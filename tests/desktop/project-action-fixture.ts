import { expect } from "@playwright/test";
import { goTo } from "./shell";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { launchLocal, closeLocal } from "./local-client";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import {
  JOURNEY_CAPABILITY,
  JOURNEY_SCHEMA,
} from "./runtime-fakes/journey-contract";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { ProjectActionRequest } from "../../src/shared/project-actions";
declare global {
  var runtimeHost: RuntimeHost;
}
export async function journeyFixture(options: { reader?: boolean } = {}) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-actions-")),
    data = join(root, "data"),
    folder = join(root, "folder");
  mkdirSync(folder);
  mkdirSync(data);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  try {
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, folder);
    const projectId = await page.evaluate(async () => {
      const folder = await window.desktop.pickProjectFolder();
      if (!folder.ok) throw Error(folder.message);
      const r = await window.desktop.createProject({
        token: folder.token,
        name: "合成任务旅程",
        goal: "验证每次操作所依据的候选与权限",
      });
      if (!r.ok || !r.projectId) throw Error(JSON.stringify(r));
      return r.projectId;
    });
    const fake = resolve("tests/desktop/runtime-fakes");
    const bundle = buildBundle(join(root, "bundle"), newPublisher(), {
      runtimeId: "runtime:test-journey",
      version: "1",
      entrypoint: options.reader ? "reader_fake.py" : "journey_fake.py",
      entrypointBytes: readFileSync(
        join(fake, options.reader ? "reader_fake.py" : "journey_fake.py"),
      ),
      launcher: "python3",
      argv: ["${instanceDir}", "${contractDigest}"],
      dataFormat: "test.g1",
      capabilities: [
        { capability: JOURNEY_CAPABILITY, schema: JOURNEY_SCHEMA },
      ],
      extraMembers: [
        "graph_fake.py",
        "fake_framing.py",
        ...(options.reader ? ["journey_fake.py"] : []),
      ].map((name) => ({
        name,
        data: readFileSync(join(fake, name)),
      })),
    });
    const target = await app.evaluate(
      async (_, { bundle, folder }) => {
        const host = globalThis.runtimeHost;
        const imported = await host.supervisor.importBundle(
          bundle,
          "synthetic-journey",
        );
        if (!imported.ok) throw Error(JSON.stringify(imported));
        const instanceId = host.records()!.runtimeInstances[0].instanceId,
          resource = await host.registerResource(folder),
          scope = await host.openScope(instanceId, resource.handle);
        const grant = await host.grant(
          instanceId,
          scope.scopeRef,
          "csthink.test.journey",
          "graph.read",
          "local synthetic journey",
        );
        await host.authorize(instanceId, scope.scopeRef);
        await host.sync(instanceId, scope.scopeRef);
        await host.awaitCurrent(instanceId, scope.scopeRef);
        return {
          instanceId,
          scopeRef: scope.scopeRef,
          grantId: grant.ref.id,
          runtimeRoot: host.supervisor.runtimeRoot,
        };
      },
      { bundle: bundle.dir, folder },
    );
    const bound = await page.evaluate(
      ({ projectId, target }) =>
        window.desktop.projectWork({
          type: "bind",
          projectId,
          instanceId: target.instanceId,
          scopeRef: target.scopeRef,
          revision: 0,
        }),
      { projectId, target },
    );
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    await goTo(page, "项目");
    await page
      .locator(".project-open")
      .filter({ hasText: "合成任务旅程" })
      .click();
    await page.getByRole("button", { name: "打开右栏", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "合成编码任务", exact: true })
      .click();
    // A reply is not a projection boundary. Read the synthetic Runtime's persisted version,
    // then wait for both the Host's complete object/action projection and the visible object.
    // This never retries prepare or invoke; expired confirmations remain explicit refusals.
    async function waitForPublishedProjection() {
      const state = JSON.parse(
        readFileSync(
          join(
            target.runtimeRoot,
            "instances",
            target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
            "graph-runtime",
            "state.json",
          ),
          "utf8",
        ),
      ) as { revision: number };
      const revision = `rev:${state.revision}`;
      await expect
        .poll(async () => {
          const reply = await page.evaluate(
            (projectId) =>
              window.desktop.projectWork({ type: "read", projectId }),
            projectId,
          );
          const projection = reply.ok && reply.view?.projection;
          return (
            !!projection &&
            projection.objects.length > 0 &&
            projection.actions.length > 0 &&
            projection.objects.every(
              (object) => object.revision === revision,
            ) &&
            projection.actions.every(
              (action) => action.expectedRevision === revision,
            )
          );
        })
        .toBe(true);
      await expect(
        page.locator(".project-center-content > .project-source"),
      ).toHaveText(`版本 ${revision}`);
    }
    return {
      app,
      page,
      root,
      data,
      folder,
      projectId,
      target,
      waitForPublishedProjection,
      request: (c: ProjectActionRequest) =>
        page.evaluate((c) => window.desktop.projectAction(c), c),
      prepare: async (actionId: string) =>
        page.evaluate(
          async ({ projectId, actionId }) => {
            const view = await window.desktop.projectWork({
              type: "read",
              projectId,
            });
            if (!view.ok || !view.view?.projection)
              throw Error(JSON.stringify(view));
            const a = view.view.projection.actions.find(
              (a) => a.actionId === actionId,
            )!;
            return window.desktop.projectAction({
              type: "prepare",
              projectId,
              actionId,
              objectRef: a.objectRef,
              expectedRevision: a.expectedRevision,
              candidateRef: a.candidateRef,
            });
          },
          { projectId, actionId },
        ),
    };
  } catch (e) {
    await closeLocal(app);
    throw e;
  }
}
