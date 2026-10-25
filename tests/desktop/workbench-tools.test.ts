import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import type { Command, HostCommand, Reply } from "../../src/shared/protocol";
import {
  deleteWidgetToolName,
  listWidgetsToolName,
  moveWidgetToolName,
} from "../../src/shared/workbench-tools";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { probeTools, TransportError } from "../../src/main/transport";

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

test("workbench tools: an Agent's deletion moves one named widget to recently deleted; same names are asked first, a stale revision or an unknown name deletes nothing, and the result card can undo it", () => {
  const f = fixture();
  try {
    const ids = f.widgets.map((w) => w.id);
    const trash = () => f.store.snapshot().recentlyDeleted!.widgets;
    // Same name: nothing deleted, the candidates go back to the model so it asks first.
    const ambiguous = f.result(
      f.run(deleteWidgetToolName, { name: "便笺", orderRevision: 5 }),
    );
    assert.equal(ambiguous.status, "ambiguous");
    assert.deepEqual(
      ambiguous.candidates.map((c: { widgetId: string }) => c.widgetId),
      [ids[1], ids[3]],
    );
    assert.equal(
      f.result(f.run(deleteWidgetToolName, { name: "股票", orderRevision: 5 }))
        .status,
      "not_found",
    );
    assert.equal(
      f.result(f.run(deleteWidgetToolName, { name: "汇率", orderRevision: 4 }))
        .status,
      "stale",
    );
    assert.deepEqual(f.order(), ids);
    assert.equal(trash().length, 0);
    // Arguments beyond the declared shape, or a position, are refused before anything runs.
    assert.equal(
      f.run(deleteWidgetToolName, {
        name: "汇率",
        orderRevision: 5,
        toPosition: 1,
      }).ok,
      false,
    );
    assert.equal(f.run(deleteWidgetToolName, { orderRevision: 5 }).ok, false);
    const deleted = f.result(
      f.run(
        deleteWidgetToolName,
        { widgetId: ids[3], orderRevision: 5 },
        "call_delete",
      ),
    );
    assert.equal(deleted.status, "deleted");
    assert.deepEqual(f.order(), [ids[0], ids[1], ids[2], ids[4]]);
    assert.deepEqual(
      trash().map((w) => w.id),
      [ids[3]],
    );
    // The same call identity returns the recorded result without deleting again.
    assert.deepEqual(
      f.result(
        f.run(
          deleteWidgetToolName,
          { widgetId: ids[1], orderRevision: 6 },
          "call_delete",
        ),
      ),
      deleted,
    );
    assert.deepEqual(f.order(), [ids[0], ids[1], ids[2], ids[4]]);
    const actions = f.store.snapshot().workbenchActions;
    assert.deepEqual(
      actions.map((a) => [a.tool, a.status]),
      [
        ["delete", "ambiguous"],
        ["delete", "not_found"],
        ["delete", "stale"],
        ["delete", "deleted"],
      ],
    );
    // The card's undo is the ordinary restore: same identity, between its former neighbours.
    ok(
      f.command({
        type: "restoreDeleted",
        kind: "widget",
        id: ids[3],
        revision: trash()[0].trashRevision,
      }),
    );
    assert.deepEqual(f.order(), ids);
  } finally {
    f.close();
  }
});

test("tool call check: a confirmed check records verified, a refused tools parameter records unsupported, other failures keep the measured value, and a new endpoint starts unknown", () => {
  const f = fixture();
  try {
    const model = () =>
      f.store
        .snapshot()
        .connections.find((c) => c.id === f.connectionId)!
        .models.find((m) => m.model === "test-model")!;
    assert.equal(model().toolCalls, "unknown");
    assert.equal(model().toolCallsCheckedAt, null);
    const probe = (finish: (executionId: string) => void) => {
      const executionId = randomUUID();
      ok(
        f.host({
          type: "createExecution",
          executionId,
          kind: "tool_probe",
          connectionId: f.connectionId,
          model: "test-model",
        }),
      );
      ok(f.host({ type: "beginExecution", executionId }));
      finish(executionId);
      return executionId;
    };
    probe((executionId) =>
      ok(f.host({ type: "reportFinished", executionId, seq: 1 })),
    );
    assert.equal(model().toolCalls, "verified");
    assert.ok(model().toolCallsCheckedAt);
    assert.equal(model().lastToolProbe?.state, "completed");
    // An ordinary failure (no tool call made, network, rate limit) changes nothing measured.
    probe((executionId) =>
      ok(
        f.host({
          type: "reportFailed",
          executionId,
          seq: 1,
          errorClass: "protocol",
          message: "工具调用检测未通过",
        }),
      ),
    );
    assert.equal(model().toolCalls, "verified");
    assert.equal(model().lastToolProbe?.state, "failed");
    probe((executionId) => {
      ok(f.host({ type: "reportToolsUnsupported", executionId }));
      ok(
        f.host({
          type: "reportFailed",
          executionId,
          seq: 1,
          errorClass: "unsupported",
          message: "不支持工具调用",
        }),
      );
    });
    assert.equal(model().toolCalls, "unsupported");
    // The check kind never reaches another model or a test of the text call.
    assert.equal(
      f.store.snapshot().connections.find((c) => c.id === f.connectionId)!
        .lastTest,
      null,
    );
    // The fixture's conversation turn uses the connection; it ends before the endpoint changes.
    ok(f.host({ type: "reportFinished", executionId: f.executionId, seq: 1 }));
    const current = f.store
      .snapshot()
      .connections.find((c) => c.id === f.connectionId)!;
    ok(
      f.command({
        type: "upsertConnection",
        id: f.connectionId,
        name: current.name,
        provider: current.provider,
        baseUrl: "http://127.0.0.1:2/v1",
        model: current.model,
        secretRef: current.secretRef,
        imageInput: "unknown",
        contextChars: null,
        revision: current.revision,
      }),
    );
    assert.equal(model().toolCalls, "unknown");
    assert.equal(model().toolCallsCheckedAt, null);
  } finally {
    f.close();
  }
});

test("tool call check request: only the forced call with the issued token confirms; a provider naming tools as unsupported is classified", async () => {
  let reply: (body: Record<string, unknown>) => {
    status: number;
    json: unknown;
  } = () => ({ status: 200, json: {} });
  const seen: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (part) => (text += part));
    request.on("end", () => {
      const body = JSON.parse(text);
      seen.push(body);
      const { status, json } = reply(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    apiKey: "test-only",
    model: "probe-model",
  };
  const call = (token: string, name = "report_tool_probe") => ({
    status: 200,
    json: {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name, arguments: JSON.stringify({ token }) },
              },
            ],
          },
        },
      ],
    },
  });
  const token = (body: Record<string, unknown>) =>
    /token 为 (\w+)/.exec(
      String((body.messages as { content: string }[])[0].content),
    )![1];
  try {
    reply = (body) => call(token(body));
    assert.deepEqual(await probeTools(endpoint), { called: true });
    // The probe leaves tool choice to the provider default, as conversation turns do.
    assert.equal(seen[0].tool_choice, undefined);
    reply = () => call("wrong-token");
    assert.deepEqual(await probeTools(endpoint), { called: false });
    reply = (body) => call(token(body), "other_tool");
    assert.deepEqual(await probeTools(endpoint), { called: false });
    reply = () => ({
      status: 200,
      json: { choices: [{ message: { content: "好的" } }] },
    });
    assert.deepEqual(await probeTools(endpoint), { called: false });
    reply = () => ({
      status: 400,
      json: { error: { message: "This model does not support tools" } },
    });
    await assert.rejects(probeTools(endpoint), (error: TransportError) => {
      assert.equal(error.toolsUnsupported, true);
      return true;
    });
    // DeepSeek thinking mode refuses a forced tool_choice; that is not a measured lack of tool calls.
    reply = () => ({
      status: 400,
      json: {
        error: {
          message: "Thinking mode does not support this tool_choice",
          type: "invalid_request_error",
        },
      },
    });
    await assert.rejects(probeTools(endpoint), (error: TransportError) => {
      assert.equal(error.toolsUnsupported, false);
      return true;
    });
    reply = () => ({
      status: 400,
      json: { error: { message: "Invalid request" } },
    });
    await assert.rejects(probeTools(endpoint), (error: TransportError) => {
      assert.equal(error.toolsUnsupported, false);
      return true;
    });
  } finally {
    server.close();
  }
});
