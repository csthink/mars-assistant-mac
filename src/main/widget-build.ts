import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { freezeWidget, widgetLimits, type BuiltWidget } from "../shared/widget";
/** No generated code executes here. Even parsing is isolated and bounded. */
export async function compileWidget(
  source: string,
  workerFile = join(__dirname, "widget-build-worker.cjs"),
): Promise<BuiltWidget> {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > widgetLimits.packageBytes
  )
    throw new Error("控件包超过 1 MiB。");
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, {
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
    let done = false;
    const finish = (error?: Error, build?: BuiltWidget) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(freezeWidget(build!));
        },
        () => reject(new Error("控件包校验进程退出未确认。")),
      );
    };
    const timer = setTimeout(
      () => finish(new Error("控件包校验超时。")),
      widgetLimits.buildMs,
    );
    worker.once("error", () => finish(new Error("控件包校验进程失败。")));
    worker.once("exit", () => finish(new Error("控件包校验进程中断。")));
    worker.once("message", (message) => {
      if (message?.ok && message.build) finish(undefined, message.build);
      else
        finish(
          new Error(
            typeof message?.error === "string"
              ? message.error
              : "控件包校验失败。",
          ),
        );
    });
    worker.postMessage(source);
  });
}
