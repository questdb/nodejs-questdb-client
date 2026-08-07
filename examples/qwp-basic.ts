import { Sender } from "@questdb/nodejs-client";

async function main(): Promise<void> {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000;");
  await sender.connect();
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");
  await sender.flush();
  await sender.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
