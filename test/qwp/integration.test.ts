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

/**
 * Resolve the ingest endpoint. Three modes:
 *
 * 1. `QWP_TEST_ADDR=host:port` (e.g. "localhost:9000") — connect to an
 *    ALREADY-RUNNING QuestDB instead of starting one. Use this to verify against
 *    a container you manage yourself, or any external server.
 * 2. Otherwise start `questdb/questdb:nightly` via testcontainers.
 * 3. If neither is possible (no `QWP_TEST_ADDR` and Docker unavailable), skip.
 */
function parseAddr(
  addr: string | undefined,
): { host: string; port: number } | null {
  if (!addr) return null;
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return { host: addr, port: 9000 };
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) };
}

const external = parseAddr(process.env.QWP_TEST_ADDR);
const useExternal = external !== null;
const canRun = useExternal || dockerAvailable();

let container: StartedTestContainer | undefined;
let host = external?.host ?? "localhost";
let httpPort = external?.port ?? 0;

async function query(sql: string): Promise<any> {
  const res = await fetch(
    `http://${host}:${httpPort}/exec?query=${encodeURIComponent(sql)}`,
  );
  return res.json();
}

describe.skipIf(!canRun)("QWP ingest end-to-end", () => {
  beforeAll(async () => {
    if (useExternal) {
      // Confirm the target is actually a reachable QuestDB before proceeding.
      const probe = await query("SELECT 1").catch(() => null);
      if (!probe || probe.error) {
        throw new Error(
          `QWP_TEST_ADDR=${process.env.QWP_TEST_ADDR} is not a reachable QuestDB HTTP endpoint`,
        );
      }
      return;
    }
    // Matches the existing test/sender.integration.test.ts pattern: no wait
    // strategy, readiness is established by the polling loop below.
    container = await new GenericContainer("questdb/questdb:nightly")
      .withExposedPorts(9000)
      .start();
    host = container.getHost();
    httpPort = container.getMappedPort(9000);
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("ingests rows over ws:// and they land with correct values", async () => {
    // Unique table per run, so re-verifying against a persistent server is idempotent.
    const table = `qwp_e2e_${Date.now()}`;
    // fromConfig is async. Do NOT pass auto_flush=off: spec 9.2 records that
    // disabling auto-flush is rejected for WebSocket. The default triggers are
    // harmless here because we flush explicitly and then poll.
    const sender = await Sender.fromConfig(`ws::addr=${host}:${httpPort};`);
    await sender.connect();

    await sender
      .table(table)
      .symbol("sym", "ETH-USD")
      .floatColumn("price", 2615.54)
      .intColumn("qty", 7)
      .at(1_700_000_000_000_000n, "us");

    await sender.flush();
    await sender.close();

    // WAL apply is asynchronous — poll rather than sleeping a fixed interval.
    let rows: any[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await query(`select sym, price, qty, timestamp from ${table}`);
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

  it("round-trips every supported column type", async () => {
    const table = `qwp_types_${Date.now()}`;
    const sender = await Sender.fromConfig(
      `ws::addr=${host}:${httpPort};`,
    );
    await sender.connect();
    await sender
      .table(table)
      .symbol("sym", "A")
      .stringColumn("str", "hello")
      .booleanColumn("flag", true)
      .intColumn("i", 42)
      .floatColumn("d", 1.25)
      .timestampColumn("ts2", 1_700_000_000_000_000n, "us")
      .at(1_700_000_000_000_000n, "us");
    await sender.flush();
    await sender.close();

    let rows: any[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await query(
        `select sym, str, flag, i, d from ${table}`,
      );
      rows = r.dataset ?? [];
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(rows[0][0]).toBe("A");
    expect(rows[0][1]).toBe("hello");
    expect(rows[0][2]).toBe(true);
    expect(rows[0][3]).toBe(42);
    expect(rows[0][4]).toBeCloseTo(1.25, 5);
  }, 180_000);
});
