/**
 * Widget generation evaluation: the standard requirement set, its judgement rules and the
 * provider-neutral model output that an evaluation attempt replays or records.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type StaticRule =
  | { id: string; check: "capability"; capability: string }
  | {
      id: string;
      check: "source";
      files: ("html" | "css" | "js")[];
      pattern: string;
      flags?: string;
      absent?: boolean;
    }
  | { id: string; check: "config"; type: "text" | "number" | "boolean" };
export interface RoleCheck {
  check: "role";
  roles: string[];
  name?: string;
  flags?: string;
  checked?: boolean;
  min?: number;
  max?: number;
}
export interface TextCheck {
  check: "text";
  pattern: string;
  flags?: string;
  min?: number;
  max?: number;
}
export interface SelectorCheck {
  check: "selector";
  selector: string;
  min?: number;
  max?: number;
}
export type DomCheck = RoleCheck | TextCheck | SelectorCheck;
export type InteractionStep =
  | { action: "click"; roles: string[]; name?: string; flags?: string }
  | { action: "check"; roles: string[]; name?: string; flags?: string }
  | { action: "fill"; label: string; value: string }
  | { action: "expect"; rule: DomCheck; timeoutMs?: number };
export type RenderRule =
  | (DomCheck & { id: string })
  | { id: string; check: "interaction"; steps: InteractionStep[] };
export type Rule = StaticRule | RenderRule;

export const staticChecks = ["capability", "source", "config"] as const;
export const renderChecks = [
  "role",
  "text",
  "selector",
  "interaction",
] as const;
export const isStaticRule = (rule: Rule): rule is StaticRule =>
  (staticChecks as readonly string[]).includes(rule.check);

export interface Requirement {
  id: string;
  language: "zh" | "en";
  category: string;
  difficulty: 1 | 2 | 3;
  prompt: string;
  expectation: string;
  rules: Rule[];
}
export interface RequirementSet {
  schemaVersion: 1;
  set: string;
  version: number;
  requirements: Requirement[];
}

const capabilities = ["data.read", "data.write", "draft.write", "config.read"];
const roleNames = new Set([
  "button",
  "checkbox",
  "textbox",
  "spinbutton",
  "slider",
  "radio",
  "combobox",
  "listitem",
  "heading",
  "img",
]);
function fail(message: string): never {
  throw new Error(`requirement set: ${message}`);
}
function regex(pattern: unknown, flags: unknown, where: string) {
  if (typeof pattern !== "string" || !pattern) fail(`${where} needs a pattern`);
  if (flags !== undefined && (typeof flags !== "string" || /[gy]/.test(flags)))
    fail(`${where} has unsupported flags`);
  try {
    return new RegExp(pattern, flags ?? "u");
  } catch {
    fail(`${where} has an invalid pattern`);
  }
}
function bounds(rule: { min?: unknown; max?: unknown }, where: string) {
  for (const key of ["min", "max"] as const)
    if (
      rule[key] !== undefined &&
      (!Number.isInteger(rule[key]) || Number(rule[key]) < 0)
    )
      fail(`${where} has an invalid ${key}`);
  if (
    rule.min !== undefined &&
    rule.max !== undefined &&
    Number(rule.min) > Number(rule.max)
  )
    fail(`${where} has min above max`);
}
function roles(value: unknown, where: string) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((r) => !roleNames.has(r))
  )
    fail(`${where} needs known roles`);
}
function domCheck(rule: Record<string, unknown>, where: string) {
  bounds(rule, where);
  if (rule.check === "role") {
    roles(rule.roles, where);
    if (rule.name !== undefined) regex(rule.name, rule.flags, where);
    if (rule.checked !== undefined && typeof rule.checked !== "boolean")
      fail(`${where} has an invalid checked state`);
  } else if (rule.check === "text") regex(rule.pattern, rule.flags, where);
  else if (rule.check === "selector") {
    if (typeof rule.selector !== "string" || !rule.selector.trim())
      fail(`${where} needs a selector`);
  } else fail(`${where} has an unknown check`);
}
/** Rejects a malformed set before any attempt: every rule must be judgeable as written. */
export function validateRequirementSet(value: unknown): RequirementSet {
  const set = value as RequirementSet;
  if (
    !set ||
    set.schemaVersion !== 1 ||
    typeof set.set !== "string" ||
    !Number.isInteger(set.version) ||
    !Array.isArray(set.requirements) ||
    !set.requirements.length
  )
    fail("invalid header");
  const ids = new Set<string>();
  for (const r of set.requirements) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(r?.id ?? "") || ids.has(r.id))
      fail(`invalid or duplicate id ${r?.id}`);
    ids.add(r.id);
    if (!["zh", "en"].includes(r.language)) fail(`${r.id} language`);
    if (![1, 2, 3].includes(r.difficulty)) fail(`${r.id} difficulty`);
    if (!r.category || !r.prompt?.trim() || !r.expectation?.trim())
      fail(`${r.id} needs category, prompt and expectation`);
    if (!Array.isArray(r.rules) || !r.rules.length) fail(`${r.id} needs rules`);
    const ruleIds = new Set<string>();
    for (const rule of r.rules) {
      const where = `${r.id}/${rule?.id}`;
      if (
        !/^[a-z][a-z0-9-]{1,47}$/.test(rule?.id ?? "") ||
        ruleIds.has(rule.id)
      )
        fail(`invalid or duplicate rule id ${where}`);
      ruleIds.add(rule.id);
      const raw = rule as unknown as Record<string, unknown>;
      if (rule.check === "capability") {
        if (!capabilities.includes(rule.capability))
          fail(`${where} names an unknown capability`);
      } else if (rule.check === "source") {
        if (
          !Array.isArray(rule.files) ||
          !rule.files.length ||
          rule.files.some((f) => !["html", "css", "js"].includes(f))
        )
          fail(`${where} needs view files`);
        regex(rule.pattern, rule.flags, where);
      } else if (rule.check === "config") {
        if (!["text", "number", "boolean"].includes(rule.type))
          fail(`${where} names an unknown config type`);
      } else if (rule.check === "interaction") {
        if (!Array.isArray(rule.steps) || !rule.steps.length)
          fail(`${where} needs steps`);
        if (!rule.steps.some((s) => s.action === "expect"))
          fail(`${where} never checks an outcome`);
        for (const step of rule.steps) {
          if (step.action === "click" || step.action === "check") {
            roles(step.roles, where);
            if (step.name !== undefined) regex(step.name, step.flags, where);
          } else if (step.action === "fill") {
            if (typeof step.label !== "string" || !step.label)
              fail(`${where} fill needs a label`);
            if (typeof step.value !== "string")
              fail(`${where} fill needs a value`);
          } else if (step.action === "expect") {
            domCheck(step.rule as unknown as Record<string, unknown>, where);
            if (
              step.timeoutMs !== undefined &&
              (!Number.isInteger(step.timeoutMs) ||
                step.timeoutMs < 100 ||
                step.timeoutMs > 10_000)
            )
              fail(`${where} has an invalid timeout`);
          } else fail(`${where} has an unknown step`);
        }
      } else domCheck(raw, where);
    }
  }
  return set;
}

export const requirementSetPath = join(__dirname, "requirements.json");
/** The versioned set with the digest of its exact bytes, so results name the set they judged. */
export function loadRequirementSet(path = requirementSetPath) {
  const bytes = readFileSync(path);
  return {
    set: validateRequirementSet(JSON.parse(bytes.toString("utf8"))),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Model output of one attempt, independent of the provider: the provider's raw HTTP response
 * (a Chat Completions event stream or an error body) exactly as recorded or synthesized. Replay
 * serves these bytes to the product's own executor, which parses them; nothing here re-parses
 * the stream to decide a stage.
 */
export interface ModelResponse {
  status: number;
  contentType: string;
  body: string;
  /** The connection was cut after the body: a network failure the replay reproduces. */
  truncated?: boolean;
}
export type RecordedOutcome =
  | { kind: "response" }
  | { kind: "timeout" }
  | { kind: "stopped" }
  | { kind: "transport"; errorClass: string; message: string };
export interface Fixture {
  schemaVersion: 1;
  id: string;
  requirement: string;
  source: "synthetic" | "recorded";
  provider: string;
  model: string;
  repeat: number;
  recorded: {
    outcome: RecordedOutcome;
    durationMs: number | null;
    firstByteMs: number | null;
    usage: { promptTokens: number; completionTokens: number } | null;
  };
  /** Null when the attempt never received a response (an unreplayable timeout or stop). */
  response: ModelResponse | null;
}
export function validFixture(value: unknown): value is Fixture {
  const f = value as Fixture;
  return (
    !!f &&
    f.schemaVersion === 1 &&
    /^[a-z0-9][a-z0-9.-]{2,127}$/.test(f.id ?? "") &&
    typeof f.requirement === "string" &&
    ["synthetic", "recorded"].includes(f.source) &&
    typeof f.provider === "string" &&
    !!f.provider &&
    typeof f.model === "string" &&
    !!f.model &&
    Number.isInteger(f.repeat) &&
    f.repeat >= 1 &&
    !!f.recorded &&
    ["response", "timeout", "stopped", "transport"].includes(
      f.recorded.outcome?.kind,
    ) &&
    (f.response === null ||
      (Number.isInteger(f.response?.status) &&
        typeof f.response.contentType === "string" &&
        typeof f.response.body === "string")) &&
    (f.recorded.outcome.kind !== "response" || f.response !== null)
  );
}

/** Recorded fixtures of a directory, in file name order; any malformed file stops the load. */
export function loadFixtures(directory: string): Fixture[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const value: unknown = JSON.parse(
        readFileSync(join(directory, name), "utf8"),
      );
      if (!validFixture(value)) throw new Error(`invalid fixture ${name}`);
      return value;
    });
}
