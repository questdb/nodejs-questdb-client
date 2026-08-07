import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { Sender } from "../../src";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let container: StartedTestContainer;
let httpPort: number;

async function query(sql: string): Promise<any> {
  const res = await fetch(
    `http://${container.getHost()}:${httpPort}/exec?query=${encodeURIComponent(sql)}`,
  );
  return res.json();
}

// Skip cleanly when Docker is unavailable so the rest of the suite stays green.
describe.skipIf(!dockerAvailable())("QWP ingest end-to-end", () => {
  beforeAll(async () => {
    // Matches the existing test/sender.integration.test.ts pattern: no wait
    // strategy, readiness is established by the polling loop below.
    container = await new GenericContainer("questdb/questdb:nightly")
      .withExposedPorts(9000)
      .start();
    httpPort = container.getMappedPort(9000);
  }, 180_000);

  afterAll(async () => await container?.stop());

  it("ingests rows over ws:// and they land with correct values", async () => {
    // fromConfig is async. Do NOT pass auto_flush=off: spec 9.2 records that
    // disabling auto-flush is rejected for WebSocket. The default triggers are
    // harmless here because we flush explicitly and then poll.
    const sender = await Sender.fromConfig(
      `ws::addr=${container.getHost()}:${httpPort};`,
    );
    await sender.connect();

    await sender
      .table("qwp_e2e")
      .symbol("sym", "ETH-USD")
      .floatColumn("price", 2615.54)
      .intColumn("qty", 7)
      .at(1_700_000_000_000_000n, "us");

    await sender.flush();
    await sender.close();

    // WAL apply is asynchronous — poll rather than sleeping a fixed interval.
    let rows: any[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await query("select sym, price, qty, timestamp from qwp_e2e");
      rows = r.dataset ?? [];
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("ETH-USD");
    expect(rows[0][1]).toBeCloseTo(2615.54, 5);
    expect(rows[0][2]).toBe(7);
    // The designated timestamp lands with OUR value, not receive time.
    expect(rows[0][3]).toBe("2023-11-14T22:13:20.000000Z");
  }, 180_000);
});
