import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createCodexFixture } from "./codex-fixture";
import { CodexRpc } from "../../src/main/codex-rpc";
import {
  codexInput,
  codexInstructionSources,
  runCodexTurn,
  startCodexThread,
} from "../../src/main/codex-session";
import { TransportError } from "../../src/main/transport";
async function fixture(mode: string, generation = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csthink-turn-")));
  const f = createCodexFixture(root);
  f.update({ mode });
  const rpc = new CodexRpc(
    f.binary,
    ["app-server"],
    { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" } },
    5000,
  );
  await rpc.request("initialize", {
    clientInfo: { name: "fixture", version: "1" },
  });
  rpc.notify("initialized");
  const thread = await startCodexThread(
    rpc,
    root,
    "synthetic-model",
    "openai",
    generation ? "generation" : true,
  );
  const controller = new AbortController();
  const text: string[] = [];
  const options = {
    rpc,
    thread,
    messages: [{ role: "user" as const, content: "Synthetic user question" }],
    signal: controller.signal,
    onDelta: (delta: string) => text.push(delta),
    budget: 100_000,
  };
  return {
    ...f,
    root,
    rpc,
    controller,
    text,
    options,
    async clean() {
      await rpc.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("Codex stdio turn preserves deltas, binds identities and sends only fixed material arguments", async () => {
  const f = await fixture("turn_tool");
  try {
    let called = 0;
    await runCodexTurn({
      ...f.options,
      invoke: async (call, signal) => {
        signal.throwIfAborted();
        called++;
        assert.equal(call.function.name, "read_selected_material");
        assert.deepEqual(JSON.parse(call.function.arguments), {
          attachmentId: "selected-material",
        });
        return "SYNTHETIC_VERIFIED_MATERIAL";
      },
    });
    assert.equal(called, 1);
    assert.equal(f.text.join(""), "fixture-read-completed");
  } finally {
    await f.clean();
  }
});
test("Codex spoofed thread and extra file path are rejected before the capability service", async () => {
  for (const mode of ["turn_spoof", "turn_extra", "turn_namespace"]) {
    const f = await fixture(mode);
    try {
      let called = 0;
      await assert.rejects(
        runCodexTurn({
          ...f.options,
          invoke: async () => {
            called++;
            return "must-not-read";
          },
        }),
        (error) =>
          error instanceof TransportError && error.errorClass === "protocol",
      );
      assert.equal(called, 0);
    } finally {
      await f.clean();
    }
  }
});
test("Codex duplicate call revokes an outstanding permission wait without executing a side effect", async () => {
  const f = await fixture("turn_duplicate");
  try {
    let effects = 0,
      aborted = false;
    await assert.rejects(
      runCodexTurn({
        ...f.options,
        invoke: async (_call, signal) => {
          try {
            await wait(3000, undefined, { signal });
            effects++;
            return "must-not-read";
          } finally {
            aborted = signal.aborted;
          }
        },
      }),
      TransportError,
    );
    assert.equal(effects, 0);
    assert.equal(aborted, true);
  } finally {
    await f.clean();
  }
});
test("Codex failure preserves partial output and a separate session survives cancellation", async () => {
  const failed = await fixture("turn_partial_fail");
  try {
    await assert.rejects(runCodexTurn(failed.options), TransportError);
    assert.equal(failed.text.join(""), "partial-answer");
  } finally {
    await failed.clean();
  }
  const stopped = await fixture("turn_hang"),
    spectator = await fixture("turn_hang");
  try {
    const run = runCodexTurn(stopped.options);
    const deadline = Date.now() + 5000;
    while (stopped.text.length === 0 && Date.now() < deadline) await wait(10);
    assert.ok(stopped.text.length > 0);
    stopped.controller.abort();
    await assert.rejects(run);
    assert.equal(stopped.text.join(""), "partial-before-stop");
    assert.match(readFileSync(stopped.calls, "utf8"), /turn\/interrupt/);
    const reply = await spectator.rpc.request("config/read");
    assert.equal(
      (reply as { config: { model: string } }).config.model,
      "synthetic-model",
    );
  } finally {
    await stopped.clean();
    await spectator.clean();
  }
});
test("Codex instruction disclosure records exact file identity without returning content", async () => {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "csthink-instructions-")),
    ),
    path = join(root, "AGENTS.md");
  try {
    writeFileSync(path, "SYNTHETIC_PRIVATE_INSTRUCTIONS");
    const first = await codexInstructionSources([path]);
    assert.equal(first[0].path, path);
    assert.match(first[0].sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(first),
      /SYNTHETIC_PRIVATE_INSTRUCTIONS/,
    );
    writeFileSync(path, "changed");
    assert.notEqual(
      (await codexInstructionSources([path]))[0].sha256,
      first[0].sha256,
    );
    await assert.rejects(codexInstructionSources(["relative"]), TransportError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex recovery reads the saved completed answer without another turn and refuses unknown prior outcomes", async () => {
  const f = await fixture("normal");
  try {
    await runCodexTurn(f.options);
    const old = {
      threadId: "thread-fixture",
      turnId: "turn-fixture",
      cwd: f.root,
      model: "synthetic-model",
      provider: "openai",
      fingerprint: "b".repeat(64),
      installation: {
        path: f.binary,
        resolvedPath: f.binary,
        version: "0.153.4",
      },
    };
    const reopen = async () => {
      const rpc = new CodexRpc(f.binary, ["app-server"], {
        cwd: f.root,
        env: { HOME: f.root, PATH: "/usr/bin:/bin" },
      });
      await rpc.request("initialize", {
        clientInfo: { name: "fixture", version: "1" },
      });
      rpc.notify("initialized");
      return rpc;
    };
    const resumed = await reopen();
    try {
      const thread = await startCodexThread(
        resumed,
        f.root,
        old.model,
        old.provider,
        true,
        old,
      );
      assert.equal(thread.recoveredText, "partial-answer");
      const count = readFileSync(f.calls, "utf8").split("turn/start").length;
      const output: string[] = [];
      await runCodexTurn({
        ...f.options,
        rpc: resumed,
        thread,
        onDelta: (text) => output.push(text),
      });
      assert.deepEqual(output, ["partial-answer"]);
      assert.equal(
        readFileSync(f.calls, "utf8").split("turn/start").length,
        count,
      );
    } finally {
      await resumed.close();
    }
    f.update({ mode: "resume_unknown" });
    const unknown = await reopen();
    try {
      await assert.rejects(
        startCodexThread(unknown, f.root, old.model, old.provider, true, old),
        (error) =>
          error instanceof TransportError &&
          error.message.includes("未确认执行"),
      );
    } finally {
      await unknown.close();
    }
  } finally {
    await f.clean();
  }
});

test("Codex follow-up keeps historical images as image inputs in message order", () => {
  const image = "data:image/png;base64,SYNTHETIC";
  const result = codexInput([
    {
      role: "user",
      content: [
        { type: "text", text: "first image" },
        { type: "image_url", image_url: { url: image } },
      ],
    },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "follow up" },
  ]);
  assert.deepEqual(
    result.filter((part) => part.type === "image"),
    [{ type: "image", url: image }],
  );
  assert.equal(
    JSON.stringify(result.filter((part) => part.type === "text")).includes(
      image,
    ),
    false,
  );
  assert.ok(
    result.findIndex((part) => part.type === "image") <
      result.findIndex(
        (part) => part.type === "text" && part.text === "previous answer",
      ),
  );
  assert.deepEqual(result.at(-1), { type: "text", text: "follow up" });
});

test("Codex widget tool is isolated from material tools and binds the candidate to its own turn", async () => {
  const f = await fixture("turn_widget", true);
  try {
    let called = 0;
    await runCodexTurn({
      ...f.options,
      generation: true,
      invoke: async (call) => {
        called++;
        assert.equal(call.function.name, "submit_widget_candidate");
        assert.deepEqual(JSON.parse(call.function.arguments), {
          package: "{}",
        });
        return JSON.stringify({ status: "accepted", retained: false });
      },
    });
    assert.equal(called, 1);
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const start = calls.find((c) => c.method === "thread/start");
    assert.deepEqual(
      start.params.dynamicTools.map((t: { name: string }) => t.name),
      ["submit_widget_candidate"],
    );
  } finally {
    await f.clean();
  }
  const wrong = await fixture("turn_tool", true);
  try {
    let invoked = false;
    await assert.rejects(
      runCodexTurn({
        ...wrong.options,
        generation: true,
        invoke: async () => {
          invoked = true;
          return "";
        },
      }),
    );
    assert.equal(invoked, false);
  } finally {
    await wrong.clean();
  }
});

test(
  "Codex generation: caller deadline can extend beyond the ordinary ten-minute turn limit",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture("turn_hang", true);
    t.mock.timers.enable({
      apis: ["setTimeout", "Date"],
      now: 1_900_000_000_000,
    });
    let settled = false;
    const run = runCodexTurn({ ...f.options, generation: true });
    const result = run.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      const deadline = performance.now() + 5000;
      while (!f.text.length && performance.now() < deadline)
        await new Promise<void>((r) => setImmediate(r));
      assert(f.text.length);
      t.mock.timers.tick(11 * 60_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(settled, false);
      t.mock.timers.reset();
      f.controller.abort(new Error("caller deadline"));
      assert((await result) instanceof Error);
      const calls = readFileSync(f.calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
      assert.equal(
        calls.filter((c) => c.method === "turn/interrupt").length,
        1,
      );
    } finally {
      t.mock.timers.reset();
      f.controller.abort();
      await result;
      await f.clean();
    }
  },
);
