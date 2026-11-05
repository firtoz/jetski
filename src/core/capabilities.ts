import type { HostCapabilities } from "./contracts.js";

/** Configured API features, not per-sandbox readiness or release qualification. */
export type ApiCapabilities = {
  version: 1;
  releaseQualified: false;
  commands: boolean;
  outputCursors: boolean;
  fileRead: boolean;
  fileList: boolean;
  fileWrite: boolean;
  checkpointHistory: boolean;
  checkpointCopy: boolean;
  retentionPins: boolean;
  pty: boolean;
  previews: boolean;
  previewSessions: boolean;
  host: HostCapabilities;
  hostStreams: boolean;
  streamInspection: boolean;
  streamCancellation: boolean;
  sshGateway: boolean;
  tcpForwarding: boolean;
  cancellationScope: "command";
};

/** Controller observations, not proof of provider health or checkpoint durability. */
export type ApiHealth = {
  version: string;
  apiVersion: 1;
  ready: boolean;
  stopping: boolean;
  lastSuccess: number | null;
  lastFailure: number | null;
  sandboxes: Record<string, number>;
};
