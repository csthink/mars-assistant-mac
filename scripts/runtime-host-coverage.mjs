// Runtime Host coverage report (feature-t29 S-05): reads the Host's protocol transcripts
// (every frame in both directions, as src/main/runtime-supervisor.ts records them), validates
// each frame against the current Contract 0.1.0 schema through methods.json, counts request,
// result and error frames per method and every data.code, and compares the counts with the
// required set: the 28 methods of the method directory, the runtime.event notification and the
// 15 error codes observed in the frozen fixtures (fixtures/coverage.md sections 3 and 4).
// INVALID_SOURCE stays listed separately as unproven; it is never counted as required.
// Usage: node scripts/runtime-host-coverage.mjs --transcripts <dir> [--out <report.json>]
// Exit code 1 when any required item is missing or any frame fails validation. No network, no application.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = join(repo, "contract/0.1.0");
const load = (name) =>
  JSON.parse(readFileSync(join(contractDir, name), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const transcriptsDir = option("--transcripts");
const outPath = option("--out");
if (!transcriptsDir) {
  console.error(
    "usage: node scripts/runtime-host-coverage.mjs --transcripts <dir> [--out <report.json>]",
  );
  process.exit(2);
}

/** The 15 error codes with frozen observations; INVALID_SOURCE is reported apart (fixtures/coverage.md section 4). */
const requiredCodes = [
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_CAPABILITY",
  "PERMISSION_DENIED",
  "PERMISSION_REVOKED",
  "PRECONDITION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "WRITER_CONFLICT",
  "RESOURCE_LIMIT",
  "BUSY",
  "RESYNC_REQUIRED",
  "NOT_FOUND",
  "RESULT_UNKNOWN",
  "EXECUTION_FAILED",
  "CANCELLED",
  "INTEGRITY_MISMATCH",
];
const unprovenCodes = ["INVALID_SOURCE"];

const schema = load("schema.json");
const methods = load("methods.json").methods;
const manifestDigest = sha(
  readFileSync(join(contractDir, "contract-manifest.json")),
);
const ajv = new Ajv({ allErrors: true, jsonPointers: true });
ajv.addSchema(schema);
const compiled = Object.fromEntries(
  Object.keys(schema.definitions).map((name) => [
    name,
    ajv.compile({ $ref: schema.$id + "#/definitions/" + name }),
  ]),
);
const describe = (validate) =>
  JSON.stringify(validate.errors ?? []).slice(0, 300);

const counted = Object.fromEntries(
  Object.keys(methods).map((name) => [
    name,
    { request: 0, result: 0, error: 0 },
  ]),
);
const codes = {};
const files = [];
const problems = [];
let notifications = 0;
let markers = 0;
let parseErrorReplies = 0;
let digestFrames = 0;
let digestMatches = 0;
const versions = new Set();
const digests = new Set();

for (const name of readdirSync(transcriptsDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()) {
  const path = join(transcriptsDir, name);
  const bytes = readFileSync(path);
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  const idToMethod = new Map();
  const local = {
    name,
    lines: lines.length,
    requests: 0,
    notifications: 0,
    markers: 0,
    problems: 0,
    sha256: sha(bytes),
  };
  for (const [n, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      problems.push(`${name}:${n + 1}: transcript line is not JSON`);
      local.problems += 1;
      continue;
    }
    const { direction, value } = entry;
    // Host notes (spawn errors, closed connections) and refused frames are counted, never validated.
    if (
      direction === "host-note" ||
      !value ||
      value.rejected ||
      value.dropped ||
      value.raw !== undefined
    ) {
      markers += 1;
      local.markers += 1;
      continue;
    }
    if ("method" in value && !("id" in value)) {
      notifications += 1;
      local.notifications += 1;
      if (direction !== "runtime-to-host" || !compiled.Notification(value)) {
        problems.push(
          `${name}:${n + 1}: Notification ${describe(compiled.Notification)}`,
        );
        local.problems += 1;
      }
      continue;
    }
    if ("method" in value) {
      const method = methods[value.method];
      idToMethod.set(value.id, value.method);
      if (!method) {
        problems.push(`${name}:${n + 1}: unknown method ${value.method}`);
        local.problems += 1;
        continue;
      }
      counted[value.method].request += 1;
      local.requests += 1;
      if (method.direction !== direction) {
        problems.push(
          `${name}:${n + 1}: ${value.method} sent in the wrong direction`,
        );
        local.problems += 1;
      }
      if (!compiled.Request(value)) {
        problems.push(
          `${name}:${n + 1}: Request ${describe(compiled.Request)}`,
        );
        local.problems += 1;
      }
      if (!compiled[method.params](value.params)) {
        problems.push(
          `${name}:${n + 1}: params ${value.method} ${describe(compiled[method.params])}`,
        );
        local.problems += 1;
      }
      if (value.method === "runtime.initialize")
        for (const item of value.params.protocols ?? []) {
          versions.add(item.version);
          digests.add(item.contractDigest);
        }
      if (value.params && "requestDigest" in value.params) {
        digestFrames += 1;
        const {
          context: _context,
          requestDigest: hash,
          ...body
        } = value.params;
        void _context;
        if (sha(canonical({ method: value.method, ...body })) === hash)
          digestMatches += 1;
        else {
          problems.push(
            `${name}:${n + 1}: requestDigest mismatch for ${value.method}`,
          );
          local.problems += 1;
        }
      }
    } else if ("error" in value) {
      const method = idToMethod.get(value.id);
      if (!method && [-32700, -32600].includes(value.error?.code)) {
        // standard JSON-RPC reply to a frame refused before dispatch (C-01)
        parseErrorReplies += 1;
        continue;
      }
      if (method) counted[method].error += 1;
      else {
        problems.push(`${name}:${n + 1}: orphan error`);
        local.problems += 1;
      }
      if (!compiled.Failure(value)) {
        problems.push(
          `${name}:${n + 1}: Failure ${describe(compiled.Failure)}`,
        );
        local.problems += 1;
      }
      const code = value.error?.data?.code;
      if (typeof code === "string") codes[code] = (codes[code] ?? 0) + 1;
    } else {
      const method = idToMethod.get(value.id);
      if (!method) {
        problems.push(`${name}:${n + 1}: orphan result`);
        local.problems += 1;
        continue;
      }
      counted[method].result += 1;
      if (!compiled.Success(value)) {
        problems.push(
          `${name}:${n + 1}: Success ${describe(compiled.Success)}`,
        );
        local.problems += 1;
      } else if (!compiled[methods[method].result](value.result)) {
        problems.push(
          `${name}:${n + 1}: result ${method} ${describe(compiled[methods[method].result])}`,
        );
        local.problems += 1;
      }
    }
  }
  files.push(local);
}

const missingMethods = Object.keys(methods).filter(
  (name) =>
    counted[name].request === 0 ||
    counted[name].result + counted[name].error === 0,
);
const missingCodes = requiredCodes.filter((code) => !(codes[code] > 0));
const unexpectedCodes = Object.keys(codes).filter(
  (code) => !requiredCodes.includes(code) && !unprovenCodes.includes(code),
);
const identity = {
  protocolVersions: [...versions],
  contractDigests: [...digests],
  currentManifestDigest: manifestDigest,
  identityMatches:
    digests.size === 1 &&
    digests.has(manifestDigest) &&
    versions.size === 1 &&
    versions.has("0.1.0-draft.5"),
};
const passed =
  files.length > 0 &&
  problems.length === 0 &&
  missingMethods.length === 0 &&
  notifications > 0 &&
  missingCodes.length === 0 &&
  unexpectedCodes.length === 0 &&
  identity.identityMatches &&
  digestFrames > 0 &&
  digestFrames === digestMatches;
const report = {
  schema_version: 1,
  generatedBy: "scripts/runtime-host-coverage.mjs",
  schema: schema.$id,
  transcripts: files,
  frames: {
    methods: counted,
    notifications: { "runtime.event": notifications },
    markers,
    parseErrorReplies,
    requestDigests: { frames: digestFrames, matches: digestMatches },
  },
  codes: {
    observed: codes,
    required: Object.fromEntries(requiredCodes.map((c) => [c, codes[c] ?? 0])),
    missing: missingCodes,
    unexpected: unexpectedCodes,
    unproven: Object.fromEntries(unprovenCodes.map((c) => [c, codes[c] ?? 0])),
  },
  methods: {
    required: Object.keys(methods).length,
    covered: Object.keys(methods).length - missingMethods.length,
    missing: missingMethods,
  },
  identity,
  problems: problems.slice(0, 200),
  problemCount: problems.length,
  passed,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (outPath) writeFileSync(outPath, text);
else process.stdout.write(text);
if (outPath)
  console.log(
    `${passed ? "PASS" : "FAIL"}: ${report.methods.covered}/${report.methods.required} methods, runtime.event ${notifications}, codes ${requiredCodes.length - missingCodes.length}/${requiredCodes.length}, problems ${problems.length}, transcripts ${files.length}`,
  );
process.exit(passed ? 0 : 1);
