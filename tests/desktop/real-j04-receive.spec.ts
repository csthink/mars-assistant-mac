/**
 * J-04 receiving and refusal entry (mac-feature-t32 S-02): through the product, in the background
 * isolated client, two independent namespaces receive the signed Runtime development bundle, connect
 * Codex the product's normal way and bind the embedded Reviewer port to that connection; the accept
 * namespace is left ready for a Reviewer, the reject namespace is refused by the Runtime before any
 * Host execution. No model is called: the entry observes every Codex app-server the product spawns
 * (tests/desktop/background-main.cjs, CSTHINK_TEST_CODEX_PROTOCOL_LOG) and fails unless the model
 * turns sent to a provider other than the loopback synthetic capability check are zero. The turns of
 * that local check and the real threads the connection check starts without input are counted apart.
 *
 * Inputs are explicit and never defaulted; a missing one fails the run with its name:
 *   CSTHINK_J04_BUNDLE_DIR      absolute import directory holding exactly bundle.tar, release.json,
 *                               release.sig and publisher.pub
 *   CSTHINK_J04_FIXTURE         absolute path of the run fixture (j04-receive-fixture/v1): the task id,
 *                               the Registry port id, the binding's credential reference and agent, and
 *                               the namespaces. Each namespace names its product-line repository (the
 *                               task at N-DEF-REVIEW-DISPATCH with a submitted candidate), the task
 *                               worktree, a client data root that does not exist yet, the authority
 *                               reference the binding records, and its Registry handling: "match" sets
 *                               the port's applicability configurationRevision to the Host connection's
 *                               revision, "deviate" sets it to another valid revision (the refusal case;
 *                               "1" when the connection's is "0", otherwise "0")
 *   CSTHINK_J04_EVIDENCE_DIR    absolute, new or empty evidence directory
 *   CSTHINK_J04_EXPECTED_PUBLISHER_KEY_DIGEST (optional) SPKI SHA-256 given out of band
 *
 * Steps per namespace: a new client; 设置 → 模型 → Codex enables the Registry's model, the connection
 * origin is confirmed (prepare and accept, each with the product's local capability check and a real
 * thread started without input); 扩展管理 imports the bundle (first publisher pin, degraded without a
 * binding); the project's 仓库治理接入 registers the repository folder; the Registry copy is handled;
 * the bundle's own CLI writes the binding with the embedded execution binding of the confirmed
 * connection; 重新连接; the scope opens, is authorised and linked; 执行角色 saves the Reviewer
 * (connection, model, effort) when the Runtime negotiated its profile and otherwise records why it
 * cannot; a killed Runtime is reconnected and the binding, connection and role
 * read back unchanged. Accept: the Host preflight of exactly that binding passes every check. Reject:
 * 项目操作 records the Owner formal authorization and dispatches; the Runtime settles the round as an
 * execution failure with execution-port-binding-mismatch, with no Host execution request and no Codex
 * process, thread or turn in that window. The client quits and its Runtime is gone.
 */
import { test, expect, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { providersPage } from "./provider-ui";
import {
  deliveryInputs,
  probeRecord,
  ProbeClient,
  requireAbsolute,
  sha256,
  type Json,
} from "./real-probe";
import type { Connection } from "../../src/shared/protocol";
import type { PreflightCheck } from "../../src/main/runtime-execution-port";
declare global {
  var executionPort: { preflight(request: unknown): Promise<PreflightCheck[]> };
}

const bundleDir = process.env.CSTHINK_J04_BUNDLE_DIR ?? "";
const fixturePath = process.env.CSTHINK_J04_FIXTURE ?? "";
const evidenceDir = process.env.CSTHINK_J04_EVIDENCE_DIR ?? "";
const expectedKey = process.env.CSTHINK_J04_EXPECTED_PUBLISHER_KEY_DIGEST ?? "";
const registryPath = "mechanisms/review-channel/review_channel_registry.json";

interface Namespace {
  name: string;
  repository: string;
  worktree: string;
  dataRoot: string;
  authorityRef: string;
  registry: "match" | "deviate";
}
interface Fixture {
  schema: string;
  taskId: string;
  portId: string;
  credentialRef: string;
  agent: string;
  namespaces: Namespace[];
}
interface ProtocolEntry {
  event: "spawn" | "request" | "notification" | "exit";
  pid: number | null;
  method?: string | null;
  modelProvider?: string | null;
  loopbackProvider?: boolean;
}
/** Model turns and threads per kind of process, from the protocol log lines given. */
function tally(entries: ProtocolEntry[]) {
  const loopback = new Set(
    entries
      .filter((e) => e.event === "spawn" && e.loopbackProvider)
      .map((e) => e.pid),
  );
  const spawns = entries.filter((e) => e.event === "spawn");
  const count = (method: string, local: boolean) =>
    entries.filter(
      (e) =>
        e.event === "request" &&
        e.method === method &&
        loopback.has(e.pid) === local,
    ).length;
  return {
    processes: spawns.length,
    loopbackProcesses: spawns.filter((e) => e.loopbackProvider).length,
    providers: [...new Set(spawns.map((e) => e.modelProvider ?? null))],
    unparsedRequests: entries.filter(
      (e) => e.event === "request" && e.method === null,
    ).length,
    localSyntheticTurns: count("turn/start", true),
    localSyntheticThreads: count("thread/start", true),
    realThreadsWithoutInput: count("thread/start", false),
    realProviderTurns: count("turn/start", false),
    realTurnStartedNotifications: entries.filter(
      (e) =>
        e.event === "notification" &&
        e.method === "turn/started" &&
        !loopback.has(e.pid),
    ).length,
  };
}

test.setTimeout(1_800_000);
// Traces would copy the bundle bytes and every frame; the protocol transcript is the record.
test.use({ trace: "off" });

test("J-04 receive and refuse: two namespaces receive the signed bundle, bind the embedded Reviewer port to the confirmed Codex connection and reconnect; the deviating namespace is refused with execution-port-binding-mismatch; no model turn reaches a real provider", async () => {
  requireAbsolute("J-04 receiving entry", [
    ["CSTHINK_J04_BUNDLE_DIR", bundleDir],
    ["CSTHINK_J04_FIXTURE", fixturePath],
    ["CSTHINK_J04_EVIDENCE_DIR", evidenceDir],
  ]);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  expect(fixture.schema).toBe("j04-receive-fixture/v1");
  expect(fixture.namespaces.map((n) => n.registry).sort()).toEqual([
    "deviate",
    "match",
  ]);
  for (const ns of fixture.namespaces)
    requireAbsolute("J-04 namespace " + ns.name, [
      ["repository", ns.repository],
      ["worktree", ns.worktree],
      ["dataRoot", ns.dataRoot],
    ]);
  const { step, steps, finish } = probeRecord(
    evidenceDir,
    "mac-feature-t32-j04-receive/v1",
  );
  const gitIn =
    (dir: string) =>
    (...args: string[]) =>
      execFileSync("/usr/bin/git", ["-C", dir, ...args], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: evidenceDir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
        encoding: "utf8",
      }).trim();
  const logs: Record<string, string> = {};
  const clients: ProbeClient[] = [];
  let publisherKeyDigest = "";
  let inputs: Record<string, { bytes: number; sha256: string }> = {};
  try {
    await step(
      "inputs",
      "the import directory holds exactly the four delivery files; the publisher key digest equals the one given out of band; every namespace is a prepared repository at N-DEF-REVIEW-DISPATCH with a submitted candidate and a data root that does not exist yet",
      (o) => {
        const delivery = deliveryInputs(bundleDir);
        inputs = delivery.files;
        publisherKeyDigest = delivery.publisherKeyDigest;
        o.files = delivery.files;
        o.publisherKeyDigest = publisherKeyDigest;
        if (expectedKey) expect(publisherKeyDigest).toBe(expectedKey);
        o.namespaces = fixture.namespaces.map((ns) => {
          const state = JSON.parse(
            gitIn(ns.repository)("show", "refs/harness/runtime:state.json"),
          ) as Json;
          const task = (state.tasks as Json)[fixture.taskId] as Json;
          const instance = task.workflowInstance as Json;
          const candidates = (task.taskDefinition as Json).candidates as Json[];
          expect(instance.position).toBe("N-DEF-REVIEW-DISPATCH");
          expect(existsSync(ns.dataRoot)).toBe(false);
          return {
            name: ns.name,
            registry: ns.registry,
            head: gitIn(ns.repository)("rev-parse", "HEAD"),
            worktreeHead: gitIn(ns.worktree)("rev-parse", "HEAD"),
            position: instance.position,
            runtimeVersion: instance.runtimeVersion,
            candidate: candidates[candidates.length - 1] && {
              commit: candidates[candidates.length - 1].commit,
              path: candidates[candidates.length - 1].path,
              bytes: candidates[candidates.length - 1].bytes,
              sha256: candidates[candidates.length - 1].sha256,
            },
            executionDescriptors: Object.keys(
              (state.executionDescriptors as Json) ?? {},
            ).length,
          };
        });
      },
    );
    for (const ns of fixture.namespaces) await receive(ns);
    await step(
      "codex-protocol",
      "across both clients the observer saw the Codex processes (the local capability checks prove it was active); every model turn went to a process whose provider is the loopback synthetic check; real threads started without input are counted; model turns to a real provider are zero",
      (o) => {
        const per: Record<string, ReturnType<typeof tally>> = {};
        for (const [name, path] of Object.entries(logs))
          per[name] = tally(
            existsSync(path)
              ? readFileSync(path, "utf8")
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line) as ProtocolEntry)
              : [],
          );
        o.perNamespace = per;
        // Each namespace is its own client, so pids are only compared within one log.
        const sum = (
          key: Exclude<keyof ReturnType<typeof tally>, "providers">,
        ) => Object.values(per).reduce((n, t) => n + t[key], 0);
        const total = {
          processes: sum("processes"),
          loopbackProcesses: sum("loopbackProcesses"),
          unparsedRequests: sum("unparsedRequests"),
          localSyntheticTurns: sum("localSyntheticTurns"),
          localSyntheticThreads: sum("localSyntheticThreads"),
          realThreadsWithoutInput: sum("realThreadsWithoutInput"),
          realProviderTurns: sum("realProviderTurns"),
          realTurnStartedNotifications: sum("realTurnStartedNotifications"),
        };
        o.total = total;
        expect(total.processes).toBeGreaterThan(0);
        expect(total.localSyntheticTurns).toBeGreaterThan(0);
        expect(total.unparsedRequests).toBe(0);
        expect(total.realProviderTurns).toBe(0);
        expect(total.realTurnStartedNotifications).toBe(0);
      },
    );
    // A step recorded as failed while the later evidence was still gathered fails the entry.
    expect(steps.filter((s) => s.result === "FAIL").map((s) => s.id)).toEqual(
      [],
    );
  } finally {
    finish();
    for (const client of clients) await client.close();
  }

  async function receive(ns: Namespace) {
    const id = ns.name;
    const transcripts = join(evidenceDir, "transcripts", id);
    mkdirSync(transcripts, { recursive: true });
    const log = join(evidenceDir, `codex-protocol-${id}.jsonl`);
    logs[id] = log;
    const lines = () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
    const git = gitIn(ns.repository);
    const domainState = () =>
      JSON.parse(git("show", "refs/harness/runtime:state.json")) as Json;
    const workflow = () =>
      ((domainState().tasks as Json)[fixture.taskId] as Json)
        .workflowInstance as Json;
    const client = new ProbeClient(ns.dataRoot, transcripts, {
      CSTHINK_TEST_CODEX_PROTOCOL_LOG: log,
    });
    clients.push(client);
    const page = () => client.page;
    const snapshot = () => client.snapshot();
    const shot = (name: string) =>
      page().screenshot({ path: join(evidenceDir, `${id}-${name}.png`) });
    const projectName = `J-04 ${id}`;
    const registry = JSON.parse(
      readFileSync(join(ns.repository, registryPath), "utf8"),
    ) as Json;
    const port = (registry.execution_ports as Json[]).find(
      (p) => p.id === fixture.portId,
    )!;
    const applicability = port.applicability as Json;
    const profile = port.profile as Json;
    const model = String(port.model_ref);
    const effort = String(port.effort);
    let connection!: Connection;
    let card!: () => Locator;
    let packageDir = "";
    let instanceDir = "";
    let entrypoint = "";
    let handle = "";
    let scopeRef = "";
    let instanceId = "";
    let bindingDigest = "";

    await step(
      `${id}:launch`,
      "a new client starts on the namespace's own new data root with the Codex protocol observer installed before production code",
      async (o) => {
        mkdirSync(ns.dataRoot);
        await client.launch();
        o.dataRoot = ns.dataRoot;
        o.observerFile = log.slice(evidenceDir.length + 1);
        o.connections = (await snapshot()).connections.length;
        expect(o.connections).toBe(0);
      },
    );
    await step(
      `${id}:codex-connect`,
      `设置 → 模型 → Codex: detection finishes, 启用模型 ${model} shows the connection origin to confirm, 确认配置 Codex records one Codex connection whose ${model} is enabled with a confirmed origin and an effort list containing ${effort}`,
      async (o) => {
        await providersPage(page());
        await page()
          .getByRole("button", { name: "打开提供方 Codex", exact: true })
          .click();
        const section = page().getByRole("region", { name: "Codex 连接" });
        const toggle = section.getByRole("checkbox", {
          name: `启用模型 ${model}`,
          exact: true,
        });
        // As a person would: a detection that timed out or failed is started again (each one is an
        // inspection without thread or turn), at most three times.
        const detections: string[] = [];
        const deadline = Date.now() + 300_000;
        while (
          !(await toggle.isEnabled({ timeout: 1000 }).catch(() => false))
        ) {
          const text = await section.innerText();
          const failed = /检测超时|未能完成连接检测/.exec(text)?.[0];
          const again = section.getByRole("button", {
            name: "重新检测 Codex",
            exact: true,
          });
          if (failed && (await again.isEnabled())) {
            detections.push(failed);
            expect(detections.length).toBeLessThanOrEqual(3);
            await again.click();
          }
          expect(Date.now()).toBeLessThan(deadline);
          await page().waitForTimeout(1000);
        }
        o.failedDetections = detections;
        await toggle.click();
        const setup = page().getByRole("region", { name: "确认 Codex 连接" });
        await expect(setup).toBeVisible({ timeout: 180_000 });
        o.setupText = (await setup.innerText()).replace(
          /SHA-256：\S+/g,
          "SHA-256：…",
        );
        const consent = setup.getByRole("checkbox", {
          name: "允许随此连接的对话发送这些规则",
        });
        o.instructionConsent = (await consent.count()) > 0;
        if (o.instructionConsent) await consent.check();
        await shot("codex-setup");
        await setup
          .getByRole("button", { name: "确认配置 Codex", exact: true })
          .click();
        await expect(setup).toHaveCount(0, { timeout: 180_000 });
        await expect(
          section.getByText("已配置", { exact: true }),
        ).toBeVisible();
        const codex = (await snapshot()).connections.filter(
          (c) => c.provider === "codex",
        );
        expect(codex).toHaveLength(1);
        connection = codex[0];
        const entry = connection.models.find((m) => m.model === model);
        o.connection = {
          id: connection.id,
          revision: connection.revision,
          enabled: connection.enabled,
          model: connection.model,
          origin: connection.codex && {
            provider: connection.codex.provider,
            endpoint: connection.codex.endpoint,
            authentication: connection.codex.authentication,
            instructions: connection.codex.instructions.length,
            configurationInstructions:
              connection.codex.configurationInstructions.length,
          },
          models: connection.models.map((m) => ({
            model: m.model,
            enabled: m.enabled,
            originConfirmed: !!m.codex,
            effort: m.effort && {
              levels: m.effort.levels,
              defaultLevel: m.effort.defaultLevel,
            },
          })),
        };
        expect(entry?.enabled).toBe(true);
        expect(entry?.codex).toBeTruthy();
        expect(entry?.effort?.levels).toContain(effort);
        await shot("codex-connected");
      },
    );
    await step(
      `${id}:import`,
      "设置 → 扩展管理 → 从本地导入运行包 admits the bundle with the first publisher pin; the installation records the delivered digests; without a binding the instance is 待核实 and degraded",
      async (o) => {
        const section = await client.openExtensions();
        card = () =>
          page().getByRole("article", {
            name: "harness-plane 扩展",
            exact: true,
          });
        await client.pickDirectory(bundleDir);
        await section
          .getByRole("button", { name: "从本地导入运行包…" })
          .click();
        await expect(page().getByTestId("import-result")).toHaveText(
          "已导入并开始可用性检查。",
          { timeout: 120_000 },
        );
        o.pinNotice = await page().getByTestId("import-pin").textContent();
        expect(o.pinNotice).toContain(publisherKeyDigest.slice(0, 12));
        await expect(card().getByTestId("extension-state")).toHaveText(
          "待核实",
          { timeout: 60_000 },
        );
        await expect(card().getByTestId("extension-health")).toContainText(
          "no instance binding file",
        );
        const s = await snapshot();
        expect(s.runtimeInstallations).toHaveLength(1);
        const installation = s.runtimeInstallations[0];
        const instance = s.runtimeInstances[0];
        o.installation = {
          runtimeId: installation.runtimeId,
          version: installation.version,
          publicKeyDigest: installation.publicKeyDigest,
          artifactDigest: installation.artifactDigest,
          releaseRecordDigest: installation.releaseRecordDigest,
          manifestDigest: installation.manifestDigest,
          capabilities: installation.capabilities.map((c) => c.id),
          incompatibility: installation.incompatibility,
        };
        expect(installation.artifactDigest).toBe(inputs["bundle.tar"].sha256);
        expect(installation.releaseRecordDigest).toBe(
          inputs["release.json"].sha256,
        );
        expect(installation.publicKeyDigest).toBe(publisherKeyDigest);
        expect(installation.incompatibility).toBeNull();
        entrypoint = installation.entrypoint;
        packageDir = instance.launchDirectories!.packageDir;
        instanceDir = instance.launchDirectories!.instanceDir;
        instanceId = instance.instanceId;
        o.instance = {
          instanceId,
          state: instance.state,
          health: instance.health,
        };
        expect(instance.health?.result).toBe("degraded");
      },
    );
    await step(
      `${id}:register`,
      "项目 → 新项目 on the repository folder, then 仓库治理接入 → 登记项目文件夹 shows the resource handle; nothing is granted and the repository's refs are unchanged",
      async (o) => {
        const refsBefore = git(
          "for-each-ref",
          "--format=%(objectname) %(refname)",
        );
        o.projectId = await client.createProject(
          ns.repository,
          projectName,
          "J-04 接收与评审",
        );
        const panel = await client.openProject(projectName);
        await panel.getByRole("button", { name: "登记项目文件夹" }).click();
        const value = panel.getByTestId("project-resource-handle-value");
        await expect(value).toHaveText(/^resource:[0-9a-f]{32}$/);
        handle = (await value.textContent())!;
        o.handle = handle;
        o.grants = (await snapshot()).runtimeGrants.length;
        expect(o.grants).toBe(0);
        expect(git("for-each-ref", "--format=%(objectname) %(refname)")).toBe(
          refsBefore,
        );
      },
    );
    await step(
      `${id}:registry`,
      ns.registry === "match"
        ? "the Registry copy in the repository and in the task worktree sets only the port's applicability configurationRevision to the Host connection's revision"
        : "the Registry copy in the repository and in the task worktree sets only the port's applicability configurationRevision to a valid revision other than the Host connection's (the deviation the refusal needs)",
      (o) => {
        const actual = String(connection.revision);
        const files = [ns.repository, ns.worktree].map((root) =>
          join(root, registryPath),
        );
        const before = files.map((file) => readFileSync(file));
        expect(before[1].equals(before[0])).toBe(true);
        o.port = {
          id: port.id,
          model,
          effort,
          transport: port.transport,
          capability: port.capability,
          profile: { id: profile.id, digest: profile.digest },
          applicability,
        };
        o.before = { bytes: before[0].length, sha256: sha256(before[0]) };
        o.hostConnectionRevision = actual;
        const original = String(applicability.configurationRevision);
        const target =
          ns.registry === "match" ? actual : actual === "0" ? "1" : "0";
        const text = before[0].toString("utf8");
        const field = `"configurationRevision": ${JSON.stringify(original)}`;
        expect(text.split(field).length - 1).toBe(1);
        const after = Buffer.from(
          text.replace(
            field,
            `"configurationRevision": ${JSON.stringify(target)}`,
          ),
          "utf8",
        );
        for (const file of files) writeFileSync(file, after);
        const changed = JSON.parse(after.toString("utf8")) as Json;
        const changedPort = (changed.execution_ports as Json[]).find(
          (p) => p.id === fixture.portId,
        )!;
        expect((changedPort.applicability as Json).configurationRevision).toBe(
          target,
        );
        if (ns.registry === "deviate") expect(target).not.toBe(actual);
        o.after = { bytes: after.length, sha256: sha256(after) };
        o.delta = {
          field:
            "execution_ports[embedded].applicability.configurationRevision",
          from: original,
          to: target,
          hostConnectionRevision: actual,
        };
      },
    );
    let binding: Json = {};
    await step(
      `${id}:binding-write`,
      "the bundle's own CLI writes the binding for the repository and the registered handle with the embedded execution binding of the confirmed Codex connection (connection reference and revision from the Host, credential revision from the Registry); show reads it back; the file is 0600",
      (o) => {
        binding = {
          [fixture.portId]: {
            connectionRef: `connection:${connection.id}`,
            credentialRef: fixture.credentialRef,
            credentialRevision: String(applicability.credentialRevision),
            configurationRevision: String(connection.revision),
            agent: fixture.agent,
            protocolProvider: connection.codex!.provider,
          },
        };
        const file = join(evidenceDir, `${id}-execution-bindings.json`);
        writeFileSync(file, JSON.stringify(binding, null, 1) + "\n");
        const program = join(packageDir, entrypoint);
        const env = { PATH: "/usr/bin:/bin" };
        const write = JSON.parse(
          execFileSync(
            program,
            [
              "-I",
              "-B",
              "-m",
              "hp",
              "binding",
              "write",
              "--instance-dir",
              instanceDir,
              "--repository",
              ns.repository,
              "--resource-handle",
              handle,
              "--execution-bindings",
              "@" + file,
              "--authority-ref",
              ns.authorityRef,
            ],
            { env, encoding: "utf8" },
          ),
        ) as Json;
        const show = JSON.parse(
          execFileSync(
            program,
            [
              "-I",
              "-B",
              "-m",
              "hp",
              "binding",
              "show",
              "--instance-dir",
              instanceDir,
            ],
            { env, encoding: "utf8" },
          ),
        ) as Json;
        o.write = { result: write.result, sha256: write.sha256 };
        o.show = show;
        expect(write.result).toBe("BINDING_WRITTEN");
        expect(show.result).toBe("BINDING_READ");
        expect(show.sha256).toBe(write.sha256);
        const read = show.binding as Json;
        expect(read.executionBindings).toEqual(binding);
        expect(read.resourceHandles).toEqual([handle]);
        bindingDigest = String(show.sha256);
        const name = readdirSync(instanceDir).find((n) =>
          n.endsWith("binding.json"),
        )!;
        o.mode = (statSync(join(instanceDir, name)).mode & 0o777).toString(8);
        expect(o.mode).toBe("600");
      },
    );
    await step(
      `${id}:reconnect-ready`,
      "设置 → 扩展管理 → 重新连接: the new incarnation reads the binding, health is ok and the card states 可用; the Initialize exchange is recorded",
      async (o) => {
        const first = (await snapshot()).runtimeInstances[0];
        await client.openExtensions();
        await card().getByRole("button", { name: "重新连接" }).click();
        await expect(card().getByTestId("reconnect-result")).toHaveText(
          "已建立新的连接，当前状态：可用。",
          { timeout: 60_000 },
        );
        const second = (await snapshot()).runtimeInstances[0];
        expect(second.incarnationId).not.toBe(first.incarnationId);
        expect(second.health?.result).toBe("ok");
        const init = client.requestAndReply(
          second.incarnationId!,
          "runtime.initialize",
        );
        const answer = (init.reply?.result ?? {}) as Json;
        o.instance = {
          incarnationId: second.incarnationId,
          health: second.health,
          negotiated: second.negotiation?.capabilities.map((c) => c.id),
        };
        o.offeredExecutionProfiles = (
          ((init.request.params as Json).executionProfiles as Json[]) ?? []
        ).map((p) => ({ id: p.id, digest: p.digest, purpose: p.purpose }));
        o.answeredExecutionProfiles = answer.executionProfiles ?? null;
      },
    );
    await step(
      `${id}:authorize-link`,
      "打开项目范围 opens the bound handle's scope; 核对并授权… → 确认授权 grants the reviewed set and the Runtime accepts it; 关联 links the project to the current projection",
      async (o) => {
        let panel = await client.openProject(projectName);
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        await expect(panel.getByTestId("access-scope")).toContainText(
          "尚未授权",
          { timeout: 30_000 },
        );
        const scope = (await snapshot()).runtimeScopes[0];
        scopeRef = scope.scopeRef;
        expect(scope.resourceHandle).toBe(handle);
        panel = await client.openProject(projectName);
        await panel.getByRole("button", { name: "核对并授权…" }).click();
        const review = page().getByRole("dialog", { name: "核对扩展授权" });
        await expect(review).toContainText(handle);
        o.review = await review.textContent();
        await review.getByRole("button", { name: "确认授权" }).click();
        await expect(panel.getByTestId("access-grants")).toContainText(
          "已授权",
          { timeout: 30_000 },
        );
        await expect
          .poll(async () => (await snapshot()).runtimeScopes[0].freshness, {
            timeout: 60_000,
          })
          .toBe("current");
        const s = await snapshot();
        const grants = s.runtimeGrants.filter((g) => g.status === "active");
        o.grants = {
          count: grants.length,
          capabilities: [...new Set(grants.map((g) => g.capability))],
          operations: [...new Set(grants.map((g) => g.operation))],
        };
        expect(grants.length).toBeGreaterThan(0);
        await page()
          .getByRole("combobox", { name: "关联项目内容", exact: true })
          .selectOption(`${instanceId}|${scopeRef}`);
        await page().getByRole("button", { name: "关联", exact: true }).click();
        await expect(panel.getByTestId("access-summary")).toHaveText("已接入", {
          timeout: 30_000,
        });
        o.scope = { scopeRef, state: s.runtimeScopes[0].state };
      },
    );
    let savedRole: Json | null = null;
    await step(
      `${id}:reviewer-role`,
      `项目 → 执行角色 → 评审者: when the Runtime negotiated the Reviewer profile, the confirmed Codex connection's ${model} with effort ${effort} is saved and the Host reads the same role binding; when it did not, the section says so, nothing is saved, and the negotiated execution profiles are recorded`,
      async (o) => {
        await client.openProject(projectName);
        const roles = page().getByRole("region", { name: "执行角色" });
        await expect(roles.getByText("正在读取角色选择…")).toHaveCount(0, {
          timeout: 30_000,
        });
        const reviewer = roles.getByRole("group", { name: /^评审者/ });
        const select = reviewer.getByRole("combobox", { name: "评审者模型" });
        await expect(select).toBeVisible();
        const instance = (await snapshot()).runtimeInstances.find(
          (i) => i.instanceId === instanceId,
        )!;
        const negotiated = instance.negotiation?.executionProfiles ?? [];
        o.negotiatedExecutionProfiles = negotiated;
        o.hint = await reviewer.locator(".project-form-hint").textContent();
        o.available = await select.isEnabled();
        const read = () =>
          client.app!.evaluate(
            async (_, { instanceId, scopeRef }) =>
              globalThis.runtimeHost.roleBinding(
                instanceId,
                scopeRef,
                "role:reviewer",
              ),
            { instanceId, scopeRef },
          );
        if (!o.available) {
          // The bundle's Manifest names no execution profile requirement, so the Runtime selects none
          // and the product does not let a role be saved for a profile the Runtime has not accepted.
          expect(negotiated.some((p) => p.id === profile.id)).toBe(false);
          expect(o.hint).toBe(
            "Runtime 尚未接纳当前角色的执行配置，不能保存该选择。",
          );
          o.roleBinding = await read();
          expect(o.roleBinding).toBeNull();
          await shot("roles");
          return;
        }
        await select.selectOption(`${connection.id}::${model}`);
        await reviewer
          .getByRole("combobox", { name: "评审者推理强度" })
          .selectOption(effort);
        await reviewer.getByRole("button", { name: "保存评审者" }).click();
        await expect(reviewer).toContainText(`已保存：${model} · ${effort}`, {
          timeout: 30_000,
        });
        savedRole = (await read()) as unknown as Json;
        o.roleBinding = savedRole;
        expect(savedRole).toMatchObject({
          connectionId: connection.id,
          model,
          effort,
        });
        await shot("roles");
      },
    );
    await step(
      `${id}:disconnect-recover`,
      "a killed Runtime shows 连接异常; 重新连接 starts a new incarnation, the scope is current again; the binding file, the Codex connection revision and the Reviewer role read back unchanged",
      async (o) => {
        await client.openExtensions();
        const before = (await snapshot()).runtimeInstances[0];
        process.kill(before.pid!, "SIGKILL");
        await expect(card().getByTestId("extension-state")).toHaveText(
          "连接异常",
          { timeout: 30_000 },
        );
        await card().getByRole("button", { name: "重新连接" }).click();
        await expect(card().getByTestId("extension-state")).toHaveText("可用", {
          timeout: 60_000,
        });
        await expect
          .poll(
            async () =>
              (await snapshot()).runtimeScopes.find(
                (s) => s.scopeRef === scopeRef,
              )?.freshness,
            { timeout: 60_000 },
          )
          .toBe("current");
        const after = await snapshot();
        const recovered = after.runtimeInstances[0];
        expect(recovered.incarnationId).not.toBe(before.incarnationId);
        expect(recovered.health?.result).toBe("ok");
        const show = JSON.parse(
          execFileSync(
            join(packageDir, entrypoint),
            [
              "-I",
              "-B",
              "-m",
              "hp",
              "binding",
              "show",
              "--instance-dir",
              instanceDir,
            ],
            { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
          ),
        ) as Json;
        const current = after.connections.find((c) => c.id === connection.id)!;
        const role = await client.app!.evaluate(
          async (_, { instanceId, scopeRef }) =>
            globalThis.runtimeHost.roleBinding(
              instanceId,
              scopeRef,
              "role:reviewer",
            ),
          { instanceId, scopeRef },
        );
        o.readback = {
          incarnationId: recovered.incarnationId,
          bindingSha256: show.sha256,
          connectionRevision: current.revision,
          roleBinding: role,
        };
        expect(show.sha256).toBe(bindingDigest);
        expect((show.binding as Json).executionBindings).toEqual(binding);
        expect(current.revision).toBe(connection.revision);
        if (savedRole === null) expect(role).toBeNull();
        else expect(role).toMatchObject(savedRole);
      },
    );
    if (ns.registry === "match")
      await step(
        `${id}:host-preflight`,
        "the Host preflight of exactly the bound request (Registry profile, binding, connection revision) passes every check and states this attempt's Codex program identity; it starts no thread or turn",
        async (o) => {
          const from = lines();
          const request = {
            scopeRef,
            profileId: String(profile.id),
            profileDigest: String(profile.digest),
            connectionRef: `connection:${connection.id}`,
            configurationRevision: String(connection.revision),
            executionBinding: {
              profileDigest: String(profile.digest),
              agent: fixture.agent,
              model,
              modelVendor: "OpenAI",
              routeVendor: null,
              credentialRef: fixture.credentialRef,
              configurationRevision: String(connection.revision),
            },
            constraints: [],
          };
          const mapping = (registry.model_mappings as Json[]).find(
            (m) => m.id === port.mapping_id,
          )!;
          request.executionBinding.modelVendor = String(mapping.model_vendor);
          request.executionBinding.routeVendor =
            (mapping.route_vendor as null) ?? null;
          const checks = await client.app!.evaluate(
            async (_, request) => globalThis.executionPort.preflight(request),
            request,
          );
          o.request = request;
          o.checks = checks;
          const window = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .slice(from)
            .map((line) => JSON.parse(line) as ProtocolEntry);
          o.codexInWindow = tally(window);
          expect(checks.filter((c) => !c.passed)).toEqual([]);
          expect(checks.map((c) => c.id)).toContain("program-identity/v1");
          expect(
            window.filter(
              (e) =>
                e.event === "request" &&
                ["thread/start", "turn/start"].includes(String(e.method)),
            ),
          ).toEqual([]);
        },
      );
    else {
      const resyncs: Json[] = [];
      /** One action through the product's action entry on the Task Definition object. */
      const act = async (
        actionId: string,
        fill: (modal: Locator) => Promise<void>,
      ) => {
        const before = new Set(
          (await snapshot()).runtimeOperations.map((x) => x.operationId),
        );
        await client.openProject(projectName);
        await page()
          .getByRole("navigation", { name: "Runtime 内容" })
          .getByRole("button", { name: "Task Definition", exact: true })
          .click();
        const pane = page().getByRole("region", {
          name: "项目操作",
          exact: true,
        });
        // After an action succeeded the product holds the object's actions until the Runtime sends a
        // state with a new revision (KB-296 guard). The Definition object's revision does not move when
        // only a formal authorization is recorded, so, as a person would, 重新同步 is used (at most 3).
        const button = pane.getByRole("button", {
          name: actionId,
          exact: true,
        });
        const note = pane.locator(".project-awaiting");
        const deadline = Date.now() + 120_000;
        let last = 0;
        while (
          !(await button.isEnabled({ timeout: 1000 }).catch(() => false))
        ) {
          if ((await note.count()) && Date.now() - last > 5000) {
            resyncs.push({
              before: actionId,
              note: await note.getByRole("status").textContent(),
            });
            expect(resyncs.length).toBeLessThanOrEqual(3);
            await note.getByRole("button", { name: "重新同步" }).click();
            last = Date.now();
          }
          expect(Date.now()).toBeLessThan(deadline);
          await page().waitForTimeout(1000);
        }
        await button.click();
        const modal = page().getByRole("dialog", {
          name: "核对项目操作",
          exact: true,
        });
        await expect(modal).toBeVisible();
        await fill(modal);
        const reads = modal.getByRole("button", { name: /^打开依据 [0-9]+$/ });
        for (let i = 0; i < (await reads.count()); i++)
          await reads.nth(i).click();
        const confirm = modal.getByRole("checkbox", {
          name: "我已核对本次操作与全部依据",
          exact: true,
        });
        if (await confirm.count()) await confirm.check();
        await modal
          .getByRole("button", { name: "确认提交", exact: true })
          .click();
        let operationId = "";
        await expect
          .poll(
            async () => {
              const created = (await snapshot()).runtimeOperations.filter(
                (x) =>
                  !before.has(x.operationId) &&
                  x.request?.actionId === actionId,
              );
              operationId = created[0]?.operationId ?? "";
              return created.length === 1 &&
                ["succeeded", "failed", "unknown", "cancelled"].includes(
                  created[0].status,
                )
                ? created[0].status
                : "pending";
            },
            { timeout: 120_000 },
          )
          .not.toBe("pending");
        await shot(actionId.replace(/\W+/g, "-"));
        await modal.getByRole("button", { name: "关闭", exact: true }).click();
        const s = await snapshot();
        const operation = s.runtimeOperations.find(
          (x) => x.operationId === operationId,
        ) as unknown as Json;
        const decision = s.runtimeDecisions.find(
          (d) => d.domainOperationId === operationId,
        );
        return {
          operationId,
          status: operation.status,
          resultCode: operation.resultCode,
          errorCode: operation.errorCode,
          reason: operation.reason,
          payload: (operation.request as Json)?.payload,
          decision: decision && {
            decisionRef: decision.decisionRef,
            source: decision.source,
            status: decision.status,
          },
        };
      };
      const hostExecutionRequests = () =>
        ["host.execution.preflight", "host.execution.start"].map(
          (method) =>
            readdirSync(transcripts)
              .flatMap((file) =>
                readFileSync(join(transcripts, file), "utf8")
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map(
                    (line) =>
                      JSON.parse(line) as { direction: string; value: Json },
                  ),
              )
              .filter(
                (f) =>
                  f.direction === "runtime-to-host" &&
                  f.value.method === method,
              ).length,
        );
      let from = 0;
      let hostBefore = [0, 0];
      await step(
        `${id}:formal-authorize`,
        "项目操作 → Task Definition → definition.formal-authorize records the Owner formal authorization for one call on the registered port (the refusal must come from the binding, not from a missing Owner fact)",
        async (o) => {
          from = lines();
          hostBefore = hostExecutionRequests();
          const version = String(workflow().runtimeVersion);
          o.expectedRuntimeVersion = version;
          o.operation = await act(
            "definition.formal-authorize",
            async (modal) => {
              await modal
                .getByRole("textbox", { name: "taskId", exact: true })
                .fill(fixture.taskId);
              await modal.getByText("填写portId", { exact: true }).click();
              await modal
                .getByRole("textbox", { name: "portId", exact: true })
                .fill(fixture.portId);
              await modal
                .getByRole("spinbutton", { name: "maxCalls", exact: true })
                .fill("1");
              await modal
                .getByRole("textbox", {
                  name: "expectedRuntimeVersion",
                  exact: true,
                })
                .fill(version);
            },
          );
          expect((o.operation as Json).status).toBe("succeeded");
          const formal = ((domainState().tasks as Json)[fixture.taskId] as Json)
            .taskDefinition as Json;
          o.formal = (formal.formal as Json[]).map((f) => ({
            factId: f.factId,
            portId: f.portId,
            maxCalls: f.maxCalls,
            capability: f.capability,
            profileDigest: f.profileDigest,
            roundLabel: f.roundLabel,
          }));
          expect(o.formal).toHaveLength(1);
        },
      );
      await step(
        `${id}:dispatch-refused`,
        "项目操作 → definition.dispatch is accepted; the Runtime's Reviewer execution is refused before any Host execution request: the round settles as an execution failure with execution-port-binding-mismatch and the task waits in RECOVERY_REQUIRED; no Codex process, thread or turn in this window",
        async (o) => {
          const version = String(workflow().runtimeVersion);
          o.expectedRuntimeVersion = version;
          o.resyncs = resyncs;
          o.operation = await act("definition.dispatch", async (modal) => {
            await modal
              .getByRole("textbox", { name: "taskId", exact: true })
              .fill(fixture.taskId);
            await modal
              .getByRole("textbox", {
                name: "expectedRuntimeVersion",
                exact: true,
              })
              .fill(version);
          });
          let round: Json = {};
          await expect
            .poll(
              () => {
                const definition = (
                  (domainState().tasks as Json)[fixture.taskId] as Json
                ).taskDefinition as Json;
                round =
                  ((definition.rounds as Json[]) ?? []).slice(-1)[0] ?? {};
                return round.status ?? "absent";
              },
              { timeout: 180_000 },
            )
            .not.toMatch(/^(absent|dispatched)$/);
          const instance = workflow();
          o.round = {
            round: round.round,
            status: round.status,
            failure: round.failure,
            formalFactId: round.formalFactId,
            executionId: round.executionId,
          };
          o.workflow = {
            position: instance.position,
            condition: instance.condition,
            runtimeVersion: instance.runtimeVersion,
          };
          const state = domainState();
          o.executionReservations = Object.keys(
            (state.executionReservations as Json) ?? {},
          ).length;
          const hostAfter = hostExecutionRequests();
          o.hostExecutionRequests = {
            preflight: hostAfter[0] - hostBefore[0],
            start: hostAfter[1] - hostBefore[1],
          };
          const window = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .slice(from)
            .map((line) => JSON.parse(line) as ProtocolEntry);
          o.codexInWindow = tally(window);
          const settled = (await snapshot()).runtimeOperations.find(
            (x) => x.operationId === (o.operation as Json).operationId,
          ) as unknown as Json | undefined;
          o.operationAfterSettlement = settled && {
            status: settled.status,
            resultCode: settled.resultCode,
            errorCode: settled.errorCode,
            reason: settled.reason,
          };
          // The refusal comes before any Host execution request and any Codex thread or turn.
          expect(o.hostExecutionRequests).toEqual({ preflight: 0, start: 0 });
          expect(
            window.filter(
              (e) =>
                e.event === "request" &&
                ["thread/start", "turn/start"].includes(String(e.method)),
            ),
          ).toEqual([]);
          expect(instance.condition).toBe("RECOVERY_REQUIRED");
          expect((round.failure as Json)?.failureCode).toBe(
            "execution-port-binding-mismatch",
          );
          expect(round.status).toBe("execution-failed");
        },
        // A wrong refusal stays recorded; the quit and the protocol count still run.
        { continueOnFailure: true },
      );
    }
    await step(
      `${id}:quit`,
      "quitting the client shuts the Runtime down and the process is gone",
      async (o) => {
        const last = (await snapshot()).runtimeInstances[0];
        await client.close();
        try {
          process.kill(last.pid!, 0);
          o.pidGone = false;
        } catch {
          o.pidGone = true;
        }
        expect(o.pidGone).toBe(true);
      },
    );
  }
});
