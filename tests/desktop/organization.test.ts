import {
  parseConversationLink,
  conversationLink,
} from "../../src/shared/conversation-link";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/service/store";
import type { ConversationAction } from "../../src/shared/protocol";
mkdirSync(".test-data/disposable", { recursive: true });
function fixture() {
  const dir = mkdtempSync(resolve(".test-data/disposable/organization-"));
  const store = new Store(dir);
  const id = randomUUID();
  assert.ok(store.execute({ type: "create", id }, "main").ok);
  return {
    store,
    id,
    dir,
    close() {
      store.close();
      rmSync(dir, { recursive: true });
    },
  };
}
function action(
  store: Store,
  id: string,
  action: ConversationAction,
  confirmed = false,
  revision?: number,
) {
  const c = store.snapshot().conversations.find((c) => c.id === id)!;
  return store.execute(
    {
      type: "organizeConversation",
      id,
      action,
      revision: revision ?? c.organizationRevision,
      confirmed,
    },
    "main",
  );
}
test("对话组织使用独立修订，置顶与未读持久，过期及写失败保持数据与事件", () => {
  const f = fixture();
  try {
    const second = randomUUID();
    f.store.execute({ type: "create", id: second }, "main");
    assert.ok(action(f.store, f.id, "pin").ok);
    assert.equal(f.store.snapshot().conversations[0].id, f.id);
    assert.ok(action(f.store, f.id, "unread").ok);
    assert.ok(
      f.store.execute(
        { type: "saveDraft", id: f.id, text: "草稿", revision: 0 },
        "panel",
      ).ok,
    );
    const before = f.store.snapshot();
    assert.equal(action(f.store, f.id, "unpin", false, 0).ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    f.store.db.exec("PRAGMA query_only=ON");
    assert.equal(action(f.store, f.id, "unpin").ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    f.store.db.exec("PRAGMA query_only=OFF");
    f.store.close();
    const reopened = new Store(f.dir);
    assert.deepEqual(reopened.snapshot(), before);
    reopened.close();
    f.close = () => rmSync(f.dir, { recursive: true });
  } finally {
    f.close();
  }
});
test("删除需要确认，活动回合拒绝，删除后拒绝选择写入和重试，恢复原身份与内容", () => {
  const f = fixture();
  try {
    assert.ok(
      f.store.execute(
        { type: "saveDraft", id: f.id, text: "原草稿", revision: 0 },
        "main",
      ).ok,
    );
    const before = f.store.snapshot();
    assert.equal(action(f.store, f.id, "delete").ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    const turn = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO turns(id,conversation_id,request_id,connection_snapshot,state,created_at) VALUES(?,?,?,'{}','running',?)",
      )
      .run(turn, f.id, randomUUID(), new Date().toISOString());
    assert.equal(action(f.store, f.id, "delete", true).ok, false);
    f.store.db.prepare("UPDATE turns SET state='stopped' WHERE id=?").run(turn);
    assert.ok(action(f.store, f.id, "delete", true).ok);
    const deleted = f.store.snapshot();
    assert.equal(deleted.selected.main, null);
    assert.ok(deleted.conversations[0].deletedAt);
    assert.ok(
      Date.parse(deleted.conversations[0].retainUntil!) -
        Date.parse(deleted.conversations[0].deletedAt!) >=
        30 * 86400000,
    );
    assert.equal(
      f.store.execute({ type: "select", id: f.id }, "main").ok,
      false,
    );
    assert.equal(
      f.store.execute(
        { type: "saveDraft", id: f.id, text: "迟到", revision: 1 },
        "panel",
      ).ok,
      false,
    );
    assert.ok(action(f.store, f.id, "extend").ok);
    assert.ok(action(f.store, f.id, "restore").ok);
    assert.equal(f.store.snapshot().conversations[0].draft, "原草稿");
    assert.ok(f.store.execute({ type: "select", id: f.id }, "main").ok);
    assert.equal(f.store.snapshot().conversations[0].id, f.id);
  } finally {
    f.close();
  }
});
test("永久删除单独确认，删除正文及草稿但原事件不改写，不能重新选择", () => {
  const f = fixture();
  try {
    const mid = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user','永久删除内容',?)",
      )
      .run(mid, f.id, new Date().toISOString());
    assert.ok(action(f.store, f.id, "delete", true).ok);
    const events = f.store.snapshot().events;
    assert.equal(action(f.store, f.id, "purge").ok, false);
    assert.ok(action(f.store, f.id, "purge", true).ok);
    assert.equal(f.store.snapshot().conversations.length, 0);
    assert.deepEqual(f.store.snapshot().events.slice(1), events);
    assert.equal(
      f.store.db.prepare("SELECT * FROM messages WHERE id=?").get(mid),
      undefined,
    );
    assert.equal(
      f.store.execute({ type: "select", id: f.id }, "main").ok,
      false,
    );
  } finally {
    f.close();
  }
});

test("外观持久、非法模式拒绝，导出仅含已保存标题消息且renderer不能调用宿主接口", () => {
  const f = fixture();
  try {
    assert.equal(f.store.snapshot().settings.appearance, "light");
    assert.ok(
      f.store.execute({ type: "setAppearance", appearance: "auto" }, "main").ok,
    );
    assert.equal(
      f.store.execute({ type: "setAppearance", appearance: "invalid" }, "main")
        .ok,
      false,
    );
    f.store.execute(
      { type: "saveDraft", id: f.id, text: "未发送草稿秘密", revision: 0 },
      "main",
    );
    f.store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user','已发送内容',?)",
      )
      .run(randomUUID(), f.id, new Date().toISOString());
    assert.equal(
      f.store.execute({ type: "exportConversation", id: f.id }, "main").ok,
      false,
    );
    const result = f.store.execute(
      { type: "exportConversation", id: f.id },
      "main",
      "host",
    );
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(result.markdown?.includes("已发送内容"));
      assert.ok(!result.markdown?.includes("未发送草稿秘密"));
    }
    f.store.close();
    const reopened = new Store(f.dir);
    assert.equal(reopened.snapshot().settings.appearance, "auto");
    reopened.close();
    f.close = () => rmSync(f.dir, { recursive: true });
  } finally {
    f.close();
  }
});

test("对话链接只接受规范协议和UUID，不接受外部地址、路径及附加参数", () => {
  const id = randomUUID();
  assert.equal(parseConversationLink(conversationLink(id)), id);
  for (const value of [
    "https://example.com",
    `csthink-assistant://conversation/${id}?send=1`,
    `csthink-assistant://conversation/${id}#x`,
    `csthink-assistant://other/${id}`,
    "csthink-assistant://conversation/../../file",
    `csthink-assistant://conversation/%${id}`,
    null,
  ])
    assert.equal(parseConversationLink(value), null);
});

test("归档发送同事务返回最近列表，写失败保持归档，重复发送确认不取消后续归档", () => {
  const f = fixture();
  try {
    const connectionId = randomUUID();
    assert.ok(
      f.store.execute(
        {
          type: "upsertConnection",
          id: connectionId,
          name: "模拟连接",
          provider: "custom",
          baseUrl: "http://127.0.0.1:1/v1",
          model: "test-model",
          secretRef: randomUUID(),
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        },
        "main",
      ).ok,
    );
    assert.ok(action(f.store, f.id, "archive").ok);
    const command = {
      type: "submitTurn" as const,
      requestId: randomUUID(),
      conversationId: f.id,
      connectionId,
      text: "归档后继续",
    };
    const before = f.store.snapshot();
    f.store.db.exec("PRAGMA query_only=ON");
    assert.equal(f.store.execute(command, "main").ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    f.store.db.exec("PRAGMA query_only=OFF");
    assert.ok(f.store.execute(command, "main").ok);
    assert.equal(f.store.snapshot().conversations[0].archivedAt, null);
    assert.ok(action(f.store, f.id, "archive").ok);
    const archived = f.store.snapshot();
    assert.ok(f.store.execute(command, "main").ok);
    assert.deepEqual(f.store.snapshot(), {
      ...archived,
      revision: archived.revision + 1,
    });
  } finally {
    f.close();
  }
});

test("浅色默认不覆盖已保存的深色或自动外观", () => {
  const dir = mkdtempSync(resolve(".test-data/disposable/appearance-"));
  let store = new Store(dir);
  try {
    assert.equal(store.snapshot().settings.appearance, "light");
    for (const appearance of ["dark", "auto", "light"] as const) {
      assert.ok(
        store.execute({ type: "setAppearance", appearance }, "main").ok,
      );
      store.close();
      store = new Store(dir);
      assert.equal(store.snapshot().settings.appearance, appearance);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
