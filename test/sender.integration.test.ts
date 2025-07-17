// @ts-check
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import http from "http";

import { Sender } from "../src";

const HTTP_OK = 200;

const QUESTDB_HTTP_PORT = 9000;
const QUESTDB_ILP_PORT = 9009;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Sender tests with containerized QuestDB instance", () => {
  let container: StartedTestContainer;

  async function query(container: StartedTestContainer, query: string) {
    const options: http.RequestOptions = {
      hostname: container.getHost(),
      port: container.getMappedPort(QUESTDB_HTTP_PORT),
      path: `/exec?query=${encodeURIComponent(query)}`,
      method: "GET",
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (response) => {
        if (response.statusCode === HTTP_OK) {
          const body: Uint8Array[] = [];
          response
            .on("data", (data: Uint8Array) => {
              body.push(data);
            })
            .on("end", () => {
              resolve(JSON.parse(Buffer.concat(body).toString()));
            });
        } else {
          reject(new Error(`HTTP request failed, statusCode=${response.statusCode}, query=${query}`));
        }
      });

      req.on("error", error => reject(error));
      req.end();
    });
  }

  async function runSelect(container: StartedTestContainer, select: string, expectedCount: number, timeout = 60000) {
    const interval = 500;
    const num = timeout / interval;
    let selectResult: any;
    for (let i = 0; i < num; i++) {
      selectResult = await query(container, select);
      if (selectResult && selectResult.count >= expectedCount) {
        return selectResult;
      }
      await sleep(interval);
    }
    throw new Error(
      `Timed out while waiting for ${expectedCount} rows, select='${select}'`,
    );
  }

  async function waitForTable(container: StartedTestContainer, tableName: string, timeout = 30000) {
    await runSelect(container, `tables() where table_name='${tableName}'`, 1, timeout);
  }

  beforeAll(async () => {
    container = await new GenericContainer("questdb/questdb:nightly")
      .withExposedPorts(QUESTDB_HTTP_PORT, QUESTDB_ILP_PORT)
      .start();

    const stream = await container.logs();
    stream
      .on("data", (line: string) => console.log(line))
      .on("err", (line: string) => console.error(line))
      .on("end", () => console.log("Stream closed"));
  }, 3000000);

  afterAll(async () => {
    await container.stop();
  });

  it("can ingest data via TCP and run queries", async () => {
    const sender = new Sender({
      protocol: "tcp",
      host: container.getHost(),
      port: container.getMappedPort(QUESTDB_ILP_PORT),
    });
    await sender.connect();

    const tableName = "test_tcp";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    // ingest via client
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");
    await sender.flush();

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const select1Result = await runSelect(container, tableName, 1);
    expect(select1Result.query).toBe(tableName);
    expect(select1Result.count).toBe(1);
    expect(select1Result.columns).toStrictEqual(schema);
    expect(select1Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z"],
    ]);

    // ingest via client, add new column
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.3)
      .at(1658484765000666000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .floatColumn("temperature", 17.4)
      .at(1658484765000999000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .symbol("city", "london")
      .floatColumn("temperature", 18.8)
      .at(1658484765001234000n, "ns");
    await sender.flush();

    // query table
    const select2Result = await runSelect(container, tableName, 4);
    expect(select2Result.query).toBe(tableName);
    expect(select2Result.count).toBe(4);
    expect(select2Result.columns).toStrictEqual([
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "city", type: "SYMBOL" },
    ]);
    expect(select2Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z", null],
      ["us", 17.3, "2022-07-22T10:12:45.000666Z", null],
      ["emea", 17.4, "2022-07-22T10:12:45.000999Z", null],
      ["emea", 18.8, "2022-07-22T10:12:45.001234Z", "london"],
    ]);

    await sender.close();
  });

  it("can ingest data via HTTP with auto flush rows", async () => {
    const tableName = "test_http_rows";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    const sender = Sender.fromConfig(
      `http::addr=${container.getHost()}:${container.getMappedPort(QUESTDB_HTTP_PORT)};auto_flush_interval=0;auto_flush_rows=1`,
    );

    // ingest via client
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const select1Result = await runSelect(container, tableName, 1);
    expect(select1Result.query).toBe(tableName);
    expect(select1Result.count).toBe(1);
    expect(select1Result.columns).toStrictEqual(schema);
    expect(select1Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z"],
    ]);

    // ingest via client, add new column
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.36)
      .at(1658484765000666000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .floatColumn("temperature", 17.41)
      .at(1658484765000999000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .symbol("city", "london")
      .floatColumn("temperature", 18.81)
      .at(1658484765001234000n, "ns");

    // query table
    const select2Result = await runSelect(container, tableName, 4);
    expect(select2Result.query).toBe(tableName);
    expect(select2Result.count).toBe(4);
    expect(select2Result.columns).toStrictEqual([
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "city", type: "SYMBOL" },
    ]);
    expect(select2Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z", null],
      ["us", 17.36, "2022-07-22T10:12:45.000666Z", null],
      ["emea", 17.41, "2022-07-22T10:12:45.000999Z", null],
      ["emea", 18.81, "2022-07-22T10:12:45.001234Z", "london"],
    ]);

    await sender.close();
  });

  it("can ingest data via HTTP with auto flush interval", async () => {
    const tableName = "test_http_interval";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    const sender = Sender.fromConfig(
      `http::addr=${container.getHost()}:${container.getMappedPort(QUESTDB_HTTP_PORT)};auto_flush_interval=1;auto_flush_rows=0`,
    );

    // wait longer than the set auto flush interval to make sure there is a flush
    await sleep(10);

    // ingest via client
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const select1Result = await runSelect(container, tableName, 1);
    expect(select1Result.query).toBe(tableName);
    expect(select1Result.count).toBe(1);
    expect(select1Result.columns).toStrictEqual(schema);
    expect(select1Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z"],
    ]);

    // ingest via client, add new column
    await sleep(10);
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.36)
      .at(1658484765000666000n, "ns");
    await sleep(10);
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .floatColumn("temperature", 17.41)
      .at(1658484765000999000n, "ns");
    await sleep(10);
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .symbol("city", "london")
      .floatColumn("temperature", 18.81)
      .at(1658484765001234000n, "ns");

    // query table
    const select2Result = await runSelect(container, tableName, 4);
    expect(select2Result.query).toBe(tableName);
    expect(select2Result.count).toBe(4);
    expect(select2Result.columns).toStrictEqual([
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "city", type: "SYMBOL" },
    ]);
    expect(select2Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z", null],
      ["us", 17.36, "2022-07-22T10:12:45.000666Z", null],
      ["emea", 17.41, "2022-07-22T10:12:45.000999Z", null],
      ["emea", 18.81, "2022-07-22T10:12:45.001234Z", "london"],
    ]);

    await sender.close();
  });

  it("does not duplicate rows if await is missing when calling flush", async () => {
    const sender = new Sender({
      protocol: "tcp",
      host: container.getHost(),
      port: container.getMappedPort(QUESTDB_ILP_PORT),
    });
    await sender.connect();

    const tableName = "test2";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    // ingest via client
    const numOfRows = 100;
    for (let i = 0; i < numOfRows; i++) {
      const p1 = sender
        .table(tableName)
        .symbol("location", "us")
        .floatColumn("temperature", i)
        .at(1658484765000000000n, "ns");
      const p2 = sender.flush();
      // IMPORTANT: missing 'await' for p1 and p2 is intentional!
      expect(p1).toBeTruthy();
      expect(p2).toBeTruthy();
    }

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const selectQuery = `${tableName} order by temperature`;
    const selectResult = await runSelect(container, selectQuery, numOfRows);
    expect(selectResult.query).toBe(selectQuery);
    expect(selectResult.count).toBe(numOfRows);
    expect(selectResult.columns).toStrictEqual(schema);

    const expectedData: (string | number)[][] = [];
    for (let i = 0; i < numOfRows; i++) {
      expectedData.push(["us", i, "2022-07-22T10:12:45.000000Z"]);
    }
    expect(selectResult.dataset).toStrictEqual(expectedData);

    await sender.close();
  });

  it("ingests all data without loss under high load with auto-flush", async () => {
    const sender = Sender.fromConfig(
      `tcp::addr=${container.getHost()}:${container.getMappedPort(QUESTDB_ILP_PORT)};auto_flush_rows=5;auto_flush_interval=1`,
    );
    await sender.connect();

    const tableName = "test_high_load_autoflush";
    const numOfRows = 1000;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < numOfRows; i++) {
      // Not awaiting each .at() call individually to allow them to queue up
      const p = sender
        .table(tableName)
        .intColumn("id", i)
        .at(1658484765000000000n + BigInt(1000 * i), "ns"); // Unique timestamp for each row
      promises.push(p);
    }

    // Wait for all .at() calls to complete their processing (including triggering auto-flushes)
    await Promise.all(promises);

    // Perform a final flush to ensure any data remaining in the buffer is sent.
    // This will be queued correctly after any ongoing auto-flushes.
    await sender.flush();

    // Wait for the table
    await waitForTable(container, tableName)

    // Query table and verify count
    const selectQuery = `SELECT id FROM ${tableName}`;
    const selectResult = await runSelect(container, selectQuery, numOfRows);
    expect(selectResult.count).toBe(numOfRows);

    // Verify data integrity
    for (let i = 0; i < numOfRows; i++) {
      expect(selectResult.dataset[i][0]).toBe(i);
    }

    await sender.close();
  }, 30000); // Increased test timeout for this specific test
});
