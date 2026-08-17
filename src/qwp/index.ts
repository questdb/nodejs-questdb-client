/**
 * Browser-safe QuestDB Wire Protocol primitives.
 *
 * This entry point intentionally contains no Node.js imports. Higher-level
 * browser and Node WebSocket clients will be layered on top of this module.
 *
 * @packageDocumentation
 */
export * from "./core";
export * from "./egress-session";
export * from "./ingress-session";
export * from "./transport";
