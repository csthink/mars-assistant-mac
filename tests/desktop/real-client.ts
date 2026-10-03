import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Starts the real client directly and connects over CDP. Playwright's Electron
 * launcher forces --use-mock-keychain, under which the user's safeStorage vault
 * cannot be decrypted, so real-provider runs must not use it.
 */
export interface RealClient {
  process: ChildProcess;
  browser: Browser;
  page: Page;
  /** Evaluates in the Electron main process over the Node inspector; used to script the file dialog. */
  mainEval: (expression: string) => Promise<unknown>;
  /** Makes the next host file dialog answer with these paths, as a user picking them would. */
  pickFiles: (paths: string[]) => Promise<void>;
}
/** Minimal Node inspector client: one WebSocket, Runtime.evaluate, no debugger session. */
async function inspectorClient(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error("inspector connect failed")),
      { once: true },
    );
  });
  let nextId = 1;
  const pending = new Map<
    number,
    (message: {
      result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
    }) => void
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    const resolve =
      message.id !== undefined ? pending.get(message.id) : undefined;
    if (resolve) {
      pending.delete(message.id!);
      resolve(message as never);
    }
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{
      result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
    }>((done) => {
      const id = nextId++;
      pending.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call("Runtime.enable");
  return {
    async evaluate(expression: string) {
      const reply = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (reply.result?.exceptionDetails)
        throw new Error(
          `main evaluate failed: ${JSON.stringify(reply.result.exceptionDetails)}`,
        );
      return reply.result?.result?.value;
    },
    close: () => socket.close(),
  };
}
const electronBinary = resolve(
  "node_modules/electron/dist",
  readFileSync("node_modules/electron/path.txt", "utf8").trim(),
);
export async function launchReal(
  root: string,
  options: { background?: boolean } = {},
): Promise<RealClient> {
  const child = spawn(
    electronBinary,
    [
      options.background
        ? resolve("tests/desktop/background-main.cjs")
        : resolve("."),
      `--data-root=${root}`,
      "--remote-debugging-port=0",
      "--inspect=0",
    ],
    { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  const endpoints = await new Promise<{ devtools: string; inspector: string }>(
    (done, fail) => {
      let buffer = "";
      const timer = setTimeout(
        () => fail(new Error("DevTools endpoint not announced")),
        30_000,
      );
      child.stderr?.on("data", (chunk) => {
        buffer += chunk;
        const devtools = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        const inspector = buffer.match(/Debugger listening on (ws:\/\/\S+)/);
        if (devtools && inspector) {
          clearTimeout(timer);
          done({ devtools: devtools[1], inspector: inspector[1] });
        }
      });
      child.on("exit", () => fail(new Error("Electron exited early")));
    },
  );
  const main = await inspectorClient(endpoints.inspector);
  const browser = await chromium.connectOverCDP(endpoints.devtools);
  const start = Date.now();
  let page: Page | undefined;
  while (!page && Date.now() - start < 30_000) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().endsWith("index.html"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!page) throw new Error("Main window not found over CDP");
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  const mainEval = (expression: string) => main.evaluate(expression);
  const pickFiles = async (paths: string[]) => {
    await mainEval(
      `(() => { const { dialog } = process.mainModule.require("electron"); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ${JSON.stringify(paths)} }); return "ok"; })()`,
    );
  };
  return { process: child, browser, page, mainEval, pickFiles };
}
/** Graceful shutdown asks the app to quit; a forced one ends it immediately. */
export async function shutdownReal(
  client: RealClient | undefined,
  graceful: boolean,
) {
  if (!client) return;
  await client.browser.close().catch(() => {});
  const child = client.process;
  if (child.exitCode !== null) return;
  if (!graceful) {
    child.kill("SIGKILL");
    return;
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
