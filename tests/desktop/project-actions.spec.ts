import { test, expect } from "@playwright/test";
import { goTo } from "./shell";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal } from "./local-client";

test("project actions: client binds human evidence, freezes definition and runs the synthetic review repair quota loop", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  async function act(label: string, human = false, limit?: number) {
    await pane.getByRole("button", { name: label, exact: true }).click();
    const modal = f.page.getByRole("dialog", {
      name: "核对项目操作",
      exact: true,
    });
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    if (limit) {
      await modal
        .getByRole("checkbox", { name: "填写评审次数额度", exact: true })
        .check();
      await modal
        .getByRole("spinbutton", { name: "评审次数额度", exact: true })
        .fill(String(limit));
    }
    if (human) {
      await expect(
        modal.getByRole("button", { name: "确认提交", exact: true }),
      ).toBeDisabled();
      await modal
        .getByRole("button", { name: "打开依据 1", exact: true })
        .click();
      await expect(modal.locator("pre")).toContainText(
        "<script>window.journeyInjected = true</script>",
      );
      expect(
        await f.page.evaluate(
          () =>
            (window as unknown as { journeyInjected?: boolean })
              .journeyInjected,
        ),
      ).toBeUndefined();
      await modal
        .getByRole("checkbox", {
          name: "我已核对本次操作与全部依据",
          exact: true,
        })
        .check();
    }
    if (label === "接纳任务")
      await modal.screenshot({
        path: info.outputPath("action-confirmation-light.png"),
      });
    await modal
      .getByRole("button", { name: "确认提交", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
  }
  try {
    await pane.getByRole("button", { name: "接纳任务", exact: true }).click();
    await f.page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const empty = await f.request({ type: "list", projectId: f.projectId });
    expect(empty.ok && empty.operations?.length).toBe(0);
    await act("接纳任务", true);
    await act("冻结定义", true);
    await act("开始实施");
    await act("执行验证");
    await act("提交变更评审");
    await act("修复评审问题");
    await act("执行验证");
    await expect(
      pane.getByRole("button", { name: "提交变更评审", exact: true }),
    ).toBeDisabled();
    await expect(pane).toContainText("CAPACITY_EXHAUSTED");
    await act("调整评审额度", true, 2);
    await act("提交变更评审");
    await expect(
      pane.getByRole("button", { name: "授权发布", exact: true }),
    ).toBeEnabled();
    const operations = await f.request({
      type: "list",
      projectId: f.projectId,
    });
    expect(operations.ok && operations.operations?.length).toBe(9);
    expect(
      operations.ok &&
        operations.operations?.filter(
          (o) => o.request?.actionId === "task.accept",
        ).length,
    ).toBe(1);
    const records = await f.app.evaluate(() =>
      globalThis.runtimeHost.records()!,
    );
    expect(records.runtimeExecutions).toHaveLength(0);
  } finally {
    await closeLocal(f.app);
  }
});

test("project actions: stale candidates, cross-project tokens, unread evidence and revoked grants fail before invocation", async () => {
  const f = await journeyFixture();
  try {
    const prepared = await f.prepare("task.accept");
    expect(prepared.ok && prepared.prepared).toBeTruthy();
    if (!prepared.ok || !prepared.prepared) throw Error("missing prepared");
    const token = prepared.prepared.token;
    const unread = await f.request({
      type: "submit",
      projectId: f.projectId,
      token,
      payload: { decision: "继续" },
    });
    expect(unread.ok).toBe(false);
    expect(JSON.stringify(unread)).toContain("全部确认依据");
    const forged = await f.request({
      type: "submit",
      projectId: "00000000-0000-0000-0000-000000000001",
      token,
      payload: { decision: "继续" },
    });
    expect(forged.ok).toBe(false);
    const read = await f.request({
      type: "evidence",
      projectId: f.projectId,
      token,
      index: 0,
    });
    expect(read.ok).toBe(true);
    await f.app.evaluate(async (_, t) => {
      await globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
        actionId: "test.revise",
        objectRef: "candidate:1",
        payload: { decision: "继续" },
      });
    }, f.target);
    const stale = await f.request({
      type: "submit",
      projectId: f.projectId,
      token,
      payload: { decision: "继续" },
    });
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale)).toContain("候选已变化");
    const guarded = await f.app.evaluate(
      async (_, { target, action }) => {
        try {
          await globalThis.runtimeHost.invoke(
            target.instanceId,
            target.scopeRef,
            {
              actionId: action.actionId,
              objectRef: action.objectRef,
              payload: { decision: "继续" },
              expectedAction: action,
            },
          );
          return "unexpected invocation";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
      { target: f.target, action: prepared.prepared.action },
    );
    expect(guarded).toContain("候选已变化");
    const current = await f.prepare("task.accept");
    if (!current.ok || !current.prepared) throw Error(JSON.stringify(current));
    const next = current.prepared.token;
    expect(
      (
        await f.request({
          type: "evidence",
          projectId: f.projectId,
          token: next,
          index: 0,
        })
      ).ok,
    ).toBe(true);
    await f.app.evaluate(async (_, t) => {
      await globalThis.runtimeHost.revokeGrant(t.instanceId, t.grantId);
    }, f.target);
    expect(
      (
        await f.request({
          type: "submit",
          projectId: f.projectId,
          token: next,
          payload: { decision: "继续" },
        })
      ).ok,
    ).toBe(false);
    const records = await f.request({ type: "list", projectId: f.projectId });
    expect(
      records.ok && records.operations?.map((o) => o.request?.actionId),
    ).toEqual(["test.revise"]);
  } finally {
    await closeLocal(f.app);
  }
});

test("project actions: concurrent confirmations share identity and a lost response is queried without replay", async () => {
  const f = await journeyFixture();
  try {
    const a = await f.prepare("task.accept"),
      b = await f.prepare("task.accept");
    if (!a.ok || !a.prepared || !b.ok || !b.prepared)
      throw Error("missing candidates");
    for (const token of [a.prepared.token, b.prepared.token])
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
    const replies = await Promise.all(
      [a.prepared.token, b.prepared.token].map((token) =>
        f.request({
          type: "submit",
          projectId: f.projectId,
          token,
          payload: { decision: "继续" },
        }),
      ),
    );
    expect(replies.every((r) => r.ok)).toBe(true);
    expect(replies.map((r) => r.ok && r.operation?.operationId)[0]).toBe(
      replies.map((r) => r.ok && r.operation?.operationId)[1],
    );
    await expect(
      f.page.getByRole("button", { name: "冻结定义", exact: true }),
    ).toBeEnabled();
    const next = await f.prepare("definition.freeze");
    if (!next.ok || !next.prepared) throw Error(JSON.stringify(next));
    const token = next.prepared.token;
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
    const submitted = await f.request({
      type: "submit",
      projectId: f.projectId,
      token,
      payload: { decision: "继续" },
    });
    expect(submitted.ok && submitted.operation?.transport).toBe("lost");
    if (!submitted.ok || !submitted.operation)
      throw Error(JSON.stringify(submitted));
    writeFileSync(fault, "{}");
    const queried = await f.request({
      type: "query",
      projectId: f.projectId,
      operationId: submitted.operation.operationId,
    });
    expect(queried.ok && queried.operation?.status).toBe("succeeded");
    const list = await f.request({ type: "list", projectId: f.projectId });
    expect(list.ok && list.operations?.length).toBe(2);
    expect(
      (
        await f.request({
          type: "query",
          projectId: f.projectId,
          operationId: "op:foreign",
        })
      ).ok,
    ).toBe(false);
  } finally {
    await closeLocal(f.app);
  }
});
test("project actions: 冻结定义 takes the Define Task shape (OD-423): a list of evidence entries added, reordered and removed within its bounds, nullable names kept apart from absent ones, a named-entry map that refuses repeated names; the Host sends exactly the reviewed structure and the main process refuses a forged one", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  const modal = f.page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  const a = "0123456789abcdef0123456789abcdef01234567";
  const b = "89abcdef0123456789abcdef0123456789abcdef";
  const confirmAndSubmit = async () => {
    await modal
      .getByRole("button", { name: "打开依据 1", exact: true })
      .click();
    await modal
      .getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      })
      .check();
    await modal.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
  };
  const entry = (group: string, n: number) =>
    modal.getByRole("group", { name: `${group} 第 ${n} 项`, exact: true });
  const fillEvidence = async (n: number, commit: string, path: string) => {
    await entry("依据", n).getByRole("textbox", { name: "提交" }).fill(commit);
    await entry("依据", n).getByRole("textbox", { name: "路径" }).fill(path);
  };
  try {
    await pane.getByRole("button", { name: "接纳任务", exact: true }).click();
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    await confirmAndSubmit();
    await modal.getByRole("button", { name: "关闭", exact: true }).click();

    await pane.getByRole("button", { name: "冻结定义", exact: true }).click();
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    await modal
      .getByRole("checkbox", { name: "填写定义候选", exact: true })
      .check();
    await modal.getByRole("textbox", { name: "定义提交", exact: true }).fill(a);
    // Nullable names start as the explicit empty value; the tool is given, the model stays null.
    const tool = modal.getByRole("checkbox", { name: "工具 为空值（null）" });
    const model = modal.getByRole("checkbox", { name: "模型 为空值（null）" });
    await expect(tool).toBeChecked();
    await expect(model).toBeChecked();
    await expect(
      modal.getByRole("textbox", { name: "工具", exact: true }),
    ).toHaveCount(0);
    await tool.uncheck();
    await modal
      .getByRole("textbox", { name: "工具", exact: true })
      .fill("Claude Code");
    await modal
      .getByRole("combobox", { name: "仅由人撰写", exact: true })
      .selectOption("false");
    // The list starts at its minimum of one entry, which cannot be removed.
    await expect(entry("依据", 1)).toBeVisible();
    await expect(entry("依据", 2)).toHaveCount(0);
    await expect(
      modal.getByRole("button", { name: "删除依据第 1 项" }),
    ).toBeDisabled();
    await fillEvidence(1, a, "sdd/spec.md");
    const list = modal.getByRole("group", { name: "依据", exact: true });
    const add = list.getByRole("button", { name: "添加一项" });
    await add.click();
    await fillEvidence(2, b, "sdd/milestones.md");
    // Reorder: the second entry moves up and keeps its values.
    await modal.getByRole("button", { name: "上移依据第 2 项" }).click();
    await expect(
      entry("依据", 1).getByRole("textbox", { name: "路径" }),
    ).toHaveValue("sdd/milestones.md");
    await expect(
      entry("依据", 2).getByRole("textbox", { name: "路径" }),
    ).toHaveValue("sdd/spec.md");
    // Up to the maximum of four, then adding stops; removing brings it back to two.
    await add.click();
    await add.click();
    await expect(entry("依据", 4)).toBeVisible();
    await expect(add).toBeDisabled();
    await modal.getByRole("button", { name: "删除依据第 4 项" }).click();
    await modal.getByRole("button", { name: "删除依据第 3 项" }).click();
    await expect(add).toBeEnabled();
    // A map refuses a repeated name: the confirmation cannot be submitted until it is fixed.
    await modal
      .getByRole("checkbox", { name: "填写说明", exact: true })
      .check();
    const notes = modal.getByRole("group", { name: "说明", exact: true });
    await notes.getByRole("button", { name: "添加一项" }).click();
    await notes.getByRole("button", { name: "添加一项" }).click();
    await entry("说明", 1).getByRole("textbox", { name: "名称" }).fill("范围");
    await entry("说明", 1)
      .getByRole("textbox", { name: "内容" })
      .fill("只含作品页与深色模式");
    await entry("说明", 2).getByRole("textbox", { name: "名称" }).fill("范围");
    await entry("说明", 2)
      .getByRole("textbox", { name: "内容" })
      .fill("不含评论与搜索");
    await expect(modal.getByRole("status").first()).toContainText(
      "名称不能为空，也不能重复",
    );
    await expect(
      modal.getByRole("button", { name: "确认提交", exact: true }),
    ).toBeDisabled();
    await entry("说明", 2).getByRole("textbox", { name: "名称" }).fill("排除");
    await expect(modal.getByText("名称不能为空，也不能重复")).toHaveCount(0);
    await modal
      .getByRole("button", { name: "打开依据 1", exact: true })
      .click();
    await modal
      .getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      })
      .check();
    // Pixel review: light, dark and 900 × 680, top and bottom of the scrolled form.
    const shoot = async (suffix: string) => {
      await modal.evaluate((el) => (el.scrollTop = 0));
      await f.page.screenshot({
        path: info.outputPath(`define-form-top-${suffix}.png`),
      });
      await list.scrollIntoViewIfNeeded();
      await f.page.screenshot({
        path: info.outputPath(`define-form-list-${suffix}.png`),
      });
      await modal.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await f.page.screenshot({
        path: info.outputPath(`define-form-bottom-${suffix}.png`),
      });
    };
    await shoot("light");
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await shoot("dark");
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await shoot("dark-900");
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await shoot("light-900");
    await modal.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
    await expect(modal).toContainText(
      "冻结定义已生效：定义候选 0123456，依据 2 条，工具 Claude Code，模型 空值，说明 2 条",
    );
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    // The Host sent exactly the reviewed structure: order kept, null kept, nothing merged or dropped.
    const listed = await f.request({ type: "list", projectId: f.projectId });
    const freeze =
      listed.ok &&
      listed.operations?.find(
        (o) => o.request?.actionId === "definition.freeze",
      );
    expect(freeze && freeze.request?.payload).toEqual({
      decision: "继续",
      definition: {
        commit: a,
        author: {
          tool: "Claude Code",
          model: null,
          humanOnly: false,
          evidenceRefs: [
            { commit: b, path: "sdd/milestones.md" },
            { commit: a, path: "sdd/spec.md" },
          ],
        },
        notes: { 范围: "只含作品页与深色模式", 排除: "不含评论与搜索" },
      },
    });
    // The main process checks the same form: forged structures never reach the Runtime.
    const before = listed.ok ? listed.operations!.length : -1;
    const forged = async (definition: unknown) => {
      const prepared = await f.prepare("task.implement");
      if (!prepared.ok || !prepared.prepared) throw Error("missing prepared");
      return f.request({
        type: "submit",
        projectId: f.projectId,
        token: prepared.prepared.token,
        payload: { decision: "继续", definition },
      });
    };
    const good = {
      commit: a,
      author: {
        tool: null,
        model: null,
        humanOnly: true,
        evidenceRefs: [{ commit: a, path: "p" }],
      },
    };
    for (const [definition, reason] of [
      [{ ...good, author: { ...good.author, evidenceRefs: [] } }, "1 至 4"],
      [{ ...good, author: { ...good.author, tool: 5 } }, "文本"],
      [
        {
          ...good,
          author: {
            tool: null,
            humanOnly: true,
            evidenceRefs: good.author.evidenceRefs,
          },
        },
        "必填",
      ],
      [{ ...good, author: { ...good.author, humanOnly: null } }, "空值"],
      [{ ...good, notes: [["x", "1"]] }, "不能重复"],
      [{ ...good, reviewer: "x" }, "未定义字段"],
    ] as [unknown, string][]) {
      const reply = await forged(definition);
      expect(reply.ok, JSON.stringify(definition)).toBe(false);
      expect(reply.ok ? "" : reply.message).toContain(reason);
    }
    const after = await f.request({ type: "list", projectId: f.projectId });
    expect(after.ok && after.operations!.length).toBe(before);
  } finally {
    await closeLocal(f.app);
  }
});
test("project actions: one capability, several action schemas (OD-425): 补充说明 takes the root definitions entry its digest names, not the capability root; the Host sends exactly that payload and the main process refuses the root's fields; a digest the capability document does not hold is refused before any form", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  const modal = f.page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  const fault = join(
    f.target.runtimeRoot,
    "instances",
    f.target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
    "fault.json",
  );
  // test.revise changes the candidate, so the Runtime announces its actions again.
  const announce = async (annotate: string) => {
    writeFileSync(fault, JSON.stringify({ annotate }));
    const prepared = await f.prepare("test.revise");
    if (!prepared.ok || !prepared.prepared)
      throw Error(JSON.stringify(prepared));
    const reply = await f.request({
      type: "submit",
      projectId: f.projectId,
      token: prepared.prepared.token,
      payload: { decision: "继续" },
    });
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
  };
  const annotate = pane.getByRole("button", { name: "补充说明", exact: true });
  try {
    await announce("entry");
    await annotate.click();
    // The entry's fields only: the capability root's 处理方式 is not part of this action.
    await expect(modal.getByRole("combobox", { name: "处理方式" })).toHaveCount(
      0,
    );
    await expect(modal).toContainText(
      "为合成任务补充一条说明，不改变任务阶段。",
    );
    // KB-307: the empty required 说明 asks to be filled; the main process gives the same answer below.
    await expect(
      modal.getByRole("status").filter({ hasText: "说明：请填写。" }),
    ).toBeVisible();
    await expect(
      modal.getByRole("button", { name: "确认提交", exact: true }),
    ).toBeDisabled();
    await modal
      .getByRole("textbox", { name: "说明", exact: true })
      .fill("已与设计稿逐项核对");
    await modal
      .getByRole("checkbox", { name: "填写标签", exact: true })
      .check();
    const tags = modal.getByRole("group", { name: "标签", exact: true });
    await tags.getByRole("button", { name: "添加一项" }).click();
    await tags.getByRole("button", { name: "添加一项" }).click();
    const tag = (n: number) =>
      modal
        .getByRole("group", { name: `标签 第 ${n} 项`, exact: true })
        .getByRole("textbox", { name: "标签", exact: true });
    await tag(1).fill("设计");
    await tag(2).fill("深色模式");
    // Pixel review: light, dark and 900 × 680, top and bottom of the scrolled form.
    const shoot = async (suffix: string) => {
      if (!(await modal.count()))
        return f.page.screenshot({
          path: info.outputPath(`annotate-${suffix}.png`),
        });
      await modal.evaluate((el) => (el.scrollTop = 0));
      await f.page.screenshot({
        path: info.outputPath(`annotate-form-top-${suffix}.png`),
      });
      await modal.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await f.page.screenshot({
        path: info.outputPath(`annotate-form-bottom-${suffix}.png`),
      });
    };
    await shoot("light");
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await shoot("dark");
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await shoot("dark-900");
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await shoot("light-900");
    await modal.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
    await expect(modal).toContainText(
      "补充说明已记录：已与设计稿逐项核对（标签 2 个）",
    );
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    const listed = await f.request({ type: "list", projectId: f.projectId });
    const sent =
      listed.ok &&
      listed.operations?.find((o) => o.request?.actionId === "task.annotate");
    expect(sent && sent.request?.payload).toEqual({
      note: "已与设计稿逐项核对",
      tags: ["设计", "深色模式"],
    });
    // The action reply can precede its projection events. Prepare once against the fully published version.
    await f.waitForPublishedProjection();
    // The main process checks the entry's form: the root's fields never reach the Runtime.
    const before = listed.ok ? listed.operations!.length : -1;
    for (const [payload, reason] of [
      [{ decision: "继续" }, "未定义字段"],
      [{ note: "x", decision: "继续" }, "未定义字段"],
      [{ note: "" }, "说明：请填写。"],
      [{ note: "x".repeat(201) }, "说明：文本长度不符合要求。"],
      [{ note: "x", tags: Array(5).fill("t") }, "0 至 4"],
    ] as [Record<string, unknown>, string][]) {
      const prepared = await f.prepare("task.annotate");
      if (!prepared.ok || !prepared.prepared)
        throw Error(JSON.stringify(prepared));
      const reply = await f.request({
        type: "submit",
        projectId: f.projectId,
        token: prepared.prepared.token,
        payload,
      });
      expect(reply.ok, JSON.stringify(payload)).toBe(false);
      expect(reply.ok ? "" : reply.message).toContain(reason);
    }
    const unchanged = await f.request({ type: "list", projectId: f.projectId });
    expect(unchanged.ok && unchanged.operations!.length).toBe(before);

    // A digest the capability document does not hold: an unknown schema, no form (OD-425 R1).
    await announce("unknown");
    const total = await f.request({ type: "list", projectId: f.projectId });
    // Until the view shows the new announcement the pane answers 操作版本已变化 and the person opens it again.
    await expect(async () => {
      await annotate.click();
      await expect(pane).toContainText(
        "该操作的输入格式摘要既不是其能力文档本身，也不是该文档 definitions 中的一项（OD-425 R1），按未知格式拒绝。",
        { timeout: 1000 },
      );
    }).toPass();
    await expect(modal).toHaveCount(0);
    await shoot("refused-light-900");
    const refused = await f.prepare("task.annotate");
    expect(refused.ok).toBe(false);
    const after = await f.request({ type: "list", projectId: f.projectId });
    expect(after.ok && after.operations!.length).toBe(
      total.ok ? total.operations!.length : -1,
    );
  } finally {
    await closeLocal(f.app);
  }
});
test("project actions: after an action succeeds its object shows 同步中 with its actions closed until the projection moves past the binding the action consumed; events in time, delayed events, 重新同步 and a disconnection each end in the true state (KB-308)", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  const modal = f.page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  const note = pane.locator(".project-awaiting");
  const fault = join(
    f.target.runtimeRoot,
    "instances",
    f.target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
    "fault.json",
  );
  const view = async () => {
    const r = await f.page.evaluate(
      (projectId) => window.desktop.projectWork({ type: "read", projectId }),
      f.projectId,
    );
    if (!r.ok || !r.view) throw Error(JSON.stringify(r));
    return r.view;
  };
  // The Host commits a change's events one at a time after its answer, so a single read can fall between
  // them; what the view awaits is polled until it holds.
  const awaiting = async () => (await view()).awaiting;
  const button = (name: string) =>
    pane.getByRole("button", { name, exact: true });
  async function act(label: string, human = false) {
    await button(label).click();
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    if (human) {
      await modal
        .getByRole("button", { name: "打开依据 1", exact: true })
        .click();
      await modal
        .getByRole("checkbox", {
          name: "我已核对本次操作与全部依据",
          exact: true,
        })
        .check();
    }
    await modal.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
  }
  try {
    // Events in time: the fake sends a change's events before its answer, so nothing awaits.
    await act("接纳任务", true);
    await expect.poll(awaiting).toEqual([]);
    await expect(note).toHaveCount(0);
    await expect(button("冻结定义")).toBeEnabled();

    // Delayed: the answer first, the events 6 s later one at a time, as hp sends them.
    writeFileSync(fault, JSON.stringify({ delayEvents: 6, eventGap: 0.2 }));
    await act("冻结定义", true);
    await expect(note).toContainText("同步中“冻结定义”已成功");
    const waiting = await view();
    expect(waiting.awaiting).toMatchObject([
      { objectRef: "candidate:1", actionId: "definition.freeze" },
    ]);
    // The projection still offers the old state (冻结定义 open); every action of the object is closed.
    expect(
      waiting.projection!.actions.find(
        (a) => a.actionId === "definition.freeze",
      )!.enabled,
    ).toBe(true);
    for (const label of ["冻结定义", "开始实施", "更新合成候选"])
      await expect(button(label)).toBeDisabled();
    await expect(pane.getByText("当前阶段不能执行该操作")).toHaveCount(0);
    await note.scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: info.outputPath("awaiting-light.png") });
    // The global pending entry shows the same item as 同步中 with its processing closed.
    await goTo(f.page, "待处理");
    const row = f.page
      .locator(".project-pending-item[data-status=pending]")
      .filter({ hasText: "冻结定义" });
    await expect(row.locator(".project-tag")).toHaveText("同步中");
    await expect(
      row.getByRole("button", { name: "处理：冻结定义", exact: true }),
    ).toBeDisabled();
    await expect(row.locator(".project-awaiting")).toBeVisible();
    await f.page.screenshot({
      path: info.outputPath("awaiting-pending-light.png"),
    });
    await goTo(f.page, "项目");
    // 全部项目 opens the project list; the project row reopens its detail, as returning to it did before.
    await f.page.locator(".project-open").first().click();
    // The events arrive: the true state, with no timer involved. Returning to the project mounts the project
    // detail again and it shows no note until its first read, although the change still awaits its events;
    // the next action becoming available is what shows that they have arrived.
    await expect(button("开始实施")).toBeEnabled({ timeout: 20_000 });
    await expect(note).toHaveCount(0);
    await expect(button("冻结定义")).toBeDisabled();
    await expect.poll(awaiting).toEqual([]);

    // The events never come: 重新同步 takes a fresh full snapshot, which already holds the change.
    writeFileSync(fault, JSON.stringify({ delayEvents: 600 }));
    await act("开始实施");
    await expect(note).toBeVisible();
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await note.scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: info.outputPath("awaiting-dark.png") });
    await note.getByRole("button", { name: "重新同步", exact: true }).click();
    // As above, the available next action shows the fresh snapshot; the note is checked after it.
    await expect(button("执行验证")).toBeEnabled({ timeout: 20_000 });
    await expect(note).toHaveCount(0);
    await expect(button("开始实施")).toBeDisabled();

    // Disconnected while awaiting: the existing unavailable rule takes over; a reconnection resynchronises.
    await act("执行验证");
    await expect(note).toBeVisible();
    await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.supervisor.shutdown(
          t.instanceId,
          "synthetic disconnection",
        ),
      f.target,
    );
    await expect(
      f.page
        .getByRole("region", { name: "任务操作", exact: true })
        .getByText("扩展未连接，显示最后已知内容。", { exact: true }),
    ).toBeVisible();
    await expect(note).toHaveCount(0);
    for (const label of ["执行验证", "提交变更评审"])
      await expect(button(label)).toBeDisabled();
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await button("执行验证").scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("awaiting-disconnected-dark-900.png"),
    });
    writeFileSync(fault, "{}");
    const reconnected = await f.page.evaluate(
      (instanceId) =>
        window.desktop.runtimeControl({ type: "reconnect", instanceId }),
      f.target.instanceId,
    );
    expect(reconnected.ok, JSON.stringify(reconnected)).toBe(true);
    await expect(button("提交变更评审")).toBeEnabled({ timeout: 20_000 });
    await expect(button("执行验证")).toBeDisabled();
    await expect(note).toHaveCount(0);
    await expect.poll(awaiting).toEqual([]);
    // Each change was invoked once; nothing was sent again by the wait or the resynchronisation.
    const listed = await f.request({ type: "list", projectId: f.projectId });
    expect(
      listed.ok && listed.operations!.map((o) => o.request?.actionId).sort(),
    ).toEqual([
      "definition.freeze",
      "task.accept",
      "task.implement",
      "task.validate",
    ]);
  } finally {
    await closeLocal(f.app);
  }
});

test("project actions: every action of the object has its own aligned row with its reason beside it and available actions come first, in light, dark and the 900 × 680 window (KB-315)", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  const modal = f.page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  /** The rows the pane shows for the object's actions, in the order read from the Runtime projection. */
  const rows = async () => {
    const r = await f.page.evaluate(
      (projectId) => window.desktop.projectWork({ type: "read", projectId }),
      f.projectId,
    );
    if (!r.ok || !r.view?.projection) throw Error(JSON.stringify(r));
    const object = r.view.projection.objects.find(
      (o) => o.title === "合成编码任务",
    )!;
    const actions = r.view.projection.actions.filter(
      (a) => a.objectRef === object.objectRef,
    );
    return pane.evaluate(
      (el, actions) =>
        actions.map((a) => {
          const button = [...el.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === a.label,
          )!;
          const box = button.getBoundingClientRect(),
            id = button.getAttribute("aria-describedby"),
            reason = id ? document.getElementById(id) : null,
            text = reason?.getBoundingClientRect();
          return {
            label: a.label,
            enabled: a.enabled,
            expected: a.enabled
              ? ""
              : `${a.disabledReason ?? ""}${a.disabledCode ? `（${a.disabledCode}）` : ""}`,
            left: box.left,
            width: box.width,
            top: box.top,
            bottom: box.bottom,
            reason: reason?.textContent?.replace(/\s+/g, "") ?? null,
            reasonMiddle: text ? (text.top + text.bottom) / 2 : null,
          };
        }),
      actions,
    );
  };
  function expectRows(list: Awaited<ReturnType<typeof rows>>) {
    const shown = JSON.stringify(list);
    expect(list.length, shown).toBeGreaterThan(2);
    // One column of equally wide buttons, one action per row.
    for (const key of ["left", "width"] as const) {
      const values = list.map((r) => r[key]);
      expect(Math.max(...values) - Math.min(...values), shown).toBeLessThan(
        0.5,
      );
    }
    const byTop = [...list].sort((a, b) => a.top - b.top);
    for (let i = 1; i < byTop.length; i++)
      expect(byTop[i].top, shown).toBeGreaterThanOrEqual(byTop[i - 1].bottom);
    // Available actions come first; a closed one names its reason on its own row.
    const firstClosed = byTop.findIndex((r) => !r.enabled);
    if (firstClosed >= 0)
      expect(
        byTop.slice(firstClosed).every((r) => !r.enabled),
        shown,
      ).toBe(true);
    for (const r of list.filter((r) => !r.enabled)) {
      expect(r.reason, shown).toBe(r.expected.replace(/\s+/g, ""));
      expect(r.reasonMiddle!, shown).toBeGreaterThan(r.top);
      expect(r.reasonMiddle!, shown).toBeLessThan(r.bottom);
    }
  }
  try {
    expectRows(await rows());
    await pane.screenshot({ path: info.outputPath("actions-light.png") });
    await pane.getByRole("button", { name: "接纳任务", exact: true }).click();
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    await modal
      .getByRole("button", { name: "打开依据 1", exact: true })
      .click();
    await modal
      .getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      })
      .check();
    await modal.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      pane.getByRole("button", { name: "冻结定义", exact: true }),
    ).toBeEnabled();
    expectRows(await rows());
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await expect(f.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    expectRows(await rows());
    await pane.screenshot({ path: info.outputPath("actions-dark-900.png") });
  } finally {
    await closeLocal(f.app);
  }
});

test("project actions: the required prompt under the confirmation box keeps a clear distance from it in dark and light at 900 × 680 (KB-320)", async ({}, info) => {
  const f = await journeyFixture();
  const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
  const modal = f.page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  try {
    await pane.getByRole("button", { name: "接纳任务", exact: true }).click();
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    await modal
      .getByRole("button", { name: "打开依据 1", exact: true })
      .click();
    await modal
      .getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      })
      .check();
    await modal.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(modal.getByText("操作已成功", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await expect(f.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await pane.getByRole("button", { name: "冻结定义", exact: true }).click();
    await modal
      .getByRole("combobox", { name: "处理方式", exact: true })
      .selectOption("继续");
    await modal
      .getByRole("checkbox", { name: "填写定义候选", exact: true })
      .check();
    await modal
      .getByRole("button", { name: "打开依据 1", exact: true })
      .click();
    const prompt = modal.getByRole("status").filter({ hasText: "请填写" });
    await expect(prompt).toBeVisible();
    const confirmBox = modal.locator("label").filter({
      has: f.page.getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      }),
    });
    const gap = async () => {
      const above = (await confirmBox.boundingBox())!,
        box = (await prompt.boundingBox())!;
      return box.y - (above.y + above.height);
    };
    await prompt.scrollIntoViewIfNeeded();
    expect(await gap()).toBeGreaterThanOrEqual(12);
    await f.page.screenshot({ path: info.outputPath("prompt-dark-900.png") });
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "light" }),
    );
    await expect(f.page.locator("html")).toHaveAttribute("data-theme", "light");
    await prompt.scrollIntoViewIfNeeded();
    expect(await gap()).toBeGreaterThanOrEqual(12);
    await f.page.screenshot({ path: info.outputPath("prompt-light-900.png") });
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
  } finally {
    await closeLocal(f.app);
  }
});
