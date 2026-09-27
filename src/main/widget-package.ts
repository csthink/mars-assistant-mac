import { widgetImagePixels } from "./widget-image";
import { createHash } from "node:crypto";
import { parse, type Node } from "acorn";
import {
  freezeWidget,
  validWidgetValue,
  widgetKey,
  widgetLimits,
  type BuiltWidget,
  type WidgetField,
  type WidgetPackage,
} from "../shared/widget";
export class WidgetPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetPackageError";
  }
}
function fail(message: string): never {
  throw new WidgetPackageError(message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("控件包字段必须是对象。");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const v = object(value);
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail("控件包包含缺失或未知字段。");
  return v;
}
function text(
  value: unknown,
  limit: number,
  nonempty = false,
): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= limit &&
    (!nonempty || value.trim().length > 0) &&
    !value.includes("\u0000")
  );
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit)
    fail("控件包列表缺失或超过数量限制。");
  return value;
}
/** Iterative walk bounds work and avoids trusting property names or recursive traversal. */
function walk(
  node: Node,
  visit: (node: Node & Record<string, unknown>) => void,
) {
  const pending: unknown[] = [node];
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (++count > 150_000) fail("控件包语法结构过于复杂。");
    const record = item as Node & Record<string, unknown>;
    if (typeof record.type === "string") visit(record);
    for (const [key, value] of Object.entries(record)) {
      if (key === "start" || key === "end") continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
}
function rejectDuplicateJSON(source: string) {
  const tree = parse(`(${source})`, { ecmaVersion: 2025 });
  walk(tree, (node) => {
    if (node.type !== "ObjectExpression") return;
    const keys = new Set<string>();
    for (const prop of node.properties as { key: { value: string } }[]) {
      const name = prop.key.value;
      if (keys.has(name)) fail("控件包包含重复字段。");
      keys.add(name);
    }
  });
}
export function parseWidgetPackage(source: string): WidgetPackage {
  if (!text(source, widgetLimits.packageBytes, true))
    fail("控件包为空或超过 1 MiB。");
  let value: unknown;
  try {
    value = JSON.parse(source);
    rejectDuplicateJSON(source);
  } catch (error) {
    if (error instanceof WidgetPackageError) throw error;
    fail("控件包不是有效的 JSON。");
  }
  const p = exact(value, [
    "schemaVersion",
    "name",
    "view",
    "config",
    "draftFields",
    "capabilities",
    "resources",
  ]);
  if (p.schemaVersion !== 1) fail("不兼容的控件规范版本。");
  if (!text(p.name, 160, true)) fail("控件名称为空或过长。");
  const view = exact(p.view, ["html", "css", "js"]);
  if (
    ![view.html, view.css, view.js].every((v) =>
      text(v, widgetLimits.fileBytes),
    )
  )
    fail("视图资源格式错误或超过限制。");
  try {
    const tree = parse(view.js as string, {
      ecmaVersion: 2025,
      sourceType: "module",
    });
    walk(tree, (node) => {
      if (node.type.startsWith("Import") || node.type.startsWith("Export"))
        fail("控件不能导入依赖或导出模块。");
    });
  } catch (error) {
    if (error instanceof WidgetPackageError) throw error;
    fail("控件 JavaScript 语法错误。");
  }
  const config = array(p.config, widgetLimits.fields);
  const fields = new Set<string>();
  for (const value of config) {
    const f = exact(value, ["id", "label", "type", "default"]);
    if (!widgetKey(f.id) || fields.has(f.id) || !text(f.label, 160, true))
      fail("配置字段身份重复或无效。");
    fields.add(f.id);
    if (!validWidgetValue(f as unknown as WidgetField, f.default))
      fail("配置默认值与声明类型不一致。");
  }
  const drafts = array(p.draftFields, widgetLimits.fields);
  if (!drafts.every(widgetKey) || new Set(drafts).size !== drafts.length)
    fail("草稿字段身份重复或无效。");
  const caps = array(p.capabilities, 4);
  if (
    !caps.every((c) =>
      ["data.read", "data.write", "draft.write", "config.read"].includes(
        c as string,
      ),
    ) ||
    new Set(caps).size !== caps.length
  )
    fail("控件声明了尚未交付的能力。");
  const paths = new Set<string>();
  for (const value of array(p.resources, widgetLimits.resources)) {
    const asset = exact(value, ["path", "type", "data"]);
    if (
      typeof asset.path !== "string" ||
      !/^assets\/[a-z0-9][a-z0-9_-]{0,63}\.(png|jpg)$/.test(asset.path) ||
      paths.has(asset.path)
    )
      fail("资源路径无效、重复或越界。");
    paths.add(asset.path);
    if (
      asset.type !== (asset.path.endsWith(".png") ? "image/png" : "image/jpeg")
    )
      fail("资源类型与路径不一致。");
    if (
      typeof asset.data !== "string" ||
      asset.data.length > widgetLimits.fileBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        asset.data,
      )
    )
      fail("图片资源编码无效或超过限制。");
    const bytes = Buffer.from(asset.data, "base64");
    if (!bytes.length || bytes.toString("base64") !== asset.data)
      fail("图片资源编码无效。");
    // Dimensions are checked before the sandboxed Chromium decoder is reached.
    if (
      asset.type === "image/png"
        ? bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        : bytes.subarray(0, 3).toString("hex") !== "ffd8ff"
    )
      fail("图片资源内容与声明不一致。");
  }
  let pixels = 0;
  for (const asset of p.resources as WidgetPackage["resources"]) {
    try {
      pixels += widgetImagePixels(
        Buffer.from(asset.data, "base64"),
        asset.type,
      );
    } catch {
      fail("控件图片结构或尺寸无效。");
    }
  }
  if (pixels > 4194304) fail("控件图片总像素超过限制。");
  return value as WidgetPackage;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function payload(manifest: WidgetPackage, resources: BuiltWidget["resources"]) {
  return JSON.stringify({
    format: "csthink-widget-build-1",
    manifest,
    resources,
  });
}
/** Fixed assembly only. It does not evaluate generated JavaScript, HTML, CSS, or package commands. */
export function buildWidgetPackage(source: string): BuiltWidget {
  const manifest = parseWidgetPackage(source);
  const resources: BuiltWidget["resources"] = Object.create(null);
  const put = (path: string, type: string, body: string) => {
    resources[path] = { type, data: Buffer.from(body).toString("base64") };
  };
  put(
    "index.html",
    "text/html; charset=utf-8",
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/view.css"><script type="module" src="/view.js"></script></head><body>${manifest.view.html}</body></html>`,
  );
  put("view.css", "text/css; charset=utf-8", manifest.view.css);
  put("view.js", "text/javascript; charset=utf-8", manifest.view.js);
  for (const resource of manifest.resources)
    resources[resource.path] = { type: resource.type, data: resource.data };
  return freezeWidget({
    format: "csthink-widget-build-1",
    digest: hash(payload(manifest, resources)),
    manifest,
    resources,
  });
}
export function verifyBuiltWidget(build: BuiltWidget): boolean {
  try {
    if (
      build.format !== "csthink-widget-build-1" ||
      !/^[a-f0-9]{64}$/.test(build.digest)
    )
      return false;
    const canonical = buildWidgetPackage(JSON.stringify(build.manifest));
    return (
      canonical.digest === build.digest &&
      payload(build.manifest, build.resources) ===
        payload(canonical.manifest, canonical.resources)
    );
  } catch {
    return false;
  }
}
