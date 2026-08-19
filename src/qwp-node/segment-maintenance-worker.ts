import { Worker } from "node:worker_threads";

interface WorkerFailure {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

interface WorkerReply {
  readonly id: number;
  readonly error?: WorkerFailure;
}

type MaintenanceRequest =
  | {
      readonly operation: "provision";
      readonly path: string;
      readonly size: number;
      readonly durable: boolean;
    }
  | {
      readonly operation: "unlink";
      readonly path: string;
    }
  | {
      readonly operation: "sync-directory";
      readonly directory: string;
    }
  | {
      readonly operation: "checkpoint";
      readonly paths: readonly string[];
      readonly directory?: string;
    };

interface PendingRequest {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { open, unlink } = require("node:fs/promises");

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function datasyncFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

async function run(request) {
  switch (request.operation) {
    case "provision": {
      let handle;
      try {
        handle = await open(request.path, "wx+", 0o600);
        await handle.truncate(request.size);
        if (request.durable) await handle.sync();
      } finally {
        await handle?.close().catch(() => undefined);
      }
      return;
    }
    case "unlink":
      try {
        await unlink(request.path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return;
    case "sync-directory":
      await syncDirectory(request.directory);
      return;
    case "checkpoint":
      for (const path of request.paths) await datasyncFile(path);
      if (request.directory) await syncDirectory(request.directory);
      return;
    default:
      throw new Error("unknown QWP segment-maintenance operation");
  }
}

let operationTail = Promise.resolve();
parentPort.on("message", ({ id, request }) => {
  const operation = operationTail.then(() => run(request));
  operationTail = operation.catch(() => undefined);
  void operation.then(
    () => parentPort.postMessage({ id }),
    (cause) => parentPort.postMessage({
      id,
      error: {
        name: cause?.name,
        message: cause instanceof Error ? cause.message : String(cause),
        stack: cause?.stack,
        code: cause?.code,
      },
    }),
  );
});
`;

/** One unreferenced maintenance worker shared by every SF journal in a process. */
class QwpSegmentMaintenanceWorker {
  private readonly pending = new Map<number, PendingRequest>();
  private worker?: Worker;
  private nextRequestId = 1;

  provision(path: string, size: number, durable: boolean): Promise<void> {
    return this.request({ operation: "provision", path, size, durable });
  }

  unlink(path: string): Promise<void> {
    return this.request({ operation: "unlink", path });
  }

  syncDirectory(directory: string): Promise<void> {
    return this.request({ operation: "sync-directory", directory });
  }

  checkpoint(paths: readonly string[], directory?: string): Promise<void> {
    if (paths.length === 0 && directory === undefined) return Promise.resolve();
    return this.request({ operation: "checkpoint", paths, directory });
  }

  private request(request: MaintenanceRequest): Promise<void> {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    worker.ref();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, request });
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      name: "questdb-qwp-segment-maintenance",
    });
    worker.on("message", (reply: WorkerReply) => this.onReply(reply));
    worker.on("error", (error) => this.onWorkerFailure(worker, error));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.onWorkerFailure(
          worker,
          new Error(`QWP segment-maintenance worker exited with code ${code}`),
        );
      }
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private onReply(reply: WorkerReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.error) pending.reject(workerError(reply.error));
    else pending.resolve();
    if (this.pending.size === 0) this.worker?.unref();
  }

  private onWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function workerError(failure: WorkerFailure): Error {
  const error = new Error(failure.message);
  error.name = failure.name ?? "Error";
  if (failure.stack) error.stack = failure.stack;
  if (failure.code) {
    (error as Error & { code?: string }).code = failure.code;
  }
  return error;
}

export const qwpSegmentMaintenanceWorker = new QwpSegmentMaintenanceWorker();
