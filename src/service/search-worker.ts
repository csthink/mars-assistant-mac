import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { querySearch } from "./search-query";
import { validSearch } from "../shared/search";
const db = new DatabaseSync(String(workerData), { readOnly: true });
db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100");
parentPort?.on("message", (request) => {
  if (!validSearch(request)) return;
  try {
    parentPort?.postMessage(querySearch(db, request));
  } catch {
    parentPort?.postMessage({
      ok: false,
      code: "UNAVAILABLE",
      message: "搜索索引读取失败。请在数据与隐私中重建索引后重试。",
    });
  }
});
