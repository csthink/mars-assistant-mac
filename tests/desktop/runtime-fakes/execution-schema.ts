/** Frozen Contract assertions for offline execution tests. No product schema changes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

const schemaPath = "contract/0.1.0/schema.json";
const schemaBytes = readFileSync(schemaPath);
const schema = JSON.parse(schemaBytes.toString());
const ajv = new Ajv({ allErrors: true, jsonPointers: true });
ajv.addSchema(schema);
const validate = ajv.compile({
  $ref: schema.$id + "#/definitions/HostExecutionGetResult",
});
export function assertExecutionView(value: unknown) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}
/** Validate the actual captured RPC results, without projecting or repairing them in the test. */
export function auditExecutionQueries(directory: string, output: string) {
  const results: {
    file: string;
    id: string;
    state: string;
    executionRef: string;
  }[] = [];
  const protocols = [];
  for (const file of readdirSync(directory)) {
    const bytes = readFileSync(join(directory, file));
    const frames = bytes
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    protocols.push({
      file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (const request of frames.filter(
      (f) =>
        f.direction === "runtime-to-host" &&
        f.value.method === "host.execution.get",
    )) {
      const response = frames.find(
        (f) =>
          f.direction === "host-to-runtime" &&
          f.value.id === request.value.id &&
          (f.value.result || f.value.error),
      );
      assert.ok(
        response?.value.result,
        "query must return a result: " + request.value.id,
      );
      const value = response.value.result;
      assertExecutionView(value);
      assert.deepEqual(value.context, request.value.params.context);
      assert.equal(value.executionRef, request.value.params.executionRef);
      assert.equal(value.scopeRef, request.value.params.scopeRef);
      results.push({
        file,
        id: request.value.id,
        state: value.state,
        executionRef: value.executionRef,
      });
    }
  }
  assert.ok(results.length > 0, "actual query frames required");
  writeFileSync(
    output,
    JSON.stringify(
      {
        schema: "assistant-kb247-wire-audit/v1",
        result: "PASS",
        contractSchema: {
          path: schemaPath,
          bytes: schemaBytes.length,
          sha256: createHash("sha256").update(schemaBytes).digest("hex"),
        },
        protocols,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
