import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import {
  CodexProcessOwner,
  configureCodexProcessHelper,
} from "../../src/main/codex-process";
import { buildProcessHelper } from "./process-helper";
test("macOS ownership includes a detached child and refuses a changed process birth identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-process-")),
    helper = join(root, "identity");
  buildProcessHelper(helper);
  configureCodexProcessHelper(helper);
  const spectator = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const [data] = await once(child.stdout!, "data"),
      descendant = Number(String(data).trim());
    const owner = CodexProcessOwner.create(
      child.pid!,
      () => child.exitCode === null && child.signalCode === null,
    )!;
    await owner.ready();
    const identity = owner.identities().find((row) => row.pid === descendant)!;
    assert.ok(identity);
    assert.notEqual(identity.group, child.pid);
    const response = execFileSync(
      helper,
      [
        "stop",
        String(identity.pid),
        String(identity.startSeconds),
        String(identity.startMicros + 1),
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(response, "false");
    assert.doesNotThrow(() => process.kill(descendant, 0));
    await owner.close();
    assert.throws(() => process.kill(descendant, 0));
    assert.doesNotThrow(() => process.kill(spectator.pid!, 0));
  } finally {
    child.kill("SIGKILL");
    spectator.kill("SIGKILL");
    await wait(30);
    rmSync(root, { recursive: true, force: true });
  }
});
