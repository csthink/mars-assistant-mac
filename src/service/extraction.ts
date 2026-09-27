import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { Store } from "./store";
import type { ExtractionOutcome, Reply } from "../shared/protocol";
import { attachmentDirectory } from "./attachments";

/**
 * Runs the restricted extraction worker for one importing attachment at a
 * time. Every outcome, including a deadline or a crash, is reported to the
 * store as a host command so the row never stays "importing" while the
 * service is alive; a restart re-queues whatever was still importing.
 */
export interface ExtractionOptions {
  workerFile: string;
  execArgv?: string[];
  timeoutMs?: number;
  heapMb?: number;
}
export class ExtractionQueue {
  private running = false;
  private stopped = false;
  private active: Worker | undefined;
  constructor(
    private store: Store,
    private options: ExtractionOptions,
    private onUpdate: (reply: Reply) => void,
  ) {}
  /** Starts the next pending extraction unless one is already running. */
  schedule() {
    if (this.running || this.stopped) return;
    const next = this.store.pendingExtractions()[0];
    if (!next) return;
    this.running = true;
    void this.run(next).finally(() => {
      this.running = false;
      this.schedule();
    });
  }
  close() {
    this.stopped = true;
    void this.active?.terminate();
  }
  private run(item: { id: string; sha256: string; kind: string }) {
    return new Promise<void>((resolve) => {
      const path = join(this.store.root, attachmentDirectory, item.sha256);
      let settled = false;
      const finish = (outcome: ExtractionOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active = undefined;
        const reply = this.store.execute(
          { type: "reportExtraction", attachmentId: item.id, outcome },
          "main",
          "host",
        );
        this.onUpdate(reply);
        resolve();
      };
      let worker: Worker;
      try {
        worker = new Worker(this.options.workerFile, {
          workerData: { path, kind: item.kind },
          execArgv: this.options.execArgv,
          stdout: true,
          stderr: true,
          resourceLimits: {
            maxOldGenerationSizeMb: this.options.heapMb ?? 512,
          },
        });
      } catch {
        finish({ ok: false, reason: "damaged" });
        return;
      }
      this.active = worker;
      // Anything the worker prints is not needed; consume it so it cannot block.
      worker.stdout.on("data", () => {});
      worker.stderr.on("data", () => {});
      const timer = setTimeout(() => {
        void worker.terminate();
        finish({ ok: false, reason: "extraction_timeout" });
      }, this.options.timeoutMs ?? 30_000);
      worker.once("message", (outcome: ExtractionOutcome) => {
        finish(outcome);
        void worker.terminate();
      });
      worker.once("error", () => finish({ ok: false, reason: "damaged" }));
      worker.once("exit", () => finish({ ok: false, reason: "damaged" }));
    });
  }
}
