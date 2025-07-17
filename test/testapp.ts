import { readFileSync } from "node:fs";

import { Proxy } from "./util/proxy";
import { Sender } from "../src";
import { SenderOptions } from "../src/options";

const PROXY_PORT = 9099;
const PORT = 9009;
const HOST = "localhost";

const senderOptions: SenderOptions = {
  protocol: "tcps",
  host: HOST,
  port: PROXY_PORT,
  addr: "localhost",
  tls_ca: readFileSync("certs/ca/ca.crt"), // necessary only if the server uses self-signed certificate
};

const proxyTLS = {
  key: readFileSync("certs/server/server.key"),
  cert: readFileSync("certs/server/server.crt"),
  ca: readFileSync("certs/ca/ca.crt"), // authority chain for the clients
};

async function run() {
  const proxy = new Proxy();
  await proxy.start(PROXY_PORT, PORT, HOST, proxyTLS);

  const sender = new Sender(senderOptions); //with authentication
  const connected = await sender.connect(); //connection through proxy with encryption
  if (connected) {
    await sender
      .table("test")
      .symbol("location", "emea")
      .symbol("city", "budapest")
      .stringColumn("hoppa", "hello")
      .stringColumn("hippi", "hello")
      .stringColumn("hippo", "haho")
      .floatColumn("temperature", 14.1)
      .intColumn("intcol", 56)
      .timestampColumn("tscol", Date.now(), "ms")
      .atNow();
    await sender
      .table("test")
      .symbol("location", "asia")
      .symbol("city", "singapore")
      .stringColumn("hoppa", "hi")
      .stringColumn("hopp", "hello")
      .stringColumn("hippo", "huhu")
      .floatColumn("temperature", 7.1)
      .at(1658484765000555000n, "ns");
    await sender.flush();

    await sender
      .table("test")
      .symbol("location", "emea")
      .symbol("city", "miskolc")
      .stringColumn("hoppa", "hello")
      .stringColumn("hippi", "hello")
      .stringColumn("hippo", "lalalala")
      .floatColumn("temperature", 13.1)
      .intColumn("intcol", 333)
      .atNow();
    await sender.flush();
  }
  await sender.close();

  await proxy.stop();
}

run().catch(console.error);
