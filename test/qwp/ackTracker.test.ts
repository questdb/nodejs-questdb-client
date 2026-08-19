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

  it("does not let a catch-up ACK over-trim the first ring frame (handoff B1b)", () => {
    // A reconnect with a populated dictionary emits one catch-up frame first,
    // which the server assigns wire seq 0. onConnected(100, 1) says so.
    const t = new AckTracker();
    t.onConnected(100, 1); // 1 catch-up frame; ring replay resumes at FSN 100
    // The catch-up frame is counted by onConnected's initial nextWireSeq=1.
    t.onFrameSent(); // ring frame 0 sent -> nextWireSeq = 2

    // The catch-up ACK (wire seq 0) must NOT trim ring frame 0.
    expect(t.onAck(0)).toBeNull();
    // The real ACK for ring frame 0 (wire seq 1) maps to FSN 100.
    expect(t.onAck(1)).toBe(100);

    t.onFrameSent(); // ring frame 1 sent -> nextWireSeq = 3
    expect(t.onAck(2)).toBe(101); // ring frame 1 (FSN 101)
  });

  it("behaves identically with no catch-up frames", () => {
    const t = new AckTracker();
    t.onConnected(100, 0);
    t.onFrameSent();
    expect(t.onAck(0)).toBe(100);
    t.onFrameSent();
    expect(t.onAck(1)).toBe(101);
  });
});
