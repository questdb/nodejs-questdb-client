import { describe, expect, it } from "vitest";
import { DurableAckTracker } from "../../src/qwp/durableAckTracker";

describe("DurableAckTracker", () => {
  it("retires OK frames only after every table transaction is durable", () => {
    const t = new DurableAckTracker();
    t.reset(-1);
    expect(t.onOk(0, [{ name: "a", seqTxn: 4n }])).toBeNull();
    expect(t.onDurableAck([{ name: "a", seqTxn: 3n }])).toBeNull();
    expect(t.onDurableAck([{ name: "a", seqTxn: 4n }])).toBe(0);
  });

  it("never crosses an unresolved earlier FSN", () => {
    const t = new DurableAckTracker();
    t.reset(-1);
    expect(t.onOk(1, [{ name: "b", seqTxn: 2n }])).toBeNull();
    expect(t.onDurableAck([{ name: "b", seqTxn: 2n }])).toBeNull();
    expect(t.onOk(0, [])).toBe(1);
  });

  it("uses durable watermarks that arrive before their OK", () => {
    const t = new DurableAckTracker();
    t.reset(4);
    expect(t.onDurableAck([{ name: "t", seqTxn: 9n }])).toBeNull();
    expect(t.onOk(5, [{ name: "t", seqTxn: 9n }])).toBe(5);
  });
});
