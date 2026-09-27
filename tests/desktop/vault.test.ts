import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Vault, VaultError, type Cipher } from "../../src/main/vault";

mkdirSync(".test-data/disposable", { recursive: true });
function root() {
  return mkdtempSync(resolve(".test-data/disposable/vault-"));
}
// Reversible stand-in for safeStorage: output bytes never equal the plaintext.
function cipher(available = true): Cipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) =>
      Buffer.from(Buffer.from(plain, "utf8").map((byte) => byte ^ 0x5a)),
    decryptString: (encrypted) =>
      Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString("utf8"),
  };
}
const secret = "test-secret-甲-7f3a";

test("保存、读取、重启读回；文件无明文且权限 0600", () => {
  const dir = root();
  try {
    const vault = new Vault(join(dir, "vault"), cipher());
    const ref = vault.save(secret);
    assert.match(ref, /^[0-9a-f-]{36}$/);
    assert.equal(vault.read(ref), secret);
    assert.deepEqual(vault.keys(), [ref]);
    const bytes = readFileSync(vault.file);
    assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false);
    assert.equal(statSync(vault.file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "vault")).mode & 0o777, 0o700);
    const reopened = new Vault(join(dir, "vault"), cipher());
    assert.equal(reopened.read(ref), secret);
    assert.throws(
      () => reopened.read("00000000-0000-4000-8000-000000000000"),
      (error: unknown) =>
        error instanceof VaultError && error.code === "INVALID_SECRET",
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("加密不可用时拒绝保存，不建立文件", () => {
  const dir = root();
  try {
    const vault = new Vault(join(dir, "vault"), cipher(false));
    assert.equal(vault.available(), false);
    assert.throws(
      () => vault.save(secret),
      (error: unknown) =>
        error instanceof VaultError && error.code === "ENCRYPTION_UNAVAILABLE",
    );
    assert.equal(existsSync(vault.file), false);
    assert.deepEqual(vault.keys(), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("移除单个引用与保留集合清理孤立引用", () => {
  const dir = root();
  try {
    const vault = new Vault(join(dir, "vault"), cipher());
    const kept = vault.save("keep");
    const removed = vault.save("remove");
    const orphan = vault.save("orphan");
    vault.remove(removed);
    assert.equal(vault.has(removed), false);
    vault.remove(removed);
    assert.deepEqual(vault.retain([kept]), [orphan]);
    assert.deepEqual(vault.retain([kept]), []);
    assert.deepEqual(new Vault(join(dir, "vault"), cipher()).keys(), [kept]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("无法解析的存储文件不被改写，写入被拒绝", () => {
  const dir = root();
  try {
    mkdirSync(join(dir, "vault"));
    writeFileSync(join(dir, "vault", "vault.json"), "{not json");
    const vault = new Vault(join(dir, "vault"), cipher());
    assert.equal(vault.available(), false);
    assert.throws(
      () => vault.save(secret),
      (error: unknown) =>
        error instanceof VaultError && error.code === "VAULT_UNREADABLE",
    );
    assert.deepEqual(vault.retain([]), []);
    assert.deepEqual(vault.keys(), []);
    assert.equal(readFileSync(vault.file, "utf8"), "{not json");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
