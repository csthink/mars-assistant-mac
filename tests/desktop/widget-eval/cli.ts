/**
 * Replay evaluation without a model call or a client window:
 *   npm run eval:widget -- --out <new directory> [--fixtures <directory of recorded fixtures>]
 * Without --fixtures it replays the synthetic fixtures. Rendering needs the client and runs in
 * tests/desktop/widget-eval.spec.ts; here satisfaction covers static rules only.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { replayAll, score } from "./evaluate";
import { syntheticFixtures } from "./fixtures";
import { loadFixtures, loadRequirementSet } from "./model";
import { canonicalJson, summary } from "./score";

function argument(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
async function main() {
  const out = argument("--out");
  if (!out) throw new Error("--out <new directory> is required");
  const target = resolve(out);
  if (existsSync(target) && readdirSync(target).length)
    throw new Error("the output directory must be new or empty");
  const fixturesDir = argument("--fixtures");
  const fixtures = fixturesDir
    ? loadFixtures(resolve(fixturesDir))
    : syntheticFixtures().map((s) => s.fixture);
  const { set, sha256 } = loadRequirementSet();
  const executed = await replayAll(set, fixtures);
  const result = score({
    mode: "replay",
    set,
    setSha256: sha256,
    executed,
    renders: null,
  });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "result.json"), canonicalJson(result));
  writeFileSync(join(target, "summary.md"), summary(result));
  console.log(`wrote ${result.attempts.length} attempts to ${target}`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
