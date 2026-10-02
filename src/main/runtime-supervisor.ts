/**
 * Runtime supervisor (Contract "职责与进程" trusted host component): admits bundles,
 * starts each verified installation's primary instance as a supervised child process
 * on bidirectional stdio JSON-RPC, binds instance/incarnation/connection identities
 * from the real handles, negotiates protocol and capabilities, runs the health
 * heartbeat and reconnects. Persistent records go through the business service (the
 * single SQLite writer) as host commands; this module holds only live process state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isMacMetadata } from "../shared/macos-metadata";
import {
  digestOf,
  expandArgv,
  installPackage,
  installedVersionKey,
  launchEnvironment,
  launchProblems,
  needsResourceHandle,
  packageDir,
  sha256,
  verifyBundle,
  verifyInstalledPackage,
  type HostDescriptor,
} from "./runtime-admission";
import {
  FrameError,
  LineReader,
  encodeFrame,
  parseFrame,
  type RpcRequest,
  type RpcResponse,
} from "./runtime-framing";
import {
  contractDigest,
  contractVersion,
  diagnosticsRetainBytes,
  diagnosticsRetainDays,
  healthIntervalMs,
  rpcTimeoutMs,
  runtimeLimits,
  sameContext,
  validCapability,
  validContext,
  validProfileRef,
  validProtocol,
  validRuntimeLimits,
  type Capability,
  type Context,
  type ExecutionProfileRef,
  type LaunchConfiguration,
  type LaunchDirectories,
  type RuntimeHostCommand,
  type RuntimeImportReply,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeLimits,
  type RuntimeOperation,
} from "../shared/runtime-host";

/** Business-level failure on a runtime-to-host request or a host-side check (Contract ErrorData). */
export class RpcFailure extends Error {
  code: string;
  scopeRef: string | null;
  operationId: string | null;
  recovery: string;
  absenceProven: boolean;
  constructor(
    code: string,
    message: string,
    extra: Partial<{
      scopeRef: string | null;
      operationId: string | null;
      recovery: string;
      absenceProven: boolean;
    }> = {},
  ) {
    super(message);
    this.code = code;
    this.scopeRef = extra.scopeRef ?? null;
    this.operationId = extra.operationId ?? null;
    this.recovery = extra.recovery ?? "none";
    this.absenceProven = extra.absenceProven ?? false;
  }
}
/** A failed host-to-runtime call: a wire error frame, a timeout or a lost process. */
export class CallError extends Error {
  code: string;
  data: Record<string, unknown> | null;
  constructor(
    code: string,
    message: string,
    data: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type Json = Record<string, unknown>;

export interface LaunchSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  diagnosticsDir: string;
  /** Optional transcript for evidence; every frame in both directions is appended. */
  transcriptPath?: string;
}
type Pending = {
  resolve: (value: Json) => void;
  reject: (error: CallError) => void;
  timer: NodeJS.Timeout;
  method: string;
};
/** Every process creation gets a new incarnation and every pipe a new connection identity. */
export function newConnectionIds() {
  return {
    connectionId: "connection:" + randomUUID(),
    incarnationId: "incarnation:" + randomUUID(),
  };
}
export type InboundHandler = (
  connection: RuntimeConnection,
  method: string,
  params: Json,
) => Promise<Json>;

/** One protocol connection to one supervised process (one incarnation). */
export class RuntimeConnection {
  readonly connectionId: string;
  readonly incarnationId: string;
  child: ChildProcess | null = null;
  context: Context | null = null;
  exit: { code: number | null; signal: string | null; at: string } | null =
    null;
  closedBy: string | null = null;
  private pending = new Map<string, Pending>();
  private next = 0;
  private inFlight = 0;
  private queue: (() => void)[] = [];
  private reader = new LineReader(runtimeLimits);
  private stderrBytes = 0;
  private exitWaiters: (() => void)[] = [];
  onEvent: ((event: Json) => void) | null = null;
  onInbound: InboundHandler | null = null;
  onExit: (() => void) | null = null;
  frameRejections: { rpcCode: number; message: string; close: boolean }[] = [];
  contextRejections = 0;
  /** Responses that match no pending request (for example the Runtime's parse-error replies to refused frames); bounded diagnostics. */
  orphanReplies: { id: string | null; code: number | null }[] = [];
  constructor(
    readonly spec: LaunchSpec,
    ids: { connectionId: string; incarnationId: string } = newConnectionIds(),
    private readonly limits: RuntimeLimits = runtimeLimits,
  ) {
    this.connectionId = ids.connectionId;
    this.incarnationId = ids.incarnationId;
  }
  start() {
    mkdirSync(this.spec.diagnosticsDir, { recursive: true });
    pruneDiagnostics(this.spec.diagnosticsDir);
    const child = spawn(this.spec.argv[0], this.spec.argv.slice(1), {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const diagnosticsFile = join(
      this.spec.diagnosticsDir,
      this.incarnationId.slice(12) + ".log",
    );
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes <= diagnosticsRetainBytes)
        appendFileSync(diagnosticsFile, chunk);
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const piece of this.reader.feed(chunk))
        this.onRaw(piece.raw, piece.error);
    });
    child.stdin!.on("error", () => {
      /* The runtime may exit before the Host stops writing. */
    });
    child.on("error", (error) => {
      this.record("host-note", { spawnError: error.message });
      this.settleExit(null, "ENOENT");
    });
    child.on("exit", (code, signal) => this.settleExit(code, signal));
    return this;
  }
  get pid() {
    return this.child?.pid ?? null;
  }
  private settleExit(code: number | null, signal: string | null) {
    if (this.exit) return;
    this.exit = { code, signal, at: nowIso() };
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new CallError(
          "RUNTIME_EXITED",
          "runtime exited during " + pending.method,
        ),
      );
    }
    this.pending.clear();
    this.inFlight = 0;
    this.queue = [];
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    this.onExit?.();
  }
  /** Exit is proven by the parent's wait status; a PID probe afterwards must fail. */
  waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exit) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  pidGone(): boolean {
    const pid = this.child?.pid;
    if (!pid) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
  record(direction: string, value: unknown, note?: string) {
    if (!this.spec.transcriptPath) return;
    appendFileSync(
      this.spec.transcriptPath,
      JSON.stringify({ direction, value, ...(note ? { note } : {}) }) + "\n",
    );
  }
  private send(frame: unknown, note?: string) {
    this.record("host-to-runtime", frame, note);
    if (!this.exit && this.child?.stdin?.writable)
      this.child.stdin.write(encodeFrame(frame));
  }
  /** Host-to-runtime request; the in-flight limit queues instead of exceeding the profile. */
  call(
    method: string,
    params: Json = {},
    options: { timeout?: number; raw?: boolean } = {},
  ): Promise<Json> {
    const id = "h:" + ++this.next;
    const frame: RpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params:
        options.raw || !this.context
          ? params
          : { context: this.context as unknown as Json, ...params },
    } as RpcRequest;
    if (this.exit)
      return Promise.reject(
        new CallError("RUNTIME_EXITED", "runtime exited before " + method),
      );
    return new Promise((resolve, reject) => {
      const start = () => {
        if (this.exit) {
          reject(
            new CallError("RUNTIME_EXITED", "runtime exited before " + method),
          );
          return;
        }
        this.inFlight += 1;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.inFlight -= 1;
          this.pump();
          reject(
            new CallError(
              "TIMEOUT",
              "no answer within " +
                (options.timeout ?? rpcTimeoutMs) +
                "ms: " +
                method,
            ),
          );
        }, options.timeout ?? rpcTimeoutMs);
        this.pending.set(id, { resolve, reject, timer, method });
        this.send(frame);
      };
      if (this.inFlight < this.limits.inFlight) start();
      else this.queue.push(start);
    });
  }
  private pump() {
    while (this.queue.length && this.inFlight < this.limits.inFlight)
      this.queue.shift()!();
  }
  private onRaw(raw: Buffer | null, error: FrameError | null) {
    let message: RpcRequest | RpcResponse | undefined;
    if (!error) {
      try {
        message = parseFrame(raw!, this.limits);
      } catch (caught) {
        error = caught as FrameError;
      }
    }
    if (error) {
      this.frameRejections.push({
        rpcCode: error.rpcCode,
        message: error.message,
        close: error.close,
      });
      this.record(
        "runtime-to-host",
        {
          rejected: true,
          rpcCode: error.rpcCode,
          reason: error.message,
          bytes: raw?.length ?? null,
        },
        "frame rejected before dispatch",
      );
      if (error.close) this.close("oversized frame: " + error.message);
      return;
    }
    void this.onMessage(message!);
  }
  /** Closing keeps scopes stale and pending operations unresolved; the process is ended after a grace period. */
  close(reason: string) {
    if (this.closedBy) return;
    this.closedBy = reason;
    this.record("host-note", { closed: reason });
    try {
      this.child?.stdin?.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (!this.exit)
        try {
          this.child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
    }, 500).unref();
  }
  private async onMessage(message: RpcRequest | RpcResponse) {
    this.record("runtime-to-host", message);
    if ("method" in message) {
      const params = (message.params ?? {}) as Json;
      if (message.method === "runtime.event") {
        if (
          !this.context ||
          !validContext(params.context) ||
          !sameContext(params.context, this.context)
        ) {
          this.contextRejections += 1;
          return;
        }
        if (isRecord(params.event)) this.onEvent?.(params.event);
        return;
      }
      if (message.id === undefined) return;
      await this.handleInbound(message.id, message.method, params);
      return;
    }
    const pending =
      message.id === null ? undefined : this.pending.get(message.id);
    if (!pending) {
      if (this.orphanReplies.length < 64)
        this.orphanReplies.push({
          id: message.id,
          code: message.error?.code ?? null,
        });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id as string);
    this.inFlight -= 1;
    this.pump();
    if (message.error) {
      const data = isRecord(message.error.data) ? message.error.data : null;
      pending.reject(
        new CallError(
          typeof data?.code === "string"
            ? data.code
            : "RPC_" + message.error.code,
          message.error.message,
          data,
        ),
      );
      return;
    }
    const result = message.result;
    if (!isRecord(result)) {
      pending.reject(
        new CallError("PROTOCOL", "result is not an object: " + pending.method),
      );
      return;
    }
    if (
      pending.method !== "runtime.initialize" &&
      this.context &&
      (!validContext(result.context) ||
        !sameContext(result.context, this.context))
    ) {
      pending.reject(
        new CallError(
          "INTEGRITY_MISMATCH",
          "result context does not match the connection binding: " +
            pending.method,
        ),
      );
      return;
    }
    pending.resolve(result);
  }
  private async handleInbound(id: string, method: string, params: Json) {
    let result: Json | null = null;
    let failure: RpcFailure | null = null;
    try {
      if (!/^r:/.test(id))
        throw new RpcFailure(
          "PRECONDITION_CONFLICT",
          "runtime request id must start with r:",
        );
      if (
        !this.context ||
        !validContext(params.context) ||
        !sameContext(params.context, this.context)
      )
        throw new RpcFailure(
          "PERMISSION_DENIED",
          "context does not match the connection binding",
          { recovery: "reconnect" },
        );
      if (!this.onInbound)
        throw new RpcFailure(
          "PRECONDITION_CONFLICT",
          "host services are not available on this connection",
        );
      result = await this.onInbound(this, method, params);
    } catch (error) {
      failure =
        error instanceof RpcFailure
          ? error
          : new RpcFailure(
              "PRECONDITION_CONFLICT",
              String((error as Error)?.message ?? error),
            );
    }
    if (failure) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: failure.message.slice(0, 2048),
          data: {
            code: failure.code,
            scopeRef:
              failure.scopeRef ??
              (typeof params.scopeRef === "string" ? params.scopeRef : null),
            operationId:
              failure.operationId ??
              (typeof params.operationId === "string"
                ? params.operationId
                : null),
            recovery: failure.recovery,
            absenceProven: failure.absenceProven,
          },
        },
      });
    } else
      this.send({
        jsonrpc: "2.0",
        id,
        result: { context: this.context, ...result },
      });
  }
}
/** Diagnostics are bounded by age and total size; the newest files survive. */
function pruneDiagnostics(dir: string) {
  let files: { path: string; mtime: number; size: number }[] = [];
  try {
    // Finder metadata is not a diagnostics file and is never pruned.
    files = readdirSync(dir)
      .filter((name) => !isMacMetadata(name))
      .map((name) => {
        const stat = statSync(join(dir, name));
        return { path: join(dir, name), mtime: stat.mtimeMs, size: stat.size };
      });
  } catch {
    return;
  }
  const cutoff = Date.now() - diagnosticsRetainDays * 86_400_000;
  let total = 0;
  for (const file of files.sort((a, b) => b.mtime - a.mtime)) {
    total += file.size;
    if (file.mtime < cutoff || total > diagnosticsRetainBytes)
      rmSync(file.path, { force: true });
  }
}

export interface SupervisorOptions {
  runtimeRoot: string;
  descriptor: Omit<HostDescriptor, "publisherPins">;
  /** Persists a record through the business service; resolves false when the service is unavailable. */
  report: (command: RuntimeHostCommand) => Promise<boolean>;
  /** Host services for runtime-to-host requests (S-02); absent handlers refuse every request. */
  inbound?: InboundHandler;
  /** Execution profiles the Host has verified; the product build offers none (OD-323). */
  executionProfiles?: () => Json[];
  /** Publisher key digests pinned by the catalog for built-in runtime ids. */
  catalogPins?: Map<string, string>;
  transcriptsDir?: string;
  healthIntervalMs?: number;
  /** Lifecycle hooks for the Host services: after ready, on process exit, on every runtime.event. */
  hooks?: {
    ready?: (instance: RuntimeInstance) => void;
    exit?: (instance: RuntimeInstance) => void;
    event?: (instance: RuntimeInstance, event: Json) => void;
    /**
     * The refusal that holds an instance's handoff right now (a stop unconfirmed on it,
     * RUNTIME-04), or null when its resources may be released; consulted by shutdown only,
     * never by reconnect, health checks or application quit.
     */
    handoffBlock?: (instanceId: string) => Promise<RpcFailure | null>;
  };
}
interface Live {
  installation: RuntimeInstallation;
  instance: RuntimeInstance;
  connection: RuntimeConnection | null;
  healthTimer: NodeJS.Timeout | null;
  packageDir: string;
}
export class RuntimeSupervisor {
  private installations = new Map<string, RuntimeInstallation>();
  private live = new Map<string, Live>();
  private closing = false;
  /** Imports run one at a time, so two imports of one version cannot both pass the version check. */
  private importQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SupervisorOptions) {}
  get runtimeRoot() {
    return this.options.runtimeRoot;
  }
  private descriptor(): HostDescriptor {
    const pins = new Map(this.options.catalogPins ?? []);
    const installedVersions = new Map<
      string,
      { artifactDigest: string; releaseRecordDigest: string }
    >();
    for (const installation of this.installations.values()) {
      if (!pins.has(installation.runtimeId))
        pins.set(installation.runtimeId, installation.publicKeyDigest);
      installedVersions.set(
        installedVersionKey(installation.runtimeId, installation.version),
        {
          artifactDigest: installation.artifactDigest,
          releaseRecordDigest: installation.releaseRecordDigest,
        },
      );
    }
    return {
      ...this.options.descriptor,
      publisherPins: pins,
      installedVersions,
    };
  }
  /** Adopts the persisted records after (re)connecting to the business service. */
  adopt(installations: RuntimeInstallation[], instances: RuntimeInstance[]) {
    for (const installation of installations)
      this.installations.set(installation.installationId, installation);
    for (const instance of instances) {
      const entry = this.live.get(instance.instanceId);
      if (entry) continue;
      const installation = this.installations.get(instance.installationId);
      if (!installation) continue;
      this.live.set(instance.instanceId, {
        installation,
        instance,
        connection: null,
        healthTimer: null,
        packageDir: packageDir(
          this.options.runtimeRoot,
          installation.runtimeId,
          installation.artifactDigest,
        ),
      });
    }
  }
  /** Starts every compatible installation that has no running process (application start and reconnect of the service). */
  async activateAll() {
    for (const installation of this.installations.values()) {
      if (installation.incompatibility) continue;
      const existing = [...this.live.values()].find(
        (l) => l.installation.installationId === installation.installationId,
      );
      if (existing?.connection && !existing.connection.exit) continue;
      await this.activate(installation.installationId);
    }
  }
  installationsList() {
    return [...this.installations.values()];
  }
  instanceOf(instanceId: string) {
    return this.live.get(instanceId)?.instance ?? null;
  }
  connectionOf(instanceId: string) {
    return this.live.get(instanceId)?.connection ?? null;
  }
  /** Offline import: verification, record, package and first activation. */
  importBundle(
    sourceDir: string,
    reference: string,
  ): Promise<RuntimeImportReply> {
    const run = this.importQueue.then(() =>
      this.importOnce(sourceDir, reference),
    );
    this.importQueue = run.catch(() => undefined);
    return run;
  }
  private async importOnce(
    sourceDir: string,
    reference: string,
  ): Promise<RuntimeImportReply> {
    const descriptor = this.descriptor();
    const verdict = verifyBundle(sourceDir, descriptor);
    if (
      !verdict.identityVerified ||
      !verdict.release ||
      !verdict.manifest ||
      !verdict.launch
    )
      return {
        ok: false,
        code: verdict.code ?? "INTEGRITY_MISMATCH",
        reasons: verdict.reasons,
      };
    const publisherPin = descriptor.publisherPins.has(verdict.release.runtimeId)
      ? "pinned"
      : "first-use";
    // The same version with the same bytes is the installation already recorded: no second installation or instance.
    const existing = [...this.installations.values()].find(
      (i) =>
        i.runtimeId === verdict.release!.runtimeId &&
        i.version === verdict.release!.version &&
        i.artifactDigest === verdict.artifactDigest &&
        i.releaseRecordDigest === verdict.releaseRecordDigest,
    );
    if (existing)
      return {
        ok: true,
        installationId: existing.installationId,
        incompatible: existing.incompatibility !== null,
        existing: true,
        publisherPin,
        publicKeyDigest: verdict.publicKeyDigest,
      };
    const installation: RuntimeInstallation = {
      installationId: "installation:" + randomUUID(),
      runtimeId: verdict.release.runtimeId,
      version: verdict.release.version,
      publisherId: verdict.release.publisher.id,
      publicKeyDigest: verdict.publicKeyDigest,
      artifactDigest: verdict.artifactDigest,
      releaseRecordDigest: verdict.releaseRecordDigest,
      manifestDigest: verdict.manifestDigest,
      permissionProfileDigest: verdict.manifest.permissionProfileDigest,
      platform: verdict.manifest.platform,
      minimumOs: verdict.manifest.minimumOs,
      dataFormat: verdict.manifest.dataFormat,
      protocols: verdict.manifest.protocols,
      capabilities: verdict.manifest.capabilities,
      executionProfileRequirements:
        verdict.manifest.executionProfileRequirements.map((r) => ({
          capabilityId: r.capabilityId,
          profile: r.profile,
        })),
      launcher: verdict.launcher ?? {
        launcher: verdict.launch.launcher,
        binaryDigest: "",
        version: "",
      },
      entrypoint: verdict.manifest.entrypoint,
      argv: verdict.manifest.argv,
      source: { kind: "offline-import", reference },
      incompatibility: verdict.incompatibility,
      checkedFiles: verdict.checkedFiles,
      expandedBytes: verdict.expandedBytes,
      importedAt: nowIso(),
    };
    if (!verdict.incompatibility)
      installPackage(verdict, this.options.runtimeRoot, sourceDir);
    if (!(await this.options.report({ type: "runtimeInstall", installation })))
      return {
        ok: false,
        code: "UNAVAILABLE",
        reasons: ["业务服务不可用，安装记录未保存"],
      };
    this.installations.set(installation.installationId, installation);
    if (!verdict.incompatibility)
      await this.activate(installation.installationId);
    return {
      ok: true,
      installationId: installation.installationId,
      incompatible: verdict.incompatibility !== null,
      existing: false,
      publisherPin,
      publicKeyDigest: verdict.publicKeyDigest,
    };
  }
  private async persist(entry: Live, patch: Partial<RuntimeInstance>) {
    entry.instance = { ...entry.instance, ...patch, updatedAt: nowIso() };
    await this.options.report({
      type: "runtimeInstanceUpsert",
      instance: entry.instance,
    });
  }
  /** Ensures the primary instance record, then starts a new incarnation. */
  async activate(installationId: string) {
    const installation = this.installations.get(installationId);
    if (!installation || installation.incompatibility || this.closing)
      return null;
    let entry = [...this.live.values()].find(
      (l) => l.installation.installationId === installationId,
    );
    if (!entry) {
      const instance: RuntimeInstance = {
        instanceId: "instance:" + randomUUID(),
        installationId,
        createdAt: nowIso(),
        state: "stopped",
        incarnationId: null,
        connectionId: null,
        controlGeneration: null,
        pid: null,
        startedAt: null,
        launchArgv: [],
        exit: null,
        negotiation: null,
        failure: null,
        health: null,
        updatedAt: nowIso(),
      };
      entry = {
        installation,
        instance,
        connection: null,
        healthTimer: null,
        packageDir: packageDir(
          this.options.runtimeRoot,
          installation.runtimeId,
          installation.artifactDigest,
        ),
      };
      this.live.set(instance.instanceId, entry);
      await this.persist(entry, {});
    }
    return this.startIncarnation(entry);
  }
  /** Reconnect: a new incarnation and connection; the old process is ended first. */
  async reconnect(instanceId: string) {
    const entry = this.live.get(instanceId);
    if (!entry) return null;
    await this.stopProcess(entry, "reconnect requested");
    return this.startIncarnation(entry);
  }
  /** Re-verify: an immediate health check on the current connection. */
  async reverify(instanceId: string) {
    const entry = this.live.get(instanceId);
    if (!entry) return null;
    if (!entry.connection || entry.connection.exit)
      return this.startIncarnation(entry);
    await this.health(entry);
    return entry.instance;
  }
  private launchSpec(
    entry: Live,
    connection: { incarnationId: string },
  ):
    | { spec: LaunchSpec; expanded: string[]; directories: LaunchDirectories }
    | { failure: string; code: string } {
    const installation = entry.installation;
    // An installation recorded before the admission refused ${resourceHandle} is still never launched with an empty handle.
    if (needsResourceHandle(installation.argv))
      return {
        code: "UNSUPPORTED_VERSION",
        failure:
          "argv template uses ${resourceHandle}; this Host starts one instance per installation before any resource is registered, so it has no resource handle to pass at launch",
      };
    const verified = verifyInstalledPackage(entry.packageDir);
    if (!verified.ok)
      return {
        code: "INTEGRITY_MISMATCH",
        failure: "installed package changed: " + verified.reasons.join("; "),
      };
    // The launch configuration bound by permissionProfileDigest decides which Host variables the process receives.
    let launch: LaunchConfiguration;
    try {
      const bytes = readFileSync(join(entry.packageDir, "launch.json"));
      if (sha256(bytes) !== installation.permissionProfileDigest)
        throw new Error("launch.json differs from permissionProfileDigest");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      const problems = launchProblems(value);
      if (problems.length) throw new Error(problems.join("; "));
      launch = value as LaunchConfiguration;
    } catch (error) {
      return {
        code: "INTEGRITY_MISMATCH",
        failure: "launch configuration unusable: " + (error as Error).message,
      };
    }
    const instanceDir = join(
      this.options.runtimeRoot,
      "instances",
      entry.instance.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
    );
    mkdirSync(instanceDir, { recursive: true });
    const expanded = expandArgv(installation.argv, {
      runtimeRoot: this.options.runtimeRoot,
      instanceDir,
      contractDigest,
      resourceHandle: null,
    });
    const entrypoint = join(entry.packageDir, installation.entrypoint);
    const env = launchEnvironment(launch.environmentAllowList, instanceDir);
    let argv: string[];
    const launcher = installation.launcher;
    if (launcher.launcher === "direct") argv = [entrypoint, ...expanded];
    else if (launcher.launcher === this.options.descriptor.electronExecutable) {
      const stat = statSync(launcher.launcher);
      if (
        sha256(
          `${launcher.launcher}|${stat.size}|${Math.floor(stat.mtimeMs)}`,
        ) !== launcher.binaryDigest
      )
        return {
          code: "INTEGRITY_MISMATCH",
          failure: "application executable changed since admission",
        };
      env.ELECTRON_RUN_AS_NODE = "1";
      argv = [launcher.launcher, entrypoint, ...expanded];
    } else {
      if (
        !existsSync(launcher.launcher) ||
        sha256(readFileSync(launcher.launcher)) !== launcher.binaryDigest
      )
        return {
          code: "INTEGRITY_MISMATCH",
          failure:
            "launcher binary changed or missing since admission: " +
            launcher.launcher,
        };
      argv = [launcher.launcher, "-B", entrypoint, ...expanded];
    }
    const transcriptPath = this.options.transcriptsDir
      ? join(
          this.options.transcriptsDir,
          installation.runtimeId.replace(/[^A-Za-z0-9._-]/g, "_") +
            "-" +
            connection.incarnationId.slice(12, 20) +
            ".jsonl",
        )
      : undefined;
    if (transcriptPath)
      mkdirSync(this.options.transcriptsDir!, { recursive: true });
    return {
      spec: {
        argv,
        cwd: instanceDir,
        env,
        diagnosticsDir: join(instanceDir, "diagnostics"),
        transcriptPath,
      },
      expanded,
      directories: {
        runtimeRoot: this.options.runtimeRoot,
        packageDir: entry.packageDir,
        instanceDir,
      },
    };
  }
  private async startIncarnation(entry: Live) {
    if (this.closing) return entry.instance;
    const ids = newConnectionIds();
    const built = this.launchSpec(entry, ids);
    if ("failure" in built) {
      await this.persist(entry, {
        state: "failed",
        failure: {
          code: built.code,
          message: built.failure,
          at: nowIso(),
        },
      });
      return entry.instance;
    }
    const connection = new RuntimeConnection(built.spec, ids);
    connection.onInbound = this.options.inbound ?? null;
    entry.connection = connection;
    connection.onEvent = (event) => {
      if (entry.connection === connection)
        this.options.hooks?.event?.(entry.instance, event);
    };
    connection.onExit = () => {
      if (entry.connection !== connection) return;
      this.clearHealth(entry);
      this.options.hooks?.exit?.(entry.instance);
      void this.persist(entry, {
        state: "exited",
        pid: null,
        exit: connection.exit,
        failure: entry.instance.failure ?? {
          code: "RUNTIME_EXITED",
          message: `进程已退出（退出码 ${connection.exit?.code ?? "无"}，信号 ${connection.exit?.signal ?? "无"}）`,
          at: nowIso(),
        },
      });
    };
    connection.start();
    await this.persist(entry, {
      state: "starting",
      incarnationId: connection.incarnationId,
      connectionId: connection.connectionId,
      controlGeneration: null,
      pid: connection.pid,
      startedAt: nowIso(),
      launchArgv: built.spec.argv,
      launchDirectories: built.directories,
      exit: null,
      negotiation: null,
      failure: null,
      health: null,
    });
    try {
      const negotiation = await this.negotiate(entry, connection);
      await this.persist(entry, {
        state: "ready",
        controlGeneration: connection.context!.controlGeneration,
        negotiation,
      });
      await this.health(entry);
      this.scheduleHealth(entry);
      this.options.hooks?.ready?.(entry.instance);
    } catch (error) {
      const code =
        error instanceof CallError || error instanceof RpcFailure
          ? error.code
          : "PROTOCOL";
      await this.persist(entry, {
        state: "failed",
        failure: { code, message: (error as Error).message, at: nowIso() },
      });
      connection.close("negotiation failed: " + code);
    }
    return entry.instance;
  }
  private async negotiate(entry: Live, connection: RuntimeConnection) {
    const installation = entry.installation;
    const offeredProfiles = this.options.executionProfiles?.() ?? [];
    const params: Json = {
      installationId: installation.installationId,
      instanceId: entry.instance.instanceId,
      incarnationId: connection.incarnationId,
      connectionId: connection.connectionId,
      bundleDigest: installation.artifactDigest,
      protocols: [{ version: contractVersion, contractDigest }],
      capabilities: installation.capabilities,
      launchAuthorization: {
        authorizationRef: "launch:" + connection.incarnationId.slice(12),
        bundleDigest: installation.artifactDigest,
        permissionProfileDigest: installation.permissionProfileDigest,
        expiresAt: new Date(Date.now() + 3_600_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
      },
      executionProfiles: offeredProfiles,
      limits: runtimeLimits,
    };
    const result = await connection.call("runtime.initialize", params, {
      raw: true,
    });
    // Re-check every field of Initialized against what was offered before trusting the context.
    const context = result.context;
    if (
      !validContext(context) ||
      context.protocolVersion !== contractVersion ||
      context.contractDigest !== contractDigest ||
      context.installationId !== installation.installationId ||
      context.instanceId !== entry.instance.instanceId ||
      context.incarnationId !== connection.incarnationId ||
      context.connectionId !== connection.connectionId
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "Initialized context does not repeat the offered identities",
      );
    if (
      !validProtocol(result.selectedProtocol) ||
      result.selectedProtocol.version !== contractVersion ||
      result.selectedProtocol.contractDigest !== contractDigest
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "Initialized selected a protocol that was not offered",
      );
    if (
      !Array.isArray(result.capabilities) ||
      !result.capabilities.every(validCapability)
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "Initialized capabilities are malformed",
      );
    const offered = new Map(installation.capabilities.map((c) => [c.id, c]));
    for (const c of result.capabilities as Capability[]) {
      const o = offered.get(c.id);
      if (!o || o.version !== c.version || o.schemaDigest !== c.schemaDigest)
        throw new RpcFailure(
          "INTEGRITY_MISMATCH",
          "Initialized returned a capability outside the offered set: " + c.id,
        );
    }
    if (!validRuntimeLimits(result.limits))
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "Initialized limits are malformed",
      );
    if (
      !Array.isArray(result.executionProfiles) ||
      !result.executionProfiles.every(validProfileRef)
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "Initialized execution profiles are malformed",
      );
    for (const ref of result.executionProfiles as ExecutionProfileRef[])
      if (
        !offeredProfiles.some(
          (p) =>
            p.id === ref.id &&
            p.version === ref.version &&
            p.digest === ref.digest,
        )
      )
        throw new RpcFailure(
          "INTEGRITY_MISMATCH",
          "Initialized selected an execution profile that was not offered: " +
            ref.id,
        );
    if (result.recovery !== "snapshot-and-operation-query")
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "Initialized recovery mode is unknown",
      );
    const negotiated = result.capabilities as Capability[];
    for (const c of installation.capabilities)
      if (c.required && !negotiated.some((n) => n.id === c.id))
        throw new RpcFailure(
          "UNSUPPORTED_CAPABILITY",
          "required capability not negotiated: " + c.id,
        );
    // Profile requirements: a missing profile blocks ready for a required capability and drops an optional one.
    const selectedProfiles = result.executionProfiles as ExecutionProfileRef[];
    const usable = negotiated.filter((c) => {
      const requirement = installation.executionProfileRequirements.find(
        (r) => r.capabilityId === c.id,
      );
      if (!requirement) return true;
      const satisfied = selectedProfiles.some(
        (p) =>
          p.id === requirement.profile.id &&
          p.version === requirement.profile.version &&
          p.digest === requirement.profile.digest,
      );
      if (satisfied) return true;
      if (c.required)
        throw new RpcFailure(
          "UNSUPPORTED_CAPABILITY",
          `required capability ${c.id} needs execution profile ${requirement.profile.id}, which the Host does not offer`,
        );
      return false;
    });
    connection.context = context;
    const limits: RuntimeLimits = { ...runtimeLimits };
    for (const key of Object.keys(limits) as (keyof RuntimeLimits)[])
      limits[key] = Math.min(
        limits[key],
        (result.limits as RuntimeLimits)[key],
      );
    const ready = await connection.call("runtime.ready");
    if (ready.ready !== true)
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "runtime.ready did not confirm",
      );
    return {
      selectedProtocol: result.selectedProtocol,
      capabilities: usable,
      executionProfiles: selectedProfiles,
      limits,
    };
  }
  private scheduleHealth(entry: Live) {
    this.clearHealth(entry);
    entry.healthTimer = setInterval(
      () => void this.health(entry),
      this.options.healthIntervalMs ?? healthIntervalMs,
    );
    entry.healthTimer.unref();
  }
  private clearHealth(entry: Live) {
    if (entry.healthTimer) clearInterval(entry.healthTimer);
    entry.healthTimer = null;
  }
  /** Protocol health only; a timeout or an exited process is recorded as such, never as cached success. */
  private async health(entry: Live) {
    const connection = entry.connection;
    if (!connection || connection.exit) return;
    try {
      const result = await connection.call("runtime.health");
      const health =
        result.health === "ready"
          ? "ok"
          : result.health === "degraded"
            ? "degraded"
            : "failed";
      await this.persist(entry, {
        health: {
          result: health,
          reason: typeof result.reason === "string" ? result.reason : "",
          at: nowIso(),
        },
      });
    } catch (error) {
      if (entry.connection !== connection) return;
      const timeout = error instanceof CallError && error.code === "TIMEOUT";
      await this.persist(entry, {
        health: {
          result: timeout ? "timeout" : "failed",
          reason: (error as Error).message,
          at: nowIso(),
        },
      });
    }
  }
  private async stopProcess(entry: Live, reason: string) {
    this.clearHealth(entry);
    const connection = entry.connection;
    if (!connection) return;
    entry.connection = null;
    // Before initialize succeeded there is no Context, and the Contract allows nothing but the handshake:
    // such a process is closed and ended without a shutdown request.
    if (!connection.exit && connection.context) {
      // The shutdown operation is persisted with its key and digest before it is sent; the answer or its loss follows.
      const { operation, params } = shutdownOperation(entry, reason);
      await this.options.report({ type: "runtimeOperationUpsert", operation });
      try {
        await connection.call("runtime.shutdown", params, {
          timeout: rpcTimeoutMs,
        });
        await this.options.report({
          type: "runtimeOperationUpsert",
          operation: {
            ...operation,
            status: "succeeded",
            transport: "answered",
            updatedAt: nowIso(),
          },
        });
      } catch (error) {
        /* The process may already be gone or unresponsive; the record says so. */
        const code = error instanceof CallError ? error.code : "PROTOCOL";
        await this.options.report({
          type: "runtimeOperationUpsert",
          operation: {
            ...operation,
            transport:
              code === "TIMEOUT" || code === "RUNTIME_EXITED"
                ? "lost"
                : "refused",
            errorCode: code,
            reason: String((error as Error).message ?? "").slice(0, 2048),
            updatedAt: nowIso(),
          },
        });
      }
    }
    if (!connection.exit) {
      connection.close(reason);
      const exited = await connection.waitExit(3000);
      if (!exited || !connection.pidGone()) {
        try {
          connection.child?.kill("SIGKILL");
        } catch {
          /* gone */
        }
        await connection.waitExit(2000);
      }
    }
    await this.persist(entry, {
      state: "stopped",
      pid: null,
      exit: connection.exit,
    });
  }
  /**
   * The handoff path (architecture 安全切换顺序: the entry stops accepting, then releases the
   * resource so another entry can take the lock): the instance's process is asked to shut
   * down and ended, and the instance stays stopped until a reconnect. Refused while a stop
   * on the instance is unconfirmed; reconnect and application quit are not handoffs.
   */
  async shutdown(instanceId: string, reason: string) {
    const block = await this.options.hooks?.handoffBlock?.(instanceId);
    if (block) throw block;
    const entry = this.live.get(instanceId);
    if (!entry) return null;
    await this.stopProcess(entry, reason);
    return entry.instance;
  }
  /** Application quit: shutdown every instance and wait for real exits. */
  async closeAll() {
    this.closing = true;
    for (const entry of this.live.values())
      await this.stopProcess(entry, "application quit");
  }
}
/** Instance-level lifecycle request: the digest covers method and non-Context params (RFC 8785); the record is persisted before sending. */
function shutdownOperation(
  entry: Live,
  reason: string,
): { operation: RuntimeOperation; params: Json } {
  const operationId = "op:" + randomUUID();
  const body = {
    operationId,
    idempotencyKey: "key:" + operationId.slice(3),
    reason,
  };
  const requestDigest = digestOf({ method: "runtime.shutdown", ...body });
  const at = nowIso();
  return {
    operation: {
      operationId,
      installationId: entry.installation.installationId,
      instanceId: entry.instance.instanceId,
      scopeRef: "instance",
      method: "runtime.shutdown",
      origin: "host",
      idempotencyKey: body.idempotencyKey,
      requestDigest,
      request: body,
      status: "unknown",
      resultCode: null,
      reason: "",
      resultRef: null,
      executionRef: null,
      revision: null,
      result: null,
      transport: "sent",
      errorCode: null,
      recovery: null,
      createdAt: at,
      updatedAt: at,
    },
    params: { ...body, requestDigest },
  };
}
