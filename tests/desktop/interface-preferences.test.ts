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
    });
    assert.ok(store.execute(set("rightPanelWidth", 520), "panel").ok);
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: 520,
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
    });
    write('{"sidebarCollapsed":true,"rightPanelWidth":"wide"}');
    assert.deepEqual(store.snapshot().settings.interface, {
      sidebarCollapsed: true,
      rightPanelWidth: null,
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
    assert.equal(schemaVersion, 26);
    assert.equal(
      (
        migrated.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      26,
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
  writeInterfaceCache(path, { sidebarCollapsed: true, rightPanelWidth: 512 });
  assert.deepEqual(readInterfaceCache(path), {
    sidebarCollapsed: true,
    rightPanelWidth: 512,
  });
  writeInterfaceCache(path, { sidebarCollapsed: false, rightPanelWidth: null });
  assert.deepEqual(readInterfaceCache(path), {
    sidebarCollapsed: false,
    rightPanelWidth: null,
  });
  assert.equal(
    readFileSync(path, "utf8"),
    '{"sidebarCollapsed":false,"rightPanelWidth":null}',
  );
  for (const damaged of [
    "{",
    "[]",
    '{"sidebarCollapsed":"yes","rightPanelWidth":null}',
    '{"sidebarCollapsed":true,"rightPanelWidth":10}',
    '{"sidebarCollapsed":true}',
  ]) {
    writeFileSync(path, damaged);
    assert.equal(readInterfaceCache(path), undefined, damaged);
  }
});
