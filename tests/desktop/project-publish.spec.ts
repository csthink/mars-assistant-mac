import { test, expect } from "@playwright/test";
import { goTo } from "./shell";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal } from "./local-client";
import { packageDir } from "../../src/main/runtime-admission";

// All actions belong to the local synthetic Runtime. No repository publication or merge occurs.
test("project publish: authorization refusal, lost Publish reply, merge readback and closure retain separate results", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  async function act(
    label: string,
    options: {
      human?: boolean;
      limit?: number;
      reject?: boolean;
      lost?: boolean;
    } = {},
  ) {
    await f.waitForPublishedProjection();
    await pane.getByRole("button", { name: label, exact: true }).click();
    const dialog = f.page.getByRole("dialog", {
      name: "核对项目操作",
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption(options.reject ? "拒绝" : "继续");
    if (options.limit) {
      await dialog
        .getByRole("checkbox", { name: "填写评审次数额度", exact: true })
        .check();
      await dialog
        .getByRole("spinbutton", { name: "评审次数额度", exact: true })
        .fill(String(options.limit));
    }
    if (options.human) {
      await dialog
        .getByRole("button", { name: "打开依据 1", exact: true })
        .click();
      await expect(dialog.locator("pre")).toContainText("本地合成任务依据");
      await dialog
        .getByRole("checkbox", {
          name: "我已核对本次操作与全部依据",
          exact: true,
        })
        .check();
    }
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(
      dialog.getByText(
        options.lost
          ? "应答未收到，请查询结果"
          : options.reject
            ? "操作失败"
            : "操作已成功",
        { exact: true },
      ),
    ).toBeVisible({ timeout: options.lost ? 20000 : 10000 });
    const list = await f.request({ type: "list", projectId: f.projectId });
    if (!list.ok || !list.operations?.[0]) throw Error(JSON.stringify(list));
    const operation = list.operations[0];
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    return operation;
  }
  try {
    await expect(
      pane.getByRole("button", { name: "关闭任务", exact: true }),
    ).toBeDisabled();
    expect((await f.prepare("task.close")).ok).toBe(false);
    await act("接纳任务", { human: true });
    await act("冻结定义", { human: true });
    await act("开始实施");
    await act("执行验证");
    await act("提交变更评审");
    await act("修复评审问题");
    await act("执行验证");
    await act("调整评审额度", { human: true, limit: 2 });
    await act("提交变更评审");
    // Exercise the reply-before-projection ordering even when the action is rejected.
    writeFileSync(
      join(
        f.target.runtimeRoot,
        "instances",
        f.target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
        "fault.json",
      ),
      JSON.stringify({ delayEvents: 0.01, eventGap: 0.02 }),
    );
    const refused = await act("授权发布", { human: true, reject: true });
    expect(refused.resultCode).toBe("HUMAN_REJECTED");
    await expect(
      pane.getByRole("button", { name: "Publish", exact: true }),
    ).toBeDisabled();
    await expect(
      pane.getByRole("button", { name: "授权发布", exact: true }),
    ).toBeEnabled();
    const authorized = await act("授权发布", { human: true });
    expect(authorized.resultCode).toBe("PUBLISH_AUTHORIZED");
    const fault = join(
      f.target.runtimeRoot,
      "instances",
      f.target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
      "fault.json",
    );
    writeFileSync(
      fault,
      JSON.stringify({ dropResponse: "runtime.action.invoke" }),
    );
    const lost = await act("Publish", { lost: true });
    expect(lost.transport).toBe("lost");
    writeFileSync(fault, "{}");
    // Re-enter through the persisted project and query the same operation after a renderer reload.
    await f.page.reload();
    await goTo(f.page, "项目");
    // 全部项目 opens the project list; the project row reopens its detail, as returning to it did before.
    await f.page.locator(".project-open").first().click();
    const row = pane.getByRole("article", {
      name: `操作 ${lost.operationId}`,
      exact: true,
    });
    await row.getByRole("button", { name: "查询该操作", exact: true }).click();
    await expect(
      row.getByText("来源结果：PUBLISHED", { exact: true }),
    ).toBeVisible();
    // The Runtime's own result text is shown as given (the fake spaces Latin and Chinese, KB-309).
    await expect(
      row.getByText("Publish 已生效", { exact: true }),
    ).toBeVisible();
    await row.getByText("本次操作依据", { exact: true }).click();
    await expect(row).toContainText("task.publish");
    await expect(row).toContainText(String(lost.request?.candidateRef));
    await expect(
      pane.getByRole("button", { name: "关闭任务", exact: true }),
    ).toBeDisabled();
    const merged = await act("核对合并结果");
    expect(merged.resultCode).toBe("MERGE_CONFIRMED");
    const closed = await act("关闭任务", { human: true });
    expect(closed.resultCode).toBe("CLOSED");
    expect(
      new Set([
        authorized.operationId,
        lost.operationId,
        merged.operationId,
        closed.operationId,
      ]).size,
    ).toBe(4);
    const all = await f.request({ type: "list", projectId: f.projectId });
    if (!all.ok || !all.operations) throw Error(JSON.stringify(all));
    expect(
      all.operations.filter((o) => o.request?.actionId === "task.publish"),
    ).toHaveLength(1);
    expect(
      all.operations.filter((o) => o.request?.actionId === "task.close"),
    ).toHaveLength(1);
    expect(
      all.operations.find((o) => o.operationId === lost.operationId)
        ?.resultCode,
    ).toBe("PUBLISHED");
    await expect(
      f.page
        .locator(".project-domain-content > .project-section-heading")
        .getByText("已关闭", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "关闭任务", exact: true }),
    ).toBeDisabled();
    for (const [name, operation] of [
      ["published", lost],
      ["merged", merged],
      ["closed", closed],
    ] as const) {
      const fact = pane.getByRole("article", {
        name: `操作 ${operation.operationId}`,
        exact: true,
      });
      await fact.scrollIntoViewIfNeeded();
      await fact.screenshot({ path: info.outputPath(`${name}-result.png`) });
    }
    writeFileSync(
      info.outputPath("operations.json"),
      JSON.stringify(all.operations, null, 2),
    );
  } finally {
    await closeLocal(f.app);
  }
});

test("project publish: changed schema, grant set and folder identity cannot reuse a prepared confirmation", async () => {
  const f = await journeyFixture();
  try {
    const installation = await f.app.evaluate(
      () => globalThis.runtimeHost.records()!.runtimeInstallations[0],
    );
    const schema = join(
      packageDir(
        f.target.runtimeRoot,
        installation.runtimeId,
        installation.artifactDigest,
      ),
      "capabilities",
      "csthink.test.journey.json",
    );
    const original = readFileSync(schema);
    writeFileSync(schema, "{}");
    const altered = await f.prepare("task.accept");
    expect(altered.ok).toBe(false);
    expect(JSON.stringify(altered)).toContain("摘要已变化");
    writeFileSync(schema, original);
    const guarded = await f.app.evaluate(async (_, target) => {
      try {
        await globalThis.runtimeHost.invoke(
          target.instanceId,
          target.scopeRef,
          {
            actionId: "test.revise",
            objectRef: "candidate:1",
            payload: { decision: "继续" },
            expectedGrantsDigest: "0".repeat(64),
          },
        );
        return "unexpected invocation";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }, f.target);
    expect(guarded).toContain("授权已变化");
    const prepared = await f.prepare("task.accept");
    if (!prepared.ok || !prepared.prepared)
      throw Error(JSON.stringify(prepared));
    const token = prepared.prepared.token;
    expect(
      (
        await f.request({
          type: "evidence",
          projectId: f.projectId,
          token,
          index: 0,
        })
      ).ok,
    ).toBe(true);
    renameSync(f.folder, f.folder + "-previous");
    mkdirSync(f.folder);
    const changed = await f.request({
      type: "submit",
      projectId: f.projectId,
      token,
      payload: { decision: "继续" },
    });
    expect(changed.ok).toBe(false);
    expect(JSON.stringify(changed)).toContain("文件夹身份已变化");
    const operations = await f.request({
      type: "list",
      projectId: f.projectId,
    });
    expect(operations.ok && operations.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});

test("project publish: earlier operation records remain reachable after the first twenty entries", async () => {
  const f = await journeyFixture();
  try {
    let first = "";
    for (let index = 0; index < 22; index++) {
      const op = await f.app.evaluate(
        async (_, t) =>
          globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
            actionId: "test.revise",
            objectRef: "candidate:1",
            payload: { decision: "继续" },
          }),
        f.target,
      );
      expect(op.status, JSON.stringify(op)).toBe("succeeded");
      if (!index) first = op.operationId;
      await expect
        .poll(async () => {
          const view = await f.page.evaluate(
            (projectId) =>
              window.desktop.projectWork({ type: "read", projectId }),
            f.projectId,
          );
          if (!view.ok) return null;
          const projection = view.view?.projection;
          return [
            projection?.objects.find((o) => o.objectRef === "candidate:1")
              ?.revision,
            projection?.actions.find((a) => a.actionId === "test.revise")
              ?.expectedRevision,
          ];
        })
        .toEqual([`rev:${index + 1}`, `rev:${index + 1}`]);
    }
    const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
    await expect(pane.locator(".project-operation")).toHaveCount(20);
    const old = pane.getByRole("article", {
      name: `操作 ${first}`,
      exact: true,
    });
    await expect(old).toHaveCount(0);
    await pane
      .getByRole("button", { name: "显示更早记录", exact: true })
      .click();
    await expect(pane.locator(".project-operation")).toHaveCount(22);
    await old.getByRole("button", { name: "查询该操作", exact: true }).click();
    await expect(old).toContainText("操作已成功");
    const records = await f.request({ type: "list", projectId: f.projectId });
    expect(records.ok && records.operations?.length).toBe(22);
  } finally {
    await closeLocal(f.app);
  }
});
