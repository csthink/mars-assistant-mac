import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import type { Command, HostCommand, Reply } from "../../src/shared/protocol";
import {
  listWidgetsToolName,
  moveWidgetToolName,
} from "../../src/shared/workbench-tools";
import { seedRetainedWidgets } from "./widget-generation-fixture";

function ok(reply: Reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
}
/** A running turn of an ordinary conversation, with five retained widgets of which two share a name. */
function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/workbench-tools-"));
  const widgets = seedRetainedWidgets(dir, [
    "天气",
    "便笺",
    "计时",
    "便笺",
    "汇率",
  ]);
  const store = new Store(dir);
  const command = (c: Command) => store.execute(c, "main");
  const host = (c: HostCommand) => store.execute(c, "main", "host");
  const conversationId = randomUUID(),
    connectionId = randomUUID();
  ok(command({ type: "create", id: conversationId }));
  ok(
    command({
      type: "upsertConnection",
      id: connectionId,
      name: "工作台工具测试",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      secretRef: randomUUID(),
      imageInput: "unknown",
      contextChars: null,
      revision: 0,
    }),
  );
  ok(
    command({
      type: "submitTurn",
      requestId: randomUUID(),
      conversationId,
      connectionId,
      text: "把汇率移到第一个",
    }),
  );
  const executionId = store.snapshot().activeTurns[0].executionId;
  ok(host({ type: "beginExecution", executionId }));
  let call = 0;
  const run = (
    tool: string,
    args: Record<string, unknown>,
    callId = `call_${++call}`,
  ) =>
    host({
      type: "runWorkbenchTool",
      executionId,
      callId,
      tool,
      arguments: JSON.stringify(args),
    });
  const result = (reply: Reply) => JSON.parse(ok(reply).toolText!);
  const order = () =>
    store.snapshot().widgetGeneration!.widgets.map((w) => w.id);
  return {
    dir,
    store,
    widgets,
    conversationId,
    connectionId,
    executionId,
    command,
    host,
    run,
    result,
    order,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("workbench tools: list gives identities, positions, same-name numbers and the order revision; moves commit through the order command", () => {
  const f = fixture();
  try {
    const ids = f.widgets.map((w) => w.id);
    const listed = f.result(f.run(listWidgetsToolName, {}));
    assert.equal(listed.status, "listed");
    assert.equal(listed.orderRevision, 5);
    assert.deepEqual(
      listed.widgets.map((w: { name: string; sameName: number | null }) => [
        w.name,
        w.sameName,
      ]),
      [
        ["天气", null],
        ["便笺", 1],
        ["计时", null],
        ["便笺", 2],
        ["汇率", null],
      ],
    );
    const moved = f.result(
      f.run(moveWidgetToolName, {
        name: "汇率",
        toPosition: 1,
        orderRevision: 5,
      }),
    );
    assert.deepEqual(moved, {
      status: "moved",
      widgetId: ids[4],
      name: "汇率",
      position: 1,
      orderRevision: 6,
    });
    assert.deepEqual(f.order(), [ids[4], ids[0], ids[1], ids[2], ids[3]]);
    // The second 便笺 by its identity; the first stays.
    assert.equal(
      f.result(
        f.run(moveWidgetToolName, {
          widgetId: ids[3],
          toPosition: 2,
          orderRevision: 6,
        }),
      ).status,
      "moved",
    );
    assert.deepEqual(f.order(), [ids[4], ids[3], ids[0], ids[1], ids[2]]);
    const actions = f.store.snapshot().workbenchActions;
    assert.deepEqual(
      actions.map((a) => [a.status, a.widgetId, a.position]),
      [
        ["moved", ids[4], 1],
        ["moved", ids[3], 2],
      ],
    );
    assert.equal(actions[0].conversationId, f.conversationId);
  } finally {
    f.close();
  }
});

test("workbench tools: a shared name is refused with candidates, an unknown name or position moves nothing, and a stale revision never overwrites a later user move", () => {
  const f = fixture();
  try {
    const ids = f.widgets.map((w) => w.id);
    const ambiguous = f.result(
      f.run(moveWidgetToolName, {
        name: "便笺",
        toPosition: 1,
        orderRevision: 5,
      }),
    );
    assert.equal(ambiguous.status, "ambiguous");
    assert.deepEqual(
      ambiguous.candidates.map((c: { widgetId: string }) => c.widgetId),
      [ids[1], ids[3]],
    );
    assert.deepEqual(f.order(), ids);
    assert.equal(
      f.result(
        f.run(moveWidgetToolName, {
          name: "不存在",
          toPosition: 1,
          orderRevision: 5,
        }),
      ).status,
      "not_found",
    );
    assert.equal(
      f.result(
        f.run(moveWidgetToolName, {
          widgetId: ids[0],
          toPosition: 9,
          orderRevision: 5,
        }),
      ).status,
      "invalid",
    );
    // The user moves 计时 while the Agent's listed revision is 5; the Agent's later move is refused.
    ok(
      f.command({
        type: "moveWidget",
        widgetId: ids[2],
        toIndex: 0,
        orderRevision: 5,
      }),
    );
    const userOrder = f.order();
    const stale = f.result(
      f.run(moveWidgetToolName, {
        name: "汇率",
        toPosition: 1,
        orderRevision: 5,
      }),
    );
    assert.equal(stale.status, "stale");
    assert.equal(stale.orderRevision, 6);
    assert.deepEqual(f.order(), userOrder);
    assert.deepEqual(
      f.store.snapshot().workbenchActions.map((a) => a.status),
      ["ambiguous", "not_found", "invalid", "stale"],
    );
    // A repeated call identity returns the recorded result and acts once.
    const first = f.run(
      moveWidgetToolName,
      { name: "汇率", toPosition: 1, orderRevision: 6 },
      "call_repeat",
    );
    const again = f.run(
      moveWidgetToolName,
      { name: "汇率", toPosition: 1, orderRevision: 6 },
      "call_repeat",
    );
    assert.equal(f.result(again).status, f.result(first).status);
    assert.equal(f.store.snapshot().workbenchActions.length, 5);
    assert.equal(f.store.snapshot().widgetGeneration!.orderRevision, 7);
  } finally {
    f.close();
  }
});

test("workbench tools: malformed arguments, unknown tools, ended turns and project conversations are refused without changes", () => {
  const f = fixture();
  try {
    const ids = f.widgets.map((w) => w.id);
    for (const [tool, args] of [
      [moveWidgetToolName, { toPosition: 1, orderRevision: 5 }],
      [
        moveWidgetToolName,
        { name: "汇率", widgetId: ids[4], toPosition: 1, orderRevision: 5 },
      ],
      [moveWidgetToolName, { name: "汇率", toPosition: 0, orderRevision: 5 }],
      [
        moveWidgetToolName,
        { name: "汇率", toPosition: 1, orderRevision: 5, extra: true },
      ],
      [listWidgetsToolName, { all: true }],
      ["delete_workbench_widget", { widgetId: ids[0] }],
    ] as const) {
      const reply = f.run(tool, args as Record<string, unknown>);
      assert.equal(reply.ok, false, JSON.stringify(args));
    }
    assert.deepEqual(f.order(), ids);
    // A project conversation offers no workbench operations.
    f.store.db
      .prepare(
        "INSERT INTO projects(id,name,goal,folder_json,created_at,updated_at) VALUES('p1','项目','','{}',?,?)",
      )
      .run(new Date().toISOString(), new Date().toISOString());
    f.store.db
      .prepare(
        "INSERT INTO project_chats(conversation_id,project_id) VALUES(?,'p1')",
      )
      .run(f.conversationId);
    assert.equal(f.run(listWidgetsToolName, {}).ok, false);
    f.store.db
      .prepare("DELETE FROM project_chats WHERE conversation_id=?")
      .run(f.conversationId);
    ok(f.host({ type: "reportFinished", executionId: f.executionId, seq: 1 }));
    const ended = f.run(moveWidgetToolName, {
      name: "汇率",
      toPosition: 1,
      orderRevision: 5,
    });
    assert.equal(ended.ok, false);
    assert.deepEqual(f.order(), ids);
    assert.equal(f.store.snapshot().workbenchActions.length, 0);
  } finally {
    f.close();
  }
});
