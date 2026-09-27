/** Compiles a fake Runtime entry into one CommonJS file that runs under the Host's node launcher. */
import { buildSync } from "esbuild";
import { resolve } from "node:path";

const cache = new Map<string, Buffer>();
export function buildFake(entry: string): Buffer {
  const path = resolve(entry);
  const cached = cache.get(path);
  if (cached) return cached;
  const result = buildSync({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node24",
    logLevel: "silent",
  });
  const bytes = Buffer.from(result.outputFiles[0].contents);
  cache.set(path, bytes);
  return bytes;
}
export const listFakeEntry = resolve(
  "tests/desktop/runtime-fakes/list-fake.ts",
);
/** The test execution port, built the same way so the integration test can load it inside the Electron main process. */
export const fakeAgentPortEntry = resolve(
  "tests/desktop/runtime-fakes/fake-agent-port.ts",
);
/** Python members of the graph-domain bundle live next to this file; fake_agent.py is the port's target program. */
export const graphFakeDir = resolve("tests/desktop/runtime-fakes");
export const fakeAgentScript = resolve(
  "tests/desktop/runtime-fakes/fake_agent.py",
);
/** The fixture adapter for the embedded execution port (feature-t30), loaded inside the Electron main process by integration tests. */
export const fixtureAdapterEntry = resolve(
  "tests/desktop/runtime-fakes/fixture-adapter.ts",
);
