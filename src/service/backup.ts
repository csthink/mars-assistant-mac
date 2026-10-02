import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Database } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  constants,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { StoreError } from "./errors";
import { isMacMetadata } from "../shared/macos-metadata";

/** The root lock must be held. Never overwrite a prior snapshot or follow links. */
export function backupBeforeUpgrade(
  db: DatabaseSync,
  root: string,
  version: number,
) {
  try {
    const destination = mkdtempSync(`${root}-schema-${version}-backup-`);
    chmodSync(destination, 0o700);
    const data = join(destination, "data");
    mkdirSync(data, { mode: 0o700 });
    const database = join(data, "state.sqlite");
    // VACUUM INTO includes committed WAL content without modifying the source.
    db.prepare("VACUUM INTO ?").run(database);
    chmodSync(database, 0o600);
    const verify = new Database(database, { readOnly: true });
    try {
      if (
        verify.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
        verify.prepare("PRAGMA user_version").get()?.user_version !== version ||
        verify.prepare("PRAGMA foreign_key_check").all().length
      )
        throw new Error("snapshot verification failed");
    } finally {
      verify.close();
    }
    const files: { path: string; sha256: string }[] = [];
    function record(path: string) {
      const file = join(data, path);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      files.push({
        path,
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      });
    }
    record("state.sqlite");
    const source = join(root, "attachments");
    if (existsSync(source)) {
      if (!lstatSync(source).isDirectory())
        throw new Error("invalid attachment directory");
      mkdirSync(join(data, "attachments"), { mode: 0o700 });
      for (const name of readdirSync(source)) {
        // Finder metadata is not part of the data and is not copied into the backup.
        if (isMacMetadata(name, (base) => /^[0-9a-f]{64}$/.test(base)))
          continue;
        const file = join(source, name);
        if (!/^[0-9a-f]{64}$/.test(name) || !lstatSync(file).isFile())
          throw new Error("invalid attachment file");
        const target = join(data, "attachments", name);
        copyFileSync(file, target, constants.COPYFILE_EXCL);
        chmodSync(target, 0o600);
        record(`attachments/${name}`);
        if (
          files.at(-1)!.sha256 !==
          createHash("sha256").update(readFileSync(file)).digest("hex")
        )
          throw new Error("attachment copy mismatch");
      }
    }
    // Written only after every copied byte has been checked. An incomplete directory is not a backup.
    const manifest = join(destination, "complete.json");
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          schemaVersion: version,
          sourceRoot: root,
          createdAt: new Date().toISOString(),
          files,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    for (const path of [
      manifest,
      ...(existsSync(join(data, "attachments"))
        ? [join(data, "attachments")]
        : []),
      data,
      destination,
      dirname(destination),
    ]) {
      const fd = openSync(path, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return destination;
  } catch {
    throw new StoreError(
      "WRITE_FAILED",
      "升级前完整快照未能完成，原数据库未迁移。请检查数据目录旁的可用空间和写入权限后重试。",
    );
  }
}
