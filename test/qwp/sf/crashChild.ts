import { Sender } from "../../../src";

async function main(): Promise<void> {
  const [addr, sfDir] = process.argv.slice(2);
  const sender = await Sender.fromConfig(`ws::addr=${addr};sf_dir=${sfDir};`);
  await sender.connect();
  for (let i = 0; i < 50; i++) {
    await sender
      .table("crash_t")
      .intColumn("i", i)
      .at(BigInt(1_700_000_000_000_000 + i), "us");
  }
  await sender.flush();
  process.stdout.write("FLUSHED\n");
  // Never exits cleanly; the parent kills us mid-flight.
  await new Promise(() => undefined);
}

void main();
