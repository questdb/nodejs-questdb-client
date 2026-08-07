import { describe, it, expect } from "vitest";
import {
  buildUpgradeRequest,
  computeAccept,
  parseUpgradeResponse,
  QwpUpgradeError,
} from "../../src/qwp/ws/handshake";

describe("qwp handshake", () => {
  it("computes Sec-WebSocket-Accept per RFC 6455", () => {
    // The canonical example from RFC 6455 §1.3.
    expect(computeAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("builds an upgrade request with the QWP headers", () => {
    const { request } = buildUpgradeRequest({ host: "h", port: 9000, clientId: "nodejs/1.0.0" });
    const s = request.toString("ascii");
    expect(s).toMatch(/^GET \/write\/v4 HTTP\/1\.1\r\n/);
    expect(s).toMatch(/\r\nUpgrade: websocket\r\n/);
    expect(s).toMatch(/\r\nSec-WebSocket-Version: 13\r\n/);
    expect(s).toMatch(/\r\nX-QWP-Max-Version: 1\r\n/);
    expect(s).toMatch(/\r\nX-QWP-Client-Id: nodejs\/1\.0\.0\r\n/);
    expect(s.endsWith("\r\n\r\n")).toBe(true);
  });

  it("classifies 421 with a role header as a retriable role reject", () => {
    const raw = Buffer.from(
      "HTTP/1.1 421 Misdirected Request\r\nX-QuestDB-Role: replica\r\n\r\n",
      "ascii",
    );
    try {
      parseUpgradeResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(QwpUpgradeError);
      expect((e as QwpUpgradeError).kind).toBe("role-reject");
      expect((e as QwpUpgradeError).retriable).toBe(true);
    }
  });

  it("classifies 401 as a terminal auth failure", () => {
    const raw = Buffer.from("HTTP/1.1 401 Unauthorized\r\n\r\n", "ascii");
    try {
      parseUpgradeResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as QwpUpgradeError).kind).toBe("auth");
      expect((e as QwpUpgradeError).retriable).toBe(false);
    }
  });

  it("leaves 404 unclassified", () => {
    const raw = Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n", "ascii");
    try {
      parseUpgradeResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as QwpUpgradeError).kind).toBe("other");
    }
  });

  it("returns negotiated headers on 101", () => {
    const raw = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n" +
        "X-QWP-Version: 1\r\nX-QWP-Max-Batch-Size: 1048576\r\n\r\n",
      "ascii",
    );
    const r = parseUpgradeResponse(raw);
    expect(r.accept).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(r.qwpVersion).toBe(1);
    expect(r.maxBatchSize).toBe(1048576);
  });
});
