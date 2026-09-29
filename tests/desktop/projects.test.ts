import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store, migrations } from "../../src/service/store";
import { ProjectFolders, inspectProjectFolder } from "../../src/main/projects";
import {
  validProjectCommand,
  validProjectHostCommand,
} from "../../src/shared/projects";
import { warmSystemGit } from "./git-warmup";
import {
  pinnedObjects,
  sidebarProjects,
} from "../../src/renderer/project-lists";

before(warmSystemGit);

function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/projects-"));
  const folder = join(root, "folder");
  mkdirSync(folder);
  const data = join(root, "data");
  mkdirSync(data);
  const store = new Store(data);
  return { root, folder, data, store };
}
test("projects: folder inspection handles plain, no remote, multiple remotes and redacts credentials without following includes", async () => {
  const f = fixture();
  try {
    assert.equal((await inspectProjectFolder("/private/tmp")).git, null);
    execFileSync("/usr/bin/git", ["init", "-q", f.folder]);
    assert.deepEqual((await inspectProjectFolder(f.folder)).git?.remotes, []);
    execFileSync("/usr/bin/git", [
      "-C",
      f.folder,
      "config",
      "remote.origin.url",
      "https://user:secret@example.invalid/repo?token=secret#private",
    ]);
    execFileSync("/usr/bin/git", [
      "-C",
      f.folder,
      "config",
      "remote.upstream.url",
      "git@example.invalid:team/repo.git",
    ]);
    const included = join(f.root, "included.gitconfig");
    writeFileSync(
      included,
      '[remote "excluded"]\nurl = https://example.invalid/excluded\n',
    );
    execFileSync("/usr/bin/git", [
      "-C",
      f.folder,
      "config",
      "include.path",
      included,
    ]);
    const info = await inspectProjectFolder(f.folder);
    assert.equal(info.git?.remotes.length, 2);
    assert.ok(!JSON.stringify(info).includes("secret"));
    assert.ok(!JSON.stringify(info).includes("user:"));
    assert.equal(info.git?.remotes[0].url, "https://example.invalid/repo");
  } finally {
    f.store.close();
  }
});
test("projects: folder failures distinguish missing, file, permission, unavailable Git and other Git errors", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => inspectProjectFolder(join(f.root, "missing")),
      (error: { code?: string }) => error.code === "MISSING",
    );
    const file = join(f.root, "plain-file");
    writeFileSync(file, "plain");
    await assert.rejects(
      () => inspectProjectFolder(file),
      (error: { code?: string }) => error.code === "NOT_DIRECTORY",
    );
    chmodSync(f.folder, 0);
    try {
      await assert.rejects(
        () => inspectProjectFolder(f.folder),
        (error: { code?: string }) => error.code === "PERMISSION",
      );
    } finally {
      chmodSync(f.folder, 0o700);
    }
    await assert.rejects(
      () =>
        inspectProjectFolder(f.folder, {
          runGit: async () => {
            throw Object.assign(new Error("git unavailable"), {
              code: "ENOENT",
            });
          },
        }),
      (error: { code?: string }) => error.code === "GIT_UNAVAILABLE",
    );
    await assert.rejects(
      () =>
        inspectProjectFolder(f.folder, {
          runGit: async () => {
            throw new Error("unexpected git failure");
          },
        }),
      (error: { code?: string }) => error.code === "GIT_ERROR",
    );
  } finally {
    f.store.close();
  }
});
test("projects: folder selection tokens bind owner, expire, reject replacement and preserve same resource identity through aliases", async () => {
  const f = fixture();
  try {
    let now = 1000;
    const folders = new ProjectFolders(() => now);
    await assert.rejects(() => inspectProjectFolder(join(f.root, "missing")));
    chmodSync(f.folder, 0);
    try {
      await assert.rejects(() => inspectProjectFolder(f.folder));
    } finally {
      chmodSync(f.folder, 0o700);
    }
    const picked = await folders.select(1, f.folder);
    await assert.rejects(() => folders.resolve(2, picked.token), /失效/);
    const alias = join(f.root, "alias");
    symlinkSync(f.folder, alias);
    assert.equal(
      (await inspectProjectFolder(alias)).identity,
      (await inspectProjectFolder(f.folder)).identity,
    );
    const second = join(f.root, "second");
    mkdirSync(second);
    const linked = await folders.select(1, alias);
    unlinkSync(alias);
    symlinkSync(second, alias);
    await assert.rejects(() => folders.resolve(1, linked.token), /变化/);
    const replaced = await folders.select(1, f.folder);
    renameSync(f.folder, join(f.root, "old"));
    mkdirSync(f.folder);
    await assert.rejects(() => folders.resolve(1, replaced.token), /变化/);
    const expires = await folders.select(1, f.folder);
    now += 600001;
    await assert.rejects(() => folders.resolve(1, expires.token), /失效/);
  } finally {
    f.store.close();
  }
});
test("projects: one monotonic inspection deadline covers filesystem and every Git command, aborting a late command", async () => {
  const f = fixture();
  try {
    execFileSync("/usr/bin/git", ["init", "-q", f.folder]);
    let now = 100;
    const budgets: number[] = [];
    await assert.rejects(
      () =>
        inspectProjectFolder(f.folder, {
          now: () => now,
          runGit: async (_folder, _args, options) => {
            budgets.push(options.timeout);
            if (budgets.length === 1) {
              now += 9_500;
              return `${f.folder}\n`;
            }
            now += 600;
            return ".git\n";
          },
        }),
      /10 秒|超时/,
    );
    assert.equal(budgets.length, 2);
    assert.ok(budgets[0] <= 10_000 && budgets[0] > 9_000);
    assert.ok(budgets[1] <= 500 && budgets[1] > 0);

    let aborted = false;
    await assert.rejects(
      () =>
        inspectProjectFolder(f.folder, {
          timeoutMs: 25,
          runGit: (_folder, _args, options) =>
            new Promise<string>((_, reject) => {
              options.signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(options.signal.reason);
                },
                { once: true },
              );
            }),
        }),
      /超时/,
    );
    assert.equal(aborted, true);
  } finally {
    f.store.close();
  }
});
test("projects: cancel and replacement invalidate late selections, retry uses only the Host path, and save timeout never calls create", async () => {
  const f = fixture();
  try {
    const actual = await inspectProjectFolder(f.folder);
    let pending!: (value: typeof actual) => void;
    let inspections = 0;
    const seenPaths: string[] = [];
    const folders = new ProjectFolders(undefined, async (path) => {
      seenPaths.push(path);
      inspections++;
      if (inspections === 1)
        return new Promise<typeof actual>((resolve) => {
          pending = resolve;
        });
      if (inspections === 3 || inspections === 5)
        throw new Error("文件夹检查超时，请重试检查。");
      return actual;
    });
    const late = folders.select(1, f.folder);
    await new Promise((resolve) => setImmediate(resolve));
    folders.cancel(1);
    pending(actual);
    await assert.rejects(() => late, /取消|失效/);
    await assert.rejects(() => folders.retry(1), /重新选择/);
    const picked = await folders.select(1, f.folder);
    const stalePicker = folders.beginPicker(2);
    folders.cancel(2);
    await assert.rejects(
      () => folders.select(2, f.folder, stalePicker),
      /取消/,
    );
    await assert.rejects(() => folders.select(1, f.folder), /超时/);
    await assert.rejects(() => folders.resolve(1, picked.token), /失效/);
    const retried = await folders.retry(1);
    assert.equal(retried.folder.path, f.folder);
    assert.deepEqual(seenPaths, [f.folder, f.folder, f.folder, f.folder]);
    let saves = 0;
    await assert.rejects(
      () =>
        folders.create(1, retried.token, async () => {
          saves++;
          return { ok: true };
        }),
      /超时/,
    );
    assert.equal(saves, 0);
    const reply = await folders.create(1, retried.token, async () => {
      saves++;
      return { ok: true };
    });
    assert.equal(reply.ok, true);
    assert.equal(saves, 1);
    folders.clear(1);
    await assert.rejects(() => folders.retry(1), /重新选择/);
  } finally {
    f.store.close();
  }
});
test("projects: window teardown aborts save recheck and a failed save retry keeps one project identity", async () => {
  const f = fixture();
  try {
    const actual = await inspectProjectFolder(f.folder);
    let finishRecheck!: (folder: typeof actual) => void;
    let recheckAborted = false;
    let inspections = 0;
    const folders = new ProjectFolders(undefined, async (_path, options) => {
      inspections++;
      if (inspections === 2) {
        options?.signal?.addEventListener(
          "abort",
          () => {
            recheckAborted = true;
          },
          { once: true },
        );
        return new Promise<typeof actual>((resolve) => {
          finishRecheck = resolve;
        });
      }
      return actual;
    });
    const selected = await folders.select(1, f.folder);
    let saves = 0;
    const pending = folders.create(1, selected.token, async () => {
      saves++;
      return { ok: true };
    });
    await new Promise((resolve) => setImmediate(resolve));
    folders.clear(1);
    assert.equal(recheckAborted, true);
    finishRecheck(actual);
    await assert.rejects(() => pending, /取消|失效/);
    assert.equal(saves, 0);

    const next = await folders.select(2, f.folder);
    const created = new Set<string>();
    const save = async (id: string) => {
      created.add(id);
      return { ok: created.size === 1 && created.has(id), id };
    };
    const first = await folders.create(2, next.token, async (id) => {
      const result = await save(id);
      return { ...result, ok: false };
    });
    assert.equal(first.ok, false);
    const retry = await folders.create(2, next.token, async (id) => save(id));
    assert.equal(retry.ok, true);
    assert.equal(created.size, 1);
    assert.equal(first.id, retry.id);
  } finally {
    f.store.close();
  }
});
test("projects: host-only create, same-name identities, edit conflict, write failure and restart preserve records", async () => {
  const f = fixture();
  try {
    const folder = await inspectProjectFolder(f.folder);
    const id = randomUUID();
    const create = {
      type: "projectCreate",
      id,
      name: "同名",
      goal: "目标",
      folder,
    };
    assert.equal(validProjectHostCommand(create), true);
    assert.equal(validProjectCommand(create), false);
    assert.equal(f.store.execute(create, "main").ok, false);
    assert.equal(f.store.execute(create, "main", "host").ok, true);
    assert.equal(
      f.store.execute({ ...create, id: randomUUID() }, "main", "host").ok,
      true,
    );
    assert.equal(f.store.snapshot().projects.length, 2);
    const edited = f.store.execute(
      {
        type: "projectEdit",
        id,
        name: "更新名称",
        goal: "新目标",
        revision: 0,
      },
      "main",
    );
    assert.equal(edited.ok, true);
    const before = f.store.snapshot();
    assert.equal(
      f.store.execute(
        { type: "projectEdit", id, name: "旧写入", goal: "", revision: 0 },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(f.store.snapshot(), before);
    f.store.db.exec("PRAGMA query_only=ON");
    assert.equal(
      f.store.execute(
        { type: "projectEdit", id, name: "未保存", goal: "", revision: 1 },
        "main",
      ).ok,
      false,
    );
    f.store.db.exec("PRAGMA query_only=OFF");
    assert.deepEqual(f.store.snapshot(), before);
    f.store.close();
    const reopened = new Store(f.data);
    assert.deepEqual(reopened.snapshot(), before);
    reopened.close();
  } finally {
    try {
      f.store.close();
    } catch {
      /* already closed */
    }
  }
});
test("projects: archive undo binds exact revision, rejects expired/repeated tokens and keeps related data", async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    const folder = await inspectProjectFolder(f.folder);
    assert.equal(
      f.store.execute(
        { type: "projectCreate", id, name: "项目", goal: "", folder },
        "main",
        "host",
      ).ok,
      true,
    );
    writeFileSync(join(f.folder, "unchanged.txt"), "project files stay intact");
    const unrelated = f.store.snapshot().conversations;
    const archived = f.store.execute(
      { type: "projectArchive", id, archived: true, revision: 0 },
      "main",
    );
    assert.ok(archived.ok && archived.projectUndo);
    assert.equal(
      f.store.execute(
        { type: "projectUndo", id, token: archived.projectUndo.token },
        "panel",
      ).ok,
      true,
    );
    assert.equal(
      f.store.execute(
        { type: "projectUndo", id, token: archived.projectUndo.token },
        "main",
      ).ok,
      false,
    );
    assert.equal(f.store.snapshot().projects[0].archivedAt, null);
    assert.deepEqual(f.store.snapshot().conversations, unrelated);
    assert.equal(
      readFileSync(join(f.folder, "unchanged.txt"), "utf8"),
      "project files stay intact",
    );
    const again = f.store.execute(
      { type: "projectArchive", id, archived: true, revision: 2 },
      "main",
    );
    assert.ok(again.ok && again.projectUndo);
    assert.equal(
      f.store.execute(
        { type: "projectEdit", id, name: "编辑后", goal: "", revision: 3 },
        "main",
      ).ok,
      true,
    );
    assert.equal(
      f.store.execute(
        { type: "projectUndo", id, token: again.projectUndo.token },
        "main",
      ).ok,
      false,
    );
    const current = f.store.execute(
      { type: "projectArchive", id, archived: false, revision: 4 },
      "main",
    );
    assert.ok(current.ok && current.projectUndo);
    f.store.db
      .prepare("UPDATE project_undo SET expires_at=? WHERE token=?")
      .run("2000-01-01T00:00:00.000Z", current.projectUndo.token);
    assert.equal(
      f.store.execute(
        { type: "projectUndo", id, token: current.projectUndo.token },
        "main",
      ).ok,
      false,
    );
  } finally {
    f.store.close();
  }
});

test("projects: schema 23 migration preserves conversations and creates a complete pre-upgrade backup", () => {
  const f = fixture();
  const before = f.store.snapshot().conversations;
  f.store.close();
  const legacy = new DatabaseSync(join(f.data, "state.sqlite"));
  legacy.exec(
    "DROP TABLE project_turn_contexts; DROP TABLE project_chats; DROP TABLE project_runtime; DROP TABLE project_events; DROP TABLE project_undo; DROP TABLE projects; PRAGMA user_version=23",
  );
  legacy.close();
  const migrated = new Store(f.data);
  try {
    assert.deepEqual(migrated.snapshot().conversations, before);
    assert.deepEqual(migrated.snapshot().projects, []);
    assert.equal(
      migrated.db.prepare("PRAGMA user_version").get()?.user_version,
      28,
    );
    const backup = readdirSync(dirname(f.data)).find((name) =>
      name.startsWith(basename(f.data) + "-schema-23-backup-"),
    );
    assert.ok(backup);
    const original = new DatabaseSync(
      join(dirname(f.data), backup, "data", "state.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        original.prepare("PRAGMA user_version").get()?.user_version,
        23,
      );
    } finally {
      original.close();
    }
  } finally {
    migrated.close();
  }
});

test("projects: organization migration preserves old identities and rolls back after an injected failure", async () => {
  const f = fixture();
  const folder = await inspectProjectFolder(f.folder);
  const id = randomUUID();
  const chat = randomUUID();
  assert.ok(
    f.store.execute(
      { type: "projectCreate", id, name: "旧项目", goal: "旧目标", folder },
      "main",
      "host",
    ).ok,
  );
  assert.ok(
    f.store.execute(
      {
        type: "projectWork",
        request: { type: "chat", projectId: id, conversationId: chat },
      },
      "main",
      "host",
    ).ok,
  );
  assert.ok(
    f.store.execute(
      { type: "projectArchive", id, archived: true, revision: 0 },
      "main",
    ).ok,
  );
  const before = f.store
    .snapshot()
    .projects.find((project) => project.id === id)!;
  f.store.close();
  const legacy = new DatabaseSync(join(f.data, "state.sqlite"));
  legacy.exec(
    "DROP TABLE project_order; ALTER TABLE projects DROP COLUMN pinned_at; PRAGMA user_version=27",
  );
  legacy.close();
  const original = migrations[27];
  migrations[27] = (db) => {
    if (typeof original === "function") original(db);
    throw new Error("injected migration failure");
  };
  try {
    assert.throws(() => new Store(f.data), /原数据未被替换/);
  } finally {
    migrations[27] = original;
  }
  const afterFailure = new DatabaseSync(join(f.data, "state.sqlite"));
  try {
    assert.equal(
      afterFailure.prepare("PRAGMA user_version").get()?.user_version,
      27,
    );
    assert.equal(
      afterFailure.prepare("SELECT name FROM projects WHERE id=?").get(id)
        ?.name,
      "旧项目",
    );
    assert.equal(
      afterFailure
        .prepare("SELECT project_id FROM project_chats WHERE conversation_id=?")
        .get(chat)?.project_id,
      id,
    );
    assert.equal(
      afterFailure
        .prepare("PRAGMA table_info(projects)")
        .all()
        .some((column) => column.name === "pinned_at"),
      false,
    );
  } finally {
    afterFailure.close();
  }
  const reopened = new Store(f.data);
  try {
    const project = reopened
      .snapshot()
      .projects.find((item) => item.id === id)!;
    assert.equal(project.id, before.id);
    assert.equal(project.archivedAt, before.archivedAt);
    assert.deepEqual(project.chats, before.chats);
    assert.equal(project.folder.identity, before.folder.identity);
    assert.equal(project.pinnedAt, null);
    assert.equal(
      reopened.db.prepare("PRAGMA user_version").get()?.user_version,
      28,
    );
    reopened.close();
    const migrated = new DatabaseSync(join(f.data, "state.sqlite"));
    if (typeof original !== "function")
      throw new Error("expected function migration");
    original(migrated);
    original(migrated);
    migrated.close();
  } finally {
    try {
      reopened.close();
    } catch {
      /* already closed */
    }
  }
});

test("projects: pin and manual moves keep mixed identities, timestamps and rollback together", async () => {
  const f = fixture();
  try {
    const folder = await inspectProjectFolder(f.folder);
    const a = randomUUID(),
      b = randomUUID(),
      chat = randomUUID();
    for (const id of [a, b])
      assert.ok(
        f.store.execute(
          { type: "projectCreate", id, name: "同名", goal: "", folder },
          "main",
          "host",
        ).ok,
      );
    assert.ok(f.store.execute({ type: "create", id: chat }, "main").ok);
    assert.ok(
      f.store.execute(
        { type: "projectPin", id: a, pinned: true, revision: 0 },
        "main",
      ).ok,
    );
    const pinnedAt = f.store
      .snapshot()
      .projects.find((p) => p.id === a)!.pinnedAt;
    assert.ok(pinnedAt);
    assert.ok(
      f.store.execute(
        {
          type: "organizeConversation",
          id: chat,
          action: "pin",
          revision: 0,
          confirmed: false,
        },
        "main",
      ).ok,
    );
    assert.ok(
      f.store.execute(
        { type: "projectPin", id: b, pinned: true, revision: 0 },
        "main",
      ).ok,
    );
    assert.deepEqual(
      f.store.snapshot().pinnedOrder.map((r) => `${r.kind}:${r.id}`),
      [],
    );
    assert.ok(
      f.store.execute(
        {
          type: "movePinned",
          kind: "project",
          id: a,
          before: { kind: "conversation", id: chat },
          revision: 1,
        },
        "main",
      ).ok,
    );
    assert.deepEqual(
      f.store.snapshot().pinnedOrder.map((r) => `${r.kind}:${r.id}`),
      [`project:${b}`, `project:${a}`, `conversation:${chat}`],
    );
    assert.equal(
      f.store.snapshot().projects.find((p) => p.id === a)!.pinnedAt,
      pinnedAt,
    );
    const before = f.store.snapshot();
    f.store.db.exec("PRAGMA query_only=ON");
    assert.equal(
      f.store.execute(
        {
          type: "movePinned",
          kind: "project",
          id: b,
          before: null,
          revision: 1,
        },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(f.store.snapshot(), before);
    f.store.db.exec("PRAGMA query_only=OFF");
  } finally {
    f.store.close();
  }
});

test("projects: sidebar manual order is independent of pinning, archive and display preference", async () => {
  const f = fixture();
  try {
    const folder = await inspectProjectFolder(f.folder);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids)
      assert.ok(
        f.store.execute(
          { type: "projectCreate", id, name: "同名", goal: "", folder },
          "main",
          "host",
        ).ok,
      );
    const manual = () =>
      [...f.store.snapshot().projects]
        .sort((a, b) => a.manualPosition - b.manualPosition)
        .map((p) => p.id);
    assert.deepEqual(
      manual(),
      [ids[2], ids[1], ids[0]],
      "new project starts at front",
    );
    assert.ok(
      f.store.execute(
        { type: "moveProject", id: ids[0], before: ids[2], revision: 0 },
        "main",
      ).ok,
    );
    assert.deepEqual(manual(), [ids[0], ids[2], ids[1]]);
    assert.equal(
      f.store.execute(
        { type: "moveProject", id: ids[0], before: ids[1], revision: 0 },
        "main",
      ).ok,
      false,
    );
    assert.ok(
      f.store.execute(
        { type: "projectPin", id: ids[2], pinned: true, revision: 0 },
        "main",
      ).ok,
    );
    assert.equal(
      f.store.execute(
        { type: "moveProject", id: ids[1], before: ids[2], revision: 0 },
        "main",
      ).ok,
      false,
    );
    assert.ok(
      f.store.execute(
        { type: "projectArchive", id: ids[2], archived: true, revision: 1 },
        "main",
      ).ok,
    );
    assert.equal(
      f.store.snapshot().projects.find((p) => p.id === ids[2])!.pinnedAt,
      null,
    );
    assert.ok(
      f.store.execute(
        { type: "projectArchive", id: ids[2], archived: false, revision: 2 },
        "main",
      ).ok,
    );
    assert.equal(
      f.store.snapshot().projects.find((p) => p.id === ids[2])!.pinnedAt,
      null,
    );
    const order = manual();
    assert.ok(
      f.store.execute(
        { type: "setInterfacePreference", key: "pinnedSort", value: "manual" },
        "main",
      ).ok,
    );
    assert.deepEqual(manual(), order);
    f.store.close();
    const reopened = new Store(f.data);
    assert.deepEqual(
      [...reopened.snapshot().projects]
        .sort((a, b) => a.manualPosition - b.manualPosition)
        .map((p) => p.id),
      order,
    );
    reopened.close();
  } finally {
    try {
      f.store.close();
    } catch {
      /* already closed */
    }
  }
});

test("projects: sidebar chooses five unpinned rows and pinyin, while mixed pin sorting uses kind and identity", async () => {
  const f = fixture();
  try {
    const folder = await inspectProjectFolder(f.folder);
    const names = ["重庆", "北京", "阿里", "上海", "广州", "南京"];
    const ids = names.map(() => randomUUID());
    ids.forEach((id, i) =>
      assert.ok(
        f.store.execute(
          { type: "projectCreate", id, name: names[i], goal: "", folder },
          "main",
          "host",
        ).ok,
      ),
    );
    assert.deepEqual(
      sidebarProjects(f.store.snapshot().projects, "name").map((p) => p.name),
      ["阿里", "北京", "重庆", "广州", "南京"],
    );
    assert.equal(
      sidebarProjects(f.store.snapshot().projects, "manual")[0].id,
      ids[5],
    );
    assert.ok(
      f.store.execute(
        { type: "projectPin", id: ids[5], pinned: true, revision: 0 },
        "main",
      ).ok,
    );
    assert.equal(
      sidebarProjects(f.store.snapshot().projects, "manual").some(
        (p) => p.id === ids[5],
      ),
      false,
    );
    const chat = randomUUID();
    assert.ok(f.store.execute({ type: "create", id: chat }, "main").ok);
    assert.ok(
      f.store.execute(
        {
          type: "organizeConversation",
          id: chat,
          action: "pin",
          revision: 0,
          confirmed: false,
        },
        "main",
      ).ok,
    );
    const snap = f.store.snapshot();
    assert.deepEqual(
      pinnedObjects(
        snap.conversations,
        snap.projects,
        "pinned",
        snap.pinnedOrder,
      ).map((r) => r.kind),
      ["conversation", "project"],
    );
    assert.ok(
      f.store.execute(
        {
          type: "movePinned",
          kind: "project",
          id: ids[5],
          before: { kind: "conversation", id: chat },
          revision: 1,
        },
        "main",
      ).ok,
    );
    const moved = f.store.snapshot();
    assert.deepEqual(
      pinnedObjects(
        moved.conversations,
        moved.projects,
        "manual",
        moved.pinnedOrder,
      ).map((r) => r.kind),
      ["project", "conversation"],
    );
  } finally {
    f.store.close();
  }
});
