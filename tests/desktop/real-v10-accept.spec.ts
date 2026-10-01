/**
 * V-10 acceptance entry (feature-t31 S-06, OD-421): through the product, the real Runtime
 * development bundle accepts one task and refuses one on a local clone of the J-07 slice
 * repository, in the background isolated client and a fresh data root under
 * .test-data/disposable. It never calls a model, never dispatches an execution, never uses a
 * personal data root and never touches the slice repository itself: the run works on its own
 * copy of a prepared clone that has no remote.
 *
 * Inputs are explicit and never defaulted; a missing one fails the run with its name:
 *   CSTHINK_V10_BUNDLE_DIR      absolute import directory holding exactly bundle.tar,
 *                               release.json, release.sig and publisher.pub (J-03)
 *   CSTHINK_V10_REPOSITORY      absolute path of the prepared clone of the slice repository,
 *                               inside .test-data/disposable, without remotes (OD-421)
 *   CSTHINK_V10_EXPECTED_HEAD   the commit the clone's main must be at
 *   CSTHINK_V10_J07_RECORD      absolute path of the J-07 record (hp-j07-record/v1)
 *   CSTHINK_V10_EVIDENCE_DIR    absolute, new or empty evidence directory
 *   CSTHINK_V10_EXPECTED_PUBLISHER_KEY_DIGEST (optional) SPKI SHA-256 given out of band
 *
 * Steps: a working copy cloned from the prepared clone; import; the project's 仓库治理接入
 * entry registers the working copy; the bundle's own CLI writes the binding (as the person
 * on the receiving machine would, OD-412); 重新连接; the scope opens for the bound handle and
 * is refused for another folder; the reviewed authorization and the link; the readback is
 * compared item by item with the J-07 expected readback; the product's action entry accepts
 * design-t0 and the domain's records in the working copy are compared with the Host
 * readback; the Task acceptance list must reach the Host through the Runtime's events alone,
 * without a new snapshot (KB-296; when it does not, a diagnostic full snapshot is recorded
 * and the run goes on so the refusal is still exercised); the same entry asks to accept
 * feature-t0 and the refusal and the unchanged domain state are read back; when Define Task
 * (definition.submit) is offered, the person's placeholder candidate (a synthetic Task
 * Definition committed on the task branch of the working copy) is submitted once through
 * the product form and read back, and nothing after it runs (OD-423); every action the
 * projection lists has its payload schema resolved by the product's rule (OD-425 R1) and
 * its form built, and the offered ones are opened in the product; 运行记录 holds no
 * execution; the Runtime's writes stay under the run's disposable root. Any failed step
 * fails the entry.
 */
import { test, expect, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { goTo } from "./shell";
import { payloadSchemaOf } from "../../src/main/project-actions";
import { digestOf } from "../../src/main/runtime-admission";
import { actionForm } from "../../src/shared/project-actions";
import {
  deliveryInputs,
  probeRecord,
  ProbeClient,
  requireAbsolute,
  sha256,
  type Json,
} from "./real-probe";

const bundleDir = process.env.CSTHINK_V10_BUNDLE_DIR ?? "";
const prepared = process.env.CSTHINK_V10_REPOSITORY ?? "";
const expectedHead = process.env.CSTHINK_V10_EXPECTED_HEAD ?? "";
const j07Record = process.env.CSTHINK_V10_J07_RECORD ?? "";
const evidenceDir = process.env.CSTHINK_V10_EVIDENCE_DIR ?? "";
const expectedKey = process.env.CSTHINK_V10_EXPECTED_PUBLISHER_KEY_DIGEST ?? "";
/** Synthetic authority reference, confined to the isolated zero-model working copy. */
const bindingAuthority = "synthetic:v10-acceptance-probe";
/** Actions whose payload schema delivery-r3 announced outside its capability document (s06-r10). */
const previouslyRefused = new Set([
  "definition.decide",
  "definition.dispatch",
  "definition.formal-authorize",
  "publish.authorize",
  "publish.query",
  "publish.reconcile",
  "validate.decide",
  "validate.dispatch",
  "validate.dispose",
  "validate.formal-authorize",
  "validate.resume",
  "verify.run",
  "workflow.close",
]);
/**
 * The person's placeholder Task Definition (OD-423: synthetic, not Mars's task definition),
 * in the task template's structure with the identity chain the acceptance fixed.
 */
const placeholderDefinition = (taskId: string, milestonesRevision: number) =>
  [
    `# ${taskId} · V-10 合成占位定义`,
    "",
    "> Depends on:",
    `> \`milestones.md@r${milestonesRevision} ${taskId}\``,
    ">",
    `> 权威状态: subject \`${taskId}-task\`（治理记录目录按所在仓的布局规则解析；唯一状态正本）`,
    "",
    "## Identity",
    "",
    `- Task record ID: \`${taskId}\``,
    "- Task kind: `design`",
    `- Definition subject: \`${taskId}-task\``,
    "- Product line: `v10-synthetic-product-line`",
    "",
    "## 通俗说明（给人读）",
    "",
    "本节只帮助人建立心智模型，不是任务契约的权威取值；冲突时以其余正式章节为准。",
    "",
    "这是 V-10 验证在切片仓库克隆里提交的合成占位定义，只用来确认定义候选能经产品提交并被记录，不代表真实的任务定义。",
    "",
    "## Goal",
    "",
    "确认 Define Task 候选可经产品表单提交并被领域记录，本件内容为合成占位。",
    "",
    "## Goal Conditions",
    "",
    "- 领域记录了本候选的提交、路径与字节摘要。",
    "",
    "## Scope In",
    "",
    "- 在克隆的任务分支上提交本合成占位定义。",
    "",
    "## Scope Out",
    "",
    "- 真实任务定义、Authorize & Freeze 及之后的一切动作，由 Mars 在真实任务中承载。",
    "",
    "## Constraints",
    "",
    "- 只在一次性克隆中进行，不调用模型，不派发执行。",
    "",
    "## Acceptance Criteria",
    "",
    "- 领域读回的候选提交与字节摘要等于本件所在提交与本件字节。",
    "",
    "## Source References",
    "",
    `- Primary source: \`milestones.md@r${milestonesRevision} ${taskId}\``,
    "",
  ].join("\n");
/** Canonical JSON (sorted keys, no whitespace): RFC 8785 for these string, integer and array values. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
type Row = { id: string; title: string; detail: string };
/** Rows of a projected list object (view.kind "list"); anything else has none. */
const listRows = (object: { view: Json } | undefined): Row[] =>
  object?.view.kind === "list" && Array.isArray(object.view.rows)
    ? (object.view.rows as Row[])
    : [];

test.setTimeout(900_000);
// Traces would copy the bundle bytes and every frame; the protocol transcript is the record.
test.use({ trace: "off" });

test("V-10 accept and refuse: on a clone of the J-07 slice repository the real Runtime accepts design-t0 and refuses feature-t0 through the product entry, and its records in the clone match the Host readback", async () => {
  requireAbsolute("V-10 acceptance entry", [
    ["CSTHINK_V10_BUNDLE_DIR", bundleDir],
    ["CSTHINK_V10_REPOSITORY", prepared],
    ["CSTHINK_V10_J07_RECORD", j07Record],
    ["CSTHINK_V10_EVIDENCE_DIR", evidenceDir],
  ]);
  if (!/^[0-9a-f]{40}$/.test(expectedHead))
    throw new Error(
      "V-10 acceptance entry needs CSTHINK_V10_EXPECTED_HEAD (40 hexadecimal digits)",
    );
  const { step, steps, finish } = probeRecord(
    evidenceDir,
    "feature-t31-v10-accept/v1",
  );
  const disposable = resolve(".test-data/disposable") + sep;
  mkdirSync(disposable, { recursive: true });
  const root = mkdtempSync(join(disposable, "v10-run-"));
  const data = join(root, "data");
  const repo = join(root, "slice-repository");
  const other = join(root, "other-folder");
  const worktreeRoot = join(root, "worktrees");
  for (const dir of [data, other]) mkdirSync(dir);
  const gitIn =
    (dir: string) =>
    (...args: string[]) =>
      execFileSync("/usr/bin/git", ["-C", dir, ...args], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
        encoding: "utf8",
      }).trim();
  const git = gitIn(repo);
  const refs = (dir = repo) =>
    gitIn(dir)("for-each-ref", "--format=%(objectname) %(refname)")
      .split("\n")
      .filter(Boolean);
  const worktrees = () =>
    git("worktree", "list", "--porcelain")
      .split("\n\n")
      .map((block) =>
        Object.fromEntries(
          block
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const at = line.indexOf(" ");
              return at < 0
                ? [line, true]
                : [line.slice(0, at), line.slice(at + 1)];
            }),
        ),
      );
  /** The domain's own durable state in the working copy (hp: refs/harness/runtime:state.json). */
  const domainState = () =>
    JSON.parse(git("show", "refs/harness/runtime:state.json")) as Json;
  const client = new ProbeClient(data, join(evidenceDir, "transcripts"));
  const page = () => client.page;
  const snapshot = () => client.snapshot();
  const shot = (name: string) =>
    page().screenshot({ path: join(evidenceDir, name) });

  try {
    let inputs: Record<string, { bytes: number; sha256: string }> = {};
    let publisherKeyDigest = "";
    let expected: Json = {};
    let anchors: Json[] = [];
    await step(
      "inputs",
      "the import directory holds exactly the four delivery files; the J-07 record is read with its digest and expected readback; the prepared clone is inside .test-data/disposable, at the expected main, clean, without remotes or domain refs",
      (o) => {
        const delivery = deliveryInputs(bundleDir);
        o.files = inputs = delivery.files;
        publisherKeyDigest = delivery.publisherKeyDigest;
        o.publisherKeyDigest = publisherKeyDigest;
        if (expectedKey) expect(publisherKeyDigest).toBe(expectedKey);
        const raw = readFileSync(j07Record);
        const j07 = JSON.parse(raw.toString("utf8")) as Json;
        expect(j07.schema).toBe("hp-j07-record/v1");
        expected = (j07.assistant as Json).expected_readback as Json;
        anchors = j07.anchors_on_main as Json[];
        o.j07 = {
          bytes: raw.length,
          sha256: sha256(raw),
          j07: j07.j07,
          expectedReadback: expected,
          sliceMain: (j07.slice_repository as Json).main,
        };
        expect((j07.slice_repository as Json).main).toBe(expectedHead);
        const clone = gitIn(prepared);
        o.prepared = {
          relative: prepared.slice(resolve(".").length + 1),
          head: clone("rev-parse", "HEAD"),
          branch: clone("symbolic-ref", "-q", "HEAD"),
          remotes: clone("remote"),
          status: clone("status", "--porcelain", "--untracked-files=all"),
          refs: refs(prepared),
        };
        expect(resolve(prepared).startsWith(disposable)).toBe(true);
        expect(o.prepared).toMatchObject({
          head: expectedHead,
          branch: "refs/heads/main",
          remotes: "",
          status: "",
        });
        expect((o.prepared as Json).refs).toEqual([
          `${expectedHead} refs/heads/main`,
        ]);
      },
    );
    let startRefs: string[] = [];
    await step(
      "working-copy",
      "the run's working copy is cloned without hardlinks from the prepared clone into the run's disposable root; origin is removed; main is at the expected commit, clean, with no domain refs, no harness directory and no other worktree",
      (o) => {
        execFileSync(
          "/usr/bin/git",
          ["clone", "--quiet", "--no-hardlinks", prepared, repo],
          {
            env: {
              PATH: "/usr/bin:/bin",
              HOME: root,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        );
        git("remote", "remove", "origin");
        startRefs = refs();
        o.relativeRoot = root.slice(resolve(".").length + 1);
        o.head = git("rev-parse", "HEAD");
        o.branch = git("symbolic-ref", "-q", "HEAD");
        o.remotes = git("remote");
        o.status = git("status", "--porcelain", "--untracked-files=all");
        o.refs = startRefs;
        o.harnessDir = readdirSync(join(repo, ".git")).includes("harness");
        o.worktrees = worktrees().map((w) => w.worktree);
        expect(o).toMatchObject({
          head: expectedHead,
          branch: "refs/heads/main",
          remotes: "",
          status: "",
          harnessDir: false,
        });
        expect(startRefs).toEqual([`${expectedHead} refs/heads/main`]);
        expect(o.worktrees).toEqual([repo]);
      },
    );
    await client.launch();
    let projectId = "";
    await step(
      "project",
      "two projects are created through the folder picker and the creation entry: the slice repository working copy and a second plain folder",
      async (o) => {
        o.projectId = projectId = await client.createProject(
          repo,
          "V-10 切片仓克隆",
          "V-10 真实 hp 接纳与拒绝",
        );
        o.otherProjectId = await client.createProject(
          other,
          "V-10 另一目录",
          "未绑定句柄的对照",
        );
      },
    );
    const card = () =>
      page().getByRole("article", { name: "harness-plane 扩展", exact: true });
    await step(
      "import",
      "设置 → 扩展管理 → 从本地导入运行包 admits the delivery; the installation carries the delivered digests; the first launch is 待核实 without a binding",
      async (o) => {
        const section = await client.openExtensions();
        await client.pickDirectory(bundleDir);
        await section
          .getByRole("button", { name: "从本地导入运行包…" })
          .click();
        await expect(page().getByTestId("import-result")).toHaveText(
          "已导入并开始可用性检查。",
          { timeout: 120_000 },
        );
        const s = await snapshot();
        const i = s.runtimeInstallations[0];
        o.installation = {
          runtimeId: i.runtimeId,
          version: i.version,
          publisherId: i.publisherId,
          publicKeyDigest: i.publicKeyDigest,
          artifactDigest: i.artifactDigest,
          releaseRecordDigest: i.releaseRecordDigest,
          incompatibility: i.incompatibility,
        };
        expect(s.runtimeInstallations).toHaveLength(1);
        expect(i.artifactDigest).toBe(inputs["bundle.tar"].sha256);
        expect(i.releaseRecordDigest).toBe(inputs["release.json"].sha256);
        expect(i.publicKeyDigest).toBe(publisherKeyDigest);
        expect(i.incompatibility).toBeNull();
        await expect(card().getByTestId("extension-state")).toHaveText(
          "待核实",
          { timeout: 60_000 },
        );
        await expect(card().getByTestId("extension-health")).toContainText(
          "no instance binding file",
        );
      },
    );
    let handle = "";
    let instanceDir = "";
    await step(
      "register",
      "项目详情 → 仓库治理接入 → 登记项目文件夹 registers the working copy; the handle and, after the Runtime refuses to open the scope without a binding, the instance directory are copied from the entry; the working copy's refs are unchanged",
      async (o) => {
        const panel = await client.openProject("V-10 切片仓克隆");
        await panel.getByRole("button", { name: "登记项目文件夹" }).click();
        const value = panel.getByTestId("project-resource-handle-value");
        await expect(value).toHaveText(/^resource:[0-9a-f]{32}$/);
        await panel
          .getByTestId("project-resource-handle")
          .getByRole("button", { name: "复制 Runtime 资源句柄" })
          .click();
        handle = await client.clipboard();
        expect(handle).toBe(await value.textContent());
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        await expect(panel.getByRole("alert")).toContainText(
          "PERMISSION_DENIED：no instance binding file",
        );
        await panel
          .getByTestId("access-instance-dir")
          .getByRole("button", { name: "复制实例目录" })
          .click();
        instanceDir = await client.clipboard();
        o.handle = handle;
        o.instanceDir = instanceDir;
        o.refusal = await panel.getByRole("alert").textContent();
        o.refsUnchanged = refs().join("\n") === startRefs.join("\n");
        expect(instanceDir).toBe(
          (await snapshot()).runtimeInstances[0].launchDirectories!.instanceDir,
        );
        expect(o.refsUnchanged).toBe(true);
      },
    );
    await step(
      "binding-write",
      "the person on the receiving machine (here the probe) runs the bundle's own CLI with the working copy, the copied handle and instance directory and the OD-421 authority reference; show reads it back; Assistant writes no binding",
      async (o) => {
        const s = await snapshot();
        const installation = s.runtimeInstallations[0];
        const program = join(
          s.runtimeInstances[0].launchDirectories!.packageDir,
          installation.entrypoint,
        );
        const cli = (...args: string[]) =>
          JSON.parse(
            execFileSync(program, ["-I", "-B", "-m", "hp", ...args], {
              env: { PATH: "/usr/bin:/bin" },
              encoding: "utf8",
            }),
          ) as Json;
        o.write = cli(
          "binding",
          "write",
          "--instance-dir",
          instanceDir,
          "--repository",
          repo,
          "--resource-handle",
          handle,
          "--authority-ref",
          bindingAuthority,
        );
        o.show = cli("binding", "show", "--instance-dir", instanceDir);
        expect((o.write as Json).result).toBe("BINDING_WRITTEN");
        expect((o.show as Json).result).toBe("BINDING_READ");
        const binding = (o.show as Json).binding as Json;
        expect(binding.repository).toBe(repo);
        expect(binding.resourceHandles).toEqual([handle]);
      },
    );
    let incarnationId = "";
    await step(
      "reconnect-ready",
      "设置 → 扩展管理: 重新连接 in 待核实 starts a new incarnation that reads the binding; health is ready and the card states 可用",
      async (o) => {
        await client.openExtensions();
        await card().getByRole("button", { name: "重新连接" }).click();
        await expect(card().getByTestId("reconnect-result")).toHaveText(
          "已建立新的连接，当前状态：可用。",
          { timeout: 60_000 },
        );
        const instance = (await snapshot()).runtimeInstances[0];
        incarnationId = instance.incarnationId!;
        o.instance = {
          incarnationId,
          health: instance.health,
          capabilities: instance.negotiation?.capabilities.map((c) => c.id),
        };
        expect(instance.health?.result).toBe("ok");
      },
    );
    let scopeRef = "";
    let unboundRefusal = "";
    await step(
      "scope-open",
      "打开项目范围 opens an inactive scope for the bound handle; the other folder's handle is refused by the Runtime",
      async (o) => {
        let panel = await client.openProject("V-10 切片仓克隆");
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        await expect(panel.getByTestId("access-scope")).toContainText(
          "尚未授权",
        );
        const scope = (await snapshot()).runtimeScopes[0];
        scopeRef = scope.scopeRef;
        o.scope = {
          scopeRef,
          state: scope.state,
          resourceHandle: scope.resourceHandle,
        };
        expect(scope.resourceHandle).toBe(handle);
        panel = await client.openProject("V-10 另一目录");
        await panel.getByRole("button", { name: "登记项目文件夹" }).click();
        await expect(
          panel.getByTestId("project-resource-handle-value"),
        ).toHaveText(/^resource:/);
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        await expect(panel.getByRole("alert")).toContainText(
          "PERMISSION_DENIED",
        );
        unboundRefusal = (await panel.getByRole("alert").textContent())!;
        o.unbound = {
          message: unboundRefusal,
          scopes: (await snapshot()).runtimeScopes.length,
        };
        expect((o.unbound as Json).scopes).toBe(1);
      },
    );
    await step(
      "authorize-link",
      "核对并授权… and 确认授权 grant the reviewed set in one authorization; the projection becomes current and 关联 links the project",
      async (o) => {
        const panel = await client.openProject("V-10 切片仓克隆");
        await panel.getByRole("button", { name: "核对并授权…" }).click();
        await page()
          .getByRole("dialog", { name: "核对扩展授权" })
          .getByRole("button", { name: "确认授权" })
          .click();
        await expect(panel.getByTestId("access-grants")).toContainText(
          "已授权 56 项",
          { timeout: 30_000 },
        );
        await expect
          .poll(async () => (await snapshot()).runtimeScopes[0].freshness, {
            timeout: 30_000,
          })
          .toBe("current");
        await page()
          .getByRole("combobox", { name: "关联项目内容", exact: true })
          .selectOption(
            `${(await snapshot()).runtimeInstances[0].instanceId}|${scopeRef}`,
          );
        await page().getByRole("button", { name: "关联", exact: true }).click();
        await expect(panel.getByTestId("access-summary")).toHaveText("已接入", {
          timeout: 30_000,
        });
        const s = await snapshot();
        o.grants = s.runtimeGrants.filter((g) => g.status === "active").length;
        o.domainRefs = refs().filter((r) => r.includes(" refs/harness/"));
        await panel.scrollIntoViewIfNeeded();
        await shot("v10-access-connected-light.png");
      },
    );
    const instanceId = (await snapshot()).runtimeInstances[0].instanceId;
    const projection = () =>
      client.app!.evaluate(
        async (_, { instanceId, scopeRef }) => {
          const host = globalThis.runtimeHost;
          await host.awaitCurrent(instanceId, scopeRef);
          return host.projection(instanceId, scopeRef);
        },
        { instanceId, scopeRef },
      );
    /** The domain's own projection of the scope, kept in its state in the working copy. */
    const domainProjection = () =>
      (domainState().scopes as Json)[scopeRef] as {
        objects: Json[];
        actions: Json[];
        pendingItems: Json[];
      };
    const shape = (v: {
      objects: Json[];
      actions: Json[];
      pendingItems: Json[];
    }) =>
      canonical({
        objects: v.objects.map((x) => `${x.objectRef}|${x.revision}`).sort(),
        actions: v.actions
          .map(
            (a) =>
              `${a.actionId}|${a.objectRef}|${a.expectedRevision}|${a.enabled}`,
          )
          .sort(),
        pending: v.pendingItems
          .map((x) => `${x.itemRef}|${x.revision}|${x.status}`)
          .sort(),
      });
    /**
     * Waits until the Host has applied every event the domain emitted (its projection equals
     * the domain's own), then returns it. Waiting reads only; it opens no snapshot.
     */
    const settled = async () => {
      const started = Date.now();
      await expect
        .poll(
          async () =>
            shape((await projection()) as never) === shape(domainProjection()),
          { timeout: 30_000 },
        )
        .toBe(true);
      return { view: await projection(), waitedMs: Date.now() - started };
    };
    await step(
      "readback",
      "the readback equals the J-07 r3 expected readback item by item: health ready, sources rows 0, task.accept enabled, an unbound handle PERMISSION_DENIED",
      async (o) => {
        const health = client.exchanges(incarnationId, "runtime.health");
        const lastHealth = health[health.length - 1]?.reply?.result as Json;
        const view = await projection();
        const sources = view.objects.find(
          (x) => x.objectRef === "sources:milestones",
        );
        const accept = view.actions.find((a) => a.actionId === "task.accept");
        const observed = {
          health: lastHealth?.health,
          sources_rows: sources ? listRows(sources).length : null,
          task_accept_enabled: accept?.enabled ?? null,
          unbound_handle: /PERMISSION_DENIED/.test(unboundRefusal)
            ? "PERMISSION_DENIED"
            : unboundRefusal,
        };
        const items = Object.keys(observed).map((key) => ({
          item: key,
          expected: expected[key],
          observed: observed[key as keyof typeof observed],
          result:
            expected[key] === observed[key as keyof typeof observed]
              ? "PASS"
              : "FAIL",
        }));
        o.items = items;
        o.note = expected.note;
        o.projection = {
          objects: view.objects.map((x) => ({
            objectRef: x.objectRef,
            title: x.title,
            stateLabel: x.stateLabel,
          })),
          enabledActions: view.actions
            .filter((a) => a.enabled)
            .map((a) => a.actionId),
          disabledActions: view.actions.filter((a) => !a.enabled).length,
          taskAccept: accept && {
            requiresHumanDecision: accept.requiresHumanDecision,
            expectedRevision: accept.expectedRevision,
            payloadSchemaDigest: accept.payloadSchemaDigest,
          },
          pendingItems: view.pendingItems.length,
        };
        expect(items.filter((i) => i.result === "FAIL")).toEqual([]);
      },
    );
    /** Opens an action of a Runtime object in 项目操作 and returns the pane and the confirmation dialog. */
    const openAction = async (objectTitle: string, label: string) => {
      await client.openProject("V-10 切片仓克隆");
      await page()
        .getByRole("navigation", { name: "Runtime 内容" })
        .getByRole("button", { name: objectTitle, exact: true })
        .click();
      const pane = page().getByRole("region", {
        name: "项目操作",
        exact: true,
      });
      await pane.getByRole("button", { name: label, exact: true }).click();
      const modal = page().getByRole("dialog", {
        name: "核对项目操作",
        exact: true,
      });
      await expect(modal).toBeVisible();
      return { pane, modal };
    };
    /**
     * One action through the product's action entry: the person fills the form, opens every
     * evidence the confirmation lists, confirms and submits; returns the settled operation.
     */
    const actThroughEntry = async (
      objectTitle: string,
      label: string,
      actionId: string,
      fill: (modal: Locator) => Promise<void>,
      prefix: string,
    ) => {
      const before = new Set(
        (await snapshot()).runtimeOperations.map((x) => x.operationId),
      );
      const { pane, modal } = await openAction(objectTitle, label);
      await fill(modal);
      const reads = modal.getByRole("button", { name: /^打开依据 [0-9]+$/ });
      for (let i = 0; i < (await reads.count()); i++)
        await reads.nth(i).click();
      const confirm = modal.getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      });
      if (await confirm.count()) await confirm.check();
      await modal.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await shot(`${prefix}-confirm-light.png`);
      await modal
        .getByRole("button", { name: "确认提交", exact: true })
        .click();
      await expect(modal.locator(".project-operation")).toBeVisible({
        timeout: 60_000,
      });
      let operationId = "";
      await expect
        .poll(
          async () => {
            const created = (await snapshot()).runtimeOperations.filter(
              (x) =>
                !before.has(x.operationId) && x.request?.actionId === actionId,
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
      await modal.getByRole("button", { name: "关闭", exact: true }).click();
      const s = await snapshot();
      const operation = s.runtimeOperations.find(
        (x) => x.operationId === operationId,
      )!;
      const decision = s.runtimeDecisions.find(
        (d) => d.domainOperationId === operationId,
      );
      await expect(pane).toContainText(operationId);
      await pane
        .getByRole("article", { name: `操作 ${operationId}` })
        .scrollIntoViewIfNeeded();
      await shot(`${prefix}-result-light.png`);
      return { operation, decision };
    };
    /** One task.accept through the product's action entry; returns the settled operation. */
    const acceptThroughEntry = (taskId: string, prefix: string) =>
      actThroughEntry(
        "Task acceptance",
        "Accept a milestones task",
        "task.accept",
        async (modal) => {
          await modal
            .getByRole("combobox", { name: "taskType", exact: true })
            .selectOption("feature");
          await modal
            .getByRole("textbox", { name: "taskId", exact: true })
            .fill(taskId);
          await modal
            .getByRole("textbox", { name: "baseRef", exact: true })
            .fill("main");
          await modal
            .getByRole("textbox", { name: "worktreeRoot", exact: true })
            .fill(worktreeRoot);
        },
        prefix,
      );
    const summary = (op: Json) => ({
      operationId: op.operationId,
      status: op.status,
      transport: op.transport,
      resultCode: op.resultCode,
      errorCode: op.errorCode,
      reason: op.reason,
      resultRef: op.resultRef,
      request: {
        actionId: (op.request as Json)?.actionId,
        objectRef: (op.request as Json)?.objectRef,
        expectedRevision: (op.request as Json)?.expectedRevision,
        payload: (op.request as Json)?.payload,
      },
    });
    let acceptedTask: Json = {};
    let stateAfterAccept: Json = {};
    let worktreesAfterAccept: Json[] = [];
    /** Full snapshots the Host opened, and the frames, before the acceptance (KB-296 regression). */
    let snapshotsBeforeAccept = 0;
    let framesBeforeAccept = 0;
    let sourcesBeforeAccept: { revision?: string; rows: Row[] } = { rows: [] };
    let sourcesAfterAccept: Row[] = [];
    await step(
      "accept-design-t0",
      "the product's action entry accepts design-t0 (taskType feature, base main, worktree root inside the run's disposable root) after the person confirms; the Host records a trusted decision and the Runtime settles the operation succeeded",
      async (o) => {
        snapshotsBeforeAccept = client.exchanges(
          incarnationId,
          "runtime.snapshot.open",
        ).length;
        framesBeforeAccept = client.frames(incarnationId).length;
        const before = (await projection()).objects.find(
          (x) => x.objectRef === "sources:milestones",
        );
        sourcesBeforeAccept = {
          revision: before?.revision,
          rows: listRows(before),
        };
        o.before = { snapshotsBeforeAccept, sourcesBeforeAccept };
        const { operation, decision } = await acceptThroughEntry(
          "design-t0",
          "v10-accept",
        );
        o.operation = summary(operation as unknown as Json);
        o.decision = decision && {
          decisionRef: decision.decisionRef,
          domainOperationId: decision.domainOperationId,
          actionId: decision.actionId,
          objectRef: decision.objectRef,
          source: decision.source,
          status: decision.status,
          actorRef: decision.actorRef,
        };
        const invoke = client
          .exchanges(incarnationId, "runtime.action.invoke")
          .find(
            (x) =>
              (x.request.params as Json).operationId === operation.operationId,
          );
        o.invoke = invoke && {
          params: {
            actionId: (invoke.request.params as Json).actionId,
            objectRef: (invoke.request.params as Json).objectRef,
            decisionRef: (invoke.request.params as Json).decisionRef,
            payload: (invoke.request.params as Json).payload,
          },
          reply: invoke.reply,
        };
        o.decisionReads = client
          .exchanges(incarnationId, "host.decision.get", "runtime-to-host")
          .filter(
            (x) =>
              (x.request.params as Json).decisionRef === decision?.decisionRef,
          ).length;
        expect(operation.status).toBe("succeeded");
        expect(operation.resultCode).toBe("ACCEPTED");
        expect(decision?.source).toBe("host-trusted-ui");
        expect(o.decisionReads).toBeGreaterThanOrEqual(1);
        stateAfterAccept = domainState();
        acceptedTask = (stateAfterAccept.tasks as Json)["design-t0"] as Json;
        worktreesAfterAccept = worktrees();
      },
    );
    await step(
      "accept-records",
      "the domain's records in the working copy (refs/harness/runtime state, the task branch and worktree, the acceptance operation and claim, the Canonical Source Anchor) equal the Host readback (the settled operation and its result evidence, the projection objects and rows); later actions are only recorded",
      async (o) => {
        const s = await snapshot();
        const operation = s.runtimeOperations.find(
          (x) =>
            x.request?.actionId === "task.accept" &&
            (x.request?.payload as Json)?.taskId === "design-t0",
        )!;
        const decision = s.runtimeDecisions.find(
          (d) => d.domainOperationId === operation.operationId,
        )!;
        const acceptance = (stateAfterAccept.acceptance as Json)[
          operation.operationId
        ] as Json;
        const anchor = acceptedTask.anchor as Json;
        const claims = stateAfterAccept.claims as Json;
        o.domain = {
          revision: stateAfterAccept.revision,
          tasks: Object.keys(stateAfterAccept.tasks as Json),
          task: {
            taskId: acceptedTask.taskId,
            taskRef: acceptedTask.taskRef,
            taskType: acceptedTask.taskType,
            repositoryIdentity: acceptedTask.repositoryIdentity,
            branch: acceptedTask.branch,
            worktree: acceptedTask.worktree,
            acceptedRevision: acceptedTask.acceptedRevision,
            provenance: acceptedTask.provenance,
            terminal: acceptedTask.terminal,
            position: (acceptedTask.workflowInstance as Json)?.position,
          },
          anchor: {
            digest: anchor.digest,
            sourceRevision: anchor.sourceRevision,
            milestone: anchor.milestone,
            line: anchor.line,
            dependencies: anchor.dependencies,
            workflowDefinition: anchor.workflowDefinition,
          },
          acceptance: {
            status: acceptance.status,
            outcome: acceptance.outcome,
            channel: acceptance.channel,
            intent: acceptance.intent,
            history: (acceptance.history as Json[]).map((h) => h.event),
          },
          claims,
        };
        const branchRef = refs().find((r) =>
          r.endsWith(" refs/heads/harness/design-t0"),
        );
        o.git = {
          harnessDir: readdirSync(join(repo, ".git", "harness")).sort(),
          refs: refs(),
          worktrees: worktreesAfterAccept,
          status: git("status", "--porcelain", "--untracked-files=all"),
        };
        const view = (await settled()).view;
        const sources = view.objects.find(
          (x) => x.objectRef === "sources:milestones",
        )!;
        const taskObject = view.objects.find(
          (x) => x.objectRef === acceptedTask.taskRef,
        );
        const rows = (object: typeof taskObject): Record<string, string> =>
          Object.fromEntries(listRows(object).map((r) => [r.id, r.detail]));
        const evidence = operation.resultRef
          ? await client.app!.evaluate(
              async (_, { instanceId, scopeRef, ref }) =>
                Buffer.from(
                  await globalThis.runtimeHost.projectEvidence(
                    instanceId,
                    scopeRef,
                    ref,
                  ),
                ).toString("utf8"),
              { instanceId, scopeRef, ref: operation.resultRef as Json },
            )
          : "";
        const result = evidence ? (JSON.parse(evidence) as Json) : {};
        o.host = {
          operation: summary(operation as unknown as Json),
          resultEvidence: {
            sha256: sha256(evidence),
            result: result.result,
            task: result.task && {
              taskRef: (result.task as Json).taskRef,
              branch: (result.task as Json).branch,
              worktree: (result.task as Json).worktree,
              anchor: ((result.task as Json).anchor as Json)?.digest,
            },
          },
          sourcesRows: listRows(sources),
          taskObject: taskObject && {
            objectRef: taskObject.objectRef,
            title: taskObject.title,
            stateLabel: taskObject.stateLabel,
            revision: taskObject.revision,
            rows: rows(taskObject),
          },
          enabledActions: view.actions
            .filter((a) => a.enabled)
            .map((a) => ({ actionId: a.actionId, objectRef: a.objectRef })),
          pendingItems: view.pendingItems.map((p) => ({
            itemRef: p.itemRef,
            objectRef: p.objectRef,
            status: p.status,
            actionIds: p.actionIds,
          })),
          executions: s.runtimeExecutions.length,
        };
        // J-07 resolved the anchor without the Workflow definition the acceptance adds to it.
        const j07Anchor = anchors.find((a) => a.task === "design-t0");
        const withoutWorkflow = Object.fromEntries(
          Object.entries(anchor).filter(
            ([k]) => k !== "digest" && k !== "workflowDefinition",
          ),
        );
        o.j07Anchor = {
          anchorDigest: j07Anchor?.anchorDigest,
          acceptedDigest: anchor.digest,
          acceptedDigestRecomputed: sha256(
            canonical(
              Object.fromEntries(
                Object.entries(anchor).filter(([k]) => k !== "digest"),
              ),
            ),
          ),
          acceptedWithoutWorkflowDigest: sha256(canonical(withoutWorkflow)),
          workflowDefinitionEqual:
            canonical(anchor.workflowDefinition) ===
            canonical(j07Anchor?.workflowDefinition),
        };
        const taskRows = rows(taskObject);
        const worktree = worktreesAfterAccept.find(
          (w) => w.worktree === acceptedTask.worktree,
        );
        const checks = {
          acceptanceAccepted:
            acceptance.status === "accepted" &&
            acceptance.outcome === "ACCEPTED",
          // The Host's decisionRef already carries "decision:"; delivery-r4 records it as is (KB-298).
          authorityIsTheDecision:
            (acceptance.intent as Json).authorityRef === decision.decisionRef,
          intentMatchesForm:
            (acceptance.intent as Json).repository === repo &&
            (acceptance.intent as Json).worktreeRoot === worktreeRoot &&
            (acceptance.intent as Json).taskId === "design-t0" &&
            (acceptance.intent as Json).baseRef === "main",
          anchorAtExpectedRevision: anchor.sourceRevision === expectedHead,
          branchAtSourceRevision:
            branchRef === `${expectedHead} refs/heads/harness/design-t0`,
          worktreeRegisteredOnBranch:
            !!worktree &&
            worktree.branch === "refs/heads/harness/design-t0" &&
            worktree.HEAD === expectedHead,
          worktreeInsideRunRoot: String(acceptedTask.worktree).startsWith(
            worktreeRoot + sep,
          ),
          claimAccepted: Object.values(claims).some(
            (c) =>
              (c as Json).state === "accepted" &&
              (c as Json).task === "design-t0" &&
              (c as Json).operation === operation.operationId,
          ),
          hostSucceeded:
            operation.status === "succeeded" &&
            operation.resultCode === "ACCEPTED",
          evidenceDigestBound:
            !!operation.resultRef &&
            sha256(evidence) === (operation.resultRef as Json).digest,
          evidenceTaskEqualsDomain:
            canonical(result.task) === canonical(acceptedTask),
          anchorMatchesJ07WithoutWorkflow:
            (o.j07Anchor as Json).acceptedWithoutWorkflowDigest ===
              j07Anchor?.anchorDigest &&
            (o.j07Anchor as Json).acceptedDigestRecomputed === anchor.digest,
          taskObjectRowsEqualDomain:
            taskRows.branch === acceptedTask.branch &&
            taskRows.worktree === acceptedTask.worktree &&
            taskRows.anchor === anchor.digest &&
            taskRows.revision === anchor.sourceRevision &&
            taskRows.position ===
              (acceptedTask.workflowInstance as Json)?.position,
          noExecution: s.runtimeExecutions.length === 0,
          mainUnchanged: refs().includes(`${expectedHead} refs/heads/main`),
        };
        o.checks = checks;
        o.authorityRef = (acceptance.intent as Json).authorityRef;
        const task = page()
          .getByRole("navigation", { name: "Runtime 内容" })
          .getByRole("button", { name: "design-t0", exact: true });
        await task.click();
        await page()
          .locator(".project-domain-content")
          .scrollIntoViewIfNeeded();
        await shot("v10-task-design-t0-light.png");
        expect(
          Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k),
        ).toEqual([]);
      },
    );
    await step(
      "sources-list",
      "after the acceptance the Runtime's events alone bring the Task acceptance list (sources:milestones) to the domain's own projection of it: one row for design-t0, a new object revision, an object.upsert event for it, no new full snapshot; the product shows the row",
      async (o) => {
        const state = domainState();
        const domainView = (state.scopes as Json)[scopeRef] as Json;
        const domainSources = (domainView.objects as Json[]).find(
          (x) => x.objectRef === "sources:milestones",
        ) as { view: Json; revision: string } | undefined;
        const hostSources = (await settled()).view.objects.find(
          (x) => x.objectRef === "sources:milestones",
        );
        const after = client.frames(incarnationId).slice(framesBeforeAccept);
        const events = after
          .filter(
            (f) =>
              f.direction === "runtime-to-host" &&
              f.value.method === "runtime.event",
          )
          .map((f) => (f.value.params as Json).event as Json);
        const sourcesEvents = events.filter(
          (e) => (e.payload as Json)?.objectRef === "sources:milestones",
        );
        const snapshotsAfterAccept = client.exchanges(
          incarnationId,
          "runtime.snapshot.open",
        ).length;
        sourcesAfterAccept = listRows(domainSources);
        o.domain = {
          revision: domainSources?.revision,
          rows: listRows(domainSources),
        };
        o.hostFromEvents = {
          before: sourcesBeforeAccept,
          revision: hostSources?.revision,
          rows: listRows(hostSources),
        };
        o.events = events.map((e) => ({
          seq: e.seq,
          kind: e.kind,
          objectRef: (e.payload as Json)?.objectRef ?? null,
          actionId: (e.payload as Json)?.actionId ?? null,
          domainRevision: e.domainRevision,
        }));
        o.snapshots = {
          beforeAccept: snapshotsBeforeAccept,
          afterAccept: snapshotsAfterAccept,
        };
        await client.openProject("V-10 切片仓克隆");
        await page()
          .getByRole("navigation", { name: "Runtime 内容" })
          .getByRole("button", { name: "Task acceptance", exact: true })
          .click();
        const content = page().locator(".project-domain-content");
        const shown = await content
          .getByText("design-t0", { exact: true })
          .count();
        o.shownRows = shown;
        await content.scrollIntoViewIfNeeded();
        await shot("v10-sources-after-accept-light.png");
        const checks = {
          domainOneRowForTheTask:
            listRows(domainSources).length === 1 &&
            listRows(domainSources)[0].id === acceptedTask.taskRef &&
            listRows(domainSources)[0].title === "design-t0",
          hostRowsEqualDomain:
            canonical(listRows(hostSources)) ===
            canonical(listRows(domainSources)),
          hostRevisionEqualsDomain:
            hostSources?.revision === domainSources?.revision,
          revisionAdvanced:
            hostSources?.revision !== sourcesBeforeAccept.revision,
          upsertEventReceived: sourcesEvents.some(
            (e) =>
              e.kind === "object.upsert" &&
              canonical(listRows(e.payload as { view: Json })) ===
                canonical(listRows(domainSources)),
          ),
          noNewSnapshot: snapshotsAfterAccept === snapshotsBeforeAccept,
          productShowsTheRow: shown > 0,
        };
        o.checks = checks;
        const failed = Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k]) => k);
        if (failed.length) {
          // Diagnostic only (not a product path): a full snapshot through the Host's sync.
          await client.app!.evaluate(
            (_, { instanceId, scopeRef }) =>
              globalThis.runtimeHost.sync(instanceId, scopeRef),
            { instanceId, scopeRef },
          );
          const resynced = (await projection()).objects.find(
            (x) => x.objectRef === "sources:milestones",
          );
          o.hostAfterFullSnapshot = {
            revision: resynced?.revision,
            rows: listRows(resynced),
          };
        }
        expect(failed).toEqual([]);
      },
      { continueOnFailure: true },
    );
    await step(
      "refuse-feature-t0",
      "the same entry asks to accept feature-t0; the Runtime refuses it because design-t1 has no terminal done fact (DEPENDENCY_UNMET); the domain's tasks, claims, branches and worktrees are unchanged and the refused operation is recorded",
      async (o) => {
        const refsBefore = refs();
        const { operation, decision } = await acceptThroughEntry(
          "feature-t0",
          "v10-refuse",
        );
        o.operation = summary(operation as unknown as Json);
        o.decision = decision && {
          decisionRef: decision.decisionRef,
          source: decision.source,
          status: decision.status,
        };
        const state = domainState();
        const acceptance = (state.acceptance as Json)[
          operation.operationId
        ] as Json;
        o.domain = {
          revision: state.revision,
          tasks: Object.keys(state.tasks as Json),
          claims: state.claims,
          acceptance: {
            status: acceptance?.status,
            outcome: acceptance?.outcome,
            intent: acceptance?.intent,
            history: (acceptance?.history as Json[] | undefined)?.map((h) => ({
              event: h.event,
              message: h.message,
            })),
          },
        };
        const domainSources = (
          ((state.scopes as Json)[scopeRef] as Json).objects as Json[]
        ).find((x) => x.objectRef === "sources:milestones") as
          { view: Json } | undefined;
        const hostSources = (await settled()).view.objects.find(
          (x) => x.objectRef === "sources:milestones",
        );
        o.sourcesRows = {
          domain: listRows(domainSources),
          host: listRows(hostSources),
        };
        const checks = {
          hostFailedWithDependency:
            operation.status === "failed" &&
            operation.resultCode === "DEPENDENCY-UNMET" &&
            /design-t1/.test(operation.reason),
          domainRejected:
            acceptance?.status === "rejected" &&
            acceptance?.outcome === "DEPENDENCY_UNMET",
          tasksUnchanged:
            canonical(state.tasks) === canonical(stateAfterAccept.tasks),
          claimsUnchanged:
            canonical(state.claims) === canonical(stateAfterAccept.claims),
          branchesUnchanged:
            refs()
              .filter((r) => r.includes(" refs/heads/"))
              .join("\n") ===
            refsBefore.filter((r) => r.includes(" refs/heads/")).join("\n"),
          worktreesUnchanged:
            canonical(worktrees()) === canonical(worktreesAfterAccept),
          domainSourcesRowsUnchanged:
            canonical(listRows(domainSources)) ===
            canonical(sourcesAfterAccept),
          hostSourcesRowsEqualDomain:
            canonical(listRows(hostSources)) ===
            canonical(listRows(domainSources)),
        };
        o.checks = checks;
        o.refs = refs();
        expect(
          Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k),
        ).toEqual([]);
      },
    );
    await step(
      "define-task",
      "Define Task (definition.submit) is offered after the acceptance; the person commits a synthetic placeholder Task Definition on the design-t0 task branch in the working copy and submits it once through the product form (human only, the placeholder file as author evidence); the Runtime records exactly that candidate (commit, path, bytes, digest, author) and the Host readback agrees; nothing after it runs: no Authorize & Freeze, no dispatch, no execution, no model (OD-423). When it is not offered, the reason is recorded instead",
      async (o) => {
        const view = (await settled()).view;
        const submit = view.actions.find(
          (a) => a.actionId === "definition.submit",
        );
        const definitionObject = view.objects.find(
          (x) => x.objectRef === submit?.objectRef,
        );
        o.offered = submit && {
          objectRef: submit.objectRef,
          objectTitle: definitionObject?.title,
          label: submit.label,
          enabled: submit.enabled,
          disabledCode: submit.disabledCode,
          disabledReason: submit.disabledReason,
          requiresHumanDecision: submit.requiresHumanDecision,
          payloadSchemaDigest: submit.payloadSchemaDigest,
        };
        o.definitionRows = listRows(definitionObject);
        if (!submit?.enabled || !definitionObject) {
          o.result = "NOT_OFFERED";
          return;
        }
        const state = domainState();
        const task = (state.tasks as Json)["design-t0"] as Json;
        const instance = task.workflowInstance as Json;
        const milestones = ((task.anchor as Json).components as Json)
          .milestones as Json;
        const worktree = String(task.worktree);
        const path = "tasks/design-t0/design-t0.md";
        const bytes = Buffer.from(
          placeholderDefinition("design-t0", Number(milestones.freezeRevision)),
          "utf8",
        );
        mkdirSync(join(worktree, "tasks", "design-t0"), { recursive: true });
        writeFileSync(join(worktree, path), bytes);
        const inWorktree = gitIn(worktree);
        inWorktree("add", path);
        inWorktree(
          "-c",
          "user.name=V-10 probe",
          "-c",
          "user.email=v10-probe@invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-q",
          "-m",
          "V-10 synthetic placeholder Task Definition (OD-423)",
        );
        const commit = inWorktree("rev-parse", "HEAD");
        const taskObject = view.objects.find(
          (x) => x.objectRef === task.taskRef,
        );
        o.candidate = {
          path,
          bytes: bytes.length,
          sha256: sha256(bytes),
          commit,
          branch: refs().find((r) =>
            r.endsWith(" refs/heads/harness/design-t0"),
          ),
          position: instance.position,
          runtimeVersion: instance.runtimeVersion,
          // What the product shows of the task, where the person would read the Runtime Version.
          taskRows: listRows(taskObject),
        };
        const { operation, decision } = await actThroughEntry(
          String(definitionObject.title),
          submit.label,
          "definition.submit",
          async (modal) => {
            await modal
              .getByRole("textbox", { name: "taskId", exact: true })
              .fill("design-t0");
            // The candidate commit and the author evidence entry's commit are the same commit.
            const commits = modal.getByRole("textbox", {
              name: "commit",
              exact: true,
            });
            await expect(commits).toHaveCount(2);
            for (let i = 0; i < 2; i++) await commits.nth(i).fill(commit);
            await modal
              .getByRole("group", { name: "evidenceRefs 第 1 项", exact: true })
              .getByRole("textbox", { name: "path", exact: true })
              .fill(path);
            await modal
              .getByRole("combobox", { name: "humanOnly", exact: true })
              .selectOption("true");
            for (const name of ["tool", "model", "vendor"])
              await expect(
                modal.getByRole("checkbox", {
                  name: `${name} 为空值（null）`,
                  exact: true,
                }),
              ).toBeChecked();
            await modal
              .getByRole("textbox", {
                name: "expectedRuntimeVersion",
                exact: true,
              })
              .fill(String(instance.runtimeVersion));
            await modal.evaluate((el) => (el.scrollTop = 0));
            await shot("v10-define-form-top-light.png");
          },
          "v10-define",
        );
        const after = domainState();
        const defined = (after.tasks as Json)["design-t0"] as Json;
        const definition = (defined.taskDefinition ?? {}) as Json;
        const candidates = (definition.candidates ?? []) as Json[];
        const recorded = candidates[0] ?? {};
        const author = (recorded.author ?? {}) as Json;
        const evidence = ((author.evidence ?? []) as Json[])[0] ?? {};
        const s = await snapshot();
        const later = (await settled()).view;
        const laterDefinition = later.objects.find(
          (x) => x.objectRef === submit.objectRef,
        );
        o.operation = summary(operation as unknown as Json);
        o.decision = decision && {
          decisionRef: decision.decisionRef,
          source: decision.source,
          status: decision.status,
        };
        o.domain = {
          revision: after.revision,
          candidates: candidates.map((c) => ({
            candidateId: c.candidateId,
            kind: c.kind,
            commit: c.commit,
            path: c.path,
            bytes: c.bytes,
            sha256: c.sha256,
            blob: c.blob,
            authorityRef: c.authorityRef,
            author: c.author,
            authorIdentity: c.authorIdentity,
            validator: c.validator,
            identityChain: c.identityChain,
          })),
          position: (defined.workflowInstance as Json)?.position,
          condition: (defined.workflowInstance as Json)?.condition,
          runtimeVersion: (defined.workflowInstance as Json)?.runtimeVersion,
          frozen: definition.frozen ?? null,
          rounds: ((definition.rounds ?? []) as Json[]).length,
          decisions: ((definition.decisions ?? []) as Json[]).length,
          formal: ((definition.formal ?? []) as Json[]).length,
        };
        o.host = {
          definitionRows: listRows(laterDefinition),
          enabledActions: later.actions
            .filter((a) => a.enabled)
            .map((a) => a.actionId),
          pendingItems: later.pendingItems.map((p) => ({
            itemRef: p.itemRef,
            objectRef: p.objectRef,
            status: p.status,
            actionIds: p.actionIds,
          })),
          operations: s.runtimeOperations.map((x) => ({
            actionId: x.request?.actionId,
            status: x.status,
            resultCode: x.resultCode,
          })),
          executions: s.runtimeExecutions.length,
        };
        const checks = {
          hostSucceeded: operation.status === "succeeded",
          oneCandidate: candidates.length === 1,
          candidateIsTheCommit: recorded.commit === commit,
          candidateIsTheBytes:
            recorded.path === path &&
            recorded.bytes === bytes.length &&
            recorded.sha256 === sha256(bytes),
          authorHumanOnlyWithTheEvidence:
            author.humanOnly === true &&
            author.tool === null &&
            author.model === null &&
            author.vendor === null &&
            evidence.commit === commit &&
            evidence.path === path &&
            evidence.sha256 === sha256(bytes),
          authorityIsTheDecision:
            recorded.authorityRef === decision?.decisionRef,
          notFrozen: !definition.frozen,
          onlyAcceptAndSubmit: s.runtimeOperations
            .filter((x) => x.request?.actionId)
            .every((x) =>
              ["task.accept", "definition.submit"].includes(
                String(x.request?.actionId),
              ),
            ),
          oneSubmit:
            s.runtimeOperations.filter(
              (x) => x.request?.actionId === "definition.submit",
            ).length === 1,
          noExecution: s.runtimeExecutions.length === 0,
        };
        o.checks = checks;
        o.result = "SUBMITTED";
        expect(
          Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k),
        ).toEqual([]);
      },
      { continueOnFailure: true },
    );
    await step(
      "action-forms",
      "every action the projection lists resolves its payload schema by the product's rule (OD-425 R1: its own negotiated capability document, or exactly one entry of its root definitions) and builds a form; each offered action is prepared through the product entry with the same form and opened in 项目操作; the 13 actions delivery-r3 announced outside their documents are listed",
      async (o) => {
        const s = await snapshot();
        const instance = s.runtimeInstances[0];
        const packageDir = instance.launchDirectories!.packageDir;
        const negotiated = instance.negotiation!.capabilities;
        const view = (await settled()).view;
        const rows: Json[] = [];
        for (const a of view.actions) {
          const row: Json = {
            actionId: a.actionId,
            objectRef: a.objectRef,
            label: a.label,
            capability: `${a.capability.id}@${a.capability.version}`,
            payloadSchemaDigest: a.payloadSchemaDigest,
            enabled: a.enabled,
            disabledCode: a.disabledCode,
            disabledReason: a.disabledReason,
            previouslyRefused: previouslyRefused.has(a.actionId),
          };
          try {
            const capability = negotiated.find(
              (c) => digestOf(c) === digestOf(a.capability),
            );
            if (!capability) throw Error("capability not negotiated");
            const document = JSON.parse(
              readFileSync(
                join(packageDir, "capabilities", capability.id + ".json"),
                "utf8",
              ),
            ) as Json;
            if (digestOf(document) !== capability.schemaDigest)
              throw Error("capability document digest differs");
            const schema = payloadSchemaOf(
              document,
              capability.schemaDigest,
              a.payloadSchemaDigest,
            );
            const definitions = (document.definitions ?? {}) as Json;
            row.resolvedAs =
              schema === document
                ? "document"
                : "definitions/" +
                  Object.keys(definitions).find(
                    (k) => definitions[k] === schema,
                  );
            const form = actionForm(schema);
            row.fields = Object.keys(form.properties);
            row.form = "BUILT";
            row.formDigest = digestOf(form);
          } catch (error) {
            row.form = "REFUSED";
            row.reason = (error as Error).message;
          }
          rows.push(row);
        }
        for (const row of rows.filter((r) => r.enabled)) {
          const a = view.actions.find(
            (x) => x.actionId === row.actionId && x.objectRef === row.objectRef,
          )!;
          const prepared = await page().evaluate(
            ({ projectId, a }) =>
              window.desktop.projectAction({
                type: "prepare",
                projectId,
                actionId: a.actionId,
                objectRef: a.objectRef,
                expectedRevision: a.expectedRevision,
                candidateRef: a.candidateRef,
              }),
            { projectId, a },
          );
          row.product =
            prepared.ok && prepared.prepared
              ? {
                  prepared: true,
                  sameForm: digestOf(prepared.prepared.form) === row.formDigest,
                }
              : {
                  prepared: false,
                  message: prepared.ok ? "" : prepared.message,
                };
          const object = view.objects.find((x) => x.objectRef === a.objectRef);
          const { modal } = await openAction(String(object?.title), a.label);
          await shot(`v10-form-${a.actionId}-light.png`);
          await modal
            .getByRole("button", { name: "关闭", exact: true })
            .click();
        }
        o.actions = rows;
        o.summary = {
          listed: rows.length,
          actionIds: new Set(rows.map((r) => r.actionId)).size,
          built: rows.filter((r) => r.form === "BUILT").length,
          refused: rows
            .filter((r) => r.form !== "BUILT")
            .map((r) => ({ actionId: r.actionId, reason: r.reason })),
          offered: rows.filter((r) => r.enabled).map((r) => r.actionId),
          previouslyRefused: rows
            .filter((r) => r.previouslyRefused)
            .map((r) => ({
              actionId: r.actionId,
              resolvedAs: r.resolvedAs,
              form: r.form,
            })),
        };
        expect(new Set(rows.map((r) => r.actionId)).size).toBe(20);
        expect(rows.filter((r) => r.form !== "BUILT")).toEqual([]);
        expect(
          rows.filter((r) => r.enabled && !(r.product as Json)?.sameForm),
        ).toEqual([]);
        expect(
          rows
            .filter((r) => r.previouslyRefused)
            .map((r) => r.actionId)
            .sort(),
        ).toEqual([...previouslyRefused].sort());
      },
      { continueOnFailure: true },
    );
    await step(
      "run-records",
      "运行记录 shows no execution and no Runtime trace for this project (the acceptance and the refusal are operations of the 项目操作 record, not executions)",
      async (o) => {
        await client.openProject("V-10 切片仓克隆");
        await goTo(page(), "运行记录");
        await expect(
          page().getByRole("heading", { name: "运行记录", exact: true }),
        ).toBeVisible();
        o.empty = await page()
          .getByRole("heading", { name: "还没有运行记录", exact: true })
          .count();
        o.text = (await page().locator(".page").first().textContent())?.slice(
          0,
          600,
        );
        o.executions = (await snapshot()).runtimeExecutions.length;
        await shot("v10-run-records-light.png");
        expect(o.executions).toBe(0);
      },
    );
    await step(
      "write-boundary",
      "the Runtime's writes stay inside the run's disposable root: every worktree of the working copy is inside it, the Runtime process holds no network socket and no file open for writing outside it, the prepared clone is unchanged, and no execution or model call was requested",
      async (o) => {
        const pid = (await snapshot()).runtimeInstances[0].pid!;
        const lsof = execFileSync(
          "/usr/sbin/lsof",
          ["-n", "-P", "-a", "-p", String(pid), "-F", "fatn"],
          { encoding: "utf8" },
        );
        const files: {
          fd: string;
          access: string;
          type: string;
          name: string;
        }[] = [];
        let current: Record<string, string> = {};
        for (const line of lsof.split("\n")) {
          const [tag, value] = [line[0], line.slice(1)];
          if (tag === "f") {
            if (current.f) files.push(current as never);
            current = { f: value };
          } else if (tag === "a") current.a = value;
          else if (tag === "t") current.t = value;
          else if (tag === "n") current.n = value;
        }
        if (current.f) files.push(current as never);
        const open = files.map((f) => {
          const r = f as unknown as Record<string, string>;
          return {
            fd: r.f,
            access: r.a ?? "",
            type: r.t ?? "",
            name: r.n ?? "",
          };
        });
        const sockets = open.filter((f) =>
          ["IPv4", "IPv6", "TCP", "UDP"].includes(f.type),
        );
        const writableOutside = open.filter(
          (f) =>
            (f.access === "w" || f.access === "u") &&
            f.type === "REG" &&
            !f.name.startsWith(root + sep),
        );
        const methods = new Set<string>();
        for (const file of readdirSync(join(evidenceDir, "transcripts")))
          for (const line of readFileSync(
            join(evidenceDir, "transcripts", file),
            "utf8",
          )
            .trim()
            .split("\n")) {
            const value = (JSON.parse(line) as { value: Json }).value;
            if (typeof value?.method === "string") methods.add(value.method);
          }
        o.process = {
          pid,
          openFiles: open.length,
          sockets,
          writableOutside,
          cwd: open.find((f) => f.fd === "cwd")?.name,
        };
        o.worktrees = worktrees().map((w) => w.worktree);
        o.preparedRefs = refs(prepared);
        o.preparedStatus = gitIn(prepared)(
          "status",
          "--porcelain",
          "--untracked-files=all",
        );
        o.methods = [...methods].sort();
        o.executions = (await snapshot()).runtimeExecutions.length;
        expect(sockets).toEqual([]);
        expect(writableOutside).toEqual([]);
        expect(
          (o.worktrees as string[]).every(
            (w) => w === repo || w.startsWith(worktreeRoot + sep),
          ),
        ).toBe(true);
        expect(o.preparedRefs).toEqual([`${expectedHead} refs/heads/main`]);
        expect(o.preparedStatus).toBe("");
        expect(
          [...methods].filter((m) => m.startsWith("host.execution.")),
        ).toEqual([]);
        expect(o.executions).toBe(0);
      },
    );
    await step(
      "quit",
      "quitting the client shuts the Runtime down and the process is gone",
      async (o) => {
        const pid = (await snapshot()).runtimeInstances[0].pid!;
        await client.close();
        try {
          process.kill(pid, 0);
          o.pidGone = false;
        } catch {
          o.pidGone = true;
        }
        expect(o.pidGone).toBe(true);
      },
    );
  } finally {
    finish();
    await client.close();
  }
  // A step recorded as failed while the run went on still fails the entry.
  expect(steps.filter((s) => s.result === "FAIL").map((s) => s.id)).toEqual([]);
});
