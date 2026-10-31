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
  retentionPins: boolean;
  pty: boolean;
  previews: boolean;
  host: HostCapabilities;
  hostStreams: boolean;
  streamInspection: boolean;
  streamCancellation: boolean;
  sshGateway: boolean;
  tcpForwarding: boolean;
  cancellationScope: "command";
};
