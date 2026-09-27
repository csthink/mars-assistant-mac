/**
 * J-03 receiving entry (feature-t31 S-06, OD-414): receives a real Runtime development
 * bundle through the product in the background isolated client, on a fresh data root
 * under .test-data/disposable and a synthetic Git repository. It never calls a model,
 * never uses a personal data root and never binds any repository but the synthetic one.
 *
 * Inputs are explicit and never defaulted; a missing one fails the run with its name:
 *   CSTHINK_J03_BUNDLE_DIR    absolute import directory holding exactly bundle.tar,
 *                             release.json, release.sig and publisher.pub
 *   CSTHINK_J03_EVIDENCE_DIR  absolute, new or empty evidence directory
 *   CSTHINK_J03_EXPECTED_PUBLISHER_KEY_DIGEST (optional) SPKI SHA-256 the provider gave
 *                             out of band; the pinned key must equal it (KB-278 item 7)
 *   CSTHINK_J03_DELIVERY_RECORD (optional) absolute path of the provider's delivery record
 *                             (hp-bundle-delivery/v1); the installed, offered and negotiated
 *                             capabilities must equal its list (id, version, schemaDigest, required)
 *
 * Steps: import and first publisher pin; supervisor launch and the Initialize digests,
 * identities and negotiation from the protocol transcript; degraded health without a
 * binding file; 接入信息 shown and copied; the project's 仓库治理接入 entry (OD-416)
 * registers the folder, is refused to open the scope before the binding exists, and
 * shows the handle and instance directory; the bundle's own CLI writes the binding from
 * the copied values (as the person on the receiving machine would, OD-412); 重新连接 in
 * 待核实 (KB-285) makes the instance ready (with a delivery record, the installed and
 * negotiated capabilities equal its list; the unbound first launch negotiates none); the
 * entry opens the scope for the bound handle and is refused for another folder; the
 * reviewed authorization is cancelled,
 * then granted, and the project linked to a current projection; 访问权限 revokes it after
 * confirmation and a new review re-authorizes; a killed process shows 连接异常 and
 * 重新连接 recovers; an identical re-import answers with the recorded installation.
 * Task acceptance and refusal need the J-07 slice repository and belong to V-10, so
 * they are not attempted here.
 */
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { closeLocal } from "./local-client";
import {
  deliveryInputs,
  probeRecord,
  ProbeClient,
  requireAbsolute,
  type Json,
} from "./real-probe";

const bundleDir = process.env.CSTHINK_J03_BUNDLE_DIR ?? "";
const evidenceDir = process.env.CSTHINK_J03_EVIDENCE_DIR ?? "";
const expectedKey = process.env.CSTHINK_J03_EXPECTED_PUBLISHER_KEY_DIGEST ?? "";
const deliveryRecord = process.env.CSTHINK_J03_DELIVERY_RECORD ?? "";
/** The capability identity the delivery, the installation and the negotiation each state. */
const capabilityIdentity = (list: unknown) =>
  (list as Json[])
    .map((c) => ({
      id: c.id,
      version: c.version,
      schemaDigest: c.schemaDigest,
      required: c.required,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

test.setTimeout(600_000);
// Traces would copy the bundle bytes and every frame; the protocol transcript is the record.
test.use({ trace: "off" });

test("J-03 receive: a real Runtime development bundle is imported, pinned, launched, bound to a synthetic repository, authorised, disconnected and recovered through the product", async () => {
  requireAbsolute("J-03 receiving entry", [
    ["CSTHINK_J03_BUNDLE_DIR", bundleDir],
    ["CSTHINK_J03_EVIDENCE_DIR", evidenceDir],
    ...(deliveryRecord
      ? [["CSTHINK_J03_DELIVERY_RECORD", deliveryRecord] as [string, string]]
      : []),
  ]);
  const { step, finish } = probeRecord(
    evidenceDir,
    "feature-t31-j03-receive/v1",
  );

  // Disposable roots: business data, a synthetic Git repository and a second plain directory.
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/j03-"));
  const data = join(root, "data");
  const repo = join(root, "synthetic-repo");
  const other = join(root, "other-folder");
  for (const dir of [data, repo, other]) mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", repo, ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
    });
  const client = new ProbeClient(data, join(evidenceDir, "transcripts"));
  let app: ElectronApplication | undefined;
  let page!: Page;
  const snapshot = () => client.snapshot();
  const openExtensions = () => client.openExtensions();
  const openProject = (name: string) => client.openProject(name);
  const pickDirectory = (path: string) => client.pickDirectory(path);
  const clipboard = () => client.clipboard();
  const requestAndReply = (incarnationId: string, method: string) =>
    client.requestAndReply(incarnationId, method);
  try {
    let inputs: Record<string, { bytes: number; sha256: string }> = {};
    let publisherKeyDigest = "";
    await step(
      "inputs",
      "the import directory holds exactly the four delivery files; digests recorded; the publisher key digest is computed from publisher.pub",
      (o) => {
        const delivery = deliveryInputs(bundleDir);
        o.names = delivery.names;
        o.files = inputs = delivery.files;
        publisherKeyDigest = delivery.publisherKeyDigest;
        o.publisherKeyDigest = publisherKeyDigest;
        o.expectedPublisherKeyDigest = expectedKey || null;
        if (expectedKey) expect(publisherKeyDigest).toBe(expectedKey);
      },
    );
    await step(
      "setup",
      "a fresh data root and a synthetic Git repository with one commit exist under .test-data/disposable",
      (o) => {
        git("init", "-q", "-b", "main");
        writeFileSync(join(repo, "README.md"), "synthetic J-03 repository\n");
        git("add", "README.md");
        git(
          "-c",
          "user.name=J-03 probe",
          "-c",
          "user.email=j03-probe@invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-q",
          "-m",
          "synthetic",
        );
        o.repositoryHead = git("rev-parse", "HEAD").trim();
        o.relativeRoot = root.slice(resolve(".").length + 1);
      },
    );
    await client.launch();
    app = client.app;
    page = client.page;
    let projectId = "";
    await step(
      "project",
      "two projects are created through the folder picker and project creation entry: the synthetic repository and a second plain folder",
      async (o) => {
        const create = (folder: string, name: string) =>
          client.createProject(folder, name, "接收 Runtime 开发包");
        projectId = await create(repo, "J-03 合成仓");
        o.projectId = projectId;
        o.otherProjectId = await create(other, "J-03 另一目录");
      },
    );
    const section = await openExtensions();
    // Re-resolved on every use: a locator stays bound to the page it came from, and the client is relaunched.
    const card = () =>
      page.getByRole("article", { name: "harness-plane 扩展", exact: true });
    await step(
      "import",
      "设置 → 扩展管理 → 从本地导入运行包 admits the bundle, states the first-use publisher pin, records the installation with the delivered digests and no incompatibility",
      async (o) => {
        await pickDirectory(bundleDir);
        await section
          .getByRole("button", { name: "从本地导入运行包…" })
          .click();
        await expect(page.getByTestId("import-result")).toHaveText(
          "已导入并开始可用性检查。",
          { timeout: 120_000 },
        );
        o.importResult = await page.getByTestId("import-result").textContent();
        o.pinNotice = await page.getByTestId("import-pin").textContent();
        expect(o.pinNotice).toContain(publisherKeyDigest.slice(0, 12));
        const s = await snapshot();
        expect(s.runtimeInstallations).toHaveLength(1);
        const i = s.runtimeInstallations[0];
        o.installation = {
          runtimeId: i.runtimeId,
          version: i.version,
          publisherId: i.publisherId,
          publicKeyDigest: i.publicKeyDigest,
          artifactDigest: i.artifactDigest,
          releaseRecordDigest: i.releaseRecordDigest,
          manifestDigest: i.manifestDigest,
          permissionProfileDigest: i.permissionProfileDigest,
          platform: i.platform,
          minimumOs: i.minimumOs,
          dataFormat: i.dataFormat,
          protocols: i.protocols,
          capabilities: i.capabilities,
          launcher: i.launcher,
          entrypoint: i.entrypoint,
          argv: i.argv,
          checkedFiles: i.checkedFiles,
          expandedBytes: i.expandedBytes,
          incompatibility: i.incompatibility,
        };
        expect(i.artifactDigest).toBe(inputs["bundle.tar"].sha256);
        expect(i.releaseRecordDigest).toBe(inputs["release.json"].sha256);
        expect(i.publicKeyDigest).toBe(publisherKeyDigest);
        expect(i.incompatibility).toBeNull();
      },
    );
    let first = (await snapshot()).runtimeInstances[0];
    await step(
      "launch-degraded",
      "the supervisor starts the bundle; negotiation completes; without a binding file health is degraded with 'no instance binding file' and the card shows 待核实",
      async (o) => {
        await expect(card().getByTestId("extension-state")).toHaveText(
          "待核实",
          {
            timeout: 60_000,
          },
        );
        await expect(card().getByTestId("extension-health")).toContainText(
          "no instance binding file",
        );
        first = (await snapshot()).runtimeInstances[0];
        o.instance = {
          instanceId: first.instanceId,
          state: first.state,
          incarnationId: first.incarnationId,
          connectionId: first.connectionId,
          controlGeneration: first.controlGeneration,
          pid: first.pid,
          launchArgv: first.launchArgv,
          launchDirectories: first.launchDirectories,
          negotiation: first.negotiation,
          health: first.health,
        };
        expect(first.state).toBe("ready");
        expect(first.health?.result).toBe("degraded");
      },
    );
    const installation = (await snapshot()).runtimeInstallations[0];
    await step(
      "initialize",
      "runtime.initialize carries the installed bundleDigest and permissionProfileDigest; Initialized repeats the offered identities and protocol; ready and health follow",
      (o) => {
        const { request, reply } = requestAndReply(
          first.incarnationId!,
          "runtime.initialize",
        );
        const params = request.params as Json;
        const authorization = params.launchAuthorization as Json;
        const answer = (reply?.result ?? null) as Json | null;
        o.request = {
          bundleDigest: params.bundleDigest,
          launchAuthorization: {
            bundleDigest: authorization.bundleDigest,
            permissionProfileDigest: authorization.permissionProfileDigest,
          },
          identities: {
            installationId: params.installationId,
            instanceId: params.instanceId,
            incarnationId: params.incarnationId,
            connectionId: params.connectionId,
          },
          protocols: params.protocols,
          capabilities: (params.capabilities as Json[]).map((c) => c.id),
        };
        o.result = answer && {
          context: answer.context,
          selectedProtocol: answer.selectedProtocol,
          capabilities: (answer.capabilities as Json[]).map((c) => c.id),
          executionProfiles: answer.executionProfiles,
          recovery: answer.recovery,
        };
        expect(params.bundleDigest).toBe(inputs["bundle.tar"].sha256);
        expect(authorization.bundleDigest).toBe(inputs["bundle.tar"].sha256);
        expect(authorization.permissionProfileDigest).toBe(
          installation.permissionProfileDigest,
        );
        const context = answer!.context as Json;
        expect(context.installationId).toBe(installation.installationId);
        expect(context.instanceId).toBe(first.instanceId);
        expect(context.incarnationId).toBe(first.incarnationId);
        expect(context.connectionId).toBe(first.connectionId);
        o.ready = requestAndReply(first.incarnationId!, "runtime.ready").reply;
        o.health = requestAndReply(
          first.incarnationId!,
          "runtime.health",
        ).reply;
      },
    );
    let instanceDir = "";
    let packageDir = "";
    await step(
      "access-display",
      "接入信息 shows the recorded instance directory, package directory and pinned publisher key; each copy puts exactly that record on the clipboard",
      async (o) => {
        const access = card().getByTestId("extension-access");
        await access.locator("summary").click();
        const copies: Json = {};
        for (const [label, testId] of [
          ["实例目录", "fact-instance-dir"],
          ["包目录", "fact-package-dir"],
          ["发布者公钥摘要", "fact-publisher-key"],
        ]) {
          const shown = await access
            .getByTestId(testId + "-value")
            .textContent();
          await access.getByRole("button", { name: "复制" + label }).click();
          copies[label] = { shown, copied: await clipboard() };
          expect(copies[label]).toEqual({ shown, copied: shown });
        }
        o.copies = copies;
        instanceDir = (copies["实例目录"] as Json).copied as string;
        packageDir = (copies["包目录"] as Json).copied as string;
        expect(instanceDir).toBe(first.launchDirectories!.instanceDir);
        expect(packageDir).toBe(first.launchDirectories!.packageDir);
        expect((copies["发布者公钥摘要"] as Json).copied).toBe(
          publisherKeyDigest,
        );
        // The import notice leaves on its own; closing it keeps the card footer visible for review.
        const flash = page.getByTestId("import-flash");
        if (await flash.count())
          await flash.getByRole("button", { name: "关闭提示" }).click();
        await app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1180, 1500),
        );
        await access.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.screenshot({
          path: join(evidenceDir, "access-degraded-light.png"),
        });
      },
    );
    let handle = "";
    let otherHandle = "";
    await step(
      "register",
      "项目详情 → 仓库治理接入 → 登记项目文件夹 registers the synthetic repository (identity only, nothing read or written) and shows the resource handle, copied from the record",
      async (o) => {
        const panel = await openProject("J-03 合成仓");
        await expect(panel.getByTestId("access-summary")).toHaveText("未接入");
        const refsBefore = git("for-each-ref", "--format=%(refname)").trim();
        await panel.getByRole("button", { name: "登记项目文件夹" }).click();
        const value = panel.getByTestId("project-resource-handle-value");
        await expect(value).toHaveText(/^resource:[0-9a-f]{32}$/);
        handle = (await value.textContent())!;
        await panel
          .getByTestId("project-resource-handle")
          .getByRole("button", { name: "复制 Runtime 资源句柄" })
          .click();
        o.copied = await clipboard();
        expect(o.copied).toBe(handle);
        o.handle = handle;
        o.grants = (await snapshot()).runtimeGrants.length;
        expect(o.grants).toBe(0);
        o.repositoryRefsUnchanged =
          git("for-each-ref", "--format=%(refname)").trim() === refsBefore;
        expect(o.repositoryRefsUnchanged).toBe(true);
        await page.screenshot({
          path: join(evidenceDir, "project-access-registered-light.png"),
        });
      },
    );
    await step(
      "scope-before-binding",
      "打开项目范围 before the binding file exists: the Runtime refuses (PERMISSION_DENIED, no instance binding file), no scope is recorded, the step shows the instance directory to write the binding with",
      async (o) => {
        const panel = page.getByRole("region", {
          name: "仓库治理接入",
          exact: true,
        });
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        const alert = panel.getByRole("alert");
        await expect(alert).toContainText(
          "扩展未打开项目范围（PERMISSION_DENIED：no instance binding file",
        );
        o.message = await alert.textContent();
        o.scopes = (await snapshot()).runtimeScopes.length;
        expect(o.scopes).toBe(0);
        await expect(panel.getByTestId("access-instance-dir-value")).toHaveText(
          first.launchDirectories!.instanceDir,
        );
        await panel
          .getByTestId("access-instance-dir")
          .getByRole("button", { name: "复制实例目录" })
          .click();
        o.copiedInstanceDir = await clipboard();
        expect(o.copiedInstanceDir).toBe(instanceDir);
        await alert.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(evidenceDir, "project-access-refused-light.png"),
        });
      },
    );
    await step(
      "binding-write",
      "the person on the receiving machine (here the probe) runs the bundle's own CLI with the instance directory and resource handle copied from the project entry and the package directory copied from 接入信息; show reads it back; the file is 0600; Assistant writes no binding",
      (o) => {
        const program = join(packageDir, installation.entrypoint);
        const env = { PATH: "/usr/bin:/bin" };
        const write = execFileSync(
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
            repo,
            "--resource-handle",
            handle,
            "--authority-ref",
            "assistant:feature-t31:s06-r8:j03-probe",
          ],
          { env, encoding: "utf8" },
        );
        // The CLI answers with a JSON envelope: result, file digest and the binding document.
        o.write = JSON.parse(write) as Json;
        const shown = execFileSync(
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
        );
        const read = JSON.parse(shown) as Json;
        o.show = read;
        const binding = read.binding as Json;
        expect((o.write as Json).result).toBe("BINDING_WRITTEN");
        expect(read.result).toBe("BINDING_READ");
        expect(read.sha256).toBe((o.write as Json).sha256);
        expect(binding.repository).toBe(repo);
        const file = readdirSync(instanceDir).find((n) =>
          n.endsWith("binding.json"),
        );
        expect(file).toBeTruthy();
        o.file = file;
        o.mode = (statSync(join(instanceDir, file!)).mode & 0o777).toString(8);
        expect(o.mode).toBe("600");
        expect(binding.resourceHandles).toEqual([handle]);
      },
    );
    let second = first;
    await step(
      "reconnect-ready",
      "设置 → 扩展管理: the card is 待核实 and offers 重新连接 (KB-285); after it the new incarnation reads the binding, health is ready and the card states the real result 可用",
      async (o) => {
        await openExtensions();
        await expect(card().getByTestId("extension-state")).toHaveText(
          "待核实",
        );
        await card().getByRole("button", { name: "重新连接" }).click();
        await expect(card().getByTestId("reconnect-result")).toHaveText(
          "已建立新的连接，当前状态：可用。",
          { timeout: 60_000 },
        );
        await expect(card().getByTestId("extension-state")).toHaveText("可用");
        second = (await snapshot()).runtimeInstances[0];
        o.instance = {
          instanceId: second.instanceId,
          incarnationId: second.incarnationId,
          connectionId: second.connectionId,
          controlGeneration: second.controlGeneration,
          health: second.health,
          negotiatedCapabilities: second.negotiation?.capabilities.map(
            (c) => c.id,
          ),
        };
        o.firstPidGone = (() => {
          try {
            process.kill(first.pid!, 0);
            return false;
          } catch {
            return true;
          }
        })();
        expect(second.instanceId).toBe(first.instanceId);
        expect(second.incarnationId).not.toBe(first.incarnationId);
        expect(second.health?.result).toBe("ok");
        expect(o.firstPidGone).toBe(true);
        const init = requestAndReply(
          second.incarnationId!,
          "runtime.initialize",
        );
        o.initializeBundleDigest = (init.request.params as Json).bundleDigest;
        expect(o.initializeBundleDigest).toBe(inputs["bundle.tar"].sha256);
        await page.screenshot({
          path: join(evidenceDir, "reconnected-light.png"),
        });
      },
    );
    if (deliveryRecord)
      await step(
        "delivery-capabilities",
        "the capabilities the installation records, and the bound incarnation's runtime.initialize offers, Initialized answers and the Host negotiated, each equal the delivery record's list (id, version, schemaDigest, required); the unbound first launch's answer is recorded",
        (o) => {
          const raw = readFileSync(deliveryRecord);
          const delivery = JSON.parse(raw.toString("utf8")) as Json;
          const bound = requestAndReply(
            second.incarnationId!,
            "runtime.initialize",
          );
          const unbound = requestAndReply(
            first.incarnationId!,
            "runtime.initialize",
          );
          const expected = capabilityIdentity(delivery.capabilities);
          o.deliveryRecord = {
            schema: delivery.schema,
            version: delivery.version,
            bytes: raw.length,
            sha256: createHash("sha256").update(raw).digest("hex"),
          };
          o.expected = expected;
          o.unboundFirstLaunch = {
            offered: capabilityIdentity(
              (unbound.request.params as Json).capabilities,
            ).length,
            answered: capabilityIdentity(
              ((unbound.reply?.result ?? {}) as Json).capabilities,
            ).length,
          };
          const observed = {
            installed: capabilityIdentity(installation.capabilities),
            offered: capabilityIdentity(
              (bound.request.params as Json).capabilities,
            ),
            answered: capabilityIdentity(
              ((bound.reply?.result ?? {}) as Json).capabilities,
            ),
            negotiated: capabilityIdentity(second.negotiation?.capabilities),
          };
          o.observed = observed;
          expect(delivery.schema).toBe("hp-bundle-delivery/v1");
          expect(delivery.version).toBe(installation.version);
          expect(expected).toHaveLength(7);
          for (const list of Object.values(observed))
            expect(list).toEqual(expected);
        },
      );
    let scopeRef = "";
    await step(
      "scope-open",
      "打开项目范围 now opens an inactive scope for the bound handle; the second project's folder, registered through its own entry, is refused by the Runtime (PERMISSION_DENIED, not bound)",
      async (o) => {
        let panel = await openProject("J-03 合成仓");
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        await expect(panel.getByTestId("access-scope")).toContainText(
          "尚未授权",
        );
        const scope = (await snapshot()).runtimeScopes[0];
        scopeRef = scope.scopeRef;
        o.accepted = {
          scopeRef: scope.scopeRef,
          bindingRef: scope.bindingRef,
          state: scope.state,
          resourceHandle: scope.resourceHandle,
        };
        expect(scope.state).toBe("inactive");
        expect(scope.resourceHandle).toBe(handle);
        panel = await openProject("J-03 另一目录");
        await panel.getByRole("button", { name: "登记项目文件夹" }).click();
        const value = panel.getByTestId("project-resource-handle-value");
        await expect(value).toHaveText(/^resource:/);
        otherHandle = (await value.textContent())!;
        await panel.getByRole("button", { name: "打开项目范围" }).click();
        await expect(panel.getByRole("alert")).toContainText(
          "扩展未打开项目范围（PERMISSION_DENIED：resource handle is not bound to this instance by its binding file）",
        );
        o.refused = {
          handle: otherHandle,
          message: await panel.getByRole("alert").textContent(),
          scopes: (await snapshot()).runtimeScopes.length,
        };
        expect((o.refused as Json).scopes).toBe(1);
      },
    );
    await step(
      "authorize-projection",
      "核对并授权…: the review lists subject, objects, the 7 negotiated capabilities, 8 operations and 30 days; cancel grants nothing; 确认授权 grants 56 in one batch, the Runtime accepts them (active through host.grants.get); 关联 links the project and the projection syncs to current",
      async (o) => {
        const panel = await openProject("J-03 合成仓");
        await panel.getByRole("button", { name: "核对并授权…" }).click();
        const review = page.getByRole("dialog", { name: "核对扩展授权" });
        await expect(review).toContainText("harness-plane 0.1.0-dev");
        await expect(review).toContainText(repo);
        await expect(review).toContainText(handle);
        await expect(review).toContainText("协商通过的 7 项能力");
        await expect(review).toContainText("共 56 项授权");
        o.review = await review.textContent();
        await page.screenshot({
          path: join(evidenceDir, "project-access-review-light.png"),
        });
        await review.getByRole("button", { name: "取消", exact: true }).click();
        expect((await snapshot()).runtimeGrants).toHaveLength(0);
        await panel.getByRole("button", { name: "核对并授权…" }).click();
        await review.getByRole("button", { name: "确认授权" }).click();
        await expect(panel.getByTestId("access-grants")).toContainText(
          "已授权 56 项",
          { timeout: 30_000 },
        );
        const s = await snapshot();
        const grants = s.runtimeGrants.filter((g) => g.status === "active");
        o.grants = {
          count: grants.length,
          authorizations: new Set(grants.map((g) => g.authorizationId)).size,
          capabilities: [...new Set(grants.map((g) => g.capability))],
          operations: [...new Set(grants.map((g) => g.operation))],
          expiresAt: grants[0]?.expiresAt,
          purpose: grants[0]?.purpose,
        };
        expect(grants).toHaveLength(56);
        expect(s.runtimeScopes[0].state).toBe("active");
        // As the person sees it: linking waits until the projection is current (S-02 refuses a syncing scope).
        await expect(panel).not.toContainText("项目数据正在同步", {
          timeout: 30_000,
        });
        await expect
          .poll(async () => (await snapshot()).runtimeScopes[0].freshness, {
            timeout: 30_000,
          })
          .toBe("current");
        await page
          .getByRole("combobox", { name: "关联项目内容", exact: true })
          .selectOption(`${second.instanceId}|${scopeRef}`);
        await page.getByRole("button", { name: "关联", exact: true }).click();
        await expect(panel.getByTestId("access-summary")).toHaveText("已接入", {
          timeout: 30_000,
        });
        await expect(
          page.getByRole("navigation", { name: "Runtime 内容" }),
        ).toContainText("Task acceptance");
        const outcome = await app!.evaluate(
          async (_, { instanceId, scopeRef }) => {
            const host = globalThis.runtimeHost;
            await host.awaitCurrent(instanceId, scopeRef);
            const projection = await host.projection(instanceId, scopeRef);
            return {
              freshness: host.scope(instanceId, scopeRef)?.freshness ?? null,
              cursor: host.scope(instanceId, scopeRef)?.cursor ?? null,
              objects: projection?.objects.map((x) => ({
                objectRef: x.objectRef,
                title: x.title,
                stateLabel: x.stateLabel,
                kind: x.view.kind,
              })),
              actions: projection?.actions.map((a) => ({
                actionId: a.actionId,
                objectRef: a.objectRef,
                enabled: a.enabled,
              })),
              pending: projection?.pendingItems?.length ?? null,
            };
          },
          { instanceId: second.instanceId, scopeRef },
        );
        o.outcome = outcome;
        expect(outcome.freshness).toBe("current");
        const authorized = requestAndReply(
          second.incarnationId!,
          "runtime.scope.authorize",
        );
        o.authorizeReply = authorized.reply?.result ?? authorized.reply;
        o.repositoryRefs = git(
          "for-each-ref",
          "--format=%(refname)",
          "refs/harness",
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(evidenceDir, "project-access-connected-light.png"),
        });
      },
    );
    await step(
      "revoke-reauthorize",
      "设置 → 访问权限 lists the 56 grants as one authorization; 撤销 asks first, cancel keeps it, 确认撤销 revokes all and the Runtime scope becomes inactive; a new review in the project re-authorizes with new references and the Runtime accepts them",
      async (o) => {
        const panel = page.getByRole("region", {
          name: "仓库治理接入",
          exact: true,
        });
        await panel
          .getByRole("button", { name: "在访问权限中查看或撤销" })
          .click();
        const entry = page
          .getByRole("region", { name: "扩展授权" })
          .getByTestId("extension-grant")
          .first();
        await expect(entry.getByTestId("grant-operations")).toContainText(
          "（共 56 项）",
        );
        await entry.getByRole("button", { name: /^撤销 / }).click();
        const dialog = page.getByRole("dialog", { name: "撤销扩展授权" });
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(entry.getByTestId("grant-status")).toHaveText("有效");
        await entry.getByRole("button", { name: /^撤销 / }).click();
        await page.screenshot({
          path: join(evidenceDir, "access-revoke-light.png"),
        });
        await dialog.getByRole("button", { name: "确认撤销" }).click();
        await expect(dialog).toHaveCount(0);
        await expect
          .poll(async () => (await snapshot()).runtimeScopes[0].state)
          .toBe("inactive");
        const s = await snapshot();
        const old = s.runtimeGrants.map((g) => g.ref.id);
        o.revoked = {
          revoked: s.runtimeGrants.filter((g) => g.status === "revoked").length,
          scopeState: s.runtimeScopes[0].state,
          scopeGrantRefs: s.runtimeScopes[0].grantRefs.length,
        };
        expect((o.revoked as Json).revoked).toBe(56);
        const again = await openProject("J-03 合成仓");
        await expect(again.getByTestId("access-summary")).toHaveText(
          "接入未完成",
        );
        o.revokedState = await again
          .getByTestId("access-grant-state")
          .textContent();
        expect(o.revokedState).toMatch(
          /^授权已于 .+ 撤销；重新核对范围后再授权。$/,
        );
        await again.getByRole("button", { name: "核对并授权…" }).click();
        await page
          .getByRole("dialog", { name: "核对扩展授权" })
          .getByRole("button", { name: "确认授权" })
          .click();
        await expect(again.getByTestId("access-summary")).toHaveText("已接入", {
          timeout: 30_000,
        });
        const t = await snapshot();
        const active = t.runtimeGrants.filter((g) => g.status === "active");
        o.reauthorized = {
          active: active.length,
          reusedReferences: active.filter((g) => old.includes(g.ref.id)).length,
          scopeState: t.runtimeScopes[0].state,
        };
        expect(active).toHaveLength(56);
        expect((o.reauthorized as Json).reusedReferences).toBe(0);
        expect(t.runtimeScopes[0].state).toBe("active");
      },
    );
    await step(
      "disconnect-recover",
      "a killed Runtime process shows 连接异常 with the scope stale; 重新连接 starts a new incarnation, the scope resumes current and the card returns to 可用",
      async (o) => {
        await openExtensions();
        const before = (await snapshot()).runtimeInstances[0];
        process.kill(before.pid!, "SIGKILL");
        await expect(card().getByTestId("extension-state")).toHaveText(
          "连接异常",
          {
            timeout: 30_000,
          },
        );
        const lost = await snapshot();
        o.lost = {
          state: lost.runtimeInstances[0].state,
          exit: lost.runtimeInstances[0].exit,
          failure: lost.runtimeInstances[0].failure,
          scopeFreshness: lost.runtimeScopes.find(
            (s) => s.scopeRef === scopeRef,
          )?.freshness,
        };
        await page.screenshot({
          path: join(evidenceDir, "connection-error-light.png"),
        });
        await card().getByRole("button", { name: "重新连接" }).click();
        await expect(card().getByTestId("extension-state")).toHaveText("可用", {
          timeout: 60_000,
        });
        const after = await snapshot();
        const recovered = after.runtimeInstances[0];
        o.recovered = {
          incarnationId: recovered.incarnationId,
          connectionId: recovered.connectionId,
          controlGeneration: recovered.controlGeneration,
          health: recovered.health,
          scopeFreshness: after.runtimeScopes.find(
            (s) => s.scopeRef === scopeRef,
          )?.freshness,
          scopeState: after.runtimeScopes.find((s) => s.scopeRef === scopeRef)
            ?.state,
        };
        expect((o.lost as Json).scopeFreshness).toBe("stale");
        expect(recovered.incarnationId).not.toBe(before.incarnationId);
        expect(recovered.health?.result).toBe("ok");
        expect((o.recovered as Json).scopeFreshness).toBe("current");
        await card().getByTestId("extension-access").locator("summary").click();
        await card()
          .getByTestId("extension-access")
          .evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.screenshot({
          path: join(evidenceDir, "recovered-light.png"),
        });
      },
    );
    await step(
      "reimport-identical",
      "importing the same four files again answers with the recorded installation; no second installation or instance",
      async (o) => {
        await pickDirectory(bundleDir);
        await page
          .getByRole("region", { name: "扩展管理" })
          .getByRole("button", { name: "从本地导入运行包…" })
          .click();
        await expect(page.getByTestId("import-result")).toHaveText(
          "该版本已导入过且内容相同，未新建安装。",
          { timeout: 120_000 },
        );
        const s = await snapshot();
        o.installations = s.runtimeInstallations.length;
        o.instances = s.runtimeInstances.length;
        expect(o.installations).toBe(1);
        expect(o.instances).toBe(1);
      },
    );
    const last = (await snapshot()).runtimeInstances[0];
    await step(
      "quit",
      "quitting the client shuts the Runtime down and the process is gone",
      async (o) => {
        await closeLocal(app!);
        app = undefined;
        try {
          process.kill(last.pid!, 0);
          o.pidGone = false;
        } catch {
          o.pidGone = true;
        }
        expect(o.pidGone).toBe(true);
      },
    );
  } finally {
    finish();
    if (app) await closeLocal(app);
  }
});
