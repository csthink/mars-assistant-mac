import { _electron, type ElectronApplication } from "@playwright/test";
import { resolve } from "node:path";

/** Background synthetic tests use a bootstrap that isolates OS input before launch. */
export async function launchLocal(
  options: Parameters<typeof _electron.launch>[0],
) {
  const args = options?.args ?? [];
  if (resolve(args[0] ?? "") !== resolve("."))
    throw new Error("Background tests must launch the current repository");
  const client = await _electron.launch({
    ...options,
    args: [resolve("tests/desktop/background-main.cjs"), ...args.slice(1)],
  });
  try {
    await client.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (
          window.isFocusable() ||
          window.isFocused() ||
          window.getOpacity() !== 0
        )
          throw new Error(
            "Background test window is visible or accepts native keyboard focus",
          );
      }
    });
  } catch (error) {
    // A failed isolation assertion must not leave the just-launched app running.
    try {
      await client.close();
    } finally {
      const child = client.process();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    throw error;
  }
  return client;
}

/**
 * Closes a background client the way a restart needs it: the quit confirmation (a turn or a
 * connection check still running, an unconfirmed draft) is answered with "stop and quit", and
 * the call returns only once the process has exited. close() alone resolves when the protocol
 * connection is gone while the application's own quit path is still running and keeps the
 * data root, so a relaunch on the same root could overlap the previous instance (KB-18, KB-19,
 * KB-222 family: a restarted client that read stale or partial state).
 */
export async function closeLocal(
  client: ElectronApplication,
  timeoutMs = 30000,
) {
  const child = client.process();
  try {
    await client.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });
  } catch {
    // The application is already gone; nothing left to answer.
  }
  await client.close();
  if (child.exitCode === null && child.signalCode === null)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Background client did not exit within ${timeoutMs} ms after close`,
          ),
        );
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
}
