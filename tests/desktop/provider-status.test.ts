import { test } from "node:test";
import assert from "node:assert/strict";
import { providerStatus } from "../../src/renderer/provider-status";
import type {
  Connection,
  ConnectionCheck,
  RunEvent,
} from "../../src/shared/protocol";
import type { CodexStatus } from "../../src/shared/codex";
function connection(): Connection {
  return {
    id: "connection",
    name: "test",
    provider: "custom",
    baseUrl: "https://synthetic.invalid",
    model: "first",
    enabled: true,
    secretRef: "synthetic-reference",
    modelList: { state: "unknown" },
    lastTest: null,
    lastModelList: null,
    lastImageProbe: null,
    imageInput: "unknown",
    imageInputCheckedAt: null,
    contextChars: null,
    revision: 1,
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    models: ["first", "second"].map((model) => ({
      model,
      enabled: true,
      lastTest: null,
      lastProbe: null,
      imageInput: "unknown",
      imageInputCheckedAt: null,
      contextChars: null,
      effort: null,
    })),
  };
}
function check(errorClass: ConnectionCheck["errorClass"]): ConnectionCheck {
  return {
    executionId: "test",
    state: errorClass ? "failed" : "completed",
    errorClass,
    errorMessage: errorClass ? "synthetic error" : null,
    createdAt: "2026-09-08T01:00:00Z",
    endedAt: "2026-09-08T01:00:01Z",
  };
}
test("provider status distinguishes disabled, incomplete, connection failures and later recovery", () => {
  const c = connection();
  assert.equal(providerStatus(undefined, []).state, "inactive");
  assert.equal(providerStatus(c, [], false).state, "inactive");
  assert.equal(providerStatus({ ...c, secretRef: null }, []).state, "inactive");
  assert.equal(providerStatus({ ...c, models: [] }, []).state, "inactive");
  assert.equal(providerStatus(c, [], true, false).state, "error");
  c.lastTest = check("auth");
  assert.equal(providerStatus(c, []).state, "error");
  const event = {
    seq: 2,
    id: "event",
    executionId: "next",
    kind: "completed",
    at: "2026-09-08T02:00:00Z",
    connection: { connectionId: c.id, revision: c.revision, model: "first" },
    payload: {},
  } as RunEvent;
  assert.equal(providerStatus(c, [event]).state, "available");
  event.connection!.revision = 0;
  assert.equal(providerStatus(c, [event]).state, "error");
  c.lastTest = check(null);
  assert.equal(providerStatus(c, []).state, "available");
});
test("provider status keeps other models available after a refusal and ignores stopped or image-only failures", () => {
  const c = connection();
  c.models[0].lastTest = check("provider");
  assert.equal(providerStatus(c, []).state, "available");
  c.models[1].lastTest = check("model");
  assert.equal(providerStatus(c, []).state, "error");
  c.models[1].lastTest = { ...check(null), state: "stopped" };
  c.lastImageProbe = check("unsupported");
  assert.equal(providerStatus(c, []).state, "available");
  c.models[1].lastTest = check("permission");
  assert.equal(providerStatus(c, []).state, "available");
});
test("provider status uses the same installation and authentication rules for both local providers", () => {
  for (const provider of ["codex", "claude"] as const) {
    const c = connection();
    c.provider = provider;
    c.secretRef = null;
    // This fixture models the already approved, non-secret origin on each model.
    for (const m of c.models)
      m[provider] = {
        provider: "synthetic",
        endpoint: "https://synthetic.invalid",
        authentication: "apiKey",
        identity: "a".repeat(64),
        fingerprint: "b".repeat(64),
        instructions: [],
        configurationInstructions: [],
      };
    const native: CodexStatus = {
      installation: {
        path: "/synthetic/cli",
        resolvedPath: "/synthetic/cli",
        version: "999",
      },
      detection: "found",
      authentication: "apiKey",
      protocol: "available",
      model: "first",
      provider: "test",
      models: ["first", "second"],
      efforts: {},
      configurationSources: [],
      restriction: "verified",
      invocation: "untested",
      checkedAt: "2026-09-08",
      message: "synthetic diagnostic",
    };
    assert.equal(providerStatus(c, [], true, true).state, "inactive");
    assert.equal(providerStatus(c, [], true, true, native).state, "available");
    for (const change of [
      { detection: "missing" },
      { authentication: "signedOut" },
      { restriction: "conflict" },
      { protocol: "unavailable" },
      { models: [] },
    ] as Partial<CodexStatus>[]) {
      assert.equal(
        providerStatus(c, [], true, true, { ...native, ...change }).state,
        "error",
      );
    }
    assert.equal(
      providerStatus(c, [], false, true, "detection failed").state,
      "inactive",
    );
  }
});
