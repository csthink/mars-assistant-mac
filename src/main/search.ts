import { Worker } from "node:worker_threads";
import { join } from "node:path";
import {
  validSearch,
  type SearchReply,
  type SearchRequest,
} from "../shared/search";
const superseded: SearchReply = {
  ok: false,
  code: "SUPERSEDED",
  message: "搜索词已变化。",
};
/** One bounded read worker per visible surface. Superseding work is terminated. */
export class SearchService {
  private latest = new Map<string, number>();
  private slots = new Map<
    string,
    {
      worker: Worker;
      pending?: {
        resolve: (reply: SearchReply) => void;
        timer: NodeJS.Timeout;
        sequence: number;
      };
    }
  >();
  constructor(
    private root: string,
    private workerFile: string,
    private timeout = 1500,
  ) {}
  cancel(key: string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    if (slot.pending) {
      clearTimeout(slot.pending.timer);
      slot.pending.resolve(superseded);
    }
    void slot.worker.terminate();
  }
  close() {
    for (const key of this.slots.keys()) this.cancel(key);
  }
  query(key: string, input: unknown): Promise<SearchReply> {
    if (!validSearch(input))
      return Promise.resolve({
        ok: false,
        code: "INVALID_QUERY",
        message: "搜索词最多 200 个字符，请缩短后重试。",
      });
    if (input.sequence <= (this.latest.get(key) ?? -1))
      return Promise.resolve(superseded);
    this.latest.set(key, input.sequence);
    if (this.slots.get(key)?.pending) this.cancel(key);
    let slot = this.slots.get(key);
    if (!slot) {
      const worker = new Worker(this.workerFile, {
        workerData: join(this.root, "state.sqlite"),
      });
      slot = { worker };
      this.slots.set(key, slot);
      const owner = slot;
      worker.on("message", (reply: SearchReply) => {
        if (this.slots.get(key) !== owner || !owner.pending) return;
        if (reply.ok && reply.sequence !== owner.pending.sequence) return;
        const pending = owner.pending;
        owner.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(reply);
      });
      worker.on("error", () => {
        if (this.slots.get(key) !== owner) return;
        const pending = owner.pending;
        if (pending) {
          clearTimeout(pending.timer);
          owner.pending = undefined;
          pending.resolve({
            ok: false,
            code: "UNAVAILABLE",
            message: "搜索暂时不可用，请重试或重建索引。",
          });
        }
        this.cancel(key);
      });
    }
    const current = slot;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.slots.get(key) !== current) return;
        current.pending = undefined;
        this.cancel(key);
        resolve({
          ok: false,
          code: "TIMEOUT",
          message: "搜索耗时过长，请缩短范围或重试。",
        });
      }, this.timeout);
      current.pending = {
        resolve,
        timer,
        sequence: (input as SearchRequest).sequence,
      };
      current.worker.postMessage(input);
    });
  }
}
