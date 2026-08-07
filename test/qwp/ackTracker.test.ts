import { describe, it, expect } from "vitest";
import { AckTracker } from "../../src/qwp/ackTracker";

describe("AckTracker", () => {
  it("translates a connection-scoped seq into an FSN", () => {
    const t = new AckTracker();
    t.onConnected(100); // replay resumes at FSN 100
    t.onFrameSent();
    t.onFrameSent();
    expect(t.onAck(1)).toBe(101);
  });

  it("does NOT reset the FSN when the wire seq restarts", () => {
    const t = new AckTracker();
    t.onConnected(0);
    t.onFrameSent();
    expect(t.onAck(0)).toBe(0);
    // reconnect: wire seq restarts at 0, FSNs continue from 1
    t.onConnected(1);
    t.onFrameSent();
    expect(t.onAck(0)).toBe(1);
  });

  it("clamps an ACK beyond what was sent", () => {
    const t = new AckTracker();
    t.onConnected(0);
    t.onFrameSent(); // highest wire seq is 0
    expect(t.onAck(99)).toBe(0);
  });

  it("ignores an ACK arriving before any send", () => {
    const t = new AckTracker();
    t.onConnected(0);
    expect(t.onAck(0)).toBeNull();
  });

  it("never moves the acked watermark backwards", () => {
    const t = new AckTracker();
    t.onConnected(0);
    t.onFrameSent();
    t.onFrameSent();
    expect(t.onAck(1)).toBe(1);
    expect(t.onAck(0)).toBe(1);
  });
});
