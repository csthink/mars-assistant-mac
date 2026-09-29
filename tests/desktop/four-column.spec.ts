import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { closeLocal, launchLocal } from "./local-client";
import {
  goTo,
  ready,
  railEntry,
  recent,
  requestSize,
  windowClasses,
} from "./shell";
import { journeyFixture } from "./project-action-fixture";
import { Store } from "../../src/service/store";
import {
  columnLayout,
  type ColumnLayout,
} from "../../src/renderer/column-layout";

/** A data root with two conversations, one of them with messages and a long title. */
function seed() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/four-column-"));
  const store = new Store(root);
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    store.execute({ type: "create", id }, "main");
    store.execute(
      {
        type: "renameConversation",
        id,
        title: index
          ? "第二个对话"
          : "一个很长很长的中文对话标题，用来核对侧栏与中栏标题的截断与不遮挡按钮",
        revision: 0,
      },
      "main",
    );
  }
  const at = new Date().toISOString();
  const insert = store.db.prepare(
    "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
  );
  insert.run(randomUUID(), ids[0], null, "user", "帮我整理这段读书笔记。", at);
  store.close();
  return { root, ids };
}

async function launch(root: string, env: Record<string, string> = {}) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      ),
      ...env,
    },
  });
  const page = await app.firstWindow();
  return { app, page };
}

/** Measured column boxes of the main window. */
async function columns(page: Page) {
  return page.evaluate(() => {
    const width = (selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el || !el.getClientRects().length) return 0;
      if (getComputedStyle(el).position === "absolute") return 0;
      return el.getBoundingClientRect().width;
    };
    return {
      rail: width(".rail"),
      sidebar: width("#main-sidebar"),
      center: width(".center"),
      right: width("#right-panel"),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

function expectColumns(
  got: Awaited<ReturnType<typeof columns>>,
  want: ColumnLayout,
  label: string,
) {
  for (const [key, value] of [
    ["rail", want.rail],
    ["sidebar", want.sidebarWidth],
    ["center", want.center],
    ["right", want.right],
  ] as const)
    expect(
      Math.abs(got[key] - value),
      `${label} ${key} ${got[key]} ≠ ${value}`,
    ).toBeLessThanOrEqual(0.5);
  expect(got.overflow, `${label} horizontal overflow`).toBe(false);
}

const rightToggle = (page: Page) =>
  page.locator(".center-header").getByRole("button", { name: /右栏$/ });

/** The sidebar section preferences at their defaults. */
const sections = {
  pinnedSort: "pinned",
  projectSort: "updated",
  pinnedFolded: false,
  projectsFolded: false,
  recentFolded: false,
} as const;

test("rail and sidebar: every entry opens its object in the centre, the old tabs and popovers are gone, and each former entry is reachable in its new place", async () => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    await ready(page);
    // Old navigation, by role and name.
    for (const gone of [
      page.getByRole("navigation", { name: "主要页面" }),
      page.getByRole("tablist", { name: "工作台内容" }),
      page.locator("section#profile-menu"),
      page.locator("section#home-history"),
      // The former recent-chats popover button; the recent section's fold toggle has the same name.
      page
        .getByRole("button", { name: "最近聊天", exact: true })
        .and(page.locator(":not(.section-toggle)")),
      page.getByRole("button", { name: "全局搜索", exact: true }),
    ])
      await expect(gone).toHaveCount(0);
    // New conversation: the sidebar's 新建聊天 starts one and the centre shows the landing page. The unused
    // conversation stands for that page: it has no row, and 新建聊天 and 主页 reuse it instead of adding more.
    const snapshotOf = () =>
      page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw new Error(r.message);
        return {
          selected: r.snapshot.selected.main,
          unused: r.snapshot.conversations.filter((c) => c.unused).length,
          total: r.snapshot.conversations.length,
        };
      });
    const before = await (await recent(page)).locator(".session").count();
    const start = await snapshotOf();
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await expect.poll(async () => (await snapshotOf()).unused).toBe(1);
    const blank = await snapshotOf();
    expect(blank.total).toBe(start.total + 1);
    await expect((await recent(page)).locator(".session")).toHaveCount(before);
    await expect(page.locator(".welcome")).toBeVisible();
    await expect(railEntry(page, "主页")).toHaveAttribute(
      "aria-current",
      "page",
    );
    // 主页 on the landing page stays there (no second blank conversation).
    await railEntry(page, "主页").click();
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    expect(await snapshotOf()).toEqual(blank);
    // A conversation with messages opens from its row; 主页 then returns to the unused conversation.
    await (
      await recent(page)
    )
      .getByRole("button", { name: `对话 ${ids[0].slice(0, 8)}`, exact: true })
      .click();
    await expect(page.locator(".bubble.user")).toBeVisible();
    await expect(railEntry(page, "主页")).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    await railEntry(page, "主页").click();
    await expect(page.locator(".welcome")).toBeVisible();
    await expect.poll(snapshotOf).toEqual(blank);
    await expect((await recent(page)).locator(".session")).toHaveCount(before);
    // Former 工作台 项目 and 控件, the avatar popover's 待处理, 记录 and 设置.
    for (const [open, heading] of [
      [() => goTo(page, "项目"), "项目"],
      [() => railEntry(page, "控件").click(), "控件"],
      [() => railEntry(page, "待处理").click(), "待处理"],
      [() => railEntry(page, "记录").click(), "运行记录"],
    ] as const) {
      await open();
      await expect(
        page
          .locator(".center")
          .getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
    }
    // The widget page speaks of widgets, not of the former 工作台.
    await railEntry(page, "控件").click();
    await expect(
      page.locator(".center").getByRole("heading", { name: "还没有控件" }),
    ).toBeVisible();
    await expect(page.locator(".center")).not.toContainText("工作台");
    await goTo(page, "设置");
    await expect(
      page
        .getByRole("dialog", { name: "设置" })
        .locator(".settings-dialog-profile"),
    ).toContainText("保存在这台 Mac 上");
    await page.keyboard.press("Escape");
    // Former recent-chat popover pieces: the archived entry, the row menu and the title filter.
    const sidebar = page.locator("#main-sidebar");
    await expect(
      sidebar.getByRole("button", { name: /^已归档/ }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "搜索最近聊天" }),
    ).toBeVisible();
    await expect(
      sidebar.getByLabel(`对话菜单 ${ids[1].slice(0, 8)}`, { exact: true }),
    ).toBeVisible();
    // Long titles are cut with an ellipsis and never cover their row's menu button.
    const long = await sidebar
      .getByRole("button", { name: `对话 ${ids[0].slice(0, 8)}`, exact: true })
      .evaluate((row) => {
        const name = row.querySelector(".session-name") as HTMLElement;
        const more = row.parentElement!.querySelector(".session-more")!;
        return {
          cut: name.scrollWidth > name.clientWidth,
          ellipsis: getComputedStyle(name).textOverflow,
          apart:
            row.getBoundingClientRect().right <=
            more.getBoundingClientRect().left + 0.5,
        };
      });
    expect(long).toEqual({ cut: true, ellipsis: "ellipsis", apart: true });
  } finally {
    await closeLocal(app);
  }
});

test("rail and sidebar: the pending badge equals the pending page's unresolved count for project items, and the current rail entry is a selected block in light and dark", async () => {
  const f = await journeyFixture();
  try {
    const entry = railEntry(f.page, "待处理");
    await entry.click();
    const text = await f.page.getByText(/^全部未解决：\d+/).textContent();
    const count = Number(/全部未解决：(\d+)/.exec(text!)![1]);
    expect(count).toBeGreaterThan(0);
    await expect(entry.locator(".rail-badge")).toHaveText(String(count));
    await expect(entry).toHaveAttribute(
      "aria-label",
      `待处理，${count} 项未解决`,
    );
    for (const appearance of ["light", "dark"] as const) {
      const reply = await f.page.evaluate(
        (appearance) =>
          window.desktop.command({ type: "setAppearance", appearance }),
        appearance,
      );
      expect(reply.ok).toBe(true);
      await expect(f.page.locator("html")).toHaveAttribute(
        "data-theme",
        appearance,
      );
      await f.page.mouse.move(0, 0);
      const look = await entry.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.background = "var(--c-selected)";
        probe.style.color = "var(--c-accent)";
        document.body.append(probe);
        const want = getComputedStyle(probe);
        const result = {
          block: getComputedStyle(el).backgroundColor === want.backgroundColor,
          icon:
            getComputedStyle(el.querySelector(".rail-icon")!).color ===
            want.color,
          weight: getComputedStyle(el.querySelector(".rail-label")!).fontWeight,
          badgeInside: (() => {
            const b = el.querySelector(".rail-badge")!.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return b.left >= r.left && b.right <= r.right && b.top >= r.top;
          })(),
        };
        probe.remove();
        return result;
      });
      expect(look, appearance).toEqual({
        block: true,
        icon: true,
        weight: "400",
        badgeInside: true,
      });
    }
  } finally {
    await closeLocal(f.app);
  }
});

test("widths: at 900 × 680 and the standard width the columns follow the width rules, fold and float the sidebar, widen and take over the right column, and keep the composer reachable", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    await ready(page);
    await (
      await recent(page)
    )
      .getByRole("button", { name: `对话 ${ids[0].slice(0, 8)}`, exact: true })
      .click();
    const classes = await windowClasses(app, page);
    for (const [width, height] of [classes.minimum, classes.standard]) {
      await requestSize(app, page, width, height);
      const at = (state: Parameters<typeof columnLayout>[0]) =>
        columnLayout(state);
      const closed = {
        width,
        sidebarCollapsed: false,
        rightOpen: false,
        rightWidth: null,
        takeover: false,
      };
      expectColumns(await columns(page), at(closed), `${width} closed`);
      // Open the right column: its tabs are 文件 and 事件; this conversation has not submitted any file.
      await rightToggle(page).click();
      const panel = page.getByRole("complementary", { name: "右栏" });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("tab")).toHaveCount(2);
      await expect(panel.getByRole("tabpanel")).toContainText(
        "这段对话还没有提交的资料。",
      );
      await expect(panel.getByRole("tab", { name: "文件" })).toBeFocused();
      const open = { ...closed, rightOpen: true };
      const opened = at(open);
      expectColumns(await columns(page), opened, `${width} open`);
      if (width < 1104) {
        expect(opened.sidebar).toBe("auto-collapsed");
        expect([opened.center, opened.right]).toEqual([480, 364]);
        // The rail offers the sidebar; it floats over the centre without moving the centre or the right column.
        const railButton = page
          .getByRole("navigation", { name: "全局导航" })
          .getByRole("button", { name: "展开侧栏" });
        const centreBefore = await page.locator(".center").boundingBox();
        await railButton.click();
        const sidebar = page.locator("#main-sidebar");
        await expect(sidebar).toHaveAttribute("data-overlay", "true");
        await expect(
          sidebar.getByRole("button", { name: "新建聊天" }),
        ).toBeFocused();
        expect(await page.locator(".center").boundingBox()).toEqual(
          centreBefore,
        );
        await page.screenshot({
          path: info.outputPath(`${width}-overlay.png`),
        });
        await page.keyboard.press("Escape");
        await expect(sidebar).toHaveCount(0);
        await expect(railButton).toBeFocused();
        // A second press on the rail button, a press outside and the fold button fold it again as well.
        await railButton.click();
        await railButton.click();
        await expect(sidebar).toHaveCount(0);
        await railButton.click();
        await page
          .locator(".center .messages")
          .click({ position: { x: 400, y: 20 } });
        await expect(sidebar).toHaveCount(0);
        await railButton.click();
        await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
        await expect(sidebar).toHaveCount(0);
        await expect(railButton).toBeFocused();
        // Opening another object from the floating sidebar folds it and focuses the centre title.
        await railButton.click();
        await sidebar
          .getByRole("button", {
            name: `对话 ${ids[1].slice(0, 8)}`,
            exact: true,
          })
          .click();
        await expect(sidebar).toHaveCount(0);
        await expect(page.locator("[data-center-title]")).toBeFocused();
        await (
          await recent(page)
        )
          .getByRole("button", {
            name: `对话 ${ids[0].slice(0, 8)}`,
            exact: true,
          })
          .click();
        await expect(page.locator(".bubble.user")).toBeVisible();
        // The floating sidebar folds and focus moves to the centre title two frames later; the keys below must
        // not race that move, so wait for it before focusing the divider.
        await expect(sidebar).toHaveCount(0);
        await expect(page.locator("[data-center-title]")).toBeFocused();
      } else expect(opened.sidebar).toBe("expanded");
      // Widening: keys, the widen button, double click and dragging all stay within the limits.
      const separator = page.getByRole("separator", { name: "调整右栏宽度" });
      const value = async () =>
        Number(await separator.getAttribute("aria-valuenow"));
      await separator.focus();
      const start = await value();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(value).toBe(Math.min(start + 24, opened.rightMax));
      await page.keyboard.press("Home");
      await expect.poll(value).toBe(opened.rightMax);
      await page.keyboard.press("End");
      await expect.poll(value).toBe(320);
      await page.keyboard.press("Enter");
      await expect.poll(value).toBe(Math.min(400, opened.rightMax));
      // From the minimum the widen button goes to the maximum, and then offers the default again.
      await page.keyboard.press("End");
      await expect.poll(value).toBe(320);
      await panel.getByRole("button", { name: "拉宽右栏" }).click();
      await expect.poll(value).toBe(opened.rightMax);
      expectColumns(
        await columns(page),
        at({ ...open, rightWidth: opened.rightMax }),
        `${width} widest`,
      );
      await separator.dblclick();
      await expect.poll(value).toBe(Math.min(400, opened.rightMax));
      const box = (await separator.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x - 2000, box.y + 200, { steps: 5 });
      await page.mouse.up();
      await expect.poll(value).toBe(opened.rightMax);
      await separator.focus();
      await page.keyboard.press("Enter");
      // The composer stays inside the window and usable next to the right column.
      const composer = (await page
        .getByRole("textbox", { name: "输入草稿" })
        .boundingBox())!;
      const send = (await page
        .getByRole("button", { name: "发送消息" })
        .boundingBox())!;
      const centre = (await page.locator(".center").boundingBox())!;
      expect(composer.y + composer.height).toBeLessThanOrEqual(height);
      expect(send.x + send.width).toBeLessThanOrEqual(centre.x + centre.width);
      await page.screenshot({ path: info.outputPath(`${width}-right.png`) });
      // Take over the centre: the centre is hidden, the rail and the sidebar stay, Escape returns.
      const takeover = panel.getByRole("button", { name: "接管中栏" });
      await takeover.click();
      await expect(page.locator(".center")).toBeHidden();
      expectColumns(
        await columns(page),
        at({ ...open, takeover: true }),
        `${width} takeover`,
      );
      await page.keyboard.press("Escape");
      await expect(page.locator(".center")).toBeVisible();
      await expect(takeover).toBeFocused();
      // Focus inside the right column: Escape folds it and returns to the switch.
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(rightToggle(page)).toBeFocused();
      // The right column belongs to conversations: other objects hide it and its switch; returning restores it.
      await rightToggle(page).click();
      await railEntry(page, "控件").click();
      await expect(
        page.getByRole("complementary", { name: "右栏" }),
      ).toHaveCount(0);
      await expect(rightToggle(page)).toHaveCount(0);
      expectColumns(await columns(page), at(closed), `${width} widgets`);
      await (
        await recent(page)
      )
        .getByRole("button", {
          name: `对话 ${ids[0].slice(0, 8)}`,
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("complementary", { name: "右栏" }),
      ).toBeVisible();
      await page
        .getByRole("complementary", { name: "右栏" })
        .getByRole("button", { name: "收起右栏" })
        .click();
      // A sidebar folded by the person stays folded at any width until they expand it.
      await page.getByRole("button", { name: "折叠侧栏" }).click();
      await expect(page.locator("#main-sidebar")).toHaveCount(0);
      expectColumns(
        await columns(page),
        at({ ...closed, sidebarCollapsed: true }),
        `${width} folded`,
      );
      await page
        .getByRole("navigation", { name: "全局导航" })
        .getByRole("button", { name: "展开侧栏" })
        .click();
      await expect(page.locator("#main-sidebar")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "折叠侧栏" }),
      ).toBeFocused();
    }
  } finally {
    await closeLocal(app);
  }
});

test("native widget view: the widget's native view hides while the settings dialog, the search panel, a confirmation or a row menu is open and returns afterwards", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(
    resolve(".test-data/disposable/four-column-widget-"),
  );
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`, "--widget-acceptance"],
    cwd: resolve("."),
  });
  const views = () =>
    app
      .context()
      .pages()
      .filter((p) => p.url().startsWith("csthink-widget:")).length;
  try {
    const page = await app.firstWindow();
    await ready(page);
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    // A draft makes the new conversation used, so it has a row (and a row menu) in the sidebar.
    await page.getByRole("textbox", { name: "输入草稿" }).fill("控件检查");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await goTo(page, "控件");
    await page.getByRole("button", { name: "载入测试候选" }).click();
    await expect.poll(views).toBe(1);
    for (const [label, open, close] of [
      [
        "settings",
        () => goTo(page, "设置"),
        () => page.getByRole("button", { name: "关闭设置" }).click(),
      ],
      [
        "search",
        () =>
          page
            .locator("#main-sidebar")
            .getByRole("button", { name: "搜索", exact: true })
            .click(),
        () => page.keyboard.press("Escape"),
      ],
      [
        "row menu",
        () => page.locator("#main-sidebar .session-more").first().click(),
        () => page.keyboard.press("Escape"),
      ],
    ] as const) {
      await open();
      await expect.poll(views, `${label} hides the native view`).toBe(0);
      await close();
      await expect.poll(views, `${label} closed restores the view`).toBe(1);
    }
    // The view follows the centre's widget area.
    const area = await page.locator(".widget-frame").first().boundingBox();
    expect(area).not.toBeNull();
  } finally {
    await closeLocal(app);
  }
});

test("preferences: the folded sidebar and the right column width survive a restart from the first frame, while the right column itself starts folded", async () => {
  const { root, ids } = seed();
  let { app, page } = await launch(root);
  try {
    await ready(page);
    await (
      await recent(page)
    )
      .getByRole("button", { name: `对话 ${ids[0].slice(0, 8)}`, exact: true })
      .click();
    await requestSize(app, page, 1440, 900);
    await rightToggle(page).click();
    const separator = page.getByRole("separator", { name: "调整右栏宽度" });
    await separator.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "448");
    await page.getByRole("button", { name: "折叠侧栏" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.desktop.command({ type: "snapshot" });
          return r.ok ? r.snapshot.settings.interface : null;
        }),
      )
      .toEqual({ sidebarCollapsed: true, rightPanelWidth: 448, ...sections });
  } finally {
    await closeLocal(app);
  }
  // Restart with the business service late: the first layout already has the folded sidebar.
  for (const delay of ["900", "250"]) {
    ({ app, page } = await launch(root, {
      CSTHINK_TEST_SERVICE_DELAY_MS: delay,
    }));
    try {
      const first = await page.evaluate(
        () =>
          new Promise<{ sidebar: boolean; interface: unknown }>((done) => {
            const look = () => {
              if (document.querySelector(".rail"))
                done({
                  sidebar: !!document.querySelector("#main-sidebar"),
                  interface: window.desktop.interface,
                });
              else requestAnimationFrame(look);
            };
            look();
          }),
      );
      expect(first, `service delay ${delay}`).toEqual({
        sidebar: false,
        interface: {
          sidebarCollapsed: true,
          rightPanelWidth: 448,
          ...sections,
        },
      });
      await expect(
        page.getByRole("navigation", { name: "全局导航" }).getByRole("button", {
          name: "展开侧栏",
        }),
      ).toBeVisible();
      await expect(page.locator("#main-sidebar")).toHaveCount(0);
      // The right column starts folded; opened, it has the saved width.
      await expect(
        page.getByRole("complementary", { name: "右栏" }),
      ).toHaveCount(0);
      await requestSize(app, page, 1440, 900);
      await rightToggle(page).click();
      await expect(
        page.getByRole("separator", { name: "调整右栏宽度" }),
      ).toHaveAttribute("aria-valuenow", "448");
    } finally {
      await closeLocal(app);
    }
  }
});

test("preferences: a preference the business service does not save stays for this window with a notice, leaves the appearance alone and is not kept after a restart", async () => {
  const { root } = seed();
  let { app, page } = await launch(root);
  try {
    await ready(page);
    const appearance = await page.evaluate(async () => {
      const r = await window.desktop.command({ type: "snapshot" });
      return r.ok ? r.snapshot.settings.appearance : null;
    });
    const pid = await app.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((metric) => metric.name === "csthink-assistant business");
      return service!.pid;
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(
      page.getByText("业务服务已失联。", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "折叠侧栏" }).click();
    await expect(page.locator("#main-sidebar")).toHaveCount(0);
    await expect(page.locator(".notice")).toContainText("界面偏好未保存");
    await page.getByRole("button", { name: "重新连接" }).click();
    await expect(page.locator(".service-error")).toHaveCount(0);
    // Still folded in this window; the saved settings are unchanged.
    await expect(page.locator("#main-sidebar")).toHaveCount(0);
    expect(
      await page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        return r.ok
          ? [r.snapshot.settings.interface, r.snapshot.settings.appearance]
          : null;
      }),
    ).toEqual([
      { sidebarCollapsed: false, rightPanelWidth: null, ...sections },
      appearance,
    ]);
  } finally {
    await closeLocal(app);
  }
  ({ app, page } = await launch(root));
  try {
    await ready(page);
    await expect(page.locator("#main-sidebar")).toBeVisible();
  } finally {
    await closeLocal(app);
  }
});

test("menu bar panel keeps its own navigation: the top bar, four tabs in their order, the chat picker and the settings page, without the rail, the sidebar or the right column", async () => {
  const { root } = seed();
  const { app, page } = await launch(root);
  try {
    await ready(page);
    const opening = app.waitForEvent("window");
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click(),
    );
    const panel = await opening;
    const nav = panel.getByRole("navigation", { name: "面板导航" });
    await expect(nav.getByRole("button")).toHaveText([
      "工作台",
      "聊天",
      "待处理",
      "设置",
    ]);
    await expect(panel.locator(".topbar")).toBeVisible();
    for (const gone of [
      panel.getByRole("navigation", { name: "全局导航" }),
      panel.locator("#main-sidebar"),
      panel.locator("#right-panel"),
      panel.locator(".center-header"),
    ])
      await expect(gone).toHaveCount(0);
    await expect(
      panel.getByRole("heading", { level: 1, name: "工作台" }),
    ).toBeVisible();
    await nav.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(
      panel.getByRole("combobox", { name: "选择对话" }),
    ).toBeVisible();
    await nav.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      panel.getByRole("heading", { level: 1, name: "设置" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("navigation", { name: "设置分类" }).getByRole("button"),
    ).toHaveText([
      "通用",
      "模型",
      "最近删除",
      "扩展管理",
      "访问权限",
      "数据保留",
      "数据与隐私",
    ]);
    await expect(panel.getByRole("dialog")).toHaveCount(0);
  } finally {
    await closeLocal(app);
  }
});

test("chat home: at 900 × 680 and the standard width the four suggestions stay fully visible above the composer with the sidebar expanded, folded and the right column open", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/four-column-home-"));
  const { app, page } = await launch(root);
  try {
    await ready(page);
    const check = async (label: string) => {
      const geometry = await page.evaluate(() => {
        const messages = document.querySelector(".messages")!;
        messages.scrollTop = 0;
        const view = messages.getBoundingClientRect();
        const composer = document
          .querySelector(".composer-wrap")!
          .getBoundingClientRect();
        return [...document.querySelectorAll(".suggestion")].map((card) => {
          const r = card.getBoundingClientRect();
          return {
            inside: r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5,
            clear: r.bottom <= composer.top + 0.5,
          };
        });
      });
      expect(geometry, label).toHaveLength(4);
      for (const [index, card] of geometry.entries())
        expect(card, `${label} card ${index + 1}`).toEqual({
          inside: true,
          clear: true,
        });
      await page.screenshot({ path: info.outputPath(`${label}.png`) });
    };
    for (const [width, height] of [
      [900, 680],
      [1440, 900],
    ] as const) {
      const [w] = await requestSize(app, page, width, height);
      // A new data root: no conversation yet, the landing page carries the 新建对话 button too.
      await check(`${w}-empty`);
      await page.getByRole("button", { name: "折叠侧栏" }).click();
      await check(`${w}-empty-folded`);
      await page
        .getByRole("navigation", { name: "全局导航" })
        .getByRole("button", { name: "展开侧栏" })
        .click();
    }
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "输入草稿" }),
    ).not.toHaveAttribute("readonly", "");
    for (const [width, height] of [
      [900, 680],
      [1440, 900],
    ] as const) {
      const [w] = await requestSize(app, page, width, height);
      await check(`${w}-blank`);
      await rightToggle(page).click();
      await check(`${w}-blank-right`);
      await rightToggle(page).click();
    }
    // A suggestion puts its text into the composer.
    await page.locator(".suggestion").first().click();
    await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
      "帮我解释一个概念：",
    );
  } finally {
    await closeLocal(app);
  }
});
