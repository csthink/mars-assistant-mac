/**
 * Pieces shared by the two Agent adapters of the embedded execution port (feature-t30):
 * the profile digest that binds a policy, the image the process helper must report for a
 * launch, the target directory and the execution session directory, material framing and
 * the effort resolution (local role selection, then the model's recorded default). Nothing
 * here spawns a process or reads Agent output.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { canonicalJson } from "../shared/runtime-host";
import { modelRefOf } from "../shared/runtime-execution";
import type { EffortRecord } from "../shared/protocol";
import type {
  ExecutionContext,
  ExecutionMaterial,
  ExecutionStartRequest,
} from "./runtime-execution-port";
import { AdapterRefusal } from "./execution-port";
import { recordSegment } from "./execution-record";

export const sha256Hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
/**
 * A profile's digest binds the policy bytes (argv template, session settings, fixed texts,
 * environment allow-list, permission profile), not the program identity: a Claude Code or
 * Codex upgrade keeps the profile while `programIdentity` (launcher, binary digest, version)
 * is read from the current installation on every offer (spec 既有能力适配, design judgment
 * (9) of feature-t30).
 */
export function policyDigest(policy: unknown): string {
  return sha256Hex(canonicalJson(policy));
}
/** The current installation's binary digest for `programIdentity` (a launcher's real file). */
export function binaryDigest(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
/**
 * The image the helper reports for a launched executable: a script's interpreter (the shebang
 * program, `/usr/bin/env NAME` resolved on the launch PATH), otherwise the executable itself;
 * always the real path, as the kernel reports it. A mismatch after spawn is an identity
 * failure the port never releases.
 */
export async function expectedImageOf(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const real = realpathSync(executable);
  const fd = openSync(real, "r");
  let head: Buffer;
  try {
    head = Buffer.alloc(512);
    const read = readSync(fd, head, 0, head.length, 0);
    head = head.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  if (head[0] !== 0x23 || head[1] !== 0x21) return real;
  const line = head.toString("utf8").split(/\r?\n/)[0].slice(2).trim();
  const tokens = line.split(/\s+/).filter(Boolean);
  let interpreter = tokens[0] ?? "";
  if (/\/env$/.test(interpreter)) {
    const program = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (!program)
      throw new AdapterRefusal(
        "UNSUPPORTED_CAPABILITY",
        "launcher shebang names env without a program",
      );
    interpreter = await resolveOnPath(program, env.PATH ?? "");
  }
  if (!isAbsolute(interpreter))
    throw new AdapterRefusal(
      "UNSUPPORTED_CAPABILITY",
      "launcher interpreter is not an absolute path: " + interpreter,
    );
  return realpathSync(interpreter);
}
async function resolveOnPath(program: string, path: string): Promise<string> {
  if (isAbsolute(program)) return program;
  for (const dir of path.split(delimiter).filter(isAbsolute)) {
    const candidate = join(dir, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  throw new AdapterRefusal(
    "UNSUPPORTED_CAPABILITY",
    "launcher interpreter " + program + " is not on the launch PATH",
  );
}
/**
 * The Implementer's working directory: the resource path joined with the target's relative
 * path, both real paths, the result inside the resource and an existing directory. Symbolic
 * links that leave the resource are refused (the file tools would then reach outside the
 * granted tree).
 */
export function targetDirectory(
  resourcePath: string,
  relativePath: string | null,
): string {
  let root: string;
  try {
    root = realpathSync(resourcePath);
  } catch {
    throw new AdapterRefusal(
      "PRECONDITION_CONFLICT",
      "resource path is not accessible: " + resourcePath,
      "permission",
    );
  }
  const candidate = relativePath === null ? root : join(root, relativePath);
  let real: string;
  try {
    real = realpathSync(candidate);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AdapterRefusal(
      "PRECONDITION_CONFLICT",
      "target directory does not exist or is not a directory: " +
        (relativePath ?? "."),
      "permission",
    );
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new AdapterRefusal(
      "PERMISSION_DENIED",
      "target directory resolves outside the resource: " + relativePath,
      "permission",
    );
  return real;
}
export interface SessionDirectory {
  root: string;
  /** The Reviewer's thread working directory; empty apart from what the Agent leaves there. */
  cwd: string;
  materials: string;
}
/** One private directory per execution under the executions root; created here, never reused. */
export function sessionDirectory(
  executionsRoot: string,
  executionRef: string,
): SessionDirectory {
  const root = join(executionsRoot, "sessions", recordSegment(executionRef));
  const cwd = join(root, "cwd");
  const materials = join(root, "materials");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(materials, { mode: 0o700 });
  return { root, cwd, materials };
}
const extensions: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "application/json": ".json",
  "application/octet-stream": ".bin",
};
export interface MaterialFile {
  path: string;
  name: string;
  material: ExecutionMaterial;
}
/** Writes every snapshot verbatim into the materials directory; names carry the order and the object reference. */
export function writeMaterials(
  dir: string,
  materials: ExecutionMaterial[],
): MaterialFile[] {
  return materials.map((material, index) => {
    const safe = material.ref.objectRef.replace(/[^A-Za-z0-9._-]/g, "_");
    const name =
      String(index + 1).padStart(2, "0") +
      "-" +
      safe.slice(0, 80) +
      (extensions[material.ref.mediaType] ?? ".bin");
    const path = join(dir, name);
    writeFileSync(path, material.bytes, { mode: 0o600, flag: "wx" });
    return { path, name, material };
  });
}
export const textMediaTypes = [
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
];
/** Header and footer around each inline snapshot: the Host states the identity; the bytes stay verbatim and unparsed. */
export function frameMaterials(
  preamble: string,
  materials: ExecutionMaterial[],
): Buffer {
  const parts: Buffer[] = [Buffer.from(preamble, "utf8")];
  materials.forEach((material, index) => {
    const ref = material.ref;
    parts.push(
      Buffer.from(
        `\n\n===== 材料 ${index + 1}/${materials.length} 开始 · objectRef ${ref.objectRef} · revision ${ref.revision} · ${ref.mediaType} · ${ref.bytes} 字节 · sha256 ${ref.digest} =====\n`,
        "utf8",
      ),
      material.bytes,
      Buffer.from(`\n===== 材料 ${index + 1} 结束 =====\n`, "utf8"),
    );
  });
  return Buffer.concat(parts);
}
/** A material's identity line for a preamble that lists files instead of inlining them. */
export function materialLine(file: MaterialFile): string {
  const ref = file.material.ref;
  return `- ${file.path} · objectRef ${ref.objectRef} · revision ${ref.revision} · ${ref.mediaType} · ${ref.bytes} 字节 · sha256 ${ref.digest}`;
}
export function totalMaterialBytes(materials: ExecutionMaterial[]): number {
  return materials.reduce((sum, m) => sum + m.bytes.length, 0);
}

export interface EffortResolution {
  effort: string | null;
  source: "role-binding" | "model-default" | "none";
}
/**
 * The effort level of one execution (范围-06): the local role selection's explicit level, else
 * the connection's recorded default for the model, else none ("未记录"). A local selection
 * that names another connection or model is a conflict with the request, never resolved
 * silently. Whether the installation still accepts the level is the adapter's re-check.
 */
export async function resolveEffort(
  context: ExecutionContext,
  request: ExecutionStartRequest,
  record: EffortRecord | null,
): Promise<EffortResolution> {
  const binding = await context.roleBinding();
  if (binding) {
    if (
      binding.connectionId !== context.connectionId ||
      modelRefOf(binding.model) !== request.model
    )
      throw new AdapterRefusal(
        "PRECONDITION_CONFLICT",
        `局部选择与请求不一致：局部选择为连接 ${binding.connectionId} 的模型 ${binding.model}，请求为连接 ${context.connectionId ?? "无"} 的模型 ${request.model}`,
        "unsupported",
      );
    if (binding.effort !== null)
      return { effort: binding.effort, source: "role-binding" };
  }
  if (record?.defaultLevel)
    return { effort: record.defaultLevel, source: "model-default" };
  return { effort: null, source: "none" };
}
/** Whole-word presence of one command-line option in a help text. */
export function helpListsOption(help: string, option: string): boolean {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[\\s,/])" + escaped + "(?=[\\s,=<\\[]|$)", "m").test(
    help,
  );
}
