import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Browser, chromium } from "playwright";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectQwpNodeIngress,
  connectQwpNodeWebSocket,
  QWP_COLUMN_TYPE,
  QWP_STATUS,
  QwpDurableAckUnavailableError,
  QwpTableBuffer,
} from "../../src/qwp/node";

const USER = process.env.QWP_BROWSER_E2E_USER ?? "admin";
const PASSWORD = process.env.QWP_BROWSER_E2E_PASSWORD ?? "quest";
const QUESTDB_HTTP_PORT = 9000;
const WRITE_BATCH_SIZE = 8;

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createModuleServer(): Server {
  const moduleRoot = path.resolve(process.cwd(), "dist/es/qwp");
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const file = path.resolve(moduleRoot, `.${requestUrl.pathname}`);
      if (!file.startsWith(`${moduleRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/javascript; charset=utf-8",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
}

function websocketUrl(httpUrl: string, pathname: string): string {
  const url = new URL(pathname, httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function executeSql(questdbUrl: string, sql: string): Promise<Response> {
  return fetch(new URL(`/exec?query=${encodeURIComponent(sql)}`, questdbUrl), {
    headers: {
      Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
    },
  });
}

describe("QWP in a real browser against QuestDB", () => {
  let assetServer: Server;
  let assetUrl: string;
  let browser: Browser;
  let container: StartedTestContainer | undefined;
  let questdbUrl: string;

  beforeAll(async () => {
    const configuredUrl = process.env.QWP_BROWSER_E2E_URL;
    if (configuredUrl) {
      questdbUrl = new URL(configuredUrl).toString();
    } else {
      container = await new GenericContainer(
        process.env.QWP_BROWSER_E2E_IMAGE ?? "questdb/questdb:nightly",
      )
        .withEnvironment({
          QDB_HTTP_USER: USER,
          QDB_HTTP_PASSWORD: PASSWORD,
        })
        .withExposedPorts(QUESTDB_HTTP_PORT)
        .start();
      questdbUrl = new URL(
        `http://${container.getHost()}:${container.getMappedPort(QUESTDB_HTTP_PORT)}`,
      ).toString();
    }

    assetServer = createModuleServer();
    await listen(assetServer);
    const address = assetServer.address() as AddressInfo;
    assetUrl = `http://127.0.0.1:${address.port}/browser.mjs`;

    browser = await chromium.launch({
      channel: process.env.QWP_BROWSER_CHANNEL,
      executablePath: process.env.QWP_BROWSER_EXECUTABLE_PATH,
      headless: true,
    });
  });

  afterAll(async () => {
    await browser?.close();
    if (assetServer) await close(assetServer);
    await container?.stop();
  });

  it("authenticates ingress and egress with the browser session cookie", async () => {
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    const tableName = `qwp_browser_e2e_${Date.now()}`;
    const ingressUrl = websocketUrl(questdbUrl, "/write/v4");
    const egressUrl = websocketUrl(questdbUrl, "/read/v1");

    try {
      await page.goto(questdbUrl, { waitUntil: "domcontentloaded" });

      const anonymousUpgrades = await page.evaluate(
        async ({ moduleUrl, ingress, egress }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const tryConnect = async (
            connect: (options: {
              url: string;
            }) => Promise<{ close(): Promise<void> }>,
            url: string,
          ) => {
            try {
              const session = await connect({ url });
              await session.close();
              return { connected: true };
            } catch (error) {
              const failure = error as {
                name?: string;
                kind?: string;
                retryable?: boolean;
                statusCode?: number;
              };
              return {
                connected: false,
                name: failure.name,
                kind: failure.kind,
                retryable: failure.retryable ?? null,
                statusCode: failure.statusCode ?? null,
              };
            }
          };
          return {
            ingress: await tryConnect(qwp.connectQwpBrowserIngress, ingress),
            egress: await tryConnect(qwp.connectQwpBrowserEgress, egress),
          };
        },
        { moduleUrl: assetUrl, ingress: ingressUrl, egress: egressUrl },
      );
      expect(anonymousUpgrades).toEqual({
        ingress: {
          connected: false,
          name: "QwpUpgradeError",
          kind: "opaque",
          retryable: null,
          statusCode: null,
        },
        egress: {
          connected: false,
          name: "QwpUpgradeError",
          kind: "opaque",
          retryable: null,
          statusCode: null,
        },
      });

      const login = await page.evaluate(
        async ({ username, password, table }) => {
          const query =
            `create table ${table} (value long, ts timestamp) ` +
            "timestamp(ts) partition by day wal";
          const response = await fetch(
            `/exec?query=${encodeURIComponent(query)}&session=true`,
            {
              credentials: "include",
              headers: {
                Authorization: `Basic ${btoa(`${username}:${password}`)}`,
              },
            },
          );
          return { status: response.status, body: await response.text() };
        },
        { username: USER, password: PASSWORD, table: tableName },
      );
      expect(login.status, login.body).toBe(200);

      const cookies = await context.cookies(questdbUrl);
      expect(cookies).toContainEqual(
        expect.objectContaining({ name: "qdb_session", httpOnly: true }),
      );

      const ingressResult = await page.evaluate(
        async ({ moduleUrl, url, table, batchSize }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const sender = await qwp.connectQwpBrowserSender(
            { url },
            { autoFlush: false },
          );
          try {
            for (let index = 0; index < batchSize; index++) {
              await sender
                .table(table)
                .longColumn("value", 42n)
                .at(BigInt(Date.now()) * 1_000n);
            }
            return { flushed: await sender.flush() };
          } finally {
            await sender.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: ingressUrl,
          table: tableName,
          batchSize: WRITE_BATCH_SIZE,
        },
      );
      expect(ingressResult).toEqual({ flushed: true });

      await expect
        .poll(
          () =>
            page.evaluate(async (table) => {
              const response = await fetch(
                `/exec?query=${encodeURIComponent(`select count() from ${table}`)}`,
                { credentials: "include" },
              );
              if (!response.ok) return -1;
              const result = await response.json();
              return result.dataset[0][0] as number;
            }, tableName),
          { timeout: 30_000, interval: 250 },
        )
        .toBe(WRITE_BATCH_SIZE);

      const egressResult = await page.evaluate(
        async ({ moduleUrl, url, table }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const session = await qwp.connectQwpBrowserEgress({ url });
          try {
            const query = await session.query(
              `select value from ${table} where value = $1 and ts >= $2 order by ts`,
              {
                binds: (binds: any) =>
                  binds.setLong(0, 42n).setTimestampMicros(1, 0n),
              },
            );
            const values: string[] = [];
            for await (const batch of query) {
              for (const row of batch.rows()) values.push(String(row[0]));
            }
            const completion = await query.completion;

            const typedQuery = await session.query(
              "select " +
                "$1::boolean, $2::byte, $3::short, $4::char, " +
                "$5::int, $6::long, $7::float, $8::double, " +
                "$9::date, $10::timestamp, $11::timestamp_ns, " +
                "$12::varchar, $13::uuid, $14::long256, " +
                "cast($15 as geohash(60b)), $16::decimal(18, 4), " +
                "$17::decimal(38, 6), $18::decimal(76, 10) " +
                "from long_sequence(1)",
              {
                binds: (binds: any) =>
                  binds
                    .setBoolean(0, true)
                    .setByte(1, 42)
                    .setShort(2, 1234)
                    .setChar(3, "Q")
                    .setInt(4, 2_000_000)
                    .setLong(5, 9_000_000_000n)
                    .setFloat(6, 3.25)
                    .setDouble(7, 2.5)
                    .setDate(8, 1_700_000_000_000n)
                    .setTimestampMicros(9, 1_700_000_000_000_000n)
                    .setTimestampNanos(10, 1_700_000_000_123_456_789n)
                    .setVarchar(11, "café")
                    .setUuid(12, "123e4567-e89b-12d3-a456-426614174000")
                    .setLong256(13, 1n, 2n, 3n, 4n)
                    .setGeohash(14, 60, 0x0fffffffffffffffn)
                    .setDecimal64(15, 4, 123_456_789n)
                    .setDecimal128(16, 6, 123_456_789_123_456n, 0n)
                    .setDecimal256(17, 10, 420_000_000_000n, 0n, 0n, 0n),
              },
            );
            let typedRow: any[] | undefined;
            for await (const batch of typedQuery) {
              typedRow = [...batch.rows()][0];
            }
            await typedQuery.completion;
            const normalize = (value: any): any => {
              if (typeof value === "bigint") return value.toString();
              if (Array.isArray(value)) return value.map(normalize);
              if (value && typeof value === "object") {
                return Object.fromEntries(
                  Object.entries(value).map(([key, nested]) => [
                    key,
                    normalize(nested),
                  ]),
                );
              }
              return value;
            };
            return {
              values,
              completion: completion.kind,
              typedRow: typedRow?.map(normalize),
            };
          } finally {
            await session.close();
          }
        },
        { moduleUrl: assetUrl, url: egressUrl, table: tableName },
      );
      expect(egressResult).toEqual({
        values: Array.from({ length: WRITE_BATCH_SIZE }, () => "42"),
        completion: "result-end",
        typedRow: [
          true,
          42,
          1234,
          "Q",
          2_000_000,
          "9000000000",
          3.25,
          2.5,
          "1700000000000",
          "1700000000000000",
          "1700000000123456789",
          "café",
          { low: "11841725276408463360", high: "1314564453825188563" },
          { words: ["1", "2", "3", "4"] },
          { bits: "1152921504606846975", precisionBits: 60 },
          { unscaled: "123456789", scale: 4 },
          { unscaled: "123456789123456", scale: 6 },
          { unscaled: "420000000000", scale: 10 },
        ],
      });
    } finally {
      await page
        .evaluate(async (table) => {
          await fetch(
            `/exec?query=${encodeURIComponent(`drop table ${table}`)}`,
            {
              credentials: "include",
            },
          );
        }, tableName)
        .catch(() => undefined);
      await context.close();
    }
  });

  it("rejects durable ACK opt-in when the server does not advertise it", async () => {
    await expect(
      connectQwpNodeIngress({
        url: websocketUrl(questdbUrl, "/write/v4"),
        authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
        requestDurableAck: true,
      }),
    ).rejects.toBeInstanceOf(QwpDurableAckUnavailableError);
  });

  it("negotiates the server QWP version and ingress batch cap", async () => {
    const connection = await connectQwpNodeWebSocket({
      url: websocketUrl(questdbUrl, "/write/v4"),
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
    });
    try {
      expect(connection.handshake.qwpVersion).toBe(1);
      expect(connection.handshake.maxBatchSizeBytes).toBeGreaterThan(12);
    } finally {
      await connection.close();
    }
  });
});
