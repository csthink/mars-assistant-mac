/**
 * Non-Coding list-domain fake Runtime on Contract 0.1.0 ("confirm synthetic entries"):
 * a plain directory project without Git, hp or any model. Ported from the OD-281
 * cross-language list fake with the argv template placeholders, retry-later,
 * tombstones and file-based fault injection under the instance directory
 * (fault.json: crashAfterWrite, dropResponse, duplicateEvent, skipEvent, busy),
 * plus the upgrade barrier protocol: unconfirmed entries are protected references.
 * Built into a single .cjs bundle member by the test bundle builder; never shipped.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  FrameError,
  LineReader,
  parseFrame,
} from "../../../src/main/runtime-framing";
import { canonicalJson, runtimeLimits } from "../../../src/shared/runtime-host";
import { LIST_CAPABILITY, LIST_SCHEMA } from "./list-contract";

const [instanceDir, contractDigest] = process.argv.slice(2);
const PROTOCOL_VERSION = "0.1.0-draft.5";
/** The domain data format this fake's bundles declare (bundle builder default). */
const DATA_FORMAT = "test.f1";
const sha256 = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const digestOf = (v: unknown) => sha256(canonicalJson(v));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
// The fake mirrors wire objects loosely on purpose; the Host side validates them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const stateDir = join(instanceDir, "list-runtime");
mkdirSync(stateDir, { recursive: true });
// Test observation of the launch environment the Host passed (names only; KB-278 item 4).
writeFileSync(
  join(instanceDir, "launch-environment.json"),
  JSON.stringify({
    names: Object.keys(process.env).sort(),
    home: process.env.HOME ?? null,
  }),
);
const STATE_PATH = join(stateDir, "state.json");
const FAULT_PATH = join(instanceDir, "fault.json");
const fault = (): Json => {
  try {
    return JSON.parse(readFileSync(FAULT_PATH, "utf8"));
  } catch {
    return {};
  }
};
type Entry = {
  id: string;
  title: string;
  group: string;
  confirmed: boolean;
  pendingSince: string;
  processedAt: string | null;
  revision: number;
};
const state: Json = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : {
      generation: 0,
      revision: 0,
      entries: {} as Record<string, Entry>,
      operations: {},
      idempotency: {},
      tombstones: {},
      stream: { streamId: "stream:list", epoch: "epoch:1", seq: 0 },
      events: [] as Json[],
      upgrades: {},
      barrier: null,
    };
state.upgrades ??= {};
state.barrier ??= null;
const persist = () => {
  writeFileSync(STATE_PATH + ".tmp", JSON.stringify(state));
  renameSync(STATE_PATH + ".tmp", STATE_PATH);
};
let context: Json | null = null;
let bundleDigest = "";
let ready = false;
let limits = { ...runtimeLimits };
let inFlight = 0;
const scopes = new Map<string, Json>();
const bindings = new Map<string, string>();
const snapshots = new Map<string, Json>();
const subscriptions = new Map<
  string,
  {
    scopeRef: string;
    acked: number;
    sent: number;
    unackedBytes: number;
    queue: Json[];
    caughtUpPending: string | null;
  }
>();
const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
let serial = 0;
let subscriptionSerial = 0;
const waiting = new Map<
  string,
  { resolve: (v: Json) => void; reject: (e: Error) => void }
>();
function host(method: string, params: Json): Promise<Json> {
  const id = "r:" + ++serial;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    out({ jsonrpc: "2.0", id, method, params: { context, ...params } });
  });
}
class Fail extends Error {
  constructor(
    public code: string,
    message: string,
    public recovery = "none",
    public absenceProven = false,
  ) {
    super(message);
  }
}
const scopeRefOf = () => [...scopes.keys()][0] ?? "scope:none";
function projection() {
  const scope = scopeRefOf();
  const entries: Entry[] = Object.values(state.entries);
  const groups = [...new Set(entries.map((e) => e.group))].sort();
  const objects: Json[] = [
    {
      scopeRef: scope,
      objectRef: "directory:root",
      revision: "rev:" + state.revision,
      title: "Plain directory project",
      stateLabel: "entries:" + entries.length,
      capability: LIST_CAPABILITY,
      view: {
        kind: "list",
        rows: [
          { id: "git", title: "git", detail: "none (plain directory)" },
          ...groups.map((g) => ({
            id: "group:" + g,
            title: "group " + g,
            detail: entries.filter((e) => e.group === g).length + " entries",
          })),
        ],
      },
      evidence: [],
    },
  ];
  for (const e of entries)
    objects.push({
      scopeRef: scope,
      objectRef: "entry:" + e.id,
      revision: "rev:" + e.revision,
      title: e.title,
      stateLabel: e.confirmed ? "confirmed" : "unconfirmed",
      capability: LIST_CAPABILITY,
      view: {
        kind: "list",
        rows: [
          { id: "group", title: "group", detail: e.group },
          { id: "confirmed", title: "confirmed", detail: String(e.confirmed) },
        ],
      },
      evidence: [],
    });
  const action = (
    objectRef: string,
    actionId: string,
    label: string,
    revision: string,
    human: boolean,
    candidate: string | null = null,
  ) => ({
    scopeRef: scope,
    actionId,
    objectRef,
    capability: LIST_CAPABILITY,
    label,
    expectedRevision: revision,
    candidateRef: candidate,
    payloadSchemaDigest: LIST_CAPABILITY.schemaDigest,
    enabled: true,
    disabledReason: "",
    disabledCode: null,
    requiresHumanDecision: human,
  });
  const actions = [
    action(
      "directory:root",
      "entry.create",
      "Create an entry",
      "rev:" + state.revision,
      false,
    ),
    action(
      "directory:root",
      "entry.read-foreign",
      "Read a foreign Host snapshot (test-only)",
      "rev:" + state.revision,
      false,
    ),
  ];
  for (const e of entries) {
    actions.push(
      action(
        "entry:" + e.id,
        "entry.organize",
        "Move entry to a group",
        "rev:" + e.revision,
        false,
      ),
    );
    if (!e.confirmed)
      actions.push(
        action(
          "entry:" + e.id,
          "entry.confirm",
          "Confirm entry",
          "rev:" + e.revision,
          true,
          "entry-candidate:" + e.id + ".r" + e.revision,
        ),
      );
  }
  const pendingItems = entries.map((e) => ({
    scopeRef: scope,
    itemRef: "pending:" + e.id,
    revision: "rev:" + e.revision,
    objectRef: "entry:" + e.id,
    capability: LIST_CAPABILITY,
    title: "Confirm " + e.title,
    typeId: "confirm-entry",
    typeLabel: "Confirm entry",
    status: e.confirmed ? "processed" : "pending",
    pendingSince: e.pendingSince,
    updatedAt: e.processedAt ?? e.pendingSince,
    processedAt: e.processedAt,
    blocking: !e.confirmed,
    actionIds: e.confirmed ? [] : ["entry.confirm"],
    evidence: [],
  }));
  return { objects, actions, pendingItems };
}
function upgradeView(record: Json) {
  return { ...record };
}
function operationView(op: Json) {
  return {
    operationId: op.operationId,
    scopeRef: op.scopeRef,
    requestDigest: op.requestDigest,
    status: op.status,
    resultRef: null,
    executionRef: null,
    reason: op.reason ?? "",
    resultCode: op.resultCode ?? null,
    revision: "op-rev:" + op.revision,
  };
}
function drain(sid: string) {
  const sub = subscriptions.get(sid)!;
  const f = fault();
  while (sub.queue.length) {
    if (
      sub.sent - sub.acked >= limits.eventWindow ||
      sub.unackedBytes >= limits.bufferBytes
    )
      return;
    const ev = sub.queue.shift()!;
    if (f.skipEvent === ev.seq) continue;
    const frame = {
      jsonrpc: "2.0",
      method: "runtime.event",
      params: { context, event: { subscriptionId: sid, ...ev } },
    };
    sub.sent = Number(ev.seq);
    sub.unackedBytes += JSON.stringify(frame).length + 1;
    out(frame);
    if (f.duplicateEvent === ev.seq) out(frame);
  }
  if (sub.caughtUpPending !== null) {
    out({
      jsonrpc: "2.0",
      method: "runtime.event",
      params: {
        context,
        event: {
          kind: "stream.caughtUp",
          subscriptionId: sid,
          scopeRef: sub.scopeRef,
          streamId: state.stream.streamId,
          epoch: state.stream.epoch,
          throughSeq: sub.caughtUpPending,
        },
      },
    });
    sub.caughtUpPending = null;
  }
}
function transaction(mutate: (s: Json) => Json, crash = false) {
  const before = projection();
  const beforeOps = JSON.parse(JSON.stringify(state.operations));
  const result = mutate(state);
  state.revision += 1;
  const after = projection();
  const base = {
    scopeRef: scopeRefOf(),
    streamId: state.stream.streamId,
    epoch: state.stream.epoch,
    causationId: null,
  };
  const events: Json[] = [];
  const bo = new Map(before.objects.map((o) => [o.objectRef, o]));
  for (const o of after.objects)
    if (canonicalJson(bo.get(o.objectRef)) !== canonicalJson(o))
      events.push({ ...base, kind: "object.upsert", payload: o });
  const ao = new Set(after.objects.map((o) => o.objectRef));
  for (const k of bo.keys())
    if (!ao.has(k))
      events.push({
        ...base,
        kind: "object.remove",
        payload: { objectRef: k },
      });
  const ba = new Map(
    before.actions.map((a) => [a.actionId + "@" + a.objectRef, a]),
  );
  const aa = new Map(
    after.actions.map((a) => [a.actionId + "@" + a.objectRef, a]),
  );
  // Contract action.remove names the actionId only, so it removes that action for every object of the scope;
  // the removes go first and every surviving action with a removed id is upserted again afterwards.
  const removedIds = new Set<string>();
  for (const [k, a] of ba) if (!aa.has(k)) removedIds.add(a.actionId);
  for (const actionId of removedIds)
    events.push({ ...base, kind: "action.remove", payload: { actionId } });
  for (const [k, a] of aa)
    if (
      removedIds.has(a.actionId) ||
      canonicalJson(ba.get(k)) !== canonicalJson(a)
    )
      events.push({ ...base, kind: "action.upsert", payload: a });
  const bp = new Map(before.pendingItems.map((p) => [p.itemRef, p]));
  for (const p of after.pendingItems)
    if (canonicalJson(bp.get(p.itemRef)) !== canonicalJson(p))
      events.push({ ...base, kind: "pending.upsert", payload: p });
  for (const [id, op] of Object.entries(state.operations))
    if (canonicalJson(beforeOps[id]) !== canonicalJson(op))
      events.push({
        ...base,
        kind: "operation.changed",
        payload: operationView(op as Json),
      });
  for (const ev of events) {
    state.stream.seq += 1;
    ev.seq = String(state.stream.seq);
    ev.eventId = "event:" + state.stream.epoch.split(":")[1] + ":" + ev.seq;
    ev.domainRevision = "rev:" + state.revision;
    state.events.push(ev);
  }
  state.events = state.events.slice(-2000);
  persist();
  if (crash) process.exit(3);
  for (const [sid, sub] of subscriptions) {
    sub.queue.push(...events);
    drain(sid);
  }
  return result;
}
function page(sid: string, index: number) {
  const snap = snapshots.get(sid);
  if (!snap || Date.now() > snap.expires)
    throw new Fail("RESYNC_REQUIRED", "snapshot expired or unknown", "resync");
  const size = Math.min(limits.pageObjects, 4);
  const chunk = snap.items.slice(index * size, (index + 1) * size);
  const p: Json = { objects: [], actions: [], pendingItems: [] };
  for (const [k, v] of chunk) p[k].push(v);
  return {
    scopeRef: snap.scopeRef,
    snapshotId: sid,
    revision: snap.revision,
    streamId: state.stream.streamId,
    epoch: snap.epoch,
    throughSeq: snap.throughSeq,
    expiresAt: snap.expiresAt,
    ...p,
    nextPageToken:
      (index + 1) * size < snap.items.length
        ? `page:${sid.split(":")[1]}:${index + 1}`
        : null,
  };
}
function requestDigest(method: string, p: Json) {
  const { context: _c, requestDigest: _d, ...body } = p;
  void _c;
  void _d;
  return digestOf({ method, ...body });
}
/** Dedupe with tombstones (RC-11): same key same digest answers unknown, same key other digest conflicts. */
function dedupe(
  scope: string,
  method: string,
  key: string,
  opId: string,
  digest: string,
) {
  const k = [scope, method, key].join("|");
  const tomb = state.tombstones[k];
  if (tomb) {
    if (tomb.digest !== digest)
      throw new Fail(
        "IDEMPOTENCY_CONFLICT",
        "same key, different request (tombstone)",
        "review",
      );
    return {
      operationId: tomb.operationId,
      scopeRef: scope,
      requestDigest: digest,
      status: "unknown",
      reason: "result retired to a tombstone",
      revision: 0,
    };
  }
  const e = state.idempotency[k];
  if (e) {
    if (e.digest !== digest || e.operationId !== opId)
      throw new Fail(
        "IDEMPOTENCY_CONFLICT",
        "same key, different request or operation",
        "review",
      );
    return state.operations[opId];
  }
  if (state.operations[opId])
    throw new Fail(
      "IDEMPOTENCY_CONFLICT",
      "operationId reused with another key",
      "review",
    );
  return null;
}
async function dispatch(method: string, p: Json): Promise<Json> {
  if (method === "runtime.initialize") {
    const selected = p.protocols.find(
      (x: Json) =>
        x.version === PROTOCOL_VERSION && x.contractDigest === contractDigest,
    );
    if (!selected)
      throw new Fail("UNSUPPORTED_VERSION", "no exact protocol identity");
    if (
      !p.capabilities.some(
        (c: Json) =>
          c.id === LIST_CAPABILITY.id &&
          c.version === LIST_CAPABILITY.version &&
          c.schemaDigest === LIST_CAPABILITY.schemaDigest,
      )
    )
      throw new Fail("UNSUPPORTED_CAPABILITY", "list capability not offered");
    state.generation += 1;
    persist();
    limits = p.limits;
    bundleDigest = p.bundleDigest;
    context = {
      protocolVersion: PROTOCOL_VERSION,
      contractDigest,
      installationId: p.installationId,
      instanceId: p.instanceId,
      incarnationId: p.incarnationId,
      connectionId: p.connectionId,
      controlGeneration: String(state.generation),
    };
    const f = fault();
    if (f.wrongContext)
      context = { ...context, connectionId: "connection:forged" };
    return {
      context,
      selectedProtocol: selected,
      capabilities: f.extraCapability
        ? [LIST_CAPABILITY, f.extraCapability]
        : [LIST_CAPABILITY],
      limits,
      executionProfiles: [],
      recovery: "snapshot-and-operation-query",
    };
  }
  if (!context || canonicalJson(p.context) !== canonicalJson(context))
    throw new Fail("PERMISSION_DENIED", "context mismatch", "reconnect");
  const active = (ref: string) => {
    const s = scopes.get(ref);
    if (!s) throw new Fail("NOT_FOUND", "unknown scope", "none", true);
    if (!s.active)
      throw new Fail("PERMISSION_DENIED", "scope inactive", "reauthorize");
    return s;
  };
  switch (method) {
    case "runtime.ready":
      ready = true;
      return { ready: true };
    case "runtime.health": {
      const f = fault();
      if (f.healthHang) return new Promise(() => {});
      return {
        health: ready && !f.degraded ? "ready" : "degraded",
        reason: f.degraded ? String(f.degraded) : "",
      };
    }
    case "runtime.scope.open": {
      if (!ready) throw new Fail("PRECONDITION_CONFLICT", "not ready");
      // Fault injection: a Runtime that refuses to open a scope, for example without its binding file (hp, OD-412).
      const refusal = fault().refuseScopeOpen;
      if (refusal) throw new Fail("PERMISSION_DENIED", String(refusal));
      const b = p.binding;
      if (bindings.has(b.bindingRef)) {
        const ref = bindings.get(b.bindingRef)!;
        if (scopes.get(ref)!.resourceHandle !== b.resourceHandle)
          throw new Fail(
            "PRECONDITION_CONFLICT",
            "binding maps to another resource",
          );
        return { scopeRef: ref, bindingRef: b.bindingRef, state: "inactive" };
      }
      const ref = "scope:list-" + (scopes.size + 1);
      bindings.set(b.bindingRef, ref);
      scopes.set(ref, {
        bindingRef: b.bindingRef,
        resourceHandle: b.resourceHandle,
        grants: [],
        active: false,
      });
      return { scopeRef: ref, bindingRef: b.bindingRef, state: "inactive" };
    }
    case "runtime.scope.authorize": {
      const s = scopes.get(p.scopeRef);
      if (!s) throw new Fail("NOT_FOUND", "unknown scope", "none", true);
      const grants = p.grantRefs.length
        ? (await host("host.grants.get", { grantRefs: p.grantRefs })).grants
        : [];
      const usable = grants.filter(
        (g: Json) =>
          g.status === "active" &&
          g.scopeRef === p.scopeRef &&
          g.resourceHandle === s.resourceHandle &&
          g.capability === LIST_CAPABILITY.id,
      );
      if (p.grantRefs.length && fault().refuseAuthorize)
        throw new Fail("PERMISSION_DENIED", String(fault().refuseAuthorize));
      s.grants = usable.map((g: Json) => g.ref);
      // The fake's own operation, or the Contract method names the product's project entry grants (OD-416).
      s.active = usable.some(
        (g: Json) =>
          g.operation === "directory.read" ||
          g.operation === "runtime.snapshot.open",
      );
      return { scopeRef: p.scopeRef, state: s.active ? "active" : "inactive" };
    }
    case "runtime.snapshot.open": {
      active(p.scopeRef);
      const pr = projection();
      const items = [
        ...pr.objects.map((o) => ["objects", o]),
        ...pr.actions.map((a) => ["actions", a]),
        ...pr.pendingItems.map((i) => ["pendingItems", i]),
      ];
      const sid = "snapshot:" + (snapshots.size + 1);
      const lease = fault().shortLease ? 50 : 60000;
      snapshots.set(sid, {
        scopeRef: p.scopeRef,
        items,
        revision: "rev:" + state.revision,
        throughSeq: String(state.stream.seq),
        epoch: state.stream.epoch,
        expires: Date.now() + lease,
        expiresAt: new Date(Date.now() + lease)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
      });
      return page(sid, 0);
    }
    case "runtime.snapshot.next": {
      active(p.scopeRef);
      const parts = p.pageToken.split(":");
      if ("snapshot:" + parts[1] !== p.snapshotId)
        throw new Fail("PRECONDITION_CONFLICT", "token/snapshot mismatch");
      return page(p.snapshotId, Number(parts[2]));
    }
    case "runtime.events.subscribe": {
      active(p.scopeRef);
      if (
        p.streamId !== state.stream.streamId ||
        p.epoch !== state.stream.epoch
      )
        throw new Fail(
          "RESYNC_REQUIRED",
          "stream identity or epoch changed",
          "resync",
        );
      const after = Number(p.afterSeq);
      if (state.events.length && Number(state.events[0].seq) > after + 1)
        throw new Fail(
          "RESYNC_REQUIRED",
          "replay log does not cover afterSeq",
          "resync",
        );
      let replaced: string | null = null;
      for (const [k, v] of [...subscriptions])
        if (v.scopeRef === p.scopeRef) {
          subscriptions.delete(k);
          replaced = k;
        }
      const sid = "subscription:" + ++subscriptionSerial;
      subscriptions.set(sid, {
        scopeRef: p.scopeRef,
        acked: after,
        sent: after,
        unackedBytes: 0,
        queue: state.events.filter((e: Json) => Number(e.seq) > after),
        caughtUpPending: String(state.stream.seq),
      });
      setTimeout(() => drain(sid), 20);
      return { subscriptionId: sid, replacedSubscriptionId: replaced };
    }
    case "runtime.events.ack": {
      const s = subscriptions.get(p.subscriptionId);
      if (!s)
        throw new Fail(
          "RESYNC_REQUIRED",
          "unknown or replaced subscription",
          "resync",
        );
      if (Number(p.seq) > state.stream.seq)
        throw new Fail("PRECONDITION_CONFLICT", "undelivered sequence");
      if (Number(p.seq) > s.acked) {
        s.acked = Number(p.seq);
        if (s.acked >= s.sent) s.unackedBytes = 0;
      }
      drain(p.subscriptionId);
      return { acknowledgedSeq: String(s.acked) };
    }
    case "runtime.operation.get": {
      active(p.scopeRef);
      const op = state.operations[p.operationId];
      if (!op) {
        const tomb = Object.values(
          state.tombstones as Record<string, Json>,
        ).find((t) => t.operationId === p.operationId);
        if (tomb)
          throw new Fail(
            "RESULT_UNKNOWN",
            "result retired to a tombstone",
            "query",
            false,
          );
        if (fault().indexLost)
          throw new Fail(
            "RESULT_UNKNOWN",
            "operation index unavailable",
            "query",
            false,
          );
        throw new Fail("NOT_FOUND", "never accepted", "query", true);
      }
      return operationView(op);
    }
    case "runtime.operation.cancel": {
      active(p.scopeRef);
      const d = requestDigest(method, p);
      if (d !== p.requestDigest)
        throw new Fail("PRECONDITION_CONFLICT", "digest");
      const ex = dedupe(p.scopeRef, method, p.idempotencyKey, p.operationId, d);
      if (ex) return operationView(ex);
      if (!state.operations[p.targetOperationId])
        throw new Fail("NOT_FOUND", "target unknown", "query", true);
      return operationView(
        transaction((s) => {
          const op = {
            operationId: p.operationId,
            scopeRef: p.scopeRef,
            requestDigest: d,
            status: "succeeded",
            reason: "target already terminal",
            revision: 1,
          };
          s.operations[p.operationId] = op;
          s.idempotency[[p.scopeRef, method, p.idempotencyKey].join("|")] = {
            digest: d,
            operationId: p.operationId,
          };
          return op;
        }),
      );
    }
    case "runtime.quiesce":
    case "runtime.shutdown": {
      const d = requestDigest(method, p);
      if (d !== p.requestDigest)
        throw new Fail("PRECONDITION_CONFLICT", "digest");
      const ex = dedupe("instance", method, p.idempotencyKey, p.operationId, d);
      if (ex) return operationView(ex);
      const op = transaction((s) => {
        const o = {
          operationId: p.operationId,
          scopeRef: "instance",
          requestDigest: d,
          status: "succeeded",
          reason: p.reason,
          revision: 1,
        };
        s.operations[p.operationId] = o;
        s.idempotency[["instance", method, p.idempotencyKey].join("|")] = {
          digest: d,
          operationId: p.operationId,
        };
        return o;
      });
      if (method === "runtime.shutdown") setTimeout(() => process.exit(0), 200);
      return operationView(op);
    }
    case "runtime.resource.read":
      throw new Fail(
        "NOT_FOUND",
        "the list domain publishes no evidence",
        "none",
        true,
      );
    case "runtime.upgrade.prepare": {
      const d = requestDigest(method, p);
      if (d !== p.requestDigest)
        throw new Fail("PRECONDITION_CONFLICT", "digest");
      const k = ["instance", method, p.idempotencyKey].join("|");
      const e = state.idempotency[k];
      // A prepare's result is fixed: the same key and digest answers the stored state, blocked stays blocked.
      if (e) {
        if (e.digest !== d || e.operationId !== p.operationId)
          throw new Fail(
            "IDEMPOTENCY_CONFLICT",
            "same key, other request",
            "review",
          );
        return upgradeView(state.upgrades[p.operationId]);
      }
      if (
        p.sourceBundleDigest !== bundleDigest ||
        p.sourceDataFormat !== DATA_FORMAT
      )
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "source identity is not the running bundle",
        );
      if (state.barrier)
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "barrier " + state.barrier.barrierRef + " already holds",
        );
      const scope = scopeRefOf();
      const protectedReferences = (Object.values(state.entries) as Entry[])
        .filter((en) => !en.confirmed)
        .map((en) => ({
          scopeRef: scope,
          objectRef: "entry:" + en.id,
          revision: "rev:" + en.revision,
          reason: "unconfirmed entry",
        }));
      const blocked = protectedReferences.length > 0;
      const upgrade = transaction((st) => {
        const record: Json = {
          operationId: p.operationId,
          requestDigest: d,
          sourceBundleDigest: p.sourceBundleDigest,
          targetBundleDigest: p.targetBundleDigest,
          sourceDataFormat: p.sourceDataFormat,
          targetDataFormat: p.targetDataFormat,
          status: blocked ? "blocked" : "prepared",
          barrierRef: blocked ? null : "barrier:" + p.operationId.slice(3, 11),
          // The transaction advances the domain revision; the state names the revision it commits at.
          domainRevision: "rev:" + (st.revision + 1),
          preparedGeneration: String(st.generation),
          protectedReferences,
          reason: blocked
            ? protectedReferences.length + " protected reference(s)"
            : "domain barrier established",
          releasedDomainRevision: null,
        };
        st.upgrades[p.operationId] = record;
        st.idempotency[k] = { digest: d, operationId: p.operationId };
        if (!blocked)
          st.barrier = {
            barrierRef: record.barrierRef,
            operationId: p.operationId,
          };
        return record;
      });
      return upgradeView(upgrade);
    }
    case "runtime.upgrade.get": {
      const record = state.upgrades[p.operationId];
      if (!record)
        throw new Fail("NOT_FOUND", "no such preparation", "query", true);
      return upgradeView(record);
    }
    case "runtime.upgrade.release": {
      const d = requestDigest(method, p);
      if (d !== p.requestDigest)
        throw new Fail("PRECONDITION_CONFLICT", "digest");
      const ex = dedupe("instance", method, p.idempotencyKey, p.operationId, d);
      if (ex) return operationView(ex);
      const record = state.upgrades[p.prepareOperationId];
      if (!record)
        throw new Fail("NOT_FOUND", "no such preparation", "query", true);
      // The release binds the barrier, the running bundle and the data format; any mismatch refuses.
      const expectedBundle =
        p.disposition === "activated"
          ? record.targetBundleDigest
          : record.sourceBundleDigest;
      const expectedFormat =
        p.disposition === "activated"
          ? record.targetDataFormat
          : record.sourceDataFormat;
      if (
        record.status !== "prepared" ||
        !state.barrier ||
        state.barrier.barrierRef !== p.barrierRef ||
        record.barrierRef !== p.barrierRef
      )
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "release does not match the persisted barrier",
        );
      // The running bundle and data format must be the ones this process really runs and the ones the disposition names.
      if (
        p.runningBundleDigest !== expectedBundle ||
        p.runningBundleDigest !== bundleDigest ||
        p.dataFormat !== expectedFormat ||
        p.dataFormat !== DATA_FORMAT
      )
        throw new Fail(
          "INTEGRITY_MISMATCH",
          "release names another bundle identity or data format than the running one",
        );
      const op = transaction((st) => {
        const o = {
          operationId: p.operationId,
          scopeRef: "instance",
          requestDigest: d,
          status: "succeeded",
          reason: "barrier released (" + p.disposition + ")",
          revision: 1,
        };
        st.operations[p.operationId] = o;
        st.idempotency[["instance", method, p.idempotencyKey].join("|")] = {
          digest: d,
          operationId: p.operationId,
        };
        st.upgrades[p.prepareOperationId] = {
          ...record,
          status: "released",
          releasedDomainRevision: "rev:" + (st.revision + 1),
          reason: "released after " + p.disposition,
        };
        st.barrier = null;
        return o;
      });
      return operationView(op);
    }
    case "runtime.action.invoke": {
      const s = active(p.scopeRef);
      // The persisted domain barrier refuses new user actions until released (Contract "升级与迁移").
      if (state.barrier)
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "upgrade barrier " + state.barrier.barrierRef + " holds",
        );
      const held = new Set(s.grants.map((g: Json) => g.id + "@" + g.revision));
      for (const g of p.grantRefs)
        if (!held.has(g.id + "@" + g.revision)) {
          // Re-check with the Host: a grant it reports as revoked or expired answers PERMISSION_REVOKED.
          const known = (
            await host("host.grants.get", { grantRefs: [g] })
          ).grants.find((x: Json) => x.ref.id === g.id);
          throw new Fail(
            known && known.status !== "active"
              ? "PERMISSION_REVOKED"
              : "PERMISSION_DENIED",
            known ? "grant " + known.status : "grant not authorized",
            "reauthorize",
          );
        }
      const d = requestDigest(method, p);
      if (d !== p.requestDigest)
        throw new Fail("PRECONDITION_CONFLICT", "requestDigest mismatch");
      const ex = dedupe(p.scopeRef, method, p.idempotencyKey, p.operationId, d);
      if (ex) return operationView(ex);
      const pr = projection();
      const offered = pr.actions.find(
        (a) => a.actionId === p.actionId && a.objectRef === p.objectRef,
      );
      if (!offered)
        throw new Fail("PRECONDITION_CONFLICT", "action not offered", "resync");
      if (offered.expectedRevision !== p.expectedRevision)
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "stale expectedRevision",
          "resync",
        );
      if ((offered.candidateRef ?? null) !== (p.candidateRef ?? null))
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "candidateRef mismatch",
          "resync",
        );
      if (
        !LIST_SCHEMA.properties.choice.enum.includes(p.payload.choice) ||
        Object.keys(p.payload).some((k) => !["choice", "arguments"].includes(k))
      )
        throw new Fail(
          "PRECONDITION_CONFLICT",
          "payload violates the capability schema",
        );
      if (offered.requiresHumanDecision) {
        if (!p.decisionRef)
          throw new Fail("PERMISSION_DENIED", "decision required", "review");
        const dec = await host("host.decision.get", {
          scopeRef: p.scopeRef,
          decisionRef: p.decisionRef,
        });
        for (const k of [
          "actionId",
          "objectRef",
          "candidateRef",
          "expectedRevision",
          "requestDigest",
        ])
          if (dec[k] !== p[k])
            throw new Fail(
              "PERMISSION_DENIED",
              "decision does not bind " + k,
              "review",
            );
        if (dec.domainOperationId !== p.operationId || dec.status !== "valid")
          throw new Fail(
            "PERMISSION_DENIED",
            "decision invalid for this operation",
            "review",
          );
      }
      const args = p.payload.arguments ?? {};
      let foreign: Json | null = null;
      if (p.actionId === "entry.read-foreign") {
        // C-08 (test-only): a host snapshot copied for another scope must not be readable from this scope.
        try {
          await host("host.resource.read", {
            scopeRef: p.scopeRef,
            evidence: args.evidence,
            grantRefs: p.grantRefs,
            offset: 0,
            length: 16,
          });
          foreign = { outcome: "read-succeeded" };
        } catch (e) {
          foreign = {
            outcome: "refused",
            code: (e as Json).code ?? "HOST_ERROR",
          };
        }
      }
      const crash = fault().crashAfterWrite === p.actionId;
      const retire = fault().retireAfter === p.actionId;
      return operationView(
        transaction((st) => {
          const op: Json = {
            operationId: p.operationId,
            scopeRef: p.scopeRef,
            requestDigest: d,
            status: "succeeded",
            reason: "",
            resultCode: null,
            revision: 1,
          };
          st.operations[p.operationId] = op;
          st.idempotency[[p.scopeRef, method, p.idempotencyKey].join("|")] = {
            digest: d,
            operationId: p.operationId,
          };
          if (p.actionId === "entry.create") {
            const id = "e" + (Object.keys(st.entries).length + 1);
            st.entries[id] = {
              id,
              title: args.title ?? id,
              group: args.group ?? "inbox",
              confirmed: false,
              pendingSince: nowIso(),
              processedAt: null,
              revision: st.revision + 1,
            };
            op.reason = "created " + id;
          } else if (p.actionId === "entry.organize") {
            const e = st.entries[p.objectRef.slice(6)];
            e.group = args.group ?? e.group;
            e.revision = st.revision + 1;
            op.reason = "moved to " + e.group;
          } else if (p.actionId === "entry.confirm") {
            const e = st.entries[p.objectRef.slice(6)];
            e.confirmed = true;
            e.processedAt = nowIso();
            e.revision = st.revision + 1;
            op.reason = "confirmed";
          } else if (p.actionId === "entry.read-foreign") {
            op.status = foreign!.outcome === "refused" ? "failed" : "succeeded";
            op.resultCode =
              foreign!.outcome === "refused" ? foreign!.code : null;
            op.reason = "foreign snapshot read " + foreign!.outcome;
          }
          if (retire) {
            // The full result is retired right away; only the key, digest and operationId tombstone remain.
            st.tombstones[[p.scopeRef, method, p.idempotencyKey].join("|")] = {
              digest: d,
              operationId: p.operationId,
            };
            delete st.operations[p.operationId];
            delete st.idempotency[
              [p.scopeRef, method, p.idempotencyKey].join("|")
            ];
          }
          return op;
        }, crash),
      );
    }
  }
  throw new Fail("PRECONDITION_CONFLICT", "unsupported " + method);
}
function failure(id: unknown, e: unknown, p: Json | undefined) {
  const code = e instanceof Fail ? e.code : "PRECONDITION_CONFLICT";
  const recovery = e instanceof Fail ? e.recovery : "none";
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: String((e as Error)?.message ?? e).slice(0, 2048),
      data: {
        code,
        scopeRef: p?.scopeRef ?? null,
        operationId: p?.operationId ?? null,
        recovery,
        absenceProven: e instanceof Fail ? e.absenceProven : false,
      },
    },
  };
}
const reader = new LineReader(runtimeLimits);
process.stdin.on("data", (chunk: Buffer) => {
  for (const { raw, error } of reader.feed(chunk)) {
    let m: Json | undefined;
    let err = error;
    if (!err)
      try {
        m = parseFrame(raw!, runtimeLimits) as Json;
      } catch (e) {
        err = e as FrameError;
      }
    if (err) {
      let id: string | null = null;
      try {
        const guess = JSON.parse(raw!.toString("utf8"));
        id = typeof guess?.id === "string" ? guess.id : null;
      } catch {
        id = null;
      }
      out({
        jsonrpc: "2.0",
        id,
        error: {
          code: err.rpcCode,
          message: "frame rejected before dispatch: " + err.message,
        },
      });
      if (err.close) process.exit(2);
      continue;
    }
    if (!m!.method) {
      const w = waiting.get(m!.id);
      if (w) {
        waiting.delete(m!.id);
        if (m!.error)
          w.reject(
            Object.assign(new Error(m!.error.message), {
              code: m!.error.data?.code,
            }),
          );
        else w.resolve(m!.result);
      }
      continue;
    }
    if (inFlight >= limits.inFlight || fault().busy === m!.method) {
      out({
        jsonrpc: "2.0",
        id: m!.id,
        error: {
          code: -32000,
          message: "in-flight request limit reached; not accepted",
          data: {
            code: "BUSY",
            scopeRef: null,
            operationId: null,
            recovery: "retry-later",
            absenceProven: false,
          },
        },
      });
      continue;
    }
    inFlight += 1;
    // Lost-answer injection (C-03): the request is processed and persisted, only the answer never leaves.
    const drop = fault().dropResponse === m!.method;
    dispatch(m!.method, m!.params ?? {})
      .then((result) => {
        if (drop) return;
        out({
          jsonrpc: "2.0",
          id: m!.id,
          result:
            m!.method === "runtime.initialize"
              ? result
              : { context, ...result },
        });
      })
      .catch((e) => {
        if (!drop) out(failure(m!.id, e, m!.params));
      })
      .finally(() => {
        inFlight -= 1;
      });
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
