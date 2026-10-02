import { launchLocal } from "./local-client";
import { displayNameFor } from "../../src/shared/app-name";
import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
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
    const label = `退出 ${displayNameFor(await application.evaluate(({ app }) => app.getLocale()))}`;
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
