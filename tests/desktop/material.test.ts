import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, migrations, schemaVersion } from "../../src/service/store";
import { ExtractionQueue } from "../../src/service/extraction";
import {
  validCommand,
  validHostCommand,
  type Command,
  type HostCommand,
  type ImageInput,
  type Reply,
  type Turn,
} from "../../src/shared/protocol";
import { pngSample } from "./samples";

mkdirSync(".test-data/disposable", { recursive: true });
function root() {
  return mkdtempSync(resolve(".test-data/disposable/material-"));
}
function files() {
  return mkdtempSync(resolve(".test-data/disposable/user-files-material-"));
}
function connection(
  store: Store,
  extra: { imageInput?: ImageInput; contextChars?: number | null } = {},
) {
  const id = randomUUID();
  const reply = store.execute(
    {
      type: "upsertConnection",
      id,
      name: `连接 ${id.slice(0, 4)}`,
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      secretRef: randomUUID(),
      imageInput: extra.imageInput ?? "unknown",
      contextChars: extra.contextChars ?? null,
      revision: 0,
    },
    "main",
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return id;
}
function conversation(store: Store) {
  const id = randomUUID();
  assert.equal(store.execute({ type: "create", id }, "main").ok, true);
  return id;
}
function importFile(store: Store, conversationId: string, path: string) {
  const attachmentId = randomUUID();
  const reply = store.execute(
    {
      type: "importAttachment",
      conversationId,
      attachmentId,
      path,
      name: path.split("/").pop()!,
    },
    "main",
    "host",
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return attachmentId;
}
async function extractAll(store: Store) {
  await new Promise<void>((done) => {
    if (!store.pendingExtractions().length) return done();
    const queue = new ExtractionQueue(
      store,
      {
        workerFile: resolve("src/service/extract.ts"),
        execArgv: ["--import", "tsx"],
      },
      () => {
        if (!store.pendingExtractions().length) {
          queue.close();
          done();
        }
      },
    );
    queue.schedule();
  });
}
function submit(
  store: Store,
  conversationId: string,
  connectionId: string,
  text = "请看资料",
): Reply {
  store.execute(
    {
      type: "grantConnectionScope",
      conversationId,
      connectionId,
      baseUrl: store.snapshot().connections.find((c) => c.id === connectionId)!
        .baseUrl,
    },
    "main",
  );
  const command: Command = {
    type: "submitTurn",
    requestId: randomUUID(),
    conversationId,
    connectionId,
    text,
  };
  return store.execute(command, "main");
}
function refused(reply: Reply, pattern: RegExp) {
  assert.equal(reply.ok, false, JSON.stringify(reply));
  if (!reply.ok) {
    assert.equal(reply.code, "CONFLICT");
    assert.match(reply.message, pattern);
  }
}
function host(store: Store, command: HostCommand) {
  return store.execute(command, "main", "host");
}
function finish(store: Store, turn: Turn) {
  host(store, { type: "beginExecution", executionId: turn.executionId });
  host(store, {
    type: "reportDelta",
    executionId: turn.executionId,
    seq: 1,
    text: "答",
  });
  host(store, {
    type: "reportFinished",
    executionId: turn.executionId,
    seq: 2,
  });
}

test("提交事务内重查：提取中、不可读、副本缺失、明确不支持图片或超过预算均拒绝，未知图片能力可发送", async () => {
  const dir = root(),
    user = files();
  const store = new Store(dir);
  try {
    const conversationId = conversation(store);
    const unknown = connection(store);
    const unsupported = connection(store, { imageInput: "unsupported" });
    const declared = connection(store, { imageInput: "declared" });
    const tight = connection(store, {
      imageInput: "declared",
      contextChars: 1000,
    });
    const before = store.snapshot().revision;
    // Still importing: the text has not been extracted yet.
    writeFileSync(join(user, "说明.txt"), "正文".repeat(10));
    const text = importFile(store, conversationId, join(user, "说明.txt"));
    refused(submit(store, conversationId, declared), /仍在提取正文/);
    await extractAll(store);
    // Unreadable material must be removed first.
    writeFileSync(join(user, "bad.exe"), "MZ");
    const bad = importFile(store, conversationId, join(user, "bad.exe"));
    refused(submit(store, conversationId, declared), /“bad.exe”不可读/);
    store.execute(
      { type: "removeDraftAttachment", conversationId, attachmentId: bad },
      "main",
    );
    // Explicit image refusal blocks submission; unknown capability permits it.
    writeFileSync(join(user, "图.png"), pngSample());
    const image = importFile(store, conversationId, join(user, "图.png"));

    refused(
      submit(store, conversationId, unsupported),
      /不支持图片输入.*移除图片/,
    );
    // Budget: history + material + this text must fit the connection's budget.
    writeFileSync(join(user, "long.txt"), "长".repeat(1200));
    const long = importFile(store, conversationId, join(user, "long.txt"));
    await extractAll(store);
    refused(
      submit(store, conversationId, tight),
      /约 1,2\d\d 字符，超过连接“.*”的上下文预算 1,000 字符/,
    );
    store.execute(
      { type: "removeDraftAttachment", conversationId, attachmentId: long },
      "main",
    );
    // A copy that vanished from disk cannot be sent as if it were there.
    const sha = store
      .snapshot()
      .attachments.find((a) => a.id === image)!.sha256;
    const copy = join(dir, "attachments", sha);
    const bytes = readFileSync(copy);
    rmSync(copy);
    refused(submit(store, conversationId, declared), /副本缺失/);
    writeFileSync(copy, bytes, { mode: 0o600 });
    // Every refusal above left no turn, message or execution behind.
    assert.equal(store.snapshot().turns.length, 0);
    assert.equal(
      (
        store.db.prepare("SELECT COUNT(*) AS n FROM executions").get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(store.snapshot().draftAttachments.length, 2);
    // Unknown capability accepts the same material and binds it to the message.
    const accepted = submit(store, conversationId, unknown);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const turn = store.snapshot().turns[0];
    assert.equal(turn.omittedImages, 0);
    assert.deepEqual(
      store
        .snapshot()
        .messageAttachments.map((m) => m.attachmentId)
        .sort(),
      [text, image].sort(),
    );
    assert.ok(store.snapshot().revision > before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("回合上下文携带资料：正文内联、图片给出副本位置；不支持图片的连接得到 send=false 与历史图片省略计数", async () => {
  const dir = root(),
    user = files();
  const store = new Store(dir);
  try {
    const conversationId = conversation(store);
    const capable = connection(store, { imageInput: "declared" });
    const textOnly = connection(store, { imageInput: "unsupported" });
    writeFileSync(join(user, "资料.md"), "# 标题\n正文");
    writeFileSync(join(user, "图.png"), pngSample());
    importFile(store, conversationId, join(user, "资料.md"));
    importFile(store, conversationId, join(user, "图.png"));
    await extractAll(store);
    assert.equal(submit(store, conversationId, capable, "第一问").ok, true);
    const first = store.snapshot().turns[0];
    const context = host(store, {
      type: "loadTurnContext",
      executionId: first.executionId,
    });
    assert.equal(context.ok, true);
    if (context.ok) {
      assert.equal(context.messages?.length, 1);
      const [md, png] = context.attachments!;
      assert.deepEqual(
        [md.name, md.kind, md.text, md.copy, md.send],
        ["资料.md", "markdown", "# 标题\n正文", null, true],
      );
      assert.deepEqual(
        [png.name, png.kind, png.text, png.send],
        ["图.png", "png", null, true],
      );
      assert.equal(png.copy, `attachments/${png.sha256}`);
    }
    finish(store, first);
    // A follow-up on a text-only connection: history text still goes, the history image is omitted and counted.
    assert.equal(submit(store, conversationId, textOnly, "追问").ok, true);
    const second = store.snapshot().turns.find((t) => t.id !== first.id)!;
    assert.equal(second.omittedImages, 1);
    const follow = host(store, {
      type: "loadTurnContext",
      executionId: second.executionId,
    });
    if (follow.ok) {
      assert.equal(follow.messages?.length, 3);
      assert.deepEqual(
        follow.attachments!.map((a) => [a.name, a.send]),
        [
          ["资料.md", true],
          ["图.png", false],
        ],
      );
    }
    const submitted = store
      .snapshot()
      .events.find(
        (e) => e.kind === "submitted" && e.payload.omittedImages === 1,
      );
    assert.ok(submitted);
    // Events never carry material text.
    for (const event of store.snapshot().events)
      assert.equal(JSON.stringify(event.payload).includes("正文"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("图片能力：检测成功归已实测、检测被拒或回合被拒归不支持；已实测只能由检测得到；用户改动清除检测时间", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const id = connection(store);
    const conversationId = conversation(store);
    const probe = randomUUID();
    assert.equal(
      host(store, {
        type: "createExecution",
        executionId: probe,
        kind: "image_probe",
        connectionId: id,
      }).ok,
      true,
    );
    host(store, { type: "beginExecution", executionId: probe });
    host(store, { type: "reportFinished", executionId: probe, seq: 1 });
    let row = store.snapshot().connections.find((c) => c.id === id)!;
    assert.equal(row.imageInput, "verified");
    assert.ok(row.imageInputCheckedAt);
    assert.equal(row.lastImageProbe?.state, "completed");
    // The user keeps "verified" when editing other fields, but cannot type it in for another connection.
    const keep = store.execute(
      {
        type: "upsertConnection",
        id,
        name: row.name,
        provider: row.provider,
        baseUrl: row.baseUrl,
        model: row.model,
        secretRef: row.secretRef,
        imageInput: "verified",
        contextChars: 5000,
        revision: row.revision,
      },
      "main",
    );
    assert.equal(keep.ok, true);
    row = store.snapshot().connections.find((c) => c.id === id)!;
    assert.deepEqual([row.imageInput, row.contextChars], ["verified", 5000]);
    assert.ok(row.imageInputCheckedAt);
    const forged = store.execute(
      {
        type: "upsertConnection",
        id: randomUUID(),
        name: "伪造",
        provider: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "m",
        secretRef: row.secretRef,
        imageInput: "verified",
        contextChars: null,
        revision: 0,
      },
      "main",
    );
    refused(forged, /只能通过“检测图片能力”得到/);
    // A user statement replaces the probe result and clears its time.
    store.execute(
      {
        type: "upsertConnection",
        id,
        name: row.name,
        provider: row.provider,
        baseUrl: row.baseUrl,
        model: row.model,
        secretRef: row.secretRef,
        imageInput: "declared",
        contextChars: 5000,
        revision: row.revision,
      },
      "main",
    );
    row = store.snapshot().connections.find((c) => c.id === id)!;
    assert.deepEqual(
      [row.imageInput, row.imageInputCheckedAt],
      ["declared", null],
    );
    // Capability is measured per model: changing the model without a new statement resets it.
    store.execute(
      {
        type: "upsertConnection",
        id,
        name: row.name,
        provider: row.provider,
        baseUrl: row.baseUrl,
        model: "another-model",
        secretRef: row.secretRef,
        imageInput: "declared",
        contextChars: 5000,
        revision: row.revision,
      },
      "main",
    );
    row = store.snapshot().connections.find((c) => c.id === id)!;
    assert.deepEqual(
      [row.model, row.imageInput, row.imageInputCheckedAt],
      ["another-model", "unknown", null],
    );
    store.execute(
      {
        type: "upsertConnection",
        id,
        name: row.name,
        provider: row.provider,
        baseUrl: row.baseUrl,
        model: "third-model",
        secretRef: row.secretRef,
        imageInput: "declared",
        contextChars: 5000,
        revision: row.revision,
      },
      "main",
    );
    row = store.snapshot().connections.find((c) => c.id === id)!;
    assert.deepEqual([row.model, row.imageInput], ["third-model", "declared"]);
    // A probe refused for image content marks the connection unsupported.
    const probe2 = randomUUID();
    host(store, {
      type: "createExecution",
      executionId: probe2,
      kind: "image_probe",
      connectionId: id,
    });
    host(store, { type: "reportImageUnsupported", executionId: probe2 });
    host(store, {
      type: "reportFailed",
      executionId: probe2,
      seq: 1,
      errorClass: "unsupported",
      message: "HTTP 400：该模型或接口不接受图片输入。",
    });
    row = store.snapshot().connections.find((c) => c.id === id)!;
    assert.equal(row.imageInput, "unsupported");
    assert.equal(row.lastImageProbe?.errorClass, "unsupported");
    // A network failure of the probe leaves the capability untouched.
    const probe3 = randomUUID();
    host(store, {
      type: "createExecution",
      executionId: probe3,
      kind: "image_probe",
      connectionId: id,
    });
    host(store, {
      type: "reportFailed",
      executionId: probe3,
      seq: 1,
      errorClass: "network",
      message: "网络错误",
    });
    assert.equal(
      store.snapshot().connections.find((c) => c.id === id)!.imageInput,
      "unsupported",
    );
    // A real turn refused for image content by a declared connection marks it unsupported too.
    const declared = connection(store, { imageInput: "declared" });
    assert.equal(submit(store, conversationId, declared).ok, true);
    const turn = store.snapshot().turns[0];
    host(store, {
      type: "reportImageUnsupported",
      executionId: turn.executionId,
    });
    assert.equal(
      store.snapshot().connections.find((c) => c.id === declared)!.imageInput,
      "unsupported",
    );
    // Validators: budget bounds and command shapes.
    const base = {
      type: "upsertConnection",
      id: randomUUID(),
      name: "x",
      provider: "custom",
      baseUrl: "https://example.com/v1",
      model: "m",
      secretRef: null,
      imageInput: "unknown",
      contextChars: null,
      revision: 0,
    };
    assert.equal(validCommand(base), true);
    assert.equal(validCommand({ ...base, contextChars: 999 }), false);
    assert.equal(validCommand({ ...base, contextChars: 10_000_001 }), false);
    assert.equal(validCommand({ ...base, contextChars: 1.5 }), false);
    assert.equal(validCommand({ ...base, imageInput: "yes" }), false);
    assert.equal(
      validHostCommand({
        type: "reportImageUnsupported",
        executionId: randomUUID(),
      }),
      true,
    );
    assert.equal(
      validHostCommand({
        type: "reportImageUnsupported",
        executionId: randomUUID(),
        connectionId: id,
      }),
      false,
    );
    assert.equal(
      store.execute(
        { type: "reportImageUnsupported", executionId: turn.executionId },
        "main",
      ).ok,
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("版本 8 数据库带有执行、事件与待处理时迁移到版本 9：行与只追加事件不变，外键校验通过，image_probe 可用", () => {
  const dir = root();
  try {
    const db = new DatabaseSync(join(dir, "state.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), root_id TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE selections (surface TEXT PRIMARY KEY CHECK(surface IN ('main','panel')), conversation_id TEXT REFERENCES conversations(id));
      INSERT INTO selections VALUES ('main',NULL),('panel',NULL);
      PRAGMA application_id=1129534529; PRAGMA user_version=1;`);
    db.prepare("INSERT INTO meta VALUES(1,?,0)").run(randomUUID());
    for (let version = 1; version < 8; version++) {
      const migration = migrations[version];
      assert.equal(typeof migration, "string");
      db.exec(
        `BEGIN; ${migration as string} PRAGMA user_version=${version + 1}; COMMIT`,
      );
    }
    const conversationId = randomUUID(),
      connectionId = randomUUID(),
      turnId = randomUUID(),
      executionId = randomUUID();
    db.prepare(
      "INSERT INTO conversations (id,title,updated_at) VALUES (?,'旧对话','2026-09-05T00:00:00.000Z')",
    ).run(conversationId);
    db.prepare(
      "INSERT INTO connections (id,name,provider,base_url,model,revision,created_at,updated_at) VALUES (?,'旧连接','custom','http://127.0.0.1:1/v1','m',0,'2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z')",
    ).run(connectionId);
    db.prepare(
      "INSERT INTO turns (id,conversation_id,request_id,connection_snapshot,state,created_at) VALUES (?,?,?,'{}','failed','2026-09-05T00:00:00.000Z')",
    ).run(turnId, conversationId, randomUUID());
    db.prepare(
      "INSERT INTO executions (id,turn_id,kind,connection_id,attempt,state,last_seq,created_at,error_class,error_message,partial_text) VALUES (?,?,'turn',?,2,'failed',3,'2026-09-05T00:00:00.000Z','network','断网','部分')",
    ).run(executionId, turnId, connectionId);
    db.prepare(
      "INSERT INTO pending_items (id,execution_id,kind,state,created_at) VALUES (?,?,'failed_turn','open','2026-09-05T00:00:00.000Z')",
    ).run(randomUUID(), executionId);
    for (const kind of ["submitted", "started", "failed"])
      db.prepare(
        "INSERT INTO run_events (id,execution_id,kind,at,snapshot,payload) VALUES (?,?,?,'2026-09-05T00:00:00.000Z','{}','{}')",
      ).run(randomUUID(), executionId, kind);
    const eventsBefore = db
      .prepare("SELECT seq,id,execution_id,kind FROM run_events ORDER BY seq")
      .all();
    db.close();
    const store = new Store(dir);
    try {
      assert.equal(
        (
          store.db.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
        schemaVersion,
      );
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.deepEqual(
        store.db
          .prepare(
            "SELECT seq,id,execution_id,kind FROM run_events WHERE execution_id=? ORDER BY seq",
          )
          .all(executionId),
        eventsBefore,
      );
      const execution = store.db
        .prepare(
          "SELECT attempt,state,last_seq,error_class AS errorClass,partial_text AS partialText FROM executions WHERE id=?",
        )
        .get(executionId) as Record<string, unknown>;
      assert.deepEqual(
        [
          execution.attempt,
          execution.state,
          execution.last_seq,
          execution.errorClass,
          execution.partialText,
        ],
        [2, "failed", 3, "network", "部分"],
      );
      assert.equal(store.snapshot().pendingItems.length, 1);
      const old = store.snapshot().connections[0];
      assert.deepEqual(
        [old.imageInput, old.imageInputCheckedAt, old.contextChars],
        ["unknown", null, null],
      );
      // The rebuilt table accepts the new kind and still refuses unknown ones and event rewrites.
      assert.equal(
        host(store, {
          type: "createExecution",
          executionId: randomUUID(),
          kind: "image_probe",
          connectionId: old.id,
        }).ok,
        true,
      );
      assert.throws(() =>
        store.db
          .prepare(
            "INSERT INTO executions (id,kind,state,created_at) VALUES (?,'other','queued','x')",
          )
          .run(randomUUID()),
      );
      assert.throws(() => store.db.exec("DELETE FROM run_events"));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
