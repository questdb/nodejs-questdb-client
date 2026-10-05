/**
 * Browser WebSocket adapter and browser-safe QWP protocol/session APIs.
 * @packageDocumentation
 */
// The shared protocol barrel plus the browser runtime adapter. The adapter is
// re-exported by name rather than with `export *` because qwp.ts also exports
// the internal ingress-session factory behind its senders.
export * from "../../client-core/src/qwp";
export {
  QwpBrowserSessionBootstrapError,
  bootstrapQwpBrowserSession,
  connectQwpBrowserClient,
  connectQwpBrowserEgress,
  connectQwpBrowserSender,
  connectQwpBrowserWebSocket,
  createQwpBrowserClient,
  createQwpBrowserConnectionFactory,
  createQwpBrowserSender,
} from "./qwp";
export type {
  QwpBrowserClientEgressOptions,
  QwpBrowserClientIngressOptions,
  QwpBrowserClientOptions,
  QwpBrowserClusterOptions,
  QwpBrowserEgressOptions,
  QwpBrowserFetch,
  QwpBrowserSessionAuthentication,
  QwpBrowserSessionBootstrapConfig,
  QwpBrowserSessionBootstrapOptions,
  QwpBrowserSessionBootstrapResult,
  QwpBrowserSplitClientOptions,
  QwpBrowserUnifiedClientOptions,
  QwpBrowserWebSocketOptions,
  QwpWebSocketLike,
} from "./qwp";
