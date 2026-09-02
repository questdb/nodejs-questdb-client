import { connectQwpBrowserSender } from "@questdb/browser-client";

async function main(): Promise<void> {
  const url = new URL("/write/v4", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const sender = await connectQwpBrowserSender({ url }, { autoFlush: false });
  try {
    await sender.table("events").longColumn("value", 42n).atNow();
    await sender.flush();
  } finally {
    await sender.close();
  }
}

void main();
