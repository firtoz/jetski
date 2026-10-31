import { join } from "node:path";
import type { CheckpointStore } from "../core/contracts.js";
export type StorageConfig =
  | { kind: "local" }
  | {
      kind: "s3";
      bucket: string;
      prefix: string;
      endpoint: string;
      region: string;
      accessKeyEnv: string;
      secretKeyEnv: string;
      sessionTokenEnv?: string;
    };
export async function standaloneStorage(
  directory: string,
  config: StorageConfig = { kind: "local" },
  environment = process.env,
): Promise<{ store: CheckpointStore; close: () => void }> {
  if (config.kind === "local") {
    const { LocalCheckpointStore } = await import("../storage/local.js");
    return {
      store: new LocalCheckpointStore(join(directory, "objects")),
      close: () => {},
    };
  }
  if (config.kind !== "s3") throw Error("Unsupported storage kind");
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw Error("HTTPS storage origin required");
  if (!/^[a-z0-9-]{1,64}$/.test(config.region))
    throw Error("Invalid storage region");
  const secret = (name: string) => {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !environment[name])
      throw Error("Storage credential environment variable missing or invalid");
    return environment[name]!;
  };
  const credentials = {
    accessKeyId: secret(config.accessKeyEnv),
    secretAccessKey: secret(config.secretKeyEnv),
    ...(config.sessionTokenEnv
      ? { sessionToken: secret(config.sessionTokenEnv) }
      : {}),
  };
  const [{ S3Client }, { S3CheckpointStore }] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("../storage/s3.js"),
  ]);
  const client = new S3Client({
    endpoint: endpoint.href,
    region: config.region,
    credentials,
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
  });
  try {
    return {
      store: new S3CheckpointStore(client, config),
      close: () => client.destroy(),
    };
  } catch (error) {
    client.destroy();
    throw error;
  }
}
