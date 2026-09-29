import { test, expect, type ElectronApplication } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { launchLocal } from "./local-client";
import { goTo } from "./shell";
import { stopClaudeTestTurns } from "./claude-test-cleanup";
import { openProvider } from "./provider-ui";
import {
  discoverClaude,
  claudeEnvironment,
} from "../../src/main/claude-discovery";
import { ClaudeRpc } from "../../src/main/claude-rpc";
import { claudeInspectionArgs } from "../../src/main/claude";
import { assertClaudePolicy } from "../../src/main/claude-policy";
import { configureCodexProcessHelper } from "../../src/main/codex-process";
import type { ClaudeRun } from "../../src/shared/claude";
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const evidenceRoot = process.env.CSTHINK_REAL_EVIDENCE_ROOT;
const batch = process.env.CSTHINK_CLAUDE_RECOVERY_BATCH;
const scenario = process.env.CSTHINK_CLAUDE_RECOVERY_CASE;
const model = "claude-sonnet-5";
const stopSupplement = process.env.CSTHINK_CLAUDE_STOP_SUPPLEMENT === "OD-64";
const authorization = stopSupplement ? "OD-64" : "OD-63";
const limit = stopSupplement ? 1 : 4;
test.skip(
  process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    process.env.CSTHINK_REAL_TASK !== "feature-t7" ||
    !root ||
    !evidence ||
    !batch ||
    !scenario,
  "Requires OD-63 Sonnet authorization and isolated paths",
);
test.use({ trace: "off", actionTimeout: 30000 });
test.setTimeout(420000);
test("real claude recovery: bounded rejection, stop or native resume", async () => {
  if (!evidenceRoot)
    throw Error("CSTHINK_REAL_EVIDENCE_ROOT must name the evidence directory");
  const evidenceParent = resolve(evidenceRoot, "feature-t7") + "/";
  if (
    root !==
      join(
        homedir(),
        "Library/Application Support/csthink-assistant-dev/feature-t7",
      ) ||
    !evidence?.startsWith(evidenceParent) ||
    !batch?.startsWith(evidenceParent) ||
    !["deny", "stop", "recovery"].includes(scenario!) ||
    (stopSupplement && scenario !== "stop")
  )
    throw Error("Outside OD-63 scope");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, "attempt.json"),
    JSON.stringify({ scenario, model, at: new Date().toISOString() }),
    { flag: "wx" },
  );
  const budgetPath = join(batch, "budget.json");
  if (!existsSync(budgetPath))
    writeFileSync(
      budgetPath,
      JSON.stringify({ authorization, limit, reservations: [] }),
      { flag: "wx" },
    );
  const spend = (stage: string) => {
    const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
    if (
      budget.authorization !== authorization ||
      budget.limit !== limit ||
      budget.reservations.length >= limit
    )
      throw Error("OD-63 budget exhausted");
    budget.reservations.push({
      stage,
      evidence,
      model,
      at: new Date().toISOString(),
    });
    writeFileSync(budgetPath, JSON.stringify(budget, null, 2));
  };
  const result: Record<string, unknown> = {
    result: "NOT RUN",
    scenario,
    model,
    execution_ids: [],
    checks: [],
  };
  const ids: string[] = [];
  const checks: string[] = [];
  const save = () =>
    writeFileSync(
      join(evidence!, "result.json"),
      JSON.stringify({ ...result, execution_ids: ids, checks }, null, 2) + "\n",
    );
  let app: ElectronApplication | undefined, observer: ClaudeRpc | undefined;
  const observe = () => {
    if (
      !observer ||
      observer.process.exitCode !== null ||
      observer.process.signalCode !== null
    )
      throw Error("Independent Claude process exited unexpectedly");
    const identities = JSON.parse(
      execFileSync(
        resolve("dist/codex-process"),
        ["scan", String(observer.process.pid)],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
      ),
    ) as Array<{ pid: number }>;
    const identity = identities.find(
      (item) => item.pid === observer!.process.pid,
    );
    if (!identity) throw Error("Independent CLI identity missing");
    return identity;
  };
  try {
    app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (v): v is [string, string] => v[1] !== undefined,
        ),
      ),
    });
    const page = await app.firstWindow();
    const snapshot = () =>
      page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw Error(r.message);
        return r.snapshot;
      });
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await openProvider(page, "Claude Code");
    const section = page.getByRole("region", {
      name: "Claude Code 连接",
      exact: true,
    });
    await expect(
      section.getByText("Claude 订阅登录", { exact: true }),
    ).toBeVisible();
    const toggle = section.getByRole("checkbox", {
      name: `启用模型 ${model}`,
      exact: true,
    });
    await expect(toggle).toBeChecked();
    const initial = await snapshot();
    const connection = initial.connections.find(
      (c) => c.provider === "claude",
    )!;
    const initialDefault = {
      connection: initial.settings.defaultConnectionId,
      model: initial.settings.defaultModelId,
    };
    result.initial_default = initialDefault;
    // The independent CLI belongs to this test runner, outside the product's process tree.
    await assertClaudePolicy(process.env);
    const installation = await discoverClaude();
    if (!installation) throw Error("Claude installation unavailable");
    const observerRoot = join(root + "-shell", "observer-od63-" + randomUUID());
    mkdirSync(observerRoot, { recursive: true });
    configureCodexProcessHelper(resolve("dist/codex-process"));
    observer = new ClaudeRpc(
      installation.resolvedPath,
      claudeInspectionArgs(),
      {
        cwd: observerRoot,
        env: claudeEnvironment(process.env, dirname(installation.path)),
      },
    );
    await observer.request("initialize");
    await observer.ready();
    const observerBefore = observe();
    result.observer_before = observerBefore;
    await app.evaluate(
      (_electron, options) => {
        const cp = process.mainModule!.require(
          "node:child_process",
        ) as typeof import("node:child_process");
        const fs = process.mainModule!.require(
          "node:fs",
        ) as typeof import("node:fs");
        const original = cp.spawn;
        let faulted = false;
        const record = (value: unknown) =>
          fs.appendFileSync(
            options.evidence + "/native-events.txt",
            JSON.stringify(value) + "\n",
          );
        cp.spawn = function (...args: Parameters<typeof original>) {
          const argv = args[1];
          const opts = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
          const target =
            Array.isArray(argv) &&
            (argv.includes("--session-id") || argv.includes("--resume")) &&
            opts?.env?.ANTHROPIC_API_KEY !== "SYNTHETIC_ONLY_NOT_REAL";
          const resumed = target && argv.includes("--resume");
          const child = original(...args);
          if (target) {
            const session =
              argv[argv.indexOf(resumed ? "--resume" : "--session-id") + 1];
            record({
              type: "spawn",
              pid: child.pid,
              session,
              model: argv[argv.indexOf("--model") + 1],
              resume: resumed,
              binary: args[0],
              restricted: argv.includes("--restricted"),
              permissionMode: argv[argv.indexOf("--permission-mode") + 1],
            });
            const write = child.stdin!.write.bind(child.stdin);
            child.stdin!.write = ((chunk: string, ...rest: unknown[]) => {
              const m = JSON.parse(String(chunk));
              if (m.type === "user")
                fs.writeFileSync(
                  options.evidence + `/input-${child.pid}.json`,
                  JSON.stringify(m, null, 2),
                );
              if (
                m.type === "control_request" &&
                m.request?.subtype === "interrupt"
              )
                record({ type: "interrupt", pid: child.pid, session });
              return Reflect.apply(write, undefined, [chunk, ...rest]);
            }) as typeof write;
            let buffer = "",
              deltaCount = 0;
            child.stdout?.on("data", (chunk: Buffer | string) => {
              buffer += chunk.toString();
              let end: number;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                try {
                  const m = JSON.parse(line);
                  if (m.type === "system" && m.subtype === "init")
                    record({
                      type: "init",
                      pid: child.pid,
                      session: m.session_id,
                      model: m.model,
                      tools: m.tools,
                      permissionMode: m.permissionMode,
                    });
                  if (
                    m.type === "stream_event" &&
                    m.event?.delta?.type === "text_delta"
                  ) {
                    deltaCount++;
                    if (deltaCount === 1)
                      record({
                        type: "first_delta",
                        pid: child.pid,
                        session,
                        length: m.event.delta.text.length,
                      });
                    if (
                      options.scenario === "recovery" &&
                      !resumed &&
                      !faulted
                    ) {
                      faulted = true;
                      record({
                        type: "injected_failure",
                        pid: child.pid,
                        session,
                        signal: "SIGTERM",
                      });
                      child.kill("SIGTERM");
                    }
                  }
                } catch {
                  /* Discard unrelated CLI diagnostics. */
                }
              }
            });
            child.on("close", (code, signal) =>
              record({ type: "close", pid: child.pid, session, code, signal }),
            );
          }
          return child;
        } as typeof original;
      },
      { evidence, scenario },
    );
    await goTo(page, "聊天");
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    const conversationId = (await snapshot()).selected.main!;
    const submit = async (
      text: string,
      materialMode: "tools" | "inline" = "inline",
    ) => {
      const before = new Set(
        (await snapshot()).events
          .filter((e) => e.kind === "submitted")
          .map((e) => e.executionId),
      );
      await page.getByRole("textbox", { name: "输入草稿" }).fill(text);
      await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
      await expect(
        page.getByRole("button", { name: "发送消息", exact: true }),
      ).toBeEnabled();
      spend(scenario!);
      await page.evaluate(
        async ({ conversationId, connectionId, model, text, materialMode }) => {
          const r = await window.desktop.command({
            type: "submitTurn",
            requestId: crypto.randomUUID(),
            conversationId,
            connectionId,
            model,
            text,
            materialMode,
          });
          if (!r.ok) throw Error(r.message);
        },
        {
          conversationId,
          connectionId: connection.id,
          model,
          text,
          materialMode,
        },
      );
      await expect
        .poll(async () =>
          (await snapshot()).events.some(
            (e) => e.kind === "submitted" && !before.has(e.executionId),
          ),
        )
        .toBe(true);
      const id = (await snapshot()).events.find(
        (e) => e.kind === "submitted" && !before.has(e.executionId),
      )!.executionId;
      ids.push(id);
      save();
      return id;
    };
    const settled = async (id: string) => {
      await expect
        .poll(
          async () =>
            (await snapshot()).events.some(
              (e) =>
                e.executionId === id &&
                ["completed", "failed", "stopped", "interrupted"].includes(
                  e.kind,
                ),
            ),
          { timeout: 190000 },
        )
        .toBe(true);
      const s = await snapshot();
      expect(s.activeTurns.some((t) => t.executionId === id)).toBe(false);
      return s;
    };
    if (scenario === "deny") {
      const marker = "T7_DENIED_" + randomUUID();
      const file = join(evidence, "material-denied.txt");
      writeFileSync(file, marker);
      result.fixture_sha256 = createHash("sha256").update(marker).digest("hex");
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [file],
        })) as typeof dialog.showOpenDialog;
      }, file);
      await page.getByRole("button", { name: "添加资料", exact: true }).click();
      await expect
        .poll(async () => (await snapshot()).draftAttachments.length)
        .toBe(1);
      const id = await submit(
        "请使用产品资料读取工具读取选定文件，只回复文件中的标记。如果读取被拒绝，明确说明无法读取，不要猜测。",
        "tools",
      );
      await expect
        .poll(
          async () => {
            const s = await snapshot();
            return (
              s.toolOperations.some((o) => o.executionId === id) ||
              s.events.some(
                (e) =>
                  e.executionId === id &&
                  ["failed", "completed"].includes(e.kind),
              )
            );
          },
          { timeout: 90000 },
        )
        .toBe(true);
      await page
        .getByRole("button", { name: "到待处理确认资料读取", exact: true })
        .click();
      await page.getByRole("button", { name: "拒绝读取", exact: true }).click();
      const s = await settled(id);
      const operations = s.toolOperations.filter((o) => o.executionId === id);
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.every((o) => o.state === "denied")).toBe(true);
      expect(
        s.events.some((e) => e.executionId === id && e.kind === "completed"),
      ).toBe(true);
      await goTo(page, "聊天");
      const answer = await page
        .getByRole("article", { name: "助手消息" })
        .innerText();
      expect(answer).not.toContain(marker);
      expect(answer).toMatch(/拒绝|无法|未获|不能/);
      result.answer = answer;
      result.tool_operations = operations;
      checks.push("material-denied-without-disclosure");
    } else {
      const id = await submit(
        scenario === "recovery"
          ? "请只输出从 1 到 100 的整数，每行一个数字。"
          : stopSupplement
            ? "请只输出从 1 到 1000 的整数，每行一个数字。"
            : "请依次输出从 1 到 500 的编号，每行加一句不同的简短中文说明，不调用工具。",
      );
      if (scenario === "stop") {
        await expect
          .poll(
            async () =>
              (await snapshot()).turns.find((t) => t.executionId === id)
                ?.partialText.length ?? 0,
            { timeout: 90000 },
          )
          .toBeGreaterThan(0);
        await page
          .getByRole("button", { name: "停止回合", exact: true })
          .click();
        const s = await settled(id);
        expect(
          s.events.some((e) => e.executionId === id && e.kind === "stopped"),
        ).toBe(true);
        expect(
          s.turns.find((t) => t.executionId === id)?.partialText.length,
        ).toBeGreaterThan(0);
        const native = readFileSync(join(evidence, "native-events.txt"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(native.filter((n) => n.type === "interrupt")).toHaveLength(1);
        expect(native.some((n) => n.type === "close")).toBe(true);
        checks.push("native-stop-with-interrupt-and-exit");
      } else {
        const failed = await settled(id);
        const pending = failed.pendingItems.find((p) => p.executionId === id);
        expect(pending).toBeTruthy();
        expect(
          failed.turns.find((t) => t.executionId === id)?.partialText.length,
        ).toBeGreaterThan(0);
        const prior = failed.events.find(
          (e) => e.kind === "native_session" && e.executionId === id,
        )?.payload.claude as ClaudeRun;
        expect(prior).toBeTruthy();
        result.failed_journal = JSON.parse(
          readFileSync(join(prior.cwd, "outcome.json"), "utf8"),
        );
        expect((result.failed_journal as { state: string }).state).toBe(
          "failed",
        );
        checks.push("owned-process-failed-with-partial-output");
        save();
        const before = new Set(failed.events.map((e) => e.executionId));
        spend("native-resume");
        await page.evaluate(async (id) => {
          const r = await window.desktop.command({
            type: "resolvePending",
            id,
            action: "retry",
          });
          if (!r.ok) throw Error(r.message);
        }, pending!.id);
        await expect
          .poll(async () =>
            (await snapshot()).events.some(
              (e) => !before.has(e.executionId) && e.kind === "started",
            ),
          )
          .toBe(true);
        const resumedId = (await snapshot()).events.find(
          (e) => !before.has(e.executionId) && e.kind === "started",
        )!.executionId;
        ids.push(resumedId);
        save();
        const recovered = await settled(resumedId);
        expect(
          recovered.events.some(
            (e) => e.executionId === resumedId && e.kind === "completed",
          ),
        ).toBe(true);
        expect(
          recovered.pendingItems.some(
            (p) => p.id === pending!.id || p.executionId === resumedId,
          ),
        ).toBe(false);
        const current = recovered.events.find(
          (e) => e.kind === "native_session" && e.executionId === resumedId,
        )?.payload.claude as ClaudeRun;
        expect(current.threadId).toBe(prior.threadId);
        expect(current.cwd).toBe(prior.cwd);
        expect(current.fingerprint).toBe(prior.fingerprint);
        expect(current.turnId).not.toBe(prior.turnId);
        const native = readFileSync(join(evidence, "native-events.txt"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(
          native.some(
            (n) =>
              n.type === "spawn" && n.resume && n.session === prior.threadId,
          ),
        ).toBe(true);
        result.recovered_journal = JSON.parse(
          readFileSync(join(current.cwd, "outcome.json"), "utf8"),
        );
        expect((result.recovered_journal as { state: string }).state).toBe(
          "completed",
        );
        checks.push("same-native-session-resumed-and-completed");
      }
    }
    const final = await snapshot();
    result.events = final.events.filter((e) => ids.includes(e.executionId));
    result.turns = final.turns.filter((t) => ids.includes(t.executionId));
    result.final_default = {
      connection: final.settings.defaultConnectionId,
      model: final.settings.defaultModelId,
    };
    expect(result.final_default).toEqual(initialDefault);
    result.observer_after = observe();
    expect(result.observer_after).toEqual(observerBefore);
    checks.push("independent-cli-identity-survived");
    await page.screenshot({ path: join(evidence, "result.png") });
    result.result = "PASS";
  } catch (error) {
    result.result = "FAIL";
    result.error = error instanceof Error ? error.message : String(error);
    try {
      const page = await app?.firstWindow();
      if (page) {
        const reply = await page.evaluate(() =>
          window.desktop.command({ type: "snapshot" }),
        );
        if (reply.ok) {
          result.events = reply.snapshot.events.filter((e) =>
            ids.includes(e.executionId),
          );
          result.turns = reply.snapshot.turns.filter((t) =>
            ids.includes(t.executionId),
          );
          result.tool_operations = reply.snapshot.toolOperations.filter((o) =>
            ids.includes(o.executionId),
          );
        }
      }
      result.observer_on_failure = observe();
    } catch {
      /* The original failure remains the result. */
    }
    throw error;
  } finally {
    save();
    try {
      if (app) {
        await stopClaudeTestTurns(app, root!);
        const child = app.process();
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        }, 5000);
        try {
          await app.close();
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      if (observer) await observer.close();
    }
  }
});
