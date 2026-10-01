import { execFile } from "node:child_process";
import { access, realpath, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { CodexInstallation } from "../shared/codex";

/** Never inherit arbitrary application secrets or evaluate interactive shell startup files. */
export function codexEnvironment(
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
    "CODEX_HOME",
    "PATH",
  ]) {
    if (source[key]) result[key] = source[key];
  }
  const paths = (result.PATH ?? "").split(delimiter).filter(isAbsolute);
  result.PATH = [
    ...new Set([...(binDir ? [binDir] : []), ...paths, "/usr/bin", "/bin"]),
  ].join(delimiter);
  return result;
}
export async function codexCandidates(
  home = homedir(),
  environment = process.env,
): Promise<string[]> {
  const paths = (environment.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((p) => join(p, "codex"));
  paths.push(
    ...[
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".local/bin"),
      join(home, "bin"),
      join(home, ".npm-global/bin"),
      join(home, ".volta/bin"),
      join(home, "Library/pnpm"),
    ].map((p) => join(p, "codex")),
  );
  // Bounded directory discovery supports GUI launches whose PATH excludes Node version managers.
  const roots = [
    join(home, ".nvm/versions/node"),
    join(home, ".local/share/fnm/node-versions"),
    join(home, "Library/Application Support/fnm/node-versions"),
    join(home, ".asdf/installs/nodejs"),
    join(home, ".local/share/mise/installs/node"),
  ];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries
      .filter((e) => e.isDirectory())
      .sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      )
      .slice(0, 16)) {
      paths.push(
        join(
          root,
          entry.name,
          root.includes("fnm/") ? "installation/bin/codex" : "bin/codex",
        ),
      );
    }
  }
  paths.push(
    "/Applications/Codex.app/Contents/Resources/codex",
    join(home, "Applications/Codex.app/Contents/Resources/codex"),
  );
  return [...new Set(paths)].slice(0, 128);
}
/** Per-candidate probe budget; a cold Node-based CLI can need well over a second to start under load (KB-228). */
export const versionProbeTimeout = 5000;
export function readCodexVersion(
  binary: string,
  environment: NodeJS.ProcessEnv,
  timeout = versionProbeTimeout,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      {
        env: codexEnvironment(environment, dirname(binary)),
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) return resolve(null);
        const value = /^codex(?:-cli)?\s+([^\s\x00-\x1f]{1,80})\s*$/m.exec(
          stdout,
        )?.[1];
        resolve(value ?? null);
      },
    );
  });
}
export async function discoverCodex(
  options: {
    home?: string;
    environment?: NodeJS.ProcessEnv;
    candidates?: string[];
    version?: typeof readCodexVersion;
  } = {},
): Promise<CodexInstallation | null> {
  const environment = options.environment ?? process.env;
  const candidates =
    options.candidates ?? (await codexCandidates(options.home, environment));
  const seen = new Set<string>();
  const deadline = Date.now() + 15_000;
  for (const candidate of candidates.slice(0, 128)) {
    if (!isAbsolute(candidate) || Date.now() >= deadline) continue;
    try {
      const resolvedPath = await realpath(candidate);
      if (seen.has(resolvedPath)) continue;
      seen.add(resolvedPath);
      if (!(await stat(resolvedPath)).isFile()) continue;
      await access(resolvedPath, constants.X_OK);
      const version = await (options.version ?? readCodexVersion)(
        resolvedPath,
        environment,
        Math.min(versionProbeTimeout, deadline - Date.now()),
      );
      if (version) return { path: candidate, resolvedPath, version };
    } catch {
      /* A stale symlink or inaccessible installation must not hide a working candidate. */
    }
  }
  return null;
}
