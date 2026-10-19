import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { replayAll, score } from "./widget-eval/evaluate";
import { syntheticFixtures } from "./widget-eval/fixtures";
import { loadRequirementSet } from "./widget-eval/model";
import { renderCandidates } from "./widget-eval/render";
import { canonicalJson, summary } from "./widget-eval/score";

/**
 * Full replay of the synthetic fixtures, rendering included: every reference and variant widget
 * must load without errors and satisfy every rule of its requirement, and every negative fixture
 * must fail at its declared stage. CSTHINK_WIDGET_EVAL_OUT (an absolute, new or empty directory) keeps the
 * result and summary of the run.
 */
test("widget evaluation: replayed reference widgets render and satisfy every rule while each negative fixture fails at its declared stage", async () => {
  test.setTimeout(300_000);
  const out = process.env.CSTHINK_WIDGET_EVAL_OUT;
  if (out && (!isAbsolute(out) || (existsSync(out) && readdirSync(out).length)))
    throw new Error(
      "CSTHINK_WIDGET_EVAL_OUT must be an absolute new or empty directory",
    );
  const { set, sha256 } = loadRequirementSet();
  const synthetic = syntheticFixtures();
  const executed = await replayAll(
    set,
    synthetic.map((s) => s.fixture),
  );
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
    mode: "replay",
    set,
    setSha256: sha256,
    executed,
    renders,
  });
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "result.json"), canonicalJson(result));
    writeFileSync(join(out, "summary.md"), summary(result));
  }
  const outcomes = synthetic.map(({ fixture, expect: wanted }) => {
    const attempt = result.attempts.find((a) => a.id === fixture.id)!;
    const failure = attempt.judgement.failure;
    return {
      id: fixture.id,
      stage: failure?.stage ?? null,
      failure: failure?.class ?? null,
      ...(wanted.failedRules
        ? {
            failedRules: [
              ...attempt.judgement.staticRules,
              ...(attempt.judgement.renderRules ?? []),
            ]
              .filter((r) => !r.pass)
              .map((r) => r.id),
          }
        : {}),
      detail: failure?.detail ?? null,
    };
  });
  expect(
    outcomes.map((o) => ({ ...o, detail: undefined })),
    JSON.stringify(outcomes, null, 1),
  ).toEqual(
    synthetic.map(({ fixture, expect: wanted }) => ({
      id: fixture.id,
      stage: wanted.stage,
      failure: wanted.failure,
      ...(wanted.failedRules ? { failedRules: wanted.failedRules } : {}),
    })),
  );
  // Rendering ran for every compiled attempt: the funnel reports the rendered stage.
  expect(result.render).toBe("run");
  for (const group of result.groups)
    expect(group.funnel.rendered).toBeDefined();
});
test.use({ trace: "off" });
