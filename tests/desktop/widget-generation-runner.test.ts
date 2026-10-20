import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { Store } from "../../src/service/store";
import type { Command, HostCommand, Reply } from "../../src/shared/protocol";
import {
  WidgetGenerationRunner,
  runApiWidgetGeneration,
  widgetGenerationInstructions,
  type GenerationExecution,
} from "../../src/main/widget-generation";
import { compileWidget } from "../../src/main/widget-build";
import { CodexProcessError } from "../../src/main/codex-process";
import { streamChat } from "../../src/main/transport";
import { codexInput } from "../../src/main/codex-session";
import { claudeInput } from "../../src/main/claude-session";
import { answerSourcePrompt } from "../../src/shared/answer-source";
import { widgetSubmitToolName } from "../../src/shared/widget-generation-tool";
const source = JSON.stringify({
  schemaVersion: 1,
  name: "Seven marks",
  view: { html: "<p>Seven marks</p>", css: "p{color:navy}", js: "" },
  config: [],
  draftFields: [],
  capabilities: [],
  resources: [],
});
const tool = (
  name = widgetSubmitToolName,
  args = JSON.stringify({ package: source }),
) => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "candidate-1",
            type: "function",
            function: { name, arguments: args },
          },
        ],
      },
    },
  ],
});
const end = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
async function mock(chunks: unknown[]) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks)
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    endpoint: {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: "test-model",
      apiKey: "synthetic-generation-key",
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
function setup(
  run: (o: GenerationExecution) => Promise<void>,
  /** Prepares the source conversation before the task; returns the connection the task uses. */
  prepare?: (
    command: (c: Command) => Reply,
    host: (c: HostCommand) => Reply,
    ids: { connectionId: string; conversationId: string },
  ) => string,
) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/generation-runner-"));
  const store = new Store(root),
    connectionId = randomUUID(),
    conversationId = randomUUID(),
    draftId = randomUUID();
  const command = (c: Command) => {
    const r = store.execute(c, "main");
    assert(r.ok, JSON.stringify(r));
    return r;
  };
  const host = async (c: HostCommand) => store.execute(c, "main", "host");
  command({ type: "create", id: conversationId });
  command({
    type: "upsertConnection",
    id: connectionId,
    name: "Offline",
    provider: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-model",
    secretRef: randomUUID(),
    imageInput: "unknown",
    contextChars: null,
    revision: 0,
  });
  const taskConnection = prepare
    ? prepare(command, (c) => store.execute(c, "main", "host"), {
        connectionId,
        conversationId,
      })
    : connectionId;
  command({
    type: "createWidgetDraft",
    id: draftId,
    name: "Seven marks",
    sourceConversationId: conversationId,
  });
  command({
    type: "saveWidgetDraft",
    id: draftId,
    name: "Seven marks",
    input: "Create seven original marks",
    revision: 0,
  });
  command({
    type: "submitWidgetGeneration",
    draftId,
    connectionId: taskConnection,
    model: "test-model",
    revision: 1,
    requestId: randomUUID(),
  });
  const runner = new WidgetGenerationRunner(
    host,
    run,
    () => {},
    (s) => compileWidget(s, resolve("dist/widget-build-worker.cjs")),
  );
  return {
    store,
    command,
    host,
    runner,
    connectionId,
    conversationId,
    task: () => store.snapshot().widgetGeneration!.tasks[0],
    async start() {
      runner.adopt(store.snapshot(), 0);
      await until(() => runner.active === 0);
    },
    async close() {
      await runner.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await wait(5);
  }
}
test("widget runner: fixed tool submits original bytes through build worker once without retaining", async () => {
  const api = await mock([tool(), end]);
  const s = setup((o) => runApiWidgetGeneration(api.endpoint, o));
  try {
    await s.start();
    assert.equal(s.task().state, "completed");
    const snapshot = s.store.snapshot().widgetGeneration!;
    assert.equal(snapshot.candidates.length, 1);
    assert.equal(snapshot.candidates[0].name, "Seven marks");
    assert.equal(snapshot.widgets.length, 0);
    assert.equal(api.requests.length, 1);
  } finally {
    await s.close();
    await api.close();
  }
});
test("widget runner: the generation instructions every connection receives state the view's network, navigation and form submission limits", async () => {
  // API, Codex and Claude Code all receive the runner's messages; the API request shows them.
  const api = await mock([tool(), end]);
  let messages: GenerationExecution["messages"] = [];
  const s = setup((o) => {
    messages = o.messages;
    return runApiWidgetGeneration(api.endpoint, o);
  });
  try {
    await s.start();
    assert.equal(s.task().state, "completed");
    assert.deepEqual(messages[0], {
      role: "system",
      content: widgetGenerationInstructions,
    });
    const sent = (api.requests[0] as { messages: { content: string }[] })
      .messages[0].content;
    assert.equal(sent, widgetGenerationInstructions);
    assert.match(sent, /no network and cannot navigate or open windows/);
    assert.match(sent, /form's submit handler call event\.preventDefault\(\)/);
    assert.match(sent, /update the view in place/);
    assert.match(
      sent,
      /set novalidate on a form whose handler validates the input itself/,
    );
  } finally {
    await s.close();
    await api.close();
  }
});
test("widget runner: the generation instructions API, Codex and Claude Code receive ask for messages to the user in the language of the requirement", async () => {
  const api = await mock([tool(), end]);
  let messages: GenerationExecution["messages"] = [];
  const s = setup((o) => {
    messages = o.messages;
    return runApiWidgetGeneration(api.endpoint, o);
  });
  try {
    await s.start();
    assert.equal(s.task().state, "completed");
    const language =
      /Write every message to the user, such as notes on what you built, explanations of unsupported capabilities and questions, in the language of the user's requirement \(the final user message\), not the language of these instructions or of the history\./;
    assert.match(widgetGenerationInstructions, language);
    // API: the request body carries the instructions verbatim.
    const sent = (api.requests[0] as { messages: { content: string }[] })
      .messages[0].content;
    assert.equal(sent, widgetGenerationInstructions);
    // Codex and Claude Code build their input from the same runner messages.
    const codexText = codexInput(messages)
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n");
    assert.match(codexText, language);
    const claudeText = claudeInput(messages, 1_000_000)
      .map((part) => ("text" in part ? String(part.text) : ""))
      .join("\n");
    assert.match(claudeText, language);
    // The requirement itself stays the final user message the language refers to.
    assert.deepEqual(messages.at(-1)?.role, "user");
  } finally {
    await s.close();
    await api.close();
  }
});
test("widget runner: reference history names each saved answer's source once another connection wrote one, and is unchanged otherwise", async () => {
  /** One answered turn on the first connection; optionally a second connection the task then uses. */
  const answered =
    (switchProvider: boolean) =>
    (
      command: (c: Command) => Reply,
      host: (c: HostCommand) => Reply,
      ids: { connectionId: string; conversationId: string },
    ) => {
      const requestId = randomUUID();
      const submitted = command({
        type: "submitTurn",
        requestId,
        conversationId: ids.conversationId,
        connectionId: ids.connectionId,
        text: "要一个计数器",
      }) as Extract<Reply, { ok: true }>;
      const turn = submitted.snapshot.turns.find(
        (t) => t.requestId === requestId,
      )!;
      host({ type: "beginExecution", executionId: turn.executionId });
      host({
        type: "reportDelta",
        executionId: turn.executionId,
        seq: 1,
        text: "好的，计数器如下。",
      });
      host({
        type: "reportFinished",
        executionId: turn.executionId,
        seq: 2,
      });
      if (!switchProvider) return ids.connectionId;
      const other = randomUUID();
      command({
        type: "upsertConnection",
        id: other,
        name: "深度求索",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "test-model",
        secretRef: randomUUID(),
        imageInput: "unknown",
        contextChars: null,
        revision: 0,
      });
      command({
        type: "grantConnectionScope",
        conversationId: ids.conversationId,
        connectionId: other,
        baseUrl: "https://api.deepseek.com",
      });
      return other;
    };
  const sent = async (switchProvider: boolean) => {
    const api = await mock([tool(), end]);
    let messages: GenerationExecution["messages"] = [];
    const s = setup((o) => {
      messages = o.messages;
      return runApiWidgetGeneration(api.endpoint, o);
    }, answered(switchProvider));
    try {
      await s.start();
      assert.equal(s.task().state, "completed");
      return messages;
    } finally {
      await s.close();
      await api.close();
    }
  };
  const history = (messages: GenerationExecution["messages"]) =>
    (
      JSON.parse(String(messages[1].content)) as {
        referenceHistory: Record<string, unknown>[];
      }
    ).referenceHistory.map(({ role, content, source }) => ({
      role,
      content,
      source,
    }));

  const switched = await sent(true);
  assert.deepEqual(history(switched), [
    { role: "user", content: "要一个计数器", source: undefined },
    {
      role: "assistant",
      content: "好的，计数器如下。",
      source: "【历史回答来源：Offline（自定义 · test-model）】",
    },
  ]);
  assert.deepEqual(
    switched.map((m) => m.role),
    ["system", "system", "system", "user"],
  );
  assert.equal(
    switched[2].content,
    answerSourcePrompt({
      name: "深度求索",
      provider: "deepseek",
      model: "test-model",
    }),
  );
  // The note and prompt carry name snapshots only; the comparison flag stays in the service.
  assert.doesNotMatch(JSON.stringify(switched), /sameAsTurn/);
  assert.doesNotMatch(
    String(switched[2].content) + history(switched)[1].source,
    /127\.0\.0\.1|api\.deepseek\.com/,
  );

  const same = await sent(false);
  assert.deepEqual(history(same), [
    { role: "user", content: "要一个计数器", source: undefined },
    { role: "assistant", content: "好的，计数器如下。", source: undefined },
  ]);
  assert.deepEqual(
    same.map((m) => m.role),
    ["system", "system", "user"],
  );
});
test("widget runner: text, malformed package and undeclared tools fail without automatic provider retry", async () => {
  for (const chunks of [
    [{ choices: [{ delta: { content: source }, finish_reason: "stop" }] }],
    [tool("shell"), end],
    [tool(undefined, JSON.stringify({ package: "{}" })), end],
    [tool(undefined, "{"), end],
  ]) {
    const api = await mock(chunks),
      s = setup((o) => runApiWidgetGeneration(api.endpoint, o));
    try {
      await s.start();
      assert.equal(s.task().state, "failed");
      assert.equal(s.store.snapshot().widgetGeneration!.candidates.length, 0);
      assert.equal(api.requests.length, 1);
    } finally {
      await s.close();
      await api.close();
    }
  }
});
test("widget runner: generation stop revokes late candidate while foreground stream completes independently", async () => {
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((r) => (release = r));
  const api = await mock([
    {
      choices: [
        { delta: { content: "foreground answer" }, finish_reason: "stop" },
      ],
    },
  ]);
  const s = setup(async (o) => {
    entered = true;
    o.onDelta("partial generation");
    await gate;
    await o.invoke({
      id: "late",
      type: "function",
      function: {
        name: widgetSubmitToolName,
        arguments: JSON.stringify({ package: source }),
      },
    });
  });
  try {
    s.runner.adopt(s.store.snapshot(), 0);
    await until(() => entered);
    const foreground = new AbortController();
    let text = "";
    const question = streamChat(
      api.endpoint,
      [{ role: "user", content: "Explain a transaction" }],
      foreground.signal,
      (d) => (text += d),
    );
    s.command({ type: "stopWidgetGeneration", taskId: s.task().id });
    s.runner.adopt(s.store.snapshot(), 1);
    release();
    await question;
    await until(() => s.runner.active === 0);
    assert.equal(text, "foreground answer");
    assert.equal(foreground.signal.aborted, false);
    assert.equal(s.task().state, "stopped");
    assert.equal(s.task().partialText, "partial generation");
    assert.equal(s.store.snapshot().widgetGeneration!.candidates.length, 0);
  } finally {
    release();
    await s.close();
    await api.close();
  }
});
test("widget runner: foreground stop leaves generation signal and validated candidate intact", async () => {
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup(async (o) => {
    entered = true;
    await gate;
    assert.equal(o.signal.aborted, false);
    await o.invoke({
      id: "valid",
      type: "function",
      function: {
        name: widgetSubmitToolName,
        arguments: JSON.stringify({ package: source }),
      },
    });
  });
  try {
    s.runner.adopt(s.store.snapshot(), 0);
    await until(() => entered);
    s.command({
      type: "submitTurn",
      conversationId: s.conversationId,
      connectionId: s.connectionId,
      requestId: randomUUID(),
      text: "Separate question",
    });
    const executionId = s.store.snapshot().activeTurns[0].executionId;
    assert((await s.host({ type: "beginExecution", executionId })).ok);
    s.command({ type: "stopExecution", executionId });
    s.runner.adopt(s.store.snapshot(), 1);
    release();
    await until(() => s.runner.active === 0);
    assert.equal(s.task().state, "completed");
    assert.equal(s.store.snapshot().activeTurns[0].state, "stopping");
  } finally {
    release();
    await s.close();
  }
});
test("widget runner: unconfirmed process exit is interrupted, never a confirmed stop", async () => {
  let entered = false;
  const s = setup(async (o) => {
    entered = true;
    await new Promise<void>((r) =>
      o.signal.addEventListener("abort", () => r(), { once: true }),
    );
    throw new CodexProcessError();
  });
  try {
    s.runner.adopt(s.store.snapshot(), 0);
    await until(() => entered);
    s.command({ type: "stopWidgetGeneration", taskId: s.task().id });
    s.runner.adopt(s.store.snapshot(), 0);
    await until(() => s.runner.active === 0);
    assert.equal(s.task().state, "interrupted");
    assert.match(s.task().error!, /could not be confirmed/);
    assert.equal(s.task().stopUnconfirmed, true);
    const before = s.store.snapshot(),
      d = before.widgetGeneration!.drafts[0];
    assert.equal(
      s.store.execute(
        {
          type: "deleteWidgetDraft",
          id: d.id,
          revision: d.revision,
          name: d.name,
          input: d.input,
          undoToken: randomUUID(),
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      s.store.execute(
        {
          type: "retryWidgetGeneration",
          taskId: s.task().id,
          attempt: s.task().attempt,
        },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(s.store.snapshot(), before);
  } finally {
    await s.close();
  }
});
test("widget runner: occupied capacity leaves durable task queued without dispatch", async () => {
  let count = 0;
  const s = setup(async () => {
    count++;
  });
  try {
    s.runner.adopt(s.store.snapshot(), 3);
    await wait(20);
    assert.equal(count, 0);
    assert.equal(s.task().state, "queued");
  } finally {
    await s.close();
  }
});

test("widget runner: semantic activity and explicit extension survive the old deadline while the final deadline cancels once", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: 1_900_000_000_000,
  });
  let options: GenerationExecution | undefined,
    calls = 0;
  const s = setup(async (o) => {
    calls++;
    options = o;
    await new Promise<void>((_resolve, reject) =>
      o.signal.addEventListener("abort", () => reject(o.signal.reason), {
        once: true,
      }),
    );
  });
  const drain = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  try {
    s.runner.adopt(s.store.snapshot(), 0);
    await drain();
    assert(options);
    const started = s.task().startedAt!;
    t.mock.timers.tick(120_000);
    await drain();
    assert.equal(options.signal.aborted, false);
    assert.equal(s.task().lastProgressAt, started);
    options.onProgress?.();
    t.mock.timers.tick(1000);
    await drain();
    assert.equal(s.task().lastProgressAt, started + 120_000);
    t.mock.timers.tick(419_000);
    await drain(); // Nine minutes, still the same provider request.
    const oldDeadline = s.task().deadlineAt!;
    s.command({
      type: "extendWidgetGeneration",
      taskId: s.task().id,
      executionId: s.task().executionId,
      expectedDeadline: oldDeadline,
    });
    // Deliberately don't feed the new snapshot to adopt: expiry must reread the committed lease.
    t.mock.timers.tick(60_000);
    await drain();
    assert.equal(options.signal.aborted, false);
    assert.equal(s.task().state, "running");
    assert.equal(s.task().deadlineAt, oldDeadline + 300_000);
    t.mock.timers.tick(300_000);
    await drain();
    assert.equal(options.signal.aborted, true);
    assert.equal(s.task().state, "failed");
    assert.match(s.task().error!, /本次等待时限/);
    assert.equal(calls, 1);
    assert.equal(s.runner.active, 0);
  } finally {
    await s.close();
  }
});

test(
  "widget runner: a committed stop wins at the deadline even before its snapshot arrives",
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: 1_900_000_000_000,
    });
    let provider: GenerationExecution | undefined;
    const s = setup(async (options) => {
      provider = options;
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    });
    const drain = async () => {
      for (let i = 0; i < 100; i++) await Promise.resolve();
    };
    try {
      s.runner.adopt(s.store.snapshot(), 0);
      await drain();
      assert(provider);
      s.command({ type: "stopWidgetGeneration", taskId: s.task().id });
      assert.equal(s.task().state, "stopping");
      t.mock.timers.tick(600000);
      await drain();
      assert.equal(provider.signal.aborted, true);
      assert.equal(s.task().state, "stopped");
      assert.equal(s.runner.active, 0);
    } finally {
      t.mock.timers.reset();
      await s.close();
    }
  },
);
