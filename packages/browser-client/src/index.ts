/**
 * Browser WebSocket adapter and browser-safe QWP protocol/session APIs.
 * @packageDocumentation
 */
// The shared protocol barrel plus the browser runtime adapter. The adapter is
// re-exported by name rather than with `export *` because qwp.ts also exports
// internal helpers: the ingress-session and connection factories behind its
// senders and a raw WebSocket connector for tests.
export * from "../../client-core/src/qwp";
export {
  QwpBrowserSessionBootstrapError,
  bootstrapQwpBrowserSession,
  connectQwpBrowserClient,
  connectQwpBrowserEgress,
  connectQwpBrowserSender,
  createQwpBrowserClient,
  createQwpBrowserSender,
} from "./qwp";
export type {
  QwpBrowserAuthContext,
  QwpBrowserAuthProvider,
  QwpBrowserClientOptions,
  QwpBrowserEgressOptions,
  QwpBrowserFetch,
  QwpBrowserIngressOptions,
  QwpBrowserSessionAuthentication,
  QwpBrowserSessionBootstrapConfig,
  QwpBrowserSessionBootstrapOptions,
  QwpBrowserSessionBootstrapResult,
  QwpBrowserWebSocketOptions,
  QwpWebSocketLike,
} from "./qwp";
