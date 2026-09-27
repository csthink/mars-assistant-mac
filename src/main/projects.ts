import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Project, ProjectFolder } from "../shared/projects";
const exec = promisify(execFile);
const env = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(folder: string, args: string[]) {
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
      { env, encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
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
): Promise<ProjectFolder> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path))
    throw new Error("文件夹路径无效，请重新选择。");
  const canonicalPath = await realpath(path);
  const before = await stat(canonicalPath, { bigint: true });
  if (!before.isDirectory()) throw new Error("请选择可读取的文件夹。");
  await access(canonicalPath, constants.R_OK | constants.X_OK);
  const result: ProjectFolder = {
    path,
    canonicalPath,
    identity: `${before.dev}:${before.ino}`,
    git: null,
  };
  async function recheck() {
    const after = await stat(canonicalPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (await realpath(path)) !== canonicalPath
    )
      throw new Error("文件夹身份发生变化，请重新选择。");
  }
  let root: string;
  try {
    root = (await git(canonicalPath, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!stderr.includes("not a git repository"))
      throw new Error("无法核对 Git 信息，请检查文件夹后重试。");
    await recheck();
    return result;
  }
  const commonDirectory = await realpath(
    resolve(
      canonicalPath,
      (await git(canonicalPath, ["rev-parse", "--git-common-dir"])).trim(),
    ),
  );
  const common = await stat(commonDirectory, { bigint: true });
  let config = "";
  try {
    config = await git(canonicalPath, [
      "config",
      "--local",
      "--no-includes",
      "--null",
      "--get-regexp",
      "^remote\..*\.url$",
    ]);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1)
      throw new Error("无法读取 Git 远程信息。");
  }
  const remotes = config
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const split = record.indexOf("\n"),
        key = record.slice(0, split),
        raw = record.slice(split + 1);
      if (split < 0 || !key.startsWith("remote.") || !key.endsWith(".url"))
        throw new Error("Git 远程信息格式无效。");
      return { name: key.slice(7, -4), url: safeRemote(raw) };
    });
  if (remotes.length > 100) throw new Error("远程仓库数量超过可读取范围。");
  await recheck();
  result.git = {
    root: await realpath(root),
    commonDirectory,
    identity: `${common.dev}:${common.ino}`,
    remotes,
  };
  return result;
}
/** Opaque selection capabilities are scoped to the actual trusted window. */
export class ProjectFolders {
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
  constructor(private clock = () => Date.now()) {}
  clear(owner: number) {
    for (const [key, value] of this.tokens)
      if (value.owner === owner) this.tokens.delete(key);
  }
  async select(owner: number, path: string) {
    const folder = await inspectProjectFolder(path);
    // A newer selection from this window invalidates unused selections; completed tokens remain idempotent.
    for (const [key, value] of this.tokens)
      if (
        value.expires <= this.clock() ||
        (value.owner === owner && !value.created)
      )
        this.tokens.delete(key);
    if (this.tokens.size >= 200)
      throw new Error("文件夹选择过多，请关闭窗口后重试。");
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
  async resolve(owner: number, token: string) {
    const value = this.tokens.get(token);
    if (!value || value.owner !== owner || value.expires <= this.clock())
      throw new Error("文件夹选择已失效，请重新选择。");
    if (value.created) return value;
    const current = await inspectProjectFolder(value.folder.path);
    if (
      current.identity !== value.folder.identity ||
      current.canonicalPath !== value.folder.canonicalPath ||
      current.git?.identity !== value.folder.git?.identity ||
      current.git?.root !== value.folder.git?.root ||
      current.git?.commonDirectory !== value.folder.git?.commonDirectory
    )
      throw new Error("文件夹或 Git 资源身份发生变化，请重新选择。");
    return { ...value, folder: current };
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
