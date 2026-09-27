/** Read dimensions before any decoder allocation. No image code executes here. */
export function widgetImagePixels(bytes: Buffer, type: string): number {
  let width = 0,
    height = 0;
  if (type === "image/png") {
    if (
      bytes.length < 45 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("控件 PNG 结构无效。");
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    let offset = 8,
      end = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const name = bytes.toString("ascii", offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || name === "acTL")
        throw new Error("控件图片不支持动画或损坏的块。");
      offset += length + 12;
      if (name === "IEND") {
        end = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!end) throw new Error("控件 PNG 结构无效。");
  } else if (type === "image/jpeg") {
    if (
      bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
    )
      throw new Error("控件 JPEG 结构无效。");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error("控件 JPEG 结构无效。");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length)
        throw new Error("控件 JPEG 结构无效。");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || width) throw new Error("控件 JPEG 尺寸字段无效。");
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
    }
  }
  if (
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    width * height > 4194304
  )
    throw new Error("控件图片尺寸超过限制。");
  return width * height;
}
