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
// The journal itself is internal, so the child drives it the way a producer
// does: through a sender whose endpoint never answers, which keeps every
// flushed row journalled.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , distDir, directory] = process.argv;
const { createQwpNodeSender } = await import(
  pathToFileURL(`${distDir}/es/index.mjs`).href
);

const named = (error) => ({
  name: error?.name ?? "Error",
  message: String(error?.message ?? error).slice(0, 200),
  causeName: error?.cause?.name,
});

let sender;
const handlers = {
  async open() {
    const opening = createQwpNodeSender({
      // Nothing listens on port 1. An async startup still opens the journal --
      // taking its lock and recovering its frames -- before connect()
      // resolves, and leaves connecting to the background.
      url: "ws://127.0.0.1:1/write/v4",
      initialConnectMode: "async",
      // The slot is `directory` itself: its parent is the slot root, and its
      // name the sender ID.
      storeAndForward: {
        directory: path.dirname(directory),
        durability: "append",
      },
      senderId: path.basename(directory),
      autoFlush: false,
      // Nothing will ever acknowledge the journal, so close without waiting.
      closeFlushTimeoutMs: 0,
    });
    try {
      await opening.connect();
    } catch (error) {
      await opening.close().catch(() => undefined);
      throw error;
    }
    sender = opening;
    return { recovered: sender.metrics.ingress.pendingReplayFrames };
  },
  async append({ marker }) {
    // One row per flush, and no symbols, so each append journals one frame.
    await sender
      .table("sfa_multiprocess")
      .stringColumn("marker", marker)
      .atNow();
    await sender.flush();
    return {};
  },
  async close() {
    await sender.close();
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
