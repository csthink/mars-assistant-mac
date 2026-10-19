import { test, expect } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { replayFixture, score } from "./widget-eval/evaluate";
import { liveAuthorization, runLive } from "./widget-eval/live";
import { loadRequirementSet, type Fixture } from "./widget-eval/model";
import { renderCandidates } from "./widget-eval/render";
import { canonicalJson, summary } from "./widget-eval/score";

/**
 * Live widget generation evaluation. Runs only with CSTHINK_REAL_CALLS_AUTHORIZED=1 and an
 * explicit absolute authorization file in CSTHINK_WIDGET_EVAL_AUTHORIZATION naming the
 * providers, models, requirements, repeats, wait limit and the exact call budget; without them
 * it stops as NOT RUN before any request. Keys come only from the environment variables the
 * authorization names. The evidence directory receives the call ledger, one recorded fixture
 * per attempt, result.json, summary.md and the replay check of the recordings.
 */
test("real widget evaluation: authorized providers over the standard requirements, each attempt recorded as a replayable fixture", async () => {
  const path = process.env.CSTHINK_WIDGET_EVAL_AUTHORIZATION;
  if (!path || !isAbsolute(path) || !existsSync(path))
    throw new Error(
      "NOT RUN: CSTHINK_WIDGET_EVAL_AUTHORIZATION must name an absolute authorization file",
    );
  const { set, sha256 } = loadRequirementSet();
  const auth = liveAuthorization(
    JSON.parse(readFileSync(path, "utf8")),
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED,
    process.env,
    set,
  );
  test.setTimeout(
    auth.maxCalls * (auth.waitMinutes * 60_000 + 60_000) + 600_000,
  );
  if (existsSync(auth.evidence) && readdirSync(auth.evidence).length)
    throw new Error(
      "NOT RUN: the evidence directory must be new or empty; earlier results are never overwritten",
    );
  mkdirSync(join(auth.evidence, "fixtures"), { recursive: true, mode: 0o700 });
  const ledger = (sent: number) =>
    writeFileSync(
      join(auth.evidence, "calls.json"),
      JSON.stringify(
        { maxCalls: auth.maxCalls, sent, automaticRetries: 0 },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  ledger(0);
  const fixtures: Fixture[] = [];
  const { executed, skipped } = await runLive(auth, set, process.env, {
    beforeCall: ledger,
    onAttempt: (fixture) => {
      fixtures.push(fixture);
      writeFileSync(
        join(auth.evidence, "fixtures", `${fixture.id}.json`),
        canonicalJson(fixture),
        { mode: 0o600 },
      );
    },
  });
  const renders = await renderCandidates(
    executed
      .filter((e) => e.build && e.packageSource)
      .map((e) => ({
        id: e.fixture.id,
        requirement: e.requirement,
        packageSource: e.packageSource!,
        digest: e.build!.digest,
      })),
  );
  const result = score({
    mode: "live",
    set,
    setSha256: sha256,
    executed,
    renders,
  });
  writeFileSync(join(auth.evidence, "skipped.json"), canonicalJson(skipped));
  writeFileSync(join(auth.evidence, "result.json"), canonicalJson(result));
  writeFileSync(join(auth.evidence, "summary.md"), summary(result));
  // Replay fidelity: every recorded response replays to the live product judgement.
  const checks = [];
  for (const live of executed) {
    if (live.fixture.recorded.outcome.kind !== "response") continue;
    const replayed = await replayFixture(set, live.fixture);
    checks.push({
      id: live.fixture.id,
      live: live.product,
      replay: replayed.product,
      same: JSON.stringify(live.product) === JSON.stringify(replayed.product),
    });
  }
  writeFileSync(
    join(auth.evidence, "replay-check.json"),
    canonicalJson(checks),
  );
  expect(fixtures.length + skipped.length).toBe(auth.maxCalls);
  expect(checks.filter((c) => !c.same).map((c) => c.id)).toEqual([]);
});
test.use({ trace: "off", screenshot: "off" });
