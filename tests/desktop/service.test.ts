import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Store, schemaVersion, migrations } from "../../src/service/store";

mkdirSync(".test-data/disposable", { recursive: true });
function root() {
  return mkdtempSync(resolve(".test-data/disposable/service-"));
}
test("独立根、重复身份去重、同名草稿事务与重启恢复", () => {
  const dir = root();
  let store = new Store(dir);
  try {
    const a = randomUUID(),
      b = randomUUID();
    for (const id of [a, a, b])
      assert.equal(store.execute({ type: "create", id }, "main").ok, true);
    assert.equal(store.snapshot().conversations.length, 2);
    for (const [id, text] of [
      [a, "主窗口的中文草稿"],
      [b, "另一个同名对话"],
    ])
      assert.equal(
        store.execute({ type: "saveDraft", id, text, revision: 0 }, "main").ok,
        true,
      );
    const saved = store.snapshot();
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.snapshot(), saved);
    assert.equal(new Set(saved.conversations.map((c) => c.title)).size, 1);
    assert.equal(statSync(join(dir, "state.sqlite")).mode & 0o777, 0o600);
    assert.equal(
      readdirSync(dir).some((name) => /secret|vault|key/i.test(name)),
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("过期修订与 SQL 拒写不覆盖已确认草稿，也不增加全局修订", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const id = randomUUID();
    store.execute({ type: "create", id }, "main");
    store.execute(
      { type: "saveDraft", id, text: "已保存", revision: 0 },
      "panel",
    );
    const baseline = store.snapshot();
    const conflict = store.execute(
      { type: "saveDraft", id, text: "过期输入", revision: 0 },
      "main",
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "CONFLICT");
    assert.deepEqual(store.snapshot(), baseline);
    store.db.exec("PRAGMA query_only=ON");
    const failed = store.execute(
      { type: "saveDraft", id, text: "保存失败", revision: 1 },
      "main",
    );
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.code, "WRITE_FAILED");
    assert.deepEqual(store.snapshot(), baseline);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("非法命令、伪造字段、越界文本及未知身份被拒绝", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    for (const command of [
      { type: "sendModel", prompt: "不要发送" },
      { type: "snapshot", sql: "DROP TABLE meta" },
      { type: "create", id: "../vault" },
      {
        type: "saveDraft",
        id: randomUUID(),
        text: "x".repeat(100001),
        revision: 0,
      },
    ]) {
      assert.equal(store.execute(command, "main").ok, false);
    }
    assert.equal(
      store.execute({ type: "select", id: randomUUID() }, "main").ok,
      false,
    );
    assert.equal(store.snapshot().revision, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("非空目录、坏数据库、缺失数据库与符号链接拒绝且不改原文件", () => {
  for (const kind of ["foreign", "corrupt", "symlink", "missing"]) {
    const dir = root();
    try {
      if (kind === "foreign") writeFileSync(join(dir, "user.txt"), "keep");
      if (kind === "corrupt")
        writeFileSync(join(dir, "state.sqlite"), "not sqlite");
      if (kind === "symlink")
        symlinkSync("/does-not-exist", join(dir, "state.sqlite"));
      if (kind === "missing") {
        const store = new Store(dir);
        store.close();
        rmSync(join(dir, "state.sqlite"));
      }
      assert.throws(() => new Store(dir));
      if (kind === "foreign") assert.deepEqual(readdirSync(dir), ["user.txt"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});
test("跨进程根锁与 SIGKILL 后释放，已保存事务保持", async () => {
  const dir = root();
  let child;
  try {
    const store = new Store(dir);
    const id = randomUUID();
    store.execute({ type: "create", id }, "main");
    store.close();
    child = fork("tests/desktop/store-child.ts", [dir], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const [message] = await once(child, "message");
    assert.equal(message.ready, true);
    assert.throws(() => new Store(dir), /另一个业务进程/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recovered = new Store(dir);
    assert.equal(recovered.snapshot().conversations[0].id, id);
    recovered.close();
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true });
  }
});

test("不同符号链接路径不能绕过同一数据根锁", () => {
  const dir = root();
  const alias = dir + "-alias";
  const store = new Store(dir);
  try {
    symlinkSync(dir, alias);
    assert.throws(() => new Store(alias), /另一个业务进程/);
  } finally {
    store.close();
    rmSync(alias);
    rmSync(dir, { recursive: true });
  }
});

test("连接配置事务、修订冲突、删除幂等与重启读回；业务库不接受密钥字段", () => {
  const dir = root();
  let store = new Store(dir);
  try {
    const id = randomUUID();
    const ref = randomUUID();
    const base = {
      type: "upsertConnection" as const,
      id,
      name: "DeepSeek 测试",
      provider: "deepseek" as const,
      baseUrl: "https://api.deepseek.com",
      model: "",
      secretRef: null,
      imageInput: "unknown" as const,
      contextChars: null,
      revision: 0,
    };
    assert.equal(store.execute(base, "main").ok, true);
    // Lost acknowledgement: the identical value is confirmed without a second row or revision bump.
    assert.equal(store.execute(base, "main").ok, true);
    assert.equal(store.snapshot().connections.length, 1);
    assert.equal(store.snapshot().connections[0].revision, 0);
    const edited = store.execute(
      { ...base, model: "deepseek-chat", secretRef: ref, revision: 0 },
      "panel",
    );
    assert.equal(edited.ok, true);
    const stale = store.execute(
      { ...base, name: "过期修订", revision: 0 },
      "main",
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "CONFLICT");
    const duplicateRef = store.execute(
      { ...base, id: randomUUID(), secretRef: ref },
      "main",
    );
    assert.equal(duplicateRef.ok, false);
    for (const command of [
      { ...base, secret: "sk-plain-text" },
      { ...base, baseUrl: "http://example.com/v1" },
      { ...base, baseUrl: "https://user:pw@api.example.com" },
      { ...base, baseUrl: "ftp://api.example.com" },
      { ...base, provider: "openai" },
      { ...base, name: " " },
      { ...base, secretRef: "not-a-reference" },
    ])
      assert.equal(store.execute(command, "main").ok, false);
    assert.equal(
      store.execute(
        {
          ...base,
          provider: "custom",
          id: randomUUID(),
          baseUrl: "http://127.0.0.1:8080/v1",
        },
        "main",
      ).ok,
      true,
    );
    const saved = store.snapshot();
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.snapshot(), saved);
    const connection = store.snapshot().connections.find((c) => c.id === id)!;
    assert.equal(connection.model, "deepseek-chat");
    assert.equal(connection.secretRef, ref);
    const bytes = readFileSync(join(dir, "state.sqlite"));
    assert.equal(bytes.includes(Buffer.from("sk-plain-text")), false);
    assert.equal(bytes.includes(Buffer.from(ref)), true);
    assert.equal(
      store.execute({ type: "deleteConnection", id }, "main").ok,
      true,
    );
    assert.equal(
      store.execute({ type: "deleteConnection", id }, "main").ok,
      true,
    );
    assert.equal(store.snapshot().connections.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("版本 1 与版本 2 数据库顺序迁移到当前版本并保留数据；更新的版本被拒绝", () => {
  for (const kind of ["v1", "v2", "newer"]) {
    const dir = root();
    try {
      const db = new DatabaseSync(join(dir, "state.sqlite"));
      const id = randomUUID();
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), root_id TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
        CREATE TABLE selections (surface TEXT PRIMARY KEY CHECK(surface IN ('main','panel')), conversation_id TEXT REFERENCES conversations(id));
        INSERT INTO selections VALUES ('main',NULL),('panel',NULL);
        PRAGMA application_id=1129534529; PRAGMA user_version=${kind === "v1" ? 1 : kind === "v2" ? 2 : 99};`);
      if (kind === "v2") {
        db.exec(
          "CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', secret_ref TEXT UNIQUE, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        );
        db.prepare(
          "INSERT INTO connections VALUES (?,'旧连接','deepseek','https://api.deepseek.com','deepseek-chat',NULL,0,'2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z')",
        ).run(randomUUID());
      }
      db.prepare("INSERT INTO meta VALUES(1,?,3)").run(randomUUID());
      db.prepare(
        "INSERT INTO conversations (id,title,draft,revision,updated_at) VALUES (?,'新对话','旧版草稿',2,'2026-09-05T00:00:00.000Z')",
      ).run(id);
      db.close();
      const before = readFileSync(join(dir, "state.sqlite"));
      if (kind === "newer") {
        assert.throws(() => new Store(dir), /版本不兼容/);
        assert.equal(
          readFileSync(join(dir, "state.sqlite")).equals(before),
          true,
        );
        continue;
      }
      const store = new Store(dir);
      try {
        const snapshot = store.snapshot();
        assert.equal(snapshot.revision, 3);
        assert.deepEqual(
          snapshot.conversations.map((c) => [c.id, c.draft, c.revision]),
          [[id, "旧版草稿", 2]],
        );
        if (kind === "v2") {
          assert.equal(snapshot.connections.length, 1);
          assert.equal(snapshot.connections[0].model, "deepseek-chat");
          assert.deepEqual(snapshot.connections[0].modelList, {
            state: "unknown",
          });
        } else assert.deepEqual(snapshot.connections, []);
        assert.deepEqual(snapshot.activeTurns, []);
        assert.deepEqual(snapshot.settings, {
          defaultConnectionId: null,
          defaultModelId: null,
          telemetryEnabled: false,
          appearance: "light",
          interface: {
            sidebarCollapsed: false,
            rightPanelWidth: null,
            pinnedSort: "pinned",
            projectSort: "updated",
            pinnedFolded: false,
            projectsFolded: false,
            recentFolded: false,
          },
          codex: { enabled: true, path: null, revision: 0 },
          claude: { enabled: true, path: null, revision: 0 },
        });
        assert.equal(
          (
            store.db.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
          schemaVersion,
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test("默认连接需要模型 ID，删除或清空默认连接被拒绝，重启后保持", () => {
  const dir = root();
  let store = new Store(dir);
  try {
    const withModel = randomUUID(),
      withoutModel = randomUUID();
    const base = {
      type: "upsertConnection" as const,
      provider: "openrouter" as const,
      baseUrl: "https://openrouter.ai/api/v1",
      secretRef: randomUUID(),
      imageInput: "unknown" as const,
      contextChars: null,
      revision: 0,
    };
    store.execute(
      { ...base, id: withModel, name: "有模型", model: "a/b" },
      "main",
    );
    store.execute(
      {
        ...base,
        secretRef: randomUUID(),
        provider: "custom",
        id: withoutModel,
        name: "无模型",
        model: "",
      },
      "main",
    );
    const missing = store.execute(
      { type: "setDefaultConnection", id: randomUUID() },
      "main",
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "NOT_FOUND");
    const empty = store.execute(
      { type: "setDefaultConnection", id: withoutModel },
      "main",
    );
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "CONFLICT");
    assert.equal(store.snapshot().settings.defaultConnectionId, null);
    assert.equal(
      store.execute({ type: "setDefaultConnection", id: withModel }, "panel")
        .ok,
      true,
    );
    assert.equal(store.snapshot().settings.defaultConnectionId, withModel);
    const cleared = store.execute(
      { ...base, id: withModel, name: "有模型", model: "", revision: 0 },
      "main",
    );
    assert.equal(cleared.ok, false);
    const removed = store.execute(
      { type: "deleteConnection", id: withModel },
      "main",
    );
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.equal(removed.code, "CONFLICT");
    assert.equal(store.snapshot().connections.length, 2);
    const saved = store.snapshot();
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.snapshot(), saved);
    assert.equal(
      store.execute({ type: "setDefaultConnection", id: null }, "main").ok,
      true,
    );
    assert.equal(
      store.execute({ type: "deleteConnection", id: withModel }, "main").ok,
      true,
    );
    assert.equal(
      store.execute({ type: "setDefaultConnection", id: "x" }, "main").ok,
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

function legacyModelsRoot(fail = false) {
  const dir = root();
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec(`
    CREATE TABLE meta (id INTEGER PRIMARY KEY, root_id TEXT, revision INTEGER);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, draft TEXT DEFAULT '', revision INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE selections (surface TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id));
    INSERT INTO selections VALUES ('main',NULL),('panel',NULL);
    PRAGMA application_id=1129534529; PRAGMA user_version=9;
  `);
  db.prepare("INSERT INTO meta VALUES(1,?,0)").run(randomUUID());
  for (let v = 1; v < 9; v++) {
    const migration = migrations[v];
    if (typeof migration === "string") db.exec(migration);
    else migration(db);
  }
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const refs = ids.map(() => randomUUID());
  const at = "2026-09-06T00:00:00.000Z";
  ids.forEach((id, i) =>
    db
      .prepare(
        `INSERT INTO connections
    (id,name,provider,base_url,model,secret_ref,image_input,image_input_checked_at,context_chars,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        `旧账户 ${i}`,
        i < 2 ? "deepseek" : i < 4 ? "siliconflow" : "custom",
        "https://example.com/v1",
        `model-${i}`,
        refs[i],
        i === 0 ? "verified" : "unknown",
        i === 0 ? at : null,
        4000 + i,
        at,
        at,
      ),
  );
  db.prepare("UPDATE settings SET default_connection_id=?").run(ids[0]);
  const conversationId = randomUUID();
  db.prepare(
    "INSERT INTO conversations (id,title,draft,updated_at,connection_id) VALUES (?,'旧对话','未发送草稿',?,?)",
  ).run(conversationId, at, ids[1]);
  const turns = ids.slice(0, 4).map((id, i) => ({
    connectionId: id,
    name: `历史名称 ${i}`,
    provider: i < 2 ? "deepseek" : "siliconflow",
    baseUrl: "https://example.com/v1",
    model: `model-${i}`,
    revision: 0,
  }));
  for (let i = 0; i < turns.length; i++) {
    const turnId = randomUUID(),
      executionId = randomUUID();
    const time = `2026-09-06T0${i}:00:00.000Z`;
    db.prepare(
      "INSERT INTO turns (id,conversation_id,request_id,connection_snapshot,state,created_at) VALUES (?,?,?,?,'completed',?)",
    ).run(turnId, conversationId, randomUUID(), JSON.stringify(turns[i]), time);
    db.prepare(
      "INSERT INTO executions (id,turn_id,kind,connection_id,state,created_at,ended_at) VALUES (?,?,'turn',?,'completed',?,?)",
    ).run(executionId, turnId, turns[i].connectionId, time, time);
    db.prepare(
      "INSERT INTO messages VALUES (?,?,?,'assistant','历史回答',?)",
    ).run(randomUUID(), conversationId, turnId, time);
    db.prepare(
      "INSERT INTO run_events (id,execution_id,kind,at,snapshot) VALUES (?,?,'completed',?,?)",
    ).run(randomUUID(), executionId, time, JSON.stringify(turns[i]));
  }
  if (fail)
    db.exec(
      "CREATE TRIGGER fail_model_migration BEFORE UPDATE OF provider ON connections BEGIN SELECT RAISE(ABORT,'injected migration failure'); END",
    );
  const history = ["turns", "messages", "run_events"].map((table) =>
    db.prepare(`SELECT * FROM ${table}`).all(),
  );
  db.close();
  return { dir, ids, refs, history, conversationId };
}

test("版本 9 多模型迁移保留默认、密钥引用与历史；重复预设按默认或最近使用转自定义；重开幂等", () => {
  const fixture = legacyModelsRoot();
  let store: Store | undefined;
  try {
    store = new Store(fixture.dir);
    const rows = store.db
      .prepare("SELECT id,provider,secret_ref FROM connections ORDER BY name")
      .all();
    assert.deepEqual(
      rows.map((r) => r.provider),
      ["deepseek", "custom", "custom", "siliconflow", "custom"],
    );
    assert.deepEqual(
      rows.map((r) => r.secret_ref),
      fixture.refs,
    );
    const models = store.db
      .prepare(
        "SELECT connection_id,model_id,enabled,image_input,image_input_checked_at,context_chars FROM connection_models ORDER BY model_id",
      )
      .all();
    assert.equal(models.length, 5);
    assert.deepEqual(
      models.map((r) => r.model_id),
      ["model-0", "model-1", "model-2", "model-3", "model-4"],
    );
    assert.deepEqual(
      models.map((r) => r.connection_id),
      fixture.ids,
    );
    assert.equal(models[0].image_input, "verified");
    assert.equal(models[0].context_chars, 4000);
    assert.equal(models[1].image_input, "unknown");
    assert.equal(
      store.db.prepare("SELECT default_model_id FROM settings").get()!
        .default_model_id,
      "model-0",
    );
    assert.equal(
      store.db
        .prepare("SELECT model_id FROM conversations WHERE id=?")
        .get(fixture.conversationId)!.model_id,
      "model-1",
    );
    for (let i = 0; i < 3; i++) {
      const table = ["turns", "messages", "run_events"][i];
      assert.deepEqual(
        store.db
          .prepare(`SELECT * FROM ${table} LIMIT ?`)
          .all(fixture.history[i].length),
        i === 0
          ? fixture.history[i].map((row) =>
              Object.assign(Object.create(null), row, {
                material_mode: "inline",
              }),
            )
          : fixture.history[i],
      );
    }
    const events = store.snapshot().events;
    assert.equal(
      events.filter((e) => String(e.kind) === "data_migrated").length,
      1,
    );
    assert.match(JSON.stringify(events), /旧账户 1/);
    const before = store.snapshot();
    store.close();
    store = new Store(fixture.dir);
    assert.deepEqual(store.snapshot(), before);
    assert.throws(
      () =>
        store!.db
          .prepare(
            "INSERT INTO connections (id,name,provider,base_url,created_at,updated_at) VALUES (?,'重复','deepseek','https://example.com','now','now')",
          )
          .run(randomUUID()),
      /UNIQUE/,
    );
  } finally {
    store?.close();
    rmSync(fixture.dir, { recursive: true });
  }
});

test("多模型迁移中途失败时事务完整回滚，旧 schema、默认、模型和历史不变，解除故障后可重试", () => {
  const fixture = legacyModelsRoot(true);
  try {
    const before = readFileSync(join(fixture.dir, "state.sqlite"));
    assert.throws(() => new Store(fixture.dir), /无法打开业务数据/);
    const db = new DatabaseSync(join(fixture.dir, "state.sqlite"));
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 9);
    assert.equal(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='connection_models'")
        .get(),
      undefined,
    );
    assert.deepEqual(
      db
        .prepare("SELECT provider FROM connections ORDER BY name")
        .all()
        .map((r) => r.provider),
      ["deepseek", "deepseek", "siliconflow", "siliconflow", "custom"],
    );
    for (let i = 0; i < 3; i++)
      assert.deepEqual(
        db
          .prepare(`SELECT * FROM ${["turns", "messages", "run_events"][i]}`)
          .all(),
        fixture.history[i],
      );
    db.close();
    // WAL mode may change header bytes; logical data and schema, above, are the rollback contract.
    assert.ok(before.length > 0);
    const fix = new DatabaseSync(join(fixture.dir, "state.sqlite"));
    fix.exec("DROP TRIGGER fail_model_migration");
    fix.close();
    const store = new Store(fixture.dir);
    assert.equal(
      store.db.prepare("PRAGMA user_version").get()!.user_version,
      schemaVersion,
    );
    store.close();
  } finally {
    rmSync(fixture.dir, { recursive: true });
  }
});

test("多模型提供方管理：默认保护、启停与移除密钥确认、活动引用和过期修订拒绝", () => {
  const dir = root(),
    store = new Store(dir),
    id = randomUUID();
  try {
    const input = {
      type: "upsertConnection" as const,
      id,
      name: "测试提供方",
      provider: "custom" as const,
      baseUrl: "https://example.com/v1",
      model: "alpha",
      secretRef: randomUUID(),
      imageInput: "unknown" as const,
      contextChars: null,
      revision: 0,
    };
    assert.equal(store.execute(input, "main").ok, true);
    const get = () => store.snapshot().connections.find((c) => c.id === id)!;
    const write = (model: string, enabled = true) =>
      store.execute(
        {
          type: "upsertModel",
          id,
          model,
          enabled,
          imageInput: "unknown",
          contextChars: 4000,
          revision: get().revision,
        },
        "main",
      );
    assert.equal(write("beta").ok, true);
    assert.equal(
      store.execute({ type: "setDefaultConnection", id, model: "beta" }, "main")
        .ok,
      true,
    );
    assert.equal(store.snapshot().settings.defaultModelId, "beta");
    const before = store.snapshot();
    assert.equal(write("beta", false).ok, false);
    assert.equal(
      store.execute(
        { type: "deleteModel", id, model: "beta", revision: get().revision },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "setConnectionEnabled",
          id,
          enabled: false,
          clearDefault: false,
          revision: get().revision,
        },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.equal(
      store.execute(
        {
          type: "setConnectionEnabled",
          id,
          enabled: false,
          clearDefault: true,
          revision: get().revision,
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(store.snapshot().settings.defaultConnectionId, null);
    assert.equal(get().enabled, false);
    assert.equal(
      store.execute(
        { type: "setDefaultConnection", id, model: "alpha" },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "setConnectionEnabled",
          id,
          enabled: true,
          clearDefault: false,
          revision: get().revision,
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(
      store.execute(
        { type: "setDefaultConnection", id, model: "alpha" },
        "main",
      ).ok,
      true,
    );
    const c = get();
    assert.equal(
      store.execute({ ...input, revision: c.revision, secretRef: null }, "main")
        .ok,
      false,
    );
    assert.equal(
      store.execute(
        { ...input, revision: c.revision, secretRef: null, clearDefault: true },
        "main",
      ).ok,
      true,
    );
    assert.equal(get().secretRef, null);
    assert.equal(store.snapshot().settings.defaultModelId, null);
    assert.equal(
      store.execute(
        { type: "setDefaultConnection", id, model: "alpha" },
        "main",
      ).ok,
      false,
    );
    for (const bad of [" ", "bad model", "../../with space", "x\n"])
      assert.equal(write(bad).ok, false);
    assert.equal(store.execute({ ...input, revision: 0 }, "main").ok, false);
    assert.equal(
      store.execute({ ...input, revision: get().revision }, "main").ok,
      true,
    );
    const conv = randomUUID();
    store.execute({ type: "create", id: conv }, "main");
    assert.equal(
      store.execute(
        {
          type: "submitTurn",
          requestId: randomUUID(),
          conversationId: conv,
          connectionId: id,
          model: "beta",
          text: "hello",
        },
        "main",
      ).ok,
      true,
    );
    const turn = store.snapshot().activeTurns[0];
    assert.equal(turn.connection.model, "beta");
    assert.equal(write("beta").ok, false);
    assert.equal(
      store.execute(
        {
          type: "setConnectionEnabled",
          id,
          enabled: false,
          clearDefault: true,
          revision: get().revision,
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        { ...input, revision: get().revision, secretRef: null },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        { type: "setDefaultConnection", id, model: "alpha" },
        "main",
      ).ok,
      true,
    );
    assert.equal(store.snapshot().activeTurns[0].connection.model, "beta");
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("升级前完整快照可独立校验并保留附件与 WAL 数据；快照失败不迁移原库", () => {
  const fixture = legacyModelsRoot();
  const backups = () =>
    readdirSync(resolve(fixture.dir, ".."))
      .filter((name) =>
        name.startsWith(fixture.dir.split("/").at(-1)! + "-schema-9-backup-"),
      )
      .map((name) => resolve(fixture.dir, "..", name));
  let store: Store | undefined;
  const attachment = "a".repeat(64),
    bytes = Buffer.from("迁移前附件副本");
  mkdirSync(join(fixture.dir, "attachments"));
  writeFileSync(join(fixture.dir, "attachments", attachment), bytes);
  const legacy = new DatabaseSync(join(fixture.dir, "state.sqlite"));
  try {
    legacy.exec("PRAGMA journal_mode=WAL");
    legacy
      .prepare("UPDATE conversations SET draft=? WHERE id=?")
      .run("尚在 WAL 的草稿", fixture.conversationId);
    store = new Store(fixture.dir);
    assert.equal(backups().length, 1);
    const backup = backups()[0];
    const manifest = JSON.parse(
      readFileSync(join(backup, "complete.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 9);
    assert.equal(manifest.files.length, 2);
    assert.equal(statSync(backup).mode & 0o777, 0o700);
    assert.deepEqual(
      readFileSync(join(backup, "data", "attachments", attachment)),
      bytes,
    );
    const saved = new DatabaseSync(join(backup, "data", "state.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        saved.prepare("PRAGMA quick_check").get()!.quick_check,
        "ok",
      );
      assert.equal(saved.prepare("PRAGMA user_version").get()!.user_version, 9);
      assert.equal(
        saved
          .prepare("SELECT draft FROM conversations WHERE id=?")
          .get(fixture.conversationId)!.draft,
        "尚在 WAL 的草稿",
      );
      assert.deepEqual(
        saved
          .prepare("SELECT secret_ref FROM connections ORDER BY name")
          .all()
          .map((r) => r.secret_ref),
        fixture.refs,
      );
      for (let i = 0; i < 3; i++)
        assert.deepEqual(
          saved
            .prepare(`SELECT * FROM ${["turns", "messages", "run_events"][i]}`)
            .all(),
          fixture.history[i],
        );
    } finally {
      saved.close();
    }
    store.close();
    store = new Store(fixture.dir);
    assert.equal(backups().length, 1);
  } finally {
    store?.close();
    legacy.close();
    for (const backup of backups()) rmSync(backup, { recursive: true });
    rmSync(fixture.dir, { recursive: true });
  }
  const broken = legacyModelsRoot();
  const db = new DatabaseSync(join(broken.dir, "state.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("UPDATE selections SET conversation_id=?").run(randomUUID());
    const before = db.prepare("SELECT * FROM connections").all();
    assert.throws(() => new Store(broken.dir), /完整快照未能完成/);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 9);
    assert.deepEqual(db.prepare("SELECT * FROM connections").all(), before);
    assert.equal(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='connection_models'")
        .get(),
      undefined,
    );
  } finally {
    db.close();
    rmSync(broken.dir, { recursive: true });
  }
});

test("多模型发送重新检查可用性；未完成历史换地址仍需确认，过期地址授权与迟到图片结果不生效", () => {
  const dir = root(),
    store = new Store(dir),
    conversationId = randomUUID();
  const a = randomUUID(),
    b = randomUUID();
  const input = (
    id: string,
    revision = 0,
    baseUrl = "https://example.com/v1",
  ) => ({
    type: "upsertConnection",
    id,
    name: id,
    provider: "custom",
    baseUrl,
    model: "alpha",
    secretRef: id,
    imageInput: "unknown",
    contextChars: null,
    revision,
  });
  const command = (c: unknown) => store.execute(c, "main");
  const host = (c: unknown) => {
    const r = store.execute(c, "main", "host");
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  const get = (id: string) =>
    store.snapshot().connections.find((c) => c.id === id)!;
  const submit = (id: string, model = "alpha") =>
    command({
      type: "submitTurn",
      requestId: randomUUID(),
      conversationId,
      connectionId: id,
      model,
      text: "需要携带历史",
    });
  try {
    for (const id of [a, b]) {
      const r = command(input(id));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    assert.equal(command({ type: "create", id: conversationId }).ok, true);
    assert.equal(
      command({
        type: "upsertModel",
        id: a,
        model: "disabled",
        enabled: false,
        imageInput: "unknown",
        contextChars: null,
        revision: get(a).revision,
      }).ok,
      true,
    );
    const before = store.snapshot();
    assert.equal(submit(a, "disabled").ok, false);
    assert.equal(submit(a, "missing").ok, false);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(submit(a).ok, true);
    const turn = store.snapshot().activeTurns[0];
    host({ type: "beginExecution", executionId: turn.executionId });
    host({
      type: "reportFailed",
      executionId: turn.executionId,
      seq: 1,
      errorClass: "network",
      message: "网络中断",
    });
    const stopped = store.snapshot();
    assert.equal(submit(b).ok, false);
    assert.deepEqual(store.snapshot(), stopped);
    assert.equal(
      command({
        type: "grantConnectionScope",
        conversationId,
        connectionId: b,
        baseUrl: "https://old.example.com/v1",
      }).ok,
      false,
    );
    assert.equal(
      command({
        type: "grantConnectionScope",
        conversationId,
        connectionId: b,
        baseUrl: get(b).baseUrl,
      }).ok,
      true,
    );
    assert.equal(
      command(input(b, get(b).revision, "https://changed.example.com/v1")).ok,
      true,
    );
    assert.equal(submit(b).ok, false);
    assert.equal(
      command({
        type: "grantConnectionScope",
        conversationId,
        connectionId: b,
        baseUrl: get(b).baseUrl,
      }).ok,
      true,
    );
    assert.equal(submit(b).ok, true);
    host({
      type: "reportFailed",
      executionId: store.snapshot().activeTurns[0].executionId,
      seq: 1,
      errorClass: "network",
      message: "模拟结束",
    });
    const probe = randomUUID();
    host({
      type: "createExecution",
      executionId: probe,
      kind: "image_probe",
      connectionId: a,
      model: "alpha",
    });
    host({ type: "beginExecution", executionId: probe });
    host({ type: "reportFinished", executionId: probe, seq: 1 });
    assert.equal(
      get(a).models.find((m) => m.model === "alpha")!.imageInput,
      "verified",
    );
    assert.equal(
      get(a).models.find((m) => m.model === "disabled")!.imageInput,
      "unknown",
    );
    assert.equal(
      command(input(a, get(a).revision, "https://new.example.com/v1")).ok,
      true,
    );
    host({ type: "reportImageUnsupported", executionId: probe });
    host({ type: "reportFinished", executionId: probe, seq: 2 });
    assert.equal(
      get(a).models.find((m) => m.model === "alpha")!.imageInput,
      "unknown",
    );
    assert.equal(
      get(a).models.find((m) => m.model === "alpha")!.lastProbe,
      null,
    );
    assert.deepEqual(store.snapshot().turns[0].connection, turn.connection);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("重复预设迁移为自定义后仍可重试原回合，保留原提供方与模型快照", () => {
  const fixture = legacyModelsRoot(),
    pendingId = randomUUID();
  const db = new DatabaseSync(join(fixture.dir, "state.sqlite"));
  const original = db
    .prepare("SELECT id,turn_id FROM executions WHERE connection_id=?")
    .get(fixture.ids[1])!;
  db.prepare("UPDATE executions SET state='failed' WHERE id=?").run(
    original.id,
  );
  db.prepare("UPDATE turns SET state='failed' WHERE id=?").run(
    original.turn_id,
  );
  db.prepare(
    "INSERT INTO pending_items (id,execution_id,kind,state,created_at) VALUES (?,?,'failed_turn','open',?)",
  ).run(pendingId, original.id, new Date().toISOString());
  db.close();
  const store = new Store(fixture.dir);
  try {
    assert.equal(
      store.execute({ type: "select", id: fixture.conversationId }, "main").ok,
      true,
    );
    assert.equal(
      store.snapshot().connections.find((c) => c.id === fixture.ids[1])!
        .provider,
      "custom",
    );
    const before = store
      .snapshot()
      .turns.find((t) => t.id === original.turn_id)!.connection;
    const r = store.execute(
      { type: "resolvePending", id: pendingId, action: "retry" },
      "main",
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(store.snapshot().activeTurns[0].connection, before);
    assert.equal(before.provider, "deepseek");
    assert.equal(before.model, "model-1");
  } finally {
    store.close();
    rmSync(fixture.dir, { recursive: true });
  }
});

test("文本测试按连接与模型隔离，拒绝重复执行，重启保留，配置变化与重新添加使旧结果失效", () => {
  const dir = root();
  let store = new Store(dir);
  const a = randomUUID(),
    b = randomUUID();
  const get = (id = a) =>
    store.snapshot().connections.find((c) => c.id === id)!;
  const model = (name: string, id = a) =>
    get(id).models.find((m) => m.model === name)!;
  const run = (c: unknown, host = false) => {
    const r = store.execute(c, "main", host ? "host" : undefined);
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  const configure = (
    id: string,
    baseUrl = "https://example.com/v1",
    secretRef = id,
  ) =>
    run({
      type: "upsertConnection",
      id,
      name: id,
      provider: "custom",
      baseUrl,
      secretRef,
      model: "alpha",
      imageInput: "unknown",
      contextChars: null,
      revision:
        store.snapshot().connections.find((c) => c.id === id)?.revision ?? 0,
    });
  const start = (id: string, name: string) => {
    const executionId = randomUUID();
    run(
      {
        type: "createExecution",
        connectionId: id,
        model: name,
        kind: "connection_test",
        executionId,
      },
      true,
    );
    run({ type: "beginExecution", executionId }, true);
    return executionId;
  };
  try {
    configure(a);
    configure(b);
    run({
      type: "upsertModel",
      id: a,
      model: "beta",
      enabled: true,
      imageInput: "unknown",
      contextChars: null,
      revision: get().revision,
    });
    const first = start(a, "alpha");
    const beforeDuplicate = store.snapshot();
    assert.equal(
      store.execute(
        {
          type: "createExecution",
          connectionId: a,
          model: "alpha",
          kind: "connection_test",
          executionId: randomUUID(),
        },
        "main",
        "host",
      ).ok,
      false,
    );
    assert.deepEqual(store.snapshot(), beforeDuplicate);
    const second = start(a, "beta");
    run({ type: "reportFinished", executionId: first, seq: 1 }, true);
    run(
      {
        type: "reportFailed",
        executionId: second,
        seq: 1,
        errorClass: "provider",
        message: "HTTP 403：提供方策略拒绝了请求",
      },
      true,
    );
    assert.equal(model("alpha").lastTest?.executionId, first);
    assert.equal(model("alpha").lastTest?.state, "completed");
    assert.equal(model("beta").lastTest?.state, "failed");
    assert.equal(model("alpha", b).lastTest, null);
    assert.equal(model("beta").enabled, true);
    assert.equal(model("alpha").imageInput, "unknown");
    assert.equal(model("beta").imageInput, "unknown");
    assert.equal(store.snapshot().settings.defaultConnectionId, null);
    const saved = store.snapshot();
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.snapshot(), saved);
    configure(a, "https://changed.example.com/v1");
    assert.ok(get().models.every((m) => m.lastTest === null));
    run({ type: "reportFinished", executionId: first, seq: 2 }, true);
    assert.equal(model("alpha").lastTest, null);
    const third = start(a, "alpha");
    run({ type: "reportFinished", executionId: third, seq: 1 }, true);
    configure(a, "https://changed.example.com/v1", randomUUID());
    assert.equal(model("alpha").lastTest, null);
    const fourth = start(a, "beta");
    run({ type: "reportFinished", executionId: fourth, seq: 1 }, true);
    run({
      type: "deleteModel",
      id: a,
      model: "beta",
      revision: get().revision,
    });
    run({
      type: "upsertModel",
      id: a,
      model: "beta",
      enabled: true,
      imageInput: "unknown",
      contextChars: null,
      revision: get().revision,
    });
    assert.equal(model("beta").lastTest, null);
    assert.ok(store.snapshot().events.some((e) => e.executionId === fourth));
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
