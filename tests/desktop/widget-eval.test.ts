import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { replayAll, replayFixture, score } from "./widget-eval/evaluate";
import type { Execution } from "./widget-eval/execute";
import { responseServer } from "./widget-eval/execute";
import { streamBody, syntheticFixtures } from "./widget-eval/fixtures";
import {
  attemptCost,
  callUpperBound,
  liveAuthorization,
  redact,
  runLive,
  streamUsage,
  type LiveAuthorization,
} from "./widget-eval/live";
import {
  isStaticRule,
  loadFixtures,
  loadRequirementSet,
  validateRequirementSet,
  type Fixture,
  type RequirementSet,
  type StaticRule,
} from "./widget-eval/model";
import { references } from "./widget-eval/references";
import {
  aggregate,
  buildResult,
  canonicalJson,
  evaluateStaticRule,
  judgeAttempt,
  judgeExecution,
  percentile,
  summary,
  type AttemptRecord,
} from "./widget-eval/score";
import { widgetSubmitToolName } from "../../src/shared/widget-generation-tool";
import type { BuiltWidget } from "../../src/shared/widget";

const { set, sha256 } = loadRequirementSet();
const scratch = () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/widget-eval-test-"));
};
const execution = (over: Partial<Execution>): Execution => ({
  invoked: false,
  argumentsValid: null,
  packageSource: null,
  compile: null,
  taskState: "failed",
  taskError: null,
  candidateDigest: null,
  thrownClass: null,
  durationMs: 10,
  ...over,
});
const response = { kind: "response" } as const;
const build = (over: Partial<BuiltWidget["manifest"]> = {}): BuiltWidget => ({
  format: "csthink-widget-build-1",
  digest: "d".repeat(64),
  manifest: {
    schemaVersion: 1,
    name: "W",
    view: { html: "<p>x</p>", css: "", js: "window.widget.writeData(0, {})" },
    config: [],
    draftFields: [],
    capabilities: ["data.write"],
    resources: [],
    ...over,
  },
  resources: {},
});

test("控件评测：标准需求集版本化、中英文与类别覆盖完整，每条都有参考实现", () => {
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(set.set, "widget-generation-standard");
  assert.equal(set.version, 1);
  assert.equal(set.requirements.length, 13);
  const count = (key: "language", value: string) =>
    set.requirements.filter((r) => r[key] === value).length;
  assert.equal(count("language", "zh"), 7);
  assert.equal(count("language", "en"), 6);
  assert.deepEqual(
    [...new Set(set.requirements.map((r) => r.category))].sort(),
    [
      "chart",
      "config",
      "data",
      "display",
      "form",
      "interactive",
      "timer",
      "todo",
    ],
  );
  assert.deepEqual(
    [...new Set(set.requirements.map((r) => r.difficulty))].sort(),
    [1, 2, 3],
  );
  assert.deepEqual(
    Object.keys(references).sort(),
    set.requirements.map((r) => r.id).sort(),
  );
  for (const r of set.requirements)
    assert.ok(
      r.rules.some((rule) => !isStaticRule(rule)),
      `${r.id} has a rendered rule`,
    );
});

test("控件评测：需求集校验拒绝无法机械判定的规则", () => {
  const base = JSON.parse(JSON.stringify(set)) as RequirementSet;
  const broken = (edit: (s: RequirementSet) => void) => {
    const copy = JSON.parse(JSON.stringify(base)) as RequirementSet;
    edit(copy);
    return () => validateRequirementSet(copy);
  };
  assert.doesNotThrow(broken(() => {}));
  for (const [name, edit] of [
    [
      "duplicate id",
      (s: RequirementSet) => (s.requirements[1].id = s.requirements[0].id),
    ],
    [
      "invalid pattern",
      (s: RequirementSet) =>
        s.requirements[0].rules.push({
          id: "bad",
          check: "text",
          pattern: "(",
        }),
    ],
    [
      "unknown capability",
      (s: RequirementSet) =>
        s.requirements[0].rules.push({
          id: "cap",
          check: "capability",
          capability: "network.fetch",
        }),
    ],
    [
      "interaction without outcome",
      (s: RequirementSet) =>
        s.requirements[0].rules.push({
          id: "blind",
          check: "interaction",
          steps: [{ action: "click", roles: ["button"], name: "开始" }],
        }),
    ],
    [
      "unknown role",
      (s: RequirementSet) =>
        s.requirements[0].rules.push({
          id: "role",
          check: "role",
          roles: ["banner"],
        }),
    ],
    [
      "min above max",
      (s: RequirementSet) =>
        s.requirements[0].rules.push({
          id: "range",
          check: "text",
          pattern: "x",
          min: 2,
          max: 1,
        }),
    ],
    [
      "global flag",
      (s: RequirementSet) =>
        s.requirements[0].rules.push({
          id: "flag",
          check: "text",
          pattern: "x",
          flags: "g",
        }),
    ],
  ] as const)
    assert.throws(broken(edit), /requirement set/, name);
});

test("控件评测：阶段判定按第一个失败阶段给出唯一失败分类", () => {
  const view = (names: string[]) => ({
    calls: names.map((name) => ({ name, argumentBytes: 10 })),
    textChars: 0,
  });
  const check = (
    args: Parameters<typeof judgeExecution>,
    stage: string | null,
    cls: string | null,
  ) => {
    const r = judgeExecution(...args);
    assert.equal(r.failure?.stage ?? null, stage, JSON.stringify(args[1]));
    assert.equal(r.failure?.class ?? null, cls);
  };
  check([{ kind: "timeout" }, null, null], "provider", "timeout");
  check([{ kind: "stopped" }, null, null], "provider", "stopped");
  check(
    [{ kind: "transport", errorClass: "network", message: "x" }, null, null],
    "provider",
    "network",
  );
  check(
    [{ kind: "transport", errorClass: "odd", message: "x" }, null, null],
    "provider",
    "transport_other",
  );
  check(
    [
      response,
      execution({ thrownClass: "rate_limit", taskError: "HTTP 429" }),
      null,
    ],
    "provider",
    "rate_limit",
  );
  check(
    [
      response,
      execution({ taskError: "控件生成已达到本次等待时限。已保留草稿" }),
      view([]),
    ],
    "provider",
    "timeout",
  );
  check(
    [response, execution({ thrownClass: "protocol" }), view([])],
    "submitted",
    "no_submission",
  );
  check(
    [
      response,
      execution({ thrownClass: "protocol" }),
      view([widgetSubmitToolName, widgetSubmitToolName]),
    ],
    "submitted",
    "multiple_submissions",
  );
  check(
    [response, execution({ thrownClass: "permission" }), view(["shell"])],
    "submitted",
    "wrong_tool",
  );
  check(
    [response, execution({ thrownClass: "protocol" }), null],
    "submitted",
    "malformed_tool_call",
  );
  check(
    [
      response,
      execution({ invoked: true, argumentsValid: false }),
      view([widgetSubmitToolName]),
    ],
    "valid",
    "invalid_arguments",
  );
  check(
    [
      response,
      execution({
        invoked: true,
        argumentsValid: true,
        compile: { ok: false, message: "控件包包含缺失或未知字段。" },
        thrownClass: "protocol",
      }),
      view([widgetSubmitToolName]),
    ],
    "compiled",
    "compile_rejected",
  );
  check(
    [
      response,
      execution({
        invoked: true,
        argumentsValid: true,
        compile: { ok: true, digest: "d".repeat(64), build: build() },
        taskState: "completed",
        candidateDigest: "d".repeat(64),
      }),
      view([widgetSubmitToolName]),
    ],
    null,
    null,
  );
  // The executor's acceptance and the observation must agree; a mismatch stops the run.
  assert.throws(
    () =>
      judgeExecution(
        response,
        execution({ taskState: "completed", candidateDigest: "d".repeat(64) }),
        view([]),
      ),
    /pipeline inconsistency/,
  );
  assert.throws(
    () => judgeExecution(response, null, null),
    /needs its execution/,
  );
});

test("控件评测：静态规则、渲染观察与需求满足的判定", () => {
  const requirement = set.requirements.find((r) => r.id === "todo-basic-zh")!;
  const capability = requirement.rules.find(
    (r) => r.id === "declares-data-write",
  )!;
  assert.ok(isStaticRule(capability));
  assert.equal(evaluateStaticRule(capability, build()).pass, true);
  assert.equal(
    evaluateStaticRule(capability, build({ capabilities: [] })).pass,
    false,
  );
  const absent: StaticRule = {
    id: "no-url",
    check: "source",
    files: ["js"],
    pattern: "https?://",
    absent: true,
  };
  assert.equal(evaluateStaticRule(absent, build()).pass, true);
  assert.equal(
    evaluateStaticRule(
      absent,
      build({ view: { html: "", css: "", js: "fetch('https://x')" } }),
    ).pass,
    false,
  );
  assert.equal(
    evaluateStaticRule(
      { id: "c", check: "config", type: "number" },
      build({
        config: [{ id: "step", label: "步长", type: "number", default: 1 }],
      }),
    ).pass,
    true,
  );
  const compiled = judgeExecution(
    response,
    execution({
      invoked: true,
      argumentsValid: true,
      compile: { ok: true, digest: "d".repeat(64), build: build() },
      taskState: "completed",
      candidateDigest: "d".repeat(64),
    }),
    null,
  );
  const ok = {
    loaded: true,
    empty: false,
    errors: [],
    rules: [{ id: "adds-item", pass: true, observed: "" }],
  };
  assert.equal(judgeAttempt(requirement, compiled, build(), ok).failure, null);
  assert.equal(
    judgeAttempt(requirement, compiled, build(), null).stages.rendered,
    null,
  );
  const error = judgeAttempt(requirement, compiled, build(), {
    ...ok,
    errors: ["Uncaught TypeError"],
  });
  assert.equal(error.failure?.class, "render_error");
  assert.equal(error.stages.rendered, false);
  assert.equal(
    judgeAttempt(requirement, compiled, build(), { ...ok, loaded: false })
      .failure?.detail,
    "view did not appear",
  );
  assert.equal(
    judgeAttempt(requirement, compiled, build(), { ...ok, empty: true }).failure
      ?.detail,
    "view rendered no content",
  );
  const unmet = judgeAttempt(
    requirement,
    compiled,
    build({ capabilities: [] }),
    {
      ...ok,
      rules: [{ id: "adds-item", pass: false, observed: "count 0" }],
    },
  );
  assert.equal(unmet.failure?.class, "requirement_unmet");
  assert.equal(unmet.failure?.detail, "declares-data-write, adds-item");
  assert.equal(unmet.stages.rendered, true);
  assert.equal(unmet.stages.satisfied, false);
});

test("控件评测：按提供方与模型分组的漏斗、超时率、失败计数与最近秩分位数", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([1, 2, 3], 90), 3);
  const record = (
    id: string,
    provider: string,
    stages: Partial<Record<string, boolean>>,
    failure: string | null,
    durationMs: number | null,
  ): AttemptRecord => ({
    id,
    requirement: "dice-roller-en",
    language: "en",
    category: "interactive",
    difficulty: 1,
    source: "recorded",
    provider,
    model: "m",
    repeat: 1,
    durationMs,
    firstByteMs: null,
    usage: null,
    candidateDigest: null,
    judgement: {
      stages: {
        provider: null,
        submitted: null,
        valid: null,
        compiled: null,
        rendered: null,
        satisfied: null,
        ...stages,
      },
      failure: failure
        ? { stage: "provider", class: failure as "timeout", detail: null }
        : null,
      staticRules: [],
      renderRules: null,
    },
  });
  const all = {
    provider: true,
    submitted: true,
    valid: true,
    compiled: true,
    rendered: true,
    satisfied: true,
  };
  const attempts = [
    record("a", "p", all, null, 1000),
    record("b", "p", { ...all, satisfied: false }, "requirement_unmet", 3000),
    record("c", "p", { provider: false }, "timeout", 600000),
    record(
      "d",
      "p",
      { provider: true, submitted: false },
      "no_submission",
      null,
    ),
    record("e", "q", all, null, 2000),
  ];
  const [p, q] = aggregate(attempts, true);
  assert.equal(p.provider, "p");
  assert.equal(p.attempts, 4);
  assert.deepEqual(p.funnel.provider, {
    passed: 3,
    rate: 0.75,
    ofPrevious: 0.75,
  });
  assert.deepEqual(p.funnel.submitted, {
    passed: 2,
    rate: 0.5,
    ofPrevious: 0.6667,
  });
  assert.deepEqual(p.funnel.satisfied, {
    passed: 1,
    rate: 0.25,
    ofPrevious: 0.5,
  });
  assert.deepEqual(p.timeouts, { count: 1, rate: 0.25 });
  assert.deepEqual(p.failures, {
    no_submission: 1,
    requirement_unmet: 1,
    timeout: 1,
  });
  assert.deepEqual(p.duration.all, {
    count: 3,
    minMs: 1000,
    p50Ms: 3000,
    p90Ms: 600000,
    maxMs: 600000,
    meanMs: 201333,
  });
  assert.equal(p.duration.compiled.count, 2);
  assert.equal(q.attempts, 1);
  assert.equal(aggregate(attempts, false)[0].funnel.rendered, undefined);
  const result = buildResult({
    mode: "live",
    set,
    setSha256: sha256,
    renderBaseline: [],
    attempts,
  });
  assert.deepEqual(
    result.attempts.map((a) => a.id),
    ["a", "b", "c", "d", "e"],
  );
  const text = summary(result);
  assert.match(text, /\| p \| m \| 4 \| 3 \(75\.0%\)/);
  assert.match(text, /\| p \| m \| timeout \| 1 \|/);
  assert.doesNotMatch(text, /Synthetic fixtures/);
});

/** The static part of a synthetic fixture's declared outcome: rendering does not run here. */
function staticExpectation(id: string) {
  const s = syntheticFixtures().find((f) => f.fixture.id === id)!;
  const requirement = set.requirements.find(
    (r) => r.id === s.fixture.requirement,
  )!;
  if (s.expect.stage === "rendered") return { stage: null, failure: null };
  if (s.expect.stage === "satisfied") {
    const failed = (s.expect.failedRules ?? []).filter((id) =>
      requirement.rules.some((r) => r.id === id && isStaticRule(r)),
    );
    return failed.length
      ? { stage: "satisfied", failure: "requirement_unmet", failed }
      : { stage: null, failure: null };
  }
  return { stage: s.expect.stage, failure: s.expect.failure };
}

test("控件评测：合成夹具经产品执行器回放到声明的阶段与失败分类", async () => {
  const synthetic = syntheticFixtures();
  const executed = await replayAll(
    set,
    synthetic.map((s) => s.fixture),
  );
  const result = score({
    mode: "replay",
    set,
    setSha256: sha256,
    executed,
    renders: null,
  });
  for (const { fixture } of synthetic) {
    const attempt = result.attempts.find((a) => a.id === fixture.id)!;
    const want = staticExpectation(fixture.id);
    const failure = attempt.judgement.failure;
    assert.equal(
      failure?.stage ?? null,
      want.stage,
      `${fixture.id}: ${failure?.detail}`,
    );
    assert.equal(failure?.class ?? null, want.failure, fixture.id);
    if ("failed" in want)
      assert.deepEqual(
        attempt.judgement.staticRules.filter((r) => !r.pass).map((r) => r.id),
        want.failed,
      );
  }
  // Every reference widget compiles and passes all of its static rules.
  for (const a of result.attempts.filter((a) => a.model === "reference")) {
    assert.equal(a.judgement.stages.compiled, true, a.id);
    assert.ok(
      a.judgement.staticRules.every((r) => r.pass),
      a.id,
    );
  }
  assert.equal(result.render, "not-run");
  assert.equal(result.satisfaction, "static-rules-only");
});

test("控件评测：同一夹具两次回放逐字节一致，结果不含时间戳与本机路径；命令行拒绝已有内容的输出目录", async () => {
  const fixtures = syntheticFixtures().map((s) => s.fixture);
  const run = async () => {
    const executed = await replayAll(set, fixtures);
    const result = score({
      mode: "replay",
      set,
      setSha256: sha256,
      executed,
      renders: null,
    });
    return { json: canonicalJson(result), text: summary(result) };
  };
  const first = await run();
  const second = await run();
  assert.equal(first.json, second.json);
  assert.equal(first.text, second.text);
  for (const output of [first.json, first.text]) {
    assert.doesNotMatch(output, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.doesNotMatch(output, /\/Users\/|\/private\/|\/tmp\/|\.test-data/);
    assert.ok(!output.includes(process.cwd()));
  }
  assert.match(
    first.text,
    /Synthetic fixtures only exercise the scoring pipeline/,
  );
  const root = scratch();
  try {
    const cli = (out: string) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/desktop/widget-eval/cli.ts", "--out", out],
        { encoding: "utf8" },
      );
    const a = cli(join(root, "a"));
    assert.equal(a.status, 0, a.stderr);
    assert.equal(
      readFileSync(join(root, "a", "result.json"), "utf8"),
      first.json,
    );
    assert.equal(
      readFileSync(join(root, "a", "summary.md"), "utf8"),
      first.text,
    );
    const again = cli(join(root, "a"));
    assert.equal(again.status, 1);
    assert.match(again.stderr, /must be new or empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const authorization = (over: Partial<LiveAuthorization> = {}) => ({
  task: "widget-generation-evaluation",
  authorized: true,
  evidence: resolve(".test-data/disposable/widget-eval-live-evidence"),
  requirements: ["dice-roller-en"],
  repeats: 1,
  waitMinutes: 5,
  maxCalls: 1,
  stopAfterProviderFailures: 3,
  costLimit: 2,
  selections: [
    {
      provider: "offline",
      baseUrl: "https://provider.invalid/v1",
      model: "offline-model",
      keyEnv: "WIDGET_EVAL_OFFLINE_KEY",
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    },
  ],
  ...over,
});
const env = { WIDGET_EVAL_OFFLINE_KEY: "offline-synthetic-value-0001" };

test("控件评测：真实调用授权在任何请求前完整校验", () => {
  assert.doesNotThrow(() => liveAuthorization(authorization(), "1", env, set));
  for (const [name, value, enabled, environment] of [
    ["switch off", authorization(), undefined, env],
    [
      "other task",
      authorization({
        task: "other-evaluation" as "widget-generation-evaluation",
      }),
      "1",
      env,
    ],
    ["budget mismatch", authorization({ maxCalls: 2 }), "1", env],
    [
      "repeats out of range",
      authorization({ repeats: 6, maxCalls: 6 }),
      "1",
      env,
    ],
    [
      "wait outside the product range",
      authorization({ waitMinutes: 2 }),
      "1",
      env,
    ],
    [
      "unknown requirement",
      authorization({ requirements: ["missing"] }),
      "1",
      env,
    ],
    ["key not set", authorization(), "1", {}],
    ["no cost limit", authorization({ costLimit: 0 }), "1", env],
    [
      "no prices",
      authorization({
        selections: [
          {
            ...authorization().selections[0],
            pricing: { inputPerMillion: 0, outputPerMillion: 1 },
          },
        ],
      }),
      "1",
      env,
    ],
    [
      "plain http",
      authorization({
        selections: [
          {
            ...authorization().selections[0],
            baseUrl: "http://provider.invalid/v1",
          },
        ],
      }),
      "1",
      env,
    ],
    ["relative evidence", authorization({ evidence: "evidence" }), "1", env],
    [
      "duplicate selection",
      authorization({
        maxCalls: 2,
        selections: [
          authorization().selections[0],
          authorization().selections[0],
        ],
      }),
      "1",
      env,
    ],
  ] as const)
    assert.throws(
      () =>
        liveAuthorization(
          value,
          enabled,
          environment as Record<string, string>,
          set,
        ),
      /^Error: NOT RUN/,
      name,
    );
  assert.equal(
    redact(
      "key offline-synthetic-value-0001 and sk-abcdefghijklmnop",
      env.WIDGET_EVAL_OFFLINE_KEY,
    ),
    "key [redacted] and sk-[redacted]",
  );
  // A model output keeps its bytes: only the exact key would be removed from it.
  assert.equal(
    redact("const key-handler-name = 1", env.WIDGET_EVAL_OFFLINE_KEY, false),
    "const key-handler-name = 1",
  );
  assert.deepEqual(
    streamUsage(
      'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":1200,"completion_tokens":800}}\n\n',
    ),
    { promptTokens: 1200, completionTokens: 800 },
  );
  assert.equal(streamUsage("data: [DONE]\n\n"), null);
  const selection = authorization().selections[0];
  const recorded = (usage: Fixture["recorded"]["usage"], body = "") =>
    attemptCost(selection, {
      ...syntheticFixtures()[0].fixture,
      recorded: { ...syntheticFixtures()[0].fixture.recorded, usage },
      response: { status: 200, contentType: "text/event-stream", body },
    });
  // Reported usage is priced exactly: 1,000 input at 1 and 2,000 output at 2 per million.
  assert.equal(
    recorded({ promptTokens: 1000, completionTokens: 2000 }).cost,
    0.005,
  );
  assert.equal(recorded(null).basis, "assumed");
  assert.equal(recorded(null).cost, callUpperBound(selection));
  assert.equal(recorded(null, "x".repeat(90_000)).completionTokens, 30_000);
});

test("控件评测：真实调用经录制转发只发一次请求，录制可回放到同一判定且不含密钥", async () => {
  const key = env.WIDGET_EVAL_OFFLINE_KEY;
  const body = streamBody({
    calls: [
      {
        name: widgetSubmitToolName,
        arguments: JSON.stringify({
          package: JSON.stringify(references["dice-roller-en"]),
        }),
      },
    ],
  });
  const seen: string[] = [];
  // A local stand-in for a provider: checks the key, answers once, and echoes the key on refusal.
  const upstream = createServer((req, res) => {
    seen.push(String(req.headers.authorization));
    req.resume();
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${req.headers.authorization}`,
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body);
    });
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  try {
    const run = async (keyValue: string) => {
      const auth = liveAuthorization(
        authorization({
          selections: [{ ...authorization().selections[0], baseUrl }],
        }),
        "1",
        { WIDGET_EVAL_OFFLINE_KEY: keyValue },
        set,
      );
      const calls: number[] = [];
      const fixtures: Fixture[] = [];
      const { executed, skipped } = await runLive(
        auth,
        set,
        { WIDGET_EVAL_OFFLINE_KEY: keyValue },
        {
          beforeCall: (n) => calls.push(n),
          onAttempt: (f) => fixtures.push(f),
        },
      );
      return { calls, fixtures, executed, skipped };
    };
    const good = await run(key);
    assert.deepEqual(good.calls, [1]);
    assert.equal(seen.length, 1);
    const [fixture] = good.fixtures;
    assert.equal(fixture.id, "offline.offline-model.dice-roller-en.r1");
    assert.equal(fixture.source, "recorded");
    assert.equal(fixture.response?.body, body);
    assert.equal(good.executed[0].product.failure, null);
    assert.ok(!JSON.stringify(good.fixtures).includes(key));
    const replayed = await replayFixture(set, fixture);
    assert.deepEqual(replayed.product, good.executed[0].product);

    const refused = await run("wrong-synthetic-value-0002");
    assert.equal(refused.executed[0].product.failure?.class, "auth");
    const recorded =
      JSON.stringify(refused.fixtures) +
      JSON.stringify(refused.executed.map((e) => e.execution));
    assert.ok(!recorded.includes("wrong-synthetic-value-0002"));
    assert.match(refused.fixtures[0].response!.body, /\[redacted\]/);
    assert.deepEqual(
      (await replayFixture(set, refused.fixtures[0])).product,
      refused.executed[0].product,
    );
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

test("控件评测：同一选择连续在提供方阶段失败达到上限后，其余尝试不再发送并记为跳过", async () => {
  assert.throws(
    () =>
      liveAuthorization(
        authorization({ stopAfterProviderFailures: 0 }),
        "1",
        env,
        set,
      ),
    /NOT RUN/,
  );
  let requests = 0;
  const upstream = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":{"message":"service unavailable"}}');
    });
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  try {
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    const auth = liveAuthorization(
      authorization({
        repeats: 5,
        maxCalls: 5,
        stopAfterProviderFailures: 2,
        selections: [{ ...authorization().selections[0], baseUrl }],
      }),
      "1",
      env,
      set,
    );
    const sent: number[] = [];
    const { executed, skipped } = await runLive(auth, set, env, {
      beforeCall: (n) => sent.push(n),
      onAttempt: () => {},
    });
    assert.deepEqual(sent, [1, 2]);
    assert.equal(requests, 2);
    assert.deepEqual(
      executed.map((e) => e.product.failure?.stage),
      ["provider", "provider"],
    );
    assert.deepEqual(
      skipped.map((s) => s.repeat),
      [3, 4, 5],
    );
    // The cost guard: with no reported usage each call counts at least the assumed upper bound,
    // so a limit of one and a half calls lets exactly one call through.
    const perCall = callUpperBound(auth.selections[0]);
    const limited = liveAuthorization(
      authorization({
        repeats: 3,
        maxCalls: 3,
        stopAfterProviderFailures: 5,
        costLimit: perCall * 1.5,
        selections: [{ ...authorization().selections[0], baseUrl }],
      }),
      "1",
      env,
      set,
    );
    const before = requests;
    const guarded = await runLive(limited, set, env, {
      beforeCall: () => {},
      onAttempt: () => {},
    });
    assert.equal(requests - before, 1);
    assert.equal(guarded.costs.length, 1);
    assert.equal(guarded.costs[0].basis, "assumed");
    assert.ok(guarded.spent >= perCall);
    assert.deepEqual(
      guarded.skipped.map((s) => s.repeat),
      [2, 3],
    );
    assert.match(guarded.skipped[0].reason, /would pass the limit/);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});

test("控件评测：回放服务按录制状态原样重现提供方响应；录制夹具目录逐个校验", async () => {
  const root = scratch();
  try {
    const server = await responseServer({
      status: 429,
      contentType: "application/json",
      body: '{"error":{"message":"slow down"}}',
    });
    const reply = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(reply.status, 429);
    assert.equal(await reply.text(), '{"error":{"message":"slow down"}}');
    assert.equal(server.requests, 1);
    await server.close();
    const [first] = syntheticFixtures();
    writeFileSync(join(root, "a.json"), canonicalJson(first.fixture));
    assert.deepEqual(loadFixtures(root), [first.fixture]);
    writeFileSync(join(root, "b.json"), "{}");
    assert.throws(() => loadFixtures(root), /invalid fixture b\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
