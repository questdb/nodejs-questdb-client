// One real OS process driving a store-and-forward journal, steered over IPC.
//
// The journal's exclusion, reclaim and release rules are all about what
// *separate processes* observe of each other, and none of that is reachable
// from a single-process test: two stores in one process share a module-global
// pending-release list, an event loop, and every advisory lock object. This
// child exists so the suite can put real processes on both sides.
//
// It imports the built package rather than `src/`, because that is what a
// deployed producer runs, and because a forked child has no TypeScript loader.
import { pathToFileURL } from "node:url";

const [, , distDir, directory] = process.argv;
const { QwpNodeFileReplayStore } = await import(
  pathToFileURL(`${distDir}/es/qwp/node.mjs`).href
);

const payload = (marker) => new Uint8Array(64).fill(marker.charCodeAt(0));
const named = (error) => ({
  name: error?.name ?? "Error",
  message: String(error?.message ?? error).slice(0, 200),
  causeName: error?.cause?.name,
});

let store;
const handlers = {
  async open() {
    store = new QwpNodeFileReplayStore({ directory, durability: "append" });
    const records = await store.loadReferences();
    return { recovered: records.length };
  },
  async append({ sequence, marker }) {
    await store.append({
      frameSequence: BigInt(sequence),
      payload: payload(marker),
    });
    return {};
  },
  async close() {
    await store.close();
    return {};
  },
  // Acquiring any other lock is what drains this process's pending-release
  // list, which is the step that used to remove somebody else's directory.
  async openOther({ otherDirectory }) {
    const other = new QwpNodeFileReplayStore({
      directory: otherDirectory,
      durability: "append",
    });
    await other.loadReferences();
    await other.close();
    return {};
  },
};

process.on("message", (message) => {
  const { id, command, args } = message;
  void (async () => {
    try {
      process.send({ id, ok: true, ...(await handlers[command](args ?? {})) });
    } catch (error) {
      process.send({ id, ok: false, error: named(error) });
    }
  })();
});

process.send({ ready: true });
