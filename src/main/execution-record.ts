/**
 * Shared physical observation record (Contract "执行预约、放行与共享观察记录"): the
 * supervising execution port is the only writer of `harness/executions/<request>/` under
 * the target resource's Git common directory, from exclusive creation to exit. Records are
 * numbered by `seq`, each written to a temporary file and renamed into place, so a reader
 * on another entry never sees a torn record. The record never holds prompts, credentials,
 * complete output or domain state.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../shared/runtime-host";
import type {
  ContractProcessIdentity,
  ProcessExit,
} from "../shared/runtime-execution";

export interface ExecutionRecord {
  recordVersion: "1";
  seq: string;
  executionRequestId: string;
  executionId: string;
  intentDigest: string;
  profileDigest: string;
  executionPort: "embedded" | "standalone";
  bootId: string;
  uid: number;
  supervisor: ContractProcessIdentity;
  target: ContractProcessIdentity | null;
  processGroup: number | null;
  children: ContractProcessIdentity[];
  nativeSession: { sessionRef: string; turnRef: string | null } | null;
  released: boolean;
  observedAt: string;
  cancelRequestedAt: string | null;
  exit: ProcessExit | null;
  observationErrors: string[];
  result: { digest: string; locator: string } | null;
}
export class ExecutionRecordError extends Error {
  constructor(
    readonly code: "RECORD_EXISTS" | "RECORD_WRITE" | "RECORD_ROOT",
    message: string,
  ) {
    super(message);
  }
}
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/**
 * The Git common directory a path belongs to (a worktree's `.git` file points at its own
 * gitdir whose `commondir` names the shared one), or null when the path is in no repository.
 * Only files under the path's own ancestors are read; nothing is executed.
 */
export function gitCommonDir(path: string): string | null {
  let current: string;
  try {
    current = realpathSync(path);
  } catch {
    return null;
  }
  for (;;) {
    const marker = join(current, ".git");
    let kind: "dir" | "file" | null = null;
    try {
      const info = lstatSync(marker);
      kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
    } catch {
      kind = null;
    }
    if (kind) {
      let gitDir = marker;
      if (kind === "file") {
        const text = readFileSync(marker, "utf8").trim();
        if (!text.startsWith("gitdir:")) return null;
        const target = text.slice("gitdir:".length).trim();
        gitDir = isAbsolute(target) ? target : resolve(current, target);
      }
      const commonFile = join(gitDir, "commondir");
      if (existsSync(commonFile)) {
        const target = readFileSync(commonFile, "utf8").trim();
        gitDir = isAbsolute(target) ? target : resolve(gitDir, target);
      }
      try {
        return realpathSync(gitDir);
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
/** The request id as a path segment: the Contract derives the directory from the normalized internal id, never from model text. */
export function recordSegment(requestId: string) {
  const segment = requestId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200);
  if (!segment || segment === "." || segment === "..")
    throw new ExecutionRecordError("RECORD_ROOT", "request id yields no path");
  return segment;
}

function writeAtomic(path: string, bytes: Buffer) {
  const temporary = path + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** One execution's record directory, created exclusively; every write is a new seq. */
export class ExecutionRecordWriter {
  readonly dir: string;
  /** Digest of the directory path (the record locator kept in Host records, never the path). */
  readonly locator: string;
  private next = 0;
  private last: ExecutionRecord | null = null;
  private constructor(dir: string) {
    this.dir = dir;
    this.locator = sha256(dir);
  }
  /** Creates `root/harness/executions/<segment>/` exclusively; an existing directory is another writer's and is refused. */
  static create(root: string, requestId: string): ExecutionRecordWriter {
    const parent = join(root, "harness", "executions");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = join(parent, recordSegment(requestId));
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ExecutionRecordError(
          "RECORD_EXISTS",
          "physical record directory already exists: " +
            recordSegment(requestId),
        );
      throw new ExecutionRecordError(
        "RECORD_WRITE",
        "cannot create record directory: " + (error as Error).message,
      );
    }
    return new ExecutionRecordWriter(dir);
  }
  /** Appends the next seq; the record's own `seq` and `observedAt` are set here. */
  write(record: Omit<ExecutionRecord, "seq" | "observedAt" | "recordVersion">) {
    const full: ExecutionRecord = {
      recordVersion: "1",
      seq: String(this.next),
      observedAt: nowIso(),
      ...record,
    } as ExecutionRecord;
    const ordered: ExecutionRecord = {
      recordVersion: "1",
      seq: full.seq,
      executionRequestId: full.executionRequestId,
      executionId: full.executionId,
      intentDigest: full.intentDigest,
      profileDigest: full.profileDigest,
      executionPort: full.executionPort,
      bootId: full.bootId,
      uid: full.uid,
      supervisor: full.supervisor,
      target: full.target,
      processGroup: full.processGroup,
      children: full.children,
      nativeSession: full.nativeSession,
      released: full.released,
      observedAt: full.observedAt,
      cancelRequestedAt: full.cancelRequestedAt,
      exit: full.exit,
      observationErrors: full.observationErrors.slice(0, 32),
      result: full.result,
    };
    const bytes = Buffer.from(canonicalJson(ordered) + "\n");
    const name = String(this.next).padStart(6, "0") + ".json";
    try {
      writeAtomic(join(this.dir, name), bytes);
      writeAtomic(
        join(this.dir, name + ".sha256"),
        Buffer.from(sha256(bytes) + "\n"),
      );
    } catch (error) {
      throw new ExecutionRecordError(
        "RECORD_WRITE",
        "cannot write record seq " +
          this.next +
          ": " +
          (error as Error).message,
      );
    }
    this.next += 1;
    this.last = ordered;
    return ordered;
  }
  latest() {
    return this.last;
  }
}
/** Reads every seq of a record directory in order (recovery and audits); missing or torn files are reported, not repaired. */
export function readExecutionRecords(dir: string): {
  records: ExecutionRecord[];
  problems: string[];
} {
  const records: ExecutionRecord[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
  } catch (error) {
    return { records, problems: ["unreadable: " + (error as Error).message] };
  }
  names.forEach((name, index) => {
    try {
      const bytes = readFileSync(join(dir, name));
      const expected = readFileSync(join(dir, name + ".sha256"), "utf8").trim();
      if (sha256(bytes) !== expected) problems.push(name + ": digest mismatch");
      const record = JSON.parse(bytes.toString("utf8")) as ExecutionRecord;
      if (record.seq !== String(index)) problems.push(name + ": seq gap");
      records.push(record);
    } catch (error) {
      problems.push(name + ": " + (error as Error).message);
    }
  });
  return { records, problems };
}
export function recordDirectoryExists(root: string, requestId: string) {
  try {
    return statSync(
      join(root, "harness", "executions", recordSegment(requestId)),
    ).isDirectory();
  } catch {
    return false;
  }
}
