import { execFileSync } from "node:child_process";

/**
 * Runs the system git once before tests that reach it through the product. The product calls
 * /usr/bin/git with a fixed environment (PATH=/usr/bin:/bin only) and a 3 s limit per call. On
 * macOS /usr/bin/git is the developer tools entry point that locates and starts the selected
 * toolchain's git; on a fresh CI runner the first call of a job can take longer than that limit,
 * which the product reports as a folder it cannot check. Warming it here keeps the first test
 * from paying the cold start; product behavior is unchanged. The environment carries only PATH,
 * like the product's, so the warm-up takes the same lookup; the 60 s limit only keeps a broken
 * toolchain from hanging the run.
 */
export function warmSystemGit() {
  execFileSync("/usr/bin/git", ["--version"], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: "ignore",
    timeout: 60_000,
  });
}
