/**
 * Read-only process observation and guarded signalling for the embedded execution port
 * (architecture "身份、存储与事务": 只向已匹配身份的本次进程发信号; RUNTIME-04: Host 不向目标
 * session 外的进程发信号). Identity is the tuple (pid, uid, kernel start time, executable
 * image) read by the bundled native helper; the process table for descendant discovery is
 * the helper's parent-link scan. A signal is only ever sent to a PID whose current
 * observation classifies as LIVE (or IMAGE_CHANGED, the same process after exec) against a
 * registered identity and whose session is the target's session. Nothing here matches
 * processes by name, and the helper never enumerates for signalling.
 */
import { execFile } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { invokeProcessHelper } from "./codex-process";
import type { EscapedProcess } from "../shared/runtime-execution";

/** One process as the helper reports it (`inspect PID` and each `scan` row). */
export interface ProcessObservation {
  pid: number;
  info_size: number;
  expected_size: number;
  info_errno: number;
  path_size: number;
  path_errno: number;
  kill_result: number;
  kill_errno: number;
  uid: number;
  parent: number;
  group: number;
  session: number;
  status: number;
  startSeconds: number;
  startMicros: number;
  path: string;
}
/** The registered identity of one process: the tuple plus the placement read at registration. */
export interface RegisteredProcess {
  pid: number;
  uid: number;
  startSeconds: number;
  startMicros: number;
  path: string;
  parent: number;
  group: number;
  session: number;
  registeredAt: string;
}
export type Classification =
  | "LIVE"
  | "IMAGE_CHANGED"
  | "GROUP_CHANGED"
  | "ZOMBIE_UNREAPED"
  | "IDENTITY_CONFLICT"
  | "ABSENT"
  | "OBSERVATION_DENIED"
  | "OBSERVATION_UNKNOWN";
const EPERM = 1;
const ESRCH = 3;
const SZOMB = 5;
const TUPLE = ["pid", "uid", "startSeconds", "startMicros", "path"] as const;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export class ProcessObservationError extends Error {
  constructor(
    readonly code:
      | "HELPER_MISSING"
      | "HELPER_FAILED"
      | "OBSERVER_BUDGET"
      | "REGISTRATION_IDENTITY"
      | "SIGNAL_BUDGET"
      | "SIGNAL_STAGE",
    message: string,
  ) {
    super(message);
  }
}

function isObservation(value: unknown): value is ProcessObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const row = value as Record<string, unknown>;
  const numbers = [
    "pid",
    "info_size",
    "expected_size",
    "info_errno",
    "path_size",
    "path_errno",
    "kill_result",
    "kill_errno",
    "uid",
    "parent",
    "group",
    "session",
    "status",
    "startSeconds",
    "startMicros",
  ];
  return (
    numbers.every((key) => Number.isSafeInteger(row[key])) &&
    typeof row.path === "string"
  );
}
function isScanRow(
  value: unknown,
): value is Omit<
  ProcessObservation,
  | "info_size"
  | "expected_size"
  | "info_errno"
  | "path_size"
  | "path_errno"
  | "kill_result"
  | "kill_errno"
> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const row = value as Record<string, unknown>;
  return (
    [
      "pid",
      "parent",
      "group",
      "uid",
      "session",
      "status",
      "startSeconds",
      "startMicros",
    ].every((key) => Number.isSafeInteger(row[key])) &&
    typeof row.path === "string"
  );
}

/**
 * OD-224 classification: EPERM on either probe is a denied observation; ESRCH from both
 * proc_pidinfo and kill(pid, 0) proves absence; an incomplete read is unknown; any tuple
 * field differing is another process (PID reuse); a zombie keeps its identity but is not
 * running; a changed group is still the same process. IMAGE_CHANGED (pid, uid and start
 * time equal, image different) is the same process after exec (a launcher chain or an
 * interpreter re-executing itself, KB-209) and is treated as the registered one.
 */
export function classify(
  expected: Pick<RegisteredProcess, (typeof TUPLE)[number] | "group">,
  observed: ProcessObservation,
): Classification {
  if (observed.info_errno === EPERM || observed.kill_errno === EPERM)
    return "OBSERVATION_DENIED";
  if (
    observed.info_size === 0 &&
    observed.info_errno === ESRCH &&
    observed.kill_result === -1 &&
    observed.kill_errno === ESRCH
  )
    return "ABSENT";
  if (
    observed.info_size !== observed.expected_size ||
    observed.info_size <= 0 ||
    observed.path_size <= 0 ||
    observed.kill_result !== 0
  )
    return "OBSERVATION_UNKNOWN";
  const tupleMatches = TUPLE.filter((key) => key !== "path").every(
    (key) => observed[key] === expected[key],
  );
  if (!tupleMatches) return "IDENTITY_CONFLICT";
  if (observed.path !== expected.path) return "IMAGE_CHANGED";
  if (observed.status === SZOMB) return "ZOMBIE_UNREAPED";
  if (observed.group !== expected.group) return "GROUP_CHANGED";
  return "LIVE";
}
/** The classifications under which the observed process is the registered one and running. */
export const sameProcess = (state: Classification) =>
  state === "LIVE" || state === "IMAGE_CHANGED" || state === "GROUP_CHANGED";
/** A registered identity from one LIVE observation; the caller pins the expected uid, parent and image. */
export function registration(
  observed: ProcessObservation,
  expected: { uid: number; parent?: number; image?: string },
): RegisteredProcess {
  if (
    observed.info_size !== observed.expected_size ||
    observed.info_size <= 0 ||
    observed.path_size <= 0 ||
    observed.kill_result !== 0 ||
    observed.status === SZOMB
  )
    throw new ProcessObservationError(
      "REGISTRATION_IDENTITY",
      "process " + observed.pid + " is not observable as a live process",
    );
  if (observed.uid !== expected.uid)
    throw new ProcessObservationError(
      "REGISTRATION_IDENTITY",
      "process " +
        observed.pid +
        " runs as uid " +
        observed.uid +
        ", not " +
        expected.uid,
    );
  if (expected.parent !== undefined && observed.parent !== expected.parent)
    throw new ProcessObservationError(
      "REGISTRATION_IDENTITY",
      "process " + observed.pid + " has parent " + observed.parent,
    );
  if (expected.image !== undefined && observed.path !== expected.image)
    throw new ProcessObservationError(
      "REGISTRATION_IDENTITY",
      "process " +
        observed.pid +
        " runs image " +
        observed.path +
        ", expected " +
        expected.image,
    );
  return {
    pid: observed.pid,
    uid: observed.uid,
    startSeconds: observed.startSeconds,
    startMicros: observed.startMicros,
    path: observed.path,
    parent: observed.parent,
    group: observed.group,
    session: observed.session,
    registeredAt: nowIso(),
  };
}
/** Contract ProcessIdentity (pid, startTime, image) of a registered process. */
export function schemaIdentity(reg: {
  pid: number;
  startSeconds: number;
  startMicros: number;
  path: string;
}) {
  return {
    pid: reg.pid,
    startTime: new Date(
      reg.startSeconds * 1000 + Math.floor(reg.startMicros / 1000),
    ).toISOString(),
    image: reg.path,
  };
}
/** Whether a process (registered or observed) belongs to the target's session; the target is its own session leader. */
export const inTargetSession = (
  process: { session: number },
  target: { pid: number },
) => process.session === target.pid;

/** Counts and bounds helper invocations for one execution; every call is a read. */
export class ProcessObserver {
  count = 0;
  constructor(
    readonly helper: string,
    readonly limit = 100_000,
  ) {}
  async inspect(pid: number): Promise<ProcessObservation> {
    if (!Number.isSafeInteger(pid) || pid < 2)
      throw new ProcessObservationError("HELPER_FAILED", "invalid pid " + pid);
    if (++this.count > this.limit)
      throw new ProcessObservationError(
        "OBSERVER_BUDGET",
        "observation budget exhausted",
      );
    const row = await this.invoke(["inspect", String(pid)]);
    if (!isObservation(row) || row.pid !== pid)
      throw new ProcessObservationError(
        "HELPER_FAILED",
        "helper returned no observation for " + pid,
      );
    return row;
  }
  /** Descendants of a root by parent links (the root row included when alive). */
  async scan(rootPid: number) {
    if (!Number.isSafeInteger(rootPid) || rootPid < 2)
      throw new ProcessObservationError(
        "HELPER_FAILED",
        "invalid pid " + rootPid,
      );
    if (++this.count > this.limit)
      throw new ProcessObservationError(
        "OBSERVER_BUDGET",
        "observation budget exhausted",
      );
    const rows = await this.invoke(["scan", String(rootPid)]);
    if (!Array.isArray(rows) || rows.length > 4096 || !rows.every(isScanRow))
      throw new ProcessObservationError(
        "HELPER_FAILED",
        "helper returned no process table for " + rootPid,
      );
    return rows;
  }
  /** Signals one registered process only when its start time still matches; the helper does the final check. */
  async signal(reg: RegisteredProcess, stage: "TERM" | "KILL") {
    const matched = await this.invoke([
      stage === "TERM" ? "term" : "stop",
      String(reg.pid),
      String(reg.startSeconds),
      String(reg.startMicros),
    ]);
    return matched === true;
  }
  /** Every helper failure (missing binary, timeout, malformed output) is one observation error; nothing is inferred from it. */
  private async invoke(args: string[]) {
    try {
      return await invokeProcessHelper(this.helper, args);
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause as
        | (Error & { code?: unknown; signal?: unknown; killed?: unknown })
        | undefined;
      throw new ProcessObservationError(
        "HELPER_FAILED",
        "process helper " +
          args[0] +
          " failed: " +
          (cause instanceof Error
            ? cause.message.split("\n")[0] +
              " (code " +
              String(cause.code ?? "none") +
              ", signal " +
              String(cause.signal ?? "none") +
              (cause.killed ? ", killed by the invocation budget" : "") +
              ")"
            : (error as Error).message),
      );
    }
  }
  /** Polls one identity until it is gone or another process holds the pid, bounded. */
  async waitAbsent(reg: RegisteredProcess, ms: number, interval = 100) {
    const deadline = Date.now() + ms;
    for (;;) {
      const observed = await this.inspect(reg.pid);
      const state = classify(reg, observed);
      if (
        state === "ABSENT" ||
        state === "IDENTITY_CONFLICT" ||
        Date.now() >= deadline
      )
        return { state, observed };
      await wait(interval);
    }
  }
}

export interface SignalRow {
  at: string;
  label: string;
  stage: "TERM" | "KILL";
  pid: number;
  classification: Classification;
  /** false: refused before any syscall (identity or session rule), true: the helper sent it or found the pid gone. */
  sent: boolean;
  reason: string;
}
export type SignalBudget = { TERM: number; KILL: number };
/**
 * Every kill(2) is classified before the syscall and recorded after it. The budget bounds
 * the signals of one execution per stage (the design: 1 + the registered descendants, so it
 * is read at each send); a refused signal counts against nothing, and an observation that
 * fails is recorded as a refusal and rethrown so the caller stops signalling.
 */
export class SignalLedger {
  readonly rows: SignalRow[] = [];
  private used = { TERM: 0, KILL: 0 };
  constructor(
    private readonly observer: ProcessObserver,
    private readonly target: { pid: number },
    private readonly budget: SignalBudget | (() => SignalBudget),
  ) {}
  private limit(stage: "TERM" | "KILL") {
    return (typeof this.budget === "function" ? this.budget() : this.budget)[
      stage
    ];
  }
  /**
   * Classifies `reg` (from `observed` when the caller just inspected it, else from a fresh
   * inspection) and signals only a LIVE or IMAGE_CHANGED process inside the target's session.
   */
  async send(
    reg: RegisteredProcess,
    stage: "TERM" | "KILL",
    label: string,
    observed?: ProcessObservation,
  ) {
    if (stage !== "TERM" && stage !== "KILL")
      throw new ProcessObservationError("SIGNAL_STAGE", "unknown stage");
    const row: SignalRow = {
      at: nowIso(),
      label,
      stage,
      pid: reg.pid,
      classification: "OBSERVATION_UNKNOWN",
      sent: false,
      reason: "",
    };
    try {
      observed ??= await this.observer.inspect(reg.pid);
    } catch (error) {
      row.reason = "observer: " + (error as Error).message;
      this.rows.push(row);
      throw error;
    }
    const classification = classify(reg, observed);
    row.classification = classification;
    if (!sameProcess(classification)) {
      row.reason = "identity not LIVE";
      this.rows.push(row);
      return row;
    }
    if (!inTargetSession(observed, this.target)) {
      row.reason = "outside the target session";
      this.rows.push(row);
      return row;
    }
    if (this.used[stage] >= this.limit(stage)) {
      row.reason = "signal budget exhausted";
      this.rows.push(row);
      throw new ProcessObservationError(
        "SIGNAL_BUDGET",
        stage + " budget exhausted",
      );
    }
    this.used[stage] += 1;
    try {
      row.sent = await this.observer.signal(reg, stage);
    } catch (error) {
      row.reason = "observer: " + (error as Error).message;
      this.rows.push(row);
      throw error;
    }
    row.reason = row.sent ? "sent" : "start time no longer matches";
    this.rows.push(row);
    return row;
  }
  counts() {
    return { ...this.used };
  }
}

/** Whether an observation state means the registered process is gone (exited, or its pid now belongs to another process). */
export const gone = (state: Classification) =>
  state === "ABSENT" || state === "IDENTITY_CONFLICT";
export interface ReclaimOutcome {
  /** Registered descendants inside the target's session that were signalled and are gone. */
  reclaimed: RegisteredProcess[];
  /** Registered descendants inside the session still observable (or unobservable) after the budgeted signals. */
  remaining: RegisteredProcess[];
  /** Processes outside the target's session that are still alive: never signalled (RUNTIME-04). */
  escaped: EscapedProcess[];
  errors: string[];
}
/**
 * Reclaims the target's registered descendants after the target exited: each one is
 * inspected and classified; a process that is gone (ESRCH, or another process holds the
 * pid) needs nothing; a PID reuse is refused through the ledger so the refusal is on
 * record; one that is still the registered process inside the target's session gets TERM,
 * then KILL after the cleanup budget; one outside the session is listed as escaped and is
 * never signalled. An exhausted signal budget or a failing observer stops the reclaim: the
 * rest is reported as remaining, nothing is retried.
 */
export async function reclaimDescendants(input: {
  observer: ProcessObserver;
  ledger: SignalLedger;
  target: RegisteredProcess;
  children: Iterable<RegisteredProcess>;
  unregistered: Iterable<{ pid: number; uid: number; parent: number }>;
  cleanupMs: number;
  killWaitMs?: number;
}): Promise<ReclaimOutcome> {
  const { observer, ledger, target } = input;
  const outcome: ReclaimOutcome = {
    reclaimed: [],
    remaining: [],
    escaped: [],
    errors: [],
  };
  let halted = false;
  for (const child of input.children) {
    if (halted) {
      outcome.remaining.push(child);
      continue;
    }
    let observed: ProcessObservation;
    try {
      observed = await observer.inspect(child.pid);
    } catch (error) {
      outcome.errors.push(
        "child " + child.pid + ": " + (error as Error).message,
      );
      outcome.remaining.push(child);
      halted = true;
      continue;
    }
    const state = classify(child, observed);
    if (state === "ABSENT") continue;
    if (state === "IDENTITY_CONFLICT") {
      // PID reuse: the refusal is recorded, no syscall reaches the other process.
      await ledger.send(child, "TERM", "cleanup", observed).catch(() => null);
      continue;
    }
    if (!sameProcess(state) && state !== "ZOMBIE_UNREAPED") {
      outcome.errors.push("child " + child.pid + ": " + state);
      outcome.remaining.push(child);
      continue;
    }
    if (!inTargetSession(observed, target)) {
      outcome.escaped.push({
        identity: schemaIdentity(child),
        session: observed.session,
        kind: "registered",
      });
      continue;
    }
    try {
      await ledger.send(child, "TERM", "cleanup", observed);
      let after = await observer.waitAbsent(child, input.cleanupMs);
      if (!gone(after.state)) {
        await ledger.send(child, "KILL", "cleanup", after.observed);
        after = await observer.waitAbsent(child, input.killWaitMs ?? 3000);
      }
      if (gone(after.state)) outcome.reclaimed.push(child);
      else outcome.remaining.push(child);
    } catch (error) {
      outcome.errors.push(
        "child " + child.pid + ": " + (error as Error).message,
      );
      outcome.remaining.push(child);
      halted = true;
    }
  }
  for (const row of input.unregistered) {
    const observed = await observer.inspect(row.pid).catch(() => null);
    if (
      observed &&
      observed.info_size > 0 &&
      observed.parent === row.parent &&
      observed.uid === row.uid
    )
      outcome.escaped.push({
        identity: { pid: row.pid, startTime: nowIso(), image: observed.path },
        session: observed.session,
        kind: "unregistered",
      });
  }
  return outcome;
}

/** Boot identity (kern.boottime seconds and the boot session uuid), read once per process. */
let boot: Promise<string> | undefined;
export function bootId(): Promise<string> {
  return (boot ??= new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-n", "kern.boottime", "kern.bootsessionuuid"],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 2000, encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(error);
        const [time = "", uuid = ""] = stdout.trim().split("\n");
        const seconds =
          /sec = (\d+)/.exec(time)?.[1] ?? time.replace(/\s+/g, "_");
        resolve("boot:" + seconds + "/" + uuid.trim());
      },
    );
  }));
}
