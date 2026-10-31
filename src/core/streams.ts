import {
  canonical,
  identifier,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type {
  HostConnection,
  HostStreamRequest,
  HostStreamTransport,
} from "./host-stream.js";
import type { OperationJournal } from "./operations.js";
import type { PortRegistry } from "./ports.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostTransport,
  HostTransportError,
} from "./transport.js";

const MAX_STREAMS = 64;
export const STREAM_CONTROLLER_LEASE_MS = 10_000;
const STREAM_ADMISSION_LEASE_MS = 45_000;
export type StreamRecord = HostStreamRequest & {
  exposureId: string;
  generation: number;
  phase: "dispatched" | "open" | "closed" | "uncertain" | "cancelled";
  cancelRequested: boolean;
  controller: string;
  validUntil: number;
};
/** Durable control-plane connection identity. A new controller observes/cancels;
 * it never reopens an already dispatched connection or replays network bytes. */
export class StreamCoordinator {
  constructor(
    private readonly state: StateStore,
    private readonly ports: PortRegistry,
    private readonly operations: OperationJournal,
    private readonly control: HostTransport,
    private readonly transport: HostStreamTransport,
    private readonly now = Date.now,
    private readonly controller = crypto.randomUUID(),
  ) {}
  private key(scope: Scope, id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw Error("Canonical stream UUID required");
    return `stream/${scopeKey(scope)}/${id}`;
  }
  private allowed(
    tx: Transaction,
    scope: Scope,
    record: StreamRecord,
  ): boolean {
    if (record.cancelRequested) return false;
    try {
      const current = this.ports.authorizeIn(tx, scope, record.exposureId);
      return (
        current.generation === record.generation &&
        current.port === record.port &&
        current.image === record.image &&
        canonical(current.lease) === canonical(record.lease)
      );
    } catch {
      return false;
    }
  }
  async status(scope: Scope, id: string): Promise<StreamRecord> {
    return this.state.transaction((tx) => {
      const record = tx.get<StreamRecord>(this.key(scope, id));
      if (!record) throw Error("Stream unavailable");
      return record;
    });
  }
  async cancel(scope: Scope, id: string): Promise<void> {
    const record = await this.state.transaction((tx) => {
      const record = tx.get<StreamRecord>(this.key(scope, id));
      if (!record) throw Error("Stream unavailable");
      if (record.phase === "closed" || record.phase === "cancelled")
        return record;
      const next = { ...record, cancelRequested: true };
      tx.put(this.key(scope, id), next);
      return next;
    });
    if (!record.cancelRequested) return;
    await this.control.request(record.lease.machineId, {
      version: HOST_PROTOCOL_VERSION,
      id,
      action: "stream-cancel",
      payload: { lease: record.lease, image: record.image, streamId: id },
    });
    // A cancellation acknowledgement is not process-termination evidence.
  }
  async reconcile(scope: Scope, id: string): Promise<StreamRecord> {
    let record = await this.status(scope, id);
    if (record.phase === "closed" || record.phase === "cancelled")
      return record;
    // Host completion does not mean a live controller has drained its output.
    // Never settle a valid controller's stream out from under its consumer.
    if (
      (record.phase === "open" || record.phase === "dispatched") &&
      record.validUntil > this.now() &&
      (await this.state.transaction((tx) => this.allowed(tx, scope, record)))
    )
      return record;
    const response = await this.control.request(record.lease.machineId, {
      version: HOST_PROTOCOL_VERSION,
      id,
      action: "stream-status",
      payload: { lease: record.lease, image: record.image, streamId: id },
    });
    const receipt = response.result;
    if (
      response.version !== HOST_PROTOCOL_VERSION ||
      response.id !== id ||
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      receipt.id !== id ||
      (receipt.port !== record.port &&
        !(receipt.port === null && record.cancelRequested))
    )
      throw Error("Invalid host stream receipt");
    if (receipt.phase === "closed" && receipt.delivery === "complete") {
      const permitted = await this.state.transaction((tx) =>
        this.allowed(tx, scope, record),
      );
      await this.settle(scope, id, permitted, !permitted);
    } else if (receipt.phase === "cancelled" && receipt.delivery === "unknown")
      await this.settle(scope, id, false, true);
    else {
      if (receipt.phase === "uncertain") await this.settle(scope, id, false);
      record = await this.status(scope, id);
      const permitted = await this.state.transaction((tx) =>
        this.allowed(tx, scope, record),
      );
      if (
        record.cancelRequested ||
        record.phase === "uncertain" ||
        !permitted ||
        record.validUntil <= this.now()
      )
        await this.cancel(scope, id);
    }
    return this.status(scope, id);
  }
  async reconcileOwner(owner: string): Promise<void> {
    identifier(owner);
    const pending = await this.state.transaction((tx) => {
      const cursorKey = `stream-reconcile/${owner}`;
      const rows = tx
        .scan<StreamRecord>(`stream/${owner}/`)
        .filter(
          ({ value }) =>
            value.phase !== "closed" && value.phase !== "cancelled",
        )
        .sort((a, b) => {
          if (a.key === b.key) return 0;
          return a.key < b.key ? -1 : 1;
        });
      const cursor = tx.get<string>(cursorKey) ?? "";
      const ordered = [
        ...rows.filter((row) => row.key > cursor),
        ...rows.filter((row) => row.key <= cursor),
      ].slice(0, 8);
      if (ordered.length) tx.put(cursorKey, ordered[ordered.length - 1]!.key);
      return ordered.map((row) => row.value);
    });
    const errors: unknown[] = [];
    for (const record of pending) {
      try {
        await this.reconcile(
          { owner, sandbox: record.lease.sandboxId },
          record.streamId,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Stream recovery incomplete");
  }
  private async authority(
    scope: Scope,
    id: string,
    renew = false,
  ): Promise<boolean> {
    return this.state.transaction((tx) => {
      const record = tx.get<StreamRecord>(this.key(scope, id));
      const permitted =
        !!record &&
        record.controller === this.controller &&
        record.validUntil > this.now() &&
        (record.phase === "dispatched" || record.phase === "open") &&
        this.allowed(tx, scope, record);
      if (
        permitted &&
        renew &&
        record!.validUntil - this.now() <= STREAM_CONTROLLER_LEASE_MS / 2
      )
        tx.put(this.key(scope, id), {
          ...record!,
          validUntil: this.now() + STREAM_CONTROLLER_LEASE_MS,
        });
      return permitted;
    });
  }
  async open(
    scope: Scope,
    exposureId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<HostConnection> {
    signal?.throwIfAborted();
    const record = await this.state.transaction((tx) => {
      const key = this.key(scope, id);
      if (tx.get<StreamRecord>(key) || this.operations.getIn(tx, scope, id))
        throw Error(
          "Stream already admitted; inspect its receipt, never reopen",
        );
      const authority = this.ports.authorizeIn(tx, scope, exposureId);
      const existing = tx
        .scan<StreamRecord>(`stream/${scopeKey(scope)}/`)
        .filter(
          ({ value }) => canonical(value.lease) === canonical(authority.lease),
        );
      if (
        existing.length >= 4096 ||
        existing.filter(
          ({ value }) =>
            value.phase !== "closed" && value.phase !== "cancelled",
        ).length >= MAX_STREAMS
      )
        throw Error("Stream limit reached");
      const fence = { ...scope, generation: authority.generation };
      this.operations.admitIn(tx, fence, id, "stream-open", { exposureId });
      this.operations.claimIn(tx, fence, id);
      const record: StreamRecord = {
        ...authority,
        streamId: id,
        exposureId,
        phase: "dispatched",
        cancelRequested: false,
        controller: this.controller,
        validUntil: this.now() + STREAM_ADMISSION_LEASE_MS,
      };
      tx.put(key, record);
      return record;
    });
    let connection: HostConnection;
    try {
      connection = await this.transport.open(
        record.lease.machineId,
        {
          streamId: id,
          lease: record.lease,
          image: record.image,
          port: record.port,
        },
        signal,
      );
    } catch (error) {
      await this.settle(scope, id, false);
      throw error;
    }
    let stopped = false;
    const abort = () => {
      if (stopped) return;
      stopped = true;
      connection.abort();
    };
    const check = async (renew = false) => {
      if (!(await this.authority(scope, id, renew))) {
        abort();
        throw new HostTransportError(
          "Stream authority withdrawn; cleanup unknown",
        );
      }
    };
    try {
      await check();
      await this.state.transaction((tx) => {
        const latest = tx.get<StreamRecord>(this.key(scope, id));
        if (
          !latest ||
          latest.phase !== "dispatched" ||
          !this.allowed(tx, scope, latest)
        )
          throw new HostTransportError("Stream admission superseded");
        tx.put(this.key(scope, id), {
          ...latest,
          phase: "open",
          validUntil: this.now() + STREAM_CONTROLLER_LEASE_MS,
        });
      });
    } catch (error) {
      abort();
      await this.settle(scope, id, false);
      throw error;
    }
    // A live transport watches shared durable authority, including another
    // controller's revocation. No concurrent polling or unbounded task queue.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = async () => {
      if (stopped) return;
      try {
        await check(true);
      } catch {
        abort();
      }
      if (!stopped)
        timer = setTimeout(() => {
          void watch();
        }, 100);
    };
    timer = setTimeout(() => {
      void watch();
    }, 100);
    const completed = connection.completed
      .then(
        async () => {
          const phase = await this.settle(scope, id, true);
          if (phase !== "closed")
            throw new HostTransportError(
              "Stream completion is not authoritative",
            );
        },
        async (error) => {
          await this.settle(scope, id, false);
          throw error;
        },
      )
      .finally(() => {
        stopped = true;
        clearTimeout(timer);
      });
    void completed.catch(() => {});
    const output = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const bytes of connection.output) {
            await check();
            yield bytes;
          }
          await completed;
        } finally {
          if (!stopped) abort();
        }
      },
    };
    return {
      output,
      completed,
      abort,
      send: async (bytes) => {
        await check();
        await connection.send(bytes);
      },
      end: async () => {
        await check();
        await connection.end();
      },
    };
  }
  private async settle(
    scope: Scope,
    id: string,
    complete: boolean,
    cancelled = false,
  ) {
    return this.state.transaction((tx) => {
      const key = this.key(scope, id),
        record = tx.get<StreamRecord>(key);
      if (!record) throw Error("Stream unavailable");
      if (record.phase === "closed" || record.phase === "cancelled")
        return record.phase;
      let phase: StreamRecord["phase"] = "uncertain";
      if (cancelled) phase = "cancelled";
      else if (complete && this.allowed(tx, scope, record)) phase = "closed";
      tx.put(key, { ...record, phase });
      // Replacement may already have advanced the operation fence. Retain the
      // old stream observation without writing through the replacement fence.
      if (tx.get<number>(`generation/${scopeKey(scope)}`) === record.generation)
        this.operations.finishIn(
          tx,
          { ...scope, generation: record.generation },
          id,
          {
            phase: phase === "closed" ? "succeeded" : "uncertain",
            result: { streamId: id, phase },
            error:
              phase === "closed" ? null : "Stream delivery or cleanup unknown",
          },
        );
      return phase;
    });
  }
}
