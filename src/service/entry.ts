import { join } from "node:path";
import { Store, StoreError } from "./store";
import { ExtractionQueue } from "./extraction";
import type { Surface } from "../shared/protocol";
const port = process.parentPort;
if (!port)
  throw new Error("Business service requires its registered parent port");
let store: Store;
let extraction: ExtractionQueue | undefined;
let lastHeartbeat = Date.now();
try {
  store = new Store(process.argv[2], process.argv[3] === "create");
  port.postMessage({ type: "ready", snapshot: store.snapshot() });
  // Extraction outcomes arrive outside any request; the host adopts them as unsolicited updates.
  extraction = new ExtractionQueue(
    store,
    { workerFile: join(__dirname, "extract.cjs") },
    (reply) => {
      if (reply.ok)
        port.postMessage({ type: "update", snapshot: reply.snapshot });
    },
  );
  extraction.schedule();
} catch (error) {
  port.postMessage({
    type: "fatal",
    message:
      error instanceof StoreError
        ? error.message
        : "业务服务启动失败，请检查数据目录。",
  });
  setTimeout(() => process.exit(1), 50);
}
// The watchdog exists to release the data root when the host dies. The host's
// timers can stall for seconds behind native dialogs, so parent liveness is
// checked directly and heartbeat silence only counts after a long window.
const heartbeatSilenceLimitMs = 60_000;
function parentAlive() {
  try {
    process.kill(process.ppid, 0);
    return true;
  } catch {
    return false;
  }
}
const watchdog = setInterval(() => {
  if (store) {
    try {
      const next = store.tickCapabilities();
      if (next) port.postMessage({ type: "update", snapshot: next });
    } catch {
      port.postMessage({
        type: "fatal",
        message: "权限到期状态未保存，执行已停止，请检查数据存储后重新连接。",
      });
    }
  }
  if (!parentAlive() || Date.now() - lastHeartbeat > heartbeatSilenceLimitMs) {
    extraction?.close();
    store?.close();
    process.exit(1);
  }
}, 1000);
port.on("message", (event) => {
  const message = event.data;
  if (message.type === "heartbeat") {
    lastHeartbeat = Date.now();
    return;
  }
  if (message.type === "shutdown") {
    clearInterval(watchdog);
    extraction?.close();
    store?.close();
    process.exit(0);
  }
  if (!store || message.type !== "request" || !Number.isSafeInteger(message.id))
    return;
  const reply = store.execute(
    message.command,
    message.surface as Surface,
    message.origin === "host" ? "host" : "renderer",
  );
  port.postMessage({ type: "reply", id: message.id, reply });
  extraction?.schedule();
});
