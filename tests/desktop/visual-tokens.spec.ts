import {
  test,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { closeLocal, launchLocal } from "./local-client";
import { goTo, openConversation, ready, recent } from "./shell";
import { journeyFixture } from "./project-action-fixture";
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
const windowSizes = [
  [1180, 800],
  [900, 680],
] as const;

async function windowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [width, height],
  );
  await expect
    .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
    .toEqual([width, height]);
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
      [".bubble.user", "background-color", "var(--c-raised)"],
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
      ...field(".rename-dialog input"),
      ...primaryButton(".rename-dialog .button.primary"),
      ...secondaryButton(".rename-dialog .button:not(.primary)"),
    ],
    focus: ".rename-dialog input",
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
    const failures: string[] = [];
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      await expectTokens(page, appearance);
      for (const [width, height] of windowSizes) {
        await windowSize(app, page, width, height);
        for (const view of chatPages) {
          await view.open(page);
          await rest(page, view.keep);
          if (view.hover) await page.locator(view.hover).first().hover();
          if (width === windowSizes[0][0])
            failures.push(
              ...(await mismatches(page, view.probes)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          await shot(page, info, `${width}x${height}-${appearance}-${view.id}`);
          if (width === windowSizes[0][0] && view.focus) {
            await page.keyboard.press("Tab");
            failures.push(
              ...(await focusRing(page, view.focus)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          }
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
      [".project-task-list li", "border-bottom-color", line],
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
      await page.locator(".project-more").first().click();
      await expect(page.locator(".project-menu")).toBeVisible();
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
        await page.locator(".project-more").first().click();
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
      ...field(".project-form-dialog input"),
      ...field(".project-form-dialog textarea"),
      ...primaryButton(".project-form-dialog .button.project-primary"),
      ...secondaryButton(".project-form-actions .button:not(.project-primary)"),
      [".project-form-actions", "border-top-color", line],
    ],
    focus: ".project-form-dialog input",
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
    const failures: string[] = [];
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(f.page, appearance);
      for (const [width, height] of windowSizes) {
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
          if (width === windowSizes[0][0])
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
          if (width === windowSizes[0][0] && view.focus) {
            await f.page.keyboard.press("Tab");
            failures.push(
              ...(await focusRing(f.page, view.focus)).map(
                (m) => `${appearance} ${view.id} ${m}`,
              ),
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await closeLocal(f.app);
  }
});
