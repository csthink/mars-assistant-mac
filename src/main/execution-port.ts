/**
 * Embedded execution port (feature-t30): the Host's own physical execution writer for
 * `host.execution.*`. For every accepted reservation it follows the Contract's release
 * order (预约已持久化 → 独占物理记录 → 创建尚未放行目标 → 记录真实身份 → 放行执行): the
 * shared observation record is created exclusively, the target is spawned as its own
 * session leader with nothing written to its stdin, its identity is read through the
 * native helper and pinned, and only then is the first byte written (the release
 * boundary). While the target runs the port registers every descendant by identity,
 * counts protocol output for the budgets and stops the target by identity when a budget
 * or a cancel says so. Agent-specific argv, protocol parsing and native interrupts live
 * in adapters; the port never interprets context data and never signals a process it did
 * not register or that left the target's session (RUNTIME-04).
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { ExecutionResultReadError } from "./runtime-execution-port";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type {
  ExecutionContext,
  ExecutionPort,
  ExecutionProfile,
  ExecutionStartRequest,
  PreflightCheck,
  PreflightRequest,
} from "./runtime-execution-port";
import {
  ProcessObserver,
  SignalLedger,
  bootId,
  classify,
  gone,
  inTargetSession,
  reclaimDescendants,
  registration,
  sameProcess,
  schemaIdentity,
  type Classification,
  type RegisteredProcess,
} from "./execution-process";
import {
  ExecutionRecordError,
  ExecutionRecordWriter,
  gitCommonDir,
  recordSegment,
  sha256,
} from "./execution-record";
import { canonicalJson } from "../shared/runtime-host";
import type { ProgramIdentity } from "../shared/runtime-host";
import { matchesProgramIdentity } from "./execution-program";
import {
  blockedOperations,
  physicalExecutionOf,
  type PhysicalExecution,
  type ActualBinding,
  type ContractProcessIdentity,
  type ExitClassification,
  type HostExecutionRecord,
  type ProcessExit,
  type RegisteredProcessIdentity,
  type StopReason,
} from "../shared/runtime-execution";
import type { ExecutionTransition } from "./runtime-execution-port";
import type { ErrorClass } from "../shared/protocol";

type Json = Record<string, unknown>;
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const scanIntervalMs = 250;
const recheckIntervalMs = 1000;
const maxChildren = 64;

/** A refusal the adapter states before anything is spawned; it becomes a failed execution with this code. */
export class AdapterRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly errorClass: ErrorClass = "unsupported",
  ) {
    super(message);
  }
}
export interface AdapterSummary {
  actualBinding: ActualBinding | null;
  toolCalls: number;
  nativeSession: { sessionRef: string; turnRef: string | null } | null;
  /** The adapter's reading of the protocol: completed (result frame seen), failed (protocol reported an error) or null (nothing conclusive). */
  outcome: "completed" | "failed" | null;
  resultCode: string | null;
  errorClass: ErrorClass | null;
  reason: string;
  approvalDecisionRefs: string[];
  /** Non-secret result evidence the adapter contributes (read-backs, approvals, closing records). */
  evidence: Json;
}
/** The adapter's live view of one target's protocol stream. */
export interface AdapterSession {
  /** The first write to the target's stdin: the release boundary. */
  release(): Promise<void>;
  /**
   * The native interrupt that precedes any signal. "native": the target was told to stop
   * through its own protocol (Codex: turn/interrupt, the interrupted turn/completed, then end
   * of stdin) and gets the cleanup budget to exit before SIGKILL; "signal": the protocol has
   * no interrupt (Claude print: stdin already ended), so the port sends SIGTERM by identity
   * at once and SIGKILL after the cleanup budget.
   */
  interrupt(): Promise<"native" | "signal">;
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
  /** Called when the target's pipes ended, before the summary is read. */
  onEnd(): void;
  summary(): AdapterSummary;
}
export interface LaunchPlan {
  executable: string;
  /** The discovered Reviewer launcher, fixed before spawn and rechecked before release. */
  programIdentity?: ProgramIdentity;
  /** The image the helper must report for the target (the binary, or a script's interpreter). */
  expectedImage: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  effort: string | null;
  /** Facts the record discloses about the launch (KB-190: home-directory writes outside the target tree). */
  disclosures: string[];
  session(child: ChildProcess, hooks: SessionHooks): AdapterSession;
}
/**
 * One transcript entry: the adapter's redacted reading of a protocol frame or stream chunk
 * plus the protocol bytes it accounts for (stdout line and newline, stderr chunk, the
 * unterminated tail, 0 for the adapter's own writes). The sum over the transcript is the
 * execution's output byte count, which the port measures on the pipes and the audit
 * recomputes from the transcript (LOG-01: accounting equal to the protocol output).
 */
export type TranscriptEntry = Json & { bytes: number };
export interface SessionHooks {
  /** A protocol frame counted as one tool call (budget.maxToolCalls). */
  toolCall(): void;
  /** Transcript entry (already redacted by the adapter) kept as Host evidence. */
  transcript(entry: TranscriptEntry): void;
  /**
   * The adapter's reading of the protocol says the execution must not continue (a start
   * read-back that differs from the request, a server request outside the profile): the
   * target is stopped by identity and the execution is recorded failed with this code. A
   * stop already under way (cancel, budget) keeps its own reason.
   */
  fail(code: string, message: string, errorClass: ErrorClass): void;
  /** A native approval decision, persisted at once: the ref joins approvalDecisionRefs and the run log gets the event. */
  approval(decision: "accepted" | "rejected", ref: string, detail: Json): void;
}
export interface ExecutionAdapter {
  /** The profile this adapter offers now, or null while the program is not installed or its connection is disabled. */
  profile(): Promise<ExecutionProfile | null>;
  preflight(request: PreflightRequest): Promise<PreflightCheck[]>;
  /** Everything needed to spawn the target; throws AdapterRefusal for a combination that must not run. */
  plan(
    request: ExecutionStartRequest,
    context: ExecutionContext,
  ): Promise<LaunchPlan>;
}
export interface EmbeddedPortOptions {
  helper: string;
  adapters: ExecutionAdapter[];
  /** Host evidence root: result documents and transcripts, one directory per execution. */
  evidenceRoot: string;
  /** Fallback root for the shared record when the resource is not a Git repository. */
  recordFallbackRoot: string;
  hostImage: string;
  /** Test seam: awaited between the identity record and the release; the product passes nothing. */
  beforeRelease?: (executionRef: string, targetPid: number) => Promise<void>;
}

interface Live {
  ref: string;
  request: ExecutionStartRequest;
  context: ExecutionContext;
  record: HostExecutionRecord;
  plan: LaunchPlan;
  child: ChildProcess;
  session: AdapterSession;
  observer: ProcessObserver;
  ledger: SignalLedger | null;
  writer: ExecutionRecordWriter | null;
  target: RegisteredProcess | null;
  children: Map<number, RegisteredProcess>;
  unregistered: Map<
    number,
    { pid: number; uid: number; parent: number; observedAt: string }
  >;
  toolCalls: number;
  outputBytes: number;
  transcript: string[];
  transcriptBytes: number;
  /** Entries dropped once the transcript reached the output budget, with the protocol bytes they accounted for. */
  omitted: { lines: number; bytes: number };
  stdoutClosed: boolean;
  stderrClosed: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  exitAt: number | null;
  releasedAtMs: number | null;
  /** Set synchronously once the release is decided; an exit before it is the start path's to record. */
  released: boolean;
  stopReason: StopReason | null;
  /** Set by the adapter through hooks.fail: the exit is recorded as failed with this code. */
  failure: { code: string; message: string; errorClass: ErrorClass } | null;
  cancelRequested: boolean;
  stopping: Promise<void> | null;
  /** Resolves once the stop is under way (native interrupt delivered and the first signal decided): the cancel answers then. */
  stopInitiated: Promise<StopInitiation> | null;
  /** Serialises every persisted transition of this execution so a later write never overtakes an earlier one. */
  chain: Promise<void>;
  observationErrors: string[];
  timers: NodeJS.Timeout[];
  done: Promise<void>;
  finish: () => void;
}
interface StopInitiation {
  /** "native": the adapter interrupted the target through its protocol; "signal": SIGTERM was sent by identity; "exited": the target was already gone; "unobserved": the identity could not be observed, nothing was sent; "refused": the identity no longer classifies as the registered process. */
  how: "native" | "signal" | "exited" | "unobserved" | "refused";
  detail: string;
}

export class EmbeddedExecutionPort implements ExecutionPort {
  readonly id = "embedded";
  private readonly live = new Map<string, Live>();
  private readonly recheckers = new Map<string, NodeJS.Timeout>();
  private hostIdentity: ContractProcessIdentity | null = null;
  constructor(private readonly options: EmbeddedPortOptions) {}

  /** Read only this port's published immutable result. Memory use is bounded by one chunk even for a large result. */
  readResult(
    record: HostExecutionRecord,
    offset: number,
    length: number,
  ): Buffer {
    const ref = record.resultRef;
    if (
      record.portId !== this.id ||
      !ref ||
      ref.objectRef !== "execution-result:" + record.executionRef
    )
      throw new ExecutionResultReadError(
        "INTEGRITY_MISMATCH",
        "result does not belong to this port and execution",
      );
    let fd: number | undefined;
    try {
      const root = realpathSync(this.options.evidenceRoot);
      const dir = join(root, recordSegment(record.executionRef));
      const directory = lstatSync(dir);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync(dir) !== dir
      )
        throw new ExecutionResultReadError(
          "INTEGRITY_MISMATCH",
          "result directory identity changed",
        );
      const path = join(dir, "result.json");
      const identity = lstatSync(path);
      if (!identity.isFile() || identity.isSymbolicLink())
        throw new ExecutionResultReadError(
          "INTEGRITY_MISMATCH",
          "result is not a regular file",
        );
      // Darwin fcntl.h: O_NOFOLLOW_ANY rejects symlinks in every path component,
      // including a directory replaced between the checks and open. This port is macOS-only.
      if (process.platform !== "darwin")
        throw new ExecutionResultReadError(
          "RESULT_UNKNOWN",
          "safe result opening is unavailable on this platform",
        );
      const noFollowAny = 0x20000000;
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny,
      );
      const file = fstatSync(fd);
      if (
        !file.isFile() ||
        file.size !== ref.bytes ||
        file.dev !== identity.dev ||
        file.ino !== identity.ino
      )
        throw new ExecutionResultReadError(
          "INTEGRITY_MISMATCH",
          "result type or byte length changed",
        );
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(65536);
      const chunk = Buffer.alloc(Math.min(length, ref.bytes - offset));
      let position = 0;
      while (position < ref.bytes) {
        const count = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, ref.bytes - position),
          position,
        );
        if (!count)
          throw new ExecutionResultReadError(
            "INTEGRITY_MISMATCH",
            "result ended before its fixed length",
          );
        hash.update(buffer.subarray(0, count));
        const from = Math.max(position, offset),
          to = Math.min(position + count, offset + chunk.length);
        if (to > from)
          buffer.copy(chunk, from - offset, from - position, to - position);
        position += count;
      }
      const after = fstatSync(fd),
        afterPath = lstatSync(path),
        afterDirectory = lstatSync(dir);
      if (
        readSync(fd, buffer, 0, 1, position) !== 0 ||
        hash.digest("hex") !== ref.digest ||
        afterPath.dev !== file.dev ||
        afterPath.ino !== file.ino ||
        afterPath.isSymbolicLink() ||
        after.size !== file.size ||
        after.mtimeMs !== file.mtimeMs ||
        after.ctimeMs !== file.ctimeMs ||
        afterDirectory.dev !== directory.dev ||
        afterDirectory.ino !== directory.ino ||
        realpathSync(dir) !== dir
      )
        throw new ExecutionResultReadError(
          "INTEGRITY_MISMATCH",
          "fixed result content or directory changed",
        );
      return chunk;
    } catch (error) {
      if (error instanceof ExecutionResultReadError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ELOOP")
        throw new ExecutionResultReadError(
          "INTEGRITY_MISMATCH",
          "result file is a symbolic link",
        );
      throw new ExecutionResultReadError(
        "RESULT_UNKNOWN",
        "fixed result storage is unavailable",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  async profilesAsync() {
    const profiles: ExecutionProfile[] = [];
    for (const adapter of this.options.adapters) {
      const profile = await adapter.profile();
      if (profile) profiles.push(profile);
    }
    return profiles;
  }
  /** The synchronous catalogue the Host offers at initialize; adapters refresh it through refreshProfiles. */
  private cached: ExecutionProfile[] = [];
  profiles() {
    return this.cached;
  }
  async refreshProfiles() {
    this.cached = await this.profilesAsync();
    return this.cached;
  }
  /** Adds an adapter (the product wires its own at start; tests add fixture adapters through the application event). */
  registerAdapter(adapter: ExecutionAdapter) {
    this.options.adapters.push(adapter);
  }
  private async adapterFor(profileId: string, profileDigest: string) {
    for (const adapter of this.options.adapters) {
      const profile = await adapter.profile();
      if (
        profile &&
        profile.id === profileId &&
        profile.digest === profileDigest
      )
        return { adapter, profile };
    }
    return null;
  }
  async preflight(request: PreflightRequest): Promise<PreflightCheck[]> {
    const found = await this.adapterFor(
      request.profileId,
      request.profileDigest,
    );
    if (!found)
      return [
        {
          id: "execution-profile",
          passed: false,
          detail: "no verified execution profile with this identity is offered",
        },
      ];
    return found.adapter.preflight(request);
  }
  private async supervisorIdentity(observer: ProcessObserver) {
    if (this.hostIdentity) return this.hostIdentity;
    const observed = await observer.inspect(process.pid);
    this.hostIdentity = schemaIdentity(observed);
    return this.hostIdentity;
  }

  // ---------------------------------------------------------------- start
  async start(
    executionRef: string,
    request: ExecutionStartRequest,
    context: ExecutionContext,
  ): Promise<Json> {
    if (this.live.has(executionRef))
      return { status: "running", reason: "already started" };
    const observer = new ProcessObserver(this.options.helper);
    const fail = async (
      code: string,
      reason: string,
      errorClass: ErrorClass = "unsupported",
    ) => {
      await context.transition({
        record: {
          ...context.record,
          state: "failed",
          reason: reason.slice(0, 2048),
          observationCompleteness: "complete",
          updatedAt: nowIso(),
        },
        event: {
          kind: "failed",
          payload: { resultCode: code, errorClass, message: reason },
        },
        pending: null,
      });
      return { status: "failed", resultCode: code, reason };
    };
    const found = await this.adapterFor(
      request.profileId,
      request.profileDigest,
    );
    if (!found)
      return fail(
        "UNSUPPORTED_CAPABILITY",
        "no adapter offers profile " + request.profileId,
      );
    let plan: LaunchPlan;
    try {
      plan = await found.adapter.plan(request, context);
    } catch (error) {
      if (error instanceof AdapterRefusal)
        return fail(error.code, error.message, error.errorClass);
      return fail("ACCEPT_ABORTED", (error as Error).message);
    }
    if (
      found.profile.purpose === "review" &&
      (!plan.programIdentity ||
        !matchesProgramIdentity(plan.executable, plan.programIdentity))
    )
      return fail(
        "IDENTITY_MISMATCH",
        "Reviewer program identity changed before spawn",
      );
    // 1. Exclusive shared observation record in the resource's Git common directory.
    let writer: ExecutionRecordWriter;
    const root =
      (context.resource ? gitCommonDir(context.resource.path) : null) ??
      this.options.recordFallbackRoot;
    const fallback =
      !context.resource || gitCommonDir(context.resource.path) === null;
    try {
      writer = ExecutionRecordWriter.create(root, request.operationId);
    } catch (error) {
      const code =
        error instanceof ExecutionRecordError && error.code === "RECORD_EXISTS"
          ? "RECORD_EXISTS"
          : "ACCEPT_ABORTED";
      return fail(code, (error as Error).message);
    }
    const supervisor = await this.supervisorIdentity(observer);
    const boot = await bootId();
    const uid = process.getuid?.() ?? 0;
    const observationErrors = fallback
      ? ["resource is not a git repository; record kept in the host directory"]
      : [];
    const base = {
      executionRequestId: recordSegment(request.operationId),
      executionId: executionRef,
      intentDigest: request.requestDigest,
      profileDigest: request.profileDigest,
      executionPort: "embedded" as const,
      bootId: boot,
      uid,
      supervisor,
      target: null as ContractProcessIdentity | null,
      processGroup: null as number | null,
      children: [] as ContractProcessIdentity[],
      nativeSession: null as {
        sessionRef: string;
        turnRef: string | null;
      } | null,
      released: false,
      cancelRequestedAt: null as string | null,
      exit: null as ProcessExit | null,
      observationErrors,
      result: null as { digest: string; locator: string } | null,
    };
    writer.write(base);
    let record = await context.transition({
      record: {
        ...context.record,
        supervisor,
        recordLocator: writer.locator,
        effort: plan.effort,
        connectionId: context.connectionId,
        updatedAt: nowIso(),
      },
      event: null,
      pending: null,
    });
    // 2. The target: its own session leader, nothing written to stdin yet.
    let child: ChildProcess;
    try {
      child = spawn(plan.executable, plan.argv, {
        cwd: plan.cwd,
        env: plan.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return fail(
        "ACCEPT_ABORTED",
        "spawn failed: " + (error as Error).message,
      );
    }
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live: Live = {
      ref: executionRef,
      request,
      context,
      record,
      plan,
      child,
      session: null as unknown as AdapterSession,
      observer,
      ledger: null,
      writer,
      target: null,
      children: new Map(),
      unregistered: new Map(),
      toolCalls: 0,
      outputBytes: 0,
      transcript: [],
      transcriptBytes: 0,
      omitted: { lines: 0, bytes: 0 },
      stdoutClosed: false,
      stderrClosed: false,
      exit: null,
      exitAt: null,
      releasedAtMs: null,
      released: false,
      stopReason: null,
      failure: null,
      cancelRequested: false,
      stopping: null,
      stopInitiated: null,
      chain: Promise.resolve(),
      observationErrors: [...observationErrors],
      timers: [],
      done,
      finish,
    };
    live.session = plan.session(child, {
      toolCall: () => {
        live.toolCalls += 1;
        if (live.toolCalls > record.budget.maxToolCalls && !live.stopReason)
          void this.stop(live, "tool-call-budget", "tool call budget exceeded");
      },
      transcript: (entry) => {
        const line = JSON.stringify(entry);
        live.transcriptBytes += Buffer.byteLength(line) + 1;
        if (live.transcriptBytes <= record.budget.maxOutputBytes)
          live.transcript.push(line);
        else {
          live.omitted.lines += 1;
          live.omitted.bytes += entry.bytes;
        }
      },
      fail: (code, message, errorClass) => {
        if (live.stopReason || live.failure || live.exit) return;
        live.failure = { code, message: message.slice(0, 2048), errorClass };
        void this.terminate(live, "adapter: " + message);
      },
      approval: (decision, ref, detail) => {
        void this.recordApproval(live, decision, ref, detail);
      },
    });
    this.live.set(executionRef, live);
    // Output bytes are measured on the pipes (stdout plus stderr, budget.maxOutputBytes); the adapter only reads.
    const output = (chunk: Buffer) => {
      live.outputBytes += chunk.length;
      if (live.outputBytes > record.budget.maxOutputBytes && !live.stopReason)
        void this.stop(live, "output-limit", "output byte budget exceeded");
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      output(chunk);
      live.session.onStdout(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      output(chunk);
      live.session.onStderr(chunk);
    });
    child.stdout!.on("close", () => {
      live.stdoutClosed = true;
    });
    child.stderr!.on("close", () => {
      live.stderrClosed = true;
    });
    child.stdin!.on("error", () => {
      /* EPIPE after the target exited: the exit path records it. */
    });
    const spawned = new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error) => resolve(error));
    });
    child.once("exit", (code, signal) => {
      live.exit = { code, signal };
      live.exitAt = Date.now();
      if (live.released && this.live.get(executionRef) === live)
        void this.settle(live);
    });
    const spawnError = await spawned;
    if (spawnError || !child.pid) {
      this.live.delete(executionRef);
      return fail(
        "ACCEPT_ABORTED",
        "spawn failed: " + (spawnError?.message ?? "no pid"),
      );
    }
    // 3. Real identity: uid, parent and image must match before anything is released.
    let target: RegisteredProcess;
    try {
      target = registration(await observer.inspect(child.pid), {
        uid,
        parent: process.pid,
        image: plan.expectedImage,
      });
    } catch (error) {
      live.observationErrors.push("identity: " + (error as Error).message);
      await this.endUnreleased(
        live,
        "identity check failed: " + (error as Error).message,
      );
      return {
        status: "failed",
        resultCode: "IDENTITY_MISMATCH",
        reason: (error as Error).message,
      };
    }
    live.target = target;
    // The budget per stage is 1 + the registered descendants, read at each send.
    live.ledger = new SignalLedger(observer, target, () => ({
      TERM: 1 + live.children.size,
      KILL: 1 + live.children.size,
    }));
    const targetIdentity = registered(target);
    writer.write({
      ...base,
      target: schemaIdentity(target),
      processGroup: target.group,
    });
    if (this.options.beforeRelease)
      await this.options.beforeRelease(executionRef, target.pid);
    if (
      plan.programIdentity &&
      !matchesProgramIdentity(plan.executable, plan.programIdentity)
    ) {
      live.observationErrors.push("program identity changed before release");
      await this.endUnreleased(live, "program identity changed before release");
      return {
        status: "failed",
        resultCode: "IDENTITY_MISMATCH",
        reason: "program identity changed before release",
      };
    }
    if (live.exit) {
      // Exited before release: never ran any business; recorded as unknown, not completed.
      await this.endUnreleased(live, "target exited before release");
      return { status: "unknown", reason: "target exited before release" };
    }
    // 4. Release: decided here (no await between the exit check and this flag), recorded before the first byte.
    live.released = true;
    const releasedAt = nowIso();
    writer.write({
      ...base,
      target: schemaIdentity(target),
      processGroup: target.group,
      released: true,
    });
    live.releasedAtMs = Date.now();
    live.record = record;
    record = await this.update(live, (current) => ({
      record: {
        ...current,
        state: "running",
        target: targetIdentity,
        releasedAt,
        observationCompleteness: "complete",
        reason: "released",
        updatedAt: releasedAt,
      },
      event: {
        kind: "started",
        payload: {
          pid: target.pid,
          image: target.path,
          effort: plan.effort,
        },
      },
      pending: null,
    }));
    try {
      await live.session.release();
    } catch (error) {
      live.observationErrors.push("release: " + (error as Error).message);
      // Release confirmation missing: conservative partial observation, then stop.
      void this.stop(
        live,
        "signal",
        "release failed: " + (error as Error).message,
      );
    }
    // 5. Supervision: descendant registration and the run-time budget.
    live.timers.push(
      setInterval(() => void this.scan(live), scanIntervalMs),
      setTimeout(
        () => void this.stop(live, "timeout", "run time budget exceeded"),
        record.budget.maxRunSeconds * 1000,
      ),
    );
    for (const timer of live.timers) timer.unref?.();
    return { status: "running", reason: "released" };
  }

  private async endUnreleased(live: Live, reason: string) {
    for (const timer of live.timers) clearInterval(timer);
    if (live.target && !live.exit) {
      // Only the identity we just registered, only while it is still that process.
      try {
        await live.ledger!.send(live.target, "KILL", "unreleased");
        await live.observer.waitAbsent(live.target, 2000);
      } catch (error) {
        live.observationErrors.push("unreleased: " + (error as Error).message);
      }
    } else if (!live.target && !live.exit) {
      try {
        live.child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    live.writer?.write({
      executionRequestId: recordSegment(live.request.operationId),
      executionId: live.ref,
      intentDigest: live.request.requestDigest,
      profileDigest: live.request.profileDigest,
      executionPort: "embedded",
      bootId: await bootId(),
      uid: process.getuid?.() ?? 0,
      supervisor: this.hostIdentity!,
      target: live.target ? schemaIdentity(live.target) : null,
      processGroup: live.target?.group ?? null,
      children: [],
      nativeSession: null,
      released: false,
      cancelRequestedAt: null,
      exit: null,
      observationErrors: live.observationErrors,
      result: null,
    });
    this.live.delete(live.ref);
    live.finish();
    await live.context.transition({
      record: {
        ...live.record,
        state: live.target ? "unknown" : "failed",
        target: live.target ? registered(live.target) : null,
        observationCompleteness: "partial",
        reason: reason.slice(0, 2048),
        updatedAt: nowIso(),
      },
      event: {
        kind: live.target ? "interrupted" : "failed",
        payload: { message: reason },
      },
      pending: null,
    });
  }

  // ---------------------------------------------------------------- persisted transitions
  /**
   * Every persisted transition of one execution goes through its chain: the record the
   * function receives is the last one written, and a later transition can never overtake an
   * earlier one (the cancel's stopping, a registered child, an approval and the terminal
   * record are written in the order they were decided).
   */
  private update(
    live: Live,
    next: (current: HostExecutionRecord) => ExecutionTransition,
  ): Promise<HostExecutionRecord> {
    const run = live.chain.then(async () => {
      live.record = await live.context.transition(next(live.record));
      return live.record;
    });
    live.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /** The shared observation record as the supervisor sees the execution now (seq is appended by the writer). */
  private async shared(live: Live, patch: Partial<Json> = {}) {
    if (!live.writer || !live.target) return;
    live.writer.write({
      executionRequestId: recordSegment(live.request.operationId),
      executionId: live.ref,
      intentDigest: live.request.requestDigest,
      profileDigest: live.request.profileDigest,
      executionPort: "embedded",
      bootId: await bootId(),
      uid: process.getuid?.() ?? 0,
      supervisor: this.hostIdentity!,
      target: schemaIdentity(live.target),
      processGroup: live.target.group,
      children: [...live.children.values()].map(schemaIdentity).slice(0, 64),
      nativeSession: null,
      released: live.released,
      cancelRequestedAt: live.record.cancelRequestedAt,
      exit: null,
      observationErrors: live.observationErrors,
      result: null,
      ...patch,
    });
  }

  // ---------------------------------------------------------------- supervision
  private scanning = new Set<string>();
  /**
   * Registers every new descendant by identity (uid must be this process's uid, KB-213 for
   * the rest) and persists the registration at once: a restarted Host recovers escaped
   * descendants from the record, not from memory.
   */
  private async scan(live: Live) {
    if (!live.target || live.exit || this.scanning.has(live.ref)) return;
    this.scanning.add(live.ref);
    try {
      const rows = await live.observer.scan(live.target.pid);
      const uid = process.getuid?.() ?? 0;
      let changed = false;
      for (const row of rows) {
        if (row.pid === live.target.pid || live.children.has(row.pid)) continue;
        if (row.uid !== uid) {
          if (!live.unregistered.has(row.pid)) {
            live.unregistered.set(row.pid, {
              pid: row.pid,
              uid: row.uid,
              parent: row.parent,
              observedAt: nowIso(),
            });
            changed = true;
          }
          continue;
        }
        if (live.children.size >= maxChildren) {
          live.observationErrors.push(
            "children: more than " + maxChildren + " descendants",
          );
          void this.stop(live, "signal", "descendant limit exceeded");
          return;
        }
        live.children.set(row.pid, {
          pid: row.pid,
          uid: row.uid,
          startSeconds: row.startSeconds,
          startMicros: row.startMicros,
          path: row.path,
          parent: row.parent,
          group: row.group,
          session: row.session,
          registeredAt: nowIso(),
        });
        changed = true;
      }
      if (changed && !live.exit) {
        await this.shared(live);
        await this.update(live, (current) => ({
          record: {
            ...current,
            children: [...live.children.values()],
            unregisteredObservations: [...live.unregistered.values()].slice(
              0,
              64,
            ),
            updatedAt: nowIso(),
          },
          event: null,
          pending: null,
        }));
      }
    } catch (error) {
      live.observationErrors.push("scan: " + (error as Error).message);
    } finally {
      this.scanning.delete(live.ref);
    }
  }
  /** Stops the target for a Contract stop reason (cancel or a budget): the exit is recorded as stopped. */
  private stop(live: Live, reason: StopReason, detail: string) {
    if (!live.stopping) live.stopReason ??= reason;
    return this.terminate(live, detail);
  }
  /**
   * Ends the target: the adapter's native interrupt first; SIGTERM by identity at once when
   * the protocol has no interrupt; SIGKILL by identity after the cleanup budget. Every
   * signal is a ledger decision (identity LIVE, inside the target's session, within budget);
   * an observer that fails or a refused identity sends nothing. When nothing could be sent
   * and the target does not exit within the budgets, the supervision is abandoned and the
   * execution recorded unknown with the observer's last word, never as an exit.
   */
  private terminate(live: Live, detail: string) {
    if (live.stopping) return live.stopping;
    live.observationErrors.push("stop: " + detail);
    let initiated: (value: StopInitiation) => void = () => {};
    live.stopInitiated = new Promise<StopInitiation>((resolve) => {
      initiated = resolve;
    });
    live.stopping = (async () => {
      if (live.exit || !live.target || !live.ledger) {
        initiated({ how: "exited", detail: "target already exited" });
        return;
      }
      let how: "native" | "signal" = "signal";
      try {
        how = await live.session.interrupt();
      } catch (error) {
        live.observationErrors.push("interrupt: " + (error as Error).message);
      }
      const label = "stop:" + (live.stopReason ?? live.failure?.code ?? "end");
      let lastState: Classification | null = null;
      let unobserved = false;
      const send = async (stage: "TERM" | "KILL") => {
        try {
          const row = await live.ledger!.send(live.target!, stage, label);
          lastState = row.classification;
          return row.sent ? "sent" : "refused";
        } catch (error) {
          live.observationErrors.push(stage + ": " + (error as Error).message);
          unobserved = true;
          return "unobserved";
        }
      };
      if (live.exit) {
        initiated({ how: "exited", detail: "target exited on the interrupt" });
        return;
      }
      if (how === "native") {
        initiated({
          how: "native",
          detail:
            "native interrupt delivered; waiting for the exit within the cleanup budget",
        });
      } else {
        const term = await send("TERM");
        // A SIGTERM the ledger sent is the cause even when the exit it caused is handled
        // before the helper's reply arrives.
        if (term === "sent")
          initiated({
            how: "signal",
            detail: "SIGTERM sent by identity to pid " + live.target.pid,
          });
        else if (live.exit)
          initiated({
            how: "exited",
            detail: "target exited on the interrupt",
          });
        else if (term === "refused")
          initiated({
            how: "refused",
            detail:
              "SIGTERM refused: pid " +
              live.target.pid +
              " no longer classifies as the registered process (" +
              lastState +
              ")",
          });
        else
          initiated({
            how: "unobserved",
            detail:
              "the target's identity could not be observed; no signal was sent",
          });
      }
      const deadline = Date.now() + live.record.budget.cleanupSeconds * 1000;
      while (!live.exit && Date.now() < deadline) await wait(100);
      if (live.exit) return;
      const kill = await send("KILL");
      const window = Date.now() + 5000;
      while (!live.exit && Date.now() < window) await wait(100);
      if (live.exit || kill === "sent") return;
      // Nothing reached the target: it is not confirmed running, stopped or exited. The
      // supervision ends here as unknown; a raw kill by pid is never sent.
      await this.abandon(
        live,
        unobserved
          ? "observer-lost"
          : classificationOfState(lastState ?? "OBSERVATION_UNKNOWN"),
        unobserved
          ? "stop abandoned: the process observer failed, the target could not be signalled by identity"
          : "stop abandoned: the target no longer classifies as the registered process (" +
              lastState +
              ") and no exit was observed",
      );
    })();
    return live.stopping;
  }
  private abandoned = new Set<string>();
  /** Ends the supervision of a target that could not be stopped or observed: unknown, partial, no exit facts. */
  private async abandon(
    live: Live,
    classification: ExitClassification,
    reason: string,
  ) {
    if (this.abandoned.has(live.ref) || this.settled.has(live.ref)) return;
    this.abandoned.add(live.ref);
    this.settled.add(live.ref);
    for (const timer of live.timers) clearInterval(timer);
    live.observationErrors.push(reason);
    this.live.delete(live.ref);
    try {
      await this.shared(live);
      await this.update(live, (current) => ({
        record: {
          ...current,
          state: "unknown",
          stopReason: null,
          target: registered(live.target!),
          children: [...live.children.values()],
          unregisteredObservations: [...live.unregistered.values()].slice(
            0,
            64,
          ),
          exitClassification: classification,
          observationCompleteness: "partial",
          reason: reason.slice(0, 2048),
          updatedAt: nowIso(),
        },
        event: { kind: "interrupted", payload: { classification, reason } },
        pending: null,
      }));
    } catch (error) {
      live.observationErrors.push("transition: " + (error as Error).message);
    }
    live.finish();
  }

  /** Persists one native approval decision while the target runs; the summary repeats the refs at exit. */
  private recordApproval(
    live: Live,
    decision: "accepted" | "rejected",
    ref: string,
    detail: Json,
  ) {
    return this.update(live, (current) => {
      const at = nowIso();
      const refs = current.approvalDecisionRefs.includes(ref)
        ? current.approvalDecisionRefs
        : [...current.approvalDecisionRefs, ref].slice(0, 32);
      return {
        record: { ...current, approvalDecisionRefs: refs, updatedAt: at },
        event: {
          kind:
            decision === "accepted" ? "approval_accepted" : "approval_rejected",
          payload: { decisionRef: ref, ...detail },
        },
        pending: null,
      };
    }).catch((error: Error) => {
      live.observationErrors.push("approval: " + error.message);
      return live.record;
    });
  }

  // ---------------------------------------------------------------- exit
  private settled = new Set<string>();
  private async settle(live: Live) {
    if (this.settled.has(live.ref)) return;
    this.settled.add(live.ref);
    for (const timer of live.timers) clearInterval(timer);
    // The parent has waited (exit event); pipes may still drain.
    const pipes = Date.now() + 2000;
    while ((!live.stdoutClosed || !live.stderrClosed) && Date.now() < pipes)
      await wait(20);
    live.session.onEnd();
    // A stop under way finishes its ledger rows first (its loop ends on live.exit).
    if (live.stopping) await live.stopping;
    await live.chain;
    const target = live.target!;
    // PID probing after the exit: the pid must be gone (or another process's) before the exit counts.
    let goneState: Classification;
    try {
      const probe = await live.observer.waitAbsent(target, 2000);
      goneState = probe.state;
    } catch (error) {
      live.observationErrors.push("exit probe: " + (error as Error).message);
      goneState = "OBSERVATION_UNKNOWN";
    }
    const pidGone = gone(goneState);
    const exit: ProcessExit = {
      code: live.exit!.code,
      signal: live.exit!.signal,
      pipesClosed: live.stdoutClosed && live.stderrClosed,
    };
    const runSeconds = Math.max(
      0,
      Math.round(
        ((live.exitAt ?? Date.now()) -
          (live.releasedAtMs ?? live.exitAt ?? Date.now())) /
          1000,
      ),
    );
    const summary = live.session.summary();
    const accounting = {
      toolCalls: live.toolCalls,
      runSeconds,
      outputBytes: live.outputBytes,
      waited: true,
      pidGoneAfterExit: pidGone,
    };
    // Descendants after the target's exit: inside the session they are reclaimed by identity,
    // outside it they are never signalled and make the stop unconfirmed.
    const reclaim = await reclaimDescendants({
      observer: live.observer,
      ledger: live.ledger!,
      target,
      children: live.children.values(),
      unregistered: live.unregistered.values(),
      cleanupMs: live.record.budget.cleanupSeconds * 1000,
    });
    live.observationErrors.push(...reclaim.errors.map((e) => "reclaim: " + e));
    const { escaped, remaining } = reclaim;
    const classification: ExitClassification = !pidGone
      ? classificationOfState(goneState)
      : goneState === "IDENTITY_CONFLICT"
        ? "pid-reused"
        : escaped.length || remaining.length
          ? "children-remaining"
          : exit.signal
            ? "signaled"
            : "exited";
    const at = nowIso();
    const evidence = this.writeEvidence(
      live,
      summary,
      accounting,
      exit,
      goneState,
    );
    const approvalRefs = [
      ...new Set([
        ...live.record.approvalDecisionRefs,
        ...summary.approvalDecisionRefs,
      ]),
    ].slice(0, 32);
    const base: Partial<HostExecutionRecord> = {
      target: registered(target),
      children: [...live.children.values()],
      unregisteredObservations: [...live.unregistered.values()].slice(0, 64),
      actualBinding: summary.actualBinding,
      approvalDecisionRefs: approvalRefs,
      accounting,
      exit,
      exitClassification: classification,
      resultRef: evidence.ref,
      updatedAt: at,
    };
    const signals = live.ledger?.counts() ?? { TERM: 0, KILL: 0 };
    let record: HostExecutionRecord;
    let event: {
      kind:
        "completed" | "failed" | "stopped" | "stop_unconfirmed" | "interrupted";
      payload: Json;
    };
    let pending: "open" | null = null;
    if (escaped.length) {
      record = {
        ...live.record,
        ...base,
        state: "stopping",
        stopReason: null,
        observationCompleteness: "partial",
        reason:
          "stop unconfirmed after " +
          (live.stopReason ?? "exit") +
          ": " +
          escaped.length +
          " process(es) outside the target session still alive (" +
          escaped.map((e) => e.identity.pid).join(", ") +
          ")",
        stopUnconfirmed: {
          since: at,
          targetIdentity: schemaIdentity(target),
          escaped,
          checks: 0,
          lastCheckedAt: at,
          resolvedAt: null,
        },
        blockedOperations: [...blockedOperations],
      };
      event = {
        kind: "stop_unconfirmed",
        payload: {
          escaped: escaped.map((e) => ({
            pid: e.identity.pid,
            session: e.session,
            kind: e.kind,
          })),
          blocked: [...blockedOperations],
          stopReason: live.stopReason,
          classification,
        },
      };
      pending = "open";
    } else if (live.failure && !live.stopReason) {
      record = {
        ...live.record,
        ...base,
        state: "failed",
        stopReason: null,
        observationCompleteness:
          pidGone && remaining.length === 0 ? "complete" : "partial",
        reason: live.failure.message,
      };
      event = {
        kind: "failed",
        payload: {
          resultCode: live.failure.code,
          errorClass: live.failure.errorClass,
          message: live.failure.message,
          classification,
        },
      };
    } else if (live.stopReason) {
      record = {
        ...live.record,
        ...base,
        state: "stopped",
        stopReason: live.stopReason,
        observationCompleteness:
          pidGone && remaining.length === 0 ? "complete" : "partial",
        reason:
          "stopped: " +
          live.stopReason +
          (remaining.length
            ? "; " +
              remaining.length +
              " descendant(s) remain inside the session"
            : ""),
      };
      event = {
        kind: "stopped",
        payload: {
          stopReason: live.stopReason,
          classification,
          signals,
          reclaimed: reclaim.reclaimed.length,
          remaining: remaining.length,
        },
      };
    } else if (summary.outcome === "completed" && exit.code === 0 && pidGone) {
      record = {
        ...live.record,
        ...base,
        state: "completed",
        stopReason: null,
        observationCompleteness:
          remaining.length === 0 ? "complete" : "partial",
        reason: summary.reason || "completed",
      };
      event = {
        kind: "completed",
        payload: {
          model: summary.actualBinding?.model ?? null,
          source: summary.actualBinding?.source ?? null,
          toolCalls: accounting.toolCalls,
          approvals: approvalRefs.length,
        },
      };
    } else if (!pidGone) {
      record = {
        ...live.record,
        ...base,
        state: "unknown",
        stopReason: null,
        observationCompleteness: "partial",
        reason:
          goneState === "OBSERVATION_UNKNOWN" &&
          live.observationErrors.some((e) => e.startsWith("exit probe:"))
            ? "exit status obtained but the process observer failed to confirm the pid gone"
            : "exit status obtained but the pid is still observable (" +
              goneState +
              ")",
      };
      event = { kind: "interrupted", payload: { classification } };
    } else {
      record = {
        ...live.record,
        ...base,
        state: "failed",
        stopReason: null,
        observationCompleteness: "complete",
        reason:
          summary.reason ||
          (exit.signal
            ? "terminated by " + exit.signal
            : "exited with code " + exit.code),
      };
      event = {
        kind: "failed",
        payload: {
          resultCode:
            summary.resultCode ??
            (exit.signal ? "SIGNALED" : "EXIT_" + exit.code),
          errorClass:
            summary.errorClass ?? (exit.signal ? "stream" : "provider"),
          message: record.reason,
          classification,
        },
      };
    }
    await this.shared(live, {
      nativeSession: summary.nativeSession,
      exit,
      result: evidence.ref
        ? { digest: evidence.ref.digest, locator: evidence.locator }
        : null,
    });
    try {
      await this.update(live, () => ({ record, event, pending }));
    } catch (error) {
      live.observationErrors.push("transition: " + (error as Error).message);
    }
    this.live.delete(live.ref);
    live.finish();
    if (record.state === "stopping")
      this.watchEscaped(live.ref, live.context, live.observer);
  }
  /**
   * The Host evidence of one execution: the transcript (every adapter entry, plus one
   * `omitted` entry carrying the bytes of entries dropped past the budget, so the byte sum
   * stays the output count) and the result document with the accounting's own sources:
   * `timeline` for runSeconds, `targetExit` for waited, `exitProbe` for pidGoneAfterExit.
   */
  private writeEvidence(
    live: Live,
    summary: AdapterSummary,
    accounting: HostExecutionRecord["accounting"],
    exit: ProcessExit,
    exitProbe: Classification,
  ) {
    const dir = join(this.options.evidenceRoot, recordSegment(live.ref));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lines = [...live.transcript];
    if (live.omitted.lines > 0)
      lines.push(
        JSON.stringify({
          type: "omitted",
          lines: live.omitted.lines,
          bytes: live.omitted.bytes,
        }),
      );
    const transcript = lines.join("\n") + (lines.length ? "\n" : "");
    writeFileSync(join(dir, "transcript.ndjson"), transcript, { mode: 0o600 });
    const document = {
      executionRef: live.ref,
      operationId: live.request.operationId,
      profileId: live.request.profileId,
      profileDigest: live.request.profileDigest,
      actualBinding: summary.actualBinding,
      approvalDecisionRefs: summary.approvalDecisionRefs,
      nativeSession: summary.nativeSession,
      outcome: summary.outcome,
      resultCode: summary.resultCode,
      reason: summary.reason,
      evidence: live.plan.programIdentity
        ? { ...summary.evidence, programIdentity: live.plan.programIdentity }
        : summary.evidence,
      accounting,
      budget: live.record.budget,
      stopReason: live.stopReason,
      cancelRequestedAt: live.record.cancelRequestedAt,
      timeline: {
        releasedAt:
          live.releasedAtMs === null
            ? null
            : new Date(live.releasedAtMs).toISOString(),
        exitedAt:
          live.exitAt === null ? null : new Date(live.exitAt).toISOString(),
      },
      targetExit: exit,
      exitProbe: { state: exitProbe },
      portExit: { pid: process.pid, alive: true },
      signals: live.ledger?.rows ?? [],
      transcriptDigest: sha256(transcript),
      transcriptBytes: Buffer.byteLength(transcript),
      transcriptOmitted: live.omitted,
      disclosures: live.plan.disclosures,
      observationErrors: live.observationErrors,
      writtenAt: nowIso(),
    };
    const bytes = Buffer.from(canonicalJson(document) + "\n");
    writeFileSync(join(dir, "result.json"), bytes, { mode: 0o600 });
    const locator = "result:" + recordSegment(live.ref);
    return {
      locator,
      ref: {
        authority: "host" as const,
        resourceHandle: live.request.resourceHandle,
        scopeRef: live.request.scopeRef,
        objectRef: "execution-result:" + live.ref,
        revision: "1",
        mediaType: "application/json" as const,
        bytes: bytes.length,
        digest: sha256(bytes),
      },
    };
  }

  // ---------------------------------------------------------------- stop unconfirmed
  /** Periodic re-observation of the escaped processes; the release is automatic on their exit. */
  private watchEscaped(
    executionRef: string,
    context: ExecutionContext,
    observer: ProcessObserver,
  ) {
    if (this.recheckers.has(executionRef)) return;
    const timer = setInterval(
      () =>
        void this.recheck(executionRef, context, observer, false).catch(() => {
          /* a failed periodic observation changes nothing; the next tick observes again */
        }),
      recheckIntervalMs,
    );
    timer.unref?.();
    this.recheckers.set(executionRef, timer);
  }
  /**
   * One observation of every escaped process of a stop-unconfirmed execution. An explicit
   * recheck (the pending item's action) counts; both paths release automatically once no
   * escaped process is observable as the registered one.
   */
  async recheck(
    executionRef: string,
    context: ExecutionContext,
    observer: ProcessObserver | null = null,
    explicit = true,
  ): Promise<HostExecutionRecord | null> {
    return this.recheckRecord(
      executionRef,
      context,
      observer ?? new ProcessObserver(this.options.helper),
      explicit,
    );
  }
  private rechecking = new Set<string>();
  private async recheckRecord(
    executionRef: string,
    context: ExecutionContext,
    observer: ProcessObserver,
    explicit: boolean,
  ): Promise<HostExecutionRecord | null> {
    if (this.rechecking.has(executionRef) || this.closed) return null;
    this.rechecking.add(executionRef);
    try {
      const record = await context.current();
      if (this.closed) return record;
      if (!record || record.state !== "stopping" || !record.stopUnconfirmed) {
        this.stopWatching(executionRef);
        return record;
      }
      const alive = [];
      for (const escaped of record.stopUnconfirmed.escaped) {
        const observed = await observer
          .inspect(escaped.identity.pid)
          .catch(() => null);
        if (!observed) {
          alive.push(escaped);
          continue;
        }
        if (escaped.kind === "registered") {
          const child = record.children.find(
            (c) => c.pid === escaped.identity.pid,
          );
          const state = child
            ? classify(child, observed)
            : "OBSERVATION_UNKNOWN";
          if (state === "ABSENT" || state === "IDENTITY_CONFLICT") continue;
          alive.push(escaped);
        } else if (
          observed.info_size > 0 &&
          observed.path === escaped.identity.image &&
          observed.session === escaped.session
        )
          alive.push(escaped);
      }
      const at = nowIso();
      if (this.closed) return record;
      if (alive.length) {
        return await context.transition({
          record: {
            ...record,
            stopUnconfirmed: {
              ...record.stopUnconfirmed,
              checks: record.stopUnconfirmed.checks + (explicit ? 1 : 0),
              lastCheckedAt: at,
            },
            updatedAt: at,
          },
          event: null,
          pending: null,
        });
      }
      this.stopWatching(executionRef);
      return await context.transition({
        record: {
          ...record,
          state: "stopped",
          stopReason: stopReasonOf(record) ?? "cancelled",
          observationCompleteness: "complete",
          reason:
            "stop confirmed: every process outside the target session has exited",
          stopUnconfirmed: {
            ...record.stopUnconfirmed,
            checks: record.stopUnconfirmed.checks + (explicit ? 1 : 0),
            lastCheckedAt: at,
            resolvedAt: at,
          },
          blockedOperations: [],
          updatedAt: at,
        },
        // The result event of the pending item (LOG-01): the item leaves 待处理 with this outcome.
        event: {
          kind: "stop_confirmed",
          payload: {
            checks: record.stopUnconfirmed.checks + (explicit ? 1 : 0),
            escaped: record.stopUnconfirmed.escaped.length,
            result: "processes-exited",
            stopReason: stopReasonOf(record) ?? "cancelled",
          },
        },
        pending: "resolve",
      });
    } finally {
      this.rechecking.delete(executionRef);
    }
  }
  private stopWatching(executionRef: string) {
    const timer = this.recheckers.get(executionRef);
    if (timer) clearInterval(timer);
    this.recheckers.delete(executionRef);
  }
  /** Resumes watching stop-unconfirmed executions after a restart (the record is the source; nothing is re-executed). */
  resumeWatch(executionRef: string, context: ExecutionContext) {
    this.watchEscaped(
      executionRef,
      context,
      new ProcessObserver(this.options.helper),
    );
  }
  /**
   * Restart recovery (architecture "身份、存储与事务": Host 中断后重新核验进程与原工作身份, 不盲目重执行).
   * A reservation that was never released becomes unknown; a released target that is still the
   * registered process is not adopted (this process is not its supervisor) and stays unknown
   * without a signal; a released target that is gone leaves either escaped descendants (stop
   * unconfirmed) or an unreadable result (unknown); a stop-unconfirmed record is watched again.
   */
  async recover(
    records: HostExecutionRecord[],
    contextFor: (record: HostExecutionRecord) => ExecutionContext,
  ) {
    const observer = new ProcessObserver(this.options.helper);
    const outcomes: { executionRef: string; state: string }[] = [];
    for (const record of records) {
      if (record.portId !== this.id || this.live.has(record.executionRef))
        continue;
      const context = contextFor(record);
      const at = nowIso();
      if (record.state === "stopping" && record.stopUnconfirmed) {
        this.resumeWatch(record.executionRef, context);
        outcomes.push({ executionRef: record.executionRef, state: "stopping" });
        continue;
      }
      if (
        record.state === "queued" ||
        record.state === "reserved" ||
        !record.target
      ) {
        await context.transition({
          record: {
            ...record,
            state: "unknown",
            observationCompleteness: "unknown",
            reason: "host restarted before the target was released",
            updatedAt: at,
          },
          event: { kind: "interrupted", payload: { recovery: "unreleased" } },
          pending: null,
        });
        outcomes.push({ executionRef: record.executionRef, state: "unknown" });
        continue;
      }
      if (record.state !== "running") continue;
      const observed = await observer
        .inspect(record.target.pid)
        .catch(() => null);
      const state = observed
        ? classify(record.target, observed)
        : "OBSERVATION_UNKNOWN";
      if (sameProcess(state) || state === "ZOMBIE_UNREAPED") {
        await context.transition({
          record: {
            ...record,
            state: "unknown",
            observationCompleteness: "partial",
            reason:
              "supervisor interrupted; the target is still running and is not adopted",
            updatedAt: at,
          },
          event: {
            kind: "interrupted",
            payload: { recovery: "supervisor-lost", pid: record.target.pid },
          },
          pending: null,
        });
        outcomes.push({ executionRef: record.executionRef, state: "unknown" });
        continue;
      }
      const escaped = [];
      for (const child of record.children) {
        const seen = await observer.inspect(child.pid).catch(() => null);
        if (!seen) continue;
        const childState = classify(child, seen);
        if (sameProcess(childState) && !inTargetSession(seen, record.target))
          escaped.push({
            identity: schemaIdentity(child),
            session: seen.session,
            kind: "registered" as const,
          });
      }
      if (escaped.length) {
        const next = await context.transition({
          record: {
            ...record,
            state: "stopping",
            observationCompleteness: "partial",
            reason:
              "stop unconfirmed after exit: " +
              escaped.length +
              " process(es) outside the target session still alive",
            stopUnconfirmed: {
              since: at,
              targetIdentity: schemaIdentity(record.target),
              escaped,
              checks: 0,
              lastCheckedAt: at,
              resolvedAt: null,
            },
            blockedOperations: [...blockedOperations],
            updatedAt: at,
          },
          // The same payload shape as the settle path (J-06), plus the recovery marker.
          event: {
            kind: "stop_unconfirmed",
            payload: {
              escaped: escaped.map((e) => ({
                pid: e.identity.pid,
                session: e.session,
                kind: e.kind,
              })),
              blocked: [...blockedOperations],
              stopReason: stopReasonOf(record),
              classification: "children-remaining",
              recovery: true,
            },
          },
          pending: "open",
        });
        this.resumeWatch(next.executionRef, contextFor(next));
        outcomes.push({ executionRef: record.executionRef, state: "stopping" });
        continue;
      }
      await context.transition({
        record: {
          ...record,
          state: "unknown",
          observationCompleteness: "partial",
          reason:
            "supervisor interrupted; the target has exited and its result cannot be read back",
          updatedAt: at,
        },
        event: {
          kind: "interrupted",
          payload: { recovery: "result-unreadable" },
        },
        pending: null,
      });
      outcomes.push({ executionRef: record.executionRef, state: "unknown" });
    }
    return outcomes;
  }
  /**
   * Application quit: the Host is the supervisor of every live target, so each one is stopped by
   * identity (native interrupt, TERM, KILL after the cleanup budget) and recorded before the
   * process ends; stop-unconfirmed watching resumes on the next start from the records.
   */
  private closed = false;
  async close() {
    this.closed = true;
    for (const timer of this.recheckers.values()) clearInterval(timer);
    this.recheckers.clear();
    const stops = [...this.live.values()].map(async (live) => {
      await this.stop(live, "cancelled", "application quit");
      await Promise.race([
        live.done,
        wait(live.record.budget.cleanupSeconds * 1000 + 8000),
      ]);
    });
    await Promise.all(stops);
  }

  // ---------------------------------------------------------------- get / cancel
  async get(executionRef: string): Promise<(PhysicalExecution & Json) | null> {
    const live = this.live.get(executionRef);
    return live ? { ...physicalExecutionOf(live.record) } : null;
  }
  /**
   * Cancel: the request is persisted first (state stopping, cancelRequestedAt, the
   * stop_requested event), then the stop starts and the answer is given once it is under way;
   * the physical terminal state (stopped + stopReason cancelled, or stop unconfirmed) is
   * queried through host.execution.get (Contract: 取消 Operation，物理终态另核实). A target
   * that already exited is answered as such; the Host answers a terminal execution before
   * reaching the port.
   */
  async cancel(executionRef: string, operationId: string): Promise<Json> {
    const live = this.live.get(executionRef);
    if (!live)
      return { status: "succeeded", reason: "not running", operationId };
    if (live.exit)
      return { status: "succeeded", reason: "already exited", operationId };
    const at = nowIso();
    live.cancelRequested = true;
    await this.update(live, (current) => ({
      record: {
        ...current,
        state: current.state === "running" ? "stopping" : current.state,
        cancelRequestedAt: current.cancelRequestedAt ?? at,
        reason: "stop requested by " + operationId,
        updatedAt: at,
      },
      event: { kind: "stop_requested", payload: { operationId } },
      pending: null,
    }));
    void this.stop(live, "cancelled", "cancel " + operationId);
    const initiation = await live.stopInitiated!;
    return {
      status: initiation.how === "unobserved" ? "unknown" : "succeeded",
      reason: "cancel persisted; " + initiation.detail,
      how: initiation.how,
      operationId,
    };
  }
  /** Executions this port is still supervising (tests and quit). */
  activeRefs() {
    return [...this.live.keys()];
  }
  async waitIdle(executionRef: string) {
    await this.live.get(executionRef)?.done;
  }
}

function registered(reg: RegisteredProcess): RegisteredProcessIdentity {
  return {
    pid: reg.pid,
    uid: reg.uid,
    startSeconds: reg.startSeconds,
    startMicros: reg.startMicros,
    path: reg.path,
    parent: reg.parent,
    group: reg.group,
    session: reg.session,
    registeredAt: reg.registeredAt,
  };
}
/** The exit classification of a pid that did not go away (or could not be observed) after the parent's wait. */
function classificationOfState(state: Classification): ExitClassification {
  if (state === "OBSERVATION_DENIED") return "eperm";
  if (state === "ZOMBIE_UNREAPED") return "zombie";
  if (state === "IDENTITY_CONFLICT") return "pid-reused";
  return "observer-lost";
}
/** The stop reason a stop-unconfirmed execution ends with: the cancel that produced it, else the recorded budget stop. */
function stopReasonOf(record: HostExecutionRecord): StopReason | null {
  if (record.cancelRequestedAt) return "cancelled";
  const match =
    /^stop unconfirmed after (cancelled|timeout|tool-call-budget|output-limit|signal)/.exec(
      record.reason,
    );
  return match ? (match[1] as StopReason) : null;
}
export const executionEvidenceDir = (root: string, executionRef: string) =>
  join(root, recordSegment(executionRef));
