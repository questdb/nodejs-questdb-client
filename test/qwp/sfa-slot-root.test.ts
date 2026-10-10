import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeClient,
  createQwpNodeSender,
} from "../../packages/nodejs-client/src";
import type {
  QwpNodeStoreAndForwardOptions,
  QwpSender,
} from "../../packages/nodejs-client/src";

// The slot-root warning goes through the module logger, which binds the
// console methods when it loads, so it is observed here rather than there.
const logging = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("../../packages/client-core/src/logging", () => logging);

/**
 * `storeAndForward.directory` is a slot root, as `sf_dir` is: every journal is
 * a slot below it, `default` unless `senderId` names it.
 */
describe("QWP store-and-forward slot root", () => {
  const roots: string[] = [];

  afterEach(async () => {
    logging.log.mockClear();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function slotRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "qwp-slot-root-"));
    roots.push(root);
    return root;
  }

  async function openSender(
    directory: string,
    senderId?: string,
  ): Promise<QwpSender> {
    const sender = createQwpNodeSender({
      // Nothing listens on port 1. An async startup opens the journal anyway
      // and leaves connecting to the background.
      url: "ws://127.0.0.1:1/write/v4",
      initialConnectMode: "async",
      storeAndForward: { directory },
      senderId,
      autoFlush: false,
      closeFlushTimeoutMs: 0,
    });
    await sender.connect();
    return sender;
  }

  function strandedWarnings(): string[] {
    return logging.log.mock.calls
      .filter(
        ([level, message]) =>
          level === "warn" &&
          String(message).includes("holds journal segments"),
      )
      .map(([, message]) => String(message));
  }

  it("journals a typed sender into its slot below the configured directory", async () => {
    const root = await slotRoot();
    const unnamed = await openSender(root);
    await unnamed.table("trades").longColumn("quantity", 1n).atNow();
    await unnamed.flush();
    await unnamed.close();
    const named = await openSender(root, "producer-a");
    await named.close();

    // The connect string's layout: `<sf_dir>/<sender_id>`, `default` unless
    // named, and nothing journalled into the root itself.
    const entries = await readdir(root);
    expect(entries).toEqual(expect.arrayContaining(["default", "producer-a"]));
    expect(entries.filter((entry) => entry.endsWith(".sfa"))).toEqual([]);
    expect(
      (await readdir(join(root, "default"))).some((entry) =>
        entry.endsWith(".sfa"),
      ),
    ).toBe(true);
    expect(strandedWarnings()).toEqual([]);
  });

  it("warns when the slot root itself holds journal segments", async () => {
    // A directory naming a slot rather than its root leaves this behind:
    // `sf_dir=/var/lib/qwp/default` after an earlier `sf_dir=/var/lib/qwp`
    // journalled into that same slot. Nothing replays segments in a root, and
    // the orphan scanner only inspects its child directories.
    const root = await slotRoot();
    await writeFile(join(root, "sf-0000000000000000.sfa"), new Uint8Array(32));
    const sender = await openSender(root);
    await sender.close();

    const warnings = strandedWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`'${join(root, "default")}'`);
    expect(warnings[0]).toContain(
      `its slot root '${root}' holds journal segments that nothing will replay`,
    );
  });

  describe("legacy pooled slot names", () => {
    async function startPool(
      directory: string,
      options: {
        senderId?: string;
        drainOrphans?: boolean;
      } = {},
    ): Promise<void> {
      const storeAndForward: QwpNodeStoreAndForwardOptions = {
        directory,
        orphanScanIntervalMs: 0,
        drainOrphans: options.drainOrphans,
      };
      // Nothing listens on port 1: lazyConnect starts the client, and with it
      // the slot scan, without a server.
      const client = await connectQwpNodeClient({
        cluster: { url: "ws://127.0.0.1:1" },
        ingress: { senderId: options.senderId, storeAndForward },
        lazyConnect: true,
      });
      await client.close();
    }

    async function legacySlot(root: string, name: string): Promise<void> {
      await mkdir(join(root, name));
      await writeFile(
        join(root, name, "sf-0000000000000000.sfa"),
        new Uint8Array(32),
      );
    }

    function legacyWarnings(): string[] {
      return logging.log.mock.calls
        .filter(
          ([level, message]) =>
            level === "warn" &&
            String(message).includes("that this pool will not replay"),
        )
        .map(([, message]) => String(message));
    }

    it("warns when a typed pool's earlier sender-N slots hold journals", async () => {
      // A typed pool once named its slots `sender-<slot>`. It now journals into
      // `default-<slot>`, and its drainer adopts only those, so the old
      // backlog would sit unreplayed without a word.
      const root = await slotRoot();
      await legacySlot(root, "sender-3");
      await legacySlot(root, "sender-0");
      // Empty, so nothing is stranded in it.
      await mkdir(join(root, "sender-1"));
      await startPool(root);

      const warnings = legacyWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `slot root '${root}' holds journals in 'sender-0', 'sender-3' that this pool will not replay`,
      );
      expect(warnings[0]).toContain("Rename each to 'default-<slot>'");
    });

    it("does not warn when the pool drains orphans or owns the sender-N names", async () => {
      const root = await slotRoot();
      await legacySlot(root, "sender-2");
      await startPool(root, { drainOrphans: true });
      await startPool(root, { senderId: "sender" });

      expect(legacyWarnings()).toEqual([]);
    });
  });
});
