/** Optional portable WebSocket transport; importing it loads no host SDK or server. */
export { bridgeWebSocket, type WebSocketPeer } from "./websocket-bridge.js";
export {
  type PlatformWebSocket,
  platformWebSocketPeer,
  WEBSOCKET_OUTPUT_BYTES,
  WEBSOCKET_OUTPUT_MESSAGES,
} from "./websocket-peer.js";
export { upgradeWebSocket } from "./websocket-upgrade.js";
