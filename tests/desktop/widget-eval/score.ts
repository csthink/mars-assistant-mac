/**
 * Pure scoring for the widget generation evaluation: stage judgement of one attempt, the
 * static requirement rules, per provider and model aggregation and the two output files.
 * No clock, path or random input reaches these functions, so equal inputs give equal bytes.
 */
import type { BuiltWidget } from "../../../src/shared/widget";
import type { Execution, ResponseView } from "./execute";
import {
  isStaticRule,
  type Fixture,
  type Requirement,
  type RequirementSet,
  type StaticRule,
} from "./model";

export const stages = [
  "provider",
  "submitted",
  "valid",
  "compiled",
  "rendered",
  "satisfied",
] as const;
export type Stage = (typeof stages)[number];
/** Closed failure classes; the first failed stage of an attempt decides its single class. */
export const failureClasses = {
  provider: [
    "timeout",
    "stopped",
    "network",
    "stream",
    "auth",
    "rate_limit",
    "provider",
    "model",
    "address",
    "context",
    "unsupported",
    "stop_timeout",
    "transport_other",
  ],
  submitted: [
    "no_submission",
    "multiple_submissions",
    "wrong_tool",
    "malformed_tool_call",
  ],
  valid: ["invalid_arguments"],
  compiled: ["compile_rejected"],
  rendered: ["render_error"],
  satisfied: ["requirement_unmet"],
} as const satisfies Record<Stage, readonly string[]>;
export type FailureClass = (typeof failureClasses)[Stage][number];

export interface Failure {
  stage: Stage;
  class: FailureClass;
  detail: string | null;
}
export type RuleResult = { id: string; pass: boolean; observed: string };
/** Observation of the rendered candidate in the client; absent when rendering did not run. */
export interface RenderObservation {
  /** The candidate's view appeared and finished loading. */
  loaded: boolean;
  /** The loaded view shows no text and no visual or interactive element. */
  empty: boolean;
  /** Console errors of the view during the observation window after load. */
  errors: string[];
  rules: RuleResult[];
}
export interface Judgement {
  stages: Record<Stage, boolean | null>;
  failure: Failure | null;
  staticRules: RuleResult[];
  renderRules: RuleResult[] | null;
}

const providerFailures = new Set<string>(failureClasses.provider);
const timeoutMessage = "控件生成已达到本次等待时限";

/**
 * Judges the product-side stages of one attempt. The executor's own outcome decides
 * acceptance; the response view only names why no candidate was submitted.
 */
export function judgeExecution(
  outcome: Fixture["recorded"]["outcome"],
  execution: Execution | null,
  view: ResponseView | null,
): { stages: Record<Stage, boolean | null>; failure: Failure | null } {
  const result: Record<Stage, boolean | null> = {
    provider: null,
    submitted: null,
    valid: null,
    compiled: null,
    rendered: null,
    satisfied: null,
  };
  const failed = (stage: Stage, cls: FailureClass, detail: string | null) => {
    result[stage] = false;
    return { stages: result, failure: { stage, class: cls, detail } };
  };
  if (outcome.kind !== "response" || !execution) {
    if (outcome.kind === "timeout") return failed("provider", "timeout", null);
    if (outcome.kind === "stopped") return failed("provider", "stopped", null);
    if (outcome.kind === "transport")
      return failed(
        "provider",
        providerFailures.has(outcome.errorClass)
          ? (outcome.errorClass as FailureClass)
          : "transport_other",
        outcome.message,
      );
    throw new Error("a response attempt needs its execution");
  }
  const compiled =
    execution.taskState === "completed" && execution.candidateDigest !== null;
  if (compiled && !(execution.invoked && execution.compile?.ok))
    throw new Error("pipeline inconsistency: candidate without a submission");
  if (!execution.invoked) {
    if (execution.taskError?.startsWith(timeoutMessage))
      return failed("provider", "timeout", null);
    if (execution.taskState === "stopped")
      return failed("provider", "stopped", null);
    if (
      execution.thrownClass &&
      !["protocol", "permission"].includes(execution.thrownClass)
    )
      return failed(
        "provider",
        providerFailures.has(execution.thrownClass)
          ? (execution.thrownClass as FailureClass)
          : "transport_other",
        execution.taskError,
      );
    result.provider = true;
    // The product's stream parser refused the response itself (a tool call whose arguments
    // never completed or exceeded the wire limit): nothing reached the candidate receiver.
    if (!view) {
      if (execution.thrownClass !== "protocol")
        throw new Error("pipeline inconsistency: no stream view of a response");
      return failed("submitted", "malformed_tool_call", execution.taskError);
    }
    const calls = view.calls;
    if (calls.length === 0)
      return failed("submitted", "no_submission", execution.taskError);
    if (calls.length > 1)
      return failed("submitted", "multiple_submissions", execution.taskError);
    return failed("submitted", "wrong_tool", calls[0].name);
  }
  result.provider = true;
  result.submitted = true;
  if (!execution.argumentsValid)
    return failed("valid", "invalid_arguments", execution.taskError);
  result.valid = true;
  if (!compiled)
    return failed(
      "compiled",
      "compile_rejected",
      execution.compile && !execution.compile.ok
        ? execution.compile.message
        : execution.taskError,
    );
  result.compiled = true;
  return { stages: result, failure: null };
}

function sourceText(build: BuiltWidget, files: ("html" | "css" | "js")[]) {
  return files.map((f) => build.manifest.view[f]).join("\n");
}
export function evaluateStaticRule(
  rule: StaticRule,
  build: BuiltWidget,
): RuleResult {
  const m = build.manifest;
  if (rule.check === "capability") {
    const pass = (m.capabilities as string[]).includes(rule.capability);
    return {
      id: rule.id,
      pass,
      observed: `capabilities: ${m.capabilities.join(", ") || "none"}`,
    };
  }
  if (rule.check === "config") {
    const fields = m.config.filter((f) => f.type === rule.type);
    return {
      id: rule.id,
      pass: fields.length > 0,
      observed: `${rule.type} config fields: ${fields.map((f) => f.id).join(", ") || "none"}`,
    };
  }
  const found = new RegExp(rule.pattern, rule.flags ?? "u").test(
    sourceText(build, rule.files),
  );
  return {
    id: rule.id,
    pass: rule.absent ? !found : found,
    observed: found ? "pattern present" : "pattern absent",
  };
}

/** Combines the product stages with the requirement rules and, when it ran, rendering. */
export function judgeAttempt(
  requirement: Requirement,
  product: ReturnType<typeof judgeExecution>,
  build: BuiltWidget | null,
  render: RenderObservation | null,
): Judgement {
  const stages = { ...product.stages };
  const staticRules =
    build && stages.compiled
      ? requirement.rules
          .filter(isStaticRule)
          .map((rule) => evaluateStaticRule(rule, build))
      : [];
  if (product.failure)
    return {
      stages,
      failure: product.failure,
      staticRules,
      renderRules: null,
    };
  if (render) {
    if (!render.loaded || render.empty || render.errors.length) {
      stages.rendered = false;
      return {
        stages,
        failure: {
          stage: "rendered",
          class: "render_error",
          detail: !render.loaded
            ? "view did not appear"
            : render.empty
              ? "view rendered no content"
              : render.errors.join(" | ").slice(0, 600),
        },
        staticRules,
        renderRules: render.rules,
      };
    }
    stages.rendered = true;
  }
  const unmet = [...staticRules, ...(render?.rules ?? [])].filter(
    (r) => !r.pass,
  );
  stages.satisfied = unmet.length === 0;
  return {
    stages,
    failure: unmet.length
      ? {
          stage: "satisfied",
          class: "requirement_unmet",
          detail: unmet.map((r) => r.id).join(", "),
        }
      : null,
    staticRules,
    renderRules: render?.rules ?? null,
  };
}

export interface AttemptRecord {
  id: string;
  requirement: string;
  language: string;
  category: string;
  difficulty: number;
  source: Fixture["source"];
  provider: string;
  model: string;
  repeat: number;
  durationMs: number | null;
  firstByteMs: number | null;
  usage: Fixture["recorded"]["usage"];
  candidateDigest: string | null;
  judgement: Judgement;
}

/** Nearest-rank percentile: the smallest value with at least p percent of values at or below it. */
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}
const ratio = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 10000) / 10000 : null;
function timing(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    maxMs: sorted.at(-1) ?? null,
    meanMs: sorted.length
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : null,
  };
}
export function aggregate(attempts: AttemptRecord[], renderRan: boolean) {
  const keys = [
    ...new Set(attempts.map((a) => `${a.provider}\u0000${a.model}`)),
  ].sort();
  return keys.map((key) => {
    const [provider, model] = key.split("\u0000");
    const group = attempts.filter(
      (a) => a.provider === provider && a.model === model,
    );
    const n = group.length;
    const passed = (stage: Stage) =>
      group.filter((a) => a.judgement.stages[stage] === true).length;
    const funnel: Record<
      string,
      { passed: number; rate: number | null; ofPrevious: number | null }
    > = {};
    let previous = n;
    for (const stage of stages) {
      if (stage === "rendered" && !renderRan) continue;
      const count = passed(stage);
      funnel[stage] = {
        passed: count,
        rate: ratio(count, n),
        ofPrevious: ratio(count, previous),
      };
      previous = count;
    }
    const failures: Record<string, number> = {};
    for (const a of group)
      if (a.judgement.failure)
        failures[a.judgement.failure.class] =
          (failures[a.judgement.failure.class] ?? 0) + 1;
    const durations = (filter: (a: AttemptRecord) => boolean) =>
      group
        .filter((a) => filter(a) && a.durationMs !== null)
        .map((a) => a.durationMs!);
    const timeouts = group.filter(
      (a) => a.judgement.failure?.class === "timeout",
    ).length;
    return {
      provider,
      model,
      attempts: n,
      funnel,
      timeouts: { count: timeouts, rate: ratio(timeouts, n) },
      failures: Object.fromEntries(
        Object.entries(failures).sort(([a], [b]) => a.localeCompare(b)),
      ),
      duration: {
        all: timing(durations(() => true)),
        compiled: timing(
          durations((a) => a.judgement.stages.compiled === true),
        ),
      },
    };
  });
}

export interface EvaluationResult {
  schemaVersion: 1;
  kind: "widget-generation-evaluation";
  mode: "replay" | "live";
  requirementSet: {
    set: string;
    version: number;
    sha256: string;
    count: number;
  };
  render: "run" | "not-run";
  /** Console errors of a minimal baseline widget, not attributed to candidates. */
  renderBaseline: string[] | null;
  satisfaction: "static-and-render-rules" | "static-rules-only";
  sources: { synthetic: number; recorded: number };
  groups: ReturnType<typeof aggregate>;
  attempts: AttemptRecord[];
}
export function buildResult(input: {
  mode: "replay" | "live";
  set: RequirementSet;
  setSha256: string;
  renderBaseline: string[] | null;
  attempts: AttemptRecord[];
}): EvaluationResult {
  const renderRan = input.renderBaseline !== null;
  const attempts = [...input.attempts].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    schemaVersion: 1,
    kind: "widget-generation-evaluation",
    mode: input.mode,
    requirementSet: {
      set: input.set.set,
      version: input.set.version,
      sha256: input.setSha256,
      count: input.set.requirements.length,
    },
    render: renderRan ? "run" : "not-run",
    renderBaseline: input.renderBaseline,
    satisfaction: renderRan ? "static-and-render-rules" : "static-rules-only",
    sources: {
      synthetic: attempts.filter((a) => a.source === "synthetic").length,
      recorded: attempts.filter((a) => a.source === "recorded").length,
    },
    groups: aggregate(attempts, renderRan),
    attempts,
  };
}

const percent = (rate: number | null) =>
  rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
  value === null ? "-" : `${(value / 1000).toFixed(1)} s`;
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** Human summary of a result; derived only from the result, so it is as deterministic. */
export function summary(result: EvaluationResult) {
  const lines: string[] = [];
  lines.push("# Widget generation evaluation");
  lines.push("");
  lines.push(
    `Mode: ${result.mode}. Requirement set: ${result.requirementSet.set} v${result.requirementSet.version} (${result.requirementSet.count} requirements, sha256 ${result.requirementSet.sha256.slice(0, 12)}). Attempts: ${result.attempts.length} (${result.sources.synthetic} synthetic, ${result.sources.recorded} recorded).`,
  );
  lines.push("");
  if (result.sources.synthetic)
    lines.push(
      "Synthetic fixtures only exercise the scoring pipeline; their numbers do not describe any model.",
      "",
    );
  lines.push(
    result.render === "run"
      ? "Rendering ran: requirement satisfaction covers static and rendered rules."
      : "Rendering did not run: the rendered stage is omitted and satisfaction covers static rules only.",
    "",
  );
  if (result.renderBaseline?.length)
    lines.push(
      `Console errors of the baseline widget, not attributed to candidates: ${result.renderBaseline.map((m) => `"${m}"`).join("; ")}.`,
      "",
    );
  lines.push("## Funnel by provider and model", "");
  const shown = stages.filter(
    (s) => s !== "rendered" || result.render === "run",
  );
  lines.push(
    `| Provider | Model | Attempts | ${shown
      .map((s) =>
        s === "satisfied" && result.render !== "run"
          ? "satisfied (static rules)"
          : s,
      )
      .join(" | ")} | Timeouts | p50 | p90 |`,
  );
  lines.push(
    `| --- | --- | --- | ${shown.map(() => "---").join(" | ")} | --- | --- | --- |`,
  );
  for (const g of result.groups)
    lines.push(
      `| ${cell(g.provider)} | ${cell(g.model)} | ${g.attempts} | ${shown
        .map((s) => `${g.funnel[s].passed} (${percent(g.funnel[s].rate)})`)
        .join(
          " | ",
        )} | ${g.timeouts.count} | ${ms(g.duration.all.p50Ms)} | ${ms(g.duration.all.p90Ms)} |`,
    );
  lines.push("", "## Failure classes", "");
  lines.push(
    "| Provider | Model | Class | Count |",
    "| --- | --- | --- | --- |",
  );
  for (const g of result.groups)
    for (const [cls, count] of Object.entries(g.failures))
      lines.push(
        `| ${cell(g.provider)} | ${cell(g.model)} | ${cls} | ${count} |`,
      );
  lines.push("", "## Attempts", "");
  lines.push(
    "| Attempt | Requirement | Outcome | Detail |",
    "| --- | --- | --- | --- |",
  );
  for (const a of result.attempts) {
    const f = a.judgement.failure;
    lines.push(
      `| ${cell(a.id)} | ${cell(a.requirement)} | ${f ? `${f.stage}: ${f.class}` : "satisfied"} | ${cell((f?.detail ?? "").slice(0, 160))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Stable serialisation: object keys sorted at every level. */
export function canonicalJson(value: unknown) {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2) + "\n";
}
