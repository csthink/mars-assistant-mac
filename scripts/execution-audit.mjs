// Physical execution audit (feature-t30 S-05, LOG-01 "审计以它们与协议输出逐项相等为通过条件").
// For every Host execution record it validates the Contract 0.1.0 `PhysicalExecution`
// projection and the shared `ExecutionRecord` seqs with the frozen schema.json, binds the
// Host evidence to the record by digest (result.json ← resultRef, transcript.ndjson ←
// result.json), then recomputes each accounting field from its own source and compares:
//   toolCalls        ← the transcript's tool-call entries (Claude tool_use blocks, Codex commandExecution items)
//   outputBytes      ← the sum of every transcript entry's `bytes` (stdout lines, stderr chunks, the tail, the omitted entry)
//   runSeconds       ← result.json timeline (release to exit, rounded as the port rounds)
//   waited           ← result.json targetExit (the exit status the parent obtained)
//   pidGoneAfterExit ← result.json exitProbe (the observer's post-exit classification)
// The stop reason must agree with the budget it names, the cancel time or the signal ledger,
// and a native budget result (error_max_budget_usd) must be a BUDGET_EXCEEDED failure that
// kept the turn's read-back. Any inequality fails the audit.
// Usage:
//   node scripts/execution-audit.mjs --data-root <dir> [--execution <ref>] [--out <report.json>]
//   node scripts/execution-audit.mjs --record <file.json> [--evidence-root <dir>] [--shared <dir>] [--out <report.json>]
// `--data-root` reads <dir>/state.sqlite read-only (the business data root of a client) and
// finds the evidence beside it (<dir>-executions/evidence) and the shared record under the
// resource's Git common directory; `--record` takes one HostExecutionRecord (or an array) as
// JSON. Exit code 0 when every execution passes, 1 when any check fails, 2 on usage errors.
// No network, no application, nothing is written except the optional report.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = join(repo, "contract/0.1.0");
const schemaBytes = readFileSync(join(contractDir, "schema.json"));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ajv = new Ajv({ allErrors: true, jsonPointers: true });
ajv.addSchema(schema);
const validators = Object.fromEntries(
  ["PhysicalExecution", "ExecutionRecord"].map((name) => [
    name,
    ajv.compile({ $ref: schema.$id + "#/definitions/" + name }),
  ]),
);
const describe = (validate) =>
  JSON.stringify(validate.errors ?? []).slice(0, 400);
/** The Contract projection of a Host record: exactly the PhysicalExecution properties. */
const physicalKeys = schema.definitions.PhysicalExecution.required;
const gone = (state) => state === "ABSENT" || state === "IDENTITY_CONFLICT";
/** The request id as a path segment, as src/main/execution-record.ts derives it. */
function recordSegment(id) {
  const segment = String(id)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 200);
  if (!segment || segment === "." || segment === "..")
    throw new Error("id yields no path segment: " + id);
  return segment;
}
/** The Git common directory of a path (a worktree's gitdir file and its commondir followed), or null. */
function gitCommonDir(path) {
  let current;
  try {
    current = realpathSync(path);
  } catch {
    return null;
  }
  for (;;) {
    const marker = join(current, ".git");
    let kind;
    try {
      const info = lstatSync(marker);
      kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
    } catch {
      kind = null;
    }
    if (kind) {
      let gitDir = marker;
      if (kind === "file") {
        const text = readFileSync(marker, "utf8").trim();
        if (!text.startsWith("gitdir:")) return null;
        const target = text.slice("gitdir:".length).trim();
        gitDir = isAbsolute(target) ? target : resolve(current, target);
      }
      const commonFile = join(gitDir, "commondir");
      if (existsSync(commonFile)) {
        const target = readFileSync(commonFile, "utf8").trim();
        gitDir = isAbsolute(target) ? target : resolve(gitDir, target);
      }
      try {
        return realpathSync(gitDir);
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
/** Key-order-independent JSON equality (the result document is canonical, the record keeps insertion order). */
const canonical = (value) => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};
const deepEqual = (a, b) => canonical(a) === canonical(b);

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataRoot = option("--data-root");
const recordFile = option("--record");
const outPath = option("--out");
if ((!dataRoot && !recordFile) || (dataRoot && recordFile)) {
  console.error(
    "usage: node scripts/execution-audit.mjs --data-root <dir> [--execution <ref>] [--out <report.json>]\n" +
      "       node scripts/execution-audit.mjs --record <file.json> [--evidence-root <dir>] [--shared <dir>] [--out <report.json>]",
  );
  process.exit(2);
}

/** The records to audit with where their evidence and shared record live. */
function inputs() {
  if (recordFile) {
    const parsed = JSON.parse(readFileSync(recordFile, "utf8"));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const evidenceRoot = option("--evidence-root") ?? null;
    const shared = option("--shared") ?? null;
    return {
      source: { record: resolve(recordFile), evidenceRoot, shared },
      records: records.map((record) => ({
        record,
        evidenceDir: evidenceRoot
          ? join(evidenceRoot, recordSegment(record.executionRef))
          : null,
        sharedDir: shared,
        sharedKnown: shared !== null,
      })),
    };
  }
  const root = resolve(dataRoot);
  const database = join(root, "state.sqlite");
  if (!existsSync(database)) {
    console.error("no state.sqlite under " + root);
    process.exit(2);
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  const wanted = option("--execution");
  let rows;
  let resources;
  try {
    rows = db
      .prepare(
        wanted
          ? "SELECT record FROM runtime_executions WHERE execution_ref=?"
          : "SELECT record FROM runtime_executions ORDER BY touched",
      )
      .all(...(wanted ? [wanted] : []));
    resources = db.prepare("SELECT record FROM runtime_resources").all();
  } finally {
    db.close();
  }
  const executionsRoot = join(root, "..", basename(root) + "-executions");
  const evidenceRoot = join(executionsRoot, "evidence");
  const fallbackRoot = join(executionsRoot, "records");
  const pathOf = new Map(
    resources
      .map((r) => JSON.parse(String(r.record)))
      .map((r) => [String(r.handle), String(r.path)]),
  );
  return {
    source: { dataRoot: root, evidenceRoot, records: rows.length },
    records: rows.map((row) => {
      const record = JSON.parse(String(row.record));
      const segment = recordSegment(record.operationId);
      const resourcePath = pathOf.get(record.resourceHandle);
      const common = resourcePath ? gitCommonDir(resourcePath) : null;
      const candidates = [
        common ? join(common, "harness", "executions", segment) : null,
        join(fallbackRoot, "harness", "executions", segment),
      ].filter(Boolean);
      const sharedDir =
        candidates.find((dir) => existsSync(dir)) ?? candidates[0];
      return {
        record,
        evidenceDir: join(evidenceRoot, recordSegment(record.executionRef)),
        sharedDir,
        sharedKnown: true,
      };
    }),
  };
}

// ---------------------------------------------------------------- checks
/** Tool calls as the transcript records them: Claude tool_use blocks, Codex commandExecution items (raw fixture frames count their tool_use blocks too). */
function toolCallsOf(entries) {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "assistant") {
      const blocks = Array.isArray(entry.blocks)
        ? entry.blocks
        : Array.isArray(entry.message?.content)
          ? entry.message.content
          : [];
      count += blocks.filter((b) => b && b.type === "tool_use").length;
    }
    if (
      entry.notification === "item/started" &&
      entry.itemType === "commandExecution"
    )
      count += 1;
  }
  return count;
}
function auditOne({ record, evidenceDir, sharedDir, sharedKnown }) {
  const checks = [];
  const check = (id, passed, detail) => {
    checks.push({ id, passed, detail: String(detail).slice(0, 1024) });
    return passed;
  };
  const projection = Object.fromEntries(
    physicalKeys.map((key) => [key, record[key]]),
  );
  const valid = validators.PhysicalExecution(projection);
  check(
    "physical-execution-schema",
    valid,
    valid
      ? "PhysicalExecution 投影符合 schema.json（含 state 条件）"
      : describe(validators.PhysicalExecution),
  );
  const result = {
    executionRef: record.executionRef,
    state: record.state,
    stopReason: record.stopReason ?? null,
    checks,
    recomputed: null,
    passed: false,
  };
  const early = ["queued", "reserved", "running"].includes(record.state);
  if (early) {
    check("not-settled", true, "执行尚未结算，核算字段不存在，未审计");
    result.passed = checks.every((c) => c.passed);
    return result;
  }
  if (record.resultRef === null) {
    // A start refused before any process, a target gone before its release, or a supervision
    // abandoned without an exit: nothing was accounted, so nothing may claim to be.
    const ok = record.accounting === null && record.exit === null;
    check(
      "no-evidence",
      ok,
      ok
        ? record.target === null
          ? "没有结果证据：启动前被拒绝，未产生进程，核算与退出为空"
          : `没有结果证据：${record.state}（${record.reason.slice(0, 200)}），核算与退出为空`
        : "没有结果证据，但记录带有核算或退出",
    );
    result.passed = checks.every((c) => c.passed);
    return result;
  }
  if (!evidenceDir) {
    check("result-document", false, "未提供证据根目录（--evidence-root）");
    result.passed = false;
    return result;
  }
  // The result document, bound to the record by digest.
  let document = null;
  const resultPath = join(evidenceDir, "result.json");
  if (!existsSync(resultPath))
    check("result-document", false, "缺少 " + resultPath);
  else {
    const bytes = readFileSync(resultPath);
    const digest = sha256(bytes);
    const ok =
      digest === record.resultRef.digest &&
      bytes.length === record.resultRef.bytes &&
      record.resultRef.objectRef === "execution-result:" + record.executionRef;
    check(
      "result-document",
      ok,
      ok
        ? `result.json 摘要 ${digest.slice(0, 12)}… 与 resultRef 一致（${bytes.length} 字节）`
        : `result.json 摘要 ${digest.slice(0, 12)}… / ${bytes.length} 字节，resultRef ${record.resultRef.digest.slice(0, 12)}… / ${record.resultRef.bytes} 字节，objectRef ${record.resultRef.objectRef}`,
    );
    if (ok) document = JSON.parse(bytes.toString("utf8"));
  }
  if (!document) {
    result.passed = false;
    return result;
  }
  // The transcript, bound to the result document by digest.
  let entries = null;
  const transcriptPath = join(evidenceDir, "transcript.ndjson");
  if (!existsSync(transcriptPath))
    check("transcript-digest", false, "缺少 " + transcriptPath);
  else {
    const bytes = readFileSync(transcriptPath);
    const digest = sha256(bytes);
    let parsed = [];
    let problem = null;
    try {
      parsed = bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const bad = parsed.findIndex(
        (e) =>
          !e ||
          typeof e !== "object" ||
          !Number.isInteger(e.bytes) ||
          e.bytes < 0,
      );
      if (bad >= 0) problem = `第 ${bad + 1} 条记录没有整数 bytes`;
    } catch (error) {
      problem = "transcript 不是逐行 JSON：" + error.message;
    }
    const ok =
      digest === document.transcriptDigest &&
      bytes.length === document.transcriptBytes &&
      problem === null;
    check(
      "transcript-digest",
      ok,
      ok
        ? `transcript.ndjson 摘要与 result.json 一致（${parsed.length} 条记录，${bytes.length} 字节）`
        : (problem ??
            `transcript 摘要 ${digest.slice(0, 12)}… / ${bytes.length} 字节，result.json 记录 ${String(document.transcriptDigest).slice(0, 12)}… / ${document.transcriptBytes}`),
    );
    if (ok) entries = parsed;
  }
  if (!entries) {
    result.passed = false;
    return result;
  }
  const accounting = record.accounting;
  check(
    "accounting-present",
    accounting !== null && record.exit !== null,
    accounting !== null && record.exit !== null
      ? "记录含核算与退出"
      : "已结算的记录缺少核算或退出",
  );
  if (accounting === null || record.exit === null) {
    result.passed = false;
    return result;
  }
  check(
    "accounting-in-result",
    deepEqual(document.accounting, accounting),
    deepEqual(document.accounting, accounting)
      ? "记录的核算与 result.json 的核算逐字段相等"
      : `记录 ${JSON.stringify(accounting)}，result.json ${JSON.stringify(document.accounting)}`,
  );
  // Recompute every field from its own source.
  const toolCalls = toolCallsOf(entries);
  check(
    "tool-calls",
    toolCalls === accounting.toolCalls,
    `记录 ${accounting.toolCalls} · transcript ${toolCalls}`,
  );
  const outputBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  check(
    "output-bytes",
    outputBytes === accounting.outputBytes,
    `记录 ${accounting.outputBytes} · transcript 字节和 ${outputBytes}`,
  );
  const timeline = document.timeline ?? {};
  const released = timeline.releasedAt ? Date.parse(timeline.releasedAt) : null;
  const exited = timeline.exitedAt ? Date.parse(timeline.exitedAt) : null;
  const runSeconds =
    released !== null && exited !== null
      ? Math.max(0, Math.round((exited - released) / 1000))
      : 0;
  check(
    "run-seconds",
    runSeconds === accounting.runSeconds,
    `记录 ${accounting.runSeconds} · timeline ${timeline.releasedAt ?? "未放行"} → ${timeline.exitedAt ?? "无退出"} = ${runSeconds}`,
  );
  const waited =
    document.targetExit !== null &&
    document.targetExit !== undefined &&
    deepEqual(document.targetExit, record.exit);
  check(
    "waited",
    accounting.waited === waited,
    `记录 ${accounting.waited} · result.json targetExit ${JSON.stringify(document.targetExit ?? null)}${waited ? "" : "，与记录 exit 不等或缺失"}`,
  );
  const probe = document.exitProbe?.state ?? null;
  const pidGone = probe !== null && gone(probe);
  check(
    "pid-gone",
    accounting.pidGoneAfterExit === pidGone,
    `记录 ${accounting.pidGoneAfterExit} · exitProbe ${probe ?? "缺失"}`,
  );
  result.recomputed = {
    toolCalls,
    outputBytes,
    runSeconds,
    waited,
    pidGoneAfterExit: pidGone,
  };
  // The stop reason names its cause.
  const budget = record.budget ?? {};
  const signals = Array.isArray(document.signals) ? document.signals : [];
  const stopLabels = signals
    .map((s) => s.label)
    .filter((label) => typeof label === "string" && label.startsWith("stop:"));
  if (record.state === "stopped") {
    const reason = record.stopReason;
    const causes = {
      "tool-call-budget": [
        toolCalls > budget.maxToolCalls,
        `transcript 工具调用 ${toolCalls} > maxToolCalls ${budget.maxToolCalls}`,
      ],
      "output-limit": [
        outputBytes > budget.maxOutputBytes,
        `输出 ${outputBytes} > maxOutputBytes ${budget.maxOutputBytes}`,
      ],
      timeout: [
        runSeconds >= budget.maxRunSeconds,
        `时长 ${runSeconds} >= maxRunSeconds ${budget.maxRunSeconds}`,
      ],
      cancelled: [
        record.cancelRequestedAt !== null,
        `cancelRequestedAt ${record.cancelRequestedAt}`,
      ],
      signal: [true, "放行确认缺失的停止，无预算条件"],
    };
    const [caused, why] = causes[reason] ?? [false, "未知停止原因 " + reason];
    const labelled = stopLabels.every((label) => label === "stop:" + reason);
    const same = document.stopReason === reason;
    check(
      "stop-reason",
      caused && labelled && same,
      `${reason}：${why}${labelled ? "" : "；信号台账的停止标签 " + stopLabels.join(",") + " 与原因不符"}${same ? "" : "；result.json 记录的停止原因为 " + document.stopReason}`,
    );
  } else if (record.state === "stopping" && record.stopUnconfirmed) {
    check(
      "stop-reason",
      record.stopReason === null &&
        stopLabels.every((l) => l === "stop:" + document.stopReason),
      `停止未确认：记录暂无停止原因，result.json 的原因 ${document.stopReason}，台账标签 ${stopLabels.join(",") || "无"}`,
    );
  } else
    check(
      "stop-reason",
      record.stopReason === null &&
        stopLabels.every(
          (l) =>
            !/^stop:(cancelled|timeout|tool-call-budget|output-limit|signal)$/.test(
              l,
            ),
        ),
      `${record.state}：无停止原因，台账标签 ${stopLabels.join(",") || "无"}`,
    );
  // A native budget result is a budget failure that kept the turn's read-back.
  const nativeResult = document.evidence?.result ?? null;
  const budgetSubtypes = ["error_max_budget_usd", "error_max_turns"];
  const nativeBudget =
    nativeResult && budgetSubtypes.includes(String(nativeResult.subtype));
  if (nativeBudget || document.resultCode === "BUDGET_EXCEEDED") {
    const ok =
      record.state === "failed" &&
      record.stopReason === null &&
      document.resultCode === "BUDGET_EXCEEDED" &&
      nativeBudget &&
      typeof nativeResult.total_cost_usd === "number";
    check(
      "budget-failure",
      ok,
      ok
        ? `${nativeResult.subtype}：记录 failed / BUDGET_EXCEEDED，已完成回合的读回保留（total_cost_usd ${nativeResult.total_cost_usd}）`
        : `state ${record.state}，stopReason ${record.stopReason}，resultCode ${document.resultCode}，subtype ${nativeResult?.subtype ?? "无"}，total_cost_usd ${nativeResult?.total_cost_usd ?? "缺失"}`,
    );
  } else check("budget-failure", true, "不适用：没有原生预算结果");
  // The shared observation record, when its directory is known.
  if (!sharedKnown)
    check("shared-record", true, "未提供共享观察记录目录（--shared），未核对");
  else if (!sharedDir || !existsSync(sharedDir))
    check(
      "shared-record",
      false,
      "共享观察记录目录不存在：" + (sharedDir ?? "未知"),
    );
  else {
    const names = readdirSync(sharedDir)
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
    const problems = [];
    let last = null;
    names.forEach((name, index) => {
      const bytes = readFileSync(join(sharedDir, name));
      const expected = existsSync(join(sharedDir, name + ".sha256"))
        ? readFileSync(join(sharedDir, name + ".sha256"), "utf8").trim()
        : null;
      if (sha256(bytes) !== expected) problems.push(name + " 摘要不符");
      const seq = JSON.parse(bytes.toString("utf8"));
      if (seq.seq !== String(index)) problems.push(name + " seq 不连续");
      if (!validators.ExecutionRecord(seq))
        problems.push(
          name +
            " 不符合 ExecutionRecord：" +
            describe(validators.ExecutionRecord),
        );
      last = seq;
    });
    if (!last) problems.push("没有 seq 记录");
    else {
      if (last.executionId !== record.executionRef)
        problems.push("executionId " + last.executionId);
      if (last.released !== (record.releasedAt !== null))
        problems.push("released " + last.released);
      if (!deepEqual(last.exit, record.exit))
        problems.push("exit " + JSON.stringify(last.exit));
      if (
        !record.target ||
        !last.target ||
        last.target.pid !== record.target.pid ||
        last.target.image !== record.target.path
      )
        problems.push("target " + JSON.stringify(last.target));
      if (last.result?.digest !== record.resultRef.digest)
        problems.push("result.digest " + (last.result?.digest ?? "无"));
    }
    check(
      "shared-record",
      problems.length === 0,
      problems.length === 0
        ? `${names.length} 个 seq 符合 ExecutionRecord，末条与记录的执行、放行、退出、目标与结果摘要一致`
        : problems.join("；"),
    );
  }
  result.passed = checks.every((c) => c.passed);
  return result;
}

const { source, records } = inputs();
const executions = records.map((input) => {
  try {
    return auditOne(input);
  } catch (error) {
    return {
      executionRef: input.record?.executionRef ?? null,
      state: input.record?.state ?? null,
      stopReason: input.record?.stopReason ?? null,
      checks: [{ id: "audit", passed: false, detail: String(error.message) }],
      recomputed: null,
      passed: false,
    };
  }
});
const report = {
  schema_version: 1,
  tool: "execution-audit",
  contract: { schemaDigest: sha256(schemaBytes) },
  source,
  auditedAt: new Date().toISOString(),
  passed: executions.length > 0 && executions.every((e) => e.passed),
  executions,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (outPath) writeFileSync(outPath, text);
process.stdout.write(text);
process.exit(report.passed ? 0 : 1);
