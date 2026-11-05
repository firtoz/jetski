import { DatabaseSync } from "node:sqlite";
import type { Json, StateStore, Transaction } from "../core/contracts.js";

export class SqliteState implements StateStore {
  private readonly db: DatabaseSync;
  private active = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw Error("Unsupported state format; use a compatible release");
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; PRAGMA user_version=1;",
    );
  }
  async transaction<T>(body: (tx: Transaction) => T): Promise<T> {
    if (this.active) throw new Error("Nested transaction prohibited");
    this.active = true;
    let begun = false;
    let valid = true;
    const check = () => {
      if (!valid) throw new Error("Transaction handle expired");
    };
    try {
      this.db.exec("BEGIN IMMEDIATE");
      begun = true;
      const tx: Transaction = {
        get: <V extends Json>(key: string) => {
          check();
          const row = this.db
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get(key);
          return row ? (JSON.parse(String(row.value)) as V) : undefined;
        },
        put: (key, value) => {
          check();
          this.db
            .prepare(
              "INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .run(key, JSON.stringify(value));
        },
        delete: (key) => {
          check();
          this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
        },
        scan: <V extends Json>(prefix: string) => {
          check();
          return this.db
            .prepare(
              "SELECT key,value FROM kv WHERE substr(key,1,?) = ? ORDER BY key",
            )
            .all(prefix.length, prefix)
            .map((row) => ({
              key: String(row.key),
              value: JSON.parse(String(row.value)) as V,
            }));
        },
      };
      const result = body(tx);
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("Transaction callback must be synchronous");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (begun) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      valid = false;
      this.active = false;
    }
  }
  close(): void {
    this.db.close();
  }
}
