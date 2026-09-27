import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexFixture } from "./codex-fixture";
import {
  codexCandidates,
  codexEnvironment,
  discoverCodex,
} from "../../src/main/codex-discovery";
import { CodexDetector, inspectCodex } from "../../src/main/codex";
import { CodexRpc, CodexRpcError } from "../../src/main/codex-rpc";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csthink-codex-")));
  return {
    root,
    ...createCodexFixture(root),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("codex: stale links do not hide valid installs and replacement is rediscovered without a version allowlist", async () => {
  const f = fixture();
  try {
    const link = join(f.root, "selected");
    symlinkSync(join(f.root, "missing"), link);
    assert.equal(
      (await discoverCodex({ candidates: [link, f.binary] }))?.version,
      "0.153.4",
    );
    unlinkSync(link);
    symlinkSync(f.binary, link);
    f.update({ version: "9.700.0-beta.1" });
    const found = await discoverCodex({ candidates: [link] });
    assert.equal(found?.version, "9.700.0-beta.1");
    assert.equal(found?.resolvedPath, f.binary);
  } finally {
    f.clean();
  }
});
test("codex: GUI discovery finds version managers and app bundles without evaluating shell configuration", async () => {
  const f = fixture();
  try {
    const dir = join(f.root, ".nvm/versions/node/v30.0.0/bin");
    mkdirSync(dir, { recursive: true });
    symlinkSync(f.binary, join(dir, "codex"));
    writeFileSync(join(f.root, ".zshrc"), "this must never be executed");
    const paths = await codexCandidates(f.root, { PATH: ".:relative" });
    assert.ok(paths.includes(join(dir, "codex")));
    assert.ok(
      paths.includes(
        join(f.root, "Applications/Codex.app/Contents/Resources/codex"),
      ),
    );
    assert.ok(!paths.includes("codex"));
    assert.equal(
      (
        await discoverCodex({
          candidates: paths.filter((p) => p.startsWith(f.root)),
        })
      )?.resolvedPath,
      f.binary,
    );
  } finally {
    f.clean();
  }
});
test("codex: detection reads status over real stdio but never starts a turn or returns raw secrets", async () => {
  const f = fixture();
  try {
    const detector = new CodexDetector(f.root, { HOME: f.root, PATH: f.bin });
    const first = detector.detect();
    assert.equal(first, detector.detect());
    const status = await first;
    assert.equal(status.authentication, "chatgpt");
    assert.equal(status.protocol, "available");
    assert.equal(status.invocation, "untested");
    assert.equal(status.restriction, "verified");
    assert.equal(status.model, "synthetic-model");
    assert.deepEqual(status.configurationSources, ["user"]);
    assert.ok(!JSON.stringify(status).includes("SYNTHETIC_SECRET"));
    assert.ok(!JSON.stringify(status).includes("private@"));
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((c) => c.method),
      [
        "initialize",
        "initialized",
        "config/read",
        "account/read",
        "model/list",
        "initialize",
        "initialized",
        "config/read",
      ],
    );
    assert.equal(
      calls.find((c) => c.method === "account/read").params.refreshToken,
      false,
    );
    f.update({ version: "99.0.0", authentication: "signedOut" });
    const next = await detector.detect();
    assert.equal(next.installation?.version, "99.0.0");
    assert.equal(next.authentication, "signedOut");
    assert.equal(next.protocol, "available");
    assert.equal(next.restriction, "verified");
    assert.ok(!next.message.includes("版本"));
  } finally {
    f.clean();
  }
});
test("codex: API credentials and a future auth type remain distinct from ChatGPT login", async () => {
  const f = fixture();
  try {
    const detector = new CodexDetector(f.root, { HOME: f.root, PATH: f.bin });
    f.update({ authentication: "apiKey" });
    assert.equal((await detector.detect()).authentication, "apiKey");
    f.update({ authentication: "futureAuth" });
    assert.equal((await detector.detect()).authentication, "unknown");
    const env = codexEnvironment({
      HOME: f.root,
      PATH: ".:/usr/bin",
      OPENAI_API_KEY: "synthetic",
      ELECTRON_RUN_AS_NODE: "1",
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.ok(!env.PATH?.startsWith("."));
  } finally {
    f.clean();
  }
});
test("codex: absent optional read methods produce unknown state rather than rejecting a new version", async () => {
  let closed = false;
  const status = await inspectCodex(
    { path: "/synthetic", resolvedPath: "/synthetic", version: "999.0" },
    {
      async request(method) {
        if (method === "initialize") return { userAgent: "future" };
        if (method === "config/read")
          return { config: { model_provider: "new-provider" } };
        throw new CodexRpcError(-32601);
      },
      notify() {},
      async close() {
        closed = true;
      },
    },
  );
  assert.equal(status.protocol, "available");
  assert.equal(status.authentication, "unknown");
  assert.ok(closed);
});
test("codex: malformed oversized and stalled protocols terminate without leaking raw server data", async () => {
  const f = fixture();
  try {
    for (const mode of ["malformed", "oversized", "hang", "exit"]) {
      f.update({ mode });
      // Only the stalled server is decided by the clock; the other outcomes come from the
      // fixture's own output or exit, which a loaded machine may take longer than 500 ms to
      // produce (KB-224), so they keep the production timeout.
      const rpc = new CodexRpc(
        f.binary,
        ["app-server"],
        {
          cwd: f.root,
          env: codexEnvironment({ PATH: "/usr/bin:/bin", HOME: f.root }),
        },
        mode === "hang" ? 500 : 5000,
      );
      await assert.rejects(
        rpc.request("initialize"),
        (error: unknown) =>
          error instanceof CodexRpcError &&
          error.code ===
            (
              {
                malformed: "malformed",
                oversized: "oversized",
                hang: "timeout",
                exit: "closed",
              } as const
            )[mode as "malformed" | "oversized" | "hang" | "exit"],
      );
      await rpc.close();
    }
  } finally {
    f.clean();
  }
});
test("codex: unexpected server command requests are explicitly refused during detection", async () => {
  const f = fixture();
  try {
    f.update({ mode: "request" });
    const detector = new CodexDetector(f.root, { HOME: f.root, PATH: f.bin });
    assert.equal((await detector.detect()).protocol, "available");
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.find((c) => c.id === "host-request").error.code, -32601);
  } finally {
    f.clean();
  }
});

test("codex: effective configuration conflicts block execution without erasing installation or login status", async () => {
  const f = fixture();
  try {
    f.update({ mode: "conflict" });
    const detector = new CodexDetector(f.root, { HOME: f.root, PATH: f.bin });
    const result = await detector.detect();
    assert.equal(result.detection, "found");
    assert.equal(result.authentication, "chatgpt");
    assert.equal(result.restriction, "conflict");
    assert.match(result.message, /暂不能发起会话/);
    f.update({ mode: "normal" });
    assert.equal((await detector.detect()).restriction, "verified");
    assert.doesNotMatch(
      readFileSync(f.calls, "utf8"),
      /thread\/start|turn\/start/,
    );
  } finally {
    f.clean();
  }
});

test("codex: disabling integration cancels an in-flight inspection before restricted discovery can spawn", async () => {
  const f = fixture();
  const preferences = { enabled: true, path: f.binary, revision: 0 };
  const detector = new CodexDetector(
    join(f.root, "inspection"),
    { ...process.env, HOME: f.root, PATH: f.bin },
    () => ({ ...preferences }),
  );
  try {
    f.update({ mode: "hang" });
    const pending = detector.detect();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(f.calls, "utf8").includes("initialize")) break;
      } catch {
        /* Wait for the owned fixture to start. */
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(readFileSync(f.calls, "utf8"), /initialize/);
    preferences.enabled = false;
    preferences.revision++;
    detector.cancel();
    assert.equal((await pending).installation, null);
    const before = readFileSync(join(f.bin, "invocations.jsonl"), "utf8");
    assert.equal((await detector.detect()).installation, null);
    assert.equal(
      readFileSync(join(f.bin, "invocations.jsonl"), "utf8"),
      before,
    );
    assert.equal(before.trim().split("\n").length, 2);
  } finally {
    detector.cancel();
    f.clean();
  }
});
