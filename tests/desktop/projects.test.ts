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
import { Store } from "../../src/service/store";
import { ProjectFolders, inspectProjectFolder } from "../../src/main/projects";
import {
  validProjectCommand,
  validProjectHostCommand,
} from "../../src/shared/projects";
import { warmSystemGit } from "./git-warmup";

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
      26,
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
