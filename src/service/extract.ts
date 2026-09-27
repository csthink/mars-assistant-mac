import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  attachmentTextLimit,
  type AttachmentKind,
  type ExtractionOutcome,
} from "../shared/protocol";

/**
 * Restricted extraction worker. It receives one copy path and kind, has no
 * database, secret or network access, and reports a single outcome. The
 * business service enforces the memory limit and the deadline from outside.
 */
export const pdfPageLimit = 500;
interface Input {
  path: string;
  kind: Extract<AttachmentKind, "text" | "markdown" | "pdf">;
}
/** Strict UTF-8 without BOM; a NUL byte or an invalid sequence means the file is not text. */
export function decodeText(bytes: Uint8Array): ExtractionOutcome {
  if (bytes.includes(0)) return { ok: false, reason: "decode_failed" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return { ok: false, reason: "decode_failed" };
  }
  if (text.length > attachmentTextLimit)
    return { ok: false, reason: "text_too_long" };
  return { ok: true, text, pages: null };
}
export async function extractPdf(
  bytes: Uint8Array,
): Promise<ExtractionOutcome> {
  // PDF.js prints polyfill warnings while loading; this worker has nothing else to say.
  const silenced = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = console.warn = console.error = () => {};
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bundledWorker = join(__dirname, "pdf.worker.mjs");
    if (existsSync(bundledWorker))
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(bundledWorker).href;
  } finally {
    Object.assign(console, silenced);
  }
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages > pdfPageLimit)
      return { ok: false, reason: "text_too_long" };
    const parts: string[] = [];
    let length = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("");
      page.cleanup();
      length += text.length + 1;
      if (length > attachmentTextLimit)
        return { ok: false, reason: "text_too_long" };
      parts.push(text);
    }
    const text = parts.join("\n");
    if (!text.trim()) return { ok: false, reason: "no_text" };
    return { ok: true, text, pages: document.numPages };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "PasswordException") return { ok: false, reason: "encrypted" };
    return { ok: false, reason: "damaged" };
  } finally {
    await task.destroy().catch(() => {});
  }
}
export async function extract(input: Input): Promise<ExtractionOutcome> {
  const bytes = readFileSync(input.path);
  if (input.kind === "pdf") return extractPdf(new Uint8Array(bytes));
  return decodeText(new Uint8Array(bytes));
}
if (parentPort) {
  const input = workerData as Input;
  extract(input)
    .catch((): ExtractionOutcome => ({ ok: false, reason: "damaged" }))
    .then((outcome) => parentPort!.postMessage(outcome));
}
