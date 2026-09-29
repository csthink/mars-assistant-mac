import { goTo } from "./shell";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { launchReal, shutdownReal, type RealClient } from "./real-client";

const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const evidenceRoot = process.env.CSTHINK_REAL_EVIDENCE_ROOT;
test.skip(
  !root ||
    !evidence ||
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    process.env.CSTHINK_REAL_TASK !== "feature-t6" ||
    process.env.CSTHINK_REAL_STOP_AUTHORIZED !== "1",
  "OD-54 requires separate explicit authorization for one stop-only real turn",
);
test.setTimeout(180_000);
test.use({ trace: "off", actionTimeout: 30_000 });

test("real codex: one authorized stop-only turn preserves the independent Codex process", async () => {
  if (!evidenceRoot)
    throw Error("CSTHINK_REAL_EVIDENCE_ROOT must name the evidence directory");
  mkdirSync(evidence!, { recursive: true });
  const counter = join(evidence!, "budget.json");
  writeFileSync(
    counter,
    JSON.stringify({ startedAt: Date.now(), turns: 0, maximumTurns: 1 }),
    { flag: "wx" },
  );
  const origin = JSON.parse(
    readFileSync(join(evidenceRoot, "feature-t6/real-r1/result.json"), "utf8"),
  ).origin;
  for (const instruction of origin.instructions)
    expect(
      createHash("sha256").update(readFileSync(instruction.path)).digest("hex"),
    ).toBe(instruction.sha256);
  const result: Record<string, unknown> = {
    result: "NOT RUN",
    origin,
    scenario: "OD-54 stop-only; one native turn, three minutes",
  };
  let client: RealClient | undefined;
  let spectator: ChildProcess | undefined;
  let executionId: string | undefined;
  try {
    client = await launchReal(root!);
    const page = client.page;
    const snapshot = () =>
      page.evaluate(async () => {
        const reply = await window.desktop.command({ type: "snapshot" });
        if (!reply.ok) throw Error(reply.message);
        return reply.snapshot;
      });
    await client.mainEval(`(() => {
      const cp=process.mainModule.require('node:child_process'),fs=process.mainModule.require('node:fs');
      const original=cp.spawn, counter=${JSON.stringify(counter)};
      globalThis.t6Stop={interrupts:0};
      cp.spawn=function(file,args,options){
        const child=original.apply(this,arguments);
        if(!Array.isArray(args)||!args.includes('app-server')||!args.includes('default_permissions="csthink_assistant"')||args.some(a=>a.startsWith('model_providers.csthink_contract=')))return child;
        const write=child.stdin.write.bind(child.stdin);let input='';
        child.stdin.write=function(chunk,...rest){
          input+=String(chunk);let end;
          while((end=input.indexOf('\\n'))>=0){
            const line=input.slice(0,end);input=input.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}
            if(m.method==='turn/start'){
              const b=JSON.parse(fs.readFileSync(counter,'utf8'));
              if(b.turns>=1||Date.now()-b.startedAt>=180000)throw Error('OD-54 budget exhausted');
              b.turns++;fs.writeFileSync(counter,JSON.stringify(b));
            }
            if(m.method==='turn/interrupt')globalThis.t6Stop.interrupts++;
          }
          return write(chunk,...rest);
        };return child;
      };return true;
    })()`);
    const detected = await page.evaluate(() => window.desktop.detectCodex());
    expect(detected.installation).toBeTruthy();
    const before = await snapshot();
    expect(before.activeTurns).toEqual([]);
    const connection = before.connections.find((c) => c.provider === "codex")!;
    expect(connection.codex).toEqual(origin);
    expect(connection.model).toBe("gpt-6-astra");
    expect(before.settings.defaultConnectionId).toBe(connection.id);
    expect(before.settings.defaultModelId).toBe(connection.model);
    const isolated = mkdtempSync(join(tmpdir(), "t6-stop-spectator-"));
    mkdirSync(join(isolated, "codex"));
    spectator = spawn(detected.installation!.resolvedPath, ["app-server"], {
      cwd: isolated,
      env: {
        HOME: isolated,
        CODEX_HOME: join(isolated, "codex"),
        PATH: "/usr/bin:/bin",
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const alive = () => {
      expect(spectator!.exitCode).toBeNull();
      expect(spectator!.signalCode).toBeNull();
    };
    alive();
    await goTo(page, "聊天");
    await page
      .getByRole("button", { name: /^新建(聊天|对话)$/ })
      .first()
      .click();
    await page
      .getByRole("textbox", { name: "输入草稿" })
      .fill(
        "这是停止按钮验收。请立即输出 START，然后逐行写出 1 到 500 的整数，每行一条中文短说明，不使用工具。",
      );
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect
      .poll(async () => (await snapshot()).activeTurns.length)
      .toBe(1);
    const turn = (await snapshot()).activeTurns[0];
    executionId = turn.executionId;
    await expect(
      page.getByTestId(`turn-${turn.id}`).locator("p").first(),
    ).toContainText("START", { timeout: 90_000 });
    await page.getByRole("button", { name: "停止回合", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await snapshot()).turns.find((t) => t.id === turn.id)!.state,
        { timeout: 45_000 },
      )
      .toBe("stopped");
    alive();
    const state = await snapshot();
    result.turn = state.turns.find((t) => t.id === turn.id);
    result.native = state.events.filter(
      (e) => e.executionId === executionId && e.kind === "native_session",
    );
    result.spectator = {
      pid: spectator.pid,
      aliveBefore: true,
      aliveAfter: true,
    };
    result.observer = await client.mainEval("globalThis.t6Stop");
    expect(JSON.parse(readFileSync(counter, "utf8")).turns).toBe(1);
    await page.screenshot({ path: join(evidence!, "stopped.png") });
    result.result = "PASS";
  } catch (error) {
    result.result = "FAIL";
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (client && executionId) {
      await client.page
        .evaluate(
          async (executionId) =>
            window.desktop.command({ type: "stopExecution", executionId }),
          executionId,
        )
        .catch(() => {});
      await expect
        .poll(
          async () =>
            client!.page.evaluate(async () => {
              const reply = await window.desktop.command({ type: "snapshot" });
              return reply.ok ? reply.snapshot.activeTurns.length : -1;
            }),
          { timeout: 15_000 },
        )
        .toBe(0)
        .catch(() => {
          result.cleanup =
            "Unconfirmed stop; inspect before any further real call";
        });
    }
    result.budget = JSON.parse(readFileSync(counter, "utf8"));
    result.finishedAt = new Date().toISOString();
    writeFileSync(
      join(evidence!, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    await shutdownReal(client, true);
    if (spectator?.exitCode === null) spectator.kill("SIGTERM");
  }
});
