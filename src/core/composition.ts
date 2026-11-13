import type { HostProvider, Json, StateStore } from "./contracts.js";
import type { IdlePriceSource } from "./host-lifecycle.js";
import type { HostStreamTransport } from "./host-stream.js";
import type { HostTransport } from "./transport.js";

/** Generic composition seam. Platform scheduling and product authorization remain injected. */
export type HostAdapters = {
  provider: HostProvider;
  transport: HostTransport;
  streamTransport?: HostStreamTransport;
  idlePriceSource?: IdlePriceSource;
  close?: () => void | Promise<void>;
};
export type HostFactoryContext = {
  state: StateStore;
  poolId: string;
  approvedImages: readonly string[];
};
export type HostFactory = {
  kind: "factory";
  id: string;
  /** Non-secret immutable policy; credentials must not appear here. */
  configuration?: Json;
  create(context: HostFactoryContext): HostAdapters | Promise<HostAdapters>;
};
