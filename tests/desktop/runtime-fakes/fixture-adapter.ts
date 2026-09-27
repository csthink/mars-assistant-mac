/**
 * Test adapter for the embedded execution port (feature-t30): the fixture `claude`
 * executable (tests/desktop/claude-fixture.ts) in print mode stands in for an Agent. The
 * release is one stream-json user line followed by end of stdin; the fixture answers with
 * `system/init`, a text delta and a `result` frame, or misbehaves as its state file says.
 * It is registered through the Host API by tests only and never enters the product build;
 * the Claude and Codex adapters (S-02) replace it in the product.
 */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type {
  AdapterSession,
  ExecutionAdapter,
  LaunchPlan,
  SessionHooks,
} from "../../../src/main/execution-port";
import type {
  ExecutionContext,
  ExecutionProfile,
  ExecutionStartRequest,
  PreflightRequest,
} from "../../../src/main/runtime-execution-port";

export const FIXTURE_PROFILE: ExecutionProfile = {
  id: "profile:fixture",
  version: "1",
  digest: "d".repeat(64),
  trustModel: "current-user",
  purpose: "coding-implementer",
  programIdentity: {
    launcher: "/usr/bin/true",
    binaryDigest: "a".repeat(64),
    version: "1",
  },
  nativeApprovalPolicy: "auto-deny",
  configurationDigest: "a".repeat(64),
  capabilities: [],
  limitations: [],
  operations: ["graph.execute"],
  maxContextBytes: 1024,
  maxToolCalls: 4,
  maxRunSeconds: 20,
};
export interface Variant {
  /** Replaces the print-mode argv; "--version" makes the target exit before release. */
  argv?: string[];
  /** The image the port must see; a wrong one fails the identity check. */
  expectedImage?: string;
  release?: "user" | "none";
  effort?: string | null;
  /**
   * Text-input print mode (the product Implementer's shape): the release writes one prompt and
   * ends stdin; the fixture's `implementer` state (hang, ignoreTerm, children, escaped) then
   * drives the S-03 cancel scenarios. Default: stream-json input with one user line.
   */
  print?: boolean;
}
export class FixtureAdapter implements ExecutionAdapter {
  readonly plans: LaunchPlan[] = [];
  variant: Variant = {};
  constructor(
    private readonly binary: string,
    private readonly home: string,
    private readonly image: string = process.execPath,
  ) {}
  async profile() {
    return FIXTURE_PROFILE;
  }
  async preflight(request: PreflightRequest) {
    return [
      {
        id: "profile",
        passed: request.profileId === FIXTURE_PROFILE.id,
        detail: "fixture",
      },
    ];
  }
  async plan(
    request: ExecutionStartRequest,
    context: ExecutionContext,
  ): Promise<LaunchPlan> {
    const variant = this.variant;
    const plan: LaunchPlan = {
      executable: this.binary,
      expectedImage: variant.expectedImage ?? this.image,
      argv: variant.argv ?? [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        variant.print ? "text" : "stream-json",
        "--model",
        request.model,
        "--session-id",
        randomUUID(),
        "--mcp-config",
        '{"mcpServers":{}}',
        ...(variant.print
          ? ["--tools", "Read,Edit,Write", "--permission-mode", "acceptEdits"]
          : []),
      ],
      env: { PATH: "/usr/bin:/bin", HOME: this.home },
      cwd: context.resource?.path ?? process.cwd(),
      effort: variant.effort ?? null,
      disclosures: [],
      session: (child, hooks) => new FixtureSession(child, hooks, variant),
    };
    this.plans.push(plan);
    return plan;
  }
}
class FixtureSession implements AdapterSession {
  private pending = "";
  private model: string | null = null;
  private outcome: "completed" | "failed" | null = null;
  private reason = "";
  constructor(
    private readonly child: ChildProcess,
    private readonly hooks: SessionHooks,
    private readonly variant: Variant,
  ) {}
  async release() {
    if (this.variant.release === "none") return;
    const line = this.variant.print
      ? "run\n"
      : JSON.stringify({
          type: "user",
          message: { role: "user", content: "run" },
        }) + "\n";
    await new Promise<void>((resolve, reject) =>
      this.child.stdin!.write(line, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    this.child.stdin!.end();
  }
  /** Like the product Implementer: print mode has no interrupt message, stdin is already ended; the port signals. */
  async interrupt() {
    if (!this.child.stdin?.destroyed) this.child.stdin?.end();
    return "signal" as const;
  }
  onStdout(chunk: Buffer) {
    this.pending += chunk.toString("utf8");
    let index;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      // The raw frame is kept as the transcript entry (a test double: nothing to redact), with its bytes.
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        entry = { type: "unparsed" };
      }
      this.hooks.transcript({ ...entry, bytes: Buffer.byteLength(line) + 1 });
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === "system" && frame.subtype === "init")
          this.model = String(frame.model);
        if (frame.type === "assistant") {
          const content =
            (frame.message as { content?: { type: string }[] })?.content ?? [];
          for (const block of content)
            if (block.type === "tool_use") this.hooks.toolCall();
        }
        if (frame.type === "result") {
          this.outcome = frame.is_error ? "failed" : "completed";
          this.reason = String(frame.subtype);
        }
      } catch {
        /* not a frame */
      }
    }
  }
  onStderr(chunk: Buffer) {
    this.hooks.transcript({ type: "stderr", bytes: chunk.length });
  }
  onEnd() {}
  summary() {
    return {
      actualBinding: this.model
        ? {
            model: this.model,
            source: "protocol-init" as const,
            observedModels: [this.model],
          }
        : null,
      toolCalls: 0,
      nativeSession: null,
      outcome: this.outcome,
      resultCode: this.outcome === "failed" ? "PROTOCOL_ERROR" : null,
      errorClass: this.outcome === "failed" ? ("provider" as const) : null,
      reason: this.reason,
      approvalDecisionRefs: [],
      evidence: {},
    };
  }
}
