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
interface Waiting {
  request: SearchRequest;
  resolve: (reply: SearchReply) => void;
}
interface Slot {
  worker: Worker;
  running?: Waiting & { timer: NodeJS.Timeout; cancelled?: boolean };
  queued?: Waiting;
}
/**
 * One read worker per visible surface, kept for the life of the service (mac-feature-t11, KB-05): starting a worker
 * thread and opening SQLite for every input gave each query a fresh thread and connection. Requests of one surface
 * run one at a time; a newer request waits for the running one to finish and replaces any request still waiting.
 * A reply for a request that a newer one superseded is dropped. A request that runs past the deadline terminates
 * the worker; a request waiting behind it runs on a new worker.
 */
export class SearchService {
  private latest = new Map<string, number>();
  private slots = new Map<string, Slot>();
  constructor(
    private root: string,
    private workerFile: string,
    private timeout = 1500,
  ) {}
  /** Drops this surface's waiting request and the result of its running one; the worker stays. */
  cancel(key: string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.queued?.resolve(superseded);
    slot.queued = undefined;
    if (slot.running) slot.running.cancelled = true;
  }
  private stop(key: string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    if (slot.running) {
      clearTimeout(slot.running.timer);
      slot.running.resolve(superseded);
      slot.running = undefined;
    }
    slot.queued?.resolve(superseded);
    slot.queued = undefined;
    void slot.worker.terminate();
  }
  close() {
    for (const key of [...this.slots.keys()]) this.stop(key);
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
    const slot = this.slots.get(key) ?? this.start(key);
    return new Promise((resolve) => {
      slot.queued?.resolve(superseded);
      slot.queued = { request: input, resolve };
      if (!slot.running) this.dispatch(key, slot);
    });
  }
  private start(key: string): Slot {
    const worker = new Worker(this.workerFile, {
      workerData: join(this.root, "state.sqlite"),
    });
    const slot: Slot = { worker };
    this.slots.set(key, slot);
    worker.on("message", (reply: SearchReply) => {
      const running = slot.running;
      if (this.slots.get(key) !== slot || !running) return;
      if (reply.ok && reply.sequence !== running.request.sequence) return;
      clearTimeout(running.timer);
      slot.running = undefined;
      running.resolve(
        !running.cancelled && running.request.sequence === this.latest.get(key)
          ? reply
          : superseded,
      );
      if (slot.queued) this.dispatch(key, slot);
    });
    worker.on("error", () => {
      if (this.slots.get(key) !== slot) return;
      const running = slot.running;
      slot.running = undefined;
      if (running) {
        clearTimeout(running.timer);
        running.resolve({
          ok: false,
          code: "UNAVAILABLE",
          message: "搜索暂时不可用，请重试或重建索引。",
        });
      }
      this.stop(key);
    });
    return slot;
  }
  private dispatch(key: string, slot: Slot) {
    const waiting = slot.queued!;
    slot.queued = undefined;
    const timer = setTimeout(() => {
      if (this.slots.get(key) !== slot || slot.running?.timer !== timer) return;
      slot.running = undefined;
      const queued = slot.queued;
      slot.queued = undefined;
      this.stop(key);
      waiting.resolve({
        ok: false,
        code: "TIMEOUT",
        message: "搜索耗时过长，请缩短范围或重试。",
      });
      if (queued) {
        const fresh = this.start(key);
        fresh.queued = queued;
        this.dispatch(key, fresh);
      }
    }, this.timeout);
    slot.running = { ...waiting, timer };
    slot.worker.postMessage(waiting.request);
  }
}
