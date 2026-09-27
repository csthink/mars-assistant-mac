import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import {
  extensionState,
  type RuntimeHostCommand,
  type RuntimeInstallation,
  type RuntimeInstance,
} from "../../src/shared/runtime-host";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import { buildFake, listFakeEntry } from "./runtime-fakes/build";
import { LIST_CAPABILITY, LIST_SCHEMA } from "./runtime-fakes/list-contract";

mkdirSync(".test-data/disposable", { recursive: true });
const root = () => mkdtempSync(resolve(".test-data/disposable/supervisor-"));
/** In-memory stand-in for the business service: records are kept exactly as reported. */
function records() {
  const installations = new Map<string, RuntimeInstallation>();
  const instances = new Map<string, RuntimeInstance>();
  const log: RuntimeHostCommand[] = [];
  return {
    installations,
    instances,
    log,
    report: async (command: RuntimeHostCommand) => {
      log.push(JSON.parse(JSON.stringify(command)));
      if (command.type === "runtimeInstall")
        installations.set(
          command.installation.installationId,
          command.installation,
        );
      else if (command.type === "runtimeInstanceUpsert")
        instances.set(command.instance.instanceId, command.instance);
      return true;
    },
  };
}
const publisher = newPublisher();
function listBundle(
  dir: string,
  extra: Partial<Parameters<typeof buildBundle>[2]> = {},
) {
  return buildBundle(dir, publisher, {
    runtimeId: "runtime:test-list",
    version: "1",
    entrypoint: "list-fake.cjs",
    entrypointBytes: buildFake(listFakeEntry),
    launcher: "electron-node",
    argv: ["${instanceDir}", "${contractDigest}"],
    capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
    ...extra,
  });
}
function supervisor(
  dir: string,
  store: ReturnType<typeof records>,
  healthIntervalMs = 200,
) {
  return new RuntimeSupervisor({
    runtimeRoot: join(dir, "runtimes"),
    descriptor: {
      platform: "darwin-arm64",
      osVersion: "27.0",
      electronExecutable: process.execPath,
      pythonCandidates: [],
    },
    report: store.report,
    transcriptsDir: join(dir, "transcripts"),
    healthIntervalMs,
  });
}
const until = async (predicate: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms)
      throw new Error("condition not met within " + ms + "ms");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const instanceOf = (store: ReturnType<typeof records>) =>
  [...store.instances.values()][0];

test("导入合法 list fake：安装记录、主实例、initialize/ready 协商、健康检查通过，卡片状态为可用；关闭时 shutdown 并等待真实退出", async () => {
  const dir = root();
  const store = records();
  const built = listBundle(join(dir, "bundle"));
  const host = supervisor(dir, store);
  const reply = await host.importBundle(built.dir, "test");
  assert.equal(reply.ok, true);
  const installation = [...store.installations.values()][0];
  assert.equal(installation.runtimeId, "runtime:test-list");
  assert.equal(installation.incompatibility, null);
  assert.equal(installation.launcher.launcher, process.execPath);
  const instance = instanceOf(store);
  assert.equal(instance.state, "ready");
  assert.equal(instance.negotiation?.selectedProtocol.version, "0.1.0-draft.5");
  assert.deepEqual(
    instance.negotiation?.capabilities.map((c) => c.id),
    [LIST_CAPABILITY.id],
  );
  assert.equal(instance.controlGeneration, "1");
  assert.equal(instance.health?.result, "ok");
  assert.ok(instance.pid && instance.pid > 0);
  assert.equal(instance.launchArgv[0], process.execPath);
  assert.ok(instance.launchArgv[1].endsWith("list-fake.cjs"));
  assert.match(instance.launchArgv[2], /runtimes\/instances\/instance_/);
  assert.equal(extensionState(installation, instance).state, "available");
  // The heartbeat keeps running: a later health record has a newer timestamp.
  const firstHealthAt = instance.health!.at;
  await until(
    () =>
      instanceOf(store).health!.at !== firstHealthAt ||
      store.log.filter(
        (c) => c.type === "runtimeInstanceUpsert" && c.instance.health,
      ).length > 1,
    3000,
  );
  const pid = instance.pid!;
  await host.closeAll();
  const stopped = instanceOf(store);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.exit?.code, 0);
  assert.throws(() => process.kill(pid, 0));
  const transcript = readFileSync(
    join(
      dir,
      "transcripts",
      "runtime_test-list-" + instance.incarnationId!.slice(12, 20) + ".jsonl",
    ),
    "utf8",
  );
  const methods = transcript
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((f) => f.value?.method)
    .filter(Boolean);
  assert.deepEqual(
    [...new Set(methods)],
    [
      "runtime.initialize",
      "runtime.ready",
      "runtime.health",
      "runtime.shutdown",
    ],
  );
  // The shutdown operation was persisted with its key and digest before it was sent, then recorded as answered.
  const shutdowns = store.log.filter(
    (c): c is Extract<RuntimeHostCommand, { type: "runtimeOperationUpsert" }> =>
      c.type === "runtimeOperationUpsert" &&
      c.operation.method === "runtime.shutdown",
  );
  assert.deepEqual(
    shutdowns.map((c) => [c.operation.transport, c.operation.status]),
    [
      ["sent", "unknown"],
      ["answered", "succeeded"],
    ],
  );
  assert.equal(shutdowns[0].operation.scopeRef, "instance");
  assert.equal(shutdowns[0].operation.idempotencyKey?.startsWith("key:"), true);
  assert.equal(existsSync(join(dir, "runtimes", "instances")), true);
});

test("协商失败与运行故障：伪造 Initialized context 记 INTEGRITY_MISMATCH 且不发 ready；健康降级记 degraded；进程被结束后记 exited 并可重连为新 incarnation", async () => {
  const dir = root();
  const store = records();
  const built = listBundle(join(dir, "bundle"));
  const host = supervisor(dir, store, 150);
  try {
    // Fault files live in the instance directory, which exists only after the first start: seed it through a first import.
    const reply = await host.importBundle(built.dir, "test");
    assert.equal(reply.ok, true);
    const instance = instanceOf(store);
    const instanceDir = instance.launchArgv[2];
    writeFileSync(
      join(instanceDir, "fault.json"),
      JSON.stringify({ wrongContext: true }),
    );
    await host.reconnect(instance.instanceId);
    let now = instanceOf(store);
    assert.equal(now.state, "failed");
    assert.equal(now.failure?.code, "INTEGRITY_MISMATCH");
    assert.equal(now.negotiation, null);
    assert.equal(
      extensionState([...store.installations.values()][0], now).state,
      "incompatible",
    );
    const transcripts = readFileSync(
      join(
        dir,
        "transcripts",
        "runtime_test-list-" + now.incarnationId!.slice(12, 20) + ".jsonl",
      ),
      "utf8",
    );
    assert.equal(transcripts.includes('"runtime.ready"'), false);
    // The Host's answer timeout is the fixed design value, so the degraded answer is checked here; the hang path is covered by the exit path below.
    writeFileSync(
      join(instanceDir, "fault.json"),
      JSON.stringify({ degraded: "index rebuilding" }),
    );
    await host.reconnect(instance.instanceId);
    now = instanceOf(store);
    assert.equal(now.state, "ready");
    assert.equal(now.health?.result, "degraded");
    assert.equal(now.health?.reason, "index rebuilding");
    assert.equal(
      extensionState([...store.installations.values()][0], now).state,
      "unverified",
    );
    // The process dies: exit is observed from the parent's wait status, the card shows a connection error, reconnect recovers.
    writeFileSync(join(instanceDir, "fault.json"), "{}");
    await host.reconnect(instance.instanceId);
    now = instanceOf(store);
    assert.equal(now.health?.result, "ok");
    process.kill(now.pid!, "SIGKILL");
    await until(() => instanceOf(store).state === "exited");
    now = instanceOf(store);
    assert.equal(now.exit?.signal, "SIGKILL");
    assert.equal(now.failure?.code, "RUNTIME_EXITED");
    assert.equal(
      extensionState([...store.installations.values()][0], now).state,
      "connection-error",
    );
    const previousIncarnation = now.incarnationId;
    await host.reconnect(instance.instanceId);
    now = instanceOf(store);
    assert.equal(now.state, "ready");
    assert.notEqual(now.incarnationId, previousIncarnation);
    assert.equal(now.controlGeneration, "5");
  } finally {
    await host.closeAll();
  }
});

test("拒绝与不兼容不启动进程：签名错误不产生记录；协议不交集记录为不兼容且无实例；缺 required 能力协商失败为 UNSUPPORTED_CAPABILITY", async () => {
  const dir = root();
  const store = records();
  const host = supervisor(dir, store);
  try {
    const other = newPublisher("publisher:other");
    const bad = buildBundle(
      join(dir, "bad"),
      publisher,
      {
        runtimeId: "runtime:test-list",
        version: "1",
        entrypoint: "list-fake.cjs",
        entrypointBytes: buildFake(listFakeEntry),
        launcher: "electron-node",
        argv: ["${instanceDir}", "${contractDigest}"],
        capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
      },
      { signWith: other.privateKey },
    );
    const refused = await host.importBundle(bad.dir, "test");
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "INVALID_SOURCE");
    assert.equal(store.installations.size, 0);
    const old = listBundle(join(dir, "old"), {
      protocols: [{ version: "0.1.0-draft.4", contractDigest: "1".repeat(64) }],
    });
    const incompatible = await host.importBundle(old.dir, "test");
    assert.equal(
      incompatible.ok && incompatible.incompatible,
      true,
      JSON.stringify(incompatible),
    );
    const record = [...store.installations.values()][0];
    assert.equal(record.incompatibility?.code, "UNSUPPORTED_VERSION");
    assert.equal(store.instances.size, 0);
    assert.equal(extensionState(record, undefined).state, "incompatible");
    assert.equal(existsSync(join(dir, "runtimes", "packages")), false);
    // A bundle that declares a second required capability the fake will not negotiate. Changed bytes need a new
    // version number: version 1 is already recorded (incompatible) with other bytes (KB-278 item 6).
    const extraSchema = { type: "object" };
    const missing = listBundle(join(dir, "missing"), {
      version: "2",
      capabilities: [
        { capability: LIST_CAPABILITY, schema: LIST_SCHEMA },
        {
          capability: {
            id: "csthink.test.extra",
            version: "0.1.0-draft.5",
            schemaDigest: createHash("sha256")
              .update('{"type":"object"}')
              .digest("hex"),
            required: true,
          },
          schema: extraSchema,
        },
      ],
    });
    const reply = await host.importBundle(missing.dir, "test");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const instance = [...store.instances.values()][0];
    assert.equal(instance.state, "failed");
    assert.equal(instance.failure?.code, "UNSUPPORTED_CAPABILITY");
  } finally {
    await host.closeAll();
  }
});

test("KB-278 第三、四、六、七项与实例目录记录：同版本同字节再次导入返回原安装且不新建实例；同版本不同字节拒绝且不留记录或包目录；首次导入标明固定发布者；启动记录保存实例目录与包目录；环境按允许列表收窄；旧记录含 ${resourceHandle} 时不以空串启动", async () => {
  const dir = root();
  const store = records();
  const host = supervisor(dir, store);
  try {
    const built = listBundle(join(dir, "bundle"));
    const first = await host.importBundle(built.dir, "first");
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.equal(first.existing, false);
    assert.equal(first.publisherPin, "first-use");
    assert.equal(first.publicKeyDigest, publisher.publicKeyDigest);
    const instance = instanceOf(store);
    assert.equal(instance.state, "ready");
    // The launch record holds the directories the Host actually used (OD-412 display source).
    const runtimeRoot = join(dir, "runtimes");
    assert.deepEqual(instance.launchDirectories, {
      runtimeRoot,
      packageDir: join(
        runtimeRoot,
        "packages",
        "runtime_test-list",
        built.artifactDigest,
      ),
      instanceDir: join(
        runtimeRoot,
        "instances",
        instance.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
      ),
    });
    assert.equal(
      instance.launchArgv[2],
      instance.launchDirectories!.instanceDir,
    );
    const observed = JSON.parse(
      readFileSync(
        join(
          instance.launchDirectories!.instanceDir,
          "launch-environment.json",
        ),
        "utf8",
      ),
    );
    assert.ok(observed.names.includes("PATH"));
    assert.ok(observed.names.includes("PYTHONDONTWRITEBYTECODE"));
    assert.equal(observed.home, instance.launchDirectories!.instanceDir);
    // Identical bytes again: the recorded installation answers, no second installation or instance.
    const again = await host.importBundle(built.dir, "again");
    assert.deepEqual(again, {
      ok: true,
      installationId: first.installationId,
      incompatible: false,
      existing: true,
      publisherPin: "pinned",
      publicKeyDigest: publisher.publicKeyDigest,
    });
    assert.equal(store.installations.size, 1);
    assert.equal(store.instances.size, 1);
    // Changed bytes under version 1: refused before unpacking, nothing recorded.
    const changed = listBundle(join(dir, "changed"), {
      manifestOverride: (m) => ({ ...m, dataFormat: "test.f2" }),
      dataFormat: "test.f2",
    });
    const refused = await host.importBundle(changed.dir, "changed");
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "INTEGRITY_MISMATCH");
    assert.match(
      !refused.ok ? refused.reasons.join(" ") : "",
      /version 1 of runtime:test-list is already installed with a different archive or release record/,
    );
    assert.equal(store.installations.size, 1);
    assert.equal(
      existsSync(
        join(
          runtimeRoot,
          "packages",
          "runtime_test-list",
          changed.artifactDigest,
        ),
      ),
      false,
    );
    // A narrower allow list removes Host variables; nothing is added (KB-278 item 4).
    const narrow = listBundle(join(dir, "narrow"), {
      runtimeId: "runtime:test-narrow",
      launchOverride: (l) => ({ ...l, environmentAllowList: ["PATH"] }),
    });
    const narrowReply = await host.importBundle(narrow.dir, "narrow");
    assert.equal(narrowReply.ok, true, JSON.stringify(narrowReply));
    const narrowInstance = [...store.instances.values()].find(
      (i) => i.instanceId !== instance.instanceId,
    )!;
    assert.equal(narrowInstance.state, "ready");
    const narrowEnv = JSON.parse(
      readFileSync(
        join(
          narrowInstance.launchDirectories!.instanceDir,
          "launch-environment.json",
        ),
        "utf8",
      ),
    );
    assert.ok(narrowEnv.names.includes("PATH"));
    assert.equal(narrowEnv.names.includes("PYTHONDONTWRITEBYTECODE"), false);
    assert.equal(narrowEnv.home, null);
  } finally {
    await host.closeAll();
  }
  // An installation recorded before admission refused ${resourceHandle} is adopted but never started with an empty handle.
  const legacyStore = records();
  const legacy = supervisor(dir, legacyStore);
  try {
    const recorded = [...store.installations.values()][0];
    const withHandle: RuntimeInstallation = {
      ...recorded,
      installationId: "installation:legacy-resource-handle",
      argv: ["${instanceDir}", "${contractDigest}", "${resourceHandle}"],
    };
    await legacyStore.report({
      type: "runtimeInstall",
      installation: withHandle,
    });
    legacy.adopt([withHandle], []);
    await legacy.activateAll();
    const failed = [...legacyStore.instances.values()][0];
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure?.code, "UNSUPPORTED_VERSION");
    assert.match(failed.failure!.message, /\$\{resourceHandle\}/);
    assert.equal(failed.pid, null);
    assert.deepEqual(failed.launchArgv, []);
    assert.equal(extensionState(withHandle, failed).state, "incompatible");
  } finally {
    await legacy.closeAll();
  }
});
