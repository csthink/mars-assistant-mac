import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { ExtractionQueue } from "../../src/service/extraction";
import { decodeText } from "../../src/service/extract";
import {
  attachmentTextLimit,
  type Attachment,
  type Reply,
} from "../../src/shared/protocol";
import { damagedPdf, encryptedPdf, noTextPdf, textPdf } from "./samples";

mkdirSync(".test-data/disposable", { recursive: true });
const workerFile = resolve("src/service/extract.ts");
const execArgv = ["--import", "tsx"];
function root() {
  return mkdtempSync(resolve(".test-data/disposable/extraction-"));
}
function files() {
  return mkdtempSync(resolve(".test-data/disposable/user-files-extract-"));
}
function seed(store: Store) {
  const conversationId = randomUUID();
  assert.equal(
    store.execute({ type: "create", id: conversationId }, "main").ok,
    true,
  );
  return conversationId;
}
function importFile(store: Store, conversationId: string, path: string) {
  const attachmentId = randomUUID();
  const reply = store.execute(
    {
      type: "importAttachment",
      conversationId,
      attachmentId,
      path,
      name: path.split("/").pop()!,
    },
    "main",
    "host",
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return attachmentId;
}
/** Runs the queue until nothing is importing any more, collecting every update it reports. */
async function drain(store: Store, timeoutMs = 30_000) {
  const updates: Reply[] = [];
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error("extraction did not settle")),
      60_000,
    );
    const queue = new ExtractionQueue(
      store,
      { workerFile, execArgv, timeoutMs },
      (reply) => {
        updates.push(reply);
        if (!store.pendingExtractions().length) {
          clearTimeout(timer);
          queue.close();
          done();
        }
      },
    );
    queue.schedule();
  });
  return updates;
}
function row(store: Store, id: string): Attachment {
  const found = store.snapshot().attachments.find((a) => a.id === id);
  assert.ok(found, "attachment missing");
  return found;
}

test("严格 UTF-8 解码：BOM 去除、NUL 与非法序列拒绝、超过 2 MiB 字符拒绝", () => {
  assert.deepEqual(decodeText(Buffer.from("﻿你好，世界")), {
    ok: true,
    text: "你好，世界",
    pages: null,
  });
  assert.deepEqual(decodeText(Buffer.from([0xff, 0xfe, 0x41])), {
    ok: false,
    reason: "decode_failed",
  });
  assert.deepEqual(decodeText(Buffer.from("abc\0def")), {
    ok: false,
    reason: "decode_failed",
  });
  assert.deepEqual(decodeText(Buffer.alloc(attachmentTextLimit + 1, 0x61)), {
    ok: false,
    reason: "text_too_long",
  });
});

test("受限 worker 提取：文本、Markdown、文本 PDF 可用；加密、损坏、无文本、解码失败分别归因；预览返回前 4000 字符", async () => {
  const dir = root(),
    user = files();
  const store = new Store(dir);
  try {
    const conversationId = seed(store);
    writeFileSync(join(user, "说明.txt"), "第一行\n第二行 with ASCII");
    writeFileSync(join(user, "notes.md"), "﻿# 标题\n\n正文");
    writeFileSync(join(user, "report.pdf"), textPdf("Hello PDF (world)", 2));
    writeFileSync(join(user, "locked.pdf"), encryptedPdf());
    writeFileSync(join(user, "broken.pdf"), damagedPdf());
    writeFileSync(join(user, "scan.pdf"), noTextPdf());
    writeFileSync(join(user, "latin1.txt"), Buffer.from([0xc4, 0xe9, 0x20]));
    writeFileSync(join(user, "long.txt"), "x".repeat(4500));
    const ids = Object.fromEntries(
      ["说明.txt", "notes.md", "report.pdf", "locked.pdf", "broken.pdf"].map(
        (name) => [name, importFile(store, conversationId, join(user, name))],
      ),
    );
    assert.equal(store.pendingExtractions().length, 5);
    for (const id of Object.values(ids))
      assert.equal(row(store, id).status, "importing");
    const updates = await drain(store);
    assert.equal(updates.length, 5);
    assert.ok(updates.every((u) => u.ok));
    const text = row(store, ids["说明.txt"]);
    assert.deepEqual(
      [text.status, text.chars, text.pages],
      ["ready", "第一行\n第二行 with ASCII".length, null],
    );
    const md = row(store, ids["notes.md"]);
    assert.deepEqual([md.status, md.chars], ["ready", "# 标题\n\n正文".length]);
    const pdf = row(store, ids["report.pdf"]);
    assert.deepEqual([pdf.status, pdf.pages], ["ready", 2]);
    assert.equal(pdf.chars, "Hello PDF (world)\nHello PDF (world)".length);
    assert.deepEqual(
      [
        row(store, ids["locked.pdf"]).reason,
        row(store, ids["broken.pdf"]).reason,
      ],
      ["encrypted", "damaged"],
    );
    for (const id of [ids["locked.pdf"], ids["broken.pdf"], ids["notes.md"]])
      store.execute(
        { type: "removeDraftAttachment", conversationId, attachmentId: id },
        "main",
      );
    const second = Object.fromEntries(
      ["scan.pdf", "latin1.txt", "long.txt"].map((name) => [
        name,
        importFile(store, conversationId, join(user, name)),
      ]),
    );
    await drain(store);
    assert.equal(row(store, second["scan.pdf"]).reason, "no_text");
    assert.equal(row(store, second["latin1.txt"]).reason, "decode_failed");
    // Preview: first 4000 characters and the full count.
    const preview = store.execute(
      { type: "readAttachmentPreview", attachmentId: second["long.txt"] },
      "main",
    );
    assert.equal(preview.ok, true);
    if (preview.ok) {
      assert.equal(preview.preview?.text.length, 4000);
      assert.equal(preview.preview?.chars, 4500);
    }
    const missing = store.execute(
      { type: "readAttachmentPreview", attachmentId: randomUUID() },
      "main",
    );
    assert.equal(missing.ok, false);
    // Extracted text lives in the business database, never in the copy directory.
    assert.equal(
      (
        store.db
          .prepare("SELECT text FROM attachment_texts WHERE attachment_id=?")
          .get(ids["report.pdf"]) as { text: string }
      ).text,
      "Hello PDF (world)\nHello PDF (world)",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("超过 500 页或 2 MiB 字符的 PDF 与文本按超限拒绝；超时终止 worker 后队列继续；重启后仍在提取中的资料被重新排队", async () => {
  const dir = root(),
    user = files();
  let store = new Store(dir);
  try {
    const conversationId = seed(store);
    writeFileSync(join(user, "many.pdf"), textPdf("p", 501));
    writeFileSync(
      join(user, "huge.txt"),
      Buffer.alloc(attachmentTextLimit + 1, 0x62),
    );
    const many = importFile(store, conversationId, join(user, "many.pdf"));
    const huge = importFile(store, conversationId, join(user, "huge.txt"));
    await drain(store);
    assert.equal(row(store, many).reason, "text_too_long");
    assert.equal(row(store, huge).reason, "text_too_long");
    for (const id of [many, huge])
      store.execute(
        { type: "removeDraftAttachment", conversationId, attachmentId: id },
        "main",
      );
    // A deadline of one millisecond cannot be met by any worker; the row settles as a timeout and the next item still runs.
    writeFileSync(join(user, "slow.txt"), "will time out");
    writeFileSync(join(user, "after.txt"), "runs afterwards");
    const slow = importFile(store, conversationId, join(user, "slow.txt"));
    const updates = await drain(store, 1);
    assert.equal(row(store, slow).reason, "extraction_timeout");
    assert.ok(updates.length >= 1);
    store.execute(
      { type: "removeDraftAttachment", conversationId, attachmentId: slow },
      "main",
    );
    const after = importFile(store, conversationId, join(user, "after.txt"));
    await drain(store);
    assert.equal(row(store, after).status, "ready");
    // Imported but never extracted (for example the service died): a fresh process picks it up.
    writeFileSync(join(user, "later.txt"), "extracted after restart");
    const later = importFile(store, conversationId, join(user, "later.txt"));
    assert.equal(row(store, later).status, "importing");
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.pendingExtractions().map((p) => p.id),
      [later],
    );
    await drain(store);
    assert.deepEqual(
      [row(store, later).status, row(store, later).chars],
      ["ready", "extracted after restart".length],
    );
    // A late outcome for a row that was removed meanwhile is ignored rather than resurrected.
    const ghost = store.execute(
      {
        type: "reportExtraction",
        attachmentId: randomUUID(),
        outcome: { ok: true, text: "ghost", pages: null },
      },
      "main",
      "host",
    );
    assert.equal(ghost.ok, true);
    assert.equal(store.snapshot().attachments.length, 2);
    // Renderer origin cannot report extraction outcomes.
    assert.equal(
      store.execute(
        {
          type: "reportExtraction",
          attachmentId: later,
          outcome: { ok: false, reason: "damaged" },
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(row(store, later).status, "ready");
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true, force: true });
  }
});
