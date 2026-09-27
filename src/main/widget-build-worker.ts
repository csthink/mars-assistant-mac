import { parentPort } from "node:worker_threads";
import { buildWidgetPackage, WidgetPackageError } from "./widget-package";
if (!parentPort)
  throw new Error("Widget compiler requires a registered worker port");
parentPort.once("message", (source: unknown) => {
  try {
    if (typeof source !== "string")
      throw new WidgetPackageError("控件包必须为 JSON 文本。");
    parentPort!.postMessage({ ok: true, build: buildWidgetPackage(source) });
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      error:
        error instanceof WidgetPackageError
          ? error.message
          : "控件包校验失败。",
    });
  } finally {
    parentPort!.close();
  }
});
