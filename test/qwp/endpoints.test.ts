import { describe, it, expect } from "vitest";
import { parseAddrList } from "../../src/qwp/endpoints";

describe("parseAddrList", () => {
  it("parses host and host:port", () => {
    expect(parseAddrList("a,b:1234", 9000)).toEqual([
      { host: "a", port: 9000 },
      { host: "b", port: 1234 },
    ]);
  });

  it("parses bracketed IPv6 with and without a port", () => {
    expect(parseAddrList("[::1]:9001,[fe80::1]", 9000)).toEqual([
      { host: "::1", port: 9001 },
      { host: "fe80::1", port: 9000 },
    ]);
  });

  it("treats an unbracketed multi-colon entry as bare IPv6 on the default port", () => {
    expect(parseAddrList("fe80::1", 9000)).toEqual([{ host: "fe80::1", port: 9000 }]);
  });

  it("rejects duplicates on (host, port) but allows the same host twice on different ports", () => {
    expect(() => parseAddrList("a:1,a:1", 9000)).toThrow(/duplicate/i);
    expect(parseAddrList("a:1,a:2", 9000).length).toBe(2);
  });

  it("rejects a missing bracket and an empty host", () => {
    expect(() => parseAddrList("[::1:9000", 9000)).toThrow(/closing/i);
    expect(() => parseAddrList(":9000", 9000)).toThrow(/empty host/i);
  });
});
