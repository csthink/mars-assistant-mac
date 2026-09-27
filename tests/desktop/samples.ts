/**
 * Synthetic material for attachment tests. Everything here is generated in
 * code; no personal file is ever read by the test suite.
 */
const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** A valid 1 × 1 pixel PNG. */
export function pngSample() {
  return Buffer.from(png1x1, "base64");
}
/** The same PNG with its IHDR width and height patched; only the header is inspected. */
export function pngWithSize(width: number, height: number) {
  const bytes = pngSample();
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
/** A minimal JPEG header sequence: SOI, APP0, SOF0 with the given size, EOI. */
export function jpegSample(width = 2, height = 3) {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof0,
    Buffer.from([0xff, 0xd9]),
  ]);
}
function pdfObjects(objects: string[], trailerExtra = "") {
  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
/** A one-page PDF whose content stream draws the given ASCII text with Helvetica. */
export function textPdf(text: string, pages = 1) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (m) => `\\${m}`)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  return pdfObjects(objects);
}
/** A one-page PDF with no text at all, like a scanned page without OCR. */
export function noTextPdf() {
  const stream = "0 0 1 rg 100 100 200 200 re f";
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]);
}
/** A PDF whose trailer declares the standard security handler with unusable password digests. */
export function encryptedPdf() {
  const zeros = "0".repeat(64);
  return pdfObjects(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O <${zeros}> /U <${zeros}> >>`,
    ],
    " /Encrypt 4 0 R /ID [<01234567890123456789012345678901> <01234567890123456789012345678901>]",
  );
}
/** Starts like a PDF but has no usable structure. */
export function damagedPdf() {
  return Buffer.from("%PDF-1.7\nthis is not a pdf body at all\n", "latin1");
}
