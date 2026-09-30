import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Project, ProjectFolder } from "../shared/projects";
const exec = promisify(execFile);
const inspectionBudgetMs = 10_000;
export type FolderFailure =
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_PATH"
  | "MISSING"
  | "PERMISSION"
  | "NOT_DIRECTORY"
  | "GIT_UNAVAILABLE"
  | "GIT_ERROR"
  | "IDENTITY_CHANGED";
export class FolderInspectionError extends Error {
  constructor(
    readonly code: FolderFailure,
    message: string,
  ) {
    super(message);
    this.name = "FolderInspectionError";
  }
}
export function folderFailure(error: unknown): FolderInspectionError {
  if (error instanceof FolderInspectionError) return error;
  const code = (error as { code?: unknown })?.code;
  if (
    typeof code === "string" &&
    [
      "TIMEOUT",
      "CANCELLED",
      "INVALID_PATH",
      "MISSING",
      "PERMISSION",
      "NOT_DIRECTORY",
      "GIT_UNAVAILABLE",
      "GIT_ERROR",
      "IDENTITY_CHANGED",
    ].includes(code)
  )
    return new FolderInspectionError(
      code as FolderFailure,
      error instanceof Error ? error.message : "文件夹检查失败。",
    );
  if (code === "ENOENT" || code === "ENOTDIR")
    return new FolderInspectionError("MISSING", "文件夹已不存在，请重新选择。");
  if (code === "EACCES" || code === "EPERM")
    return new FolderInspectionError(
      "PERMISSION",
      "无权读取文件夹，请检查权限后重试检查。",
    );
  return new FolderInspectionError(
    "GIT_ERROR",
    "无法核对 Git 信息，请检查文件夹后重试检查。",
  );
}
type GitOptions = { signal: AbortSignal; timeout: number };
export type GitRunner = (
  folder: string,
  args: string[],
  options: GitOptions,
) => Promise<string>;
export type InspectionOptions = {
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
  runGit?: GitRunner;
};
const env = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(folder: string, args: string[], options: GitOptions) {
  return (
    await exec(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        folder,
        ...args,
      ],
      {
        env,
        encoding: "utf8",
        timeout: options.timeout,
        signal: options.signal,
        maxBuffer: 65536,
      },
    )
  ).stdout;
}
function safeRemote(raw: string) {
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return "[地址含不可显示字符]";
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    if (!["https:", "http:", "ssh:", "git:", "file:"].includes(u.protocol))
      return "[非标准远程地址]";
    return u.toString();
  } catch {
    // SCP-style addresses contain an account name, never preserve a password-like userinfo.
    if (/^[^/@:\s]+@[^/:\s]+:.+$/.test(raw))
      return raw.replace(/^[^@]+@/, "").split(/[?#]/)[0];
    return "[本地或非标准远程地址]";
  }
}
export async function inspectProjectFolder(
  path: string,
  options: InspectionOptions = {},
): Promise<ProjectFolder> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path))
    throw new FolderInspectionError(
      "INVALID_PATH",
      "文件夹路径无效，请重新选择。",
    );
  const now = options.now ?? (() => performance.now());
  const budget = options.timeoutMs ?? inspectionBudgetMs;
  const deadline = now() + budget;
  const controller = new AbortController();
  const timeout = new FolderInspectionError(
    "TIMEOUT",
    "文件夹检查超时（10 秒），请重试检查或重新选择。",
  );
  const cancelled = new FolderInspectionError(
    "CANCELLED",
    "文件夹检查已取消，请重新选择。",
  );
  const abortParent = () => controller.abort(cancelled);
  if (options.signal?.aborted) abortParent();
  else options.signal?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(timeout),
    Math.max(0, budget),
  );
  function remaining() {
    if (controller.signal.aborted) throw controller.signal.reason;
    const left = deadline - now();
    if (left <= 0) {
      controller.abort(timeout);
      throw timeout;
    }
    return Math.max(1, Math.floor(left));
  }
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    remaining();
    let detach = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const listener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", listener, { once: true });
      detach = () => controller.signal.removeEventListener("abort", listener);
    });
    try {
      const value = await Promise.race([operation(), aborted]);
      remaining();
      return value;
    } finally {
      detach();
    }
  }
  const runGit = options.runGit ?? git;
  async function command(folder: string, args: string[]) {
    try {
      return await bounded(() =>
        runGit(folder, args, {
          signal: controller.signal,
          timeout: remaining(),
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const code = (error as { code?: unknown })?.code;
      if (code === "ENOENT")
        throw new FolderInspectionError(
          "GIT_UNAVAILABLE",
          "系统 Git 不可用，请安装或恢复 Git 后重试检查。",
        );
      if (code === "ETIMEDOUT" || (error as { killed?: unknown })?.killed)
        throw timeout;
      throw error;
    }
  }
  try {
    const canonicalPath = await bounded(() => realpath(path));
    const before = await bounded(() => stat(canonicalPath, { bigint: true }));
    if (!before.isDirectory())
      throw new FolderInspectionError(
        "NOT_DIRECTORY",
        "请选择文件夹，不要选择文件。",
      );
    await bounded(() => access(canonicalPath, constants.R_OK | constants.X_OK));
    const result: ProjectFolder = {
      path,
      canonicalPath,
      identity: `${before.dev}:${before.ino}`,
      git: null,
    };
    async function recheck() {
      const after = await bounded(() => stat(canonicalPath, { bigint: true }));
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        (await bounded(() => realpath(path))) !== canonicalPath
      )
        throw new FolderInspectionError(
          "IDENTITY_CHANGED",
          "文件夹身份发生变化，请重新选择。",
        );
    }
    let root: string;
    try {
      root = (
        await command(canonicalPath, ["rev-parse", "--show-toplevel"])
      ).trim();
    } catch (error) {
      if (error instanceof FolderInspectionError) throw error;
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (!stderr.includes("not a git repository"))
        throw new FolderInspectionError(
          "GIT_ERROR",
          "无法核对 Git 信息，请检查文件夹后重试检查。",
        );
      await recheck();
      return result;
    }
    const commonName = (
      await command(canonicalPath, ["rev-parse", "--git-common-dir"])
    ).trim();
    const commonDirectory = await bounded(() =>
      realpath(resolve(canonicalPath, commonName)),
    );
    const common = await bounded(() => stat(commonDirectory, { bigint: true }));
    let config = "";
    try {
      config = await command(canonicalPath, [
        "config",
        "--local",
        "--no-includes",
        "--null",
        "--get-regexp",
        "^remote\\..*\\.url$",
      ]);
    } catch (error) {
      if (error instanceof FolderInspectionError) throw error;
      if ((error as { code?: unknown }).code !== 1)
        throw new FolderInspectionError(
          "GIT_ERROR",
          "无法读取 Git 远程信息，请重试检查。",
        );
    }
    const remotes = config
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const split = record.indexOf("\n"),
          key = record.slice(0, split),
          raw = record.slice(split + 1);
        if (split < 0 || !key.startsWith("remote.") || !key.endsWith(".url"))
          throw new FolderInspectionError(
            "GIT_ERROR",
            "Git 远程信息格式无效，请重试检查。",
          );
        return { name: key.slice(7, -4), url: safeRemote(raw) };
      });
    if (remotes.length > 100)
      throw new FolderInspectionError(
        "GIT_ERROR",
        "远程仓库数量超过可读取范围。",
      );
    await recheck();
    result.git = {
      root: await bounded(() => realpath(root)),
      commonDirectory,
      identity: `${common.dev}:${common.ino}`,
      remotes,
    };
    return result;
  } catch (error) {
    throw folderFailure(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortParent);
  }
}
/** Opaque selection capabilities are scoped to the actual trusted window. */
export class ProjectFolders {
  private selected = new Map<
    number,
    { path: string; controller: AbortController }
  >();
  private rechecks = new Map<string, AbortController>();
  private sequence = new Map<number, number>();
  private tokens = new Map<
    string,
    {
      owner: number;
      folder: ProjectFolder;
      expires: number;
      projectId: string;
      busy: boolean;
      created: boolean;
    }
  >();
  constructor(
    private clock = () => Date.now(),
    private inspect: (
      path: string,
      options?: InspectionOptions,
    ) => Promise<ProjectFolder> = inspectProjectFolder,
  ) {}
  selectedPath(owner: number) {
    return this.selected.get(owner)?.path;
  }
  cancel(owner: number) {
    this.sequence.set(owner, (this.sequence.get(owner) ?? 0) + 1);
    this.selected.get(owner)?.controller.abort();
    this.selected.delete(owner);
    for (const [key, value] of this.tokens) {
      if (value.owner === owner) this.rechecks.get(key)?.abort();
      if (value.owner === owner && !value.created && !value.busy)
        this.tokens.delete(key);
    }
  }
  clear(owner: number) {
    this.cancel(owner);
    for (const [key, value] of this.tokens)
      if (value.owner === owner) this.tokens.delete(key);
    this.sequence.delete(owner);
  }
  beginPicker(owner: number) {
    this.cancel(owner);
    return this.sequence.get(owner)!;
  }
  private async begin(owner: number, path: string) {
    this.cancel(owner);
    const pending = { path, controller: new AbortController() };
    this.selected.set(owner, pending);
    // A replacement invalidates every unused capability before its inspection begins.
    for (const [key, value] of this.tokens)
      if (value.expires <= this.clock()) this.tokens.delete(key);
    const folder = await this.inspect(path, {
      signal: pending.controller.signal,
    });
    if (
      this.selected.get(owner) !== pending ||
      pending.controller.signal.aborted
    )
      throw new FolderInspectionError(
        "CANCELLED",
        "文件夹检查已取消，请重新选择。",
      );
    if (this.tokens.size >= 200)
      throw new FolderInspectionError(
        "GIT_ERROR",
        "文件夹选择过多，请关闭窗口后重试。",
      );
    const token = randomUUID();
    this.tokens.set(token, {
      owner,
      folder,
      expires: this.clock() + 600000,
      projectId: randomUUID(),
      busy: false,
      created: false,
    });
    return { token, folder };
  }
  select(owner: number, path: string, picker?: number) {
    if (picker !== undefined && picker !== this.sequence.get(owner))
      return Promise.reject(
        new FolderInspectionError("CANCELLED", "旧文件夹选择已取消。"),
      );
    return this.begin(owner, path);
  }
  async retry(owner: number) {
    const path = this.selectedPath(owner);
    if (!path)
      throw new FolderInspectionError(
        "CANCELLED",
        "没有可重试的文件夹，请重新选择。",
      );
    return this.begin(owner, path);
  }
  async resolve(owner: number, token: string) {
    const value = this.tokens.get(token);
    if (!value || value.owner !== owner || value.expires <= this.clock())
      throw new Error("文件夹选择已失效，请重新选择。");
    if (value.created) return value;
    const controller = new AbortController();
    this.rechecks.set(token, controller);
    try {
      const current = await this.inspect(value.folder.path, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.tokens.get(token) !== value)
        throw new FolderInspectionError(
          "CANCELLED",
          "文件夹检查已取消，请重新选择。",
        );
      if (
        current.identity !== value.folder.identity ||
        current.canonicalPath !== value.folder.canonicalPath ||
        current.git?.identity !== value.folder.git?.identity ||
        current.git?.root !== value.folder.git?.root ||
        current.git?.commonDirectory !== value.folder.git?.commonDirectory
      )
        throw new FolderInspectionError(
          "IDENTITY_CHANGED",
          "文件夹或 Git 资源身份发生变化，请重新选择。",
        );
      return { ...value, folder: current };
    } finally {
      if (this.rechecks.get(token) === controller) this.rechecks.delete(token);
    }
  }
  async create<T>(
    owner: number,
    token: string,
    save: (id: string, folder: ProjectFolder) => Promise<{ ok: boolean } & T>,
  ) {
    const stored = this.tokens.get(token);
    if (!stored || stored.owner !== owner || stored.expires <= this.clock())
      throw new Error("文件夹选择已失效，请重新选择。");
    if (stored.busy) throw new Error("项目正在保存，请等待完成。");
    stored.busy = true;
    try {
      const value = await this.resolve(owner, token);
      const reply = await save(value.projectId, value.folder);
      if (reply.ok) stored.created = true;
      return reply;
    } finally {
      stored.busy = false;
    }
  }
}

/** Check the selected directory identity without reading repository contents or changing it. */
export async function assertProjectFolder(
  project: Project,
  message = "项目文件夹身份已变化，未执行操作。",
) {
  const actual = await inspectProjectFolder(project.folder.path),
    expected = project.folder;
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.identity !== expected.identity ||
    actual.git?.identity !== expected.git?.identity ||
    actual.git?.root !== expected.git?.root ||
    actual.git?.commonDirectory !== expected.git?.commonDirectory
  )
    throw Error(message);
}
