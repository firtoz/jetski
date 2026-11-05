// Compile-only consumer contracts; this function is never executed.
import {
  type NodeJetski,
  type NodeOptions,
  type NodeStorage,
  openJetski,
  runSandbox,
} from "@firtoz/jetski/node";
import {
  type CommandResult,
  type FromCheckpointOptions,
  Jetski,
  type SandboxSession,
} from "@firtoz/jetski/sdk";

export async function publicApiTypes(
  options: NodeOptions,
  embedded: NodeJetski,
  remote: Jetski,
) {
  const opened: Promise<NodeJetski> = openJetski(options);
  const session: SandboxSession = await embedded.create();
  const result: CommandResult = await session.exec(["echo", "hello"]);
  const bytes: Uint8Array = result.stdoutBytes;
  const text: string = await session.readText("/workspace/file");
  const checkpoint = await session.checkpoint({ releaseHost: true });
  const source: FromCheckpointOptions = {
    sourceSandboxId: session.id,
    checkpointId: checkpoint.id,
  };
  const copied: SandboxSession = await embedded.fromCheckpoint(source);
  const remoteCopy: SandboxSession = await remote.fromCheckpoint(source);
  const output: Promise<CommandResult> = runSandbox(
    { ...options, image: "example@sha256:" + "a".repeat(64) },
    ["echo", "hello"],
  );
  // @ts-expect-error command arguments must be a string array
  session.exec("echo hello");
  // @ts-expect-error file content must be text or bytes
  session.writeFile("/workspace/file", 123);
  // @ts-expect-error checkpoint source must include its sandbox identity
  embedded.fromCheckpoint({ checkpointId: "root" });
  // @ts-expect-error checkpoint release option is boolean
  session.checkpoint({ releaseHost: "yes" });
  // @ts-expect-error optional properties do not silently accept explicit undefined
  session.resume({ checkpointId: undefined });
  openJetski({
    dataDirectory: "./.jetski",
    // @ts-expect-error provider credentials must be present and typed
    provider: { kind: "boat", token: undefined },
  });
  // @ts-expect-error S3 requires endpoint, bucket, prefix and credentials
  const incomplete: NodeStorage = { kind: "s3", bucket: "example" };
  void [opened, bytes, text, copied, remoteCopy, output, incomplete];
}
