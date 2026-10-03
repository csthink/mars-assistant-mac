/**
 * Test execution port (Contract `host.execution.*`, OD-323): the fake-agent target program
 * stands in for a print-mode Agent. The port is registered through the Host API by the
 * integration test only; it never enters the product build. It runs `fake_agent.py`
 * under the pinned python3 identity, observes its stream-json output, and reports
 * accounting, exit, stopReason and actualBinding exactly as the Contract's
 * PhysicalExecution describes them (C-09, C-13, C-15).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type {
  ExecutionContext,
  ExecutionPort,
  ExecutionProfile,
  ExecutionStartRequest,
  PreflightCheck,
  PreflightRequest,
} from "../../../src/main/runtime-execution-port";
import type { PhysicalExecution } from "../../../src/shared/runtime-execution";
import { canonicalJson } from "../../../src/shared/runtime-host";

type Json = Record<string, unknown>;
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export interface ProgramIdentity {
  launcher: string;
  binaryDigest: string;
  version: string;
}
export const FAKE_AGENT = "agent:fake-agent";
export const FAKE_PROFILE_ID = "profile:test-implementer";
/** The profile identity is the digest of the whole policy, so the same python identity yields the same digest everywhere. */
export function fakeAgentProfile(program: ProgramIdentity): ExecutionProfile {
  const configuration = {
    agent: FAKE_AGENT,
    script: "fake_agent.py",
    prompt: "test prompt: synthetic execution",
  };
  const policy = {
    id: FAKE_PROFILE_ID,
    version: "1",
    trustModel: "current-user",
    purpose: "coding-implementer",
    programIdentity: program,
    nativeApprovalPolicy: "auto-deny",
    configurationDigest: sha256(canonicalJson(configuration)),
    capabilities: ["write-scratch-file"],
    limitations: ["no-network", "no-model-call"],
    operations: ["graph.execute"],
    maxContextBytes: 1_048_576,
    maxToolCalls: 4,
    maxRunSeconds: 20,
  };
  return {
    ...policy,
    digest: sha256(canonicalJson(policy)),
  } as ExecutionProfile;
}

export interface Plan {
  vector: "valid" | "hang" | "fail" | "slow";
  /** C-13: the observation channel is lost after init, so the outcome can never be proven. */
  observeLoss?: boolean;
}
interface Execution {
  context: ExecutionContext;
  view: Json;
  request: ExecutionStartRequest;
  plan: Plan;
  child: ChildProcess | null;
  kill: ((reason: string) => void) | null;
  cancelRequested: boolean;
  transcript: string;
  done: Promise<void>;
}
export interface FakeAgentPortOptions {
  id?: string;
  program: ProgramIdentity;
  agentScript: string;
  workDir: string;
}
export class FakeAgentPort implements ExecutionPort {
  readonly id: string;
  readonly plans: Plan[] = [];
  readonly executions = new Map<string, Execution>();
  private readonly profile: ExecutionProfile;
  private readonly started = nowIso();
  constructor(private readonly options: FakeAgentPortOptions) {
    this.id = options.id ?? "port:fake-agent";
    this.profile = fakeAgentProfile(options.program);
    mkdirSync(options.workDir, { recursive: true });
  }
  profiles() {
    return [this.profile];
  }
  plan(plan: Plan) {
    this.plans.push(plan);
  }
  async preflight(request: PreflightRequest): Promise<PreflightCheck[]> {
    const known =
      request.profileId === this.profile.id &&
      request.profileDigest === this.profile.digest;
    return [
      {
        id: "profile-known",
        passed: known,
        detail: known ? "offered" : "unknown profile",
      },
      {
        id: "binding-agent",
        passed: request.executionBinding.agent === FAKE_AGENT,
        detail: "binding names the profile's program",
      },
      {
        id: "program-identity",
        passed:
          canonicalJson(this.profile.programIdentity) ===
          canonicalJson(this.options.program),
        detail: "fixed interpreter identity",
      },
      {
        id: "no-model-call",
        passed: true,
        detail: "no session, no operation, no execution",
      },
    ];
  }
  /** Reservation is the Host's; the port creates the target and resolves once it is running. */
  async start(
    executionRef: string,
    request: ExecutionStartRequest,
    context: ExecutionContext,
  ): Promise<Json> {
    if (request.executionBinding.agent !== FAKE_AGENT)
      throw new Error("binding agent is not the program of the profile");
    const plan = this.plans.shift() ?? { vector: "valid" };
    const dir = join(
      this.options.workDir,
      executionRef.replace(/[^A-Za-z0-9._-]/g, "_"),
    );
    mkdirSync(join(dir, "scratch"), { recursive: true });
    const transcript = join(dir, "transcript.jsonl");
    const view: Json = {
      executionRef,
      scopeRef: request.scopeRef,
      state: "running",
      connectionRef: request.connectionRef,
      configurationRevision: request.configurationRevision,
      model: request.model,
      requestIdentity: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        profileDigest: request.profileDigest,
      },
      supervisor: {
        pid: process.pid,
        startTime: this.started,
        image: process.execPath,
      },
      approvalDecisionRefs: [],
      actualBinding: null,
      stopReason: null,
      accounting: null,
      exit: null,
      observationCompleteness: "partial",
      resultRef: null,
      reason: "",
    };
    const execution: Execution = {
      context,
      view,
      request,
      plan,
      child: null,
      kill: null,
      cancelRequested: false,
      transcript,
      done: Promise.resolve(),
    };
    this.executions.set(executionRef, execution);
    execution.done = this.run(execution, dir);
    return { status: "running", state: "running", executionRef };
  }
  private async run(execution: Execution, dir: string) {
    const { request, plan, view } = execution;
    const startedAt = Date.now();
    const child = spawn(
      this.options.program.launcher,
      ["-B", this.options.agentScript, plan.vector],
      {
        cwd: join(dir, "scratch"),
        env: { PATH: "/usr/bin:/bin", HOME: dir, PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    execution.child = child;
    const state = {
      stopReason: null as string | null,
      outputBytes: 0,
      toolCalls: 0,
      initModel: null as string | null,
      observed: new Set<string>(),
      observationLost: false,
    };
    const stop = (reason: string) => {
      if (state.stopReason) return;
      state.stopReason = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, 1000).unref();
    };
    execution.kill = stop;
    const budget = request.budget as {
      maxToolCalls: number;
      maxRunSeconds: number;
      maxOutputBytes?: number;
    };
    const timer = setTimeout(
      () => stop("timeout"),
      budget.maxRunSeconds * 1000,
    );
    const lines = createInterface({ input: child.stdout! });
    const closed = new Promise<void>((resolve) =>
      lines.on("close", () => resolve()),
    );
    lines.on("line", (line) => {
      if (plan.observeLoss && state.initModel) {
        state.observationLost = true;
        return;
      }
      state.outputBytes += Buffer.byteLength(line) + 1;
      appendFileSync(execution.transcript, line + "\n");
      if (state.outputBytes > (budget.maxOutputBytes ?? 1_048_576)) {
        stop("output-limit");
        return;
      }
      try {
        const frame = JSON.parse(line) as Json;
        if (frame.type === "system" && frame.subtype === "init") {
          state.initModel =
            typeof frame.model === "string" ? frame.model : null;
          if (state.initModel) state.observed.add(state.initModel);
        } else if (frame.type === "assistant") {
          const message = frame.message as Json | undefined;
          if (typeof message?.model === "string")
            state.observed.add(message.model);
          state.toolCalls += (
            (message?.content as Json[] | undefined) ?? []
          ).filter((c) => c?.type === "tool_use").length;
          if (state.toolCalls > budget.maxToolCalls) stop("tool-call-budget");
        } else if (frame.type === "result")
          for (const model of Object.keys((frame.modelUsage as Json) ?? {}))
            state.observed.add(model);
      } catch {
        /* non-JSON line kept in the transcript */
      }
    });
    child.stdin!.on("error", () => {
      /* the child may exit early */
    });
    child.stdin!.write("test prompt: synthetic execution\n");
    const exit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    clearTimeout(timer);
    await closed;
    let gone = false;
    try {
      process.kill(child.pid!, 0);
    } catch {
      gone = true;
    }
    view.exit = { code: exit.code, signal: exit.signal, pipesClosed: true };
    view.accounting = {
      toolCalls: state.toolCalls,
      runSeconds: Math.ceil((Date.now() - startedAt) / 1000),
      outputBytes: state.outputBytes,
      waited: true,
      pidGoneAfterExit: gone,
    };
    view.actualBinding = state.initModel
      ? {
          model: state.initModel,
          source: "protocol-init",
          observedModels: [...state.observed].slice(0, 8),
        }
      : null;
    if (state.observationLost) {
      view.state = "unknown";
      view.observationCompleteness = "unknown";
      view.reason =
        "observation channel lost after init; the outcome cannot be proven";
      return;
    }
    view.observationCompleteness = "complete";
    if (execution.cancelRequested || state.stopReason === "cancel") {
      view.state = "stopped";
      view.stopReason = "cancelled";
      view.reason = "stopped after cancel";
    } else if (
      ["timeout", "tool-call-budget", "output-limit"].includes(
        state.stopReason ?? "",
      )
    ) {
      view.state = "stopped";
      view.stopReason = state.stopReason;
      view.reason = "stopped by the Host after the fact: " + state.stopReason;
    } else if (exit.code === 0) {
      view.state = "completed";
    } else {
      view.state = "failed";
      view.reason = `exit ${exit.code ?? exit.signal}`;
    }
  }
  async get(executionRef: string): Promise<Json | null> {
    const execution = this.executions.get(executionRef);
    if (!execution) return null;
    // A query observes the fake target's actual process state. Persist that observation through
    // the same Host context as production ports before returning it, so completed targets release
    // their durable reservation and capacity never depends only on the fake's in-memory view.
    const physical = { ...execution.view } as unknown as PhysicalExecution;
    const current = await execution.context.current();
    if (current && current.state !== physical.state)
      await execution.context.transition({
        record: { ...current, ...physical, updatedAt: nowIso() },
        event: null,
        pending: null,
      });
    return { ...physical };
  }
  async cancel(executionRef: string, _operationId: string): Promise<Json> {
    void _operationId;
    const execution = this.executions.get(executionRef);
    if (!execution) throw new Error("unknown execution " + executionRef);
    const state = execution.view.state as string;
    if (["completed", "failed", "stopped", "unknown"].includes(state))
      return {
        status: "succeeded",
        reason: "execution already terminal: " + state,
      };
    execution.cancelRequested = true;
    if (state === "running") execution.view.state = "stopping";
    execution.kill?.("cancel");
    return { status: "succeeded", reason: "physical stop requested" };
  }
  /** Test inspection: the stored view plus the transcript path. */
  record(executionRef: string) {
    const execution = this.executions.get(executionRef);
    return execution
      ? {
          view: { ...execution.view },
          transcript: execution.transcript,
          vector: execution.plan.vector,
        }
      : null;
  }
  async settled(executionRef: string) {
    await this.executions.get(executionRef)?.done;
    return this.record(executionRef);
  }
}
