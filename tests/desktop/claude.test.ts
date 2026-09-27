import {
  assertClaudePolicy,
  assertClaudeAccountPolicy,
} from "../../src/main/claude-policy";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeFixture } from "./claude-fixture";
import {
  claudeCandidates,
  discoverClaude,
  claudeEnvironment,
} from "../../src/main/claude-discovery";
import {
  ClaudeDetector,
  claudeAuthentication,
  claudeInspectionArgs,
} from "../../src/main/claude";
import { ClaudeRpc } from "../../src/main/claude-rpc";
import { validClaudeModel } from "../../src/shared/claude";
import { Store } from "../../src/service/store";
import { validCommand } from "../../src/shared/protocol";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "csthink-claude-"));
  const cli = createClaudeFixture(join(root, "cli"));
  return {
    ...cli,
    root,
    environment: { HOME: root, PATH: cli.bin },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("claude: discovery skips stale links and accepts compatible replacement versions without shell evaluation", async () => {
  const f = fixture();
  try {
    const stale = join(f.root, "stale");
    symlinkSync(join(f.root, "missing"), stale);
    assert.equal(
      (await discoverClaude({ candidates: [stale, f.binary] }))?.version,
      "2.1.263",
    );
    f.update({ version: "99.17.1-preview" });
    assert.equal(
      (await discoverClaude({ candidates: [f.binary] }))?.version,
      "99.17.1-preview",
    );
    const manager = join(f.root, ".nvm/versions/node/v25.0.0/bin");
    mkdirSync(manager, { recursive: true });
    symlinkSync(f.binary, join(manager, "claude"));
    const paths = await claudeCandidates(f.root, { PATH: ".:relative" });
    assert.ok(paths.includes(join(manager, "claude")));
    assert.ok(!paths.includes("claude"));
  } finally {
    f.clean();
  }
});
test("claude: inspection returns actual models and separate authentication without a model prompt or secret disclosure", async () => {
  const f = fixture();
  try {
    const detector = new ClaudeDetector(f.root, f.environment);
    const first = detector.detect();
    assert.equal(first, detector.detect());
    const status = await first;
    assert.equal(status.protocol, "available");
    assert.equal(status.authentication, "subscription");
    assert.equal(status.invocation, "untested");
    assert.equal(status.restriction, "unchecked");
    assert.equal(status.model, "claude-synthetic[1m]");
    assert.deepEqual(status.models, ["claude-synthetic[1m]", "claude-other"]);
    assert.ok(!JSON.stringify(status).includes("SYNTHETIC_SECRET"));
    assert.ok(!JSON.stringify(status).includes("private@"));
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.ok(calls.some((c) => c.request?.subtype === "initialize"));
    assert.ok(!calls.some((c) => c.type === "user"));
    f.update({ authentication: "signedOut" });
    assert.equal((await detector.detect()).authentication, "signedOut");
    f.update({ authentication: "unknown" });
    assert.equal((await detector.detect()).authentication, "unknown");
    f.update({ authentication: "apiKey" });
    assert.equal((await detector.detect()).authentication, "apiKey");
  } finally {
    f.clean();
  }
});
test("claude: malformed authentication remains unknown and a disabled integration never spawns detection", async () => {
  const f = fixture();
  try {
    f.update({ mode: "authMalformed" });
    const status = await new ClaudeDetector(f.root, f.environment).detect();
    assert.equal(status.authentication, "unknown");
    const before = readFileSync(f.calls, "utf8");
    const disabled = await new ClaudeDetector(f.root, f.environment, () => ({
      enabled: false,
      path: null,
      revision: 1,
    })).detect();
    assert.equal(disabled.protocol, "unknown");
    assert.equal(readFileSync(f.calls, "utf8"), before);
    const missing = await new ClaudeDetector(f.root, f.environment, () => ({
      enabled: true,
      path: join(f.root, "missing"),
      revision: 1,
    })).detect();
    assert.equal(missing.detection, "missing");
    assert.equal(readFileSync(f.calls, "utf8"), before);
  } finally {
    f.clean();
  }
});
test("claude: malformed frames and oversized output reject; cancellation closes only the owned inspection process", async () => {
  const f = fixture();
  try {
    for (const mode of ["malformed", "oversized"]) {
      f.update({ mode });
      const rpc = new ClaudeRpc(f.binary, claudeInspectionArgs(), {
        cwd: f.root,
        env: f.environment,
      });
      try {
        await assert.rejects(rpc.request("initialize"), /malformed/);
      } finally {
        await rpc.close();
      }
    }
    f.update({ mode: "hang" });
    const detector = new ClaudeDetector(f.root, f.environment);
    const pending = detector.detect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    detector.cancel();
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cancel did not settle")), 1500),
      ),
    ]);
    assert.notEqual(result.protocol, "available");
  } finally {
    f.clean();
  }
});
test("claude: conflicting auth metadata is unknown and model qualifiers are validated", () => {
  assert.equal(
    claudeAuthentication(
      { loggedIn: true, authMethod: "claude.ai" },
      {
        apiProvider: "firstParty",
        tokenSource: "keychain",
        apiKeySource: "env",
      },
    ),
    "unknown",
  );
  assert.equal(
    claudeAuthentication(
      { loggedIn: true, authMethod: "claude.ai" },
      { apiProvider: "unrecognized", tokenSource: "keychain" },
    ),
    "unknown",
  );
  assert.ok(validClaudeModel("claude-opus-5[1m]"));
  assert.ok(!validClaudeModel("claude[1m]; command"));
  const env = claudeEnvironment({
    PATH: ".:/usr/bin",
    UNRELATED_SECRET: "not-real",
    BASH_ENV: "/unexpected",
    NODE_OPTIONS: "--require unexpected",
  });
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});
test("claude: integration settings persist and reject stale revisions and malformed paths", () => {
  const f = fixture();
  const data = join(f.root, "data");
  mkdirSync(data);
  let store = new Store(data);
  try {
    assert.deepEqual(store.snapshot().settings.claude, {
      enabled: true,
      path: null,
      revision: 0,
    });
    const update = {
      type: "setClaudeSettings" as const,
      enabled: false,
      path: f.binary,
      revision: 0,
    };
    assert.ok(validCommand(update));
    assert.ok(!validCommand({ ...update, path: "relative" }));
    store.execute(update, "main");
    assert.deepEqual(store.snapshot().settings.claude, {
      enabled: false,
      path: f.binary,
      revision: 1,
    });
    const stale = store.execute({ ...update, enabled: true }, "main");
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "CONFLICT");
    store.close();
    store = new Store(data);
    assert.equal(store.snapshot().settings.claude.enabled, false);
    store.execute(
      { type: "setClaudeSettings", enabled: true, path: null, revision: 1 },
      "main",
    );
    assert.equal(store.snapshot().settings.claude.path, null);
  } finally {
    store.close();
    f.clean();
  }
});

test("claude: managed sources and unverified remote policy are refused before session startup", async () => {
  const f = fixture();
  try {
    const system = join(f.root, "system");
    await assertClaudePolicy(f.environment, system);
    mkdirSync(
      join(system, "Application Support/ClaudeCode/managed-settings.d"),
      { recursive: true },
    );
    await assert.rejects(assertClaudePolicy(f.environment, system), /管理配置/);
    assert.throws(
      () =>
        assertClaudeAccountPolicy(
          { loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" },
          {},
        ),
      /管理配置/,
    );
    assert.throws(
      () =>
        assertClaudeAccountPolicy(
          { loggedIn: true, authMethod: "api_key" },
          {},
        ),
      /管理配置/,
    );
    assert.doesNotThrow(() =>
      assertClaudeAccountPolicy(
        { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" },
        {},
      ),
    );
    mkdirSync(join(f.root, ".claude/remote-settings.json"), {
      recursive: true,
    });
    const before = readFileSync(f.calls, "utf8");
    const status = await new ClaudeDetector(f.root, f.environment).detect();
    assert.equal(status.protocol, "unavailable");
    assert.match(status.message, /管理配置/);
    assert.equal(readFileSync(f.calls, "utf8"), before);
  } finally {
    f.clean();
  }
});

test("claude: Node-managed executable discovers its sibling runtime when the GUI PATH has no Node", async () => {
  const f = fixture();
  try {
    writeFileSync(
      f.binary,
      readFileSync(f.binary, "utf8").replace(
        /^#![^\n]+/,
        "#!/usr/bin/env node",
      ),
    );
    symlinkSync(process.execPath, join(f.bin, "node"));
    const environment = { HOME: f.root, PATH: "/usr/bin:/bin" };
    const installation = await discoverClaude({
      environment,
      candidates: [f.binary],
    });
    assert.ok(installation);
    const detector = new ClaudeDetector(
      join(f.root, "inspection"),
      environment,
      () => ({ enabled: true, path: f.binary, revision: 0 }),
    );
    assert.equal((await detector.detect()).protocol, "available");
  } finally {
    f.clean();
  }
});

test("claude: account metadata without token-source fields remains compatible and mismatched identities stay unknown", () => {
  const auth = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "account@synthetic.invalid",
    subscriptionType: "max",
  };
  const account = {
    apiProvider: "firstParty",
    email: auth.email,
    subscriptionType: "max",
  };
  assert.equal(claudeAuthentication(auth, account), "subscription");
  assert.equal(
    claudeAuthentication(auth, { ...account, subscriptionType: "Claude Max" }),
    "subscription",
  );
  assert.equal(
    claudeAuthentication(auth, {
      ...account,
      email: "other@synthetic.invalid",
    }),
    "unknown",
  );
  assert.equal(
    claudeAuthentication(auth, { ...account, apiProvider: "bedrock" }),
    "unknown",
  );
  assert.equal(
    claudeAuthentication(auth, { apiProvider: "firstParty" }),
    "unknown",
  );
});
