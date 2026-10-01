import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import type { ProgramIdentity } from "../shared/runtime-host";

/** Hash the bytes of the resolved launcher selected for this execution. */
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

/** Verify the path selected by spawn still resolves to the bytes discovered for this attempt. */
export function matchesProgramIdentity(
  executable: string,
  identity: ProgramIdentity,
): boolean {
  try {
    return (
      realpathSync(executable) === identity.launcher &&
      binaryDigest(identity.launcher) === identity.binaryDigest
    );
  } catch {
    return false;
  }
}
