import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SecretFailure } from "../shared/protocol";

/** The subset of Electron safeStorage the vault relies on; tests inject a stub. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}
export class VaultError extends Error {
  constructor(
    public code: SecretFailure,
    message: string,
  ) {
    super(message);
  }
}
interface VaultFile {
  version: 1;
  secrets: Record<string, string>;
}
const reference =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Encrypted API secrets outside the business root. The business database only
 * holds random references; plaintext exists in host memory during a single call.
 */
export class Vault {
  readonly file: string;
  private secrets = new Map<string, string>();
  private unreadable: string | null = null;
  constructor(
    readonly directory: string,
    private cipher: Cipher,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "vault.json");
    this.load();
  }
  private load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as VaultFile;
      if (
        parsed.version !== 1 ||
        !parsed.secrets ||
        typeof parsed.secrets !== "object"
      )
        throw new Error("unexpected vault layout");
      for (const [ref, value] of Object.entries(parsed.secrets)) {
        if (!reference.test(ref) || typeof value !== "string")
          throw new Error("unexpected vault entry");
        this.secrets.set(ref, value);
      }
    } catch {
      // Never overwrite a file we cannot interpret; refuse writes instead.
      this.unreadable =
        "密钥存储文件无法读取。应用没有改写它，请恢复备份或移走该文件后重试。";
      this.secrets.clear();
    }
  }
  available() {
    return this.unreadable === null && this.cipher.isEncryptionAvailable();
  }
  keys() {
    return [...this.secrets.keys()];
  }
  has(ref: string) {
    return this.secrets.has(ref);
  }
  private guard() {
    if (this.unreadable)
      throw new VaultError("VAULT_UNREADABLE", this.unreadable);
    if (!this.cipher.isEncryptionAvailable())
      throw new VaultError(
        "ENCRYPTION_UNAVAILABLE",
        "系统加密不可用，密钥未保存。请确认 macOS 钥匙串可用后重试。",
      );
  }
  private persist() {
    const body: VaultFile = {
      version: 1,
      secrets: Object.fromEntries(this.secrets),
    };
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } catch {
      rmSync(temporary, { force: true });
      throw new VaultError(
        "VAULT_WRITE_FAILED",
        "密钥存储写入失败，密钥未保存。请检查磁盘与目录权限。",
      );
    }
  }
  /** Encrypts and durably stores the secret, verifying the round trip before returning its reference. */
  save(secret: string): string {
    this.guard();
    const ref = randomUUID();
    const encrypted = this.cipher.encryptString(secret).toString("base64");
    const previous = new Map(this.secrets);
    this.secrets.set(ref, encrypted);
    try {
      this.persist();
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as VaultFile;
      if (
        this.cipher.decryptString(
          Buffer.from(stored.secrets[ref], "base64"),
        ) !== secret
      )
        throw new Error("round trip mismatch");
    } catch (error) {
      this.secrets = previous;
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        "VAULT_WRITE_FAILED",
        "密钥写入后校验失败，密钥未保存。",
      );
    }
    return ref;
  }
  /** Decrypts for a single transport call; callers must not persist or log the result. */
  read(ref: string): string {
    this.guard();
    const value = this.secrets.get(ref);
    if (value === undefined)
      throw new VaultError(
        "INVALID_SECRET",
        "该连接的密钥不存在，请重新填写。",
      );
    return this.cipher.decryptString(Buffer.from(value, "base64"));
  }
  remove(ref: string) {
    if (!this.secrets.has(ref)) return;
    this.guardWritable();
    const previous = new Map(this.secrets);
    this.secrets.delete(ref);
    try {
      this.persist();
    } catch (error) {
      this.secrets = previous;
      throw error;
    }
  }
  /** Drops every stored secret whose reference is not in the given set. */
  retain(refs: Iterable<string>) {
    const keep = new Set(refs);
    const orphans = this.keys().filter((ref) => !keep.has(ref));
    if (!orphans.length) return [];
    this.guardWritable();
    const previous = new Map(this.secrets);
    for (const ref of orphans) this.secrets.delete(ref);
    try {
      this.persist();
    } catch (error) {
      this.secrets = previous;
      throw error;
    }
    return orphans;
  }
  private guardWritable() {
    if (this.unreadable)
      throw new VaultError("VAULT_UNREADABLE", this.unreadable);
  }
}
