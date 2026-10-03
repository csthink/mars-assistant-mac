import { restorePreRuntimeFixture } from "./legacy-codex-schema";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createClaudeFixture } from "./claude-fixture";
import { createCodexFixture } from "./codex-fixture";
import { ClaudeDetector, claudeEffortRecord } from "../../src/main/claude";
import { CodexDetector, codexEffortRecord } from "../../src/main/codex";
import { claudeRunArgs } from "../../src/main/claude-contract";
import { ClaudeConnector } from "../../src/main/claude-connector";
import { CodexRpc } from "../../src/main/codex-rpc";
import { startCodexThread } from "../../src/main/codex-session";
import { streamChat, TransportError } from "../../src/main/transport";
import { trustBoundaryNotice } from "../../src/shared/capabilities";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store, schemaVersion } from "../../src/service/store";
import { selectedModel } from "../../src/service/models";
import {
  validCommand,
  validEffort,
  validHostCommand,
  type EffortRecord,
} from "../../src/shared/protocol";
import type { ClaudeConnection } from "../../src/shared/claude";
import type { CodexConnection } from "../../src/shared/codex";

mkdirSync(".test-data/disposable", { recursive: true });
const claudeHelper = resolve("dist/claude-mcp.cjs");
const at = "2026-09-18T00:00:00.000Z";
const codexOrigin: CodexConnection = {
  provider: "openai",
  endpoint: "CLI 未报告默认地址",
  authentication: "chatgpt",
  identity: "a".repeat(64),
  fingerprint: "b".repeat(64),
  instructions: [],
  configurationInstructions: [],
};
const claudeOrigin: ClaudeConnection = {
  ...codexOrigin,
  provider: "firstParty",
  authentication: "subscription",
  fingerprint: "c".repeat(64),
};
const record = (
  levels: string[],
  defaultLevel: string | null,
  source: EffortRecord["source"] = "codex-model-list",
): EffortRecord => ({ levels, defaultLevel, source, recordedAt: at });

test("effort: records validate identifiers, limits, default membership and exact shape", () => {
  assert.equal(validEffort(null), true);
  assert.equal(validEffort(record(["low", "high"], "high")), true);
  assert.equal(validEffort(record(["low"], null, "claude-initialize")), true);
  assert.equal(validEffort(record([], null)), false);
  assert.equal(validEffort(record(["low", "low"], null)), false);
  assert.equal(validEffort(record(["Low"], null)), false);
  assert.equal(validEffort(record(["x".repeat(33)], null)), false);
  assert.equal(validEffort(record(["low"], "medium")), false);
  assert.equal(
    validEffort(
      record(
        Array.from({ length: 17 }, (_, i) => `l${i}`),
        null,
      ),
    ),
    false,
  );
  assert.equal(
    validEffort({ ...record(["low"], null), source: "guess" }),
    false,
  );
  assert.equal(
    validEffort({ ...record(["low"], null), recordedAt: "yesterday" }),
    false,
  );
  assert.equal(validEffort({ ...record(["low"], null), extra: 1 }), false);
  assert.equal(validEffort(undefined), false);
});

test("effort: Claude records need both the --effort flag and initialize metadata; nothing is inferred", () => {
  const help = "  --effort <level>  Effort level (low, medium, high)\n";
  const item = {
    value: "default",
    resolvedModel: "claude-x",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  };
  assert.deepEqual(claudeEffortRecord(help, item, at), {
    levels: ["low", "medium", "high"],
    defaultLevel: null,
    source: "claude-initialize",
    recordedAt: at,
  });
  assert.equal(claudeEffortRecord("--model --tools", item, at), null);
  assert.equal(
    claudeEffortRecord(help, { ...item, supportsEffort: false }, at),
    null,
  );
  assert.equal(
    claudeEffortRecord(help, { value: "haiku", resolvedModel: "claude-h" }, at),
    null,
  );
  assert.equal(
    claudeEffortRecord(
      help,
      { ...item, supportedEffortLevels: ["low", "Bad Level"] },
      at,
    ),
    null,
  );
  assert.equal(
    claudeEffortRecord(help, { ...item, supportedEffortLevels: "low" }, at),
    null,
  );
});

test("effort: Codex records prefer the configured default inside the advertised set and reject malformed metadata", () => {
  const item = {
    model: "gpt-x",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "a" },
      { reasoningEffort: "medium", description: "b" },
      { reasoningEffort: "high", description: "c" },
    ],
  };
  assert.deepEqual(codexEffortRecord(item, undefined, at), {
    levels: ["low", "medium", "high"],
    defaultLevel: "medium",
    source: "codex-model-list",
    recordedAt: at,
  });
  assert.equal(codexEffortRecord(item, "high", at)?.defaultLevel, "high");
  assert.equal(codexEffortRecord(item, "ultra", at)?.defaultLevel, "medium");
  assert.equal(
    codexEffortRecord(
      { ...item, defaultReasoningEffort: "ultra" },
      undefined,
      at,
    )?.defaultLevel,
    null,
  );
  assert.equal(codexEffortRecord({ model: "gpt-x" }, "high", at), null);
  assert.equal(
    codexEffortRecord(
      { ...item, supportedReasoningEfforts: [] },
      undefined,
      at,
    ),
    null,
  );
  assert.equal(
    codexEffortRecord(
      { ...item, supportedReasoningEfforts: [{ reasoningEffort: 5 }] },
      undefined,
      at,
    ),
    null,
  );
});

test("effort: Claude detection reads levels per resolved model from the actual installation and reports unrecorded models without failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-effort-claude-"));
  const cli = createClaudeFixture(join(root, "cli"));
  try {
    const detector = new ClaudeDetector(root, { HOME: root, PATH: cli.bin });
    const status = await detector.detect();
    assert.equal(status.protocol, "available");
    assert.deepEqual(Object.keys(status.efforts), ["claude-synthetic[1m]"]);
    assert.deepEqual(status.efforts["claude-synthetic[1m]"].levels, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.equal(status.efforts["claude-synthetic[1m]"].defaultLevel, null);
    assert.equal(
      status.efforts["claude-synthetic[1m]"].source,
      "claude-initialize",
    );
    cli.update({ effortFlag: false });
    const withoutFlag = await new ClaudeDetector(root, {
      HOME: root,
      PATH: cli.bin,
    }).detect();
    assert.equal(withoutFlag.protocol, "available");
    assert.deepEqual(withoutFlag.efforts, {});
    assert.deepEqual(withoutFlag.models, [
      "claude-synthetic[1m]",
      "claude-other",
    ]);
    cli.update({
      effortFlag: true,
      efforts: { "claude-other": ["low", "max"] },
    });
    const other = await new ClaudeDetector(root, {
      HOME: root,
      PATH: cli.bin,
    }).detect();
    assert.deepEqual(Object.keys(other.efforts), ["claude-other"]);
    assert.deepEqual(other.efforts["claude-other"].levels, ["low", "max"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effort: Codex detection reads per-model levels and defaults from model/list and the configured user default", async () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-effort-codex-"));
  const cli = createCodexFixture(root);
  try {
    const status = await new CodexDetector(root, {
      HOME: root,
      PATH: cli.bin,
    }).detect();
    assert.equal(status.protocol, "available");
    assert.deepEqual(status.efforts["synthetic-model"], {
      levels: ["low", "medium", "high", "xhigh"],
      defaultLevel: "medium",
      source: "codex-model-list",
      recordedAt: status.efforts["synthetic-model"].recordedAt,
    });
    cli.update({ models: ["other-model"], configuredEffort: "high" });
    const configured = await new CodexDetector(root, {
      HOME: root,
      PATH: cli.bin,
    }).detect();
    assert.equal(configured.efforts["synthetic-model"].defaultLevel, "high");
    assert.equal("other-model" in configured.efforts, false);
    assert.deepEqual(configured.models, ["synthetic-model", "other-model"]);
    cli.update({ configuredEffort: "ultra", efforts: {} });
    const unrecorded = await new CodexDetector(root, {
      HOME: root,
      PATH: cli.bin,
    }).detect();
    assert.equal(unrecorded.protocol, "available");
    assert.deepEqual(unrecorded.efforts, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effort: records persist per connection and model, refresh from the host only, and never exist for API providers", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-effort-store-"));
  const store = new Store(root);
  try {
    const effort = record(["low", "medium", "high"], "medium");
    assert.equal(
      validHostCommand({
        type: "configureCodex",
        model: "synthetic-model",
        configuration: codexOrigin,
        effort,
      }),
      true,
    );
    assert.equal(
      validHostCommand({
        type: "configureCodex",
        model: "synthetic-model",
        configuration: codexOrigin,
        effort: { levels: [], defaultLevel: null },
      }),
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "configureCodex",
          model: "synthetic-model",
          configuration: codexOrigin,
          effort,
        },
        "main",
        "host",
      ).ok,
      true,
    );
    const codex = () =>
      store.snapshot().connections.find((c) => c.provider === "codex")!;
    assert.deepEqual(codex().models[0].effort, effort);
    assert.deepEqual(selectedModel(store.db, codex().id).effort, effort);
    assert.equal(
      store.execute(
        {
          type: "configureClaude",
          model: "claude-synthetic[1m]",
          configuration: claudeOrigin,
          effort: record(["low", "high"], null, "claude-initialize"),
        },
        "main",
        "host",
      ).ok,
      true,
    );
    const claude = store
      .snapshot()
      .connections.find((c) => c.provider === "claude")!;
    assert.deepEqual(claude.models[0].effort?.levels, ["low", "high"]);
    assert.equal(claude.models[0].effort?.defaultLevel, null);
    // A second confirmed model of the same origin keeps the first model's record untouched.
    assert.equal(
      store.execute(
        {
          type: "configureCodex",
          model: "other-model",
          configuration: { ...codexOrigin, fingerprint: "d".repeat(64) },
          effort: null,
        },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.deepEqual(
      codex().models.map((m) => [m.model, m.effort?.defaultLevel ?? null]),
      [
        ["synthetic-model", "medium"],
        ["other-model", null],
      ],
    );
    // The renderer cannot write records; only host refreshes may, and they replace exactly what was read back.
    const refresh = {
      type: "recordEffort" as const,
      provider: "codex" as const,
      efforts: { "synthetic-model": record(["low", "high"], "high") },
    };
    assert.equal(validHostCommand(refresh), true);
    assert.equal(validHostCommand({ ...refresh, provider: "deepseek" }), false);
    assert.equal(
      validHostCommand({
        ...refresh,
        efforts: { "bad model id": record(["low"], null) },
      }),
      false,
    );
    assert.equal(store.execute(refresh, "main").ok, false);
    assert.equal(store.execute(refresh, "main", "host").ok, true);
    assert.deepEqual(
      codex().models.map((m) => [m.model, m.effort?.defaultLevel ?? null]),
      [
        ["synthetic-model", "high"],
        ["other-model", null],
      ],
    );
    assert.equal(
      store.execute(
        { type: "recordEffort", provider: "codex", efforts: {} },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.deepEqual(
      codex().models.map((m) => m.effort),
      [null, null],
    );
    assert.deepEqual(claude.models[0].effort?.levels, ["low", "high"]);
    const api = randomUUID();
    assert.equal(
      store.execute(
        {
          type: "upsertConnection",
          id: api,
          name: "DeepSeek",
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-chat",
          secretRef: null,
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        },
        "main",
      ).ok,
      true,
    );
    const deepseek = store.snapshot().connections.find((c) => c.id === api)!;
    assert.equal(deepseek.models[0].effort, null);
    assert.equal(
      selectedModel(store.db, api, "deepseek-chat", false).effort,
      null,
    );
    assert.equal(
      store.execute(
        {
          type: "recordEffort",
          provider: "claude",
          efforts: { "claude-synthetic[1m]": null },
        },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.equal(
      store.snapshot().connections.find((c) => c.provider === "claude")!
        .models[0].effort,
      null,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("effort: schema 20 data upgrades to 21 behind a verified backup and keeps confirmed models unrecorded", () => {
  const parent = mkdtempSync(resolve(".test-data/disposable/effort-upgrade-"));
  const dir = join(parent, "data");
  mkdirSync(dir);
  const seed = new Store(dir);
  seed.execute(
    {
      type: "configureCodex",
      model: "synthetic-model",
      configuration: codexOrigin,
      effort: record(["low", "high"], "low"),
    },
    "main",
    "host",
  );
  seed.close();
  const legacy = new DatabaseSync(join(dir, "state.sqlite"));
  restorePreRuntimeFixture(legacy);
  legacy.exec(
    "PRAGMA foreign_keys=OFF; ALTER TABLE connection_models DROP COLUMN effort_json; ALTER TABLE conversations DROP COLUMN effort; PRAGMA user_version=20;",
  );
  legacy.close();
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
    // The current schema version; later versions add project organization (25), interface preferences (26)
    // conversation creation times with the pinned order (27), and project organization (28).
    assert.equal(schemaVersion, 30);
    const backups = readdirSync(parent).filter((name) =>
      name.startsWith("data-schema-20-backup-"),
    );
    assert.equal(backups.length, 1);
    const manifest = JSON.parse(
      readFileSync(join(parent, backups[0], "complete.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 20);
    const codex = store
      .snapshot()
      .connections.find((c) => c.provider === "codex")!;
    assert.equal(codex.models.length, 1);
    assert.equal(codex.models[0].enabled, true);
    assert.equal(codex.models[0].effort, null);
    assert.deepEqual(codex.codex, codexOrigin);
    store.db
      .prepare(
        "UPDATE connection_models SET effort_json='{not json' WHERE model_id='synthetic-model'",
      )
      .run();
    assert.equal(
      store.snapshot().connections.find((c) => c.provider === "codex")!
        .models[0].effort,
      null,
    );
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("effort: the conversation choice is validated against the current record, resets on model change and resolves into the turn snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-effort-choice-"));
  const store = new Store(root);
  try {
    assert.equal(
      store.execute(
        {
          type: "configureCodex",
          model: "synthetic-model",
          configuration: codexOrigin,
          effort: record(["low", "medium", "high"], "medium"),
        },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.equal(
      store.execute(
        {
          type: "configureCodex",
          model: "second-model",
          configuration: { ...codexOrigin, fingerprint: "d".repeat(64) },
          effort: record(["low", "high"], "low"),
        },
        "main",
        "host",
      ).ok,
      true,
    );
    const codex = store
      .snapshot()
      .connections.find((c) => c.provider === "codex")!;
    const api = randomUUID();
    assert.equal(
      store.execute(
        {
          type: "upsertConnection",
          id: api,
          name: "API",
          provider: "custom",
          baseUrl: "http://127.0.0.1:1/v1",
          model: "api-model",
          secretRef: randomUUID(),
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        },
        "main",
      ).ok,
      true,
    );
    const conversation = randomUUID();
    assert.equal(
      store.execute({ type: "create", id: conversation }, "main").ok,
      true,
    );
    const current = () =>
      store.snapshot().conversations.find((c) => c.id === conversation)!;
    const choose = (effort: string | null) =>
      store.execute(
        { type: "chooseEffort", conversationId: conversation, effort },
        "main",
      );
    assert.equal(
      validCommand({
        type: "chooseEffort",
        conversationId: conversation,
        effort: "Bad Level",
      }),
      false,
    );
    assert.equal(
      validCommand({
        type: "chooseEffort",
        conversationId: conversation,
        effort: null,
      }),
      true,
    );
    // No connection chosen and no default: nothing to validate against.
    assert.equal(choose("high").ok, false);
    assert.equal(
      store.execute(
        {
          type: "chooseConnection",
          conversationId: conversation,
          connectionId: codex.id,
          model: "synthetic-model",
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(current().effort, null);
    assert.equal(choose("ultra").ok, false);
    assert.equal(choose("high").ok, true);
    assert.equal(current().effort, "high");
    // Switching the model never carries the level over.
    assert.equal(
      store.execute(
        {
          type: "chooseConnection",
          conversationId: conversation,
          connectionId: codex.id,
          model: "second-model",
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(current().effort, null);
    assert.equal(choose("medium").ok, false);
    assert.equal(choose("high").ok, true);
    const submit = (model: string, requestId = randomUUID()) => {
      const reply = store.execute(
        {
          type: "submitTurn",
          requestId,
          conversationId: conversation,
          connectionId: current().connectionId ?? codex.id,
          model,
          text: "你好",
        },
        "main",
      );
      return {
        ok: reply.ok,
        message: reply.ok ? "" : reply.message,
        turn: store.snapshot().turns.find((t) => t.requestId === requestId),
      };
    };
    const chosen = submit("second-model");
    assert.equal(chosen.ok, true, chosen.message);
    assert.equal(chosen.turn?.connection.effort, "high");
    store.db.prepare("UPDATE turns SET state='completed'").run();
    // Unselected: the recorded default is what the session will receive.
    assert.equal(choose(null).ok, true);
    const defaulted = submit("second-model");
    assert.equal(defaulted.ok, true, defaulted.message);
    assert.equal(defaulted.turn?.connection.effort, "low");
    store.db.prepare("UPDATE turns SET state='completed'").run();
    // A record that disappeared invalidates an explicit choice instead of silently dropping it.
    assert.equal(choose("high").ok, true);
    assert.equal(
      store.execute(
        { type: "recordEffort", provider: "codex", efforts: {} },
        "main",
        "host",
      ).ok,
      true,
    );
    const stale = submit("second-model");
    assert.equal(stale.ok, false);
    assert.match(stale.message, /推理强度/);
    assert.equal(choose(null).ok, true);
    const unrecorded = submit("second-model");
    assert.equal(unrecorded.ok, true, unrecorded.message);
    assert.equal(unrecorded.turn?.connection.effort, null);
    store.db.prepare("UPDATE turns SET state='completed'").run();
    // API providers never carry a level.
    assert.equal(
      store.execute(
        {
          type: "chooseConnection",
          conversationId: conversation,
          connectionId: api,
          model: "api-model",
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(choose("high").ok, false);
    assert.equal(
      store.execute(
        {
          type: "grantConnectionScope",
          conversationId: conversation,
          connectionId: api,
          baseUrl: "http://127.0.0.1:1/v1",
        },
        "main",
      ).ok,
      true,
    );
    const viaApi = submit("api-model");
    assert.equal(viaApi.ok, true, viaApi.message);
    assert.equal(viaApi.turn?.connection.effort, null);
    // Historic snapshots keep the level they were submitted with.
    assert.equal(
      store.snapshot().turns.find((t) => t.id === chosen.turn?.id)?.connection
        .effort,
      "high",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("effort: Claude sessions pass --effort only for a recorded level, re-check the installation before every start and never drop the parameter silently", async () => {
  assert.deepEqual(
    claudeRunArgs("m", "s", { mcpServers: {} }, false, "high").slice(-2),
    ["--effort", "high"],
  );
  assert.equal(
    claudeRunArgs("m", "s", { mcpServers: {} }, false, null).includes(
      "--effort",
    ),
    false,
  );
  const root = mkdtempSync(join(tmpdir(), "csthink-effort-claude-run-"));
  const cli = createClaudeFixture(join(root, "cli"));
  const connector = new ClaudeConnector(join(root, "runs"), claudeHelper, {
    HOME: root,
    PATH: cli.bin,
  });
  try {
    const setup = await connector.prepare();
    assert.deepEqual(setup.effortRecord?.levels, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const base = {
      model: setup.model,
      configuration: setup.configuration,
      messages: [{ role: "user" as const, content: "hello" }],
      signal: new AbortController().signal,
      budget: 10000,
      onDelta: () => {},
      onSession: async () => {},
    };
    const calls = () =>
      readFileSync(cli.calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args?: string[]; type?: string });
    const sessionsWith = (level: string | null, from = 0) =>
      calls()
        .slice(from)
        .filter(
          (c) =>
            c.args?.includes("--session-id") &&
            (level === null
              ? !c.args.includes("--effort")
              : c.args[c.args.indexOf("--effort") + 1] === level),
        ).length;
    const prepared = calls().length;
    await connector.run({ ...base, effort: "high" });
    // Both the synthetic contract run and the real session carried the level.
    assert.ok(sessionsWith("high", prepared) >= 2);
    assert.equal(sessionsWith(null, prepared), 0);
    const before = calls().length;
    await assert.rejects(
      connector.run({ ...base, effort: "ultra" }),
      (error: unknown) =>
        error instanceof TransportError &&
        error.errorClass === "unsupported" &&
        /推理强度/.test(error.message),
    );
    assert.equal(
      calls()
        .slice(before)
        .some((c) => c.args?.includes("--session-id")),
      false,
    );
    cli.update({ effortFlag: false });
    const flagless = calls().length;
    await assert.rejects(
      connector.run({ ...base, effort: "high" }),
      (error: unknown) =>
        error instanceof TransportError && /推理强度/.test(error.message),
    );
    assert.equal(sessionsWith(null, flagless), 0);
    assert.equal(sessionsWith("high", flagless), 0);
    // Without a level the session starts as before, whatever the installation offers.
    await connector.run({ ...base, effort: null });
    assert.ok(sessionsWith(null, flagless) >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effort: Codex threads carry model_reasoning_effort in the thread configuration and stop when the read-back differs", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "csthink-effort-codex-run-")),
  );
  const cli = createCodexFixture(root);
  const open = async () => {
    const rpc = new CodexRpc(
      cli.binary,
      ["app-server"],
      { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" } },
      5000,
    );
    await rpc.request("initialize", {
      clientInfo: { name: "fixture", version: "1" },
    });
    rpc.notify("initialized");
    return rpc;
  };
  const started = () =>
    readFileSync(cli.calls, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: { config?: Record<string, unknown> };
          },
      )
      .filter(
        (c) => c.method === "thread/start" || c.method === "thread/resume",
      );
  try {
    let rpc = await open();
    const thread = await startCodexThread(
      rpc,
      root,
      "synthetic-model",
      "openai",
      false,
      undefined,
      "high",
    );
    assert.equal(thread.model, "synthetic-model");
    assert.deepEqual(started().at(-1)?.params?.config, {
      model_reasoning_effort: "high",
    });
    await rpc.close();
    rpc = await open();
    await startCodexThread(
      rpc,
      root,
      "synthetic-model",
      "openai",
      false,
      undefined,
      null,
    );
    assert.equal("config" in (started().at(-1)?.params ?? {}), false);
    await rpc.close();
    cli.update({ effortReadback: "low" });
    rpc = await open();
    await assert.rejects(
      startCodexThread(
        rpc,
        root,
        "synthetic-model",
        "openai",
        false,
        undefined,
        "high",
      ),
      (error: unknown) =>
        error instanceof TransportError && /推理强度/.test(error.message),
    );
    await rpc.close();
    rpc = await open();
    // A resumed thread receives the same configuration and the same read-back check.
    const resume = {
      threadId: "thread-fixture",
      turnId: null,
      cwd: root,
      model: "synthetic-model",
      provider: "openai",
      fingerprint: "b".repeat(64),
      installation: {
        path: cli.binary,
        resolvedPath: cli.binary,
        version: "0.153.4",
      },
    };
    await assert.rejects(
      startCodexThread(
        rpc,
        root,
        "synthetic-model",
        "openai",
        false,
        resume,
        "high",
      ),
      (error: unknown) =>
        error instanceof TransportError && /推理强度/.test(error.message),
    );
    assert.deepEqual(started().at(-1)?.params?.config, {
      model_reasoning_effort: "high",
    });
    await rpc.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effort: API chat requests carry no effort field on any path", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as AddressInfo).port;
    await streamChat(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "api-model",
        apiKey: "synthetic-key",
      },
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
      () => {},
    );
    const body = JSON.parse(seen[0]) as Record<string, unknown>;
    for (const key of [
      "effort",
      "reasoning_effort",
      "reasoning",
      "thinking",
      "model_reasoning_effort",
    ])
      assert.equal(key in body, false, key);
    assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "stream"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("access boundary: the fixed notice equals the ACCESS-02 sentence in tests/desktop/fixtures/access-02-notice.txt byte for byte", () => {
  const sentence = readFileSync(
    resolve("tests/desktop/fixtures/access-02-notice.txt"),
    "utf8",
  );
  assert.ok(sentence.length > 0, "the ACCESS-02 fixture must not be empty");
  assert.equal(trustBoundaryNotice, sentence);
  assert.ok(
    trustBoundaryNotice.startsWith("本地 Agent 以当前 macOS 账户运行。"),
  );
});

test("walkthrough: the scope grant accepts a local executor's empty address and still rejects malformed ones", () => {
  const base = {
    type: "grantConnectionScope" as const,
    conversationId: randomUUID(),
    connectionId: randomUUID(),
  };
  assert.equal(validCommand({ ...base, baseUrl: "" }), true);
  assert.equal(
    validCommand({ ...base, baseUrl: "https://api.example.com/v1" }),
    true,
  );
  assert.equal(validCommand({ ...base, baseUrl: " " }), false);
  assert.equal(validCommand({ ...base, baseUrl: "not a url" }), false);
  assert.equal(validCommand({ ...base, baseUrl: "http://example.com" }), false);
});
