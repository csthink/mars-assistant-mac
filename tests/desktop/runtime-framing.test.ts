import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FrameError,
  LineReader,
  encodeFrame,
  parseFrame,
  parseJsonDocument,
} from "../../src/main/runtime-framing";
import {
  canonicalJson,
  contractDigest,
  contractVersion,
  iJsonProblem,
  runtimeLimits,
} from "../../src/shared/runtime-host";

const limits = { ...runtimeLimits, frameBytes: 256, depth: 4, members: 4 };
function rejects(raw: string | Buffer, rpcCode: number, close = false) {
  const buffer = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  try {
    parseFrame(buffer, limits);
  } catch (error) {
    assert.ok(error instanceof FrameError, "FrameError expected");
    assert.equal(error.rpcCode, rpcCode, error.message);
    assert.equal(error.close, close, error.message);
    return error;
  }
  assert.fail("frame accepted: " + String(raw).slice(0, 60));
}

test("协议身份：常量与冻结 manifest 的原字节摘要一致，线上版本为 draft.5", () => {
  const manifest = readFileSync(
    resolve("contract/0.1.0/contract-manifest.json"),
  );
  assert.equal(
    createHash("sha256").update(manifest).digest("hex"),
    contractDigest,
  );
  assert.equal(contractVersion, "0.1.0-draft.5");
});

test("非法帧在派发前拒绝：BOM、无效 UTF-8、重复 key、batch、顶层数组、NaN、非对象 params、深度与成员超限、换行", () => {
  rejects(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"jsonrpc":"2.0","method":"runtime.health"}'),
    ]),
    -32700,
  );
  rejects(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), -32700);
  rejects('{"jsonrpc":"2.0","method":"a","method":"b"}', -32700);
  rejects('[{"jsonrpc":"2.0","method":"a"}]', -32600);
  rejects("[]", -32600);
  rejects('{"jsonrpc":"2.0","method":"a","params":{"n":NaN}}', -32700);
  rejects('{"jsonrpc":"2.0","method":"a","params":{"n":-Infinity}}', -32700);
  rejects('{"jsonrpc":"2.0","method":"a","params":[1]}', -32600);
  rejects('{"jsonrpc":"2.0","method":"a","params":null}', -32600);
  rejects(
    '{"jsonrpc":"2.0","method":"a","params":{"a":{"b":{"c":{"d":1}}}}}',
    -32600,
  );
  rejects(
    '{"jsonrpc":"2.0","method":"a","params":{"a":1,"b":2,"c":3,"d":4,"e":5}}',
    -32600,
  );
  rejects('{"jsonrpc":"2.0","method":"a","params":{"a":[1,2,3,4,5]}}', -32600);
  rejects('{"jsonrpc":"2.0","method":"a","params":{"s":"x\ny"}}', -32700);
  rejects('{"jsonrpc":"1.0","method":"a"}', -32600);
  rejects('{"jsonrpc":"2.0","id":7,"method":"a"}', -32600);
  rejects('{"jsonrpc":"2.0","id":"1","result":1,"error":{}}', -32600);
  rejects('{"jsonrpc":"2.0","id":"1"}', -32600);
  rejects('{"jsonrpc":"2.0","result":1}', -32600);
  rejects('{"jsonrpc":"2.0","method":"a"} x', -32700);
  rejects("null", -32600);
  rejects('"text"', -32600);
  rejects('{"jsonrpc":"2.0","method":"a","params":{"s":"\\x"}}', -32700);
  rejects('{"jsonrpc":"2.0","method":"a","params":{"s":"\u0001"}}', -32700);
});

test("超大帧关闭连接：完整帧超限与未换行累积超限都报告一次且标记 close", () => {
  const big =
    '{"jsonrpc":"2.0","method":"a","params":{"s":"' + "x".repeat(300) + '"}}';
  const error = rejects(big, -32600, true);
  assert.match(error.message, /exceeds 256 bytes/);
  const reader = new LineReader(limits);
  const first = reader.feed(Buffer.from("y".repeat(200)));
  assert.equal(first.length, 0);
  const second = reader.feed(Buffer.from("y".repeat(100)));
  assert.equal(second.length, 1);
  assert.equal(second[0].raw, null);
  assert.equal(second[0].error?.close, true);
  // The rest of the overflowing line up to its LF is dropped, the next line is read normally.
  const third = reader.feed(
    Buffer.from("y".repeat(50) + '\n{"jsonrpc":"2.0","method":"b"}\n'),
  );
  assert.equal(third.length, 1);
  assert.equal(third[0].error, null);
  const frame = parseFrame(third[0].raw!, limits);
  assert.equal("method" in frame ? frame.method : null, "b");
});

test("合法帧按 LF 切分且跨块累积；编码为单行紧凑 JSON", () => {
  const reader = new LineReader(limits);
  const a = encodeFrame({
    jsonrpc: "2.0",
    id: "h:1",
    method: "runtime.health",
    params: { s: "换行\n转义" },
  });
  const b = encodeFrame({ jsonrpc: "2.0", id: "h:1", result: { ok: true } });
  const joined = Buffer.concat([a, b]);
  const pieces = [
    ...reader.feed(joined.subarray(0, 10)),
    ...reader.feed(joined.subarray(10, 40)),
    ...reader.feed(joined.subarray(40)),
  ];
  assert.equal(pieces.length, 2);
  const request = parseFrame(pieces[0].raw!, limits);
  assert.ok("method" in request);
  assert.equal(request.params?.s, "换行\n转义");
  const response = parseFrame(pieces[1].raw!, limits);
  assert.ok("result" in response);
  assert.equal(a.subarray(0, a.length - 1).includes(0x0a), false);
});

test("RFC 8785：canonicalJson 与 RFC 8785 第 3.2.3 节示例、键排序示例及附录 B 数字向量逐字节一致；无规范形式的值由 iJsonProblem 拒绝；超出 binary64 的数字字面量在帧与文档中都拒绝", () => {
  const document = (text: string) =>
    parseJsonDocument(Buffer.from(text, "utf8"), runtimeLimits);
  // Section 3.2.3: escapes, non-ASCII, number forms and key order in one document.
  const sample = document(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      '"literals":[null,true,false]}',
  );
  const canonical =
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
    '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(canonicalJson(sample), canonical);
  assert.equal(
    Buffer.from(canonicalJson(sample), "utf8").toString("hex"),
    Buffer.from(canonical, "utf8").toString("hex"),
  );
  // Section 3.2.3 key sorting: by UTF-16 code unit, so the emoji sorts before U+FB33.
  const sorted = document(
    '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
      '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
      '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
  ) as Record<string, string>;
  // Read the order from the text: a JavaScript object would enumerate "1" first again.
  assert.deepEqual(
    [...canonicalJson(sorted).matchAll(/:"([^"]*)"/g)].map((m) => m[1]),
    [
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ],
  );
  assert.ok(canonicalJson(sorted).startsWith('{"\\r":"Carriage Return","1":'));
  // Appendix B: IEEE 754 binary64 bits and their RFC 8785 serialization.
  const vectors: [string, string][] = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];
  for (const [bits, text] of vectors) {
    const value = Buffer.from(bits, "hex").readDoubleBE(0);
    assert.equal(canonicalJson(value), text, bits);
    // The parser reads the canonical text back to the same binary64 value.
    assert.equal(document(`[${text}]`)?.toString(), [value].toString(), bits);
  }
  assert.throws(() => canonicalJson(NaN), /non-finite/);
  assert.throws(() => canonicalJson(Infinity), /non-finite/);
  // Outside I-JSON RFC 8785 has no canonical form: refused before a digest is compared.
  for (const value of [
    "\ud800",
    "x\udc00",
    { ["\ud83d"]: 1 },
    [{ a: "\ude00x" }],
  ])
    assert.match(iJsonProblem(value), /unpaired surrogate/);
  for (const value of [
    2 ** 53,
    -(2 ** 53),
    1e23,
    { maximum: 9007199254740993 },
    Infinity,
    // The section 3.2.3 sample itself carries 1E30: serializable, but outside the Contract digest domain.
    sample,
  ])
    assert.match(iJsonProblem(value), /outside ±\(2\^53 - 1\)/);
  for (const value of [
    sorted,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    0.5,
    "\ud83d\ude00",
    { "\u00f6": ["€", null, true] },
  ])
    assert.equal(iJsonProblem(value), "");
  // A number literal beyond binary64 would read as Infinity: refused in frames and documents alike.
  rejects('{"jsonrpc":"2.0","method":"a","params":{"n":1e999}}', -32700);
  rejects('{"jsonrpc":"2.0","method":"a","params":{"n":-1e400}}', -32700);
  // Strict document parse: the RFC 8785 input the Contract allows (no duplicate key, valid UTF-8, no BOM).
  for (const raw of [
    Buffer.from('{"a":1,"a":2}'),
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
    Buffer.from('{"a":NaN}'),
    Buffer.from('{"a":1e999}'),
    Buffer.from('{"a":1} x'),
  ])
    assert.throws(() => parseJsonDocument(raw, runtimeLimits), FrameError);
  // A pretty-printed document (newlines between tokens) is one document, unlike a frame.
  assert.deepEqual(document('{\n "a": [1,\n 2]\n}\n'), { a: [1, 2] });
});
