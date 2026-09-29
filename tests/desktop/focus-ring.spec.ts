import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { closeLocal, launchLocal } from "./local-client";
import { goTo, railEntry, ready, recent, requestSize } from "./shell";
import { Store } from "../../src/service/store";

function seed() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/focus-ring-"));
  const store = new Store(root);
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    store.execute({ type: "create", id }, "main");
    store.execute(
      {
        type: "renameConversation",
        id,
        title: index ? "第二个对话" : "第一个对话",
        revision: 0,
      },
      "main",
    );
  }
  const insert = store.db.prepare(
    "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
  );
  const at = new Date().toISOString();
  for (let i = 0; i < 12; i++)
    insert.run(
      randomUUID(),
      ids[0],
      null,
      i % 2 ? "assistant" : "user",
      `第 ${i + 1} 段文字。`.repeat(8),
      at,
    );
  store.close();
  return { root, ids };
}

/**
 * Walks the page with Tab from the first control of `scope` (or of the page) until focus leaves it or comes
 * back to the start, and returns every keyboard-focused control whose ring (the border box grown by the
 * outline width and offset) is cut by an ancestor that clips its overflow.
 */
async function clippedRings(page: Page, label: string, scope?: string) {
  // A key press makes the next programmatic focus a keyboard focus, so its ring shows.
  await page.keyboard.press("Shift");
  await page.evaluate((scope) => {
    const root = scope ? document.querySelector(scope)! : document.body;
    const first = root.querySelector<HTMLElement>(
      "button:not(:disabled), [tabindex='0'], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]",
    );
    (document.activeElement as HTMLElement | null)?.blur();
    first?.focus();
  }, scope);
  const found: string[] = [];
  const seen = new Set<string>();
  let steps = 0;
  for (; steps < 300; steps++) {
    const result = await page.evaluate((scope) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { done: true };
      if (scope && !el.closest(scope)) return { done: true };
      if (!el.dataset.ringId)
        el.dataset.ringId = String(Math.random()).slice(2);
      const style = getComputedStyle(el);
      const extent =
        style.outlineStyle === "none"
          ? 0
          : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const box = el.getBoundingClientRect();
      const ring = {
        top: box.top - extent,
        bottom: box.bottom + extent,
        left: box.left - extent,
        right: box.right + extent,
      };
      const cuts: string[] = [];
      if (el.matches(":focus-visible") && extent > 0 && box.width && box.height)
        for (let a = el.parentElement; a; a = a.parentElement) {
          const o = getComputedStyle(a);
          const x = o.overflowX !== "visible";
          const y = o.overflowY !== "visible";
          if (!x && !y) continue;
          const c = a.getBoundingClientRect();
          const inner = {
            top: c.top + parseFloat(o.borderTopWidth),
            bottom: c.bottom - parseFloat(o.borderBottomWidth),
            left: c.left + parseFloat(o.borderLeftWidth),
            right: c.right - parseFloat(o.borderRightWidth),
          };
          const cut = {
            top: y ? inner.top - ring.top : 0,
            bottom: y ? ring.bottom - inner.bottom : 0,
            left: x ? inner.left - ring.left : 0,
            right: x ? ring.right - inner.right : 0,
          };
          const sides = Object.entries(cut)
            .filter(([, v]) => v > 0.5)
            .map(([k, v]) => `${k} ${v.toFixed(1)}`);
          if (sides.length)
            cuts.push(
              `${a.tagName.toLowerCase()}.${String(a.className).split(" ")[0]} ${sides.join(", ")}`,
            );
        }
      return {
        done: false,
        id: el.dataset.ringId,
        name: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24)}`,
        cuts,
      };
    }, scope);
    if (result.done || seen.has(result.id!)) break;
    seen.add(result.id!);
    if (result.cuts!.length)
      found.push(`${label}: ${result.name} cut by ${result.cuts!.join("; ")}`);
    await page.keyboard.press("Tab");
  }
  expect(steps, `${label}: no control reached`).toBeGreaterThan(0);
  return found;
}

test("focus rings: every control reached with Tab shows its whole ring inside the rail, the sidebar, the centre, the right column and the settings dialog at both window sizes in light and dark", async ({}, info) => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  const failures: string[] = [];
  try {
    await ready(page);
    for (const appearance of ["light", "dark"] as const) {
      const reply = await page.evaluate(
        (appearance) =>
          window.desktop.command({ type: "setAppearance", appearance }),
        appearance,
      );
      expect(reply.ok).toBe(true);
      for (const [w, h] of [
        [900, 680],
        [1440, 900],
      ] as const) {
        const [width] = await requestSize(app, page, w, h);
        const tag = `${appearance} ${width}`;
        await (
          await recent(page)
        )
          .getByRole("button", {
            name: `对话 ${ids[0].slice(0, 8)}`,
            exact: true,
          })
          .click();
        failures.push(...(await clippedRings(page, `${tag} conversation`)));
        await page
          .locator(".center-header")
          .getByRole("button", { name: "打开右栏" })
          .click();
        failures.push(
          ...(await clippedRings(page, `${tag} right column`, "#right-panel")),
        );
        await page
          .getByRole("complementary", { name: "右栏" })
          .getByRole("button", { name: "收起右栏" })
          .click();
        await railEntry(page, "主页").click();
        failures.push(...(await clippedRings(page, `${tag} home`, ".center")));
        for (const view of ["控件", "项目", "待处理", "运行记录"] as const) {
          await goTo(page, view);
          failures.push(
            ...(await clippedRings(page, `${tag} ${view}`, ".center")),
          );
        }
        await goTo(page, "设置");
        for (const category of [
          "通用",
          "模型",
          "最近删除",
          "扩展管理",
          "访问权限",
          "数据保留",
          "数据与隐私",
        ]) {
          await page
            .getByRole("dialog", { name: "设置" })
            .getByRole("button", { name: category, exact: true })
            .click();
          failures.push(
            ...(await clippedRings(
              page,
              `${tag} 设置 ${category}`,
              ".settings-dialog",
            )),
          );
        }
        await page.keyboard.press("Escape");
        await page.screenshot({
          path: info.outputPath(`${tag.replace(" ", "-")}.png`),
        });
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(app);
  }
});

test("keyboard: Escape closes only the innermost layer and returns focus to its entry, focus stays on a rail entry opened by keyboard, and pointer use leaves no ring", async () => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await ready(page);
    await requestSize(app, page, 900, 680);
    await (
      await recent(page)
    )
      .getByRole("button", { name: `对话 ${ids[0].slice(0, 8)}`, exact: true })
      .click();
    const toggle = page
      .locator(".center-header")
      .getByRole("button", { name: "打开右栏" });
    await toggle.click();
    const panel = page.getByRole("complementary", { name: "右栏" });
    // Take over, then float the sidebar, then open a row menu inside it: four layers.
    const takeover = panel.getByRole("button", { name: "接管中栏" });
    await takeover.click();
    const railButton = page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: "展开侧栏" });
    await railButton.click();
    const sidebar = page.locator("#main-sidebar");
    await expect(sidebar).toHaveAttribute("data-overlay", "true");
    const more = sidebar.getByLabel(`对话菜单 ${ids[1].slice(0, 8)}`, {
      exact: true,
    });
    await more.click();
    const menu = page.getByRole("menu", { name: "对话菜单" });
    await expect(menu).toBeVisible();
    // 1. the menu
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(sidebar).toHaveAttribute("data-overlay", "true");
    // 2. a modal dialog opened from the rail over everything
    await page.getByRole("button", { name: /^我，个人空间/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^我，个人空间/ }),
    ).toBeFocused();
    // 3. the floating sidebar (the press on the avatar folded it; float it again)
    await railButton.click();
    await expect(sidebar).toHaveAttribute("data-overlay", "true");
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveCount(0);
    await expect(railButton).toBeFocused();
    await expect(page.locator(".center")).toBeHidden();
    // 4. the takeover
    await page.keyboard.press("Escape");
    await expect(page.locator(".center")).toBeVisible();
    await expect(takeover).toBeFocused();
    // 5. focus in the right column folds it
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(toggle).toBeFocused();
    // Nothing left: a further Escape changes nothing and keeps the focus.
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    // A rail entry opened by keyboard keeps the focus after the centre redraws, with its ring.
    await railEntry(page, "控件").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".center").getByRole("heading", { level: 1, name: "控件" }),
    ).toBeVisible();
    await expect(railEntry(page, "控件")).toBeFocused();
    expect(
      await railEntry(page, "控件").evaluate((el) =>
        el.matches(":focus-visible"),
      ),
    ).toBe(true);
    // The pointer leaves no ring.
    await railEntry(page, "待处理").click();
    expect(
      await railEntry(page, "待处理").evaluate((el) =>
        el.matches(":focus-visible"),
      ),
    ).toBe(false);
  } finally {
    await closeLocal(app);
  }
});
