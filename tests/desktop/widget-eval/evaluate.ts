/**
 * Evaluation driver shared by replay and live runs: execute every attempt through the product
 * path, optionally render the compiled candidates, then score. Replay takes durations from the
 * fixtures, so its result carries no measurement of this machine.
 */
import type { BuiltWidget } from "../../../src/shared/widget";
import {
  executeAttempt,
  inspectResponse,
  responseServer,
  type Execution,
  type ResponseView,
} from "./execute";
import type { Fixture, Requirement, RequirementSet } from "./model";
import {
  buildResult,
  judgeAttempt,
  judgeExecution,
  type AttemptRecord,
  type RenderObservation,
} from "./score";

export interface Executed {
  fixture: Fixture;
  requirement: Requirement;
  execution: Execution | null;
  view: ResponseView | null;
  product: ReturnType<typeof judgeExecution>;
  build: BuiltWidget | null;
  packageSource: string | null;
}

function requirementOf(set: RequirementSet, fixture: Fixture) {
  const requirement = set.requirements.find(
    (r) => r.id === fixture.requirement,
  );
  if (!requirement)
    throw new Error(`fixture ${fixture.id} names unknown requirement`);
  return requirement;
}

/** Replays one fixture's response through the product path; exactly one request is allowed. */
export async function replayFixture(
  set: RequirementSet,
  fixture: Fixture,
): Promise<Executed> {
  const requirement = requirementOf(set, fixture);
  let execution: Execution | null = null;
  let view: ResponseView | null = null;
  if (fixture.recorded.outcome.kind === "response" && fixture.response) {
    const server = await responseServer(fixture.response);
    try {
      execution = await executeAttempt({
        prompt: requirement.prompt,
        endpoint: {
          baseUrl: server.baseUrl,
          model: fixture.model,
          apiKey: "replay",
        },
      });
      if (server.requests !== 1)
        throw new Error(
          `fixture ${fixture.id}: the executor sent ${server.requests} requests`,
        );
    } finally {
      await server.close();
    }
    view = await inspectResponse(fixture.response);
  }
  return scoreExecution(requirement, fixture, execution, view);
}

export function scoreExecution(
  requirement: Requirement,
  fixture: Fixture,
  execution: Execution | null,
  view: ResponseView | null,
): Executed {
  const product = judgeExecution(fixture.recorded.outcome, execution, view);
  const compiled = execution?.compile?.ok ? execution.compile : null;
  return {
    fixture,
    requirement,
    execution,
    view,
    product,
    build: product.stages.compiled && compiled ? compiled.build : null,
    packageSource:
      product.stages.compiled && execution ? execution.packageSource : null,
  };
}

export function attemptRecord(
  executed: Executed,
  render: RenderObservation | null,
): AttemptRecord {
  const { fixture, requirement } = executed;
  return {
    id: fixture.id,
    requirement: requirement.id,
    language: requirement.language,
    category: requirement.category,
    difficulty: requirement.difficulty,
    source: fixture.source,
    provider: fixture.provider,
    model: fixture.model,
    repeat: fixture.repeat,
    durationMs: fixture.recorded.durationMs,
    firstByteMs: fixture.recorded.firstByteMs,
    usage: fixture.recorded.usage,
    candidateDigest: executed.build?.digest ?? null,
    judgement: judgeAttempt(
      requirement,
      executed.product,
      executed.build,
      render,
    ),
  };
}

export async function replayAll(set: RequirementSet, fixtures: Fixture[]) {
  const ids = new Set<string>();
  const executed: Executed[] = [];
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture ${fixture.id}`);
    ids.add(fixture.id);
    executed.push(await replayFixture(set, fixture));
  }
  return executed;
}

export function score(input: {
  mode: "replay" | "live";
  set: RequirementSet;
  setSha256: string;
  executed: Executed[];
  renders: {
    observations: Map<string, RenderObservation>;
    baseline: string[];
  } | null;
}) {
  const observations = input.renders?.observations ?? null;
  return buildResult({
    mode: input.mode,
    set: input.set,
    setSha256: input.setSha256,
    renderBaseline: input.renders?.baseline ?? null,
    attempts: input.executed.map((e) =>
      attemptRecord(
        e,
        observations && e.build
          ? (observations.get(e.fixture.id) ??
              (() => {
                throw new Error(`no render observation for ${e.fixture.id}`);
              })())
          : null,
      ),
    ),
  });
}
