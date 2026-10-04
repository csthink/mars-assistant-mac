import { claudeInput } from "../../src/main/claude-session";
import { spawn } from "node:child_process";
import { configureCodexProcessHelper } from "../../src/main/codex-process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClaudeFixture } from "./claude-fixture";
import { ClaudeConnector } from "../../src/main/claude-connector";
import { validHostCommand } from "../../src/shared/protocol";
import {
  defaultClaudeSettings,
  type ClaudeRun,
  type ClaudeConnection,
} from "../../src/shared/claude";
import { Store } from "../../src/service/store";
const helper = resolve("dist/claude-mcp.cjs");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t7-session-"));
  const cli = createClaudeFixture(join(root, "cli"));
  const connector = new ClaudeConnector(join(root, "runs"), helper, {
    HOME: root,
    PATH: cli.bin,
  });
  return {
    ...cli,
    root,
    connector,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("claude: model confirmation survives compatible upgrades and invalidates a changed account origin", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    assert.equal(setup.model, "claude-synthetic[1m]");
    f.update({ version: "99.0.0" });
    assert.deepEqual(await f.connector.accept(setup.token), setup);
    const pending = await f.connector.prepare();
    f.update({ authentication: "apiKey" });
    await assert.rejects(f.connector.accept(pending.token), /认证来源/);
    const settings = { ...defaultClaudeSettings };
    const connector = new ClaudeConnector(
      join(f.root, "other"),
      helper,
      { HOME: f.root, PATH: f.bin },
      () => settings,
    );
    f.update({ authentication: "subscription" });
    const stale = await connector.prepare();
    settings.revision++;
    await assert.rejects(connector.accept(stale.token), /认证来源/);
  } finally {
    f.clean();
  }
});
test("claude: completed native outcomes recover without a second model turn and preserve image blocks", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    let run: ClaudeRun | undefined,
      text = "";
    const options = {
      ...setup,
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "image" },
            {
              type: "image_url" as const,
              image_url: { url: "data:image/png;base64,QUJD" },
            },
          ],
        },
      ],
      signal: new AbortController().signal,
      budget: 10000,
      onDelta: (delta: string) => {
        text += delta;
      },
      onSession: async (value: ClaudeRun) => {
        run = value;
      },
    };
    await f.connector.run(options);
    assert.equal(text, "红色");
    assert.ok(run);
    const records = () =>
      readFileSync(f.calls, "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
    const image = records()
      .filter((m) => m.type === "user")
      .find(
        (m) =>
          Array.isArray(m.message.content) &&
          m.message.content.some((b: { type: string }) => b.type === "image"),
      );
    assert.ok(image);
    const count = records().filter(
      (m) =>
        m.type === "user" &&
        Array.isArray(m.message.content) &&
        m.message.content.some((b: { type: string }) => b.type === "image"),
    ).length;
    text = "";
    await f.connector.run({ ...options, resume: run });
    assert.equal(text, "红色");
    assert.equal(
      records().filter(
        (m) =>
          m.type === "user" &&
          Array.isArray(m.message.content) &&
          m.message.content.some((b: { type: string }) => b.type === "image"),
      ).length,
      count,
    );
    writeFileSync(
      join(run.cwd, "outcome.json"),
      JSON.stringify({ run, state: "running", text: "partial" }),
    );
    await assert.rejects(
      f.connector.run({ ...options, resume: run }),
      /未自动重放/,
    );
  } finally {
    f.clean();
  }
});
test("claude: cancel confirms process exit then resumes only the recorded session identity", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    f.update({ mode: "slow" });
    let run: ClaudeRun | undefined;
    const controller = new AbortController();
    let text = "";
    await assert.rejects(
      f.connector.run({
        ...setup,
        messages: [{ role: "user", content: "slow" }],
        signal: controller.signal,
        budget: 10000,
        onSession: async (value) => {
          run = value;
        },
        onDelta: (delta) => {
          text += delta;
          controller.abort();
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(text, "SYNTHETIC_RESPONSE");
    assert.ok(run);
    assert.equal(
      JSON.parse(readFileSync(join(run.cwd, "outcome.json"), "utf8")).state,
      "stopped",
    );
    f.update({ mode: "normal" });
    let next: ClaudeRun | undefined;
    await f.connector.run({
      ...setup,
      resume: run,
      messages: [{ role: "user", content: "retry" }],
      signal: new AbortController().signal,
      budget: 10000,
      onDelta: () => {},
      onSession: async (value) => {
        next = value;
      },
    });
    assert.equal(next?.threadId, run.threadId);
    assert.notEqual(next?.turnId, run.turnId);
    assert.ok(
      readFileSync(f.calls, "utf8").includes(
        '"--resume","' + run.threadId + '"',
      ),
    );
  } finally {
    f.clean();
  }
});
test("claude: unowned sessions and unsafe tool declarations fail before exposing answer text", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    for (const mode of ["wrongSession", "unsafeTools"]) {
      f.update({ mode });
      let text = "";
      await assert.rejects(
        f.connector.run({
          ...setup,
          messages: [{ role: "user", content: "test" }],
          signal: new AbortController().signal,
          budget: 10000,
          onDelta: (delta) => {
            text += delta;
          },
          onSession: async () => {},
        }),
        /协议|身份/,
      );
      assert.equal(text, "");
    }
  } finally {
    f.clean();
  }
});
test("claude: product broker sends only permitted selected material and reports denied reads", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    f.update({ mode: "tools" });
    let reads = 0;
    const options = {
      ...setup,
      messages: [{ role: "user" as const, content: "read selected" }],
      signal: new AbortController().signal,
      budget: 10000,
      onDelta: () => {},
      onSession: async () => {},
      invoke: async (call: { function: { arguments: string } }) => {
        assert.deepEqual(JSON.parse(call.function.arguments), {
          attachmentId: "selected",
        });
        reads++;
        return "selected content";
      },
    };
    await f.connector.run(options);
    assert.equal(reads, 1);
    await assert.rejects(
      f.connector.run({
        ...options,
        invoke: async () => {
          throw Error("denied");
        },
      }),
      /未获允许/,
    );
  } finally {
    f.clean();
  }
});
test("claude: stored model origins enforce native readiness and disabling clears the default without deleting history", () => {
  const f = fixture();
  const data = join(f.root, "data");
  mkdirSync(data);
  const store = new Store(data);
  try {
    const origin: ClaudeConnection = {
      provider: "firstParty",
      endpoint: "CLI 未报告默认地址",
      authentication: "subscription",
      identity: "1".repeat(64),
      fingerprint: "2".repeat(64),
      instructions: [],
      configurationInstructions: [],
    };
    const configure = {
      type: "configureClaude" as const,
      model: "claude-test[1m]",
      configuration: origin,
    };
    assert.equal(validHostCommand(configure), true);
    let reply = store.execute(configure, "main", "host");
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    const c = reply.snapshot.connections.find((c) => c.provider === "claude")!;
    assert.equal(c.models[0].claude?.fingerprint, origin.fingerprint);
    assert.equal(
      store.execute(
        {
          type: "setDefaultConnection",
          id: c.id,
          model: configure.model,
        },
        "main",
      ).ok,
      true,
    );
    reply = store.execute(
      {
        type: "setClaudeSettings",
        ...defaultClaudeSettings,
        enabled: false,
      },
      "main",
    );
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.equal(reply.snapshot.settings.defaultConnectionId, null);
    assert.equal(
      reply.snapshot.connections.find((entry) => entry.id === c.id)?.models
        .length,
      1,
    );
    assert.equal(
      store.execute(
        {
          type: "setDefaultConnection",
          id: c.id,
          model: configure.model,
        },
        "main",
      ).ok,
      false,
    );
  } finally {
    store.close();
    f.clean();
  }
});

test("claude: stopping an owned runtime leaves a separate terminal CLI process alive", async () => {
  const f = fixture();
  const observer = spawn(f.binary, ["--observer"], {
    stdio: "pipe",
    env: { HOME: f.root, PATH: f.bin },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      observer.once("spawn", resolve);
      observer.once("error", reject);
    });
    configureCodexProcessHelper(resolve("dist/codex-process"));
    const setup = await f.connector.prepare();
    f.update({ mode: "slow" });
    const controller = new AbortController();
    await assert.rejects(
      f.connector.run({
        ...setup,
        messages: [{ role: "user", content: "stop only this run" }],
        signal: controller.signal,
        budget: 10000,
        onDelta: () => controller.abort(),
        onSession: async () => {},
      }),
      { name: "AbortError" },
    );
    assert.equal(observer.exitCode, null);
    assert.equal(observer.signalCode, null);
    assert.doesNotThrow(() => process.kill(observer.pid!, 0));
  } finally {
    if (observer.exitCode === null && observer.signalCode === null) {
      const closed = new Promise<void>((resolve) =>
        observer.once("close", () => resolve()),
      );
      observer.stdin.end();
      await closed;
    }
    f.clean();
  }
});

test("claude: provider refusal preserves partial text and reports a safe reason without exposing raw diagnostics", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    f.update({ mode: "refusal" });
    let text = "";
    let native: ClaudeRun | undefined;
    await assert.rejects(
      f.connector.run({
        ...setup,
        messages: [{ role: "user", content: "synthetic refusal" }],
        signal: new AbortController().signal,
        budget: 10000,
        onDelta: (delta) => {
          text += delta;
        },
        onSession: async (run) => {
          native = run;
        },
      }),
      (error: unknown) => {
        const e = error as Error & { errorClass: string };
        assert.equal(e.errorClass, "provider");
        assert.match(e.message, /模型服务拒绝.*reasoning_extraction/);
        assert.doesNotMatch(e.message, /SYNTHETIC_PRIVATE_DIAGNOSTIC/);
        return true;
      },
    );
    assert.equal(text, "SYNTHETIC_RESPONSE");
    assert.ok(native);
    assert.equal(
      JSON.parse(readFileSync(join(native.cwd, "outcome.json"), "utf8")).state,
      "failed",
    );
  } finally {
    f.clean();
  }
});

test("claude: image bytes do not consume text budget and request size stays bounded", () => {
  const data = Buffer.alloc(1_500_000).toString("base64");
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Describe" },
        {
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${data}` },
        },
      ],
    },
  ];
  const input = claudeInput(messages, 1000);
  assert.equal((input[2] as { source: { data: string } }).source.data, data);
  assert.throws(
    () => claudeInput([{ role: "user", content: "x".repeat(1001) }], 1000),
    /上下文/,
  );
  assert.throws(
    () =>
      claudeInput(
        [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64," + "A".repeat(33 * 1024 * 1024),
                },
              },
            ],
          },
        ],
        1000,
      ),
    /请求.*大小|请求.*过大/,
  );
});
test("claude: API errors preserve classification without exposing diagnostics as an answer", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    for (const [code, detail, expected] of [
      [
        "rate_limit",
        "You've reached your Fable limit. SYNTHETIC_PRIVATE_DIAGNOSTIC",
        "rate_limit",
      ],
      [
        "authentication_failed",
        "Not logged in SYNTHETIC_PRIVATE_DIAGNOSTIC",
        "auth",
      ],
      [
        "invalid_request",
        "image input is not supported SYNTHETIC_PRIVATE_DIAGNOSTIC",
        "unsupported",
      ],
    ]) {
      f.update({ mode: "apiError", errorCode: code, errorText: detail });
      let text = "";
      await assert.rejects(
        f.connector.run({
          ...setup,
          messages: [{ role: "user", content: "test" }],
          signal: new AbortController().signal,
          budget: 10000,
          onSession: async () => {},
          onDelta: (delta) => {
            text += delta;
          },
        }),
        (e: unknown) => {
          const error = e as {
            errorClass: string;
            message: string;
            imageUnsupported: boolean;
          };
          assert.equal(error.errorClass, expected);
          assert.ok(error.message.includes(setup.model));
          assert.doesNotMatch(
            error.message,
            /SYNTHETIC_PRIVATE_DIAGNOSTIC|已保留/,
          );
          if (expected === "unsupported")
            assert.equal(error.imageUnsupported, true);
          return true;
        },
      );
      assert.equal(text, "");
    }
  } finally {
    f.clean();
  }
});

test("claude: generated package travels only through the product widget MCP with independent session identity", async () => {
  const f = fixture();
  try {
    const setup = await f.connector.prepare();
    f.update({ mode: "widget" });
    let calls = 0;
    const sessions = new Set<string>();
    await f.connector.run({
      ...setup,
      generation: true,
      messages: [{ role: "user", content: "Synthetic widget" }],
      signal: new AbortController().signal,
      budget: 10000,
      onDelta: () => {},
      onSession: async (r) => {
        sessions.add(r.threadId);
      },
      invoke: async (call) => {
        calls++;
        assert.equal(call.function.name, "submit_widget_candidate");
        assert.deepEqual(JSON.parse(call.function.arguments), {
          package: "{}",
        });
        return JSON.stringify({ status: "accepted", retained: false });
      },
    });
    assert.equal(calls, 1);
    assert.equal(sessions.size, 1);
    assert.match(readFileSync(f.calls, "utf8"), /submit_widget_candidate/);
  } finally {
    f.clean();
  }
});

test("claude: observed built-in plugins are disabled while an unknown loaded plugin still prevents preparation", async () => {
  const f = fixture();
  try {
    const known = [
      "cc-plugin-agents-md@builtin",
      "cc-plugin-plugin-authoring@builtin",
    ];
    f.update({ builtinPlugins: known });
    const prepared = await f.connector.prepare();
    assert.equal(prepared.model, "claude-synthetic[1m]");
    assert.deepEqual(await f.connector.accept(prepared.token), prepared);
    f.update({ builtinPlugins: [...known, "unexpected-plugin@builtin"] });
    await assert.rejects(f.connector.prepare(), /工具限制验证/);
  } finally {
    f.clean();
  }
});

test(
  "claude generation: caller deadline can extend beyond the ordinary three-minute session limit",
  { timeout: 20000 },
  async (t) => {
    const f = fixture();
    let controller: AbortController | undefined;
    let result: Promise<unknown> | undefined;
    try {
      const setup = await f.connector.prepare();
      f.update({ mode: "slow" });
      t.mock.timers.enable({
        apis: ["setTimeout", "Date"],
        now: 1_900_000_000_000,
      });
      controller = new AbortController();
      let text = "",
        settled = false;
      const run = f.connector.run({
        ...setup,
        generation: true,
        messages: [{ role: "user", content: "synthetic waiting" }],
        signal: controller.signal,
        budget: 10000,
        onSession: async () => {},
        onDelta: (v) => {
          text += v;
        },
      });
      result = run.then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const deadline = performance.now() + 15000;
      while (!text && performance.now() < deadline)
        await new Promise<void>((r) => setImmediate(r));
      assert(text);
      t.mock.timers.tick(11 * 60_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(settled, false);
      t.mock.timers.reset();
      controller.abort();
      assert((await result) instanceof Error);
    } finally {
      t.mock.timers.reset();
      controller?.abort();
      await result;
      f.clean();
    }
  },
);
