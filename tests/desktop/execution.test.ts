import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import type { Command, HostCommand, Turn } from "../../src/shared/protocol";

mkdirSync(".test-data/disposable", { recursive: true });
function root() {
  return mkdtempSync(resolve(".test-data/disposable/execution-"));
}
/** A store with one conversation and one usable connection; returns their ids. */
function seed(store: Store) {
  const conversationId = randomUUID(),
    connectionId = randomUUID();
  assert.equal(
    store.execute({ type: "create", id: conversationId }, "main").ok,
    true,
  );
  assert.equal(
    store.execute(
      {
        type: "upsertConnection",
        id: connectionId,
        name: "模拟连接",
        provider: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "test-model",
        secretRef: randomUUID(),
        imageInput: "unknown" as const,
        contextChars: null,
        revision: 0,
      },
      "main",
    ).ok,
    true,
  );
  return { conversationId, connectionId };
}
function submit(
  store: Store,
  ids: ReturnType<typeof seed>,
  requestId = randomUUID(),
) {
  const command: Command = {
    type: "submitTurn",
    requestId,
    conversationId: ids.conversationId,
    connectionId: ids.connectionId,
    text: "你好",
  };
  const reply = store.execute(command, "main");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  // Snapshots only carry the selected conversations, so fall back to the table for other conversations.
  const turn = store.snapshot().turns.find((t) => t.requestId === requestId);
  if (turn) return turn;
  return store.db
    .prepare(
      "SELECT t.id, t.state, e.id AS executionId FROM turns t JOIN executions e ON e.turn_id = t.id WHERE t.request_id=?",
    )
    .get(requestId) as unknown as Turn;
}
function turnStates(store: Store) {
  return Object.fromEntries(
    (
      store.db
        .prepare("SELECT id, state, partial_text AS partialText FROM turns")
        .all() as { id: string; state: string; partialText: string }[]
    ).map((t) => [t.id, t]),
  );
}
function host(store: Store, command: HostCommand) {
  return store.execute(command, "main", "host");
}
function events(store: Store) {
  return store.db
    .prepare(
      "SELECT execution_id AS executionId, kind, payload FROM run_events ORDER BY seq",
    )
    .all() as { executionId: string; kind: string; payload: string }[];
}

test("提交按 request_id 去重，草稿在同一事务清空；缺连接、缺模型或缺对话时不启动", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    store.execute(
      { type: "saveDraft", id: ids.conversationId, text: "你好", revision: 0 },
      "main",
    );
    const requestId = randomUUID();
    const turn = submit(store, ids, requestId);
    const again = submit(store, ids, requestId);
    assert.equal(again.id, turn.id);
    const snapshot = store.snapshot();
    assert.equal(snapshot.turns.length, 1);
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].role, "user");
    assert.equal(snapshot.conversations[0].draft, "");
    assert.equal(turn.state, "queued");
    assert.deepEqual(turn.connection, {
      connectionId: ids.connectionId,
      name: "模拟连接",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      revision: 0,
      effort: null,
    });
    assert.deepEqual(
      events(store).map((e) => e.kind),
      ["submitted"],
    );
    const empty = randomUUID();
    store.execute(
      {
        type: "upsertConnection",
        id: empty,
        name: "无模型",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "",
        secretRef: null,
        imageInput: "unknown" as const,
        contextChars: null,
        revision: 0,
      },
      "main",
    );
    for (const [connectionId, conversationId, code] of [
      [randomUUID(), ids.conversationId, "NOT_FOUND"],
      [empty, ids.conversationId, "CONFLICT"],
      [ids.connectionId, randomUUID(), "NOT_FOUND"],
    ] as const) {
      const reply = store.execute(
        {
          type: "submitTurn",
          requestId: randomUUID(),
          conversationId,
          connectionId,
          text: "x",
        },
        "main",
      );
      assert.equal(reply.ok, false);
      if (!reply.ok) assert.equal(reply.code, code);
    }
    assert.equal(
      store.execute(
        {
          type: "submitTurn",
          requestId: randomUUID(),
          conversationId: ids.conversationId,
          connectionId: ids.connectionId,
          text: "   ",
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(store.snapshot().turns.length, 1);
    assert.equal(events(store).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("提交事务失败时不产生消息、回合、执行或事件", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    const before = store.snapshot();
    store.db.exec("PRAGMA query_only=ON");
    const reply = store.execute(
      {
        type: "submitTurn",
        requestId: randomUUID(),
        conversationId: ids.conversationId,
        connectionId: ids.connectionId,
        text: "写不进去",
      },
      "main",
    );
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.match(reply.message, /没有开始执行/);
    store.db.exec("PRAGMA query_only=OFF");
    assert.deepEqual(store.snapshot(), before);
    assert.equal(events(store).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("运行事件只追加：UPDATE 与 DELETE 被触发器拒绝，原行不变", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    submit(store, ids);
    const before = events(store);
    assert.throws(
      () => store.db.exec("UPDATE run_events SET kind='completed'"),
      /append-only/,
    );
    assert.throws(() => store.db.exec("DELETE FROM run_events"), /append-only/);
    assert.deepEqual(events(store), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("适配器回报按序号去重并推进状态；完成写入助手消息；失败建立待处理", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    const turn = submit(store, ids);
    const e = turn.executionId;
    assert.equal(
      host(store, { type: "beginExecution", executionId: e }).ok,
      true,
    );
    assert.equal(store.snapshot().turns[0].state, "running");
    host(store, { type: "reportDelta", executionId: e, seq: 1, text: "你" });
    host(store, { type: "reportDelta", executionId: e, seq: 1, text: "你" });
    host(store, { type: "reportDelta", executionId: e, seq: 2, text: "好" });
    assert.equal(store.snapshot().turns[0].partialText, "你好");
    host(store, { type: "reportFinished", executionId: e, seq: 3 });
    const done = store.snapshot();
    assert.equal(done.turns[0].state, "completed");
    assert.deepEqual(
      done.messages.map((m) => [m.role, m.content]),
      [
        ["user", "你好"],
        ["assistant", "你好"],
      ],
    );
    assert.deepEqual(
      events(store).map((x) => x.kind),
      ["submitted", "started", "completed"],
    );
    assert.equal(done.pendingItems.length, 0);
    // A second turn fails: the failure is classified and lands in pending.
    const failing = submit(store, ids);
    // While it is open, the same conversation refuses another submission.
    const serial = store.execute(
      {
        type: "submitTurn",
        requestId: randomUUID(),
        conversationId: ids.conversationId,
        connectionId: ids.connectionId,
        text: "再来一条",
      },
      "main",
    );
    assert.equal(serial.ok, false);
    if (!serial.ok) assert.match(serial.message, /还有回合在执行/);
    host(store, {
      type: "reportFailed",
      executionId: failing.executionId,
      seq: 1,
      errorClass: "auth",
      message: "401",
    });
    const failed = store.snapshot();
    const view = failed.turns.find((t) => t.id === failing.id)!;
    assert.equal(view.state, "failed");
    assert.equal(view.errorClass, "auth");
    assert.equal(failed.pendingItems.length, 1);
    assert.equal(failed.pendingItems[0].kind, "failed_turn");
    assert.equal(failed.pendingItems[0].turnId, failing.id);
    // Unknown execution and renderer-originated host commands are rejected.
    assert.equal(
      host(store, { type: "beginExecution", executionId: randomUUID() }).ok,
      false,
    );
    assert.equal(
      store.execute({ type: "beginExecution", executionId: e }, "main").ok,
      false,
    );
    assert.equal(store.execute({ type: "snapshot" }, "main", "host").ok, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("停止幂等：先停止中再已停止；终态后的迟到结果只留痕不改状态", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    const turn = submit(store, ids);
    const e = turn.executionId;
    host(store, { type: "beginExecution", executionId: e });
    host(store, { type: "reportDelta", executionId: e, seq: 1, text: "部分" });
    for (let i = 0; i < 3; i++)
      assert.equal(
        store.execute({ type: "stopExecution", executionId: e }, "panel").ok,
        true,
      );
    assert.equal(store.snapshot().turns[0].state, "stopping");
    assert.equal(
      events(store).filter((x) => x.kind === "stop_requested").length,
      1,
    );
    host(store, { type: "reportStopped", executionId: e, seq: 2 });
    const stopped = store.snapshot();
    assert.equal(stopped.turns[0].state, "stopped");
    assert.equal(stopped.turns[0].partialText, "部分");
    assert.notEqual(stopped.turns[0].endedAt, null);
    const frozen = stopped.turns[0];
    host(store, { type: "reportDelta", executionId: e, seq: 3, text: "迟到" });
    host(store, { type: "reportFinished", executionId: e, seq: 4 });
    host(store, { type: "beginExecution", executionId: e });
    const after = store.snapshot();
    assert.deepEqual(after.turns[0], frozen);
    assert.equal(after.messages.length, 1);
    assert.equal(
      events(store).filter((x) => x.kind === "late_result").length,
      3,
    );
    assert.equal(
      store.execute({ type: "stopExecution", executionId: e }, "main").ok,
      true,
    );
    assert.equal(
      store.execute(
        { type: "stopExecution", executionId: randomUUID() },
        "main",
      ).ok,
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("崩溃后重开：未结束执行标记已中断、追加事件、建立待处理，原事件不变；处理后退出列表", () => {
  const dir = root();
  let store = new Store(dir);
  const ids = seed(store);
  try {
    const running = submit(store, ids);
    host(store, { type: "beginExecution", executionId: running.executionId });
    host(store, {
      type: "reportDelta",
      executionId: running.executionId,
      seq: 1,
      text: "一半",
    });
    // Turns are serial per conversation, so the other turns live in their own conversations.
    const second = { ...ids, conversationId: randomUUID() };
    const third = { ...ids, conversationId: randomUUID() };
    for (const extra of [second, third])
      store.execute({ type: "create", id: extra.conversationId }, "main");
    const queued = submit(store, second);
    const finished = submit(store, third);
    host(store, {
      type: "reportFinished",
      executionId: finished.executionId,
      seq: 1,
    });
    const before = events(store);
    // Simulate a crash: the lock database releases without a clean shutdown path.
    store.db.close();
    store.close = () => {};
    (store as unknown as { lock: { close: () => void } }).lock.close();
    store = new Store(dir);
    const snapshot = store.snapshot();
    const byId = turnStates(store);
    assert.equal(byId[running.id].state, "interrupted");
    assert.equal(byId[running.id].partialText, "一半");
    assert.equal(byId[queued.id].state, "interrupted");
    assert.equal(byId[finished.id].state, "completed");
    assert.deepEqual(events(store).slice(0, before.length), before);
    assert.deepEqual(
      events(store)
        .slice(before.length)
        .map((x) => x.kind),
      ["interrupted", "interrupted"],
    );
    assert.equal(snapshot.pendingItems.length, 2);
    assert.deepEqual(
      new Set(snapshot.pendingItems.map((p) => p.kind)),
      new Set(["interrupted_turn"]),
    );
    // Newest first, so the most recent interruption is what the user sees at the top.
    assert.ok(
      snapshot.pendingItems[0].createdAt >= snapshot.pendingItems[1].createdAt,
    );
    // Reopening again does not duplicate interrupted events or pending items.
    store.close();
    store = new Store(dir);
    assert.equal(store.snapshot().pendingItems.length, 2);
    assert.equal(
      events(store).filter((x) => x.kind === "interrupted").length,
      2,
    );
    const item = store.snapshot().pendingItems[0];
    for (let i = 0; i < 2; i++)
      assert.equal(
        store.execute(
          { type: "resolvePending", id: item.id, action: "dismiss" },
          "main",
        ).ok,
        true,
      );
    assert.equal(store.snapshot().pendingItems.length, 1);
    assert.equal(
      events(store).filter((x) => x.kind === "pending_resolved").length,
      1,
    );
    assert.equal(
      store.execute(
        { type: "resolvePending", id: randomUUID(), action: "dismiss" },
        "main",
      ).ok,
      false,
    );
    assert.equal(store.snapshot().events[0].kind, "pending_resolved");
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("回合上下文只含该对话到本回合用户消息为止的内容；停止超时只在停止中留痕", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    const first = submit(store, ids);
    host(store, {
      type: "reportDelta",
      executionId: first.executionId,
      seq: 1,
      text: "第一答",
    });
    host(store, {
      type: "reportFinished",
      executionId: first.executionId,
      seq: 2,
    });
    const other = { ...ids, conversationId: randomUUID() };
    store.execute({ type: "create", id: other.conversationId }, "main");
    submit(store, other);
    const second = submit(store, ids);
    const context = host(store, {
      type: "loadTurnContext",
      executionId: second.executionId,
    });
    assert.equal(context.ok, true);
    if (context.ok)
      assert.deepEqual(
        context.messages?.map((m) => [m.role, m.content]),
        [
          ["user", "你好"],
          ["assistant", "第一答"],
          ["user", "你好"],
        ],
      );
    assert.equal(
      host(store, { type: "loadTurnContext", executionId: randomUUID() }).ok,
      false,
    );
    // stop_timeout is only meaningful while stopping; otherwise it is ignored.
    host(store, { type: "reportStopTimeout", executionId: second.executionId });
    assert.equal(
      events(store).filter((e) => e.kind === "stop_timeout").length,
      0,
    );
    store.execute(
      { type: "stopExecution", executionId: second.executionId },
      "main",
    );
    host(store, { type: "reportStopTimeout", executionId: second.executionId });
    host(store, { type: "reportStopTimeout", executionId: second.executionId });
    assert.equal(
      events(store).filter((e) => e.kind === "stop_timeout").length,
      2,
    );
    assert.equal(turnStates(store)[second.id].state, "stopping");
    assert.equal(
      store.execute(
        { type: "loadTurnContext", executionId: second.executionId },
        "main",
      ).ok,
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("停止或失败后保留的部分回答随追问进入上下文并标明未完成；重试清空后不再携带；预算计入该文本", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    // Stopped after some text: the follow-up sees that text as an unfinished answer.
    const stopped = submit(store, ids);
    host(store, { type: "beginExecution", executionId: stopped.executionId });
    host(store, {
      type: "reportDelta",
      executionId: stopped.executionId,
      seq: 1,
      text: "停止前收到的",
    });
    store.execute(
      { type: "stopExecution", executionId: stopped.executionId },
      "main",
    );
    host(store, {
      type: "reportStopped",
      executionId: stopped.executionId,
      seq: 2,
    });
    const failed = submit(store, ids);
    host(store, { type: "beginExecution", executionId: failed.executionId });
    host(store, {
      type: "reportDelta",
      executionId: failed.executionId,
      seq: 1,
      text: "断流前收到的",
    });
    host(store, {
      type: "reportFailed",
      executionId: failed.executionId,
      seq: 2,
      errorClass: "stream",
      message: "输出中断",
    });
    // Stopped before any text: nothing to carry, the question simply stays unanswered.
    const empty = submit(store, ids);
    host(store, { type: "beginExecution", executionId: empty.executionId });
    store.execute(
      { type: "stopExecution", executionId: empty.executionId },
      "main",
    );
    host(store, {
      type: "reportStopped",
      executionId: empty.executionId,
      seq: 1,
    });
    const follow = submit(store, ids);
    const context = host(store, {
      type: "loadTurnContext",
      executionId: follow.executionId,
    });
    assert.equal(context.ok, true);
    if (context.ok) {
      assert.deepEqual(
        context.messages?.map((m) => [m.role, m.content]),
        [
          ["user", "你好"],
          ["assistant", "停止前收到的\n\n（回答未完成：已停止。）"],
          ["user", "你好"],
          ["assistant", "断流前收到的\n\n（回答未完成：失败。）"],
          ["user", "你好"],
          ["user", "你好"],
        ],
      );
      // Unfinished answers are context only: they are not saved messages.
      assert.equal(store.snapshot().messages.length, 4);
    }
    host(store, { type: "beginExecution", executionId: follow.executionId });
    host(store, {
      type: "reportFinished",
      executionId: follow.executionId,
      seq: 1,
    });
    // Retrying the failed turn clears its partial text: its own context carries neither the old text nor a duplicate.
    const pending = store
      .snapshot()
      .pendingItems.find((p) => p.turnId === failed.id)!;
    assert.equal(
      store.execute(
        { type: "resolvePending", id: pending.id, action: "retry" },
        "main",
      ).ok,
      true,
    );
    const retried = store.snapshot().turns.find((t) => t.id === failed.id)!;
    const retryContext = host(store, {
      type: "loadTurnContext",
      executionId: retried.executionId,
    });
    if (retryContext.ok)
      assert.deepEqual(
        retryContext.messages?.map((m) => [m.role, m.content]),
        [
          ["user", "你好"],
          ["assistant", "停止前收到的\n\n（回答未完成：已停止。）"],
          ["user", "你好"],
        ],
      );
    host(store, { type: "beginExecution", executionId: retried.executionId });
    host(store, {
      type: "reportFinished",
      executionId: retried.executionId,
      seq: 1,
    });
    // The budget counts the unfinished text the model will receive: 4 × 2 saved + 6 partial + 990 new = 1,004 > 1,000; without the partial text it would fit.
    const shrink = store.execute(
      {
        type: "upsertConnection",
        id: ids.connectionId,
        name: "模拟连接",
        provider: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "test-model",
        secretRef: randomUUID(),
        imageInput: "unknown",
        contextChars: 1000,
        revision: 0,
      },
      "main",
    );
    assert.equal(shrink.ok, true, JSON.stringify(shrink));
    const over = store.execute(
      {
        type: "submitTurn",
        requestId: randomUUID(),
        conversationId: ids.conversationId,
        connectionId: ids.connectionId,
        text: "问".repeat(990),
      },
      "main",
    );
    assert.equal(over.ok, false);
    if (!over.ok)
      assert.match(
        over.message,
        /约 1,004 字符，超过连接“模拟连接”的上下文预算 1,000 字符/,
      );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("待处理重试建立新执行并沿用原回合与消息，原失败事件不变；重复重试与冲突被拒绝", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = seed(store);
    const turn = submit(store, ids);
    host(store, { type: "beginExecution", executionId: turn.executionId });
    host(store, {
      type: "reportDelta",
      executionId: turn.executionId,
      seq: 1,
      text: "半截",
    });
    host(store, {
      type: "reportFailed",
      executionId: turn.executionId,
      seq: 2,
      errorClass: "stream",
      message: "cut",
    });
    const before = events(store);
    const item = store.snapshot().pendingItems[0];
    assert.equal(item.kind, "failed_turn");
    for (let i = 0; i < 2; i++)
      assert.equal(
        store.execute(
          { type: "resolvePending", id: item.id, action: "retry" },
          "main",
        ).ok,
        true,
      );
    const retried = store.snapshot().turns.find((t) => t.id === turn.id)!;
    assert.equal(retried.state, "queued");
    assert.equal(retried.attempt, 2);
    assert.equal(retried.partialText, "");
    assert.notEqual(retried.executionId, turn.executionId);
    assert.equal(store.snapshot().activeTurns.length, 1);
    assert.equal(store.snapshot().pendingItems.length, 0);
    assert.equal(store.snapshot().messages.length, 1);
    assert.deepEqual(events(store).slice(0, before.length), before);
    assert.deepEqual(
      events(store)
        .slice(before.length)
        .map((e) => e.kind),
      ["retried", "pending_resolved"],
    );
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT partial_text AS partialText FROM executions WHERE id=?",
          )
          .get(turn.executionId) as { partialText: string }
      ).partialText,
      "半截",
    );
    // The retried attempt completes: the assistant message belongs to the same turn.
    host(store, {
      type: "reportDelta",
      executionId: retried.executionId,
      seq: 1,
      text: "完整回答",
    });
    host(store, {
      type: "reportFinished",
      executionId: retried.executionId,
      seq: 2,
    });
    assert.deepEqual(
      store.snapshot().messages.map((m) => [m.role, m.content, m.turnId]),
      [
        ["user", "你好", turn.id],
        ["assistant", "完整回答", turn.id],
      ],
    );
    assert.equal(store.snapshot().activeTurns.length, 0);
    assert.equal(store.snapshot().conversations[0].preview, "完整回答");
    assert.equal(store.snapshot().conversations[0].messageCount, 2);
    // A retry is refused while another turn of the conversation is open.
    const second = submit(store, ids);
    host(store, {
      type: "reportFailed",
      executionId: second.executionId,
      seq: 1,
      errorClass: "auth",
      message: "401",
    });
    const pendingSecond = store.snapshot().pendingItems[0];
    const third = submit(store, ids);
    const blocked = store.execute(
      { type: "resolvePending", id: pendingSecond.id, action: "retry" },
      "main",
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.message, /还有回合在执行/);
    host(store, {
      type: "reportFinished",
      executionId: third.executionId,
      seq: 1,
    });
    assert.equal(
      store.execute(
        { type: "resolvePending", id: pendingSecond.id, action: "retry" },
        "main",
      ).ok,
      true,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("宿主中断命令把未结束执行记为已中断并建立待处理，终态不受影响；统计开关默认关闭且可持久保存", () => {
  const dir = root();
  let store = new Store(dir);
  try {
    const ids = seed(store);
    const turn = submit(store, ids);
    host(store, { type: "beginExecution", executionId: turn.executionId });
    store.execute(
      { type: "stopExecution", executionId: turn.executionId },
      "main",
    );
    host(store, { type: "reportInterrupted", executionId: turn.executionId });
    host(store, { type: "reportInterrupted", executionId: turn.executionId });
    const snapshot = store.snapshot();
    assert.equal(snapshot.turns[0].state, "interrupted");
    assert.equal(snapshot.pendingItems.length, 1);
    assert.equal(
      events(store).filter((e) => e.kind === "interrupted").length,
      1,
    );
    assert.equal(snapshot.settings.telemetryEnabled, false);
    assert.equal(
      store.execute({ type: "setTelemetry", enabled: true }, "main").ok,
      true,
    );
    assert.equal(
      store.execute({ type: "setTelemetry", enabled: "yes" }, "main").ok,
      false,
    );
    store.close();
    store = new Store(dir);
    assert.equal(store.snapshot().settings.telemetryEnabled, true);
    assert.equal(
      store.execute({ type: "setTelemetry", enabled: false }, "panel").ok,
      true,
    );
    assert.equal(store.snapshot().settings.telemetryEnabled, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("对话级连接选择与提供方范围授权持久化；被活动回合或默认值引用的连接不能删除，删除已选连接回退默认", () => {
  const dir = root();
  let store = new Store(dir);
  try {
    const ids = seed(store);
    const other = randomUUID();
    store.execute(
      {
        type: "upsertConnection",
        id: other,
        name: "另一家",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        secretRef: randomUUID(),
        imageInput: "unknown" as const,
        contextChars: null,
        revision: 0,
      },
      "main",
    );
    assert.equal(
      store.execute(
        {
          type: "chooseConnection",
          conversationId: ids.conversationId,
          connectionId: other,
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(
      store.execute(
        {
          type: "chooseConnection",
          conversationId: ids.conversationId,
          connectionId: randomUUID(),
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "grantProviderScope",
          conversationId: ids.conversationId,
          provider: "deepseek",
        },
        "main",
      ).ok,
      true,
    );
    store.execute(
      {
        type: "grantProviderScope",
        conversationId: ids.conversationId,
        provider: "deepseek",
      },
      "main",
    );
    assert.equal(
      store.execute(
        {
          type: "grantProviderScope",
          conversationId: ids.conversationId,
          provider: "openai",
        },
        "main",
      ).ok,
      false,
    );
    let conversation = store.snapshot().conversations[0];
    assert.equal(conversation.connectionId, other);
    assert.deepEqual(conversation.grantedProviders, ["deepseek"]);
    assert.equal(conversation.lastProvider, null);
    // A completed turn records the provider that answered last.
    const turn = submit(store, ids);
    host(store, {
      type: "reportFinished",
      executionId: turn.executionId,
      seq: 1,
    });
    assert.equal(store.snapshot().conversations[0].lastProvider, "custom");
    // A running turn pins its connection: deletion is refused until it ends.
    const second = submit(store, ids);
    host(store, { type: "beginExecution", executionId: second.executionId });
    const busy = store.execute(
      { type: "deleteConnection", id: ids.connectionId },
      "main",
    );
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.match(busy.message, /执行中的回合/);
    host(store, {
      type: "reportFinished",
      executionId: second.executionId,
      seq: 1,
    });
    store.close();
    store = new Store(dir);
    conversation = store.snapshot().conversations[0];
    assert.equal(conversation.connectionId, other);
    assert.deepEqual(conversation.grantedProviders, ["deepseek"]);
    // Deleting the chosen connection clears the choice; the default remains untouched.
    assert.equal(
      store.execute({ type: "deleteConnection", id: other }, "main").ok,
      true,
    );
    assert.equal(store.snapshot().conversations[0].connectionId, null);
    assert.equal(store.snapshot().turns.length, 2);
    assert.equal(store.snapshot().turns[0].connection.name, "模拟连接");
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("待处理按不同的已发生时间倒序显示，重启后顺序不变", () => {
  const dir = root();
  let store = new Store(dir);
  try {
    const ids = seed(store);
    const expected: string[] = [];
    for (const time of [
      "2026-09-01T00:00:00Z",
      "2026-09-03T00:00:00Z",
      "2026-09-02T00:00:00Z",
    ]) {
      const turn = submit(store, ids);
      assert.equal(
        host(store, {
          type: "reportFailed",
          executionId: turn.executionId,
          seq: 1,
          errorClass: "network",
          message: "合成网络失败",
        }).ok,
        true,
      );
      // Distinct times make an ascending-sort regression observable, even on fast machines.
      store.db
        .prepare("UPDATE pending_items SET created_at=? WHERE execution_id=?")
        .run(time, turn.executionId);
      expected.push(turn.id);
    }
    const order = [expected[1], expected[2], expected[0]];
    assert.deepEqual(
      store.snapshot().pendingItems.map((p) => p.turnId),
      order,
    );
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.snapshot().pendingItems.map((p) => p.turnId),
      order,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
