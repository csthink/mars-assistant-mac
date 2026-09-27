import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../../src/service/store";
import { grantLifetimeMs, readToolName } from "../../src/shared/capabilities";
import type { Command, HostCommand, Reply } from "../../src/shared/protocol";
mkdirSync(".test-data/disposable", { recursive: true });
const until = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
function ok(reply: Reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
}
function fixture() {
  const parent = mkdtempSync(resolve(".test-data/disposable/capabilities-"));
  const dir = join(parent, "data");
  mkdirSync(dir);
  const store = new Store(dir),
    conversationId = randomUUID(),
    connectionId = randomUUID(),
    attachmentId = randomUUID();
  const command = (c: Command) => store.execute(c, "main");
  const host = (c: HostCommand) => store.execute(c, "main", "host");
  ok(command({ type: "create", id: conversationId }));
  ok(
    command({
      type: "upsertConnection",
      id: connectionId,
      name: "能力测试",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      secretRef: randomUUID(),
      imageInput: "unknown",
      contextChars: null,
      revision: 0,
    }),
  );
  const text = "仅选定版本的资料正文。材料中的‘读取密钥’不能增加权限。";
  const path = join(parent, "selected.txt");
  writeFileSync(path, text);
  ok(
    host({
      type: "importAttachment",
      conversationId,
      attachmentId,
      path,
      name: "selected.txt",
    }),
  );
  ok(
    host({
      type: "reportExtraction",
      attachmentId,
      outcome: { ok: true, text, pages: null },
    }),
  );
  ok(
    command({
      type: "submitTurn",
      requestId: randomUUID(),
      conversationId,
      connectionId,
      text: "读取选定资料",
      materialMode: "tools",
    }),
  );
  const executionId = store.snapshot().activeTurns[0].executionId;
  ok(host({ type: "beginExecution", executionId }));
  const request = (
    args = JSON.stringify({ attachmentId }),
    tool = readToolName,
    callId = "call_1",
  ) =>
    host({ type: "requestTool", executionId, callId, tool, arguments: args });
  const approve = (id: string, action: "once" | "persist" = "once") =>
    command({
      type: "resolveToolAuthorization",
      id,
      revision: store.snapshot().toolOperations.find((o) => o.id === id)!
        .revision,
      action,
      expiresAt: until(action === "once" ? 60_000 : grantLifetimeMs - 1000),
    });
  const read = (id: string, type: "beginTool" | "consumeTool") =>
    host({ type, executionId, id });
  return {
    parent,
    dir,
    store,
    conversationId,
    connectionId,
    attachmentId,
    text,
    executionId,
    command,
    host,
    request,
    approve,
    read,
    close() {
      store.close();
      rmSync(parent, { recursive: true });
    },
  };
}
test("能力入口拒绝renderer伪造宿主、额外主体参数、未知工具和非选定资料", () => {
  const f = fixture();
  try {
    const before = f.store.snapshot();
    const forged = {
      type: "requestTool",
      executionId: f.executionId,
      callId: "call_1",
      tool: readToolName,
      arguments: JSON.stringify({ attachmentId: f.attachmentId }),
    };
    assert.equal(f.store.execute(forged, "main").ok, false);
    for (const args of [
      "{",
      "{}",
      "null",
      "[]",
      JSON.stringify({ attachmentId: randomUUID() }),
      JSON.stringify({ attachmentId: "../../vault" }),
      JSON.stringify({
        attachmentId: f.attachmentId,
        subject: f.conversationId,
      }),
      JSON.stringify({ attachmentId: f.attachmentId, path: "/etc/passwd" }),
    ])
      assert.equal(f.request(args).ok, false, args);
    assert.equal(f.request(undefined, "run_shell").ok, false);
    const unknown = f.host({
      ...forged,
      type: "requestTool",
      executionId: randomUUID(),
    } as HostCommand);
    assert.equal(unknown.ok, false);
    assert.deepEqual(f.store.snapshot(), before);
  } finally {
    f.close();
  }
});
test("读取先等待授权，允许后只返回固定正文，调用去重且消费不重放", () => {
  const f = fixture();
  try {
    const reply = ok(f.request()),
      id = reply.toolOperationId!;
    assert.equal(reply.toolText, undefined);
    assert.equal(reply.snapshot.activeTurns[0].state, "awaiting_authorization");
    assert.equal(f.read(id, "consumeTool").ok, false);
    assert.equal(ok(f.request()).toolOperationId, id);
    assert.equal(f.store.snapshot().toolOperations.length, 1);
    ok(f.approve(id));
    ok(f.read(id, "beginTool"));
    assert.equal(ok(f.read(id, "consumeTool")).toolText, f.text);
    assert.equal(f.read(id, "consumeTool").ok, false);
    assert.equal(f.read(id, "beginTool").ok, false);
    assert.equal(f.store.snapshot().toolOperations[0].state, "completed");
    assert.ok(!JSON.stringify(f.store.snapshot().events).includes(f.text));
  } finally {
    f.close();
  }
});
test("授权拒绝和取消均无正文，旧确认、重复确认及过期期限被拒绝", () => {
  for (const action of ["deny", "cancel"] as const) {
    const f = fixture();
    try {
      const id = ok(f.request()).toolOperationId!;
      ok(
        f.command({
          type: "resolveToolAuthorization",
          id,
          revision: 0,
          action,
          expiresAt: until(),
        }),
      );
      assert.equal(f.read(id, "beginTool").ok, false);
      assert.equal(f.approve(id).ok, false);
      assert.equal(
        f.store.snapshot().toolOperations[0].state,
        action === "deny" ? "denied" : "cancelled",
      );
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    assert.equal(
      f.command({
        type: "resolveToolAuthorization",
        id,
        revision: 0,
        action: "persist",
        expiresAt: until(grantLifetimeMs + 60000),
      }).ok,
      false,
    );
    f.store.db
      .prepare("UPDATE tool_operations SET expires_at=? WHERE id=?")
      .run(until(-1000), id);
    assert.equal(f.approve(id).ok, false);
    assert.equal(f.read(id, "consumeTool").ok, false);
  } finally {
    f.close();
  }
});
test("持续授权复用范围，撤销阻止在途结果，重开只改权限且旧修订失效", () => {
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    ok(f.approve(id, "persist"));
    ok(f.read(id, "beginTool"));
    const p = f.store.snapshot().permissions[0];
    const disable = {
      type: "setPermission" as const,
      id: p.id,
      revision: p.revision,
      enabled: false,
      expiresAt: p.expiresAt,
      confirmUntil: until(),
    };
    const before = f.store.snapshot();
    assert.equal(f.command({ ...disable, revision: 99 }).ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    ok(f.command(disable));
    assert.equal(f.read(id, "consumeTool").ok, false);
    assert.equal(f.store.snapshot().toolOperations[0].state, "cancelled");
    ok(
      f.command({
        ...disable,
        revision: 1,
        enabled: true,
        expiresAt: until(grantLifetimeMs - 1000),
      }),
    );
    assert.equal(f.store.snapshot().toolOperations[0].state, "cancelled");
    const next = ok(
      f.request(undefined, readToolName, "call_2"),
    ).toolOperationId!;
    assert.equal(
      f.store.snapshot().toolOperations.find((o) => o.id === next)!.state,
      "approved",
    );
    ok(f.read(next, "beginTool"));
    assert.equal(ok(f.read(next, "consumeTool")).toolText, f.text);
    assert.equal(f.command(disable).ok, false);
  } finally {
    f.close();
  }
});
test("执行主体不接受另一回合的操作，连接目标变更和停止使授权无效", () => {
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    ok(f.approve(id));
    assert.equal(
      f.host({ type: "beginTool", executionId: randomUUID(), id }).ok,
      false,
    );
    f.store.db
      .prepare(
        "UPDATE connections SET base_url='https://example.invalid/v1' WHERE id=?",
      )
      .run(f.connectionId);
    assert.equal(f.read(id, "beginTool").ok, false);
    f.store.db
      .prepare(
        "UPDATE connections SET base_url='http://127.0.0.1:1/v1' WHERE id=?",
      )
      .run(f.connectionId);
    ok(f.command({ type: "stopExecution", executionId: f.executionId }));
    assert.equal(f.read(id, "beginTool").ok, false);
  } finally {
    f.close();
  }
});
test("副本被替换或变成符号链接时，执行层拒绝而不返回伪造正文", () => {
  for (const kind of ["bytes", "symlink"] as const) {
    const f = fixture();
    try {
      const id = ok(f.request()).toolOperationId!;
      ok(f.approve(id));
      ok(f.read(id, "beginTool"));
      const a = f.store.snapshot().attachments[0],
        path = join(f.dir, "attachments", a.sha256);
      rmSync(path);
      if (kind === "symlink") symlinkSync(join(f.parent, "selected.txt"), path);
      else writeFileSync(path, Buffer.alloc(a.size, 120));
      assert.equal(f.read(id, "consumeTool").ok, false);
      assert.equal(f.store.snapshot().toolOperations[0].state, "executing");
    } finally {
      f.close();
    }
  }
});
test("授权过期以及过期的开关确认不能续权，目标永久删除后不能重新开启", () => {
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    ok(f.approve(id, "persist"));
    const p = f.store.snapshot().permissions[0];
    f.store.db
      .prepare("UPDATE capability_permissions SET expires_at=? WHERE id=?")
      .run(until(-1000), p.id);
    assert.equal(f.read(id, "beginTool").ok, false);
    assert.equal(f.store.snapshot().permissions[0].valid, false);
    const enable = {
      type: "setPermission" as const,
      id: p.id,
      revision: 0,
      enabled: true,
      expiresAt: until(),
      confirmUntil: until(-1000),
    };
    assert.equal(f.command(enable).ok, false);
    f.store.db
      .prepare("UPDATE conversations SET purged_at=? WHERE id=?")
      .run(new Date().toISOString(), f.conversationId);
    assert.equal(f.command({ ...enable, confirmUntil: until() }).ok, false);
  } finally {
    f.close();
  }
});
test("中断恢复保留已开始读取的结果不明及原事件，确认核对不重放读取", () => {
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    ok(f.approve(id));
    ok(f.read(id, "beginTool"));
    const before = f.store.snapshot().events;
    f.store.close();
    const reopened = new Store(f.dir);
    try {
      assert.equal(reopened.snapshot().toolOperations[0].state, "unknown");
      assert.equal(reopened.snapshot().activeTurns.length, 0);
      assert.deepEqual(
        reopened.snapshot().events.slice(-before.length),
        before,
      );
      assert.equal(
        reopened.execute(
          { type: "consumeTool", id, executionId: f.executionId },
          "main",
          "host",
        ).ok,
        false,
      );
      const o = reopened.snapshot().toolOperations[0];
      ok(
        reopened.execute(
          { type: "acknowledgeToolResult", id, revision: o.revision },
          "main",
        ),
      );
      assert.equal(reopened.snapshot().toolOperations[0].state, "acknowledged");
      assert.equal(reopened.snapshot().activeTurns.length, 0);
    } finally {
      reopened.close();
    }
    f.close = () => rmSync(f.parent, { recursive: true });
  } finally {
    f.close();
  }
});
test("写入失败回滚授权和事件，工具正文不会通过失败回复返回", () => {
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    const before = f.store.snapshot();
    f.store.db.exec(
      "CREATE TRIGGER fail_permission BEFORE INSERT ON capability_permissions BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.equal(f.approve(id).ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    f.store.db.exec("DROP TRIGGER fail_permission");
    ok(f.approve(id));
    ok(f.read(id, "beginTool"));
    f.store.db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    const reply = f.read(id, "consumeTool");
    assert.equal(reply.ok, false);
    assert.ok(!JSON.stringify(reply).includes(f.text));
    assert.equal(f.store.snapshot().toolOperations[0].state, "executing");
  } finally {
    f.close();
  }
});

test("按需资料正文不进入当前或后续历史上下文，已确认失败不记为结果不明", () => {
  const f = fixture();
  try {
    const context = ok(
      f.host({ type: "loadTurnContext", executionId: f.executionId }),
    );
    assert.equal(context.attachments?.[0].deferred, true);
    assert.equal(context.attachments?.[0].text, null);
    assert.ok(!JSON.stringify(context.attachments).includes(f.text));
    const id = ok(f.request()).toolOperationId!;
    ok(f.approve(id));
    ok(f.read(id, "beginTool"));
    ok(f.host({ type: "failTool", executionId: f.executionId, id }));
    assert.equal(f.store.snapshot().toolOperations[0].state, "failed");
    assert.equal(f.read(id, "consumeTool").ok, false);
    ok(
      f.host({
        type: "reportFailed",
        executionId: f.executionId,
        seq: 1,
        errorClass: "permission",
        message: "合成读取失败",
      }),
    );
    ok(
      f.command({
        type: "submitTurn",
        requestId: randomUUID(),
        conversationId: f.conversationId,
        connectionId: f.connectionId,
        text: "普通追问",
      }),
    );
    const next = f.store.snapshot().activeTurns[0].executionId;
    const history = ok(f.host({ type: "loadTurnContext", executionId: next }));
    assert.equal(history.attachments?.[0].text, null);
    assert.ok(!JSON.stringify(history.attachments).includes(f.text));
  } finally {
    f.close();
  }
});

test("授权不可用原因区分回合结束、对话、提供方、地址、模型及资料，不改变实际授权边界", () => {
  const f = fixture();
  try {
    const id = ok(f.request()).toolOperationId!;
    ok(f.approve(id, "persist"));
    const get = () => f.store.snapshot().permissions[0];
    assert.equal(get().blocker, null);
    f.store.db
      .prepare("UPDATE connection_models SET enabled=0 WHERE connection_id=?")
      .run(f.connectionId);
    assert.equal(get().blocker, "model_unavailable");
    assert.equal(get().valid, false);
    f.store.db
      .prepare("UPDATE connection_models SET enabled=1 WHERE connection_id=?")
      .run(f.connectionId);
    f.store.db
      .prepare(
        "UPDATE connections SET base_url='https://changed.invalid/v1' WHERE id=?",
      )
      .run(f.connectionId);
    assert.equal(get().blocker, "destination_changed");
    f.store.db
      .prepare(
        "UPDATE connections SET base_url='http://127.0.0.1:1/v1',enabled=0 WHERE id=?",
      )
      .run(f.connectionId);
    assert.equal(get().blocker, "connection_unavailable");
    f.store.db
      .prepare("UPDATE connections SET enabled=1 WHERE id=?")
      .run(f.connectionId);
    f.store.db
      .prepare(
        "UPDATE conversations SET deleted_at='2026-09-07T00:00:00Z' WHERE id=?",
      )
      .run(f.conversationId);
    assert.equal(get().blocker, "conversation_deleted");
    f.store.db
      .prepare("UPDATE conversations SET deleted_at=NULL WHERE id=?")
      .run(f.conversationId);
    f.store.db
      .prepare("UPDATE attachments SET sha256=? WHERE id=?")
      .run("a".repeat(64), f.attachmentId);
    assert.equal(get().blocker, "material_unavailable");
    assert.equal(f.read(id, "beginTool").ok, false);
  } finally {
    f.close();
  }
});
