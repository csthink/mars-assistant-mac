import { goTo } from "./shell";
import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchReal, shutdownReal, type RealClient } from "./real-client";
import { openProvider } from "./provider-ui";
import {
  terminalStates,
  validEffortLevel,
  validModel,
  type Snapshot,
} from "../../src/shared/protocol";

/**
 * feature-t27 S-05: real re-verification of the reasoning effort level on both local executors
 * and the four API presets. Every case is named by Mars in CSTHINK_REAL_EFFORT_CASES after the
 * recorded authorization; nothing is guessed. Each executor case sends one short turn at the
 * chosen level and one at an unrecorded model; each API case sends one turn and proves the
 * request body carries no level. Instrumentation records flags, method names and effort fields
 * only, never prompts, answers, credentials or raw protocol payloads.
 */
interface Cases {
  claude?: { model: string; level: string; unrecordedModel?: string };
  codex?: { model: string; level: string; unrecordedModel?: string };
  api?: Partial<
    Record<"zhipu" | "deepseek" | "openrouter" | "siliconflow", string>
  >;
}
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const casesText = process.env.CSTHINK_REAL_EFFORT_CASES;
const authorized =
  process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1" &&
  process.env.CSTHINK_REAL_TASK === "feature-t27";
test.skip(
  !root || !evidence || !authorized || !casesText,
  "feature-t27 needs its own real-call authorization, data root, a fresh evidence directory and explicit cases",
);
test.setTimeout(900_000);
test.use({ trace: "off", actionTimeout: 30_000 });
const prompt = "这是一条推理强度复验消息。请只回复：确认。";

/** Test-owned observer installed in the main process; it never enters the product build. */
const observerSource = `(() => {
  const cp = process.mainModule.require('node:child_process');
  const original = cp.spawn;
  const state = globalThis.t27 = { claudeSessions: [], codexThreads: [], inits: [] };
  cp.spawn = function (file, args, options) {
    const child = original.apply(this, arguments);
    if (!Array.isArray(args)) return child;
    const isClaude = args.includes('--session-id') || args.includes('--resume');
    const isCodex = args.includes('app-server') && args.includes('default_permissions="csthink_assistant"') && !args.some((a) => String(a).startsWith('model_providers.csthink_contract='));
    if (isClaude) {
      const flags = [];
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]);
        if (a === '--effort' || a === '--model') flags.push(a, String(args[i + 1]));
        else if (a.startsWith('--')) flags.push(a);
      }
      const entry = { flags, init: null };
      state.claudeSessions.push(entry);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        let end;
        while ((end = output.indexOf('\\n')) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m && m.type === 'system' && m.subtype === 'init' && !entry.init) {
            const effortFields = {};
            for (const [k, v] of Object.entries(m)) if (/effort/i.test(k)) effortFields[k] = v;
            entry.init = { keys: Object.keys(m).sort(), effortFields, model: typeof m.model === 'string' ? m.model : null };
          }
        }
      });
    }
    if (isCodex) {
      const requests = new Map(); let input = '';
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = function (chunk, ...rest) {
        input += String(chunk);
        let end;
        while ((end = input.indexOf('\\n')) >= 0) {
          const line = input.slice(0, end); input = input.slice(end + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m && (m.method === 'thread/start' || m.method === 'thread/resume')) {
            const entry = { method: m.method, model: m.params && m.params.model, config: m.params && m.params.config ? m.params.config : null, readback: undefined };
            requests.set(m.id, entry); state.codexThreads.push(entry);
          }
        }
        return write(chunk, ...rest);
      };
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        let end;
        while ((end = output.indexOf('\\n')) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          const entry = m && m.id !== undefined ? requests.get(m.id) : undefined;
          if (entry && m.result) entry.readback = typeof m.result.reasoningEffort === 'string' ? m.result.reasoningEffort : null;
        }
      });
    }
    return child;
  };
  return 'installed';
})()`;

/** Confirms the executor's origin and enables the model the way a person does in settings; no model call. */
async function ensureLocalModel(page: Page, name: string, model: string) {
  await openProvider(page, name);
  const section = page.getByRole("region", { name: `${name} 连接` });
  const configure = section.getByRole("button", {
    name: `配置 ${name}`,
    exact: true,
  });
  if (await configure.isVisible().catch(() => false)) {
    await configure.click();
    const setup = page.getByRole("region", { name: `确认 ${name} 连接` });
    await expect(setup).toBeVisible();
    // Personal rule sources need the person's consent before the origin can be confirmed.
    const consent = setup.getByRole("checkbox");
    if (await consent.count()) await consent.first().check();
    await setup
      .getByRole("button", { name: `确认配置 ${name}`, exact: true })
      .click();
    await expect(section.getByText("已配置", { exact: true })).toBeVisible();
  }
  const toggle = section.getByRole("checkbox", {
    name: `启用模型 ${model}`,
    exact: true,
  });
  await expect(toggle).toBeVisible();
  if (!(await toggle.isChecked())) {
    await toggle.click();
    const confirmation = page.getByRole("button", {
      name: `确认配置 ${name}`,
      exact: true,
    });
    await expect
      .poll(
        async () =>
          (await toggle.isChecked()) ||
          (await confirmation.isVisible().catch(() => false)),
      )
      .toBe(true);
    if (!(await toggle.isChecked())) {
      const setup = page.getByRole("region", { name: `确认 ${name} 连接` });
      const consent = setup.getByRole("checkbox");
      if (await consent.count()) await consent.first().check();
      await confirmation.click();
    }
    await expect(toggle).toBeChecked();
  }
  await section
    .getByRole("button", { name: `重新检测 ${name}`, exact: true })
    .click();
}
async function snapshotOf(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot;
  });
}
async function sendTurn(page: Page, label: string, level: string | null) {
  await goTo(page, "聊天");
  await page
    .locator("#main-sidebar")
    .getByRole("button", { name: "新建聊天", exact: true })
    .click();
  const picker = page.getByRole("combobox", { name: "本次连接", exact: true });
  await picker.selectOption({ label });
  const control = page.getByRole("combobox", { name: "推理强度" });
  if (level !== null) await expect(control).toBeEnabled();
  else await expect(control).toBeDisabled();
  const options = await control.locator("option").allTextContents();
  const disabled = await control.isDisabled();
  if (level !== null) await control.selectOption(level);
  const before = (await snapshotOf(page)).turns.map((t) => t.id);
  await page
    .getByRole("textbox", { name: "输入草稿", exact: true })
    .fill(prompt);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "跨提供方发送确认" });
  if (await confirm.isVisible().catch(() => false))
    await confirm.getByRole("button", { name: /确认|允许/ }).click();
  await expect
    .poll(
      async () =>
        (await snapshotOf(page)).turns.some(
          (t) => !before.includes(t.id) && terminalStates.includes(t.state),
        ),
      { timeout: 300_000 },
    )
    .toBe(true);
  const turn = (await snapshotOf(page)).turns.find(
    (t) => !before.includes(t.id),
  )!;
  const source = await page.locator(".turn-reference").last().textContent();
  return {
    controlDisabled: disabled,
    controlOptions: options,
    turn: {
      id: turn.id,
      state: turn.state,
      errorClass: turn.errorClass,
      errorMessage: turn.errorMessage,
      model: turn.connection.model,
      provider: turn.connection.provider,
      effort: turn.connection.effort,
      answerLength: turn.partialText.length,
    },
    answerSource: source,
  };
}

test("real effort: local executors honour the chosen level, unrecorded models run at their default, and API requests carry no level", async () => {
  const cases = JSON.parse(casesText!) as Cases;
  for (const local of [cases.claude, cases.codex])
    if (local) {
      expect(validModel(local.model)).toBe(true);
      expect(validEffortLevel(local.level)).toBe(true);
    }
  mkdirSync(evidence!, { recursive: true });
  const output = resolve(evidence!, `effort-real-${Date.now()}.json`);
  expect(existsSync(output)).toBe(false);
  const record: Record<string, unknown> = {
    task: "feature-t27",
    validation: "V-08",
    startedAt: new Date().toISOString(),
    cases,
    claude: "NOT RUN",
    codex: "NOT RUN",
    api: {},
    result: "NOT RUN",
  };
  let client: RealClient | undefined;
  try {
    client = await launchReal(root!);
    const page = client.page;
    expect(await client.mainEval(observerSource)).toBe("installed");
    const observed = () =>
      client!
        .mainEval("JSON.stringify(globalThis.t27)")
        .then((v) => JSON.parse(String(v)));
    const connectionFor = async (provider: string) =>
      (await snapshotOf(page)).connections.find((c) => c.provider === provider);
    const executorCase = async (
      provider: "claude" | "codex",
      name: string,
      spec: NonNullable<Cases["claude"]>,
    ) => {
      await ensureLocalModel(page, name, spec.model);
      if (spec.unrecordedModel)
        await ensureLocalModel(page, name, spec.unrecordedModel);
      await expect
        .poll(
          async () =>
            (await connectionFor(provider))?.models.find(
              (m) => m.model === spec.model,
            )?.effort ?? null,
        )
        .not.toBeNull();
      const connection = (await connectionFor(provider))!;
      const recorded = connection.models.find(
        (m) => m.model === spec.model,
      )!.effort!;
      expect(recorded.levels).toContain(spec.level);
      const chosen = await sendTurn(
        page,
        `${connection.name} · ${spec.model}`,
        spec.level,
      );
      expect(chosen.turn.state).toBe("completed");
      expect(chosen.turn.effort).toBe(spec.level);
      expect(chosen.answerSource).toContain(`推理 ${spec.level}`);
      let unrecorded: unknown = "NOT RUN";
      if (spec.unrecordedModel) {
        const entry = connection.models.find(
          (m) => m.model === spec.unrecordedModel,
        );
        expect(entry?.effort ?? null).toBeNull();
        unrecorded = await sendTurn(
          page,
          `${connection.name} · ${spec.unrecordedModel}`,
          null,
        );
        expect(
          (unrecorded as { controlDisabled: boolean }).controlDisabled,
        ).toBe(true);
        expect(
          (unrecorded as { turn: { effort: unknown } }).turn.effort,
        ).toBeNull();
      }
      return { recorded, chosen, unrecorded };
    };
    if (cases.claude)
      record.claude = await executorCase("claude", "Claude Code", cases.claude);
    if (cases.codex)
      record.codex = await executorCase("codex", "Codex", cases.codex);
    for (const [provider, model] of Object.entries(cases.api ?? {})) {
      const connection = await connectionFor(provider);
      expect(connection?.enabled, provider).toBe(true);
      expect(
        connection?.models.find((m) => m.model === model)?.effort ?? null,
      ).toBeNull();
      const turn = await sendTurn(page, `${connection!.name} · ${model}`, null);
      expect(turn.controlDisabled).toBe(true);
      expect(turn.turn.effort).toBeNull();
      (record.api as Record<string, unknown>)[provider] = { model, ...turn };
    }
    record.observed = await observed();
    const claudeSessions = (
      record.observed as { claudeSessions: { flags: string[] }[] }
    ).claudeSessions;
    const codexThreads = (
      record.observed as {
        codexThreads: {
          config: Record<string, unknown> | null;
          readback?: string | null;
        }[];
      }
    ).codexThreads;
    if (cases.claude) {
      expect(
        claudeSessions.some(
          (s) =>
            s.flags.includes("--effort") &&
            s.flags[s.flags.indexOf("--effort") + 1] === cases.claude!.level,
        ),
      ).toBe(true);
    }
    if (cases.codex) {
      const thread = codexThreads.find(
        (t) => t.config?.model_reasoning_effort === cases.codex!.level,
      );
      expect(thread).toBeTruthy();
      expect(thread?.readback).toBe(cases.codex!.level);
    }
    record.result = "PASS";
  } catch (error) {
    record.result = "FAIL";
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (client && record.observed === undefined)
      record.observed = await client
        .mainEval("JSON.stringify(globalThis.t27)")
        .then((v) => JSON.parse(String(v)))
        .catch(() => null);
    record.endedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
    });
    await shutdownReal(client, true);
  }
});
