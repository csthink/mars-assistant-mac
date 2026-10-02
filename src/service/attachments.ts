import type { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  acceptsImages,
  attachmentPreviewLimit,
  attachmentSizeLimit,
  attachmentsPerTurn,
  defaultContextChars,
  imageSideLimit,
  type Attachment,
  type AttachmentPreview,
  type ImageInput,
  type TurnAttachment,
  type AttachmentKind,
  type AttachmentReason,
  type DraftAttachment,
  type HostCommand,
  type MessageAttachment,
  type Snapshot,
} from "../shared/protocol";
import { StoreError } from "./errors";
import { isMacMetadata } from "../shared/macos-metadata";

/**
 * Schema version 8: selected material. A copy of the chosen bytes is stored
 * content-addressed under <root>/attachments; rows only ever point at copies,
 * so a changed or deleted original cannot alter what a message carried.
 */
export const attachmentSchema = `CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','markdown','pdf','png','jpeg')),
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('importing','ready','unreadable')),
  reason TEXT,
  chars INTEGER,
  pages INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE attachment_texts (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);
CREATE TABLE draft_attachments (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, attachment_id)
);
CREATE TABLE message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id),
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);`;
export const attachmentDirectory = "attachments";
const hex64 = /^[0-9a-f]{64}$/;
const temporary = /^tmp-[0-9a-f-]{36}$/;
const attachmentColumns =
  "id, sha256, name, kind, size, status, reason, chars, pages, width, height, created_at AS createdAt";

/** Only the copy directory's own layout is accepted; anything else means the root was touched. */
export function verifyAttachmentDirectory(root: string) {
  const dir = join(root, attachmentDirectory);
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory())
      throw new StoreError(
        "INVALID_ROOT",
        "attachments 不是目录，应用未改写原数据。",
      );
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    // Finder metadata is left in place; it is not a copy and nothing references it.
    if (isMacMetadata(name, (base) => hex64.test(base))) continue;
    const entry = lstatSync(join(dir, name));
    if (temporary.test(name)) {
      // An interrupted import left its own scratch file; nothing references it.
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (!hex64.test(name) || !entry.isFile())
      throw new StoreError(
        "INVALID_ROOT",
        "attachments 目录中包含非本应用副本。请恢复原目录，应用未改写它。",
      );
  }
}
/** Kind implied by the extension alone; used to label files that could not be read. */
export function kindFromExtension(name: string): AttachmentKind | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "txt" || extension === "text") return "text";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "pdf") return "pdf";
  if (extension === "png") return "png";
  if (extension === "jpg" || extension === "jpeg") return "jpeg";
  return null;
}
/** Kind from the extension, confirmed by the file header for binary formats. */
export function sniffKind(
  name: string,
  header: Buffer,
): AttachmentKind | "unsupported" | "mismatch" {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "txt" || extension === "text") return "text";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "pdf")
    return header.subarray(0, 5).toString("latin1") === "%PDF-"
      ? "pdf"
      : "mismatch";
  if (extension === "png")
    return header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? "png"
      : "mismatch";
  if (extension === "jpg" || extension === "jpeg")
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      ? "jpeg"
      : "mismatch";
  return "unsupported";
}
/** Pixel dimensions from the header alone; no pixel decoding happens in the business service. */
export function imageDimensions(
  kind: "png" | "jpeg",
  bytes: Buffer,
): { width: number; height: number } | null {
  if (kind === "png") {
    if (
      bytes.length < 24 ||
      bytes.subarray(12, 16).toString("latin1") !== "IHDR"
    )
      return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    if (marker === 0xd9 || marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}
interface Imported {
  sha256: string;
  size: number;
  kind: AttachmentKind;
  status: Attachment["status"];
  reason: AttachmentReason | null;
  width: number | null;
  height: number | null;
}
/**
 * Opens exactly the given path once, read-only and without following a symlink,
 * and copies it into the content-addressed store while hashing. The parent
 * directory is never listed and no other file is touched.
 */
function copyIntoStore(root: string, path: string, name: string): Imported {
  const dir = join(root, attachmentDirectory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unreadable = (
    reason: AttachmentReason,
    kind: AttachmentKind,
    size: number,
  ): Imported => ({
    sha256: "",
    size,
    kind,
    status: "unreadable",
    reason,
    width: null,
    height: null,
  });
  // Files refused before or without a readable header are still labelled by their extension.
  const fallbackKind: AttachmentKind = kindFromExtension(name) ?? "text";
  let fd: number;
  try {
    if (!lstatSync(path).isFile())
      throw new StoreError(
        "INVALID_COMMAND",
        "只能添加普通文件，不能添加目录、符号链接或设备。",
      );
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(
      "NOT_FOUND",
      "无法打开所选文件，可能已被移动、删除或没有读取权限。",
    );
  }
  let scratch: string | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new StoreError("INVALID_COMMAND", "只能添加普通文件。");
    if (stat.size > attachmentSizeLimit)
      return unreadable("too_large", fallbackKind, stat.size);
    const head = Buffer.alloc(64);
    const headLength = readSync(fd, head, 0, 64, 0);
    const sniffed = sniffKind(name, head.subarray(0, headLength));
    if (sniffed === "unsupported" || sniffed === "mismatch")
      return unreadable(
        sniffed === "mismatch" && /\.(png|jpe?g)$/i.test(name)
          ? "image_invalid"
          : "unsupported_format",
        fallbackKind,
        stat.size,
      );
    scratch = join(dir, `tmp-${randomUUID()}`);
    const out = openSync(scratch, "wx", 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let total = 0;
    let dimensionBytes: Buffer | undefined;
    try {
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, total);
        if (read === 0) break;
        total += read;
        if (total > attachmentSizeLimit)
          return unreadable("too_large", sniffed, total);
        hash.update(chunk.subarray(0, read));
        if (!dimensionBytes && (sniffed === "png" || sniffed === "jpeg"))
          dimensionBytes = Buffer.from(chunk.subarray(0, read));
        let written = 0;
        while (written < read)
          written += writeSync(out, chunk, written, read - written);
      }
    } finally {
      closeSync(out);
    }
    const sha256 = hash.digest("hex");
    const final = join(dir, sha256);
    try {
      if (lstatSync(final).isFile()) rmSync(scratch, { force: true });
      else throw new Error("unexpected entry");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      renameSync(scratch, final);
    }
    scratch = undefined;
    let width: number | null = null,
      height: number | null = null;
    let status: Attachment["status"] = "importing";
    let reason: AttachmentReason | null = null;
    if (sniffed === "png" || sniffed === "jpeg") {
      const dimensions = imageDimensions(
        sniffed,
        dimensionBytes ?? Buffer.alloc(0),
      );
      if (!dimensions) {
        status = "unreadable";
        reason = "image_invalid";
      } else if (
        dimensions.width > imageSideLimit ||
        dimensions.height > imageSideLimit ||
        dimensions.width === 0 ||
        dimensions.height === 0
      ) {
        status = "unreadable";
        reason = "image_too_large";
        width = dimensions.width;
        height = dimensions.height;
      } else {
        status = "ready";
        width = dimensions.width;
        height = dimensions.height;
      }
    }
    return {
      sha256,
      size: total,
      kind: sniffed,
      status,
      reason,
      width,
      height,
    };
  } finally {
    closeSync(fd);
    if (scratch) rmSync(scratch, { force: true });
  }
}
export function importAttachment(
  db: DatabaseSync,
  root: string,
  command: Extract<HostCommand, { type: "importAttachment" }>,
  now: string,
) {
  // A retried import after a lost acknowledgement confirms the recorded row.
  if (
    db.prepare("SELECT 1 FROM attachments WHERE id=?").get(command.attachmentId)
  )
    return;
  if (
    !db
      .prepare("SELECT 1 FROM conversations WHERE id=?")
      .get(command.conversationId)
  )
    throw new StoreError("NOT_FOUND", "原对话不存在，未添加资料。");
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS last FROM draft_attachments WHERE conversation_id=?",
    )
    .get(command.conversationId) as { count: number; last: number };
  if (count.count >= attachmentsPerTurn)
    throw new StoreError(
      "CONFLICT",
      `每回合最多 ${attachmentsPerTurn} 个资料，未添加“${command.name}”。请先移除其他资料。`,
    );
  const imported = copyIntoStore(root, command.path, command.name);
  db.prepare(
    "INSERT INTO attachments (id, sha256, name, kind, size, status, reason, width, height, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    command.attachmentId,
    imported.sha256,
    command.name,
    imported.kind,
    imported.size,
    imported.status,
    imported.reason,
    imported.width,
    imported.height,
    now,
  );
  db.prepare(
    "INSERT INTO draft_attachments (conversation_id, attachment_id, position) VALUES (?,?,?)",
  ).run(command.conversationId, command.attachmentId, count.last + 1);
}
/** Deletes an attachment row and its copy once nothing references either any more. */
export function releaseAttachment(
  db: DatabaseSync,
  root: string,
  attachmentId: string,
) {
  const referenced =
    db
      .prepare("SELECT 1 FROM draft_attachments WHERE attachment_id=?")
      .get(attachmentId) ||
    db
      .prepare("SELECT 1 FROM message_attachments WHERE attachment_id=?")
      .get(attachmentId);
  if (referenced) return;
  const row = db
    .prepare("SELECT sha256 FROM attachments WHERE id=?")
    .get(attachmentId) as { sha256: string } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM attachment_texts WHERE attachment_id=?").run(
    attachmentId,
  );
  db.prepare("DELETE FROM attachments WHERE id=?").run(attachmentId);
  if (
    hex64.test(row.sha256) &&
    !db.prepare("SELECT 1 FROM attachments WHERE sha256=?").get(row.sha256)
  )
    rmSync(join(root, attachmentDirectory, row.sha256), { force: true });
}
export function removeDraftAttachment(
  db: DatabaseSync,
  root: string,
  conversationId: string,
  attachmentId: string,
) {
  // Idempotent: a repeated remove after a lost acknowledgement succeeds.
  db.prepare(
    "DELETE FROM draft_attachments WHERE conversation_id=? AND attachment_id=?",
  ).run(conversationId, attachmentId);
  releaseAttachment(db, root, attachmentId);
}
/** Moves the conversation's draft attachments onto the submitted user message, in one transaction. */
export function attachDraftToMessage(
  db: DatabaseSync,
  conversationId: string,
  messageId: string,
) {
  const rows = db
    .prepare(
      "SELECT attachment_id AS attachmentId, position FROM draft_attachments WHERE conversation_id=? ORDER BY position",
    )
    .all(conversationId) as { attachmentId: string; position: number }[];
  for (const [index, row] of rows.entries())
    db.prepare(
      "INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?,?,?)",
    ).run(messageId, row.attachmentId, index);
  db.prepare("DELETE FROM draft_attachments WHERE conversation_id=?").run(
    conversationId,
  );
  return rows.map((row) => row.attachmentId);
}
/** Draft attachments of a conversation with their rows, in position order. */
export function draftAttachments(
  db: DatabaseSync,
  conversationId: string,
): Attachment[] {
  return db
    .prepare(
      `SELECT ${attachmentColumns} FROM attachments a JOIN draft_attachments d ON d.attachment_id = a.id WHERE d.conversation_id=? ORDER BY d.position`,
    )
    .all(conversationId) as unknown as Attachment[];
}
export function attachmentSnapshot(
  db: DatabaseSync,
  conversationIds: string[],
): Pick<Snapshot, "attachments" | "draftAttachments" | "messageAttachments"> {
  const ids = [...new Set(conversationIds)];
  const marks = ids.map(() => "?").join(",") || "NULL";
  const draft = db
    .prepare(
      `SELECT conversation_id AS conversationId, attachment_id AS attachmentId, position FROM draft_attachments WHERE conversation_id IN (${marks}) ORDER BY conversation_id, position`,
    )
    .all(...ids) as unknown as DraftAttachment[];
  const message = db
    .prepare(
      `SELECT ma.message_id AS messageId, ma.attachment_id AS attachmentId, ma.position FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.conversation_id IN (${marks}) ORDER BY m.created_at, m.rowid, ma.position`,
    )
    .all(...ids) as unknown as MessageAttachment[];
  const attachmentIds = [
    ...new Set([...draft, ...message].map((row) => row.attachmentId)),
  ];
  const attachmentMarks = attachmentIds.map(() => "?").join(",") || "NULL";
  const attachments = db
    .prepare(
      `SELECT ${attachmentColumns} FROM attachments a WHERE id IN (${attachmentMarks}) ORDER BY created_at, rowid`,
    )
    .all(...attachmentIds) as unknown as Attachment[];
  return { attachments, draftAttachments: draft, messageAttachments: message };
}
/** Text attachments whose copy still awaits the extraction worker, oldest first. */
export function pendingExtractions(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, sha256, kind FROM attachments WHERE status='importing' AND kind IN ('text','markdown','pdf') AND sha256 <> '' ORDER BY created_at, rowid",
    )
    .all() as unknown as { id: string; sha256: string; kind: string }[];
}
/** Applies one worker outcome; a row that is no longer importing (removed, or already settled) is left alone. */
export function applyExtraction(
  db: DatabaseSync,
  command: Extract<HostCommand, { type: "reportExtraction" }>,
) {
  const row = db
    .prepare("SELECT status FROM attachments WHERE id=?")
    .get(command.attachmentId) as { status: string } | undefined;
  if (!row || row.status !== "importing") return;
  if (command.outcome.ok) {
    db.prepare(
      "UPDATE attachments SET status='ready', reason=NULL, chars=?, pages=? WHERE id=?",
    ).run(
      command.outcome.text.length,
      command.outcome.pages,
      command.attachmentId,
    );
    db.prepare(
      "INSERT OR REPLACE INTO attachment_texts (attachment_id, text) VALUES (?,?)",
    ).run(command.attachmentId, command.outcome.text);
    return;
  }
  db.prepare(
    "UPDATE attachments SET status='unreadable', reason=? WHERE id=?",
  ).run(command.outcome.reason, command.attachmentId);
}
/** The first characters of the extracted text for the preview panel; images and unreadable files have none. */
export function readPreview(
  db: DatabaseSync,
  attachmentId: string,
): AttachmentPreview {
  const row = db
    .prepare(
      "SELECT a.status, t.text FROM attachments a LEFT JOIN attachment_texts t ON t.attachment_id = a.id WHERE a.id=?",
    )
    .get(attachmentId) as { status: string; text: string | null } | undefined;
  if (!row) throw new StoreError("NOT_FOUND", "该资料不存在或已移除。");
  const text = row.text ?? "";
  return {
    attachmentId,
    text: text.slice(0, attachmentPreviewLimit),
    chars: text.length,
  };
}
/** Full extracted text of a ready attachment; used when building a turn's request. */
export function attachmentText(db: DatabaseSync, attachmentId: string) {
  const row = db
    .prepare("SELECT text FROM attachment_texts WHERE attachment_id=?")
    .get(attachmentId) as { text: string } | undefined;
  return row?.text ?? null;
}
/**
 * Re-checks the conversation's material inside the submit transaction: count,
 * readiness, copies on disk, image capability and the context budget. Returns
 * how many history images the connection will not receive.
 */
export function checkSubmission(
  db: DatabaseSync,
  root: string,
  conversationId: string,
  connection: {
    imageInput: ImageInput;
    contextChars: number | null;
    name: string;
    textLength: number;
  },
): { omittedImages: number } {
  const drafts = draftAttachments(db, conversationId);
  if (drafts.length > attachmentsPerTurn)
    throw new StoreError(
      "CONFLICT",
      `本次携带 ${drafts.length} 个资料，超过每回合 ${attachmentsPerTurn} 个的上限，消息未发送。请先移除部分资料。`,
    );
  for (const draft of drafts) {
    if (draft.status === "importing")
      throw new StoreError(
        "CONFLICT",
        `“${draft.name}”仍在提取正文，消息未发送。请等待提取完成或移除它。`,
      );
    if (draft.status === "unreadable")
      throw new StoreError(
        "CONFLICT",
        `“${draft.name}”不可读，消息未发送。请移除它后重试。`,
      );
    if (
      !hex64.test(draft.sha256) ||
      !existsSync(join(root, attachmentDirectory, draft.sha256))
    )
      throw new StoreError(
        "CONFLICT",
        `“${draft.name}”的副本缺失，消息未发送。请移除它并重新选择文件。`,
      );
  }
  const images = drafts.filter((d) => d.kind === "png" || d.kind === "jpeg");
  if (images.length && !acceptsImages(connection.imageInput))
    throw new StoreError(
      "CONFLICT",
      connection.imageInput === "unsupported"
        ? `连接“${connection.name}”的模型不支持图片输入，消息未发送。请移除图片，或在输入区换用支持图片的连接。`
        : `连接“${connection.name}”暂不能接收图片，请进入设置查看检测结果或换用其他连接。`,
    );
  // Budget: saved history text (including unfinished answers the model will see), the text of material those messages carried, this turn's material and text.
  const history = db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(length(content)), 0) FROM messages WHERE conversation_id=?)
            + (SELECT COALESCE(SUM(length(partial_text)), 0) FROM turns WHERE conversation_id=? AND state IN ('stopped','failed','interrupted')) AS chars`,
    )
    .get(conversationId, conversationId) as { chars: number };
  const carried = db
    .prepare(
      `SELECT COALESCE(SUM(a.chars), 0) AS chars,
              COALESCE(SUM(CASE WHEN a.kind IN ('png','jpeg') THEN 1 ELSE 0 END), 0) AS images
       FROM message_attachments ma JOIN messages m ON m.id = ma.message_id JOIN attachments a ON a.id = ma.attachment_id
       WHERE m.conversation_id=? AND a.status='ready'`,
    )
    .get(conversationId) as { chars: number; images: number };
  const current = drafts.reduce((sum, d) => sum + (d.chars ?? 0), 0);
  const total = history.chars + carried.chars + current + connection.textLength;
  const budget = connection.contextChars ?? defaultContextChars;
  if (total > budget)
    throw new StoreError(
      "CONFLICT",
      `本次将发送约 ${total.toLocaleString("zh-CN")} 字符，超过连接“${connection.name}”的上下文预算 ${budget.toLocaleString("zh-CN")} 字符，消息未发送。请移除或缩减资料，或在设置中调整该连接的上下文预算。`,
    );
  return {
    omittedImages: acceptsImages(connection.imageInput) ? 0 : carried.images,
  };
}
/** Material carried by the given messages, with text inline and images as copy locations. */
export function turnAttachments(
  db: DatabaseSync,
  messageIds: string[],
  imageInput: ImageInput,
): TurnAttachment[] {
  if (!messageIds.length) return [];
  const marks = messageIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ma.message_id AS messageId, a.id, a.name, a.kind, a.sha256, a.status, t.text, COALESCE(turn.material_mode,'inline') AS materialMode
       FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
       LEFT JOIN attachment_texts t ON t.attachment_id = a.id
       JOIN messages m ON m.id = ma.message_id
       LEFT JOIN turns turn ON turn.id=m.turn_id
       WHERE ma.message_id IN (${marks}) ORDER BY m.created_at, m.rowid, ma.position`,
    )
    .all(...messageIds) as unknown as {
    messageId: string;
    id: string;
    name: string;
    kind: AttachmentKind;
    sha256: string;
    status: string;
    text: string | null;
    materialMode: string;
  }[];
  return rows.map((row) => {
    const image = row.kind === "png" || row.kind === "jpeg";
    return {
      messageId: row.messageId,
      id: row.id,
      name: row.name,
      kind: row.kind,
      sha256: row.sha256,
      ...(row.materialMode === "tools" ? { deferred: true } : {}),
      text: image || row.materialMode === "tools" ? null : row.text,
      copy: image ? `${attachmentDirectory}/${row.sha256}` : null,
      send:
        row.status === "ready" &&
        row.materialMode !== "tools" &&
        (image ? acceptsImages(imageInput) : true),
    };
  });
}
