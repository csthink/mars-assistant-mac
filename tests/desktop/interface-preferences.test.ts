import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, schemaVersion } from "../../src/service/store";
import {
  defaultInterfacePreferences,
  validCommand,
} from "../../src/shared/protocol";
import {
  readInterfaceCache,
  writeInterfaceCache,
} from "../../src/main/appearance-cache";

function open() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/interface-preferences-"));
}
/** The keys added for the sidebar sections, at their defaults. */
const sections = {
  pinnedSort: "pinned",
  pinnedFolded: false,
  projectsFolded: false,
  recentFolded: false,
} as const;
const set = (key: string, value: unknown) => ({
  type: "setInterfacePreference",
  key,
  value,
});

test("interface preferences: a new data root reads the defaults, and each key is saved on its own without touching other settings", () => {
  const dir = open();
  const store = new Store(dir);
  try {
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: false,
      rightPanelWidth: null,
      ...sections,
    });
    assert.deepEqual(
      store.snapshot().settings.interface,
      defaultInterfacePreferences,
    );
    assert.ok(
      store.execute({ type: "setAppearance", appearance: "dark" }, "main").ok,
    );
    assert.ok(store.execute(set("sidebarCollapsed", true), "main").ok);
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: null,
      ...sections,
    });
    assert.ok(store.execute(set("rightPanelWidth", 520), "panel").ok);
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: 520,
      ...sections,
    });
    assert.ok(store.execute(set("rightPanelWidth", null), "main").ok);
    assert.equal(store.snapshot().settings.interface.rightPanelWidth, null);
    assert.equal(store.snapshot().settings.appearance, "dark");
  } finally {
    store.close();
  }
  const reopened = new Store(dir);
  try {
    assert.deepEqual(reopened.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: null,
      ...sections,
    });
  } finally {
    reopened.close();
  }
});

test("interface preferences: unknown keys, wrong types, out-of-range widths and extra fields are refused and change nothing", () => {
  const dir = open();
  const store = new Store(dir);
  try {
    assert.ok(store.execute(set("rightPanelWidth", 480), "main").ok);
    const before = store.snapshot();
    for (const command of [
      set("sidebarWidth", 200),
      set("sidebarCollapsed", "true"),
      set("sidebarCollapsed", 1),
      set("rightPanelWidth", 319),
      set("rightPanelWidth", 2001),
      set("rightPanelWidth", 400.5),
      set("rightPanelWidth", "400"),
      { ...set("sidebarCollapsed", true), extra: 1 },
      { type: "setInterfacePreference", key: "sidebarCollapsed" },
    ]) {
      assert.equal(validCommand(command), false, JSON.stringify(command));
      const reply = store.execute(command, "main");
      assert.equal(reply.ok, false, JSON.stringify(command));
    }
    const after = store.snapshot();
    assert.deepEqual(after.settings, before.settings);
    assert.equal(after.revision, before.revision);
    assert.equal(validCommand(set("rightPanelWidth", 320)), true);
    assert.equal(validCommand(set("rightPanelWidth", 2000)), true);
    assert.equal(validCommand(set("sidebarCollapsed", false)), true);
  } finally {
    store.close();
  }
});

test("interface preferences: a stored value that is not a valid preference object reads each bad key as its default and leaves other settings alone", () => {
  const dir = open();
  const store = new Store(dir);
  try {
    assert.ok(
      store.execute({ type: "setAppearance", appearance: "auto" }, "main").ok,
    );
    const write = (value: string) =>
      store.db
        .prepare("UPDATE settings SET interface_preferences=? WHERE id=1")
        .run(value);
    write('{"sidebarCollapsed":"yes","rightPanelWidth":5}');
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: false,
      rightPanelWidth: null,
      ...sections,
    });
    write('{"sidebarCollapsed":true,"rightPanelWidth":"wide"}');
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: null,
      ...sections,
    });
    write("[1,2]");
    assert.deepEqual(
      store.snapshot().settings.interface,
      defaultInterfacePreferences,
    );
    write('{"sidebarCollapsed":false,"rightPanelWidth":600,"later":1}');
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: false,
      rightPanelWidth: 600,
      ...sections,
    });
    // Text that is not JSON never reaches the column.
    assert.throws(() => write("{not json"));
    assert.equal(store.snapshot().settings.appearance, "auto");
    // Saving one key over a partly bad stored value replaces the bad key and keeps the other valid key.
    write('{"sidebarCollapsed":"yes","rightPanelWidth":700}');
    assert.ok(store.execute(set("sidebarCollapsed", true), "main").ok);
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: 700,
      ...sections,
    });
  } finally {
    store.close();
  }
});

test("interface preferences: schema 25 data upgrades to 26 with the defaults and keeps the saved appearance", () => {
  const dir = open();
  const seed = new Store(dir);
  assert.ok(
    seed.execute({ type: "setAppearance", appearance: "dark" }, "main").ok,
  );
  seed.close();
  const legacy = new DatabaseSync(join(dir, "state.sqlite"));
  legacy.exec(
    "ALTER TABLE settings DROP COLUMN interface_preferences; PRAGMA user_version=25",
  );
  legacy.close();
  const migrated = new Store(dir);
  try {
    assert.equal(
      (
        migrated.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      schemaVersion,
    );
    assert.equal(migrated.snapshot().settings.appearance, "dark");
    assert.deepEqual(
      migrated.snapshot().settings.interface,
      defaultInterfacePreferences,
    );
    assert.equal(
      (
        migrated.db
          .prepare("SELECT interface_preferences AS v FROM settings")
          .get() as { v: string }
      ).v,
      "{}",
    );
  } finally {
    migrated.close();
  }
  // Opening again does not migrate again.
  const again = new Store(dir);
  try {
    assert.ok(again.execute(set("sidebarCollapsed", true), "main").ok);
    assert.equal(again.snapshot().settings.interface.sidebarCollapsed, true);
  } finally {
    again.close();
  }
});

test("interface preferences: the shell cache reads back what it wrote, replaces it whole and reads a missing or damaged file as unknown", () => {
  const dir = open();
  const path = join(dir, "interface");
  assert.equal(readInterfaceCache(path), undefined);
  writeInterfaceCache(path, {
    sidebarCollapsed: true,
    rightPanelWidth: 512,
    ...sections,
  });
  assert.deepEqual(readInterfaceCache(path), {
    sidebarCollapsed: true,
    rightPanelWidth: 512,
    ...sections,
  });
  writeInterfaceCache(path, {
    sidebarCollapsed: false,
    rightPanelWidth: null,
    ...sections,
  });
  assert.deepEqual(readInterfaceCache(path), {
    sidebarCollapsed: false,
    rightPanelWidth: null,
    ...sections,
  });
  assert.equal(
    readFileSync(path, "utf8"),
    '{"sidebarCollapsed":false,"rightPanelWidth":null,"pinnedSort":"pinned","pinnedFolded":false,"projectsFolded":false,"recentFolded":false}',
  );
  for (const damaged of [
    "{",
    "[]",
    '{"sidebarCollapsed":"yes","rightPanelWidth":null}',
    '{"sidebarCollapsed":true,"rightPanelWidth":10}',
    '{"sidebarCollapsed":true}',
    // A cache written before the section keys existed is unknown until the snapshot arrives.
    '{"sidebarCollapsed":true,"rightPanelWidth":null}',
  ]) {
    writeFileSync(path, damaged);
    assert.equal(readInterfaceCache(path), undefined, damaged);
  }
});

test("interface preferences: the pinned sort and the folded sections are saved key by key, refuse values outside their range and read missing or bad values as the defaults", () => {
  const dir = open();
  const store = new Store(dir);
  try {
    assert.deepEqual(
      { ...store.snapshot().settings.interface },
      { sidebarCollapsed: false, rightPanelWidth: null, ...sections },
    );
    assert.ok(store.execute(set("pinnedSort", "manual"), "main").ok);
    assert.ok(store.execute(set("pinnedFolded", true), "main").ok);
    assert.ok(store.execute(set("recentFolded", true), "panel").ok);
    assert.ok(store.execute(set("projectsFolded", true), "main").ok);
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: false,
      rightPanelWidth: null,
      pinnedSort: "manual",
      pinnedFolded: true,
      projectsFolded: true,
      recentFolded: true,
    });
    const before = store.snapshot();
    for (const command of [
      set("pinnedSort", "name"),
      set("pinnedSort", null),
      set("pinnedFolded", "true"),
      set("projectsFolded", 0),
      set("recentFolded", null),
      set("recentSort", "updated"),
    ]) {
      assert.equal(validCommand(command), false, JSON.stringify(command));
      assert.equal(store.execute(command, "main").ok, false);
    }
    assert.deepEqual(store.snapshot().settings, before.settings);
    store.db
      .prepare("UPDATE settings SET interface_preferences=? WHERE id=1")
      .run('{"pinnedSort":"name","pinnedFolded":"yes","recentFolded":true}');
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: false,
      rightPanelWidth: null,
      pinnedSort: "pinned",
      pinnedFolded: false,
      projectsFolded: false,
      recentFolded: true,
    });
  } finally {
    store.close();
  }
  const reopened = new Store(dir);
  try {
    assert.equal(reopened.snapshot().settings.interface.recentFolded, true);
  } finally {
    reopened.close();
  }
});
