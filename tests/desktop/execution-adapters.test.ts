import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Store } from "../../src/service/store";
import { RuntimeHost } from "../../src/main/runtime-host";
import {
  EmbeddedExecutionPort,
  executionEvidenceDir,
} from "../../src/main/execution-port";
import {
  ClaudeImplementerAdapter,
  claudeImplementerDigest,
  claudeImplementerProfileId,
} from "../../src/main/execution-claude";
import {
  ApprovalGate,
  CodexReviewerAdapter,
  codexReviewerArgs,
  codexReviewerDigest,
  codexReviewerPermissionProfile,
  codexReviewerProfileId,
  effectiveScope,
  expectedMaterialScope,
  verifyCodexReviewerPolicy,
} from "../../src/main/execution-codex";
import { helpListsOption } from "../../src/main/execution-adapter";
import { gitCommonDir, recordSegment } from "../../src/main/execution-record";
import { ClaudeDetector } from "../../src/main/claude";
import { claudeConnectionOf } from "../../src/main/claude-connector";
import { codexConnectionOf } from "../../src/main/codex-connector";
import { configureCodexProcessHelper } from "../../src/main/codex-process";
import { canonicalJson } from "../../src/shared/runtime-host";
import {
  contractDigest,
  contractVersion,
  type RuntimeHostCommand,
  type RuntimeInstallation,
  type RuntimeInstance,
} from "../../src/shared/runtime-host";
import {
  modelRefOf,
  type HostExecutionRecord,
} from "../../src/shared/runtime-execution";
import { createClaudeFixture } from "./claude-fixture";
import { createCodexFixture } from "./codex-fixture";
import { buildProcessHelper } from "./process-helper";

/**
 * S-02: the two product adapters of the embedded port against the fixture `claude` and
 * `codex` executables through the real Host and business Store. Start conditions are
 * re-read from the installation before every launch; every mismatch refuses the start with a
 * CONN-03 explanation instead of substituting another Agent or model; read-backs after the
 * release stop the target; the ApprovalGate answers exactly one expected-range request.
 */
type Json = Record<string, unknown>;
mkdirSync(".test-data/disposable", { recursive: true });
const digest = "a".repeat(64);
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const installation: RuntimeInstallation = {
  installationId: "installation:one",
  runtimeId: "runtime:test-graph",
  version: "1",
  publisherId: "publisher:csthink-test",
  publicKeyDigest: digest,
  artifactDigest: digest,
  releaseRecordDigest: digest,
  manifestDigest: digest,
  permissionProfileDigest: digest,
  platform: "darwin-arm64",
  minimumOs: "26.6.2",
  dataFormat: "test.f1",
  protocols: [{ version: contractVersion, contractDigest }],
  capabilities: [
    {
      id: "csthink.test.graph",
      version: contractVersion,
      schemaDigest: digest,
      required: true,
    },
  ],
  executionProfileRequirements: [],
  launcher: { launcher: "/usr/bin/true", binaryDigest: digest, version: "1" },
  entrypoint: "graph_fake.py",
  argv: [],
  source: { kind: "offline-import", reference: "test" },
  incompatibility: null,
  checkedFiles: 4,
  expandedBytes: 100,
  importedAt: "2026-09-19T00:00:00Z",
};
const instance: RuntimeInstance = {
  instanceId: "instance:one",
  installationId: "installation:one",
  createdAt: "2026-09-19T00:00:00Z",
  state: "ready",
  incarnationId: "incarnation:a",
  connectionId: "connection:instance:one",
  controlGeneration: "1",
  pid: null,
  startedAt: null,
  launchArgv: [],
  exit: null,
  negotiation: null,
  failure: null,
  health: null,
  updatedAt: "2026-09-19T00:00:00Z",
};
let helperPath: string | null = null;
function helper() {
  if (helperPath) return helperPath;
  const dir = mkdtempSync(resolve(".test-data/disposable/adapter-helper-"));
  helperPath = join(dir, "identity");
  buildProcessHelper(helperPath);
  configureCodexProcessHelper(helperPath);
  return helperPath;
}
const claudeModel = "claude-synthetic[1m]";
const codexModel = "synthetic-model";

async function harness() {
  const dir = mkdtempSync(resolve(".test-data/disposable/adapters-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const home = join(dir, "home");
  mkdirSync(home);
  const claude = createClaudeFixture(join(dir, "claude"));
  const codex = createCodexFixture(join(dir, "codex"));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    PATH: `${claude.bin}:${codex.bin}:/usr/bin:/bin`,
  };
  mkdirSync(join(dir, "data"));
  const store = new Store(join(dir, "data"));
  const host = new RuntimeHost({
    runtimeRoot: join(dir, "runtimes"),
    descriptor: {
      platform: "darwin-arm64",
      osVersion: "27.0",
      electronExecutable: process.execPath,
      pythonCandidates: [],
    },
    request: async (command: RuntimeHostCommand) =>
      store.execute(command, "main", "host"),
    records: () => store.snapshot(),
  });
  const detector = new ClaudeDetector(
    join(dir, "claude-inspection"),
    env,
    () => store.snapshot().settings.claude,
  );
  const executionsRoot = join(dir, "executions");
  const implementer = new ClaudeImplementerAdapter({
    environment: env,
    settings: () => store.snapshot().settings.claude,
    detect: () => detector.detect(),
    connections: () => store.snapshot().connections,
    statusTtlMs: 0,
  });
  const reviewer = new CodexReviewerAdapter({
    environment: env,
    settings: () => store.snapshot().settings.codex,
    connections: () => store.snapshot().connections,
    executionsRoot,
    statusTtlMs: 0,
  });
  const port = new EmbeddedExecutionPort({
    helper: helper(),
    adapters: [implementer, reviewer],
    evidenceRoot: join(executionsRoot, "evidence"),
    recordFallbackRoot: join(executionsRoot, "records"),
    hostImage: process.execPath,
  });
  host.registerExecutionPort(port);
  store.execute({ type: "runtimeInstall", installation }, "main", "host");
  store.execute({ type: "runtimeInstanceUpsert", instance }, "main", "host");
  store.execute(
    {
      type: "runtimeResourceRegister",
      resource: {
        handle: "resource:repo",
        kind: "directory",
        path: repo,
        registeredAt: "2026-09-19T00:00:00Z",
      },
    },
    "main",
    "host",
  );
  store.execute(
    {
      type: "runtimeScopeUpsert",
      scope: {
        instanceId: "instance:one",
        installationId: "installation:one",
        scopeRef: "scope:a",
        bindingRef: "binding:a",
        resourceHandle: "resource:repo",
        state: "active",
        grantRefs: [],
        freshness: "current",
        cursor: null,
        revision: null,
        snapshotId: null,
        subscriptionId: null,
        lastError: null,
        updatedAt: "2026-09-19T00:00:00Z",
      },
    },
    "main",
    "host",
  );
  // The confirmed connections: the same records the settings page writes after a detection.
  const status = await detector.detect();
  assert.equal(status.protocol, "available", status.message);
  store.execute(
    {
      type: "configureClaude",
      model: claudeModel,
      configuration: claudeConnectionOf(status, env, claudeModel),
      effort: status.efforts[claudeModel] ?? null,
    },
    "main",
    "host",
  );
  const codexConfiguration = await codexConnectionOf({
    effectiveConfig: {
      model: codexModel,
      model_provider: "openai",
      developer_instructions: "",
    },
    account: { type: "chatgpt", email: "private@synthetic.invalid" },
    thread: {
      id: "thread-fixture",
      model: codexModel,
      provider: "openai",
      instructions: [],
    },
    authentication: "chatgpt",
    environment: env,
  });
  store.execute(
    {
      type: "configureCodex",
      model: codexModel,
      configuration: codexConfiguration,
      effort: {
        levels: ["low", "medium", "high", "xhigh"],
        defaultLevel: "medium",
        source: "codex-model-list",
        recordedAt: "2026-09-19T00:00:00Z",
      },
    },
    "main",
    "host",
  );
  const connections = () => store.snapshot().connections;
  const claudeConnection = () =>
    connections().find((c) => c.provider === "claude")!;
  const codexConnection = () =>
    connections().find((c) => c.provider === "codex")!;
  const connection = {
    context: {
      protocolVersion: contractVersion,
      contractDigest,
      controlGeneration: "1",
      installationId: "installation:one",
      instanceId: "instance:one",
      incarnationId: "incarnation:a",
      connectionId: "connection:instance:one",
    },
    call: async () => {
      throw new Error("unexpected call");
    },
  };
  type Inbound = (
    c: unknown,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  const inbound = (host as unknown as { inbound: Inbound }).inbound.bind(
    host,
  ) as Inbound;
  await port.refreshProfiles();
  const grant = await host.grant(
    "instance:one",
    "scope:a",
    "csthink.test.graph",
    "graph.execute",
    "test",
  );
  /** A context snapshot of this scope, as host.context.capture would store it. */
  const snapshotOf = (objectRef: string, mediaType: string, bytes: Buffer) => {
    const handle = "context:" + sha([objectRef, bytes.length]).slice(0, 12);
    const file = join("instance_one", handle.slice(8) + ".bin");
    const path = join(dir, "runtimes", "context", file);
    mkdirSync(join(dir, "runtimes", "context", "instance_one"), {
      recursive: true,
    });
    writeFileSync(path, bytes);
    const digestHex = createHash("sha256").update(bytes).digest("hex");
    store.execute(
      {
        type: "runtimeContextSnapshotUpsert",
        snapshot: {
          handle,
          instanceId: "instance:one",
          installationId: "installation:one",
          scopeRef: "scope:a",
          operationId: "op:capture-" + handle.slice(8),
          domainOperationId: "op:domain-capture",
          source: {
            authority: "runtime",
            resourceHandle: "resource:repo",
            scopeRef: "scope:a",
            objectRef,
            revision: "1",
            mediaType,
            bytes: bytes.length,
            digest: digestHex,
          },
          objectRef,
          revision: "1",
          mediaType,
          bytes: bytes.length,
          digest: digestHex,
          file,
          createdAt: "2026-09-19T00:00:00Z",
        },
      },
      "main",
      "host",
    );
    return {
      authority: "host",
      resourceHandle: handle,
      scopeRef: "scope:a",
      objectRef,
      revision: "1",
      mediaType,
      bytes: bytes.length,
      digest: digestHex,
    };
  };
  let n = 0;
  const request = (
    kind: "implementer" | "reviewer",
    overrides: Record<string, unknown> = {},
  ) => {
    n += 1;
    const c = kind === "implementer" ? claudeConnection() : codexConnection();
    const model = modelRefOf(kind === "implementer" ? claudeModel : codexModel);
    const profile =
      kind === "implementer"
        ? { id: claudeImplementerProfileId, digest: claudeImplementerDigest }
        : { id: codexReviewerProfileId, digest: codexReviewerDigest };
    const binding = {
      profileDigest: profile.digest,
      agent: kind === "implementer" ? "agent:claude-code" : "agent:codex",
      model,
      modelVendor:
        kind === "implementer" ? "vendor:anthropic" : "vendor:openai",
      routeVendor: null,
      credentialRef: "credential:cli",
      configurationRevision: String(c.revision),
    };
    return {
      operationId: "op:exec-" + n,
      idempotencyKey: "key:exec-" + n,
      requestDigest: String(n).padStart(64, "0"),
      scopeRef: "scope:a",
      profileId: profile.id,
      profileDigest: profile.digest,
      domainOperationId: "op:domain-" + n,
      domainNodeRef: kind === "implementer" ? "node:implement" : "node:review",
      roleIntent: kind === "implementer" ? "role:implementer" : "role:reviewer",
      resourceHandle: "resource:repo",
      targetBinding:
        kind === "implementer"
          ? { resourceHandle: "resource:repo", relativePath: "src" }
          : null,
      connectionRef: "connection:" + c.id,
      configurationRevision: String(c.revision),
      model,
      executionBinding: binding,
      constraints: [],
      decisionRef: null,
      grantRefs: [grant.ref],
      contextRefs: [],
      budget: {
        maxToolCalls: 4,
        maxRunSeconds: 30,
        maxOutputBytes: 1048576,
        cleanupSeconds: 2,
      },
      ...overrides,
    };
  };
  const preflightOf = (req: ReturnType<typeof request>) => ({
    scopeRef: req.scopeRef,
    profileId: req.profileId,
    profileDigest: req.profileDigest,
    connectionRef: req.connectionRef,
    configurationRevision: req.configurationRevision,
    executionBinding: req.executionBinding,
    constraints: req.constraints,
  });
  const recordOf = (ref: string) =>
    store.snapshot().runtimeExecutions.find((r) => r.executionRef === ref)!;
  /** Waits for a terminal record; "stopping" without a stop-unconfirmed fact is a cancel still under way. */
  const finished = async (ref: string, ms = 30_000) => {
    const start = Date.now();
    for (;;) {
      const r = recordOf(ref);
      if (
        r &&
        !["reserved", "running", "queued"].includes(r.state) &&
        !(r.state === "stopping" && r.stopUnconfirmed === null)
      )
        return r;
      if (Date.now() - start > ms)
        throw new Error("timeout: " + JSON.stringify(r).slice(0, 400));
      await wait(50);
    }
  };
  const eventsOf = (r: HostExecutionRecord) =>
    store
      .snapshot()
      .events.filter((e) => e.executionId === r.executionId)
      .reverse();
  const calls = (file: string) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  const roleBinding = (
    roleIntent: string,
    connectionId: string,
    model: string,
    effort: string | null,
  ) => {
    const reply = store.execute(
      {
        type: "runtimeRoleBindingUpsert",
        binding: {
          instanceId: "instance:one",
          scopeRef: "scope:a",
          roleIntent,
          connectionId,
          model,
          effort,
          updatedAt: "2026-09-19T00:00:00Z",
        },
      },
      "main",
      "host",
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
  };
  return {
    dir,
    repo,
    home,
    claude,
    codex,
    store,
    host,
    port,
    implementer,
    reviewer,
    connection,
    inbound,
    request,
    preflightOf,
    recordOf,
    finished,
    eventsOf,
    calls,
    snapshotOf,
    roleBinding,
    claudeConnection,
    codexConnection,
    executionsRoot,
  };
}

// ---------------------------------------------------------------- pure pieces
test("help text: an option counts only as a whole word (the -p, --print form included)", () => {
  const help =
    "  -p, --print   Print\n  --max-budget-usd <amount>  cap\n  --model <model>  m\n  --safe-mode-x  no\n";
  assert.ok(helpListsOption(help, "--print"));
  // A real option the product no longer passes still counts as listed.
  assert.ok(helpListsOption(help, "--max-budget-usd"));
  assert.ok(helpListsOption(help, "--model"));
  assert.ok(!helpListsOption(help, "--safe-mode"));
  assert.ok(!helpListsOption(help, "--effort"));
});
test("reviewer policy: the restricted argv carries the granular approval policy, the three read entries and network off; the read-back verifier refuses an enabled MCP server, network on and an extra filesystem entry", () => {
  const inventory = { features: ["shell_tool", "hooks"], mcp: ["docs"] };
  const args = codexReviewerArgs("/bin/codex", "/tmp/session/cwd", inventory);
  const joined = args.join(" ");
  assert.equal(args[0], "app-server");
  assert.match(
    joined,
    /approval_policy=\{"granular"=\{.*"request_permissions"=true/,
  );
  assert.match(joined, /"shell_tool"=false/);
  assert.match(joined, /"unified_exec"=true/);
  assert.match(joined, /"docs"=\{"enabled"=false\}/);
  assert.match(
    joined,
    new RegExp(
      `permissions\\.${codexReviewerPermissionProfile}=\\{"filesystem"=\\{":minimal"="read","/bin/codex"="read","/tmp/session/cwd"="read"\\},"network"=\\{"enabled"=false\\}\\}`,
    ),
  );
  const good = {
    config: {
      features: {
        shell_tool: false,
        hooks: false,
        plugins: false,
        remote_plugin: false,
        apps: false,
        shell_snapshot: false,
        memories: false,
        computer_use: false,
        browser_use: false,
        browser_use_external: false,
        in_app_browser: false,
        image_generation: false,
        multi_agent: false,
        multi_agent_v2: false,
        workspace_dependencies: false,
        skill_mcp_dependency_install: false,
        skill_search: false,
        unbounded_connection_retries: false,
        view_image: false,
        goals: false,
        sleep_tool: false,
        tool_suggest: false,
        code_mode: false,
        web_search_cached: false,
        code_mode_host: true,
        skip_host_skill_discovery: true,
        request_permissions_tool: true,
        unified_exec: true,
      },
      mcp_servers: { docs: { enabled: false } },
      agents: { max_depth: 0 },
      notify: [],
      project_doc_max_bytes: 0,
      web_search: "disabled",
      approval_policy: {
        granular: {
          mcp_elicitations: false,
          rules: false,
          sandbox_approval: false,
          request_permissions: true,
          skill_approval: false,
        },
      },
      default_permissions: codexReviewerPermissionProfile,
      permissions: {
        [codexReviewerPermissionProfile]: {
          filesystem: {
            ":minimal": "read",
            "/bin/codex": "read",
            "/tmp/session/cwd": "read",
            glob_scan_max_depth: null,
          },
          network: { enabled: false },
        },
      },
    },
  };
  assert.doesNotThrow(() =>
    verifyCodexReviewerPolicy(
      good,
      "/bin/codex",
      "/tmp/session/cwd",
      inventory,
    ),
  );
  const mutate = (fn: (config: Json) => void) => {
    const copy = JSON.parse(JSON.stringify(good)) as { config: Json };
    fn(copy.config);
    return copy;
  };
  assert.throws(
    () =>
      verifyCodexReviewerPolicy(
        mutate((c) => ((c.mcp_servers as Json).docs = { enabled: true })),
        "/bin/codex",
        "/tmp/session/cwd",
        inventory,
      ),
    /mcp/,
  );
  assert.throws(
    () =>
      verifyCodexReviewerPolicy(
        mutate(
          (c) =>
            ((
              (c.permissions as Json)[codexReviewerPermissionProfile] as Json
            ).network = { enabled: true }),
        ),
        "/bin/codex",
        "/tmp/session/cwd",
        inventory,
      ),
    /configuration/,
  );
  assert.throws(
    () =>
      verifyCodexReviewerPolicy(
        mutate(
          (c) =>
            ((
              ((c.permissions as Json)[codexReviewerPermissionProfile] as Json)
                .filesystem as Json
            )["/Users"] = "read"),
        ),
        "/bin/codex",
        "/tmp/session/cwd",
        inventory,
      ),
    /configuration/,
  );
  assert.throws(
    () =>
      verifyCodexReviewerPolicy(
        mutate((c) => (c.approval_policy = "never")),
        "/bin/codex",
        "/tmp/session/cwd",
        inventory,
      ),
    /configuration/,
  );
});
test("approval gate: exactly the material directory read-only with the network closed is accepted once; an extra directory, network on, another turn, another cwd, a malformed scope and a second request are rejected without a grant", () => {
  const dir = mkdtempSync(resolve(".test-data/disposable/gate-"));
  const materials = join(dir, "materials");
  const cwd = join(dir, "cwd");
  mkdirSync(materials);
  mkdirSync(cwd);
  const make = () =>
    new ApprovalGate({
      threadId: "t1",
      turnId: "u1",
      cwd: resolve(cwd),
      scope: expectedMaterialScope(materials),
      windowMs: 300_000,
    });
  const entry = (path: string, access = "read") => ({
    access,
    path: { type: "path", path },
  });
  const params = (over: Json = {}) => ({
    threadId: "t1",
    turnId: "u1",
    itemId: "i1",
    cwd,
    startedAtMs: Date.now(),
    permissions: {
      fileSystem: {
        read: [materials],
        write: null,
        entries: [entry(materials)],
      },
      network: null,
    },
    ...over,
  });
  const method = "item/permissions/requestApproval";
  const gate = make();
  const accepted = gate.decide(method, 1, params());
  assert.equal(accepted.decision, "accepted");
  assert.deepEqual(accepted.response, {
    permissions: { fileSystem: { entries: [entry(materials)] } },
    scope: "turn",
    strictAutoReview: false,
  });
  assert.match(accepted.ref, /^approval:[0-9a-f]{32}$/);
  const second = gate.decide(method, 2, params());
  assert.equal(second.decision, "rejected");
  assert.deepEqual(second.response, { permissions: {}, scope: "turn" });
  assert.match(second.reason, /second request/);
  const cases: [string, Json, RegExp][] = [
    [
      "extra directory",
      {
        permissions: {
          fileSystem: { entries: [entry(materials), entry("/etc")] },
        },
      },
      /more or different/,
    ],
    [
      "write access",
      { permissions: { fileSystem: { entries: [entry(materials, "write")] } } },
      /more or different/,
    ],
    [
      "network on",
      {
        permissions: {
          fileSystem: { entries: [entry(materials)] },
          network: { enabled: true },
        },
      },
      /more or different/,
    ],
    ["other turn", { turnId: "u2" }, /routing/],
    ["other cwd", { cwd: materials }, /cwd/],
    ["stale time", { startedAtMs: Date.now() - 600_000 }, /window/],
    [
      "legacy read disagrees",
      {
        permissions: {
          fileSystem: { read: ["/etc"], entries: [entry(materials)] },
        },
      },
      /legacy read/,
    ],
    [
      "unknown field",
      {
        permissions: {
          fileSystem: { entries: [entry(materials)] },
          shell: true,
        },
      },
      /unknown fields/,
    ],
  ];
  for (const [label, over, pattern] of cases) {
    const decision = make().decide(method, 1, params(over));
    assert.equal(decision.decision, "rejected", label);
    assert.match(decision.reason, pattern, label);
    assert.deepEqual(
      decision.response,
      { permissions: {}, scope: "turn" },
      label,
    );
  }
  assert.equal(
    make().decide("item/tool/call", 1, params()).decision,
    "rejected",
  );
  assert.deepEqual(
    effectiveScope({ fileSystem: { read: ["/a"], write: ["/b"] } }),
    {
      entries: [entry("/a"), entry("/b", "write")],
      networkEnabled: false,
    },
  );
});

// ---------------------------------------------------------------- Claude Implementer
test("claude implementer: preflight lists every start condition; the start releases the prompt with the materials inline after the help text, login, connection, model and effort re-checks and without any cost cap argument; init read-back, actual model, tools and effort land in the record, the events and the target directory", async () => {
  const h = await harness();
  try {
    await h.roleBinding(
      "role:implementer",
      h.claudeConnection().id,
      claudeModel,
      "high",
    );
    const material = h.snapshotOf(
      "task:1",
      "text/markdown",
      Buffer.from("# 任务\n请在 src 目录实施。\n", "utf8"),
    );
    const req = h.request("implementer", { contextRefs: [material] });
    const checks = (await h.inbound(
      h.connection,
      "host.execution.preflight",
      h.preflightOf(req),
    )) as {
      status: string;
      checks: { id: string; passed: boolean; detail: string }[];
    };
    assert.equal(checks.status, "supported", JSON.stringify(checks.checks));
    assert.deepEqual(
      checks.checks.map((c) => c.id),
      [
        "claude-enabled",
        "claude-installed",
        "claude-policy",
        "claude-help",
        "claude-login",
        "connection",
        "connection-model",
        "effort-option",
      ],
    );
    const accepted = await h.inbound(h.connection, "host.execution.start", req);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    const done = await h.finished(String(accepted.executionRef));
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(done.model, "claude-synthetic:1m", "the Contract ref");
    assert.equal(done.effort, "high");
    assert.ok(!("costCapUsd" in done), "no cost cap field (spec 0.6 r3 U-19)");
    assert.deepEqual(done.actualBinding, {
      model: claudeModel,
      source: "protocol-result",
      observedModels: [claudeModel],
    });
    assert.equal(done.accounting?.toolCalls, 1);
    assert.equal(done.exitClassification, "exited");
    // The fixture saw one print invocation with the policy argv, the prompt with the material and the boundary headers.
    const lines = h.calls(h.claude.calls);
    const launch = lines.find(
      (l) =>
        Array.isArray(l.args) &&
        (l.args as string[]).includes("-p") &&
        (l.args as string[]).includes("--safe-mode"),
    )!;
    const argv = launch.args as string[];
    assert.ok(argv.includes("--restricted") && argv.includes("--safe-mode"));
    assert.equal(argv[argv.indexOf("--tools") + 1], "Edit,Read,Write");
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(argv[argv.indexOf("--permission-prompts") + 1], "none");
    assert.ok(
      !argv.includes("--max-budget-usd"),
      "no USD cost cap is passed (spec 0.6 r3 U-19, OD-331)",
    );
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    assert.equal(argv[argv.indexOf("--model") + 1], claudeModel);
    assert.equal(argv[argv.indexOf("--input-format") + 1], "text");
    const prompt = lines.find((l) => typeof l.prompt === "string")!;
    assert.match(
      String(prompt.prompt),
      /材料 1\/1 开始 · objectRef task:1 · revision 1 · text\/markdown · \d+ 字节 · sha256 [0-9a-f]{64}/,
    );
    assert.ok(String(prompt.prompt).includes("请在 src 目录实施。"));
    assert.equal(prompt.cwd, join(h.repo, "src"));
    assert.ok(
      !(prompt.env as string[]).includes("SHELL"),
      "no inherited environment",
    );
    assert.ok(existsSync(join(h.repo, "src", "IMPLEMENTED.md")));
    const kinds = h.eventsOf(done).map((e) => e.kind);
    assert.deepEqual(kinds, ["submitted", "started", "completed"]);
    const started = h.eventsOf(done).find((e) => e.kind === "started")!;
    assert.equal(started.payload.effort, "high");
    assert.ok(!("costCapUsd" in started.payload));
    const completed = h.eventsOf(done).find((e) => e.kind === "completed")!;
    assert.equal(completed.payload.model, claudeModel);
    assert.equal(completed.payload.toolCalls, 1);
    const evidence = JSON.parse(
      readFileSync(
        join(
          executionEvidenceDir(
            join(h.executionsRoot, "evidence"),
            done.executionRef,
          ),
          "result.json",
        ),
        "utf8",
      ),
    ) as { evidence: { init: Json; result: Json } };
    assert.deepEqual(evidence.evidence.init.tools, ["Edit", "Read", "Write"]);
    assert.equal(evidence.evidence.init.permissionMode, "acceptEdits");
    assert.equal(evidence.evidence.result.subtype, "success");
    assert.equal(evidence.evidence.result.total_cost_usd, 0.0042);
  } finally {
    await h.port.close();
  }
});
test("claude implementer refusals before any process: a help text missing an option is unsupported and names it; a local selection for another model is a precondition conflict; a local level the installation does not offer is unsupported; nothing is launched and no other Agent or model is used", async () => {
  const h = await harness();
  try {
    // Implementer launches carry --safe-mode; the detection's own inspection sessions do not.
    const launches = () =>
      h
        .calls(h.claude.calls)
        .filter(
          (l) =>
            Array.isArray(l.args) &&
            (l.args as string[]).includes("--safe-mode"),
        ).length;
    const before = launches();
    // 1. help text without --safe-mode and --permission-prompts
    h.claude.update({ helpOmit: ["--safe-mode", "--permission-prompts"] });
    const req1 = h.request("implementer");
    const pre = (await h.inbound(
      h.connection,
      "host.execution.preflight",
      h.preflightOf(req1),
    )) as {
      status: string;
      checks: { id: string; passed: boolean; detail: string }[];
    };
    assert.equal(pre.status, "unsupported");
    const help = pre.checks.find((c) => c.id === "claude-help")!;
    assert.equal(help.passed, false);
    assert.match(help.detail, /缺少参数：--safe-mode、--permission-prompts/);
    const started1 = await h.inbound(
      h.connection,
      "host.execution.start",
      req1,
    );
    assert.equal(started1.status, "failed");
    assert.equal(started1.resultCode, "UNSUPPORTED_CAPABILITY");
    assert.match(
      String(started1.reason),
      /claude-help.*--safe-mode.*不改用其他 Agent 或模型/,
    );
    const r1 = await h.finished(String(started1.executionRef));
    assert.equal(r1.state, "failed");
    h.claude.update({ helpOmit: [] });
    // 2. local selection names another model
    await h.roleBinding(
      "role:implementer",
      h.claudeConnection().id,
      "claude-other",
      null,
    );
    const started2 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer"),
    );
    assert.equal(started2.resultCode, "PRECONDITION_CONFLICT");
    assert.match(String(started2.reason), /局部选择与请求不一致/);
    // 3. local level the installation does not list
    await h.roleBinding(
      "role:implementer",
      h.claudeConnection().id,
      claudeModel,
      "ultra",
    );
    const started3 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer"),
    );
    assert.equal(started3.resultCode, "UNSUPPORTED_CAPABILITY");
    assert.match(String(started3.reason), /局部选择的档位 ultra 当前不可用/);
    await h.roleBinding(
      "role:implementer",
      h.claudeConnection().id,
      claudeModel,
      null,
    );
    // 4. binary material
    const binary = h.snapshotOf(
      "blob:1",
      "application/octet-stream",
      Buffer.from([0, 1, 2]),
    );
    const started5 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer", { contextRefs: [binary] }),
    );
    assert.equal(started5.resultCode, "UNSUPPORTED_CAPABILITY");
    assert.match(String(started5.reason), /只接受文本材料/);
    assert.equal(
      launches(),
      before,
      "no target was launched by a refused start",
    );
    // A context ref that does not match the stored snapshot is refused before the reservation.
    await assert.rejects(
      () =>
        h.inbound(
          h.connection,
          "host.execution.start",
          h.request("implementer", {
            contextRefs: [{ ...binary, digest: "b".repeat(64) }],
          }),
        ),
      (error: unknown) =>
        (error as { code?: string }).code === "PRECONDITION_CONFLICT",
    );
  } finally {
    await h.port.close();
  }
});
test("claude implementer after release: an init frame whose tools or permission mode differ from the request stops the target at once and records failed; a no-default model runs without --effort and records none; error_max_budget_usd is a budget failure", async () => {
  const h = await harness();
  try {
    h.claude.update({ implementer: "wrongTools" });
    const s1 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer"),
    );
    assert.equal(s1.status, "running", JSON.stringify(s1));
    const r1 = await h.finished(String(s1.executionRef));
    assert.equal(r1.state, "failed", JSON.stringify(r1));
    assert.match(r1.reason, /启动读回不符：工具集合 Bash,Read/);
    assert.ok(!existsSync(join(h.repo, "src", "IMPLEMENTED.md")));
    const failed = h.eventsOf(r1).find((e) => e.kind === "failed")!;
    assert.equal(failed.payload.resultCode, "READBACK_MISMATCH");
    assert.equal(failed.payload.errorClass, "protocol");
    // No local level, no recorded default (Claude records state none): nothing passed, recorded as none.
    h.claude.update({ implementer: "normal" });
    const s2 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer"),
    );
    const r2 = await h.finished(String(s2.executionRef));
    assert.equal(r2.state, "completed", JSON.stringify(r2));
    assert.equal(r2.effort, null);
    const argv = h
      .calls(h.claude.calls)
      .filter(
        (l) =>
          Array.isArray(l.args) && (l.args as string[]).includes("--safe-mode"),
      )
      .at(-1)!.args as string[];
    assert.ok(!argv.includes("--effort"));
    // A native budget end reported by the CLI itself (the product passes no cap)
    h.claude.update({ implementer: "budget" });
    const s3 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer"),
    );
    const r3 = await h.finished(String(s3.executionRef));
    assert.equal(r3.state, "failed");
    const budget = h.eventsOf(r3).find((e) => e.kind === "failed")!;
    assert.equal(budget.payload.resultCode, "BUDGET_EXCEEDED");
    assert.equal(budget.payload.errorClass, "budget");
    assert.equal(r3.actualBinding?.model, claudeModel);
  } finally {
    await h.port.close();
  }
});

// ---------------------------------------------------------------- Codex Reviewer
test("codex reviewer: preflight runs the inventory and the restricted inspection app-servers; the start releases initialize, re-reads the configuration, reads the account and thread back, writes the materials into the session directory, accepts exactly one expected-range approval and records the thread model, the approval and the answer", async () => {
  const h = await harness();
  try {
    await h.roleBinding(
      "role:reviewer",
      h.codexConnection().id,
      codexModel,
      "high",
    );
    const a = h.snapshotOf(
      "candidate:1",
      "text/markdown",
      Buffer.from("# 候选\n正文\n", "utf8"),
    );
    const b = h.snapshotOf(
      "task:1",
      "text/plain",
      Buffer.from("任务书\n", "utf8"),
    );
    const req = h.request("reviewer", { contextRefs: [a, b] });
    const pre = (await h.inbound(
      h.connection,
      "host.execution.preflight",
      h.preflightOf(req),
    )) as {
      status: string;
      checks: { id: string; passed: boolean; detail: string }[];
    };
    assert.equal(pre.status, "supported", JSON.stringify(pre.checks));
    assert.deepEqual(
      pre.checks.map((c) => c.id),
      [
        "codex-enabled",
        "codex-installed",
        "codex-protocol",
        "codex-login",
        "connection",
        "connection-model",
        "model-available",
        "effort-option",
        "codex-restricted-config",
      ],
    );
    const accepted = await h.inbound(h.connection, "host.execution.start", req);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    const done = await h.finished(String(accepted.executionRef));
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(done.effort, "high");
    assert.deepEqual(done.actualBinding, {
      model: codexModel,
      source: "protocol-init",
      observedModels: [codexModel],
    });
    assert.equal(done.approvalDecisionRefs.length, 1);
    assert.match(done.approvalDecisionRefs[0], /^approval:[0-9a-f]{32}$/);
    assert.equal(done.accounting?.toolCalls, 1);
    const kinds = h.eventsOf(done).map((e) => e.kind);
    assert.deepEqual(kinds, [
      "submitted",
      "started",
      "approval_accepted",
      "completed",
    ]);
    const approval = h
      .eventsOf(done)
      .find((e) => e.kind === "approval_accepted")!;
    assert.equal(approval.payload.decisionRef, done.approvalDecisionRefs[0]);
    assert.equal(approval.payload.networkEnabled, false);
    const completed = h.eventsOf(done).find((e) => e.kind === "completed")!;
    assert.equal(completed.payload.approvals, 1);
    // The fixture's view: thread/start parameters, the turn input naming the material directory, the granted entry.
    const calls = h.calls(h.codex.calls);
    const threadStart = calls.filter((c) => c.method === "thread/start").at(-1)!
      .params as Json;
    assert.equal(threadStart.ephemeral, true);
    assert.equal(threadStart.permissions, codexReviewerPermissionProfile);
    assert.equal(
      (threadStart.approvalPolicy as { granular: Json }).granular
        .request_permissions,
      true,
    );
    assert.equal(threadStart.allowProviderModelFallback, false);
    assert.deepEqual(threadStart.dynamicTools, []);
    assert.equal((threadStart.config as Json).model_reasoning_effort, "high");
    assert.match(String(threadStart.developerInstructions), /只读/);
    // The environment is selected, not closed: neither thread/start nor turn/start carries `environments`
    // (an empty list removes exec_command and request_permissions in Codex 0.155.1, V-18).
    assert.equal("environments" in threadStart, false);
    const turnStart = calls.filter((c) => c.method === "turn/start").at(-1)!
      .params as Json;
    assert.equal("environments" in turnStart, false);
    const turn = calls.find((c) => c.reviewerTurn === true)!;
    const materials = String(turn.materials);
    assert.ok(materials.startsWith(join(h.executionsRoot, "sessions")));
    assert.deepEqual(
      readFileSync(join(materials, "01-candidate_1.md"), "utf8"),
      "# 候选\n正文\n",
    );
    assert.ok(existsSync(join(materials, "02-task_1.txt")));
    const granted = calls.find((c) => "approvalResponse" in c)!;
    assert.equal(granted.granted, true);
    assert.deepEqual(
      (
        granted.approvalResponse as {
          permissions: { fileSystem: { entries: unknown[] } };
        }
      ).permissions.fileSystem.entries,
      [{ access: "read", path: { type: "path", path: materials } }],
    );
    // The result document holds the answer bytes and the read-backs.
    const evidence = JSON.parse(
      readFileSync(
        join(
          executionEvidenceDir(
            join(h.executionsRoot, "evidence"),
            done.executionRef,
          ),
          "result.json",
        ),
        "utf8",
      ),
    ) as { evidence: Json; nativeSession: Json };
    assert.equal(
      evidence.evidence.answer,
      "REVIEW: 01-candidate_1.md,02-task_1.txt bytes 16,10",
    );
    assert.equal((evidence.evidence.readback as Json).fingerprintMatches, true);
    assert.deepEqual((evidence.evidence.readback as Json).environment, {
      environmentId: "local",
      cwd: join(materials, "..", "cwd"),
      runtimeWorkspaceRoots: [join(materials, "..", "cwd")],
    });
    assert.equal(
      evidence.nativeSession.sessionRef,
      "codex-thread:thread-fixture",
    );
    assert.equal(evidence.nativeSession.turnRef, "codex-turn:turn-fixture");
    assert.equal((evidence.evidence.inspections as unknown[]).length, 1);
    // The turn's working directory is the empty session cwd, not the materials.
    const cwd = calls.filter((c) => c.method === "thread/start").at(-1)!
      .params as Json;
    assert.equal(cwd.cwd, join(materials, "..", "cwd"));
  } finally {
    await h.port.close();
  }
});
test("codex reviewer refusals: a restricted configuration that reads back with an enabled MCP server or the network open fails preflight and stops the target after initialize with no thread; a local selection for another connection is a precondition conflict", async () => {
  const h = await harness();
  try {
    for (const [patch, pattern] of [
      [{ reviewerMcpEnabled: true, reviewerNetwork: false }, /mcp/],
      [{ reviewerMcpEnabled: false, reviewerNetwork: true }, /configuration/],
    ] as const) {
      h.codex.update(patch);
      const req = h.request("reviewer");
      const pre = (await h.inbound(
        h.connection,
        "host.execution.preflight",
        h.preflightOf(req),
      )) as {
        status: string;
        checks: { id: string; passed: boolean; detail: string }[];
      };
      assert.equal(pre.status, "unsupported");
      const restricted = pre.checks.find(
        (c) => c.id === "codex-restricted-config",
      )!;
      assert.equal(restricted.passed, false);
      assert.match(restricted.detail, pattern);
      // A start (which does not repeat the restricted inspection) releases initialize and stops at the config re-check.
      const started = await h.inbound(
        h.connection,
        "host.execution.start",
        req,
      );
      assert.equal(started.status, "running", JSON.stringify(started));
      const done = await h.finished(String(started.executionRef));
      assert.equal(done.state, "failed", JSON.stringify(done));
      assert.match(done.reason, /受限配置读回不符/);
      assert.equal(
        h.eventsOf(done).find((e) => e.kind === "failed")!.payload.resultCode,
        "READBACK_MISMATCH",
      );
    }
    const threadStarts = h
      .calls(h.codex.calls)
      .filter((c) => c.method === "thread/start");
    assert.equal(
      threadStarts.length,
      0,
      "no thread was started by a refused configuration",
    );
    h.codex.update({ reviewerMcpEnabled: false, reviewerNetwork: false });
    // The thread's environment read-back must be exactly the local environment on the session cwd:
    // an empty list (environment access closed), null or another directory stops before any turn.
    for (const shape of ["empty", "null", "foreign"] as const) {
      h.codex.update({ reviewerEnvironments: shape });
      const started = await h.inbound(
        h.connection,
        "host.execution.start",
        h.request("reviewer"),
      );
      assert.equal(started.status, "running", JSON.stringify(started));
      const done = await h.finished(String(started.executionRef));
      assert.equal(done.state, "failed", shape + ": " + JSON.stringify(done));
      assert.match(
        done.reason,
        /thread\/start 读回与请求不符：.*thread\.environments/,
      );
      assert.equal(
        h.eventsOf(done).find((e) => e.kind === "failed")!.payload.resultCode,
        "READBACK_MISMATCH",
      );
    }
    assert.equal(
      h.calls(h.codex.calls).filter((c) => c.method === "turn/start").length,
      0,
      "no turn was started after a refused environment read-back",
    );
    h.codex.update({ reviewerEnvironments: "local" });
    // Phased messages (Codex 0.155.1 MessagePhase): commentary before exactly one final_answer completes
    // with the final answer as the answer; a second final_answer is a protocol error.
    h.codex.update({ reviewer: "commentary" });
    const commented = await h.finished(
      String(
        (
          await h.inbound(
            h.connection,
            "host.execution.start",
            h.request("reviewer"),
          )
        ).executionRef,
      ),
    );
    assert.equal(commented.state, "completed", JSON.stringify(commented));
    assert.match(
      commented.reason,
      /one final answer after 2 commentary message/,
    );
    const commentedDocument = JSON.parse(
      readFileSync(
        join(
          executionEvidenceDir(
            join(h.executionsRoot, "evidence"),
            commented.executionRef,
          ),
          "result.json",
        ),
        "utf8",
      ),
    ) as { evidence: Json };
    assert.match(String(commentedDocument.evidence.answer), /^REVIEW final: /);
    assert.deepEqual(commentedDocument.evidence.messagePhases, {
      commentary: 2,
      finalAnswer: 1,
      unphased: 0,
    });
    assert.equal(commentedDocument.evidence.agentMessages, 3);
    h.codex.update({ reviewer: "twoFinal" });
    const twice = await h.finished(
      String(
        (
          await h.inbound(
            h.connection,
            "host.execution.start",
            h.request("reviewer"),
          )
        ).executionRef,
      ),
    );
    assert.equal(twice.state, "failed", JSON.stringify(twice));
    assert.match(twice.reason, /final_answer 2/);
    assert.equal(
      h.eventsOf(twice).find((e) => e.kind === "failed")!.payload.resultCode,
      "PROTOCOL_ERROR",
    );
    h.codex.update({ reviewer: "normal" });
    await h.roleBinding(
      "role:reviewer",
      h.claudeConnection().id,
      codexModel,
      null,
    );
    const started = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("reviewer"),
    );
    assert.equal(started.resultCode, "PRECONDITION_CONFLICT");
    assert.match(String(started.reason), /局部选择与请求不一致/);
  } finally {
    await h.port.close();
  }
});
test("codex reviewer approval gate on the wire: a request for an extra directory or the network is answered with no grant, recorded as approval_rejected and the turn is interrupted; a second request is rejected after the first was accepted; a tool call from the server is refused", async () => {
  const h = await harness();
  try {
    for (const [mode, refs] of [
      ["scopeExtra", 1],
      ["network", 1],
      ["twice", 2],
    ] as const) {
      h.codex.update({ reviewer: mode });
      const started = await h.inbound(
        h.connection,
        "host.execution.start",
        h.request("reviewer"),
      );
      assert.equal(
        started.status,
        "running",
        mode + " " + JSON.stringify(started),
      );
      const done = await h.finished(String(started.executionRef));
      assert.equal(done.state, "failed", mode + " " + JSON.stringify(done));
      assert.equal(done.approvalDecisionRefs.length, refs, mode);
      const events = h.eventsOf(done).map((e) => e.kind);
      if (mode === "twice")
        assert.deepEqual(events, [
          "submitted",
          "started",
          "approval_accepted",
          "approval_rejected",
          "failed",
        ]);
      else
        assert.deepEqual(events, [
          "submitted",
          "started",
          "approval_rejected",
          "failed",
        ]);
      const failed = h.eventsOf(done).find((e) => e.kind === "failed")!;
      assert.equal(failed.payload.resultCode, "APPROVAL_REJECTED", mode);
      assert.equal(failed.payload.errorClass, "permission", mode);
      const rejected = h
        .eventsOf(done)
        .find((e) => e.kind === "approval_rejected")!;
      assert.match(
        String(rejected.payload.reason),
        mode === "twice" ? /second request/ : /more or different/,
      );
      const calls = h.calls(h.codex.calls);
      const responses = calls.filter(
        (c) => "approvalResponse" in c || "secondApproval" in c,
      );
      const last = responses.at(-1)!;
      const answer = (last.approvalResponse ?? last.secondApproval) as Json;
      assert.deepEqual(answer, { permissions: {}, scope: "turn" }, mode);
      assert.ok(
        calls.some((c) => c.method === "turn/interrupt"),
        mode + ": the turn was interrupted",
      );
      writeFileSync(h.codex.calls, "");
    }
    h.codex.update({ reviewer: "toolCall" });
    const started = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("reviewer"),
    );
    const done = await h.finished(String(started.executionRef));
    assert.equal(done.state, "failed");
    assert.equal(
      h.eventsOf(done).find((e) => e.kind === "failed")!.payload.resultCode,
      "UNEXPECTED_SERVER_REQUEST",
    );
    assert.equal(canonicalJson(done.approvalDecisionRefs), "[]");
  } finally {
    await h.port.close();
  }
});

// ---------------------------------------------------------------- S-03: cancel through the product adapters
test("cancel through the product adapters: the Claude Implementer target (stdin already ended) is stopped by SIGTERM and recorded stopped/cancelled with the signaled classification; the Codex Reviewer turn is interrupted natively (turn/interrupt, the interrupted turn/completed, end of stdin) and exits on its own before any signal", async () => {
  const h = await harness();
  try {
    h.claude.update({ implementer: "hang" });
    const s1 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("implementer"),
    );
    assert.equal(s1.status, "running", JSON.stringify(s1));
    const ref1 = String(s1.executionRef);
    // The fixture records the prompt and writes its init frame in one synchronous step after stdin
    // ends; the cancel goes out only after that, so the stopped record carries the init read-back.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (h.calls(h.claude.calls).some((c) => typeof c.prompt === "string"))
          return resolve();
        if (Date.now() - start > 20_000)
          return reject(new Error("the implementer did not read its prompt"));
        setTimeout(tick, 50);
      };
      tick();
    });
    const c1 = await h.inbound(h.connection, "host.execution.cancel", {
      operationId: "op:cancel-1",
      idempotencyKey: "key:cancel-1",
      requestDigest: "1".padStart(64, "c"),
      scopeRef: "scope:a",
      executionRef: ref1,
    });
    assert.equal(c1.status, "succeeded", JSON.stringify(c1));
    const r1 = await h.finished(ref1);
    assert.equal(r1.state, "stopped", JSON.stringify(r1));
    assert.equal(r1.stopReason, "cancelled");
    assert.equal(r1.exit?.signal, "SIGTERM");
    assert.equal(r1.exitClassification, "signaled");
    assert.equal(r1.accounting?.pidGoneAfterExit, true);
    assert.equal(r1.actualBinding?.model, claudeModel);
    assert.deepEqual(
      h.eventsOf(r1).map((e) => e.kind),
      ["submitted", "started", "stop_requested", "stopped"],
    );
    const stopped = h.eventsOf(r1).find((e) => e.kind === "stopped")!;
    assert.equal(stopped.payload.stopReason, "cancelled");
    assert.equal(stopped.payload.classification, "signaled");
    const evidence1 = JSON.parse(
      readFileSync(
        join(
          executionEvidenceDir(join(h.executionsRoot, "evidence"), ref1),
          "result.json",
        ),
        "utf8",
      ),
    ) as { signals: { stage: string; sent: boolean }[] };
    assert.deepEqual(
      evidence1.signals.map((s) => [s.stage, s.sent]),
      [["TERM", true]],
    );
    // Reviewer: the turn never completes; the cancel is a native interrupt first and the target exits by itself.
    h.codex.update({ reviewer: "hang" });
    const s2 = await h.inbound(
      h.connection,
      "host.execution.start",
      h.request("reviewer"),
    );
    assert.equal(s2.status, "running", JSON.stringify(s2));
    const ref2 = String(s2.executionRef);
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (
          h.calls(h.codex.calls).some((c) => c.reviewerTurn === true) &&
          h.recordOf(ref2).approvalDecisionRefs.length === 1
        )
          return resolve();
        if (Date.now() - start > 20_000)
          return reject(new Error("the reviewer turn did not start"));
        setTimeout(tick, 50);
      };
      tick();
    });
    const c2 = await h.inbound(h.connection, "host.execution.cancel", {
      operationId: "op:cancel-2",
      idempotencyKey: "key:cancel-2",
      requestDigest: "2".padStart(64, "c"),
      scopeRef: "scope:a",
      executionRef: ref2,
    });
    assert.equal(c2.status, "succeeded", JSON.stringify(c2));
    const r2 = await h.finished(ref2);
    assert.equal(r2.state, "stopped", JSON.stringify(r2));
    assert.equal(r2.stopReason, "cancelled");
    assert.equal(r2.exit?.code, 0, "the app-server exited on end of stdin");
    assert.equal(r2.exit?.signal, null);
    assert.equal(r2.exitClassification, "exited");
    assert.equal(r2.accounting?.pidGoneAfterExit, true);
    assert.equal(r2.actualBinding?.model, codexModel);
    const calls = h.calls(h.codex.calls);
    const interrupt = calls.find((c) => c.method === "turn/interrupt")!;
    assert.deepEqual(interrupt.params, {
      threadId: "thread-fixture",
      turnId: "turn-fixture",
    });
    const evidence2 = JSON.parse(
      readFileSync(
        join(
          executionEvidenceDir(join(h.executionsRoot, "evidence"), ref2),
          "result.json",
        ),
        "utf8",
      ),
    ) as { signals: unknown[]; reason: string };
    assert.deepEqual(evidence2.signals, [], "no signal was needed");
    assert.match(evidence2.reason, /interrupted/);
    assert.deepEqual(
      h.eventsOf(r2).map((e) => e.kind),
      [
        "submitted",
        "started",
        "approval_accepted",
        "stop_requested",
        "stopped",
      ],
    );
  } finally {
    await h.port.close();
  }
});

// ---------------------------------------------------------------- S-05: budgets and the audit
/** Runs scripts/execution-audit.mjs on one record and its evidence; returns the parsed report and the exit code. */
function audit(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["scripts/execution-audit.mjs", ...args],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  let report: Json | null = null;
  try {
    report = JSON.parse(result.stdout) as Json;
  } catch {
    report = null;
  }
  return { code: result.status, report, stderr: result.stderr };
}
const checkOf = (report: Json | null, id: string) =>
  (
    ((report?.executions as Json[] | undefined)?.[0]?.checks as
      { id: string; passed: boolean; detail: string }[] | undefined) ?? []
  ).find((c) => c.id === id);

test("budget stop-losses through the product Implementer: a target that keeps calling tools past maxToolCalls is stopped by identity and recorded tool-call-budget with the over-budget call counted; a target that ignores SIGTERM past maxRunSeconds is SIGKILLed after the cleanup budget and recorded timeout; one frame larger than maxOutputBytes is recorded output-limit; each record's accounting equals the transcript, the timeline and the exit probe under scripts/execution-audit.mjs, and a tampered accounting field fails the audit even with the digests recomputed", async () => {
  const h = await harness();
  try {
    const evidenceRoot = join(h.executionsRoot, "evidence");
    const sharedDir = (operationId: string) =>
      join(
        gitCommonDir(h.repo)!,
        "harness",
        "executions",
        recordSegment(operationId),
      );
    const run = async (
      state: Parameters<typeof h.claude.update>[0],
      budget: Record<string, number>,
    ) => {
      h.claude.update(state);
      const req = h.request("implementer", {
        budget: {
          maxToolCalls: 4,
          maxRunSeconds: 30,
          maxOutputBytes: 1048576,
          cleanupSeconds: 2,
          ...budget,
        },
      });
      const started = await h.inbound(
        h.connection,
        "host.execution.start",
        req,
      );
      assert.equal(started.status, "running", JSON.stringify(started));
      const record = await h.finished(String(started.executionRef));
      const file = join(h.dir, recordSegment(record.executionRef) + ".json");
      writeFileSync(file, JSON.stringify(record));
      const report = audit([
        "--record",
        file,
        "--evidence-root",
        evidenceRoot,
        "--shared",
        sharedDir(req.operationId),
      ]);
      return { req, record, file, report };
    };
    // 1. Tool calls: the fixture emits six tool calls 300 ms apart; the budget allows two.
    const tools = await run(
      {
        implementer: "normal",
        implementerToolCalls: 6,
        implementerToolDelayMs: 300,
      },
      { maxToolCalls: 2 },
    );
    assert.equal(tools.record.state, "stopped", JSON.stringify(tools.record));
    assert.equal(tools.record.stopReason, "tool-call-budget");
    assert.equal(
      tools.record.accounting?.toolCalls,
      3,
      "the third call is the one over budget (KB-189)",
    );
    assert.equal(tools.record.exit?.signal, "SIGTERM");
    assert.equal(tools.record.exitClassification, "signaled");
    assert.deepEqual(
      h.eventsOf(tools.record).map((e) => e.kind),
      ["submitted", "started", "stopped"],
    );
    const stoppedTools = h
      .eventsOf(tools.record)
      .find((e) => e.kind === "stopped")!;
    assert.equal(stoppedTools.payload.stopReason, "tool-call-budget");
    assert.deepEqual(stoppedTools.payload.signals, { TERM: 1, KILL: 0 });
    assert.equal(
      tools.report.code,
      0,
      tools.report.stderr + JSON.stringify(tools.report.report),
    );
    // 2. Run time: SIGTERM at one second is ignored, SIGKILL follows after the one-second cleanup budget.
    const time = await run(
      { implementer: "ignoreTerm" },
      { maxRunSeconds: 1, cleanupSeconds: 1 },
    );
    assert.equal(time.record.state, "stopped", JSON.stringify(time.record));
    assert.equal(time.record.stopReason, "timeout");
    assert.equal(time.record.exit?.signal, "SIGKILL");
    assert.ok(
      (time.record.accounting?.runSeconds ?? 0) >= 2,
      JSON.stringify(time.record.accounting),
    );
    const stoppedTime = h
      .eventsOf(time.record)
      .find((e) => e.kind === "stopped")!;
    assert.deepEqual(stoppedTime.payload.signals, { TERM: 1, KILL: 1 });
    assert.ok(
      h.calls(h.claude.calls).some((l) => l.ignoredSignal === "SIGTERM"),
      "the fixture recorded the ignored SIGTERM",
    );
    assert.equal(
      time.report.code,
      0,
      time.report.stderr + JSON.stringify(time.report.report),
    );
    // 3. Output: a single 8 KiB frame against a 4 KiB budget.
    const output = await run(
      { implementer: "flood", implementerFloodBytes: 8192 },
      { maxOutputBytes: 4096 },
    );
    assert.equal(output.record.state, "stopped", JSON.stringify(output.record));
    assert.equal(output.record.stopReason, "output-limit");
    assert.ok((output.record.accounting?.outputBytes ?? 0) > 8192);
    assert.equal(output.record.exit?.signal, "SIGTERM");
    assert.equal(
      output.report.code,
      0,
      output.report.stderr + JSON.stringify(output.report.report),
    );
    // The audit recomputed every accounting field from its own source.
    for (const id of [
      "physical-execution-schema",
      "result-document",
      "transcript-digest",
      "tool-calls",
      "output-bytes",
      "run-seconds",
      "waited",
      "pid-gone",
      "stop-reason",
      "shared-record",
    ]) {
      const check = checkOf(output.report.report, id);
      assert.ok(check?.passed, id + ": " + JSON.stringify(check));
    }
    // Transcript accounting: the sum of every entry's bytes is the recorded outputBytes; the flood frame carries its size.
    const transcript = readFileSync(
      join(
        executionEvidenceDir(evidenceRoot, output.record.executionRef),
        "transcript.ndjson",
      ),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Json);
    assert.equal(
      transcript.reduce((sum, e) => sum + Number(e.bytes), 0),
      output.record.accounting?.outputBytes,
    );
    assert.ok(
      transcript.some((e) => e.type === "assistant" && Number(e.bytes) > 8192),
    );
    // 4. Tampering: the record's toolCalls raised by one, every digest recomputed to match, still fails on the recount.
    const tampered = {
      ...tools.record,
      accounting: { ...tools.record.accounting!, toolCalls: 4 },
    };
    const tamperedFile = join(h.dir, "tampered.json");
    writeFileSync(tamperedFile, JSON.stringify(tampered));
    const failed = audit([
      "--record",
      tamperedFile,
      "--evidence-root",
      evidenceRoot,
    ]);
    assert.equal(failed.code, 1);
    const toolCheck = checkOf(failed.report, "tool-calls");
    assert.equal(toolCheck?.passed, false, JSON.stringify(failed.report));
    assert.match(toolCheck?.detail ?? "", /记录 4.*transcript 3/);
    assert.equal(checkOf(failed.report, "accounting-in-result")?.passed, false);
    // A transcript rewritten to match (digests recomputed in the copy) still fails: the result document's own accounting disagrees.
    const copyRoot = join(h.dir, "evidence-copy");
    const copyDir = executionEvidenceDir(copyRoot, tools.record.executionRef);
    mkdirSync(copyDir, { recursive: true });
    const sourceDir = executionEvidenceDir(
      evidenceRoot,
      tools.record.executionRef,
    );
    const lines = readFileSync(join(sourceDir, "transcript.ndjson"), "utf8")
      .trim()
      .split("\n");
    lines.push(
      JSON.stringify({
        type: "assistant",
        model: claudeModel,
        blocks: [{ type: "tool_use", name: "Write" }],
        stop_reason: "tool_use",
        isApiErrorMessage: false,
        error: null,
        bytes: 0,
      }),
    );
    const forgedTranscript = lines.join("\n") + "\n";
    writeFileSync(join(copyDir, "transcript.ndjson"), forgedTranscript);
    const document = JSON.parse(
      readFileSync(join(sourceDir, "result.json"), "utf8"),
    ) as Json;
    document.transcriptDigest = createHash("sha256")
      .update(forgedTranscript)
      .digest("hex");
    document.transcriptBytes = Buffer.byteLength(forgedTranscript);
    const forgedBytes = Buffer.from(canonicalJson(document) + "\n");
    writeFileSync(join(copyDir, "result.json"), forgedBytes);
    const forgedRecord = {
      ...tampered,
      resultRef: {
        ...tampered.resultRef!,
        bytes: forgedBytes.length,
        digest: createHash("sha256").update(forgedBytes).digest("hex"),
      },
    };
    writeFileSync(tamperedFile, JSON.stringify(forgedRecord));
    const forged = audit([
      "--record",
      tamperedFile,
      "--evidence-root",
      copyRoot,
    ]);
    assert.equal(forged.code, 1);
    assert.equal(checkOf(forged.report, "result-document")?.passed, true);
    assert.equal(checkOf(forged.report, "transcript-digest")?.passed, true);
    assert.equal(checkOf(forged.report, "tool-calls")?.passed, true);
    assert.equal(
      checkOf(forged.report, "accounting-in-result")?.passed,
      false,
      JSON.stringify(forged.report),
    );
  } finally {
    await h.port.close();
  }
});

test("a native error_max_budget_usd end through the product Implementer (no cap is passed; the end comes from the CLI itself): the record is failed with BUDGET_EXCEEDED and errorClass budget, the completed turn's read-back (total_cost_usd, modelUsage) is kept in the result document, the target was launched exactly once (no retry) without --max-budget-usd, and the audit's budget-failure check passes on the failed record", async () => {
  const h = await harness();
  try {
    const launches = () =>
      h
        .calls(h.claude.calls)
        .filter(
          (l) =>
            Array.isArray(l.args) &&
            (l.args as string[]).includes("--safe-mode"),
        );
    const before = launches().length;
    h.claude.update({ implementer: "budget", costUsd: 0.051 });
    const req = h.request("implementer");
    const started = await h.inbound(h.connection, "host.execution.start", req);
    assert.equal(started.status, "running", JSON.stringify(started));
    const record = await h.finished(String(started.executionRef));
    assert.equal(record.state, "failed", JSON.stringify(record));
    assert.equal(record.stopReason, null);
    assert.match(
      record.reason,
      /Claude Code 报告预算超限（error_max_budget_usd，产品未设置费用上限），已花费 0\.051 美元/,
    );
    assert.equal(record.exit?.code, 1);
    assert.equal(record.accounting?.toolCalls, 1);
    assert.deepEqual(
      h.eventsOf(record).map((e) => e.kind),
      ["submitted", "started", "failed"],
      "no retry: one submitted, one started, one failed",
    );
    const failed = h.eventsOf(record).find((e) => e.kind === "failed")!;
    assert.equal(failed.payload.resultCode, "BUDGET_EXCEEDED");
    assert.equal(failed.payload.errorClass, "budget");
    assert.equal(launches().length, before + 1, "launched exactly once");
    const argv = launches().at(-1)!.args as string[];
    assert.ok(!argv.includes("--max-budget-usd"), "no cap argument");
    const evidenceRoot = join(h.executionsRoot, "evidence");
    const document = JSON.parse(
      readFileSync(
        join(
          executionEvidenceDir(evidenceRoot, record.executionRef),
          "result.json",
        ),
        "utf8",
      ),
    ) as { resultCode: string; evidence: { result: Json } };
    assert.equal(document.resultCode, "BUDGET_EXCEEDED");
    assert.equal(document.evidence.result.subtype, "error_max_budget_usd");
    assert.equal(document.evidence.result.total_cost_usd, 0.051);
    assert.deepEqual(Object.keys(document.evidence.result.modelUsage as Json), [
      claudeModel,
    ]);
    const file = join(h.dir, "budget-record.json");
    writeFileSync(file, JSON.stringify(record));
    const report = audit(["--record", file, "--evidence-root", evidenceRoot]);
    assert.equal(report.code, 0, report.stderr + JSON.stringify(report.report));
    assert.equal(checkOf(report.report, "budget-failure")?.passed, true);
  } finally {
    await h.port.close();
  }
});
