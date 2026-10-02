import { closeLocal, launchLocal } from "./local-client";
import { displayName } from "../../src/shared/app-name";
import { test, expect } from "@playwright/test";
import { join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

test("startup: invalid data root remains disconnected and can quit", async () => {
  const application = await launchLocal({
    args: [
      resolve("."),
      `--data-root=${resolve(".test-data/disposable", `missing-${randomUUID()}`)}`,
    ],
    cwd: resolve("."),
  });
  const child = application.process();
  try {
    const window = await application.firstWindow();
    await expect(
      window.getByText(
        "数据目录不存在。请检查指定目录，应用没有改用其他目录。",
      ),
    ).toBeVisible();
    const closed = application.waitForEvent("close", { timeout: 5000 });
    const label = `退出 ${displayName}`;
    await application.evaluate(({ Menu }, target) => {
      Menu.getApplicationMenu()
        ?.items[0].submenu?.items.find((item) => item.label === target)
        ?.click();
    }, label);
    await closed;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("startup: a data root whose only entry is the Finder's .DS_Store opens, and the file is left as it was", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/finder-root-"));
  const finder = Buffer.from("Bud1 finder metadata");
  writeFileSync(join(root, ".DS_Store"), finder);
  const application = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const window = await application.firstWindow();
    await expect(
      window
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await expect(window.getByText("目录中包含非本应用数据")).toHaveCount(0);
    expect(existsSync(join(root, "state.sqlite"))).toBe(true);
    expect(readFileSync(join(root, ".DS_Store"))).toEqual(finder);
  } finally {
    await closeLocal(application);
  }
});
