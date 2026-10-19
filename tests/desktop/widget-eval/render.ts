/**
 * Renders compiled candidates in the background client and judges the rendered rules. Each
 * candidate enters a fresh data root through the existing offline seeding (the real store and
 * the fixed build), is selected in the widget page, and its csthink-widget:// view is probed.
 * The main process records the views' console errors from creation on, so a failure while the
 * module script first runs is not missed.
 */
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { closeLocal, launchLocal } from "../local-client";
import { goTo, ready } from "../shell";
import { seedWidgetCandidate } from "../widget-generation-fixture";
import type { DomCheck, RenderRule, Requirement } from "./model";
import { isStaticRule } from "./model";
import type { RenderObservation, RuleResult } from "./score";

/** How long a loaded view is watched for errors before its rules run. */
export const observationMs = 1000;
const stepTimeoutMs = 3000;

export interface RenderItem {
  id: string;
  requirement: Requirement;
  packageSource: string;
  digest: string;
}

const literal = (text: string) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u");
function roleLocator(
  view: Page,
  roles: string[],
  name?: string,
  flags?: string,
  checked?: boolean,
) {
  const options = {
    ...(name !== undefined ? { name: new RegExp(name, flags ?? "u") } : {}),
    ...(checked !== undefined ? { checked } : {}),
  };
  return roles
    .map((role) =>
      view.getByRole(role as Parameters<Page["getByRole"]>[0], options),
    )
    .reduce((a: Locator, b: Locator) => a.or(b));
}
async function countOf(view: Page, check: DomCheck) {
  if (check.check === "role")
    return roleLocator(
      view,
      check.roles,
      check.name,
      check.flags,
      check.checked,
    ).count();
  if (check.check === "selector")
    return view.locator(check.selector).filter({ visible: true }).count();
  // Deepest visible elements whose rendered text matches: a container is not counted again.
  return view.evaluate(
    ({ pattern, flags }) => {
      const re = new RegExp(pattern, flags);
      const visible = (el: Element) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const text = (el: Element) =>
        (el instanceof HTMLElement ? el.innerText : el.textContent) ?? "";
      const all = [document.body, ...document.body.querySelectorAll("*")]
        .filter((el) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(el.tagName))
        .filter((el) => visible(el) && re.test(text(el).trim()));
      return all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
        .length;
    },
    { pattern: check.pattern, flags: check.flags ?? "u" },
  );
}
/** Without a min, a check asks for at least one match, unless it only sets a max. */
const within = (count: number, check: DomCheck) =>
  count >= (check.min ?? (check.max === undefined ? 1 : 0)) &&
  count <= (check.max ?? Infinity);
async function judgeCheck(view: Page, check: DomCheck, timeoutMs = 0) {
  const deadline = Date.now() + timeoutMs;
  let count = await countOf(view, check);
  while (!within(count, check) && Date.now() < deadline) {
    await wait(100);
    count = await countOf(view, check);
  }
  return { pass: within(count, check), observed: `count ${count}` };
}
async function judgeRule(view: Page, rule: RenderRule): Promise<RuleResult> {
  if (rule.check !== "interaction") {
    const r = await judgeCheck(view, rule);
    return { id: rule.id, ...r };
  }
  for (const [i, step] of rule.steps.entries()) {
    try {
      if (step.action === "fill")
        await view
          .getByLabel(literal(step.label))
          .and(view.locator("input, textarea, [contenteditable]"))
          .first()
          .fill(step.value, { timeout: stepTimeoutMs });
      else if (step.action === "click" || step.action === "check") {
        const target = roleLocator(view, step.roles, step.name, step.flags);
        if (step.action === "click")
          await target.first().click({ timeout: stepTimeoutMs });
        else await target.first().check({ timeout: stepTimeoutMs });
      } else {
        const r = await judgeCheck(
          view,
          step.rule,
          step.timeoutMs ?? stepTimeoutMs,
        );
        if (!r.pass)
          return {
            id: rule.id,
            pass: false,
            observed: `step ${i + 1} expect ${step.rule.check}: ${r.observed}`,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: rule.id,
        pass: false,
        observed: `step ${i + 1} ${step.action} failed: ${message.split("\n")[0].slice(0, 200)}`,
      };
    }
  }
  return { id: rule.id, pass: true, observed: "all steps passed" };
}

interface ConsoleEntry {
  url: string;
  level: string;
  message: string;
}
async function watchViews(app: ElectronApplication) {
  await app.evaluate(({ app: electronApp }) => {
    const log: { url: string; level: string; message: string }[] = [];
    Reflect.set(globalThis, "widgetEvalConsole", log);
    electronApp.on("web-contents-created", (_event, contents) => {
      contents.on("console-message", (...args: unknown[]) => {
        const event = args[0] as { level?: unknown; message?: unknown };
        // Electron passes an event with level and message; older signatures pass them positionally.
        const level =
          typeof event.level === "string"
            ? event.level
            : args[1] === 3
              ? "error"
              : String(args[1]);
        const message =
          typeof event.message === "string" ? event.message : String(args[2]);
        log.push({ url: contents.getURL(), level, message });
      });
      contents.on("preload-error", (_e, _path, error) =>
        log.push({
          url: contents.getURL(),
          level: "error",
          message: `preload: ${error.message}`,
        }),
      );
      contents.on("render-process-gone", (_e, details) =>
        log.push({
          url: contents.getURL(),
          level: "error",
          message: `render process gone: ${details.reason}`,
        }),
      );
    });
  });
  return async (origin: string) =>
    (
      (await app.evaluate(
        () => Reflect.get(globalThis, "widgetEvalConsole") as ConsoleEntry[],
      )) ?? []
    )
      .filter((e) => e.url.startsWith(origin) && e.level === "error")
      .map((e) => e.message);
}

/**
 * A minimal widget rendered first in every run. Console errors it logs come from the product's
 * own view document, not from any candidate, and are not attributed to the candidates.
 */
export const baselineSource = JSON.stringify({
  schemaVersion: 1,
  name: "Baseline",
  view: { html: "<p>baseline</p>", css: "", js: "" },
  config: [],
  draftFields: [],
  capabilities: [],
  resources: [],
});

/** Renders every item in one client, one selected draft at a time. */
export async function renderCandidates(items: RenderItem[]): Promise<{
  observations: Map<string, RenderObservation>;
  baseline: string[];
}> {
  const observations = new Map<string, RenderObservation>();
  if (!items.length) return { observations, baseline: [] };
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(
    resolve(".test-data/disposable/widget-eval-render-"),
  );
  const baselineSeed = seedWidgetCandidate(root, false, baselineSource);
  const seeded = items.map((item) => ({
    item,
    ...seedWidgetCandidate(root, false, item.packageSource),
  }));
  let app: ElectronApplication | undefined;
  try {
    app = await launchLocal({ args: [resolve("."), `--data-root=${root}`] });
    const client = app;
    const errorsFor = await watchViews(client);
    const page = await client.firstWindow();
    await ready(page);
    await client.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("index.html"))!
        .setContentSize(1200, 900),
    );
    await goTo(page, "控件");
    /** Selects a seeded draft and returns its loaded view, or null when none appeared. */
    const open = async (draftId: string, candidateId: string) => {
      const snapshot = await page.evaluate(async (id) => {
        const r = await window.desktop.command({
          type: "selectWidgetDraft",
          id,
        });
        if (!r.ok) throw new Error(r.message);
        return r.snapshot;
      }, draftId);
      const digest = snapshot.widgetGeneration!.candidates.find(
        (c) => c.id === candidateId,
      )?.digest;
      // The native view exists only while its preview frame is inside the viewport.
      const frame = page
        .getByLabel("控件预览", { exact: true })
        .locator(".widget-frame");
      const until = Date.now() + 15_000;
      let generation: string | null = null;
      while (!generation && Date.now() < until) {
        if (await frame.count())
          await frame.scrollIntoViewIfNeeded().catch(() => {});
        const status = await page.evaluate(() =>
          window.desktop.widgetControl({ action: "status" }),
        );
        if (
          status.ok &&
          status.preview?.candidateId === candidateId &&
          status.generation
        )
          generation = status.generation;
        else await wait(100);
      }
      if (!generation) return { digest, view: null, origin: "" };
      const origin = `csthink-widget://${generation}/`;
      let view: Page | undefined;
      while (!view && Date.now() < until) {
        view = client
          .context()
          .pages()
          .find((p) => p.url() === `${origin}index.html`);
        if (!view) await wait(100);
      }
      if (!view) return { digest, view: null, origin };
      await view.waitForLoadState("load");
      await wait(observationMs);
      return { digest, view, origin };
    };
    const base = await open(baselineSeed.draftId, baselineSeed.candidateId);
    if (!base.view) throw new Error("the baseline widget view did not appear");
    const baseline = [...new Set(await errorsFor(base.origin))].sort();
    for (const { item, draftId, candidateId } of seeded) {
      const { digest, view, origin } = await open(draftId, candidateId);
      if (digest !== item.digest)
        throw new Error(
          `${item.id}: seeded build differs from the replayed one`,
        );
      if (!view) {
        observations.set(item.id, {
          loaded: false,
          empty: false,
          errors: [],
          rules: [],
        });
        continue;
      }
      const errors = (await errorsFor(origin)).filter(
        (m) => !baseline.includes(m),
      );
      const empty = await view.evaluate(
        () =>
          document.body.innerText.trim().length === 0 &&
          document.body.querySelector("svg, canvas, img, input, button") ===
            null,
      );
      const rules: RuleResult[] = [];
      if (!empty && !errors.length)
        for (const rule of item.requirement.rules)
          if (!isStaticRule(rule)) rules.push(await judgeRule(view, rule));
      observations.set(item.id, { loaded: true, empty, errors, rules });
    }
    return { observations, baseline };
  } finally {
    if (app) await closeLocal(app);
    rmSync(root, { recursive: true, force: true });
  }
}
