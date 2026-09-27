import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import {
  ProcessObservationError,
  ProcessObserver,
  SignalLedger,
  bootId,
  classify,
  inTargetSession,
  reclaimDescendants,
  registration,
  schemaIdentity,
  type ProcessObservation,
  type RegisteredProcess,
} from "../../src/main/execution-process";
import { buildProcessHelper } from "./process-helper";

const live = (pid: number): ProcessObservation => ({
  pid,
  info_size: 136,
  expected_size: 136,
  info_errno: 0,
  path_size: 20,
  path_errno: 0,
  kill_result: 0,
  kill_errno: 0,
  uid: 501,
  parent: 1,
  group: pid,
  session: pid,
  status: 2,
  startSeconds: 1789817961,
  startMicros: 784497,
  path: "/usr/local/bin/tool",
});
const expected = {
  pid: 4242,
  uid: 501,
  startSeconds: 1789817961,
  startMicros: 784497,
  path: "/usr/local/bin/tool",
  group: 4242,
};

test("classification: EPERM denies, ESRCH on both probes proves absence, partial reads are unknown, a changed start time is another process, a changed image is the same process after exec, a zombie keeps its identity", () => {
  assert.equal(classify(expected, live(4242)), "LIVE");
  assert.equal(
    classify(expected, { ...live(4242), info_errno: 1 }),
    "OBSERVATION_DENIED",
  );
  assert.equal(
    classify(expected, { ...live(4242), kill_result: -1, kill_errno: 1 }),
    "OBSERVATION_DENIED",
  );
  assert.equal(
    classify(expected, {
      ...live(4242),
      info_size: 0,
      info_errno: 3,
      kill_result: -1,
      kill_errno: 3,
      path_size: 0,
      path: "",
    }),
    "ABSENT",
  );
  // ESRCH from proc_pidinfo alone (kill(pid, 0) still succeeds) is not proof of absence.
  assert.equal(
    classify(expected, { ...live(4242), info_size: 0, info_errno: 3 }),
    "OBSERVATION_UNKNOWN",
  );
  assert.equal(
    classify(expected, { ...live(4242), path_size: 0 }),
    "OBSERVATION_UNKNOWN",
  );
  assert.equal(
    classify(expected, { ...live(4242), startMicros: 784498 }),
    "IDENTITY_CONFLICT",
  );
  assert.equal(
    classify(expected, { ...live(4242), uid: 0 }),
    "IDENTITY_CONFLICT",
  );
  assert.equal(
    classify(expected, { ...live(4242), path: "/bin/sleep" }),
    "IMAGE_CHANGED",
  );
  assert.equal(
    classify(expected, { ...live(4242), status: 5 }),
    "ZOMBIE_UNREAPED",
  );
  assert.equal(
    classify(expected, { ...live(4242), group: 1 }),
    "GROUP_CHANGED",
  );
  assert.throws(
    () => registration({ ...live(4242), uid: 0 }, { uid: 501 }),
    (error: unknown) =>
      error instanceof ProcessObservationError &&
      error.code === "REGISTRATION_IDENTITY",
  );
  assert.throws(() =>
    registration(live(4242), { uid: 501, image: "/bin/other" }),
  );
  assert.throws(() => registration(live(4242), { uid: 501, parent: 99 }));
  const reg = registration(live(4242), {
    uid: 501,
    parent: 1,
    image: "/usr/local/bin/tool",
  });
  assert.equal(reg.session, 4242);
  assert.deepEqual(schemaIdentity(reg), {
    pid: 4242,
    startTime: new Date(1789817961 * 1000 + 784).toISOString(),
    image: "/usr/local/bin/tool",
  });
  assert.equal(inTargetSession({ session: 4242 }, { pid: 4242 }), true);
  assert.equal(inTargetSession({ session: 7 }, { pid: 4242 }), false);
});

test("helper observation and guarded signals: a detached grandchild is outside the target session and is never signalled; the ledger refuses a changed identity, sends SIGTERM only to the live matched target, and the budget bounds every stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-execution-process-")),
    helper = join(root, "identity");
  buildProcessHelper(helper);
  const observer = new ProcessObserver(helper, 200);
  // The target is its own session leader (detached), like an execution target; it spawns one
  // child in its session and one grandchild that escapes into a new session.
  const target = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');
       const inside=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
       const escaped=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
       console.log(JSON.stringify({inside:inside.pid,escaped:escaped.pid}));
       setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const spectator = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {
      stdio: "ignore",
    },
  );
  let escapedPid = 0;
  try {
    const [data] = await once(target.stdout!, "data");
    const pids = JSON.parse(String(data)) as {
      inside: number;
      escaped: number;
    };
    escapedPid = pids.escaped;
    const observed = await observer.inspect(target.pid!);
    const reg = registration(observed, {
      uid: process.getuid!(),
      parent: process.pid,
      image: process.execPath,
    });
    assert.equal(reg.session, target.pid);
    assert.ok(reg.group !== process.pid);
    const table = await observer.scan(target.pid!);
    const inside = table.find((row) => row.pid === pids.inside)!;
    const escaped = table.find((row) => row.pid === pids.escaped)!;
    assert.ok(inside && escaped, "both descendants are in the scan");
    assert.equal(inTargetSession(inside, reg), true);
    assert.equal(inTargetSession(escaped, reg), false);
    assert.equal(escaped.session, pids.escaped);
    assert.equal(inside.uid, process.getuid!());
    assert.match(await bootId(), /^boot:\d+\/[0-9A-Fa-f-]+$/);
    const insideReg = registration(await observer.inspect(pids.inside), {
      uid: process.getuid!(),
    });
    const escapedReg = registration(await observer.inspect(pids.escaped), {
      uid: process.getuid!(),
    });
    const ledger = new SignalLedger(observer, reg, { TERM: 1, KILL: 1 });
    // Outside the target session: refused before any syscall, the process stays alive.
    const refusedSession = await ledger.send(escapedReg, "TERM", "escaped");
    assert.equal(refusedSession.sent, false);
    assert.equal(refusedSession.reason, "outside the target session");
    assert.doesNotThrow(() => process.kill(pids.escaped, 0));
    // A changed identity (another start time) is refused even inside the session.
    const refusedIdentity = await ledger.send(
      { ...insideReg, startMicros: insideReg.startMicros + 1 },
      "TERM",
      "inside-conflict",
    );
    assert.equal(refusedIdentity.sent, false);
    assert.equal(refusedIdentity.classification, "IDENTITY_CONFLICT");
    assert.doesNotThrow(() => process.kill(pids.inside, 0));
    assert.deepEqual(ledger.counts(), { TERM: 0, KILL: 0 });
    // The matched target receives SIGTERM; node exits on it, the parent waits, the pid is gone.
    const sent = await ledger.send(reg, "TERM", "target");
    assert.equal(sent.sent, true);
    await once(target, "exit");
    const gone = await observer.waitAbsent(reg, 2000);
    assert.equal(gone.state, "ABSENT");
    // The child inside the session survives its parent (still LIVE); the TERM budget is spent, so
    // a second TERM is refused before any syscall and the child stays alive.
    const insideAfter = classify(
      insideReg,
      await observer.inspect(pids.inside),
    );
    assert.equal(insideAfter, "LIVE");
    assert.equal(inTargetSession(insideReg, reg), true);
    await assert.rejects(
      () => ledger.send(insideReg, "TERM", "over-budget"),
      (error: unknown) =>
        error instanceof ProcessObservationError &&
        error.code === "SIGNAL_BUDGET",
    );
    assert.doesNotThrow(() => process.kill(pids.inside, 0));
    // KILL by identity inside the session is allowed once.
    const killed = await ledger.send(insideReg, "KILL", "inside");
    assert.equal(killed.sent, true);
    assert.equal((await observer.waitAbsent(insideReg, 2000)).state, "ABSENT");
    assert.deepEqual(ledger.counts(), { TERM: 1, KILL: 1 });
    // The escaped grandchild was never touched; the spectator neither.
    assert.doesNotThrow(() => process.kill(pids.escaped, 0));
    assert.doesNotThrow(() => process.kill(spectator.pid!, 0));
    assert.equal(ledger.rows.filter((r) => r.sent).length, 2);
    assert.equal(ledger.rows.filter((r) => !r.sent).length, 3);
    assert.ok(observer.count > 0);
    const small = new ProcessObserver(helper, 1);
    await small.inspect(process.pid);
    await assert.rejects(
      () => small.inspect(process.pid),
      (error: unknown) =>
        error instanceof ProcessObservationError &&
        error.code === "OBSERVER_BUDGET",
    );
  } finally {
    for (const pid of [target.pid!, escapedPid, spectator.pid!])
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    await wait(50);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A detached target (its own session leader) with `inside` same-session children and `escaped` own-session descendants. */
function tree(inside: number, escaped: number) {
  const target = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');
       const inside=[...Array(${inside})].map(()=>spawn('/bin/sleep',['60'],{stdio:'ignore'}).pid);
       const escaped=[...Array(${escaped})].map(()=>spawn('/bin/sleep',['60'],{detached:true,stdio:'ignore'}).pid);
       console.log(JSON.stringify({inside,escaped}));
       setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const pids = once(target.stdout!, "data").then(
    ([data]) =>
      JSON.parse(String(data)) as { inside: number[]; escaped: number[] },
  );
  return { target, pids };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("reclaim after the target exits: a same-session child is TERMed by identity and reclaimed; a stale identity on a reused pid is refused on the ledger and the live process is untouched; an already absent child needs nothing; a descendant in its own session is escaped and never signalled; an exhausted signal budget and a failing observer both halt the reclaim with the rest remaining", async () => {
  const root = mkdtempSync(join(tmpdir(), "csthink-execution-reclaim-")),
    helper = join(root, "identity");
  buildProcessHelper(helper);
  const observer = new ProcessObserver(helper, 500);
  const uid = process.getuid!();
  const a = tree(1, 1);
  const b = tree(2, 0);
  const c = tree(1, 0);
  const cleanup: number[] = [];
  try {
    const [pa, pb, pc] = await Promise.all([a.pids, b.pids, c.pids]);
    cleanup.push(...pa.inside, ...pa.escaped, ...pb.inside, ...pc.inside);
    const reg = async (pid: number) =>
      registration(await observer.inspect(pid), { uid });
    // (1) Mixed descendants of target a; the target itself is ended first (the reclaim runs after the exit).
    const targetA = await reg(a.target.pid!);
    const inside = await reg(pa.inside[0]);
    const escaped = await reg(pa.escaped[0]);
    const stale: RegisteredProcess = {
      ...inside,
      startMicros: inside.startMicros + 1,
    };
    const short = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"], {
      stdio: "ignore",
    });
    const absent = await reg(short.pid!);
    await once(short, "exit");
    a.target.kill("SIGKILL");
    await once(a.target, "exit");
    const ledgerA = new SignalLedger(observer, targetA, () => ({
      TERM: 1 + 4,
      KILL: 1 + 4,
    }));
    const outcome = await reclaimDescendants({
      observer,
      ledger: ledgerA,
      target: targetA,
      children: [stale, inside, escaped, absent],
      unregistered: [],
      cleanupMs: 2000,
    });
    assert.deepEqual(
      outcome.reclaimed.map((r) => r.pid),
      [inside.pid],
    );
    assert.deepEqual(outcome.remaining, []);
    assert.deepEqual(
      outcome.escaped.map((e) => [e.identity.pid, e.kind, e.session]),
      [[escaped.pid, "registered", escaped.pid]],
    );
    assert.deepEqual(outcome.errors, []);
    assert.equal(alive(inside.pid), false, "the same-session child is gone");
    assert.equal(alive(escaped.pid), true, "the escaped process lives on");
    assert.deepEqual(
      ledgerA.rows.map((r) => [
        r.stage,
        r.pid,
        r.classification,
        r.sent,
        r.reason,
      ]),
      [
        ["TERM", inside.pid, "IDENTITY_CONFLICT", false, "identity not LIVE"],
        ["TERM", inside.pid, "LIVE", true, "sent"],
      ],
    );
    assert.deepEqual(ledgerA.counts(), { TERM: 1, KILL: 0 });
    // (2) Budget exhausted: only one TERM allowed, two children inside the session.
    const targetB = await reg(b.target.pid!);
    const [b1, b2] = await Promise.all(pb.inside.map(reg));
    b.target.kill("SIGKILL");
    await once(b.target, "exit");
    const ledgerB = new SignalLedger(observer, targetB, { TERM: 1, KILL: 1 });
    const budget = await reclaimDescendants({
      observer,
      ledger: ledgerB,
      target: targetB,
      children: [b1, b2],
      unregistered: [],
      cleanupMs: 2000,
    });
    assert.deepEqual(
      budget.reclaimed.map((r) => r.pid),
      [b1.pid],
    );
    assert.deepEqual(
      budget.remaining.map((r) => r.pid),
      [b2.pid],
    );
    assert.equal(budget.errors.length, 1);
    assert.match(budget.errors[0], /budget exhausted/);
    assert.equal(alive(b2.pid), true, "nothing beyond the budget was sent");
    assert.equal(
      ledgerB.rows.filter((r) => r.pid === b2.pid && !r.sent).length,
      1,
      "the refusal is on the ledger",
    );
    // (3) Observer failure: the helper no longer answers; nothing is signalled, the child remains.
    const targetC = await reg(c.target.pid!);
    const c1 = await reg(pc.inside[0]);
    c.target.kill("SIGKILL");
    await once(c.target, "exit");
    const broken = new ProcessObserver(join(root, "missing-helper"), 500);
    const ledgerC = new SignalLedger(broken, targetC, { TERM: 2, KILL: 2 });
    const lost = await reclaimDescendants({
      observer: broken,
      ledger: ledgerC,
      target: targetC,
      children: [c1],
      unregistered: [],
      cleanupMs: 2000,
    });
    assert.deepEqual(lost.reclaimed, []);
    assert.deepEqual(
      lost.remaining.map((r) => r.pid),
      [c1.pid],
    );
    assert.equal(lost.errors.length, 1);
    assert.match(lost.errors[0], /process helper inspect failed/);
    assert.equal(alive(c1.pid), true);
    assert.deepEqual(ledgerC.rows, []);
    assert.deepEqual(ledgerC.counts(), { TERM: 0, KILL: 0 });
  } finally {
    for (const pid of [a.target.pid!, b.target.pid!, c.target.pid!, ...cleanup])
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    await wait(50);
    rmSync(root, { recursive: true, force: true });
  }
});
