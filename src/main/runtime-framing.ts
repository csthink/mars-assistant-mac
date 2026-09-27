/**
 * Strict JSON-RPC frame parser for the Runtime Contract transport ("传输与消息边界").
 * A recursive-descent reader checks duplicate keys, depth and member counts while
 * parsing; JSON.parse would silently keep the last duplicate. Bytes accumulate to LF
 * and the frame limit applies to the unfinished buffer, so an endless line never
 * grows past it. Ported from the cross-language experiment (OD-281) framing.mts.
 */
import type { RuntimeLimits } from "../shared/runtime-host";

export class FrameError extends Error {
  rpcCode: number;
  /** An oversized frame closes the protocol connection; other rejections only drop the frame. */
  close: boolean;
  constructor(rpcCode: number, message: string, close = false) {
    super(message);
    this.rpcCode = rpcCode;
    this.close = close;
  }
}
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

class Reader {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly limits: RuntimeLimits,
  ) {}
  get offset() {
    return this.i;
  }
  fail(message: string): never {
    throw new FrameError(-32700, message + " at offset " + this.i);
  }
  ws() {
    while (this.i < this.s.length && " \t\r\n".includes(this.s[this.i]))
      this.i++;
  }
  value(depth: number): JsonValue {
    if (depth > this.limits.depth)
      throw new FrameError(-32600, "depth exceeds " + this.limits.depth);
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') return this.string();
    if (c === "t" && this.s.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (c === "f" && this.s.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    if (c === "n" && this.s.startsWith("null", this.i)) {
      this.i += 4;
      return null;
    }
    if (c === "N" || c === "I" || (c === "-" && this.s[this.i + 1] === "I"))
      this.fail("NaN or Infinity is not JSON");
    return this.number();
  }
  object(depth: number) {
    const out: { [key: string]: JsonValue } = {};
    const keys = new Set<string>();
    this.i++;
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail("object key must be a string");
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ":") this.fail("missing colon");
      this.i++;
      if (keys.has(key)) this.fail("duplicate key " + key);
      keys.add(key);
      if (keys.size > this.limits.members)
        throw new FrameError(
          -32600,
          "object exceeds " + this.limits.members + " members",
        );
      out[key] = this.value(depth + 1);
      this.ws();
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      this.fail("expected , or }");
    }
  }
  array(depth: number) {
    const out: JsonValue[] = [];
    this.i++;
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      if (out.length > this.limits.members)
        throw new FrameError(
          -32600,
          "array exceeds " + this.limits.members + " members",
        );
      this.ws();
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      this.fail("expected , or ]");
    }
  }
  string() {
    this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("unterminated string");
      const c = this.s[this.i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        if (e === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("bad unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else {
          const map: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!(e in map)) this.fail("bad escape");
          out += map[e];
        }
      } else {
        if (c.charCodeAt(0) < 0x20) this.fail("control character in string");
        out += c;
      }
    }
  }
  number() {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(
      this.s.slice(this.i),
    );
    if (!m) this.fail("unexpected token");
    // A literal beyond binary64 would read as Infinity: outside I-JSON, like NaN and Infinity.
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail("number out of binary64 range");
    this.i += m[0].length;
    return n;
  }
}

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string;
  method: string;
  params?: { [key: string]: JsonValue };
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | null;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}
export type Frame = RpcRequest | RpcResponse;

function utf8(raw: Buffer): string {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)
    throw new FrameError(-32700, "BOM is not allowed");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new FrameError(-32700, "invalid UTF-8");
  }
}
function whole(text: string, limits: RuntimeLimits): JsonValue {
  const reader = new Reader(text, limits);
  const value = reader.value(1);
  reader.ws();
  if (reader.offset !== text.length) reader.fail("trailing characters");
  return value;
}
/**
 * Parses one JSON document with the frame reader's strictness: UTF-8 without BOM, no
 * duplicate key (the Contract refuses them before an RFC 8785 digest), no NaN or
 * Infinity token, and the depth and member limits. For package members whose RFC 8785
 * digest another implementation recomputes; JSON.parse would keep the last duplicate
 * and replace invalid UTF-8 silently.
 */
export function parseJsonDocument(raw: Buffer, limits: RuntimeLimits): unknown {
  return whole(utf8(raw), limits);
}
/** Parses one LF-terminated frame (without the LF); every rejection happens before dispatch. */
export function parseFrame(raw: Buffer, limits: RuntimeLimits): Frame {
  if (raw.length + 1 > limits.frameBytes)
    throw new FrameError(
      -32600,
      "frame exceeds " + limits.frameBytes + " bytes",
      true,
    );
  const text = utf8(raw);
  if (text.includes("\n") || text.includes("\r"))
    throw new FrameError(-32700, "unescaped newline inside a frame");
  const value = whole(text, limits);
  if (Array.isArray(value))
    throw new FrameError(-32600, "batch or top-level array is not accepted");
  if (value === null || typeof value !== "object")
    throw new FrameError(-32600, "frame is not a JSON object");
  if (value.jsonrpc !== "2.0")
    throw new FrameError(-32600, 'jsonrpc must be "2.0"');
  if ("method" in value) {
    if (typeof value.method !== "string")
      throw new FrameError(-32600, "method must be a string");
    if (
      "params" in value &&
      (value.params === null ||
        typeof value.params !== "object" ||
        Array.isArray(value.params))
    )
      throw new FrameError(-32600, "params must be an object");
    if ("id" in value && typeof value.id !== "string")
      throw new FrameError(-32600, "request id must be a string");
    return value as unknown as RpcRequest;
  }
  if ("result" in value === "error" in value)
    throw new FrameError(
      -32600,
      "a response carries exactly one of result or error",
    );
  if (!("id" in value)) throw new FrameError(-32600, "response without id");
  if (value.id !== null && typeof value.id !== "string")
    throw new FrameError(-32600, "response id must be a string or null");
  return value as unknown as RpcResponse;
}

export interface LinePiece {
  raw: Buffer | null;
  error: FrameError | null;
}
/** Accumulates bytes to LF; an overflowing line is dropped up to its LF and reported once. */
export class LineReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflow = false;
  constructor(private readonly limits: RuntimeLimits) {}
  feed(chunk: Buffer): LinePiece[] {
    const out: LinePiece[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const piece = chunk.subarray(start, i);
      start = i + 1;
      if (this.overflow) {
        this.overflow = false;
        continue;
      }
      const total = this.size + piece.length;
      const raw = this.size
        ? Buffer.concat([...this.chunks, piece])
        : Buffer.from(piece);
      this.chunks = [];
      this.size = 0;
      if (total + 1 > this.limits.frameBytes) {
        out.push({
          raw: null,
          error: new FrameError(
            -32600,
            "frame exceeds " + this.limits.frameBytes + " bytes",
            true,
          ),
        });
        continue;
      }
      out.push({ raw, error: null });
    }
    if (start < chunk.length && !this.overflow) {
      const rest = chunk.subarray(start);
      this.chunks.push(Buffer.from(rest));
      this.size += rest.length;
      if (this.size + 1 > this.limits.frameBytes) {
        this.chunks = [];
        this.size = 0;
        this.overflow = true;
        out.push({
          raw: null,
          error: new FrameError(
            -32600,
            "frame exceeds " +
              this.limits.frameBytes +
              " bytes before its LF arrived",
            true,
          ),
        });
      }
    }
    return out;
  }
}
/** Compact single-line encoding; string newlines are escaped by JSON.stringify. */
export function encodeFrame(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}
