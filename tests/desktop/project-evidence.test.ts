import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceAt,
  validProjectEvidenceRequest,
} from "../../src/shared/project-evidence";
import type { ProjectionObject } from "../../src/shared/runtime-host";
test("project evidence: closed selectors cannot supply arbitrary paths or evidence references", () => {
  const base = {
    projectId: "00000000-0000-0000-0000-000000000001",
    objectRef: "doc:1",
    revision: "rev:1",
    source: { kind: "document" },
  };
  assert.equal(validProjectEvidenceRequest(base), true);
  for (const input of [
    { ...base, path: "/private/secret" },
    { ...base, evidence: {} },
    { ...base, objectRef: "../../private/secret" },
    { ...base, source: { kind: "evidence", index: 32 } },
    { ...base, source: { kind: "document", index: 0 } },
    { ...base, source: { kind: "before", url: "file:///secret" } },
  ])
    assert.equal(validProjectEvidenceRequest(input), false);
  const pending = {
    projectId: base.projectId,
    itemRef: "pending:1",
    revision: "rev:1",
    index: 0,
  };
  assert.equal(validProjectEvidenceRequest(pending), true);
  for (const value of [
    { ...pending, index: 32 },
    { ...pending, evidence: {} },
    { ...pending, itemRef: "../../outside" },
  ])
    assert.equal(validProjectEvidenceRequest(value), false);
  const object = {
    view: { kind: "list", rows: [] },
    evidence: [],
  } as unknown as ProjectionObject;
  assert.throws(
    () => evidenceAt(object, { kind: "document" }),
    /没有这个证据入口/,
  );
  assert.throws(
    () => evidenceAt(object, { kind: "evidence", index: 0 }),
    /没有这个证据入口/,
  );
});
