import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Compiles the native process identity helper (src/main/codex-process.c) for a test and
 * runs it once synchronously: macOS assesses a newly created executable on its first
 * launch (measured 445 to 827 ms idle, over the helper's invocation budget under the full
 * suite's load, KB-233), so the first call is paid here rather than inside a test's timed
 * observation.
 */
export function buildProcessHelper(output: string) {
  execFileSync("/usr/bin/clang", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    resolve("src/main/codex-process.c"),
    "-o",
    output,
  ]);
  execFileSync(output, ["inspect", String(process.pid)], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  return output;
}
