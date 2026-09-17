import { Sender } from "@questdb/nodejs-client";

async function main(): Promise<void> {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000");
  await sender.connect();
  try {
    await sender
      .table("trades")
      .symbol("symbol", "ETH-USD")
      .floatColumn("price", 2_615.54)
      .floatColumn("amount", 0.00044)
      .at(Date.now(), "ms");
    await sender.flush();
  } finally {
    await sender.close();
  }
}

void main();
