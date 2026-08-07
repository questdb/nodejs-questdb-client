import { describe, it, expect } from "vitest";
import { HostTracker, HostState } from "../../src/qwp/hostTracker";

describe("HostTracker", () => {
  it("prefers a known-good host over an untried one", () => {
    const t = new HostTracker(3);
    t.record(2, HostState.HEALTHY);
    expect(t.pickNext()).toBe(2);
  });

  it("ranks HEALTHY > UNKNOWN > TRANSIENT_REJECT > TRANSPORT_ERROR > TOPOLOGY_REJECT", () => {
    const t = new HostTracker(4);
    t.record(0, HostState.TOPOLOGY_REJECT);
    t.record(1, HostState.TRANSPORT_ERROR);
    t.record(2, HostState.TRANSIENT_REJECT);
    // index 3 stays UNKNOWN
    expect(t.pickNext()).toBe(3);
    expect(t.pickNext()).toBe(2);
    expect(t.pickNext()).toBe(1);
    expect(t.pickNext()).toBe(0);
  });

  it("exhausts a round and restarts on beginRound", () => {
    const t = new HostTracker(2);
    t.pickNext();
    t.pickNext();
    expect(t.pickNext()).toBeNull();
    expect(t.isRoundExhausted()).toBe(true);
    t.beginRound();
    expect(t.pickNext()).not.toBeNull();
  });

  it("a private cursor does not consume the shared round", () => {
    const t = new HostTracker(2);
    const c = t.newCursor();
    c.pickNext();
    c.pickNext();
    expect(t.isRoundExhausted()).toBe(false);
  });
});
