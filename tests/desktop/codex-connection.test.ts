import { restorePreClaudeFixture } from "./legacy-codex-schema";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { selectedModel } from "../../src/service/models";
import { validHostCommand } from "../../src/shared/protocol";
import { sameCodexOrigin, type CodexConnection } from "../../src/shared/codex";
const configuration: CodexConnection = {
  provider: "openai",
  endpoint: "CLI 未报告默认地址",
  authentication: "chatgpt",
  identity: "a".repeat(64),
  fingerprint: "b".repeat(64),
  instructions: [],
  configurationInstructions: [],
};
test("Codex connection requires host origin, needs no vault secret and snapshots the approved origin", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-codex-store-"));
  const store = new Store(root);
  try {
    const command = {
      type: "configureCodex",
      model: "synthetic-model",
      configuration,
    };
    assert.equal(store.execute(command, "main").ok, false);
    assert.equal(store.execute(command, "main", "host").ok, true);
    const connection = store
      .snapshot()
      .connections.find((c) => c.provider === "codex")!;
    assert.equal(connection.secretRef, null);
    assert.deepEqual(connection.codex, configuration);
    assert.deepEqual(
      selectedModel(store.db, connection.id).codex,
      configuration,
    );
    assert.equal(
      store.execute(
        {
          type: "setDefaultConnection",
          id: connection.id,
          model: connection.model,
        },
        "main",
      ).ok,
      true,
    );
    const before = store.snapshot();
    assert.equal(store.execute(command, "main", "host").ok, true);
    assert.equal(
      store.snapshot().connections[0].revision,
      before.connections[0].revision,
    );
    const id = randomUUID();
    store.execute({ type: "create", id }, "main");
    assert.equal(
      store.execute(
        {
          type: "chooseConnection",
          conversationId: id,
          connectionId: connection.id,
          model: "synthetic-model",
        },
        "main",
      ).ok,
      true,
    );
    const oldDefault = store.snapshot().settings.defaultModelId;
    assert.equal(
      store.execute(
        {
          ...command,
          model: "second-confirmed-model",
          configuration: { ...configuration, fingerprint: "c".repeat(64) },
        },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.deepEqual(
      store
        .snapshot()
        .connections[0].models.filter((m) => m.enabled)
        .map((m) => m.model),
      ["synthetic-model", "second-confirmed-model"],
    );
    assert.equal(store.snapshot().settings.defaultModelId, oldDefault);
    assert.deepEqual(
      selectedModel(store.db, connection.id, "synthetic-model").codex,
      configuration,
    );
    assert.equal(
      selectedModel(store.db, connection.id, "second-confirmed-model").codex
        ?.fingerprint,
      "c".repeat(64),
    );
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(
      validHostCommand({
        ...command,
        configuration: { ...configuration, token: "must-not-store" },
      }),
      false,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex preferences persist, reject stale writes and block every submission while disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-codex-settings-"));
  let store = new Store(root);
  try {
    assert.equal(
      store.execute(
        { type: "configureCodex", model: "synthetic-model", configuration },
        "main",
        "host",
      ).ok,
      true,
    );
    const c = store.snapshot().connections.find((c) => c.provider === "codex")!;
    store.execute(
      { type: "setDefaultConnection", id: c.id, model: c.model },
      "main",
    );
    assert.equal(
      store.execute(
        {
          type: "setCodexSettings",
          enabled: false,
          path: "/custom/codex",
          revision: 0,
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(store.snapshot().settings.defaultConnectionId, null);
    assert.equal(
      store.execute(
        { type: "setCodexSettings", enabled: true, path: null, revision: 0 },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        { type: "configureCodex", model: c.model, configuration },
        "main",
        "host",
      ).ok,
      false,
    );
    for (const kind of ["model_list", "connection_test"] as const)
      assert.equal(
        store.execute(
          {
            type: "createExecution",
            kind,
            executionId: randomUUID(),
            connectionId: c.id,
            model: c.model,
          },
          "main",
          "host",
        ).ok,
        false,
      );
    assert.throws(() => selectedModel(store.db, c.id), /整合已关闭/);
    store.close();
    store = new Store(root);
    assert.deepEqual(store.snapshot().settings.codex, {
      enabled: false,
      path: "/custom/codex",
      revision: 1,
    });
    assert.equal(
      store.execute(
        { type: "setCodexSettings", enabled: true, path: null, revision: 1 },
        "main",
      ).ok,
      true,
    );
    const run = randomUUID();
    assert.equal(
      store.execute(
        {
          type: "createExecution",
          kind: "connection_test",
          executionId: run,
          connectionId: c.id,
          model: c.model,
        },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.equal(
      store.execute(
        { type: "setCodexSettings", enabled: false, path: null, revision: 2 },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "setCodexSettings",
          enabled: true,
          path: "/different/codex",
          revision: 2,
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(store.snapshot().settings.codex.revision, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema 16 upgrade preserves a disabled native connection and existing history", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-codex-migration-"));
  let store = new Store(root);
  try {
    store.execute(
      { type: "configureCodex", model: "synthetic-model", configuration },
      "main",
      "host",
    );
    const c = store.snapshot().connections.find((c) => c.provider === "codex")!;
    const conversationId = randomUUID();
    store.execute({ type: "create", id: conversationId }, "main");
    store.db.prepare("UPDATE connections SET enabled=0 WHERE id=?").run(c.id);
    restorePreClaudeFixture(store.db);
    store.db.exec(
      "ALTER TABLE connection_models DROP COLUMN codex_json; ALTER TABLE settings DROP COLUMN codex_enabled; ALTER TABLE settings DROP COLUMN codex_path; ALTER TABLE settings DROP COLUMN codex_revision; PRAGMA user_version=16;",
    );
    store.close();
    store = new Store(root);
    assert.deepEqual(store.snapshot().settings.codex, {
      enabled: false,
      path: null,
      revision: 0,
    });
    assert.equal(
      store.snapshot().connections.find((c) => c.provider === "codex")!.id,
      c.id,
    );
    assert.equal(
      store.snapshot().conversations.some((c) => c.id === conversationId),
      true,
    );
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex models keep separate approved origins across restart; changed account invalidates older models without switching defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-codex-models-"));
  let store = new Store(root);
  try {
    const configure = (model: string, origin = configuration) => {
      const r = store.execute(
        { type: "configureCodex", model, configuration: origin },
        "main",
        "host",
      );
      assert.equal(r.ok, true);
    };
    configure("alpha");
    const id = store.snapshot().connections[0].id;
    store.execute({ type: "setDefaultConnection", id, model: "alpha" }, "main");
    configure("beta", { ...configuration, fingerprint: "c".repeat(64) });
    store.close();
    store = new Store(root);
    assert.equal(
      selectedModel(store.db, id, "alpha").codex?.fingerprint,
      configuration.fingerprint,
    );
    assert.equal(
      selectedModel(store.db, id, "beta").codex?.fingerprint,
      "c".repeat(64),
    );
    assert.equal(store.snapshot().settings.defaultModelId, "alpha");
    configure("gamma", {
      ...configuration,
      identity: "d".repeat(64),
      fingerprint: "e".repeat(64),
    });
    assert.equal(store.snapshot().settings.defaultConnectionId, null);
    for (const model of ["alpha", "beta"]) {
      assert.throws(() => selectedModel(store.db, id, model), /尚未确认来源/);
      assert.throws(
        () => selectedModel(store.db, id, model, false),
        /尚未确认来源/,
      );
    }
    assert.equal(
      selectedModel(store.db, id, "gamma").codex?.identity,
      "d".repeat(64),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema 17 migration preserves native source, API key references, configured models and conversation choices", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-codex-model-upgrade-"));
  let store = new Store(root);
  try {
    store.execute(
      { type: "configureCodex", model: "native", configuration },
      "main",
      "host",
    );
    const native = store.snapshot().connections[0];
    const api = randomUUID(),
      conversation = randomUUID();
    assert.equal(
      store.execute(
        {
          type: "upsertConnection",
          id: api,
          name: "API preserved",
          provider: "custom",
          baseUrl: "https://example.test/v1",
          model: "api-model",
          secretRef: "93dc60b8-5f3e-4bce-9bed-b5375c073abe",
          revision: 0,
          imageInput: "unknown",
          contextChars: null,
        },
        "main",
      ).ok,
      true,
    );
    store.execute({ type: "create", id: conversation }, "main");
    store.execute(
      {
        type: "chooseConnection",
        conversationId: conversation,
        connectionId: api,
        model: "api-model",
      },
      "main",
    );
    restorePreClaudeFixture(store.db);
    store.db.exec(
      "ALTER TABLE connection_models DROP COLUMN codex_json; PRAGMA user_version=17;",
    );
    store.close();
    store = new Store(root);
    assert.deepEqual(
      selectedModel(store.db, native.id, "native").codex,
      configuration,
    );
    const state = store.snapshot();
    assert.equal(
      state.connections.find((c) => c.id === api)!.secretRef,
      "93dc60b8-5f3e-4bce-9bed-b5375c073abe",
    );
    assert.equal(
      state.connections.find((c) => c.id === api)!.models[0].model,
      "api-model",
    );
    assert.equal(
      state.conversations.find((c) => c.id === conversation)!.modelId,
      "api-model",
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model consent can be reused only when every account and rule source field remains unchanged", () => {
  assert.equal(
    sameCodexOrigin(configuration, {
      ...configuration,
      fingerprint: "f".repeat(64),
    }),
    true,
  );
  const changes: Partial<CodexConnection>[] = [
    { provider: "other" },
    { endpoint: "https://other.invalid" },
    { authentication: "apiKey" },
    { identity: "c".repeat(64) },
    {
      instructions: [{ path: "/synthetic/AGENTS.md", sha256: "d".repeat(64) }],
    },
    {
      configurationInstructions: [
        { field: "instructions", sha256: "e".repeat(64) },
      ],
    },
  ];
  for (const change of changes)
    assert.equal(
      sameCodexOrigin(configuration, { ...configuration, ...change }),
      false,
    );
});
