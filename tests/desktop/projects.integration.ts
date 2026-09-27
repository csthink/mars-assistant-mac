import { test, expect } from "@playwright/test";
import { launchLocal } from "./local-client";
import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
test("projects integration: renderer cannot forge folder selection or Host creation and replaced directories are rejected", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-ipc-"));
  const data = join(root, "data"),
    folder = join(root, "selected");
  mkdirSync(data);
  mkdirSync(folder);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() =>
        window.desktop.createProject({
          token: crypto.randomUUID(),
          name: "伪造",
          goal: "",
        }),
      ),
    ).toMatchObject({ ok: false });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, folder);
    const picked = await page.evaluate(() =>
      window.desktop.pickProjectFolder(),
    );
    expect(picked.ok).toBe(true);
    if (!picked.ok) throw Error("selection failed");
    const forged = await page.evaluate(
      async (selection) =>
        window.desktop.command({
          type: "projectCreate",
          id: crypto.randomUUID(),
          name: "越权",
          goal: "",
          folder: selection.folder,
        } as never),
      picked,
    );
    expect(forged.ok).toBe(false);
    renameSync(folder, join(root, "previous"));
    mkdirSync(folder);
    expect(
      await page.evaluate(
        (token) =>
          window.desktop.createProject({ token, name: "替换", goal: "" }),
        picked.token,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        return r.ok ? r.snapshot.projects.length : -1;
      }),
    ).toBe(0);
  } finally {
    await app.close();
  }
});
