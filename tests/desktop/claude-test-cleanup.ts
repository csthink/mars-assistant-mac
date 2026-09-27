import { expect, type ElectronApplication } from "@playwright/test";
/** End only Claude executions owned by this isolated product instance before closing it. */
export async function stopClaudeTestTurns(
  app: ElectronApplication,
  dataRoot: string,
) {
  const page = await app.firstWindow();
  const ids = await page.evaluate(async (expectedRoot) => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw Error(reply.message);
    if (reply.snapshot.dataRoot !== expectedRoot)
      throw Error("Unexpected test data root");
    const ids = reply.snapshot.activeTurns
      .filter((turn) => turn.connection.provider === "claude")
      .map((turn) => turn.executionId);
    for (const executionId of ids) {
      const stopped = await window.desktop.command({
        type: "stopExecution",
        executionId,
      });
      if (!stopped.ok) throw Error(stopped.message);
    }
    return ids;
  }, dataRoot);
  await expect
    .poll(
      async () =>
        page.evaluate(async (ids) => {
          const reply = await window.desktop.command({ type: "snapshot" });
          if (!reply.ok) throw Error(reply.message);
          return reply.snapshot.activeTurns.filter((turn) =>
            ids.includes(turn.executionId),
          ).length;
        }, ids),
      { timeout: 15000 },
    )
    .toBe(0);
  return ids;
}
