import { goTo } from "./shell";
import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { launchReal, shutdownReal, type RealClient } from "./real-client";
import { providersPage } from "./provider-ui";
import { terminalStates, type Snapshot } from "../../src/shared/protocol";
import type { CodexRun } from "../../src/shared/codex";

const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const evidenceRoot = process.env.CSTHINK_REAL_EVIDENCE_ROOT;
const continuation = process.env.CSTHINK_REAL_CONTINUE_FROM;
const authorized =
  process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1" &&
  process.env.CSTHINK_REAL_TASK === "feature-t6";
test.skip(
  !root || !evidence || !authorized,
  "feature-t6 requires its recorded real-call authorization and explicit data/evidence directories",
);
test.setTimeout(1_200_000);
test.use({ trace: "off", actionTimeout: 30_000 });
const model = "gpt-6-astra";
const rule = {
  path: join(homedir(), ".codex/AGENTS.md"),
  sha256: "53733c85a7afd4517385a1c70223b6b0354269650a05331285781d02b4ce5420",
};

/** Inspector instrumentation is test-owned and never enters the product build.
 * Observe only owned restricted app-server processes, excluding the loopback capability verifier.
 * Record method/identity/marker presence only. Faults use turn/interrupt, or a documented
 * unknown-history response injection; credentials and raw protocol payloads are never recorded.
 */
function observerSource(counter: string) {
  return `(() => {
    const cp=process.mainModule.require('node:child_process');
    const fs=process.mainModule.require('node:fs');
    const original=cp.spawn;
    const state=globalThis.t6={calls:[],outboundMarkers:[],marker:'',fault:'',unknownInjected:false,interrupted:false};
    const counter=${JSON.stringify(counter)};
    cp.spawn=function(file,args,options){
      const child=original.apply(this,arguments);
      if(!Array.isArray(args)||!args.includes('app-server')||!args.includes('default_permissions="csthink_assistant"')||args.some(a=>a.startsWith('model_providers.csthink_contract='))) return child;
      const requests=new Map(); let input='';
      const write=child.stdin.write.bind(child.stdin);
      child.stdin.write=function(chunk,...rest){
        const text=String(chunk); input+=text;
        let end;
        while((end=input.indexOf('\\n'))>=0){
          const line=input.slice(0,end);input=input.slice(end+1);
          let m;try{m=JSON.parse(line);}catch{continue;}
          if(m.method)requests.set(m.id,m.method);
          if(m.method==='turn/start'){
            const budget=JSON.parse(fs.readFileSync(counter,'utf8'));
            if(budget.turns>=8||Date.now()-budget.startedAt>1200000)throw new Error('Authorized Codex test budget exhausted');
            budget.turns++;fs.writeFileSync(counter,JSON.stringify(budget));
          }
          state.calls.push({direction:'out',method:m.method||'tool-result',threadId:m.params?.threadId,turnId:m.params?.turnId});
          if(state.marker&&text.includes(state.marker))state.outboundMarkers.push({method:m.method||'tool-result',present:true});
        }
        return write(chunk,...rest);
      };
      const emit=child.stdout.emit.bind(child.stdout);let output='';
      child.stdout.emit=function(event,chunk,...rest){
        if(event!=='data')return emit(event,chunk,...rest);
        output+=String(chunk);let end;let forwarded='';
        while((end=output.indexOf('\\n'))>=0){
          const line=output.slice(0,end);output=output.slice(end+1);
          let m;try{m=JSON.parse(line);}catch{forwarded+=line+'\\n';continue;}
          if(m.method)state.calls.push({direction:'in',method:m.method,threadId:m.params?.threadId,turnId:m.params?.turnId});
          if(state.fault==='unknown'&&requests.get(m.id)==='thread/resume'&&Array.isArray(m.result?.thread?.turns)){
            for(const t of m.result.thread.turns)t.status='inProgress';
            state.unknownInjected=true;state.fault='';
          }
          if(state.fault==='interrupt'&&m.method==='item/agentMessage/delta'){
            state.fault='';state.interrupted=true;
            write(JSON.stringify({id:'t6-fault-interrupt',method:'turn/interrupt',params:{threadId:m.params.threadId,turnId:m.params.turnId}})+'\\n');
          }
          forwarded+=JSON.stringify(m)+'\\n';
        }
        return forwarded ? emit(event,Buffer.from(forwarded),...rest) : true;
      };
      return child;
    };
    return true;
  })()`;
}

test("real codex: settings test, material consent, native failure recovery, unknown-result guard and stop isolation", async () => {
  if (!evidenceRoot)
    throw Error("CSTHINK_REAL_EVIDENCE_ROOT must name the evidence directory");
  mkdirSync(evidence!, { recursive: true });
  const priorContinuation =
    continuation && existsSync(join(continuation, "continuation.json"))
      ? JSON.parse(
          readFileSync(join(continuation, "continuation.json"), "utf8"),
        )
      : undefined;
  const counter =
    priorContinuation?.budget || join(continuation || evidence!, "budget.json");
  let skipped: string[] = [];
  // Deliberately refuse rerunning a spent suite. A follow-up must inspect the preserved evidence.
  if (continuation) {
    const previous = JSON.parse(
      readFileSync(join(continuation, "result.json"), "utf8"),
    );
    expect(previous.result).toBe("FAIL");
    skipped = [
      ...(priorContinuation?.skip || []),
      ...previous.checks.map((c: { name: string }) => c.name),
    ];
    expect(skipped).toEqual([
      "settings-model-test",
      ...(priorContinuation ? ["question-answer"] : []),
      ...(previous.checks.some(
        (c: { name: string }) => c.name === "material-allowed",
      )
        ? ["material-allowed"]
        : []),
    ]);
    expect(JSON.parse(readFileSync(counter, "utf8")).turns).toBe(
      skipped.includes("material-allowed") ? 4 : priorContinuation ? 2 : 1,
    );
    writeFileSync(
      join(evidence!, "continuation.json"),
      JSON.stringify({
        from: continuation,
        budget: counter,
        skip: skipped,
      }),
      { flag: "wx" },
    );
  } else {
    writeFileSync(
      counter,
      JSON.stringify({ startedAt: Date.now(), turns: 0 }),
      { flag: "wx" },
    );
  }
  const initialBudget = JSON.parse(readFileSync(counter, "utf8"));
  test.setTimeout(
    Math.max(1, 1_200_000 - (Date.now() - initialBudget.startedAt)),
  );
  const expectedTotal =
    initialBudget.turns +
    (skipped.includes("material-allowed")
      ? 4
      : skipped.includes("question-answer")
        ? 5
        : skipped.length
          ? 6
          : 7);
  expect(expectedTotal).toBeLessThanOrEqual(8);
  expect(
    createHash("sha256").update(readFileSync(rule.path)).digest("hex"),
  ).toBe(rule.sha256);
  const record: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    model,
    checks: [],
    result: "NOT RUN",
    faults:
      "Owned native turn interrupted after real delta; unknown-history response injected only for retry guard",
  };
  let client: RealClient | undefined;
  let spectator: ChildProcess | undefined;
  const save = () =>
    writeFileSync(
      join(evidence!, "result.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
  try {
    client = await launchReal(root!);
    const page = client.page;
    const snapshot = () =>
      page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw new Error(r.message);
        return r.snapshot;
      });
    const check = (name: string, value: unknown) => {
      (record.checks as unknown[]).push({ name, value });
      save();
    };
    await client.mainEval(observerSource(counter));
    await providersPage(page);
    await page
      .getByRole("button", { name: "打开提供方 Codex", exact: true })
      .click();
    const section = page.getByRole("region", { name: "Codex 连接" });
    const detected = await page.evaluate(() => window.desktop.detectCodex());
    expect(detected.installation).toBeTruthy();
    expect(detected.authentication).toBe("chatgpt");
    expect(detected.models).toContain(model);
    record.installation = detected.installation;
    if (!continuation) {
      await section
        .getByRole("button", { name: `选择 Codex 模型 ${model}`, exact: true })
        .click();
      const setup = page.getByRole("region", { name: "确认 Codex 连接" });
      await expect(setup).toBeVisible({ timeout: 180_000 });
      await expect(setup).toContainText("https://chatgpt.com/backend-api/");
      await expect(setup).toContainText(rule.sha256);
      await setup.getByRole("checkbox").click();
      await setup
        .getByRole("button", { name: "确认配置 Codex", exact: true })
        .click();
      await expect(section.getByText("已配置", { exact: true })).toBeVisible({
        timeout: 180_000,
      });
    }
    const connection = (await snapshot()).connections.find(
      (c) => c.provider === "codex",
    )!;
    expect(connection.codex?.provider).toBe("openai");
    expect(connection.codex?.authentication).toBe("chatgpt");
    expect(connection.codex?.endpoint).toBe("https://chatgpt.com/backend-api/");
    expect(connection.codex?.instructions).toEqual([rule]);
    expect(connection.codex?.configurationInstructions).toEqual([]);
    expect(connection.codex).toEqual(
      JSON.parse(
        readFileSync(
          join(evidenceRoot, "feature-t6/s03-local-prepare-r1/result.json"),
          "utf8",
        ),
      ).configuration,
    );
    record.origin = connection.codex;
    save();
    const spectatorHome = mkdtempSync(join(tmpdir(), "t6-spectator-"));
    mkdirSync(join(spectatorHome, "codex"));
    spectator = spawn(detected.installation!.resolvedPath, ["app-server"], {
      cwd: spectatorHome,
      env: {
        HOME: spectatorHome,
        CODEX_HOME: join(spectatorHome, "codex"),
        PATH: "/usr/bin:/bin",
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const alive = () => {
      expect(spectator!.exitCode).toBeNull();
      expect(spectator!.signalCode).toBeNull();
    };
    await new Promise((resolve) => setTimeout(resolve, 500));
    alive();
    if (!continuation) {
      await section
        .getByRole("button", { name: "模型测试", exact: true })
        .click();
      await expect(
        section.getByText("模型测试成功", { exact: true }),
      ).toBeVisible({ timeout: 180_000 });
      expect(JSON.parse(readFileSync(counter, "utf8")).turns).toBe(1);
      check(
        "settings-model-test",
        (await snapshot()).connections
          .find((c) => c.provider === "codex")!
          .models.find((m) => m.model === model)!.lastTest,
      );
    }
    await page.screenshot({ path: join(evidence!, "settings.png") });
    alive();
    if (
      (await snapshot()).settings.defaultConnectionId !== connection.id ||
      (await snapshot()).settings.defaultModelId !== model
    ) {
      await section
        .getByRole("button", { name: "设为默认模型", exact: true })
        .click();
    }
    await expect(
      section.getByRole("button", { name: "当前默认模型", exact: true }),
    ).toBeVisible();
    async function newConversation() {
      await goTo(page, "聊天");
      await page
        .getByRole("button", { name: /^新建(聊天|对话)$/ })
        .first()
        .click();
    }
    async function submit(text: string, tools = false) {
      const before = (await snapshot()).turns.map((t) => t.id);
      await page.getByRole("textbox", { name: "输入草稿" }).fill(text);
      await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
      if (tools) {
        await page.evaluate(
          async ({ id, model, text }) => {
            const s = await window.desktop.command({ type: "snapshot" });
            if (!s.ok) throw new Error(s.message);
            const r = await window.desktop.command({
              type: "submitTurn",
              requestId: crypto.randomUUID(),
              conversationId: s.snapshot.selected.main!,
              connectionId: id,
              model,
              text,
              materialMode: "tools",
            });
            if (!r.ok) throw new Error(r.message);
          },
          { id: connection.id, model, text },
        );
      } else
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .click();
      await expect
        .poll(async () =>
          (await snapshot()).turns.some((t) => !before.includes(t.id)),
        )
        .toBe(true);
      return (await snapshot()).turns.find((t) => !before.includes(t.id))!.id;
    }
    async function terminal(id: string) {
      await expect
        .poll(
          async () =>
            terminalStates.includes(
              (await snapshot()).turns.find((t) => t.id === id)!.state,
            ),
          { timeout: 180_000 },
        )
        .toBe(true);
      return (await snapshot()).turns.find((t) => t.id === id)!;
    }
    const native = (state: Snapshot, id: string) =>
      state.events.find(
        (e) =>
          e.executionId === id &&
          e.kind === "native_session" &&
          e.payload.codex,
      )?.payload.codex as CodexRun;
    let id: string;
    if (!skipped.includes("question-answer")) {
      await newConversation();
      id = await submit("这是一条独立功能测试。请只回复：2 加 3 等于 5。");
      expect((await terminal(id)).state).toBe("completed");
      await expect(
        page.getByRole("article", { name: "助手消息" }),
      ).toContainText("5");
      check(
        "question-answer",
        (await snapshot()).turns.find((t) => t.id === id),
      );
    }
    for (const allow of [true, false]) {
      if (allow && skipped.includes("material-allowed")) continue;
      await newConversation();
      const marker = "T6_" + randomUUID().replaceAll("-", "");
      const file = join(
        evidence!,
        allow ? "allowed-material.txt" : "denied-material.txt",
      );
      writeFileSync(file, marker);
      await client.mainEval(
        `globalThis.t6.marker=${JSON.stringify(marker)};globalThis.t6.outboundMarkers=[];true`,
      );
      await client.pickFiles([file]);
      await page.getByRole("button", { name: "添加资料", exact: true }).click();
      await expect
        .poll(async () => (await snapshot()).draftAttachments.length)
        .toBe(1);
      await expect(
        page
          .getByRole("listitem", {
            name: `资料 ${allow ? "allowed-material.txt" : "denied-material.txt"}`,
          })
          .getByRole("status"),
      ).toHaveText(`${marker.length} 字符`, { timeout: 35_000 });
      id = await submit(
        "请调用 read_selected_material 读取本次选择的资料。只返回其中的标记。如果用户拒绝，则简短说明无法读取，不要猜测，也不要再次请求。",
        true,
      );
      await page
        .getByRole("button", { name: "到待处理确认资料读取", exact: true })
        .click({ timeout: 180_000 });
      await expect(
        page.getByRole("button", { name: "允许本次读取", exact: true }),
      ).toBeVisible();
      expect(await client.mainEval("globalThis.t6.outboundMarkers")).toEqual(
        [],
      );
      await page
        .getByRole("button", {
          name: allow ? "允许本次读取" : "拒绝读取",
          exact: true,
        })
        .click();
      const materialTurn = await terminal(id);
      expect(materialTurn.state).toBe(allow ? "completed" : "failed");
      if (!allow) expect(materialTurn.errorClass).toBe("permission");
      const state = await snapshot();
      const operation = state.toolOperations.find(
        (o) =>
          o.executionId === state.turns.find((t) => t.id === id)!.executionId,
      )!;
      expect(operation.state).toBe(allow ? "completed" : "denied");
      const sent = (await client.mainEval(
        "globalThis.t6.outboundMarkers",
      )) as unknown[];
      expect(sent.length > 0).toBe(allow);
      await goTo(page, "聊天");
      if (allow)
        await expect(
          page.getByRole("article", { name: "助手消息" }),
        ).toContainText(marker);
      check(allow ? "material-allowed" : "material-denied", {
        operation,
        outboundMarker: sent.length > 0,
      });
      alive();
    }
    await newConversation();
    await client.mainEval("globalThis.t6.fault='interrupt';true");
    id = await submit(
      "这是流式中断测试。请立即输出 START，然后逐行写出 1 到 500 的整数，每行一条短中文说明，不使用任何工具。",
    );
    const failed = await terminal(id);
    expect(failed.state).toBe("failed");
    const before = await snapshot();
    const original = native(before, failed.executionId!);
    expect(original.turnId).toBeTruthy();
    check("partial-output-failure", {
      turn: failed,
      run: original,
      partial: before.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content),
    });
    expect(await client.mainEval("globalThis.t6.interrupted")).toBe(true);
    const spent = JSON.parse(readFileSync(counter, "utf8")).turns;
    await client.mainEval("globalThis.t6.fault='unknown';true");
    async function retry() {
      const item = (await snapshot()).pendingItems.find(
        (p) =>
          p.turnId === id &&
          (p.kind === "failed_turn" || p.kind === "interrupted_turn"),
      )!;
      expect(item).toBeTruthy();
      await page.evaluate(async (id) => {
        const r = await window.desktop.command({
          type: "resolvePending",
          id,
          action: "retry",
        });
        if (!r.ok) throw new Error(r.message);
      }, item.id);
      await expect
        .poll(async () => (await snapshot()).activeTurns.length, {
          timeout: 180_000,
        })
        .toBe(0);
    }
    await retry();
    expect(await client.mainEval("globalThis.t6.unknownInjected")).toBe(true);
    expect(JSON.parse(readFileSync(counter, "utf8")).turns).toBe(spent);
    check("unknown-result-guard", {
      faultInjected: true,
      additionalModelTurns: 0,
    });
    await retry();
    const resumed = (await snapshot()).turns.find((t) => t.id === id)!;
    expect(resumed.state).toBe("completed");
    expect(native(await snapshot(), resumed.executionId!).threadId).toBe(
      original.threadId,
    );
    check("same-native-thread-recovery", {
      original,
      resumed: native(await snapshot(), resumed.executionId!),
    });
    alive();
    await newConversation();
    id = await submit(
      "这是停止测试。请马上输出 START，然后逐行写出 1 到 500 的整数，每行附一条短中文说明，不使用工具。",
    );
    await expect(
      page.getByTestId(`turn-${id}`).locator("p").first(),
    ).toContainText("START", { timeout: 180_000 });
    await page.getByRole("button", { name: "停止回合", exact: true }).click();
    expect((await terminal(id)).state).toBe("stopped");
    alive();
    check("native-stop-spectator-alive", {
      turn: (await snapshot()).turns.find((t) => t.id === id),
      spectatorPid: spectator.pid,
    });
    await page.screenshot({ path: join(evidence!, "stopped.png") });
    expect(JSON.parse(readFileSync(counter, "utf8")).turns).toBe(expectedTotal);
    record.result = "PASS";
  } catch (error) {
    record.result = "FAIL";
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (client) {
      await client.page
        .evaluate(async () => {
          const s = await window.desktop.command({ type: "snapshot" });
          if (!s.ok) return;
          const ids = new Set(s.snapshot.activeTurns.map((t) => t.executionId));
          for (const c of s.snapshot.connections)
            for (const m of c.models)
              if (
                m.lastTest &&
                !["completed", "failed", "stopped", "interrupted"].includes(
                  m.lastTest.state,
                )
              )
                ids.add(m.lastTest.executionId);
          await Promise.all(
            [...ids].map((executionId) =>
              window.desktop.command({ type: "stopExecution", executionId }),
            ),
          );
        })
        .catch(() => {});
      await expect
        .poll(
          async () =>
            client!.page.evaluate(async () => {
              const s = await window.desktop.command({ type: "snapshot" });
              return s.ok ? s.snapshot.activeTurns.length : -1;
            }),
          { timeout: 15_000 },
        )
        .toBe(0)
        .catch(() => {
          record.cleanup =
            "Unconfirmed stop; inspect preserved native execution before another test";
        });
    }
    if (client)
      record.protocol = await client
        .mainEval(
          "({calls:globalThis.t6?.calls,unknownInjected:globalThis.t6?.unknownInjected,interrupted:globalThis.t6?.interrupted,outboundMarkers:globalThis.t6?.outboundMarkers})",
        )
        .catch(() => null);
    record.budget = JSON.parse(readFileSync(counter, "utf8"));
    record.finishedAt = new Date().toISOString();
    save();
    await shutdownReal(client, true);
    if (spectator?.exitCode === null) spectator.kill("SIGTERM");
  }
});
