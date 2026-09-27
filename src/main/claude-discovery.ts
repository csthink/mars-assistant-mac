import { execFile } from "node:child_process";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { ClaudeInstallation } from "../shared/claude";

/** Keep transport credentials inside the CLI; never use this environment for MCP tools. */
export function claudeEnvironment(
  source: NodeJS.ProcessEnv,
  binDir?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "PATH",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ]) {
    if (source[key]) result[key] = source[key];
  }
  result.PATH = [
    ...new Set([
      ...(binDir ? [binDir] : []),
      ...(result.PATH ?? "").split(delimiter).filter(isAbsolute),
      "/usr/bin",
      "/bin",
    ]),
  ].join(delimiter);
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  result.DISABLE_TELEMETRY = "1";
  result.DISABLE_ERROR_REPORTING = "1";
  return result;
}
export async function claudeCandidates(
  home = homedir(),
  environment = process.env,
): Promise<string[]> {
  const paths = (environment.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((p) => join(p, "claude"));
  for (const root of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local/bin"),
    join(home, "bin"),
    join(home, ".npm-global/bin"),
    join(home, ".volta/bin"),
    join(home, "Library/pnpm"),
  ])
    paths.push(join(root, "claude"));
  for (const root of [
    join(home, ".nvm/versions/node"),
    join(home, ".local/share/fnm/node-versions"),
    join(home, "Library/Application Support/fnm/node-versions"),
    join(home, ".asdf/installs/nodejs"),
    join(home, ".local/share/mise/installs/node"),
  ]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries
      .filter((e) => e.isDirectory())
      .sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      )
      .slice(0, 16))
      paths.push(
        join(
          root,
          entry.name,
          root.includes("fnm/") ? "installation/bin/claude" : "bin/claude",
        ),
      );
  }
  return [...new Set(paths)].slice(0, 128);
}
export function claudeCommand(
  binary: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        env: claudeEnvironment(environment, dirname(binary)),
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout ?? 5000,
        killSignal: "SIGKILL",
        maxBuffer: options.maxBuffer ?? 256 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error && (typeof error.code !== "number" || error.killed))
          return reject(new Error("Claude Code command failed"));
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout,
        });
      },
    );
  });
}
export async function discoverClaude(
  options: {
    home?: string;
    environment?: NodeJS.ProcessEnv;
    candidates?: string[];
    signal?: AbortSignal;
  } = {},
): Promise<ClaudeInstallation | null> {
  const env = options.environment ?? process.env;
  const candidates =
    options.candidates ??
    (await claudeCandidates(options.home ?? env.HOME, env));
  const seen = new Set<string>(),
    deadline = Date.now() + 15000;
  for (const path of candidates.slice(0, 128)) {
    if (options.signal?.aborted)
      throw new Error("Claude Code detection cancelled");
    if (!isAbsolute(path) || Date.now() >= deadline) continue;
    try {
      const resolvedPath = await realpath(path);
      if (seen.has(resolvedPath)) continue;
      seen.add(resolvedPath);
      if (!(await stat(resolvedPath)).isFile()) continue;
      await access(resolvedPath, constants.X_OK);
      const reply = await claudeCommand(
        resolvedPath,
        ["--version"],
        claudeEnvironment(env, dirname(path)),
        {
          signal: options.signal,
          // Same per-candidate budget as Codex discovery: a slow cold start must not skip a real install (KB-228).
          timeout: Math.min(5000, deadline - Date.now()),
          maxBuffer: 16384,
        },
      );
      const version = /^(\S{1,80}) \(Claude Code\)\s*$/.exec(
        reply.stdout.trim(),
      )?.[1];
      if (reply.code === 0 && version && !/[\x00-\x1f\x7f]/.test(version))
        return { path, resolvedPath, version };
    } catch {
      /* Continue past stale or invalid installations, never evaluate a login shell. */
    }
  }
  if (options.signal?.aborted)
    throw new Error("Claude Code detection cancelled");
  return null;
}
