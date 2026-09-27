import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  actionForm,
  awaitingProjection,
  formLimits,
  formProblem,
  validProjectActionRequest,
} from "../../src/shared/project-actions";
import {
  canonicalJson,
  contractVersion,
  type ProjectionAction,
  type RuntimeOperation,
  type RuntimeProjection,
} from "../../src/shared/runtime-host";
import { payloadSchemaOf } from "../../src/main/project-actions";
import {
  hpActions,
  hpCapabilityDocuments,
  schemaDigest,
} from "./runtime-fakes/hp-capability-documents";
import { JOURNEY_SCHEMA } from "./runtime-fakes/journey-contract";
test("project action forms: unknown constraints, remote references and prototype fields cannot become executable forms", () => {
  for (const extra of [
    { $ref: "https://invalid.test/schema" },
    { oneOf: [] },
    { format: "date-time" },
  ])
    assert.throws(() => actionForm({ type: "string", ...extra }));
  // A pattern belongs to a string and is bounded; it is never compiled or run here.
  for (const schema of [
    { type: "integer", pattern: "^[0-9]+$" },
    { type: "string", pattern: "" },
    { type: "string", pattern: "a".repeat(1025) },
    { type: "string", pattern: 7 },
  ])
    assert.throws(() => actionForm(schema));
  // Only draft-07 is a payload schema dialect, and only at the root.
  assert.throws(() =>
    actionForm({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    }),
  );
  assert.throws(() =>
    actionForm({
      type: "object",
      properties: {
        x: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "string",
        },
      },
    }),
  );
  // A typeless enum is only accepted when its values share one primitive type.
  assert.throws(() => actionForm({ enum: ["a", 1] }));
  assert.throws(() => actionForm({ enum: [1.5] }));
  assert.throws(() =>
    actionForm(
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
      ),
    ),
  );
  assert.equal(
    formProblem(actionForm(JOURNEY_SCHEMA), { decision: "继续", limit: 2 }),
    "",
  );
  for (const value of [
    { decision: "批准" },
    { decision: "继续", limit: 2.5 },
    { decision: "继续", limit: 9 },
    { decision: "继续", unexpected: "yes" },
    {},
  ])
    assert.notEqual(formProblem(actionForm(JOURNEY_SCHEMA), value), "");
});
test("project action forms: the real hp task.accept payload schema (JSON Schema draft-07 with $id, $schema, pattern and a typeless enum) becomes a form; the pattern is shown, never executed, and the Runtime validates it", () => {
  // Bytes of the harness.task-acceptance capability schema in the hp delivery-r3 bundle.
  const schema = JSON.parse(
    '{"$id":"urn:hp:harness:task-acceptance:v1","$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"baseRef":{"maxLength":256,"minLength":1,"type":"string"},"taskId":{"maxLength":128,"minLength":1,"pattern":"^[a-z0-9][a-z0-9-]*$","type":"string"},"taskType":{"enum":["feature","hotfix"]},"worktreeRoot":{"maxLength":4096,"minLength":1,"type":"string"}},"required":["taskType","taskId","baseRef","worktreeRoot"],"type":"object"}',
  );
  const form = actionForm(schema);
  assert.equal(form.type, "object");
  assert.deepEqual(form.required, [
    "taskType",
    "taskId",
    "baseRef",
    "worktreeRoot",
  ]);
  assert.equal(form.properties.taskType.type, "string");
  assert.deepEqual(form.properties.taskType.choices, ["feature", "hotfix"]);
  assert.equal(form.properties.taskId.pattern, "^[a-z0-9][a-z0-9-]*$");
  const value = {
    taskType: "feature",
    taskId: "design-t0",
    baseRef: "main",
    worktreeRoot: "/tmp/worktrees",
  };
  assert.equal(formProblem(form, value), "");
  assert.notEqual(formProblem(form, { ...value, taskType: "design" }), "");
  assert.notEqual(formProblem(form, { ...value, baseRef: "" }), "");
  // The Host does not evaluate the pattern: a value it would reject is left to the Runtime.
  assert.equal(formProblem(form, { ...value, taskId: "Design_T0" }), "");
  // A catastrophic pattern with a long input returns at once: nothing compiles it.
  const hostile = actionForm({ type: "string", pattern: "(a+)+$" });
  const started = Date.now();
  assert.equal(formProblem(hostile, "a".repeat(60000) + "!"), "");
  assert.ok(Date.now() - started < 100);
});
const hp = { actions: hpActions };
const hex40 = "0123456789abcdef0123456789abcdef01234567";
test("project action forms: every hp action payload schema (20 actions, 7 capabilities) is exactly the bytes the Runtime announced and becomes a form", () => {
  const actions = Object.entries(hp.actions);
  assert.equal(actions.length, 20);
  for (const [actionId, entry] of actions) {
    const digest = createHash("sha256")
      .update(canonicalJson(entry.schema))
      .digest("hex");
    assert.equal(digest, entry.payloadSchemaDigest, actionId);
    assert.doesNotThrow(() => actionForm(entry.schema), actionId);
  }
  // As delivery-r3 packaged them, each capability document is its primary action's schema
  // alone, so only these seven resolve (OD-425 R1); the other 13 wait for their documents
  // to carry them under root definitions (R2, the OD-425 test below).
  const negotiated = actions.filter(
    ([, e]) => e.payloadSchemaDigest === e.capabilitySchemaDigest,
  );
  assert.deepEqual(negotiated.map(([id]) => id).sort(), [
    "budget.decide",
    "definition.submit",
    "implement.dispatch",
    "publish.dispatch",
    "task.accept",
    "validate.configure",
    "workflow.decide",
  ]);
});
test("project action forms: OD-425 R1 resolves an action payload schema only as its own capability document or exactly one entry of that document's root definitions; anything else is an unknown schema", () => {
  const annotate = {
    type: "object",
    title: "补充说明",
    properties: { note: { type: "string", title: "说明", maxLength: 200 } },
    required: ["note"],
    additionalProperties: false,
  };
  const close = {
    type: "object",
    properties: { reason: { enum: ["完成", "放弃"] } },
    required: ["reason"],
    additionalProperties: false,
  };
  const document = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "urn:test:review:v1",
    type: "object",
    properties: { decision: { type: "string", enum: ["继续", "拒绝"] } },
    required: ["decision"],
    additionalProperties: false,
    definitions: { "review.annotate": annotate, "review.close": close },
  };
  const digest = schemaDigest(document);
  // The root: the primary action; its form ignores the root definitions (R3).
  const root = payloadSchemaOf(document, digest, digest);
  assert.equal(root, document);
  assert.deepEqual(Object.keys(actionForm(root).properties), ["decision"]);
  // Exactly one entry, by the RFC 8785 digest of the entry value.
  const entry = payloadSchemaOf(document, digest, schemaDigest(annotate));
  assert.equal(entry, annotate);
  const form = actionForm(entry);
  assert.equal(form.title, "补充说明");
  assert.equal(formProblem(form, { note: "已核对" }), "");
  assert.match(formProblem(form, { decision: "继续" }), /未定义字段/);
  assert.equal(payloadSchemaOf(document, digest, schemaDigest(close)), close);
  // A digest that names nothing in this document, one of another capability's document
  // (root or entry), and the digest of an entry's name or of a changed entry are unknown.
  const flag = { type: "object", properties: { on: { type: "boolean" } } };
  const other = { type: "object", definitions: { "other.flag": flag } };
  for (const unknown of [
    "0".repeat(64),
    schemaDigest(other),
    schemaDigest(flag),
    schemaDigest("review.annotate"),
    schemaDigest({ ...annotate, title: "改过的说明" }),
    schemaDigest(document.definitions),
  ])
    assert.throws(
      () => payloadSchemaOf(document, digest, unknown),
      /既不是其能力文档本身，也不是该文档 definitions 中的一项（OD-425 R1）/,
    );
  // A document without definitions knows only its root.
  const bare = { type: "object", properties: {} };
  assert.throws(
    () => payloadSchemaOf(bare, schemaDigest(bare), schemaDigest(annotate)),
    /OD-425 R1/,
  );
  // Two entries with one digest (admission refuses the document, OD-425 R3) name no single schema.
  const twice = {
    ...document,
    definitions: { a: annotate, b: { ...annotate } },
  };
  assert.throws(
    () => payloadSchemaOf(twice, schemaDigest(twice), schemaDigest(annotate)),
    /多项，无法唯一确定（OD-425 R1）/,
  );
  // An entry that is not self-contained is refused at the moment of use too (R2).
  for (const alone of [
    { type: "object", properties: { a: { $ref: "#/definitions/x" } } },
    { $id: "urn:test:entry", type: "object" },
    { type: "object", properties: { a: { $id: "urn:x", type: "string" } } },
  ]) {
    const holder = { type: "object", definitions: { x: alone } };
    assert.throws(
      () => payloadSchemaOf(holder, schemaDigest(holder), schemaDigest(alone)),
      /不是自包含的输入格式（含 \$ref 或 \$id，OD-425 R2）/,
    );
  }
  // Root definitions are ignored only at the root and only as an object of schemas.
  assert.throws(
    () => actionForm({ type: "object", definitions: [] }),
    /不支持的约束：definitions/,
  );
  assert.throws(
    () =>
      actionForm({
        type: "object",
        properties: { a: { type: "string", definitions: {} } },
      }),
    /不支持的约束：definitions/,
  );
});
test("project action forms: hp capability documents reshaped as OD-425 describes resolve every one of the 20 actions in its own capability only, each to a form; the delivery-r3 digests of the other 13 stay unknown", () => {
  const documents = hpCapabilityDocuments();
  assert.equal(documents.length, 7);
  let resolved = 0;
  const shared: string[] = [];
  for (const own of documents)
    for (const [actionId, digest] of Object.entries(own.payloadDigests)) {
      const schema = payloadSchemaOf(own.document, own.digest, digest);
      assert.doesNotThrow(() => actionForm(schema), actionId);
      resolved++;
      for (const other of documents.filter((d) => d !== own)) {
        let found: unknown;
        try {
          found = payloadSchemaOf(other.document, other.digest, digest);
        } catch (error) {
          assert.match((error as Error).message, /OD-425 R1/);
          continue;
        }
        // One digest names one content: another document can hold it only as the same schema.
        assert.deepEqual(found, schema);
        shared.push(`${actionId}@${other.id}`);
      }
    }
  assert.equal(resolved, 20);
  // Without $id, four hp actions of four capabilities have the same schema; R1 still locates
  // each in its own capability only, and within one document every digest is unique (R3).
  assert.deepEqual([...new Set(shared.map((s) => s.split("@")[0]))].sort(), [
    "definition.dispatch",
    "publish.query",
    "validate.resume",
    "verify.run",
  ]);
  // As delivery-r3 announced them: a document is its primary schema alone.
  for (const [actionId, a] of Object.entries(hpActions)) {
    const run = () =>
      payloadSchemaOf(
        hpActions[
          Object.keys(hpActions).find(
            (id) =>
              hpActions[id].capability === a.capability &&
              hpActions[id].payloadSchemaDigest ===
                hpActions[id].capabilitySchemaDigest,
          )!
        ].schema,
        a.capabilitySchemaDigest,
        a.payloadSchemaDigest,
      );
    if (a.payloadSchemaDigest === a.capabilitySchemaDigest)
      assert.doesNotThrow(run, actionId);
    else assert.throws(run, /OD-425 R1/, actionId);
  }
});
test("project action forms: a required text or integer left empty asks to be filled, a filled text outside its length keeps the length message, and an enum left unchosen asks for a choice (KB-307)", () => {
  // hp workflow.close: expectedRuntimeVersion is a required text of 1 to 32 characters.
  const close = actionForm(hp.actions["workflow.close"].schema);
  const value = {
    taskId: "design-t0",
    reasonCategory: "human-initiated",
    expectedRuntimeVersion: "1",
  };
  assert.equal(formProblem(close, value), "");
  assert.equal(
    formProblem(close, { ...value, expectedRuntimeVersion: "" }),
    "expectedRuntimeVersion：请填写。",
  );
  assert.equal(
    formProblem(close, { ...value, expectedRuntimeVersion: "1".repeat(33) }),
    "expectedRuntimeVersion：文本长度不符合要求。",
  );
  // The enum's “请选择” option hands over no value: a choice is asked for, not a length.
  assert.equal(
    formProblem(close, { ...value, reasonCategory: undefined }),
    "reasonCategory：请从现有选项中选择。",
  );
  // A text without a minimum may stay empty; an integer field cleared by the person is unfilled.
  const form = actionForm({
    type: "object",
    properties: {
      note: { type: "string", title: "说明", maxLength: 8 },
      count: { type: "integer", title: "次数", minimum: 1, maximum: 5 },
      refs: {
        type: "array",
        title: "依据",
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["note", "count"],
  });
  assert.equal(formProblem(form, { note: "", count: 1 }), "");
  assert.equal(
    formProblem(form, { note: "", count: undefined }),
    "次数：请填写。",
  );
  assert.equal(
    formProblem(form, { note: "", count: 9 }),
    "次数：整数不在允许范围内。",
  );
  assert.equal(
    formProblem(form, { note: "", count: 1, refs: ["a", ""] }),
    "依据：第 2 项：请填写。",
  );
  assert.equal(
    formProblem(form, { note: "x".repeat(9), count: 1 }),
    "说明：文本长度不符合要求。",
  );
});
test("project action forms: text or a name with an unpaired UTF-16 surrogate is refused, since RFC 8785 has no canonical form for the request digest", () => {
  const form = actionForm({
    type: "object",
    properties: {
      note: { type: "string" },
      tags: { type: "object", additionalProperties: { type: "string" } },
    },
  });
  assert.equal(formProblem(form, { note: "表情 \ud83d\ude00" }), "");
  for (const note of ["\ud83d", "x\ude00", "\ude00\ud83d"])
    assert.match(formProblem(form, { note }), /不成对的 Unicode 代理字符/);
  assert.match(
    formProblem(form, { tags: { ok: "\ud800" } }),
    /tags：ok：文本包含不成对/,
  );
  assert.match(formProblem(form, { tags: { ["\ud800"]: "x" } }), /不可用/);
});
test("project action forms: hp definition.submit (Define Task) takes a list of evidence objects and nullable names; null differs from leaving a field out; the list bounds, required fields, types and unknown fields are checked", () => {
  const form = actionForm(hp.actions["definition.submit"].schema);
  const author = form.properties.author;
  assert.equal(author.properties.tool.nullable, true);
  assert.equal(author.properties.tool.type, "string");
  assert.equal(author.properties.evidenceRefs.type, "array");
  assert.equal(author.properties.evidenceRefs.minItems, 1);
  assert.equal(author.properties.evidenceRefs.maxItems, 16);
  const ref = { commit: hex40, path: "sdd/milestones.md" };
  const ok = {
    taskId: "design-t0",
    commit: hex40,
    author: {
      tool: null,
      model: null,
      vendor: null,
      humanOnly: true,
      evidenceRefs: [ref],
    },
    expectedRuntimeVersion: "12",
  };
  assert.equal(formProblem(form, ok), "");
  const withAuthor = (patch: Record<string, unknown>) => ({
    ...ok,
    author: { ...ok.author, ...patch },
  });
  // Null and a text (even an empty one: the schema sets no minimum) are both values.
  assert.equal(formProblem(form, withAuthor({ tool: "Claude Code" })), "");
  assert.equal(formProblem(form, withAuthor({ tool: "" })), "");
  // Leaving a required nullable field out is not the same as null.
  const { tool: _tool, ...noTool } = ok.author;
  void _tool;
  assert.match(formProblem(form, { ...ok, author: noTool }), /必填/);
  // A non-nullable field refuses null.
  assert.match(formProblem(form, withAuthor({ humanOnly: null })), /空值/);
  assert.match(formProblem(form, { ...ok, commit: null }), /空值/);
  // Types.
  assert.match(formProblem(form, withAuthor({ humanOnly: "yes" })), /是或否/);
  assert.match(formProblem(form, withAuthor({ tool: 7 })), /文本/);
  assert.match(
    formProblem(form, withAuthor({ tool: "x".repeat(257) })),
    /文本/,
  );
  // List bounds and element checks.
  assert.match(formProblem(form, withAuthor({ evidenceRefs: [] })), /1 至 16/);
  assert.match(
    formProblem(form, withAuthor({ evidenceRefs: Array(17).fill(ref) })),
    /1 至 16/,
  );
  assert.equal(
    formProblem(form, withAuthor({ evidenceRefs: Array(16).fill(ref) })),
    "",
  );
  assert.match(
    formProblem(form, withAuthor({ evidenceRefs: [ref, { commit: hex40 }] })),
    /第 2 项：请填写全部必填项/,
  );
  assert.match(
    formProblem(form, withAuthor({ evidenceRefs: [{ ...ref, extra: "x" }] })),
    /未定义字段/,
  );
  assert.match(formProblem(form, withAuthor({ evidenceRefs: ref })), /列表/);
  assert.match(formProblem(form, { ...ok, reviewer: "x" }), /未定义字段/);
  // The commit pattern is shown, not executed: the Runtime rejects a malformed commit.
  assert.equal(form.properties.commit.pattern, "^[0-9a-f]{40}$");
  assert.equal(formProblem(form, { ...ok, commit: "not-a-commit" }), "");
});
test("project action forms: hp maps (definition.decide findings, validate.dispose findings) take named entries within their bounds; empty, repeated or reserved names are refused and never merged", () => {
  const decide = actionForm(hp.actions["definition.decide"].schema);
  const findings = decide.properties.findings;
  assert.equal(findings.type, "object");
  assert.equal(findings.values?.type, "string");
  assert.equal(findings.maxProperties, 64);
  const base = {
    taskId: "design-t0",
    decision: "Authorize & Freeze",
    decisionText: "同意冻结",
    expectedRuntimeVersion: "3",
  };
  assert.equal(formProblem(decide, base), "");
  assert.equal(formProblem(decide, { ...base, findings: {} }), "");
  assert.equal(
    formProblem(decide, { ...base, findings: { "F-1": "已处理" } }),
    "",
  );
  // KB-307: an empty entry is unfilled; an overlong one keeps the length message.
  assert.equal(
    formProblem(decide, { ...base, findings: { "F-1": "" } }),
    "findings：F-1：请填写。",
  );
  assert.match(
    formProblem(decide, { ...base, findings: { "F-1": "x".repeat(4097) } }),
    /F-1：文本长度/,
  );
  assert.match(
    formProblem(decide, {
      ...base,
      findings: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`F-${i}`, "x"]),
      ),
    }),
    /0 至 64/,
  );
  // The map editor hands its rows over while a name is empty or repeated: never sent.
  assert.match(
    formProblem(decide, {
      ...base,
      findings: [
        ["F-1", "a"],
        ["F-1", "b"],
      ],
    }),
    /不能重复/,
  );
  assert.match(
    formProblem(decide, { ...base, findings: { "": "a" } }),
    /不可用/,
  );
  assert.match(
    formProblem(decide, {
      ...base,
      findings: JSON.parse('{"__proto__":"a"}'),
    }),
    /不可用/,
  );
  assert.match(
    formProblem(decide, { ...base, decision: "Freeze" }),
    /现有选项/,
  );
  const dispose = actionForm(hp.actions["validate.dispose"].schema);
  assert.equal(dispose.properties.findings.minProperties, 1);
  assert.match(
    formProblem(dispose, {
      taskId: "t",
      expectedRuntimeVersion: "1",
      decisionText: "x",
      findings: {},
    }),
    /1 至 64/,
  );
  const dispatch = actionForm(hp.actions["validate.dispatch"].schema);
  assert.equal(dispatch.properties.roundExtensions.items?.type, "object");
  assert.equal(
    formProblem(dispatch, {
      taskId: "t",
      expectedRuntimeVersion: "1",
      roundExtensions: [
        { authorized_by: "Mars", at: "2026-09-24", added_rounds: 1, note: "x" },
      ],
    }),
    "",
  );
  assert.match(
    formProblem(dispatch, {
      taskId: "t",
      expectedRuntimeVersion: "1",
      roundExtensions: [
        { authorized_by: "Mars", at: "2026-09-24", added_rounds: 0, note: "x" },
      ],
    }),
    /第 1 项：added_rounds：整数/,
  );
});
test("project action forms: constructs outside the form subset or its limits fail closed with the reason; nothing is dropped silently", () => {
  const refused: [unknown, RegExp][] = [
    [{ type: ["string", "integer"] }, /某类型或空值/],
    [{ type: ["string", "null", "integer"] }, /某类型或空值/],
    [{ type: ["null", "null"] }, /某类型或空值/],
    [{ type: "array", items: [{ type: "string" }] }, /单一的元素格式/],
    [{ type: "array" }, /单一的元素格式/],
    [
      { type: "array", items: { type: "string" }, uniqueItems: true },
      /uniqueItems/,
    ],
    [
      { type: "array", items: { type: "string" }, minItems: 3, maxItems: 2 },
      /下限大于上限/,
    ],
    [{ type: "array", items: { type: "string" }, minItems: 65 }, /64/],
    [{ type: "array", items: { type: "string" }, minItems: -1 }, /项数约束/],
    [{ type: "string", items: { type: "string" } }, /只用于数组/],
    [
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "string" },
      },
      /固定字段与任意字段/,
    ],
    [
      {
        type: "object",
        properties: { a: { type: "string" } },
        minProperties: 1,
      },
      /任意字段对象/,
    ],
    [{ type: "string", minProperties: 1 }, /只用于对象/],
    [{ type: "object", patternProperties: {} }, /patternProperties/],
    [{ type: "object", additionalProperties: { oneOf: [] } }, /oneOf/],
    [{ type: "string", format: "date" }, /format/],
    [{ type: "integer", pattern: "^1$" }, /只用于文本/],
    [{ enum: [null] }, /类型/],
  ];
  for (const [schema, reason] of refused)
    assert.throws(() => actionForm(schema), reason, JSON.stringify(schema));
  // Depth and size limits.
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i <= formLimits.depth; i++)
    deep = { type: "object", properties: { x: deep } };
  assert.throws(() => actionForm(deep), /嵌套/);
  const wide = (n: number) => ({
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`f${i}`, { type: "string" }]),
    ),
  });
  assert.throws(
    () =>
      actionForm({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`g${i}`, wide(30)]),
        ),
      }),
    /复杂度/,
  );
  // A nullable object or list is a value or null; an array without maxItems is capped by the form.
  const nullableList = actionForm({
    type: ["array", "null"],
    items: { type: "integer" },
  });
  assert.equal(formProblem(nullableList, null), "");
  assert.equal(formProblem(nullableList, [1, 2]), "");
  assert.match(
    formProblem(nullableList, Array(formLimits.entries + 1).fill(1)),
    /0 至 64/,
  );
});
test("project action IPC: only the explicit closed request shapes reach the trusted entry", () => {
  const projectId = "00000000-0000-0000-0000-000000000001";
  assert.equal(
    validProjectActionRequest({
      type: "prepare",
      projectId,
      actionId: "task.accept",
      objectRef: "candidate:1",
      expectedRevision: "rev:1",
      candidateRef: "candidate:1",
    }),
    true,
  );
  const pending = {
    type: "prepare",
    projectId,
    actionId: "task.accept",
    objectRef: "candidate:1",
    expectedRevision: "rev:1",
    candidateRef: "candidate:1",
    pending: { itemRef: "pending:1", revision: "rev:1" },
  };
  assert.equal(validProjectActionRequest(pending), true);
  assert.equal(
    validProjectActionRequest({
      ...pending,
      pending: { ...pending.pending, scopeRef: "scope:foreign" },
    }),
    false,
  );
  assert.equal(
    validProjectActionRequest({ type: "list", projectId, actorRef: "forged" }),
    false,
  );
  assert.equal(
    validProjectActionRequest({
      type: "evidence",
      projectId,
      token: "00000000-0000-0000-0000-000000000001",
      index: -1,
    }),
    false,
  );
});
test("project action sync (KB-308): an object awaits its projection while its newest succeeded action's binding is still shown; a moved binding, an unsettled or failed newest action, another scope, another method and Runtime-origin records do not hold it", () => {
  const link = { instanceId: "instance:one", scopeRef: "scope:one" };
  const capability = {
    id: "test",
    version: contractVersion,
    schemaDigest: "a".repeat(64),
    required: true,
  };
  const op = (
    id: string,
    patch: Partial<RuntimeOperation> = {},
  ): RuntimeOperation => ({
    operationId: id,
    installationId: "installation:one",
    instanceId: link.instanceId,
    scopeRef: link.scopeRef,
    method: "runtime.action.invoke",
    origin: "host",
    idempotencyKey: "key:" + id,
    requestDigest: "a".repeat(64),
    request: {
      actionId: "definition.submit",
      objectRef: "definition:tasks",
      expectedRevision: "6",
      candidateRef: null,
      payload: {},
    },
    status: "succeeded",
    resultCode: null,
    reason: "",
    resultRef: null,
    executionRef: null,
    revision: null,
    result: null,
    transport: "answered",
    errorCode: null,
    recovery: null,
    createdAt: "2026-09-25T02:00:00.000Z",
    updatedAt: "2026-09-25T02:00:00.000Z",
    ...patch,
  });
  const action = (
    actionId: string,
    expectedRevision: string,
  ): ProjectionAction => ({
    scopeRef: link.scopeRef,
    actionId,
    objectRef: "definition:tasks",
    capability,
    label: actionId,
    expectedRevision,
    candidateRef: null,
    payloadSchemaDigest: "a".repeat(64),
    enabled: true,
    disabledReason: "",
    disabledCode: null,
    requiresHumanDecision: true,
  });
  const projection = (
    revision: string | null,
    actions: ProjectionAction[],
  ): RuntimeProjection => ({
    objects:
      revision === null
        ? []
        : [
            {
              scopeRef: link.scopeRef,
              objectRef: "definition:tasks",
              revision,
              title: "Task Definition",
              stateLabel: "",
              capability,
              view: { kind: "list", rows: [] },
              evidence: [],
            },
          ],
    actions,
    pendingItems: [],
  });
  const held = [
    {
      objectRef: "definition:tasks",
      operationId: "op:1",
      actionId: "definition.submit",
    },
  ];
  // hp's order: the success first, then the object, then its actions one at a time.
  const stale = projection("6", [
    action("definition.submit", "6"),
    action("definition.decide", "6"),
  ]);
  assert.deepEqual(awaitingProjection(stale, [op("op:1")], link), held);
  const objectOnly = projection("10", [
    action("definition.submit", "10"),
    action("definition.decide", "6"),
  ]);
  assert.deepEqual(awaitingProjection(objectOnly, [op("op:1")], link), held);
  const current = projection("10", [
    action("definition.submit", "10"),
    action("definition.decide", "10"),
  ]);
  assert.deepEqual(awaitingProjection(current, [op("op:1")], link), []);
  // Revisions are compared for equality only: "10" after "6" is not read as an order.
  assert.deepEqual(
    awaitingProjection(projection("5", []), [op("op:1")], link),
    [],
  );
  // The object left the projection: nothing is shown for it.
  assert.deepEqual(
    awaitingProjection(projection(null, []), [op("op:1")], link),
    [],
  );
  // Only a success holds the object.
  for (const status of [
    "accepted",
    "running",
    "failed",
    "cancelled",
    "unknown",
  ] as const)
    assert.deepEqual(
      awaitingProjection(stale, [op("op:1", { status })], link),
      [],
    );
  // The newest action on the object decides, by the Host's own record time, not by list order.
  const later = { createdAt: "2026-09-25T02:00:05.000Z" };
  for (const list of [
    [op("op:2", { status: "failed", ...later }), op("op:1")],
    [op("op:1"), op("op:2", { status: "failed", ...later })],
  ])
    assert.deepEqual(awaitingProjection(stale, list, link), []);
  assert.deepEqual(
    awaitingProjection(stale, [op("op:1"), op("op:2", later)], link),
    [{ ...held[0], operationId: "op:2" }],
  );
  // Other scopes, instances, methods and Runtime-origin records are not this object's actions.
  for (const patch of [
    { scopeRef: "scope:other" },
    { instanceId: "instance:other" },
    { method: "runtime.operation.cancel" },
    { origin: "runtime" as const },
    { request: null },
  ])
    assert.deepEqual(awaitingProjection(stale, [op("op:1", patch)], link), []);
});
