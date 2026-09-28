import {
  test,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { closeLocal, launchLocal } from "./local-client";
import { goTo, openConversation, ready, recent } from "./shell";
import { journeyFixture } from "./project-action-fixture";
import { openProvider, providersPage } from "./provider-ui";
import { Store } from "../../src/service/store";
import { expectedColors, type Appearance } from "./visual-tokens";

/**
 * A probe reads one computed property of the first visible element matching a selector and compares
 * it with the same property computed from a token expression, so the expectation is the semantic
 * token (the static check pins each token to the expected table).
 */
type Probe = [selector: string, property: string, expression: string];

const surface = "var(--c-surface)";
const line = "var(--c-line)";
const text = "var(--c-text)";
const muted = "var(--c-muted)";
const accent = "var(--c-accent)";
const selected = "var(--c-selected)";

async function mismatches(page: Page, probes: Probe[]) {
  return page.evaluate((probes) => {
    const found: string[] = [];
    const scratch = document.createElement("div");
    scratch.style.position = "fixed";
    scratch.style.visibility = "hidden";
    document.body.append(scratch);
    for (const [selector, property, expression] of probes) {
      const element = [...document.querySelectorAll(selector)].find(
        (e) => e.getClientRects().length > 0,
      );
      if (!element) {
        found.push(`${selector}: no visible element`);
        continue;
      }
      scratch.style.setProperty(property, expression);
      const expected = getComputedStyle(scratch).getPropertyValue(property);
      scratch.style.removeProperty(property);
      const actual = getComputedStyle(element).getPropertyValue(property);
      if (actual !== expected)
        found.push(
          `${selector} ${property}: ${actual} instead of ${expression} (${expected})`,
        );
    }
    scratch.remove();
    return found;
  }, probes);
}

/** The running window's token values equal the expected table of its appearance. */
async function expectTokens(page: Page, appearance: Appearance) {
  const actual = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      names.map((name) => [name, style.getPropertyValue(name).trim()]),
    );
  }, Object.keys(expectedColors[appearance]));
  const defined = Object.fromEntries(
    Object.entries(actual).filter(([, value]) => value !== ""),
  );
  for (const [name, value] of Object.entries(defined))
    expect(value.toLowerCase(), `${appearance} ${name}`).toBe(
      expectedColors[appearance][name],
    );
  expect(Object.keys(defined).length).toBeGreaterThan(20);
}

async function setAppearance(page: Page, appearance: Appearance) {
  const reply = await page.evaluate(
    (appearance) =>
      window.desktop.command({ type: "setAppearance", appearance }),
    appearance,
  );
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
}

/** The default main window and the smallest supported one (content size in points). */
const defaultSize = [1180, 800] as const;
const smallestSize = [900, 680] as const;

/**
 * Requests a content size for the main window and reads back what the window system gave: the size once the
 * main process and the page agree on it and it holds between two reads.
 */
async function requestWindowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<[number, number]> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [width, height],
  );
  let last = "";
  let settled: [number, number] = [0, 0];
  await expect
    .poll(
      async () => {
        const main = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getContentSize(),
        );
        const inner = await page.evaluate(() => [innerWidth, innerHeight]);
        const reading = `main ${main.join(" × ")}, page ${inner.join(" × ")}`;
        const steady =
          reading === last && main[0] === inner[0] && main[1] === inner[1];
        last = reading;
        if (steady) settled = [inner[0], inner[1]];
        return steady ? "settled" : reading;
      },
      { intervals: [100, 200] },
    )
    .toBe("settled");
  return settled;
}

/** Sets an exact content size: the window system must give exactly the size requested. */
async function windowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
) {
  expect(
    await requestWindowSize(app, page, width, height),
    `content size requested ${width} × ${height}`,
  ).toEqual([width, height]);
}

/**
 * The two content sizes the pages are checked at. The larger is the default 1180 × 800 as the window system
 * gives it: a host with a smaller screen may give less, which is used as long as it is at least the smallest
 * supported size and no more than requested. The smallest supported 900 × 680 must be given exactly. The
 * sizes used are recorded as a test annotation.
 */
async function windowSizes(app: ElectronApplication, page: Page) {
  const large = await requestWindowSize(
    app,
    page,
    defaultSize[0],
    defaultSize[1],
  );
  expect(
    large[0] >= smallestSize[0] &&
      large[1] >= smallestSize[1] &&
      large[0] <= defaultSize[0] &&
      large[1] <= defaultSize[1],
    `requested ${defaultSize.join(" × ")}, the window system gave ${large.join(" × ")}`,
  ).toBe(true);
  test.info().annotations.push({
    type: "window sizes",
    description: `${large.join("x")} (requested ${defaultSize.join("x")}) and ${smallestSize.join("x")}`,
  });
  return [large, [smallestSize[0], smallestSize[1]]] as const;
}

/**
 * Opens a project three-dot menu. The menu closes on any scroll, and a click on a button outside the
 * viewport scrolls it into view first: that scroll event can arrive after the menu has opened and close
 * it. Scrolling first and waiting two animation frames lets the event pass before the click.
 */
async function openProjectMenu(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await button
    .page()
    .evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  await button.click();
  await expect(button.page().locator(".project-menu")).toBeVisible();
}

/** Pointer outside the content (and, unless a view keeps it, no focus): the resting colours. */
async function rest(page: Page, keep = false) {
  await page.mouse.move(0, 0);
  if (!keep)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

/** Keyboard focus on the first control of a region: a 2px solid accent ring; returns what differs. */
async function focusRing(page: Page, selector: string) {
  await page.locator(selector).first().focus();
  const ring = await page.evaluate(() => {
    const el = document.activeElement!;
    const style = getComputedStyle(el);
    const scratch = document.createElement("span");
    scratch.style.color = "var(--c-accent)";
    document.body.append(scratch);
    const color = getComputedStyle(scratch).color;
    scratch.remove();
    return {
      visible: el.matches(":focus-visible"),
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      expected: `solid 2px ${color}`,
    };
  });
  return ring.visible && ring.ring === ring.expected
    ? []
    : [
        `focus ${selector}: ${ring.visible ? ring.ring : "not focus-visible"} instead of ${ring.expected}`,
      ];
}

/**
 * Keyboard focus on a form field: the accent border with a 2px soft halo drawn at the border (outline
 * offset 0), so the field shows one accent line and no separate ring outside it; returns what differs.
 */
async function fieldFocus(page: Page, selector: string) {
  await page.locator(selector).first().focus();
  const got = await page.evaluate(() => {
    const el = document.activeElement!;
    const style = getComputedStyle(el);
    const scratch = document.createElement("span");
    document.body.append(scratch);
    scratch.style.color = "var(--c-accent)";
    const accent = getComputedStyle(scratch).color;
    scratch.style.color = "var(--c-accent-soft)";
    const soft = getComputedStyle(scratch).color;
    scratch.remove();
    return {
      visible: el.matches(":focus-visible"),
      border: [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ],
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} offset ${style.outlineOffset}`,
      accent,
      expected: `solid 2px ${soft} offset 0px`,
    };
  });
  const found: string[] = [];
  if (!got.visible) found.push(`field ${selector}: not focus-visible`);
  if (got.border.some((c) => c !== got.accent))
    found.push(
      `field ${selector}: border ${got.border.join(" / ")} instead of ${got.accent}`,
    );
  if (got.ring !== got.expected)
    found.push(
      `field ${selector}: outline ${got.ring} instead of ${got.expected}`,
    );
  return found;
}

function seedConversations() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/visual-tokens-"));
  const store = new Store(root);
  const id = randomUUID();
  store.execute({ type: "create", id }, "main");
  store.execute(
    { type: "renameConversation", id, title: "整理读书笔记", revision: 0 },
    "main",
  );
  const at = new Date().toISOString();
  const insert = store.db.prepare(
    "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
  );
  const turnId = randomUUID(),
    executionId = randomUUID(),
    connection = {
      connectionId: randomUUID(),
      name: "测试连接",
      provider: "zhipu",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "glm-test",
      revision: 0,
      effort: null,
    };
  store.db
    .prepare(
      "INSERT INTO turns (id,conversation_id,request_id,connection_snapshot,state,created_at,ended_at) VALUES (?,?,?,?,'failed',?,?)",
    )
    .run(turnId, id, randomUUID(), JSON.stringify(connection), at, at);
  store.db
    .prepare(
      "INSERT INTO executions (id,turn_id,kind,connection_id,state,created_at,ended_at) VALUES (?,?,'turn',?,'failed',?,?)",
    )
    .run(executionId, turnId, connection.connectionId, at, at);
  store.db
    .prepare(
      "INSERT INTO pending_items (id,execution_id,kind,state,created_at) VALUES (?,?,'failed_turn','open',?)",
    )
    .run(randomUUID(), executionId, at);
  insert.run(randomUUID(), id, null, "user", "帮我整理这段读书笔记。", at);
  insert.run(
    randomUUID(),
    id,
    null,
    "assistant",
    "好的，先按章节列出要点。",
    at,
  );
  insert.run(randomUUID(), id, turnId, "user", "再补一段总结。", at);
  store.close();
  return root;
}

/** Header, page switch and avatar: the same on every main-window page. */
const shellProbes: Probe[] = [
  [".app", "background-color", "var(--c-canvas)"],
  [".home-nav", "background-color", surface],
  [".home-nav", "border-top-color", line],
  [".home-nav button:not(.selected)", "color", text],
  [".home-avatar", "background-color", "var(--c-raised)"],
  [".home-avatar", "color", text],
];
const selectedNav: Probe[] = [
  [".home-nav .selected", "color", accent],
  [".home-nav .selected", "background-color", selected],
];
const chatShell: Probe[] = [
  [".home-tool", "color", text],
  [".home-global-search kbd", "background-color", "var(--c-raised)"],
  [".home-global-search kbd", "color", muted],
];
const composer: Probe[] = [
  [".composer", "background-color", surface],
  [".composer", "border-top-color", line],
  [".composer", "box-shadow", "var(--c-shadow-card)"],
  [".composer textarea", "color", text],
  [".send", "background-color", "var(--c-primary-bg)"],
  [".send", "color", "var(--c-on-accent)"],
  [".composer-foot", "color", muted],
];
const primaryButton = (selector: string): Probe[] => [
  [selector, "background-color", "var(--c-primary-bg)"],
  [selector, "border-top-color", "var(--c-primary-border)"],
  [selector, "color", "var(--c-on-accent)"],
];
const secondaryButton = (selector: string): Probe[] => [
  [selector, "background-color", "var(--c-secondary-bg)"],
  [selector, "border-top-color", "var(--c-line-strong)"],
  [selector, "color", text],
];
const field = (selector: string): Probe[] => [
  [selector, "background-color", surface],
  [selector, "border-top-color", "var(--c-line-strong)"],
  [selector, "color", text],
];

type View = {
  id: string;
  open: (page: Page) => Promise<void>;
  probes: Probe[];
  /** A control of the view that takes keyboard focus for the focus-ring check. */
  focus?: string;
  /** A form field of the view that takes keyboard focus for the field-focus check. */
  field?: string;
  /** Menus, popovers and focused fields are probed with their focus kept. */
  keep?: true;
  /** A control hovered before probing. */
  hover?: string;
};
const chatPages: View[] = [
  {
    id: "MW-01",
    open: async (page) => {
      await goTo(page, "聊天");
      await page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true })
        .click();
      await expect(page.locator(".welcome")).toBeVisible();
    },
    probes: [
      ...shellProbes,
      ...selectedNav,
      ...chatShell,
      ...composer,
      [".welcome h1", "color", text],
      [".welcome > p", "color", muted],
      [".large-mark", "background-color", "var(--c-accent-soft)"],
      [".large-mark", "color", accent],
      [".suggestion", "background-color", surface],
      [".suggestion", "border-top-color", line],
      [".suggestion span", "color", text],
      [".suggestion small", "color", muted],
      [".suggestion svg", "color", muted],
    ],
    focus: ".suggestion",
  },
  {
    id: "MW-01-focus",
    open: async (page) => {
      await page.getByRole("textbox", { name: "输入草稿" }).click();
    },
    probes: [
      [".composer", "border-top-color", accent],
      [
        ".composer",
        "box-shadow",
        "0 0 0 3px var(--c-accent-soft), var(--c-shadow-card)",
      ],
    ],
    keep: true,
  },
  {
    id: "MW-02",
    open: async (page) => {
      await openConversation(
        page,
        (await (
          await recent(page)
        )
          .locator(".session")
          .filter({ hasText: "整理读书笔记" })
          .getAttribute("aria-label"))!,
      );
      await expect(page.locator(".bubble.assistant").first()).toBeVisible();
    },
    probes: [
      ...shellProbes,
      ...composer,
      [".home-chat-title .conversation-title", "color", text],
      [".bubble.user", "background-color", "var(--c-accent-soft)"],
      [".bubble.user", "border-top-color", "var(--c-accent-edge)"],
      [".bubble.user p", "color", text],
      [".bubble.assistant", "background-color", surface],
      [".bubble.assistant", "border-top-color", line],
      [".turn-state.state-failed", "background-color", "var(--c-red-bg)"],
      [".turn-state.state-failed", "color", "var(--c-red)"],
      [".turn-meta", "color", muted],
    ],
    focus: ".home-chat-title .conversation-title",
  },
  {
    id: "MW-20",
    open: async (page) => {
      await page.getByRole("button", { name: "修改对话名称" }).click();
      await expect(page.locator(".rename-dialog")).toBeVisible();
    },
    probes: [
      [".rename-dialog", "background-color", surface],
      [".rename-dialog", "border-top-color", line],
      [".rename-dialog", "box-shadow", "var(--c-shadow)"],
      [".rename-dialog", "color", text],
      // The title field opens focused; its border is checked by the field-focus check.
      [".rename-dialog input", "background-color", surface],
      [".rename-dialog input", "color", text],
      ...primaryButton(".rename-dialog .button.primary"),
      ...secondaryButton(".rename-dialog .button:not(.primary)"),
    ],
    field: ".rename-dialog input",
    keep: true,
  },
  {
    id: "MW-20-hover",
    open: async () => {},
    probes: [
      [
        ".rename-dialog .button.primary",
        "background-color",
        "var(--c-accent-strong)",
      ],
      [
        ".rename-dialog .button.primary",
        "border-top-color",
        "var(--c-accent-strong)",
      ],
      [".rename-dialog .button.primary", "color", "var(--c-on-accent)"],
    ],
    keep: true,
    hover: ".rename-dialog .button.primary",
  },
  {
    id: "MW-20-closed",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await expect(page.locator(".rename-dialog")).toBeHidden();
    },
    probes: [],
  },
  {
    id: "MW-03",
    open: async (page) => {
      await recent(page);
    },
    probes: [
      ...shellProbes,
      [".home-history", "background-color", surface],
      [".home-history", "border-top-color", line],
      [".home-history", "box-shadow", "var(--c-shadow)"],
      [".history-trigger", "background-color", surface],
      [".history-trigger", "border-top-color", line],
      [".session-line.active", "background-color", selected],
      [".session-name", "color", text],
      [".session time", "color", muted],
    ],
    focus: "section#home-history .session",
    keep: true,
  },
  {
    id: "MW-04",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^我，个人空间/ }).click();
      await expect(page.locator("section#profile-menu")).toBeVisible();
    },
    probes: [
      ...shellProbes,
      [".profile-menu", "background-color", surface],
      [".profile-menu", "border-top-color", line],
      [".profile-menu", "box-shadow", "var(--c-shadow)"],
      [".profile-menu", "color", text],
      [".profile-menu-heading small", "color", muted],
      [".profile-menu-avatar", "background-color", "var(--c-raised)"],
      [".profile-menu-count", "background-color", "var(--c-amber-badge)"],
      [".profile-menu-count", "color", "var(--c-on-amber)"],
      [".profile-pending-dot", "background-color", "var(--c-amber-badge)"],
      [".profile-menu-divider", "background-color", line],
    ],
    focus: ".profile-menu-item",
    keep: true,
  },
  {
    id: "MW-05",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "全局搜索" }).click();
      await expect(page.locator(".search-dialog")).toBeVisible();
      await page.locator(".search-input-row input").fill("读书");
      await expect(page.locator(".search-result").first()).toBeVisible();
    },
    probes: [
      [".search-dialog", "background-color", surface],
      [".search-dialog", "border-top-color", line],
      [".search-dialog", "box-shadow", "var(--c-shadow)"],
      [".search-input-row", "border-bottom-color", "var(--c-line-soft)"],
      [".search-input-row input", "color", text],
      [".search-categories [role=tab].selected", "color", accent],
      [".search-categories [role=tab].selected", "background-color", selected],
      [".search-result.selected", "background-color", "var(--c-accent-soft)"],
      [".search-result-body small", "color", muted],
      [".search-dialog mark", "background-color", "var(--c-amber-bg)"],
      [".search-dialog mark", "color", text],
      [".search-footer", "color", muted],
    ],
    keep: true,
  },
  ...(
    [
      ["MW-13", "通用"],
      ["MW-14", "模型"],
      ["MW-15", "最近删除"],
      ["MW-16", "扩展管理"],
      ["MW-17", "访问权限"],
      ["MW-18", "数据保留"],
      ["MW-19", "数据与隐私"],
    ] as const
  ).map(([id, tab]): View => ({
    id,
    open: async (page: Page) => {
      await page.keyboard.press("Escape");
      await goTo(page, "设置");
      await page
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("button", { name: tab, exact: true })
        .click();
      await expect(
        page.locator(".settings-content").getByRole("heading").first(),
      ).toBeVisible();
    },
    probes: [
      ...shellProbes,
      [".page-heading h1", "color", text],
      [".page-heading p", "color", muted],
      [".settings-nav", "border-bottom-color", line],
      [".settings-nav button.active", "color", accent],
      [".settings-nav button.active", "border-bottom-color", accent],
      [".settings-nav button:not(.active)", "color", muted],
      [".settings-content > h2", "color", text],
      ...(tab === "通用"
        ? ([
            [".setting-row", "border-bottom-color", line],
            [".setting-row p", "color", muted],
            [".appearance-control", "background-color", "var(--c-raised)"],
            [".appearance-control", "border-top-color", line],
            [
              ".appearance-control [aria-pressed=true]",
              "background-color",
              surface,
            ],
            [".appearance-control [aria-pressed=true]", "color", text],
            [
              ".appearance-control [aria-pressed=true]",
              "box-shadow",
              "var(--c-shadow-sm)",
            ],
            [".appearance-control [aria-pressed=false]", "color", muted],
            [
              "input.setting-switch",
              "background-color",
              "var(--c-line-strong)",
            ],
          ] as Probe[])
        : tab === "模型"
          ? ([
              [".provider-list", "border-top-color", line],
              [
                ".provider-row + .provider-row, .provider-row-shell + .provider-row-shell",
                "border-top-color",
                line,
              ],
              [".provider-mark", "background-color", "var(--c-raised)"],
              [".provider-info small", "color", muted],
            ] as Probe[])
          : tab === "访问权限"
            ? ([
                [".trust-boundary", "background-color", "var(--c-raised)"],
                [".trust-boundary", "border-top-color", line],
                [".trust-boundary p", "color", text],
              ] as Probe[])
            : tab === "扩展管理"
              ? ([...secondaryButton(".settings-content .button")] as Probe[])
              : []),
    ],
    focus: ".settings-nav button.active",
  })),
];

test("main window: chat, recent chats, avatar menu, search and settings take the semantic colour tokens in light and dark at both window sizes", async ({}, info) => {
  const root = seedConversations();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await ready(page);
    const sizes = await windowSizes(app, page);
    const failures: string[] = [];
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      await expectTokens(page, appearance);
      for (const [index, [width, height]] of sizes.entries()) {
        await windowSize(app, page, width, height);
        for (const view of chatPages) {
          await view.open(page);
          await rest(page, view.keep);
          if (view.hover) await page.locator(view.hover).first().hover();
          if (index === 0)
            failures.push(
              ...(await mismatches(page, view.probes)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          await shot(page, info, `${width}x${height}-${appearance}-${view.id}`);
          if (index === 0 && view.focus) {
            await page.keyboard.press("Tab");
            failures.push(
              ...(await focusRing(page, view.focus)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          }
          if (index === 0 && view.field)
            failures.push(
              ...(await fieldFocus(page, view.field)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
        }
        await page.keyboard.press("Escape");
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(app);
  }
});

const projectPages: View[] = [
  {
    id: "MW-09",
    open: async (page) => {
      await expect(
        page.getByRole("region", { name: "项目操作", exact: true }),
      ).toBeVisible();
    },
    probes: [
      ...shellProbes,
      ...selectedNav,
      [".workbench-tabs", "border-bottom-color", line],
      [".workbench-tabs [aria-selected=true]", "color", accent],
      [".workbench-tabs [aria-selected=true]", "background-color", selected],
      [".workbench-tabs [aria-selected=false]", "color", muted],
      [".projects-workspace", "color", text],
      [".project-detail-card", "background-color", surface],
      [".project-detail-card", "border-top-color", line],
      [".project-detail-card h3", "color", text],
      [".project-source", "color", muted],
      [".project-object-tabs [aria-pressed=true]", "color", accent],
      [
        ".project-object-tabs [aria-pressed=true]",
        "background-color",
        selected,
      ],
      [
        ".project-object-tabs [aria-pressed=true]",
        "border-top-color",
        "var(--c-accent-edge)",
      ],
      [".project-actions", "border-top-color", line],
      ...secondaryButton(
        ".projects-workspace .button:not(.project-primary):not(:disabled)",
      ),
      ...field(".project-work-grid select"),
    ],
    focus: ".project-object-tabs button",
  },
  {
    id: "MW-08",
    open: async (page) => {
      await page
        .getByRole("navigation", { name: "Runtime 内容" })
        .getByRole("button", { name: "当前阶段：任务开发", exact: true })
        .click();
      await expect(page.locator(".project-task-list li")).toBeVisible();
    },
    probes: [
      ...shellProbes,
      [".project-task-list li span", "color", muted],
      [".project-text-button", "color", accent],
      [".project-detail-heading h2", "color", text],
      [
        ".project-pending-item .project-tag.amber",
        "background-color",
        "var(--c-amber-bg)",
      ],
      [".project-pending-item .project-tag.amber", "color", "var(--c-amber)"],
    ],
    focus: ".project-text-button",
  },
  {
    id: "MW-06",
    open: async (page) => {
      await page.getByRole("button", { name: "返回项目列表" }).click();
      await expect(page.locator(".project-table")).toBeVisible();
    },
    probes: [
      ...shellProbes,
      ...primaryButton(".project-toolbar .button.project-primary"),
      ...field(".project-controls select"),
      [".project-total", "color", muted],
      [".project-table-wrap", "background-color", surface],
      [".project-table-wrap", "border-top-color", line],
      [".project-table th", "color", muted],
      [".project-open strong", "color", text],
      [".project-open small", "color", muted],
      [".project-symbol", "background-color", "var(--c-accent-soft)"],
      [".project-symbol", "color", accent],
      [".project-more", "color", muted],
    ],
    focus: ".project-open",
  },
  {
    id: "MW-06-hover",
    open: async () => {},
    probes: [
      [
        ".project-toolbar .button.project-primary",
        "background-color",
        "var(--c-accent-strong)",
      ],
      [
        ".project-toolbar .button.project-primary",
        "border-top-color",
        "var(--c-accent-strong)",
      ],
      [
        ".project-toolbar .button.project-primary",
        "color",
        "var(--c-on-accent)",
      ],
    ],
    hover: ".project-toolbar .button.project-primary",
  },
  {
    id: "MW-06-menu",
    open: async (page) => {
      await openProjectMenu(page.locator(".project-more").first());
    },
    probes: [
      [".project-menu", "background-color", surface],
      [".project-menu", "border-top-color", line],
      [".project-menu", "box-shadow", "var(--c-shadow)"],
      [".project-menu button", "color", text],
    ],
    keep: true,
  },
  {
    id: "MW-07",
    open: async (page) => {
      if (!(await page.locator(".project-menu").isVisible()))
        await openProjectMenu(page.locator(".project-more").first());
      await page
        .locator(".project-menu")
        .getByRole("menuitem", { name: "编辑项目" })
        .click();
      await expect(page.locator(".project-form-dialog")).toBeVisible();
    },
    probes: [
      [".project-form-dialog", "background-color", surface],
      [".project-form-dialog", "border-top-color", line],
      [".project-form-dialog", "box-shadow", "var(--c-shadow)"],
      [".project-form-dialog", "color", text],
      [".project-form-subtitle", "color", muted],
      // The name field opens focused; its border is checked by the field-focus check.
      [".project-form-dialog input", "background-color", surface],
      [".project-form-dialog input", "color", text],
      ...field(".project-form-dialog textarea"),
      ...primaryButton(".project-form-dialog .button.project-primary"),
      ...secondaryButton(".project-form-actions .button:not(.project-primary)"),
      [".project-form-actions", "border-top-color", line],
    ],
    field: ".project-form-dialog input",
    keep: true,
  },
  {
    id: "MW-10",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await expect(page.locator(".project-form-dialog")).toHaveCount(0);
      await page
        .getByRole("tablist", { name: "工作台内容" })
        .getByRole("tab", { name: "控件" })
        .click();
    },
    probes: [
      ...shellProbes,
      [".empty-icon", "background-color", surface],
      [".empty-icon", "border-top-color", line],
      [".empty-icon", "color", muted],
      [".empty h2", "color", text],
      [".empty p", "color", muted],
    ],
  },
  {
    id: "MW-11",
    open: async (page) => {
      await page
        .getByRole("tablist", { name: "工作台内容" })
        .getByRole("tab", { name: "项目" })
        .click();
      await goTo(page, "待处理");
      await expect(
        page.getByRole("region", { name: "项目待处理", exact: true }),
      ).toBeVisible();
    },
    probes: [
      ...shellProbes,
      [".home-header-compact", "border-bottom-color", line],
      ...field(".record-query-controls input:not([type=checkbox])"),
      ...field(".record-query-controls select"),
      [".record-query-controls label", "color", muted],
      [".project-pending-item", "background-color", surface],
      [".project-pending-item", "border-top-color", line],
      ...secondaryButton(".project-pending-item .button"),
      [
        ".project-pending-item .project-tag.amber",
        "background-color",
        "var(--c-amber-bg)",
      ],
      [".project-pending-item .project-tag.amber", "color", "var(--c-amber)"],
      [
        ".project-pending-item .project-tag.amber",
        "border-top-color",
        "var(--c-amber-edge)",
      ],
    ],
    focus: ".record-query-controls input",
  },
  {
    id: "MW-12",
    open: async (page) => {
      await goTo(page, "运行记录");
      await expect(
        page.getByRole("heading", { name: "运行记录", exact: true }),
      ).toBeVisible();
    },
    probes: [
      ...shellProbes,
      ...field(".record-query-controls input:not([type=checkbox])"),
      [".record-page .page-heading-actions .icon-button", "color", muted],
    ],
    focus: ".record-query-controls input",
  },
];

test("main window: projects, project detail, widgets, pending and run records take the semantic colour tokens in light and dark at both window sizes", async ({}, info) => {
  const f = await journeyFixture();
  try {
    const sizes = await windowSizes(f.app, f.page);
    const failures: string[] = [];
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(f.page, appearance);
      for (const [index, [width, height]] of sizes.entries()) {
        await windowSize(f.app, f.page, width, height);
        await f.page
          .getByRole("navigation", { name: "主要页面" })
          .getByRole("button", { name: "工作台", exact: true })
          .click();
        if (await f.page.locator(".project-table").isVisible())
          await f.page
            .locator(".project-open")
            .filter({ hasText: "合成任务旅程" })
            .click();
        await f.page
          .getByRole("navigation", { name: "Runtime 内容" })
          .getByRole("button", { name: "合成编码任务", exact: true })
          .click();
        for (const view of projectPages) {
          await view.open(f.page);
          await rest(f.page, view.keep);
          if (view.hover) await f.page.locator(view.hover).first().hover();
          if (index === 0)
            failures.push(
              ...(await mismatches(f.page, view.probes)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          await shot(
            f.page,
            info,
            `${width}x${height}-${appearance}-${view.id}`,
          );
          if (index === 0 && view.focus) {
            await f.page.keyboard.press("Tab");
            failures.push(
              ...(await focusRing(f.page, view.focus)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          }
          if (index === 0 && view.field)
            failures.push(
              ...(await fieldFocus(f.page, view.field)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
        }
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(f.app);
  }
});

/** Panel pages probed against the same tokens, and against the main window's value for the same role. */
const panelPages: [name: string, probes: Probe[]][] = [
  [
    "工作台",
    [
      [".empty-icon", "background-color", surface],
      [".empty-icon", "border-top-color", line],
      [".empty h2", "color", text],
      [".empty p", "color", muted],
    ],
  ],
  [
    "聊天",
    [
      ...composer,
      [".panel-conversations", "color", muted],
      ...field(".panel-conversations select"),
      [".bubble.user", "background-color", "var(--c-accent-soft)"],
      [".bubble.user", "border-top-color", "var(--c-accent-edge)"],
      [".bubble.user p", "color", text],
      [".bubble.assistant", "background-color", surface],
    ],
  ],
  [
    "待处理",
    [
      [".pending-item", "background-color", surface],
      [".pending-item", "border-top-color", line],
      ...secondaryButton(".pending-item .button"),
    ],
  ],
  [
    "设置",
    [
      [".settings-nav button.active", "color", accent],
      [".settings-nav button.active", "background-color", selected],
      [".settings-nav button:not(.active)", "color", muted],
      [".provider-list", "border-top-color", line],
      [".provider-mark", "background-color", "var(--c-raised)"],
      [".provider-info small", "color", muted],
    ],
  ],
];
const panelShell: Probe[] = [
  ["html", "background-color", "var(--c-canvas)"],
  [".topbar", "border-bottom-color", line],
  [".topbar .icon-button", "color", muted],
  [".panel-nav", "border-bottom-color", line],
  [".panel-nav button.active", "color", accent],
  [".panel-nav button.active", "background-color", selected],
  [".panel-nav button:not(.active)", "color", muted],
];

/** Computed colours of the roles both surfaces share, read from each window. */
async function sharedRoles(page: Page) {
  return page.evaluate(() => {
    const read = (selector: string, property: string) => {
      const element = [...document.querySelectorAll(selector)].find(
        (e) => e.getClientRects().length > 0,
      );
      return element
        ? getComputedStyle(element).getPropertyValue(property)
        : null;
    };
    return {
      canvas: getComputedStyle(document.documentElement).backgroundColor,
      composer: read(".composer", "background-color"),
      composerEdge: read(".composer", "border-top-color"),
      send: read(".send", "background-color"),
      text: getComputedStyle(document.documentElement).color,
    };
  });
}

test("menu bar panel: every page takes the semantic colour tokens in light and dark and matches the main window's colours", async ({}, info) => {
  const root = seedConversations();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await ready(page);
    // The panel's chat page shows the main window's conversation: open one with both kinds of message.
    await openConversation(
      page,
      (await (
        await recent(page)
      )
        .locator(".session")
        .filter({ hasText: "整理读书笔记" })
        .getAttribute("aria-label"))!,
    );
    await expect(page.locator(".bubble.assistant").first()).toBeVisible();
    const opened = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click();
    });
    const panel = await opened;
    await expect(
      panel.getByRole("navigation", { name: "面板导航" }),
    ).toBeVisible();
    const failures: string[] = [];
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      await expect(panel.locator("html")).toHaveAttribute(
        "data-theme",
        appearance,
      );
      await expectTokens(panel, appearance);
      await goTo(page, "聊天");
      const main = await sharedRoles(page);
      for (const [name, probes] of panelPages) {
        await panel
          .getByRole("navigation", { name: "面板导航" })
          .getByRole("button", { name, exact: true })
          .click();
        await rest(panel);
        failures.push(
          ...(await mismatches(panel, [...panelShell, ...probes])).map(
            (m) => `${appearance} panel ${name} ${m}`,
          ),
        );
        if (name === "聊天") {
          const own = await sharedRoles(panel);
          for (const role of [
            "canvas",
            "composer",
            "composerEdge",
            "send",
            "text",
          ] as const)
            if (own[role] !== main[role])
              failures.push(
                `${appearance} panel ${role}: ${own[role]} while the main window has ${main[role]}`,
              );
        }
        await panel.screenshot({
          path: info.outputPath(`420x600-${appearance}-PN-${name}.png`),
        });
        await panel.keyboard.press("Tab");
        failures.push(
          ...(await focusRing(panel, ".panel-nav button.active")).map(
            (m) => `${appearance} panel ${name} ${m}`,
          ),
        );
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(app);
  }
});

/** One human decision from the pending page: continue, read every basis, confirm, submit and close. */
async function acceptTask(page: Page) {
  await page
    .getByRole("button", { name: "处理：接纳任务", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  await dialog
    .getByRole("combobox", { name: "处理方式", exact: true })
    .selectOption("继续");
  for (const button of await dialog
    .getByRole("button", { name: /^打开依据 / })
    .all())
    await button.click();
  await dialog
    .getByRole("checkbox", { name: "我已核对本次操作与全部依据", exact: true })
    .check();
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(dialog.getByText("操作已成功", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}

/** WCAG 2 contrast of an element's text against the first opaque background behind it. */
async function contrastOf(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (e) => e.getClientRects().length > 0,
    );
    if (!element) return { selector, ratio: 0, detail: "no visible element" };
    const parse = (value: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return null;
      const [r, g, b, a = "1"] = m[1].split(",").map((v) => v.trim());
      return { r: +r, g: +g, b: +b, a: +a };
    };
    let node: HTMLElement | null = element;
    let background = null as ReturnType<typeof parse>;
    while (node && !(background && background.a === 1)) {
      const value = parse(getComputedStyle(node).backgroundColor);
      if (value && value.a === 1) background = value;
      node = node.parentElement;
    }
    background ??= parse(
      getComputedStyle(document.documentElement).backgroundColor,
    );
    const color = parse(getComputedStyle(element).color)!;
    const luminance = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const [l1, l2] = [luminance(color), luminance(background!)];
    return {
      selector,
      ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
      detail: `${getComputedStyle(element).color} on ${JSON.stringify(background)}`,
    };
  }, selector);
}

/** Geometry of the defects on the project detail: operation spacing, list row baselines and rules below the list. */
async function projectGeometry(page: Page) {
  return page.evaluate(() => {
    const baseline = (element: Element) => {
      const marker = document.createElement("span");
      marker.style.cssText =
        "display:inline-block;width:0;height:0;vertical-align:baseline";
      element.prepend(marker);
      const y = marker.getBoundingClientRect().bottom;
      marker.remove();
      return y;
    };
    const rows = [...document.querySelectorAll(".project-task-list li")].map(
      (li) => {
        const title = li.querySelector(":scope > button, :scope > strong")!;
        const detail = li.querySelector(":scope > span")!;
        return Math.abs(baseline(title) - baseline(detail));
      },
    );
    const list = document.querySelector(".project-task-list");
    const rules: number[] = [];
    if (list) {
      const last = list.lastElementChild!.getBoundingClientRect();
      const below = [...document.querySelectorAll("*")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.left < last.right && r.right > last.left;
      });
      for (const e of below) {
        const style = getComputedStyle(e),
          r = e.getBoundingClientRect();
        for (const [side, y] of [
          ["Top", r.top],
          ["Bottom", r.bottom],
        ] as const) {
          const width = parseFloat(
            style.getPropertyValue(`border-${side.toLowerCase()}-width`),
          );
          const color = style.getPropertyValue(
            `border-${side.toLowerCase()}-color`,
          );
          if (
            width > 0 &&
            !/rgba\(.*, 0\)$/.test(color) &&
            y >= last.bottom - 1.5 &&
            y <= last.bottom + 60
          )
            rules.push(Math.round(y));
        }
      }
    }
    const operations = [...document.querySelectorAll(".project-operation")].map(
      (op) => {
        const button = [...op.children].find(
          (c) => c.textContent === "查询该操作",
        );
        if (!button) return null;
        const previous = button.previousElementSibling!;
        return (
          button.getBoundingClientRect().top -
          previous.getBoundingClientRect().bottom
        );
      },
    );
    return {
      rows,
      rules: [...new Set(rules)],
      operations: operations.filter((g) => g !== null) as number[],
    };
  });
}

test("dark surfaces: selected tabs, filter fields, pending cards, the confirmation box, menus, the project chat input, project cards, operation records and list rows take the tokens in dark and light", async ({}, info) => {
  const f = await journeyFixture();
  try {
    const failures: string[] = [];
    // An operation record needs one decision: accept the task from the pending page.
    await goTo(f.page, "待处理");
    await acceptTask(f.page);
    for (const appearance of ["dark", "light"] as const) {
      await setAppearance(f.page, appearance);
      // Pending and run records: the page tabs, the filter bar and the pending card.
      await goTo(f.page, "待处理");
      await rest(f.page);
      failures.push(
        ...(
          await mismatches(f.page, [
            [
              ".record-query [role=tab][aria-selected=true]",
              "background-color",
              selected,
            ],
            [".record-query [role=tab][aria-selected=true]", "color", accent],
            [
              ".record-query [role=tab][aria-selected=true]",
              "border-top-color",
              "var(--c-accent-edge)",
            ],
            ...field(".record-query-controls input:not([type=checkbox])"),
            ...field(".record-query-controls select"),
            ["html", "background-color", "var(--c-canvas)"],
          ])
        ).map((m) => `${appearance} pending ${m}`),
      );
      // Placeholders take the secondary text colour (the browser default grey is 3.65:1 on the dark card).
      const placeholder = await f.page.evaluate(() => {
        const field = document.querySelector(
          ".record-query-controls input.record-query-search",
        )!;
        const scratch = document.createElement("span");
        scratch.style.color = "var(--c-muted)";
        document.body.append(scratch);
        const muted = getComputedStyle(scratch).color;
        scratch.remove();
        return {
          actual: getComputedStyle(field, "::placeholder").color,
          muted,
        };
      });
      if (placeholder.actual !== placeholder.muted)
        failures.push(
          `${appearance} placeholder ${placeholder.actual} instead of ${placeholder.muted}`,
        );
      for (const selector of [
        ".record-query [role=tab][aria-selected=true]",
        ".workbench-tabs [aria-selected=true]",
      ]) {
        if (selector.startsWith(".workbench")) {
          await f.page
            .getByRole("navigation", { name: "主要页面" })
            .getByRole("button", { name: "工作台", exact: true })
            .click();
          await rest(f.page);
        }
        const c = await contrastOf(f.page, selector);
        if (c.ratio < 4.5)
          failures.push(
            `${appearance} ${selector} contrast ${c.ratio.toFixed(2)} (${c.detail})`,
          );
      }
      await f.page.screenshot({
        path: info.outputPath(`${appearance}-tabs.png`),
      });
      await goTo(f.page, "待处理");
      await f.page.getByRole("tab", { name: "已处理", exact: true }).click();
      await rest(f.page);
      failures.push(
        ...(
          await mismatches(f.page, [
            [".project-pending-item", "background-color", surface],
            [".project-pending-item", "border-top-color", line],
          ])
        ).map((m) => `${appearance} pending card ${m}`),
      );
      await f.page.screenshot({
        path: info.outputPath(`${appearance}-pending.png`),
      });
      // Project detail: cards, the object list, operation records, the three-dot menu and the chat input.
      await f.page
        .getByRole("navigation", { name: "主要页面" })
        .getByRole("button", { name: "工作台", exact: true })
        .click();
      if (await f.page.locator(".project-table").isVisible())
        await f.page
          .locator(".project-open")
          .filter({ hasText: "合成任务旅程" })
          .click();
      await f.page
        .getByRole("navigation", { name: "Runtime 内容" })
        .getByRole("button", { name: "当前阶段：任务开发", exact: true })
        .click();
      await expect(f.page.locator(".project-task-list li")).toBeVisible();
      await rest(f.page);
      const pressed = await contrastOf(
        f.page,
        ".project-object-tabs [aria-pressed=true]",
      );
      if (pressed.ratio < 4.5)
        failures.push(
          `${appearance} object tab contrast ${pressed.ratio.toFixed(2)} (${pressed.detail})`,
        );
      failures.push(
        ...(
          await mismatches(f.page, [
            [".project-detail-card", "background-color", surface],
            [".project-detail-card", "border-top-color", line],
            ...field(".project-work-grid select"),
          ])
        ).map((m) => `${appearance} project ${m}`),
      );
      const geometry = await projectGeometry(f.page);
      if (geometry.rows.some((d) => d > 1))
        failures.push(
          `${appearance} list row baselines differ by ${geometry.rows.join(", ")} px`,
        );
      if (geometry.rules.length !== 1)
        failures.push(
          `${appearance} ${geometry.rules.length} rules below the last list row at ${geometry.rules.join(", ")}`,
        );
      await f.page.locator(".project-task-list").scrollIntoViewIfNeeded();
      await f.page.screenshot({
        path: info.outputPath(`${appearance}-project-list.png`),
      });
      if (
        !(await f.page
          .getByRole("textbox", { name: "项目对话输入" })
          .isVisible())
      )
        await f.page
          .getByRole("button", { name: "新建项目对话", exact: true })
          .click();
      await expect(
        f.page.getByRole("textbox", { name: "项目对话输入" }),
      ).toBeVisible();
      await rest(f.page);
      failures.push(
        ...(await mismatches(f.page, field(".project-work-grid textarea"))).map(
          (m) => `${appearance} project chat ${m}`,
        ),
      );
      // Operation records belong to the object the decision acted on.
      await f.page
        .getByRole("navigation", { name: "Runtime 内容" })
        .getByRole("button", { name: "合成编码任务", exact: true })
        .click();
      await expect(f.page.locator(".project-operation").first()).toBeVisible();
      await rest(f.page);
      failures.push(
        ...(
          await mismatches(f.page, [
            [".project-operation", "border-top-color", line],
          ])
        ).map((m) => `${appearance} operation ${m}`),
      );
      const operations = (await projectGeometry(f.page)).operations;
      if (!operations.length)
        failures.push(`${appearance} no operation record with 查询该操作`);
      if (operations.some((g) => g < 12))
        failures.push(
          `${appearance} 查询该操作 ${operations.join(", ")} px below the element above it`,
        );
      if (new Set(operations.map((g) => Math.round(g))).size > 1)
        failures.push(
          `${appearance} 查询该操作 spacing differs: ${operations.join(", ")}`,
        );
      await f.page
        .locator(".project-operation")
        .first()
        .scrollIntoViewIfNeeded();
      await f.page.screenshot({
        path: info.outputPath(`${appearance}-operations.png`),
      });
      await openProjectMenu(
        f.page.getByRole("button", { name: "合成任务旅程 项目操作" }).first(),
      );
      failures.push(
        ...(
          await mismatches(f.page, [
            [".project-menu", "background-color", surface],
            [".project-menu", "border-top-color", line],
          ])
        ).map((m) => `${appearance} menu ${m}`),
      );
      await f.page.screenshot({
        path: info.outputPath(`${appearance}-menu.png`),
      });
      await f.page.keyboard.press("Escape");
      // The confirmation box of a project action.
      await f.page
        .getByRole("button", { name: /^处理：/ })
        .first()
        .click();
      const dialog = f.page.getByRole("dialog", {
        name: "核对项目操作",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await rest(f.page, true);
      failures.push(
        ...(
          await mismatches(f.page, [
            [".project-action-dialog", "background-color", surface],
            [".project-action-dialog", "border-top-color", line],
            ...field(".project-action-dialog select"),
          ])
        ).map((m) => `${appearance} confirmation ${m}`),
      );
      await f.page.screenshot({
        path: info.outputPath(`${appearance}-confirmation.png`),
      });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    }
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(f.app);
  }
});

/** Native window backgrounds, read in the main process, as lower-case hex. */
async function backgrounds(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) =>
      w.getBackgroundColor().toLowerCase(),
    ),
  );
}

test("window background: the main window and the panel take the canvas of the current appearance, follow a change without a restart, and a restart opens on the saved appearance", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/window-background-"));
  const launch = () =>
    launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
      colorScheme: null,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] => e[1] !== undefined,
          ),
        ),
        CSTHINK_TEST_RECORD_APPEARANCE: "1",
      },
    });
  const canvas = {
    light: expectedColors.light["--c-canvas"],
    dark: expectedColors.dark["--c-canvas"],
  };
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await ready(page);
    expect(await backgrounds(app)).toEqual([canvas.light]);
    await setAppearance(page, "dark");
    await expect.poll(() => backgrounds(app)).toEqual([canvas.dark]);
    const opened = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click();
    });
    const panel = await opened;
    await expect(panel.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() => backgrounds(app))
      .toEqual([canvas.dark, canvas.dark]);
    // Automatic follows the system; the system is simulated by the native theme source.
    await goTo(page, "设置");
    await page.getByRole("button", { name: "自动", exact: true }).click();
    for (const system of ["light", "dark"] as const) {
      await app.evaluate(({ nativeTheme }, system) => {
        nativeTheme.themeSource = system;
      }, system);
      await expect
        .poll(() => backgrounds(app))
        .toEqual([canvas[system], canvas[system]]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", system);
      await expect(panel.locator("html")).toHaveAttribute("data-theme", system);
    }
    await setAppearance(page, "dark");
    await closeLocal(app);
    // A saved dark appearance: the window is shown on the dark canvas and the page is dark when it is ready.
    app = await launch();
    page = await app.firstWindow();
    await ready(page);
    const record = await app.evaluate(
      () =>
        (
          globalThis as unknown as {
            appearanceRecord: {
              shown?: string;
              ready?: string;
              themes: string[];
            }[];
          }
        ).appearanceRecord,
    );
    expect(record[0].shown?.toLowerCase()).toBe(canvas.dark);
    expect(record[0].ready).toBe("dark");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __appearanceLog: string[] }).__appearanceLog,
      ),
    ).not.toContain("light");
    await page.screenshot({ path: info.outputPath("restart-dark.png") });
  } finally {
    await closeLocal(app);
  }
  // A data root the service refuses: the window is still shown with the reason.
  const foreign = mkdtempSync(
    resolve(".test-data/disposable/window-background-foreign-"),
  );
  writeFileSync(resolve(foreign, "not-a-data-root.txt"), "foreign");
  const refused = await launchLocal({
    args: [resolve("."), `--data-root=${foreign}`],
    cwd: resolve("."),
  });
  try {
    const page = await refused.firstWindow();
    await expect(page.locator(".service-error")).toBeVisible();
    await expect
      .poll(() =>
        refused.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((w) => w.isVisible()),
        ),
      )
      .toEqual([true]);
  } finally {
    await closeLocal(refused);
  }
});

/** Left and right edges of the transcript's content box and of its first user and assistant bubbles. */
async function bubbleEdges(page: Page) {
  return page.evaluate(() => {
    const transcript = document.querySelector(".transcript")!;
    const style = getComputedStyle(transcript);
    const box = transcript.getBoundingClientRect();
    const content = {
      left: box.left + parseFloat(style.paddingLeft),
      right: box.right - parseFloat(style.paddingRight),
    };
    const edges = (selector: string) => {
      const r = transcript.querySelector(selector)!.getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    return {
      content,
      user: edges(".bubble.user"),
      assistant: edges(".bubble.assistant"),
    };
  });
}

/** Left edge of the first glyph of an element's text, so padding differences show. */
async function textLeft(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector)!;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent!.trim()) node = walker.nextNode();
    const range = document.createRange();
    range.setStart(node!, node!.textContent!.search(/\S/));
    range.setEnd(node!, node!.textContent!.search(/\S/) + 1);
    return range.getBoundingClientRect().left;
  }, selector);
}

test("existing page defects: a user bubble sits at the right in the main window and the panel, the search scope note lines up with the group title, and project form fields use the body weight", async ({}, info) => {
  const root = seedConversations();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await ready(page);
    const failures: string[] = [];
    const [large] = await windowSizes(app, page);
    await windowSize(app, page, large[0], large[1]);
    const conversation = (await (
      await recent(page)
    )
      .locator(".session")
      .filter({ hasText: "整理读书笔记" })
      .getAttribute("aria-label"))!;
    await openConversation(page, conversation);
    await expect(page.locator(".bubble.assistant").first()).toBeVisible();
    const opened = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click();
    });
    const panel = await opened;
    await panel
      .getByRole("navigation", { name: "面板导航" })
      .getByRole("button", { name: "聊天", exact: true })
      .click();
    await expect(panel.locator(".bubble.assistant").first()).toBeVisible();
    for (const [surface, window] of [
      ["main window", page],
      ["panel", panel],
    ] as const) {
      const e = await bubbleEdges(window);
      if (Math.abs(e.user.right - e.content.right) > 1)
        failures.push(
          `${surface} user bubble right ${e.user.right} while the transcript content ends at ${e.content.right}`,
        );
      if (e.user.left <= e.content.left + 1)
        failures.push(
          `${surface} user bubble starts at the transcript's left edge ${e.user.left}`,
        );
      if (
        Math.abs(e.assistant.left - e.content.left) > 1 ||
        Math.abs(e.assistant.right - e.content.right) > 1
      )
        failures.push(
          `${surface} assistant bubble ${JSON.stringify(e.assistant)} does not span ${JSON.stringify(e.content)}`,
        );
      await window.screenshot({
        path: info.outputPath(`bubbles-${surface.replace(" ", "-")}.png`),
      });
    }
    for (const [surface, window, open] of [
      [
        "main window",
        page,
        () => page.getByRole("button", { name: "全局搜索" }).click(),
      ],
      [
        "panel",
        panel,
        () =>
          panel.getByRole("button", { name: "搜索对话", exact: true }).click(),
      ],
    ] as const) {
      await open();
      await expect(window.locator(".search-dialog")).toBeVisible();
      await window.locator(".search-input-row input").fill("读书");
      await expect(window.locator(".search-scope-note")).toBeVisible();
      const note = await textLeft(window, ".search-scope-note");
      const title = await textLeft(window, ".search-group-title");
      if (Math.abs(note - title) > 0.5)
        failures.push(
          `${surface} search scope note text starts at ${note}, the group title at ${title}`,
        );
      await window.screenshot({
        path: info.outputPath(`search-${surface.replace(" ", "-")}.png`),
      });
      await window.keyboard.press("Escape");
      await expect(window.locator(".search-dialog")).toBeHidden();
    }
    await page
      .getByRole("navigation", { name: "主要页面" })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    await page
      .getByRole("button", { name: "新建项目", exact: true })
      .first()
      .click();
    const dialog = page.locator(".project-form-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("input").first().fill("读书笔记整理");
    await dialog.locator("textarea").first().fill("每周整理一次读书笔记");
    const weights = await page.evaluate(() => {
      const dialog = document.querySelector(".project-form-dialog")!;
      const weight = (e: Element) => getComputedStyle(e).fontWeight;
      return {
        input: weight(dialog.querySelector("input")!),
        textarea: weight(dialog.querySelector("textarea")!),
        label: weight(dialog.querySelector("label")!),
      };
    });
    if (weights.input !== "400" || weights.textarea !== "400")
      failures.push(
        `project form fields use weight ${weights.input} and ${weights.textarea} instead of 400`,
      );
    if (weights.label !== "600")
      failures.push(
        `project form label weight ${weights.label} instead of 600`,
      );
    await page.screenshot({ path: info.outputPath("project-form.png") });
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(app);
  }
});

test("form fields: a focused field in dialogs, settings, project settings and widget settings shows the accent border with a soft halo instead of the outer ring, while filter bars and buttons keep the ring, in light and dark", async () => {
  const failures: string[] = [];
  const f = await journeyFixture();
  try {
    const page = f.page;
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      const fields = async (where: string, selectors: string[]) => {
        for (const selector of selectors)
          failures.push(
            ...(await fieldFocus(page, selector)).map(
              (m) => `${appearance} ${where} ${m}`,
            ),
          );
      };
      const rings = async (where: string, selectors: string[]) => {
        for (const selector of selectors) {
          await page.keyboard.press("Tab");
          failures.push(
            ...(await focusRing(page, selector)).map(
              (m) => `${appearance} ${where} ${m}`,
            ),
          );
        }
      };
      // Project settings: the project chat's settings and input are form fields (the execution roles use the
      // same rule but are disabled without a configured local Agent); the object list's search and grouping
      // controls are a filter bar.
      await page
        .getByRole("navigation", { name: "主要页面" })
        .getByRole("button", { name: "工作台", exact: true })
        .click();
      if (await page.locator(".project-table").isVisible())
        await page
          .locator(".project-open")
          .filter({ hasText: "合成任务旅程" })
          .click();
      await page
        .getByRole("navigation", { name: "Runtime 内容" })
        .getByRole("button", { name: "当前阶段：任务开发", exact: true })
        .click();
      await expect(
        page.locator(".project-inline-controls input"),
      ).toBeVisible();
      if (
        !(await page.getByRole("textbox", { name: "项目对话输入" }).isVisible())
      )
        await page
          .getByRole("button", { name: "新建项目对话", exact: true })
          .click();
      await expect(
        page.getByRole("textbox", { name: "项目对话输入" }),
      ).toBeVisible();
      await fields("project", [
        ".project-chat-settings select",
        ".project-chat-pane form > textarea",
      ]);
      await rings("project", [
        ".project-inline-controls input",
        ".project-inline-controls select",
        ".project-chat-send .button",
      ]);
      // The decision form of a project action.
      await goTo(page, "待处理");
      await page
        .getByRole("button", { name: "处理：接纳任务", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "核对项目操作",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await fields("action dialog", [".project-action-field select"]);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // The pending filter bar keeps the ring.
      await rings("pending filters", [
        ".record-query-controls input:not([type=checkbox])",
        ".record-query-controls select",
      ]);
      // A new project's form.
      await page
        .getByRole("navigation", { name: "主要页面" })
        .getByRole("button", { name: "工作台", exact: true })
        .click();
      if (await page.getByRole("button", { name: "返回项目列表" }).isVisible())
        await page.getByRole("button", { name: "返回项目列表" }).click();
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      await expect(page.locator(".project-form-dialog")).toBeVisible();
      await fields("new project", [
        ".project-form-dialog input",
        ".project-form-dialog textarea",
      ]);
      await page.keyboard.press("Escape");
      await expect(page.locator(".project-form-dialog")).toHaveCount(0);
      // Settings: a provider's form and a local Agent's executable path.
      await providersPage(page);
      await page
        .getByRole("button", { name: "添加自定义提供方", exact: true })
        .click();
      await expect(
        page.getByRole("form", { name: "新建提供方" }),
      ).toBeVisible();
      await fields("provider form", [
        ".field input[name=name]",
        ".field input[name=endpoint]",
      ]);
      await openProvider(page, "Claude Code");
      await fields("Claude Code", [".codex-path-settings > input"]);
    }
  } finally {
    await closeLocal(f.app);
  }
  // Widget settings open only for an accepted widget: the acceptance build loads a test candidate.
  const root = seedConversations();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`, "--widget-acceptance"],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await ready(page);
    await goTo(page, "工作台");
    await page
      .getByRole("tablist", { name: "工作台内容" })
      .getByRole("tab", { name: "控件" })
      .click();
    await page.getByRole("button", { name: "载入测试候选" }).click();
    await page
      .getByRole("region", { name: "测试候选预览" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(page.locator(".widget-settings")).toBeVisible();
    const widgetField = ".widget-config-field input:not([type=checkbox])";
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      // At rest the widget's text field is a form field like the others (it had the browser's own border).
      await rest(page);
      failures.push(
        ...(await mismatches(page, field(widgetField))).map(
          (m) => `${appearance} widget settings ${m}`,
        ),
      );
      failures.push(
        ...(await fieldFocus(page, widgetField)).map(
          (m) => `${appearance} widget settings ${m}`,
        ),
      );
    }
  } finally {
    await closeLocal(app);
  }
  expect(failures).toEqual([]);
});

/**
 * The resting and hovered look of a selected control: background and text colour of the control (and of the row
 * that carries its selection, when given), and the text weight of the part that shows its name.
 */
async function selectedLook(
  page: Page,
  control: Locator,
  parts: { row?: Locator; name?: Locator } = {},
) {
  const read = async () => ({
    background: await control.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    ),
    color: await control.evaluate((el) => getComputedStyle(el).color),
    row: parts.row
      ? await parts.row.evaluate((el) => getComputedStyle(el).backgroundColor)
      : null,
    weight: await (parts.name ?? control).evaluate(
      (el) => getComputedStyle(el).fontWeight,
    ),
  });
  await page.mouse.move(0, 0);
  const rest = await read();
  await control.hover();
  const hovered = await read();
  await page.mouse.move(0, 0);
  return { rest, hovered };
}

test("selected states: every current item keeps its selection colours and weight under the pointer and takes the weight of its prototype counterpart, in light and dark", async () => {
  const failures: string[] = [];
  const check = async (
    page: Page,
    appearance: Appearance,
    name: string,
    control: Locator,
    weight: string,
    parts: { row?: Locator; name?: Locator } = {},
  ) => {
    if (
      !(await control
        .waitFor({ timeout: 5000 })
        .then(() => true)
        .catch(() => false))
    ) {
      failures.push(`${appearance} ${name}: no selected control found`);
      return;
    }
    const { rest, hovered } = await selectedLook(page, control, parts);
    if (rest.weight !== weight)
      failures.push(
        `${appearance} ${name}: weight ${rest.weight} instead of ${weight}`,
      );
    if (JSON.stringify(hovered) !== JSON.stringify(rest))
      failures.push(
        `${appearance} ${name}: under the pointer ${JSON.stringify(hovered)} instead of ${JSON.stringify(rest)}`,
      );
  };
  const root = seedConversations();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await ready(page);
    const conversation = (await (
      await recent(page)
    )
      .locator(".session")
      .filter({ hasText: "整理读书笔记" })
      .getAttribute("aria-label"))!;
    await page.keyboard.press("Escape");
    const opened = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click();
    });
    const panel = await opened;
    const panelNav = panel.getByRole("navigation", { name: "面板导航" });
    await expect(panelNav).toBeVisible();
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      await goTo(page, "聊天");
      await openConversation(page, conversation);
      // The page switch: the prototype's page navigation (the narrow column) keeps names regular.
      await check(
        page,
        appearance,
        "page switch",
        page.locator('.home-nav [aria-current="page"]'),
        "400",
      );
      // Recent chats: the prototype's current chat row is bold.
      const history = await recent(page);
      const current = history.locator('.session[aria-current="true"]');
      await check(page, appearance, "recent current", current, "600", {
        row: history.locator(".session-line.active"),
        name: current.locator(".session-name"),
      });
      await page.keyboard.press("Escape");
      // Global search: category chips stay regular; the current result keeps its tint.
      await page.getByRole("button", { name: "全局搜索" }).click();
      await page.locator(".search-input-row input").fill("读书");
      await expect(page.locator(".search-result").first()).toBeVisible();
      await check(
        page,
        appearance,
        "search category",
        page.locator('.search-categories [role="tab"][aria-selected="true"]'),
        "400",
      );
      await check(
        page,
        appearance,
        "search result",
        page.locator('.search-result[aria-selected="true"]'),
        await page
          .locator('.search-result[aria-selected="true"]')
          .evaluate((el) => getComputedStyle(el).fontWeight),
      );
      await page.keyboard.press("Escape");
      // Settings: the category and the chosen appearance are bold, as in the prototype's settings.
      await goTo(page, "设置");
      await check(
        page,
        appearance,
        "settings category",
        page.locator('.settings-nav [aria-current="page"]'),
        "600",
      );
      await check(
        page,
        appearance,
        "appearance choice",
        page.locator('.appearance-control [aria-pressed="true"]'),
        "600",
      );
      // The avatar menu's current page item: a page navigation item, regular like the narrow column.
      await page.getByRole("button", { name: /^我，个人空间/ }).click();
      await check(
        page,
        appearance,
        "avatar menu current",
        page.locator('.profile-menu-item[aria-current="page"]'),
        "400",
      );
      await page.keyboard.press("Escape");
      // The menu bar panel: tabs stay regular as in its prototype; its settings category is bold.
      await expect(panel.locator("html")).toHaveAttribute(
        "data-theme",
        appearance,
      );
      await check(
        panel,
        appearance,
        "panel tab",
        panelNav.locator('[aria-current="page"]'),
        "400",
      );
      await panelNav.getByRole("button", { name: "设置", exact: true }).click();
      await check(
        panel,
        appearance,
        "panel settings category",
        panel.locator('.settings-nav [aria-current="page"]'),
        "600",
      );
      await panelNav
        .getByRole("button", { name: "工作台", exact: true })
        .click();
    }
  } finally {
    await closeLocal(app);
  }
  const f = await journeyFixture();
  try {
    const page = f.page;
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      await page
        .getByRole("navigation", { name: "主要页面" })
        .getByRole("button", { name: "工作台", exact: true })
        .click();
      if (await page.locator(".project-table").isVisible())
        await page
          .locator(".project-open")
          .filter({ hasText: "合成任务旅程" })
          .click();
      // Project object buttons: bold, as the prototype's project sub-navigation.
      await check(
        page,
        appearance,
        "object button",
        page.locator('.project-object-tabs [aria-pressed="true"]'),
        "600",
      );
      await page.getByRole("button", { name: "返回项目列表" }).click();
      // Workbench tabs: bold, as the prototype's sub-navigation.
      await check(
        page,
        appearance,
        "workbench tab",
        page.locator('.workbench-tabs [aria-selected="true"]'),
        "600",
      );
      // The archived toggle when pressed: accent text as the prototype's pressed toolbar button, regular weight.
      await page.getByRole("button", { name: "已归档", exact: true }).click();
      const toggle = page.locator('.button[aria-pressed="true"]');
      await check(page, appearance, "archived toggle", toggle, "400");
      if (
        (await toggle.evaluate((el) => getComputedStyle(el).color)) !==
        (await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--c-accent)";
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }))
      )
        failures.push(`${appearance} archived toggle: text is not the accent`);
      await toggle.click();
      // Pending tabs: regular, as the prototype's view switch of the pending page.
      await goTo(page, "待处理");
      await check(
        page,
        appearance,
        "pending tab",
        page.locator('.record-query [role="tab"][aria-selected="true"]'),
        "400",
      );
    }
  } finally {
    await closeLocal(f.app);
  }
  expect(failures).toEqual([]);
});
