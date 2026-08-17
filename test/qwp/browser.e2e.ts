import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Browser, chromium } from "playwright";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectQwpNodeIngress,
  QWP_COLUMN_TYPE,
  QWP_STATUS,
  QwpDurableAckUnavailableError,
  QwpIngressSession,
  QwpTableBuffer,
} from "../../src/qwp/node";

const USER = process.env.QWP_BROWSER_E2E_USER ?? "admin";
const PASSWORD = process.env.QWP_BROWSER_E2E_PASSWORD ?? "quest";
const DURABLE_E2E_URL = process.env.QWP_DURABLE_E2E_URL;
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
          const canConnect = async (
            connect: (options: {
              url: string;
            }) => Promise<{ close(): Promise<void> }>,
            url: string,
          ) => {
            try {
              const session = await connect({ url });
              await session.close();
              return true;
            } catch {
              return false;
            }
          };
          return {
            ingress: await canConnect(qwp.connectQwpBrowserIngress, ingress),
            egress: await canConnect(qwp.connectQwpBrowserEgress, egress),
          };
        },
        { moduleUrl: assetUrl, ingress: ingressUrl, egress: egressUrl },
      );
      expect(anonymousUpgrades).toEqual({ ingress: false, egress: false });

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
          const buffer = new qwp.QwpTableBuffer(table);
          buffer
            .getOrCreateColumn("value", qwp.QWP_COLUMN_TYPE.LONG)
            .values.push(42n);
          buffer
            .getOrCreateColumn("", qwp.QWP_COLUMN_TYPE.TIMESTAMP)
            .values.push(BigInt(Date.now()) * 1_000n);
          buffer.nextRow();

          const session = await qwp.connectQwpBrowserIngress({ url });
          try {
            const responses = await Promise.all(
              Array.from({ length: batchSize }, () =>
                session.sendTables([buffer]),
              ),
            );
            return responses.map((response) => ({
              status: response.status,
              sequence: String(response.sequence),
            }));
          } finally {
            await session.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: ingressUrl,
          table: tableName,
          batchSize: WRITE_BATCH_SIZE,
        },
      );
      expect(ingressResult).toHaveLength(WRITE_BATCH_SIZE);
      ingressResult.forEach((response, requestSequence) => {
        expect(response.status).toBe(0);
        expect(BigInt(response.sequence)).toBeGreaterThanOrEqual(
          BigInt(requestSequence),
        );
      });
      expect(ingressResult.at(-1)?.sequence).toBe(String(WRITE_BATCH_SIZE - 1));

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
              `select value from ${table} order by ts`,
            );
            const values: string[] = [];
            for await (const batch of query) {
              for (const row of batch.rows()) values.push(String(row[0]));
            }
            const completion = await query.completion;
            return { values, completion: completion.kind };
          } finally {
            await session.close();
          }
        },
        { moduleUrl: assetUrl, url: egressUrl, table: tableName },
      );
      expect(egressResult).toEqual({
        values: Array.from({ length: WRITE_BATCH_SIZE }, () => "42"),
        completion: "result-end",
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
    if (DURABLE_E2E_URL) return;
    await expect(
      connectQwpNodeIngress({
        url: websocketUrl(questdbUrl, "/write/v4"),
        authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
        requestDurableAck: true,
      }),
    ).rejects.toBeInstanceOf(QwpDurableAckUnavailableError);
  });

  it.runIf(DURABLE_E2E_URL)(
    "waits for Enterprise ingress to reach its durable table watermark",
    async () => {
      const durableUrl = DURABLE_E2E_URL!;
      const tableName = `qwp_durable_e2e_${Date.now()}`;
      const create = await executeSql(
        durableUrl,
        `create table ${tableName} (value long, ts timestamp) ` +
          "timestamp(ts) partition by day wal",
      );
      expect(create.status, await create.text()).toBe(200);

      const table = new QwpTableBuffer(tableName);
      table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!.values.push(42n);
      table
        .getOrCreateColumn("", QWP_COLUMN_TYPE.TIMESTAMP)!
        .values.push(BigInt(Date.now()) * 1_000n);
      table.nextRow();

      let session: QwpIngressSession | undefined;
      try {
        session = await connectQwpNodeIngress(
          {
            url: websocketUrl(durableUrl, "/write/v4"),
            authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
            requestDurableAck: true,
          },
          { durableAckKeepaliveMs: 25 },
        );
        const ack = await session.sendTables([table]);
        expect(ack.status).toBe(QWP_STATUS.OK);
        expect(ack.tables).toContainEqual(
          expect.objectContaining({ name: tableName }),
        );
        await session.waitForDurable(ack, 30_000);
      } finally {
        await session?.close();
        await executeSql(durableUrl, `drop table ${tableName}`);
      }
    },
  );
});
