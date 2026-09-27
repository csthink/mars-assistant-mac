import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import {
  attachmentSizeLimit,
  type Attachment,
  type HostCommand,
} from "../../src/shared/protocol";
import { jpegSample, pngSample, pngWithSize } from "./samples";

mkdirSync(".test-data/disposable", { recursive: true });
function root() {
  return mkdtempSync(resolve(".test-data/disposable/attachments-"));
}
/** A directory of synthetic user files outside the data root. */
function files() {
  return mkdtempSync(resolve(".test-data/disposable/user-files-"));
}
function seed(store: Store) {
  const conversationId = randomUUID(),
    connectionId = randomUUID();
  assert.equal(
    store.execute({ type: "create", id: conversationId }, "main").ok,
    true,
  );
  assert.equal(
    store.execute(
      {
        type: "upsertConnection",
        id: connectionId,
        name: "模拟连接",
        provider: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "test-model",
        secretRef: randomUUID(),
        imageInput: "declared" as const,
        contextChars: null,
        revision: 0,
      },
      "main",
    ).ok,
    true,
  );
  return { conversationId, connectionId };
}
function importFile(
  store: Store,
  conversationId: string,
  path: string,
  name = path.split("/").pop()!,
) {
  const attachmentId = randomUUID();
  const command: HostCommand = {
    type: "importAttachment",
    conversationId,
    attachmentId,
    path,
    name,
  };
  const reply = store.execute(command, "main", "host");
  return { reply, attachmentId };
}
function attachment(store: Store, id: string): Attachment {
  const row = store.snapshot().attachments.find((a) => a.id === id);
  assert.ok(row, "attachment missing from snapshot");
  return row;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("导入保存内容寻址副本并登记草稿附件；相同内容共享副本；移除后回收无引用的行与副本", () => {
  const dir = root(),
    user = files();
  let store = new Store(dir);
  try {
    const { conversationId } = seed(store);
    const png = pngSample();
    writeFileSync(join(user, "图 1.png"), png);
    writeFileSync(join(user, "copy.png"), png);
    writeFileSync(join(user, "photo.jpg"), jpegSample(640, 480));
    const first = importFile(store, conversationId, join(user, "图 1.png"));
    assert.equal(first.reply.ok, true, JSON.stringify(first.reply));
    const second = importFile(store, conversationId, join(user, "copy.png"));
    const third = importFile(store, conversationId, join(user, "photo.jpg"));
    assert.equal(second.reply.ok && third.reply.ok, true);
    const a = attachment(store, first.attachmentId);
    assert.equal(a.status, "ready");
    assert.equal(a.kind, "png");
    assert.equal(a.name, "图 1.png");
    assert.equal(a.size, png.length);
    assert.equal(a.sha256, sha(png));
    assert.deepEqual([a.width, a.height], [1, 1]);
    const j = attachment(store, third.attachmentId);
    assert.deepEqual([j.kind, j.width, j.height], ["jpeg", 640, 480]);
    // One copy per content; the copy is private to the owner and byte-identical to the original.
    const copies = readdirSync(join(dir, "attachments")).sort();
    assert.deepEqual(copies, [sha(png), sha(jpegSample(640, 480))].sort());
    assert.equal(
      statSync(join(dir, "attachments", sha(png))).mode & 0o777,
      0o600,
    );
    assert.equal(
      readFileSync(join(dir, "attachments", sha(png))).equals(png),
      true,
    );
    assert.deepEqual(
      store
        .snapshot()
        .draftAttachments.map((d) => [d.attachmentId, d.position]),
      [
        [first.attachmentId, 0],
        [second.attachmentId, 1],
        [third.attachmentId, 2],
      ],
    );
    // A retried import with the same id confirms without a second row.
    assert.equal(
      store.execute(
        {
          type: "importAttachment",
          conversationId,
          attachmentId: first.attachmentId,
          path: join(user, "图 1.png"),
          name: "图 1.png",
        },
        "main",
        "host",
      ).ok,
      true,
    );
    assert.equal(store.snapshot().attachments.length, 3);
    // Draft attachments survive a restart in order.
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.snapshot().draftAttachments.map((d) => d.attachmentId),
      [first.attachmentId, second.attachmentId, third.attachmentId],
    );
    // Removing one of two rows sharing a copy keeps the copy; removing the last drops it.
    assert.equal(
      store.execute(
        {
          type: "removeDraftAttachment",
          conversationId,
          attachmentId: first.attachmentId,
        },
        "panel",
      ).ok,
      true,
    );
    assert.equal(existsSync(join(dir, "attachments", sha(png))), true);
    assert.equal(
      store.execute(
        {
          type: "removeDraftAttachment",
          conversationId,
          attachmentId: second.attachmentId,
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(existsSync(join(dir, "attachments", sha(png))), false);
    assert.equal(
      (
        store.db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as {
          n: number;
        }
      ).n,
      1,
    );
    // Idempotent: removing the last one twice is accepted and leaves the directory empty.
    for (let i = 0; i < 2; i++)
      assert.equal(
        store.execute(
          {
            type: "removeDraftAttachment",
            conversationId,
            attachmentId: third.attachmentId,
          },
          "main",
        ).ok,
        true,
      );
    assert.deepEqual(readdirSync(join(dir, "attachments")), []);
    assert.deepEqual(store.snapshot().attachments, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true });
  }
});

test("限额与拒绝：第 6 个拒绝、未支持格式与文件头不符登记不可读、超过 20 MB 不复制、目录/符号链接/缺失文件拒绝、renderer 不能提交路径", () => {
  const dir = root(),
    user = files();
  const store = new Store(dir);
  try {
    const { conversationId } = seed(store);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(user, `p${i}.png`), pngSample());
      assert.equal(
        importFile(store, conversationId, join(user, `p${i}.png`)).reply.ok,
        true,
      );
    }
    writeFileSync(join(user, "p6.png"), pngSample());
    const sixth = importFile(store, conversationId, join(user, "p6.png"));
    assert.equal(sixth.reply.ok, false);
    if (!sixth.reply.ok) {
      assert.equal(sixth.reply.code, "CONFLICT");
      assert.match(sixth.reply.message, /最多 5 个/);
    }
    assert.equal(store.snapshot().draftAttachments.length, 5);
    for (let i = 0; i < 5; i++)
      store.execute(
        {
          type: "removeDraftAttachment",
          conversationId,
          attachmentId: store.snapshot().draftAttachments[0].attachmentId,
        },
        "main",
      );
    assert.deepEqual(readdirSync(join(dir, "attachments")), []);

    writeFileSync(join(user, "tool.exe"), "MZ binary");
    writeFileSync(join(user, "fake.png"), "not a png at all");
    writeFileSync(join(user, "fake.pdf"), "not a pdf");
    writeFileSync(join(user, "huge.png"), pngWithSize(9000, 10));
    const unsupported = importFile(
      store,
      conversationId,
      join(user, "tool.exe"),
    );
    const fakePng = importFile(store, conversationId, join(user, "fake.png"));
    const fakePdf = importFile(store, conversationId, join(user, "fake.pdf"));
    const huge = importFile(store, conversationId, join(user, "huge.png"));
    for (const r of [unsupported, fakePng, fakePdf, huge])
      assert.equal(r.reply.ok, true, JSON.stringify(r.reply));
    assert.deepEqual(
      [unsupported, fakePng, fakePdf, huge].map((r) => {
        const a = attachment(store, r.attachmentId);
        return [a.status, a.reason];
      }),
      [
        ["unreadable", "unsupported_format"],
        ["unreadable", "image_invalid"],
        ["unreadable", "unsupported_format"],
        ["unreadable", "image_too_large"],
      ],
    );
    // Unreadable files with no usable content leave no copy; the oversized image was copied but is unusable.
    assert.deepEqual(readdirSync(join(dir, "attachments")), [
      sha(pngWithSize(9000, 10)),
    ]);
    for (const r of [unsupported, fakePng, fakePdf, huge])
      store.execute(
        {
          type: "removeDraftAttachment",
          conversationId,
          attachmentId: r.attachmentId,
        },
        "main",
      );

    // Over the size limit: recorded as unreadable with the extension's kind, nothing copied.
    const big = join(user, "big.txt");
    writeFileSync(big, Buffer.alloc(attachmentSizeLimit + 1, 0x61));
    const bigPdf = join(user, "big.pdf");
    writeFileSync(
      bigPdf,
      Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(attachmentSizeLimit, 0x20),
      ]),
    );
    const tooLarge = importFile(store, conversationId, big);
    const tooLargePdf = importFile(store, conversationId, bigPdf);
    assert.equal(tooLarge.reply.ok && tooLargePdf.reply.ok, true);
    const bigRow = attachment(store, tooLarge.attachmentId);
    assert.deepEqual(
      [bigRow.status, bigRow.reason, bigRow.size, bigRow.kind],
      ["unreadable", "too_large", attachmentSizeLimit + 1, "text"],
    );
    const bigPdfRow = attachment(store, tooLargePdf.attachmentId);
    assert.deepEqual(
      [bigPdfRow.status, bigPdfRow.reason, bigPdfRow.kind],
      ["unreadable", "too_large", "pdf"],
    );
    assert.deepEqual(readdirSync(join(dir, "attachments")), []);
    for (const id of [tooLarge.attachmentId, tooLargePdf.attachmentId])
      store.execute(
        { type: "removeDraftAttachment", conversationId, attachmentId: id },
        "main",
      );

    // Directories, symlinks and missing files are refused; nothing is recorded.
    mkdirSync(join(user, "folder"));
    writeFileSync(join(user, "target.png"), pngSample());
    symlinkSync(join(user, "target.png"), join(user, "link.png"));
    const before = store.snapshot().revision;
    for (const path of [
      join(user, "folder"),
      join(user, "link.png"),
      join(user, "missing.png"),
    ]) {
      const r = importFile(store, conversationId, path, "x.png");
      assert.equal(r.reply.ok, false, path);
    }
    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(store.snapshot().attachments, []);

    // Paths never come from a renderer, and a relative or malformed path is not a command.
    for (const [command, origin] of [
      [
        {
          type: "importAttachment",
          conversationId,
          attachmentId: randomUUID(),
          path: join(user, "target.png"),
          name: "target.png",
        },
        "renderer",
      ],
      [
        {
          type: "importAttachment",
          conversationId,
          attachmentId: randomUUID(),
          path: "relative/target.png",
          name: "target.png",
        },
        "host",
      ],
      [
        {
          type: "importAttachment",
          conversationId,
          attachmentId: randomUUID(),
          path: join(user, "target.png"),
          name: "../target.png",
        },
        "host",
      ],
    ] as const) {
      const reply = store.execute(command, "main", origin);
      assert.equal(reply.ok, false);
      if (!reply.ok) assert.equal(reply.code, "INVALID_COMMAND");
    }
    assert.equal(
      importFile(store, randomUUID(), join(user, "target.png")).reply.ok,
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("只读取对话框给出的精确文件：父目录不可列出、同目录不可读兄弟文件不影响导入；原文件修改或删除后副本不变", () => {
  const dir = root(),
    user = files();
  const store = new Store(dir);
  const guarded = join(user, "guarded");
  mkdirSync(guarded);
  const original = Buffer.concat([pngSample(), Buffer.from("v1")]);
  writeFileSync(join(guarded, "chosen.png"), original);
  writeFileSync(join(guarded, "sibling.png"), pngSample());
  chmodSync(join(guarded, "sibling.png"), 0o000);
  // Execute-only: the directory cannot be listed, but a known name can still be opened.
  chmodSync(guarded, 0o100);
  try {
    assert.throws(() => readdirSync(guarded), /EACCES/);
    const { conversationId, connectionId } = seed(store);
    const chosen = importFile(
      store,
      conversationId,
      join(guarded, "chosen.png"),
    );
    assert.equal(chosen.reply.ok, true, JSON.stringify(chosen.reply));
    const row = attachment(store, chosen.attachmentId);
    assert.equal(row.status, "ready");
    assert.equal(row.sha256, sha(original));
    chmodSync(guarded, 0o700);
    // The original changes and then disappears; the copy is untouched.
    writeFileSync(join(guarded, "chosen.png"), pngWithSize(2, 2));
    assert.equal(
      readFileSync(join(dir, "attachments", row.sha256)).equals(original),
      true,
    );
    rmSync(join(guarded, "chosen.png"));
    assert.equal(attachment(store, chosen.attachmentId).sha256, sha(original));
    // Submitting moves the draft attachment onto the user message in the same transaction.
    const requestId = randomUUID();
    assert.equal(
      store.execute(
        {
          type: "submitTurn",
          requestId,
          conversationId,
          connectionId,
          text: "看看这张图",
        },
        "main",
      ).ok,
      true,
    );
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.draftAttachments, []);
    const message = snapshot.messages.find((m) => m.role === "user")!;
    assert.deepEqual(
      snapshot.messageAttachments.map((link) => ({ ...link })),
      [
        {
          messageId: message.id,
          attachmentId: chosen.attachmentId,
          position: 0,
        },
      ],
    );
    assert.equal(snapshot.attachments[0].sha256, sha(original));
    const submitted = snapshot.events.find((e) => e.kind === "submitted")!;
    assert.equal(submitted.payload.attachments, 1);
    // Removing a message-bound attachment from the draft is a no-op and keeps the copy.
    assert.equal(
      store.execute(
        {
          type: "removeDraftAttachment",
          conversationId,
          attachmentId: chosen.attachmentId,
        },
        "main",
      ).ok,
      true,
    );
    assert.equal(existsSync(join(dir, "attachments", row.sha256)), true);
    assert.equal(store.snapshot().messageAttachments.length, 1);
  } finally {
    chmodSync(guarded, 0o700);
    chmodSync(join(guarded, "sibling.png"), 0o600);
    store.close();
    rmSync(dir, { recursive: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("数据根校验：残留临时文件被清理，attachments 中的外来文件或符号链接拒绝打开且不改写", () => {
  const dir = root();
  const store = new Store(dir);
  store.close();
  try {
    mkdirSync(join(dir, "attachments"), { recursive: true });
    writeFileSync(join(dir, "attachments", `tmp-${randomUUID()}`), "half");
    const cleaned = new Store(dir);
    cleaned.close();
    assert.deepEqual(readdirSync(join(dir, "attachments")), []);
    writeFileSync(join(dir, "attachments", "notes.txt"), "keep me");
    assert.throws(() => new Store(dir), /非本应用副本/);
    assert.equal(
      readFileSync(join(dir, "attachments", "notes.txt"), "utf8"),
      "keep me",
    );
    rmSync(join(dir, "attachments", "notes.txt"));
    symlinkSync("/etc/hosts", join(dir, "attachments", "a".repeat(64)));
    assert.throws(() => new Store(dir), /非本应用副本/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
