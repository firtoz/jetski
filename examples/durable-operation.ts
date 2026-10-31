/** Run with: npx tsx examples/durable-operation.ts /tmp/jetski-example.sqlite */
import { OperationJournal } from "../src/core/index.js";
import { SqliteState } from "../src/state/sqlite.js";

const path = process.argv[2];
if (!path) throw new Error("Provide an explicit SQLite path");
const state = new SqliteState(path);
try {
  const journal = new OperationJournal(state);
  const fence = await journal.generation({ owner: "example", sandbox: "demo" });
  await journal.admit(fence, "hello", "execute", { argv: ["printf", "hello"] });
  const dispatch = await journal.claim(fence, "hello");
  console.log({ dispatch, operation: await journal.get(fence, "hello") });
  // No command is executed here. Re-running demonstrates durable dispatch admission:
  // a running receipt remains running; reconnecting does not claim it again.
} finally {
  state.close();
}
