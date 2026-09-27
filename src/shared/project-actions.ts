import {
  unpairedSurrogate,
  validRef,
  type ProjectionAction,
  type ProjectionObject,
  type ProjectionPendingItem,
  type RuntimeOperation,
  type RuntimeProjection,
} from "./runtime-host";
export type FormValue = string | number | boolean;
export interface ActionForm {
  type: "object" | "string" | "integer" | "boolean" | "array";
  /** `type: ["<type>", "null"]`: null is a value of its own, distinct from leaving the field out. */
  nullable?: boolean;
  title: string;
  description: string;
  required: string[];
  properties: Record<string, ActionForm>;
  /** Array elements all take this form. */
  items?: ActionForm;
  minItems?: number;
  maxItems?: number;
  /** An object without fixed fields whose every entry takes this form (`additionalProperties` schema). */
  values?: ActionForm;
  minProperties?: number;
  maxProperties?: number;
  choices?: FormValue[];
  constant?: FormValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /**
   * JSON Schema pattern, shown to the person but never executed here: the Runtime validates
   * every payload against the negotiated schema (Contract: the domain's own checks are the
   * admission; the Host's field checks are not sufficient), so no schema regular expression
   * runs in the main process or the renderer.
   */
  pattern?: string;
}
/** Form limits: nesting depth, fields of one object, schema nodes in one form, entries of one array or map. */
export const formLimits = { depth: 5, fields: 32, nodes: 256, entries: 64 };
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const allowed = new Set([
  "$schema",
  "$id",
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);
const types = ["object", "string", "integer", "boolean", "array"];
const reservedKeys = ["__proto__", "constructor", "prototype"];
/** Payload schemas are JSON Schema draft-07 (Runtime Contract); another dialect fails closed. */
const draft07 = /^http:\/\/json-schema\.org\/draft-07\/schema#?$/;
/** The type a typeless enum or const implies when all its values share one primitive type. */
function impliedType(schema: Record<string, unknown>): unknown {
  const values = Array.isArray(schema.enum)
    ? schema.enum
    : "const" in schema
      ? [schema.const]
      : [];
  const kinds = new Set(
    values.map((v) =>
      typeof v === "string"
        ? "string"
        : typeof v === "boolean"
          ? "boolean"
          : Number.isSafeInteger(v)
            ? "integer"
            : "unsupported",
    ),
  );
  return kinds.size === 1 ? [...kinds][0] : undefined;
}
const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
function nodes(form: ActionForm): number {
  return (
    1 +
    Object.values(form.properties).reduce((sum, f) => sum + nodes(f), 0) +
    (form.items ? nodes(form.items) : 0) +
    (form.values ? nodes(form.values) : 0)
  );
}
/**
 * A deliberately bounded form subset of JSON Schema draft-07: objects with fixed fields, maps
 * (an `additionalProperties` schema and no fixed fields), arrays of one element form, strings,
 * integers, booleans, enums and constants, each optionally nullable as `["<type>", "null"]`.
 * Root `definitions` is ignored (OD-425 R3). Anything else, references, code, or a form
 * beyond formLimits fails closed with the reason.
 */
export function actionForm(schema: unknown): ActionForm {
  const form = build(schema, 0);
  if (nodes(form) > formLimits.nodes)
    throw Error(
      `输入格式超过表单复杂度上限（${formLimits.nodes} 个字段节点）。`,
    );
  return form;
}
function build(schema: unknown, depth: number): ActionForm {
  if (!record(schema)) throw Error("该操作的输入格式尚无可用表单。");
  // OD-425 R3: root `definitions` holds the capability's other action payload schemas.
  // It validates nothing by itself and the form follows no $ref (an unsupported keyword
  // here), so nothing the form renders reaches it and it is ignored.
  const unknown = Object.keys(schema).filter(
    (k) =>
      !allowed.has(k) &&
      !(depth === 0 && k === "definitions" && record(schema.definitions)),
  );
  if (unknown.length)
    throw Error(
      `该操作的输入格式使用了表单不支持的约束：${unknown.slice(0, 4).join("、")}。`,
    );
  if (depth > formLimits.depth)
    throw Error(`输入格式嵌套超过 ${formLimits.depth} 层。`);
  if (
    "$schema" in schema &&
    (depth > 0 ||
      typeof schema.$schema !== "string" ||
      !draft07.test(schema.$schema))
  )
    throw Error("输入格式不是 JSON Schema draft-07。");
  if (
    "$id" in schema &&
    (typeof schema.$id !== "string" || schema.$id.length > 1024)
  )
    throw Error("输入格式标识未核验。");
  let type = schema.type ?? impliedType(schema);
  let nullable = false;
  if (Array.isArray(type)) {
    // Only the nullable union of one supported type: ["<type>", "null"] in either order.
    const others = type.filter((t) => t !== "null");
    if (type.length !== 2 || others.length !== 1)
      throw Error("输入类型的联合只支持“某类型或空值”。");
    type = others[0];
    nullable = true;
  }
  if (!types.includes(String(type))) throw Error("该操作的输入类型尚不支持。");
  const out: ActionForm = {
    type: type as ActionForm["type"],
    title: typeof schema.title === "string" ? schema.title.slice(0, 256) : "",
    description:
      typeof schema.description === "string"
        ? schema.description.slice(0, 2048)
        : "",
    required: [],
    properties: {},
    ...(nullable ? { nullable } : {}),
  };
  const onlyFor = (keys: string[], kind: string, allowedHere: boolean) => {
    if (!allowedHere && keys.some((k) => k in schema))
      throw Error(
        `${keys.filter((k) => k in schema).join("、")} 只用于${kind}。`,
      );
  };
  onlyFor(["items", "minItems", "maxItems"], "数组", type === "array");
  onlyFor(
    ["properties", "required", "additionalProperties"],
    "对象",
    type === "object",
  );
  onlyFor(["minLength", "maxLength", "pattern"], "文本", type === "string");
  onlyFor(["minimum", "maximum"], "整数", type === "integer");
  if (type === "object") {
    if (schema.properties !== undefined && !record(schema.properties))
      throw Error("对象输入格式未核验。");
    const properties = record(schema.properties) ? schema.properties : {};
    const keys = Object.keys(properties);
    if (
      keys.length > formLimits.fields ||
      keys.some((k) => reservedKeys.includes(k))
    )
      throw Error("对象字段超过可用范围。");
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every(
          (k) => typeof k === "string" && keys.includes(k),
        ))
    )
      throw Error("必填字段未核验。");
    out.required = (schema.required as string[] | undefined) ?? [];
    out.properties = Object.fromEntries(
      keys.map((k) => [k, build(properties[k], depth + 1)]),
    );
    const extra = schema.additionalProperties;
    if (extra !== undefined && typeof extra !== "boolean") {
      // A map: every entry takes one form; mixing it with fixed fields is not a form this entry offers.
      if (keys.length)
        throw Error("对象同时声明固定字段与任意字段，表单不支持。");
      out.values = build(extra, depth + 1);
    }
    for (const key of ["minProperties", "maxProperties"] as const) {
      if (schema[key] === undefined) continue;
      if (!out.values) throw Error(`${key} 只用于任意字段对象。`);
      if (!count(schema[key])) throw Error("对象数量约束未核验。");
      out[key] = Number(schema[key]);
    }
  } else {
    onlyFor(["minProperties", "maxProperties"], "对象", false);
  }
  if (type === "array") {
    if (!record(schema.items)) throw Error("数组必须声明单一的元素格式。");
    out.items = build(schema.items, depth + 1);
    for (const key of ["minItems", "maxItems"] as const) {
      if (schema[key] === undefined) continue;
      if (!count(schema[key])) throw Error("数组项数约束未核验。");
      out[key] = Number(schema[key]);
    }
  }
  const low = out.minItems ?? out.minProperties ?? 0;
  const high = out.maxItems ?? out.maxProperties;
  if (high !== undefined && low > high) throw Error("数量约束的下限大于上限。");
  if (low > formLimits.entries)
    throw Error(`数量下限超过表单上限（${formLimits.entries} 项）。`);
  const primitive = (v: unknown): v is FormValue =>
    type === "string"
      ? typeof v === "string" && v.length <= 65536
      : type === "integer"
        ? Number.isSafeInteger(v)
        : type === "boolean" && typeof v === "boolean";
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      !schema.enum.length ||
      schema.enum.length > 32 ||
      !schema.enum.every(primitive)
    )
      throw Error("选项格式未核验。");
    out.choices = schema.enum;
  }
  if ("const" in schema) {
    if (!primitive(schema.const)) throw Error("固定输入未核验。");
    out.constant = schema.const;
  }
  if (schema.pattern !== undefined) {
    if (
      typeof schema.pattern !== "string" ||
      !schema.pattern.length ||
      schema.pattern.length > 1024
    )
      throw Error("文本格式约束未核验。");
    out.pattern = schema.pattern;
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) {
    const n = schema[key];
    if (n === undefined) continue;
    if (
      !Number.isSafeInteger(n) ||
      (["minLength", "maxLength"].includes(key) && Number(n) < 0)
    )
      throw Error("输入范围未核验。");
    out[key] = Number(n);
  }
  return out;
}
/** Entries an array or map form accepts: the schema's own bounds within formLimits.entries. */
export function entryBounds(form: ActionForm) {
  const min = form.minItems ?? form.minProperties ?? 0;
  const max = Math.min(
    form.maxItems ?? form.maxProperties ?? formLimits.entries,
    formLimits.entries,
  );
  return { min, max };
}
/** The first problem of a value against its form; the main process repeats this check before sending. */
export function formProblem(form: ActionForm, value: unknown): string {
  if (value === null) return form.nullable ? "" : "此项不能为空值。";
  if (form.type === "array") {
    if (!Array.isArray(value)) return "请填写列表。";
    const { min, max } = entryBounds(form);
    if (value.length < min || value.length > max)
      return `项数须在 ${min} 至 ${max} 之间。`;
    for (const [i, v] of value.entries()) {
      const p = formProblem(form.items!, v);
      if (p) return `第 ${i + 1} 项：${p}`;
    }
  } else if (form.type === "object" && form.values) {
    // The map editor hands over its rows while a name is empty or repeated; they are never sent.
    if (!record(value)) return "名称不能为空，也不能重复。";
    const keys = Object.keys(value);
    const { min, max } = entryBounds(form);
    if (keys.length < min || keys.length > max)
      return `条目数须在 ${min} 至 ${max} 之间。`;
    for (const key of keys) {
      if (
        !key.length ||
        key.length > 256 ||
        reservedKeys.includes(key) ||
        unpairedSurrogate(key)
      )
        return `名称“${key.slice(0, 32)}”不可用。`;
      const p = formProblem(form.values, value[key]);
      if (p) return `${key}：${p}`;
    }
  } else if (form.type === "object") {
    if (
      !record(value) ||
      Object.keys(value).some((k) => !Object.hasOwn(form.properties, k))
    )
      return "输入包含未定义字段。";
    if (form.required.some((k) => !Object.hasOwn(value, k)))
      return "请填写全部必填项。";
    for (const [key, v] of Object.entries(value)) {
      const p = formProblem(form.properties[key], v);
      if (p) return `${form.properties[key].title || key}：${p}`;
    }
  } else {
    // KB-307: a field the person has not filled in (a cleared number, the enum's 请选择, an
    // empty text that must not be empty) asks to be filled rather than naming a length or range.
    if (value === undefined || (value === "" && (form.minLength ?? 0) > 0))
      return form.choices
        ? "请从现有选项中选择。"
        : form.type === "boolean"
          ? "请选择是或否。"
          : "请填写。";
    if (
      form.type === "string" &&
      (typeof value !== "string" ||
        [...value].length < (form.minLength ?? 0) ||
        [...value].length > Math.min(form.maxLength ?? 65536, 65536))
    )
      return "文本长度不符合要求。";
    // RFC 8785 has no canonical form for it, so the request digest could not be recomputed alike.
    if (form.type === "string" && unpairedSurrogate(value as string))
      return "文本包含不成对的 Unicode 代理字符。";
    if (
      form.type === "integer" &&
      (!Number.isSafeInteger(value) ||
        Number(value) < (form.minimum ?? -Number.MAX_SAFE_INTEGER) ||
        Number(value) > (form.maximum ?? Number.MAX_SAFE_INTEGER))
    )
      return "整数不在允许范围内。";
    if (form.type === "boolean" && typeof value !== "boolean")
      return "请选择是或否。";
    if (form.choices && !form.choices.includes(value as FormValue))
      return "请从现有选项中选择。";
    if (form.constant !== undefined && value !== form.constant)
      return "固定输入已变化。";
  }
  return "";
}
export interface PreparedProjectAction {
  token: string;
  projectId: string;
  projectName: string;
  folder: string;
  action: ProjectionAction;
  object: ProjectionObject;
  form: ActionForm;
  evidence: Record<string, unknown>[];
  expiresAt: number;
  pending?: ProjectionPendingItem;
}
export type ProjectActionRequest =
  | { type: "list"; projectId: string }
  | {
      type: "prepare";
      projectId: string;
      actionId: string;
      objectRef: string;
      expectedRevision: string;
      candidateRef: string | null;
      pending?: { itemRef: string; revision: string };
    }
  | { type: "evidence"; projectId: string; token: string; index: number }
  | {
      type: "submit";
      projectId: string;
      token: string;
      payload: Record<string, unknown>;
    }
  | { type: "query"; projectId: string; operationId: string };
export type ProjectActionReply =
  | {
      ok: true;
      prepared?: PreparedProjectAction;
      operations?: RuntimeOperation[];
      operation?: RuntimeOperation | null;
      evidence?: { text: string; digest: string; mediaType: string };
      message?: string;
    }
  | { ok: false; message: string };
export function validProjectActionRequest(
  v: unknown,
): v is ProjectActionRequest {
  if (
    !record(v) ||
    typeof v.projectId !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v.projectId)
  )
    return false;
  const keys = Object.keys(v).sort().join(",");
  if (v.type === "list") return keys === "projectId,type";
  if (v.type === "prepare")
    return (
      (keys ===
        "actionId,candidateRef,expectedRevision,objectRef,projectId,type" ||
        (keys ===
          "actionId,candidateRef,expectedRevision,objectRef,pending,projectId,type" &&
          record(v.pending) &&
          Object.keys(v.pending).sort().join(",") === "itemRef,revision" &&
          validRef(v.pending.itemRef) &&
          validRef(v.pending.revision))) &&
      validRef(v.actionId) &&
      validRef(v.objectRef) &&
      validRef(v.expectedRevision) &&
      (v.candidateRef === null || validRef(v.candidateRef))
    );
  if (v.type === "query")
    return keys === "operationId,projectId,type" && validRef(v.operationId);
  if (typeof v.token !== "string" || !/^[0-9a-f-]{36}$/.test(v.token))
    return false;
  if (v.type === "evidence")
    return (
      keys === "index,projectId,token,type" &&
      Number.isInteger(v.index) &&
      Number(v.index) >= 0 &&
      Number(v.index) < 64
    );
  if (
    v.type !== "submit" ||
    keys !== "payload,projectId,token,type" ||
    !record(v.payload)
  )
    return false;
  try {
    return JSON.stringify(v.payload).length <= 65536;
  } catch {
    return false;
  }
}
/** An object whose newest action succeeded while the projection still shows that action's binding. */
export interface ProjectionAwaiting {
  objectRef: string;
  operationId: string;
  actionId: string;
}
/**
 * KB-308: a Runtime may answer an action, or report its operation settled, before the projection
 * events of the same change arrive (hp sends them one at a time afterwards), so for a moment the
 * projection still offers the old actions. An object is awaiting its projection while its newest
 * action (Host-issued runtime.action.invoke on this scope) has succeeded and the projection still
 * carries the binding that action consumed: the object's revision, or an action on the object,
 * still equals the request's expectedRevision. Only these recorded facts decide it, never a timer;
 * revisions are opaque and compared for equality only, never ordered (Runtime Contract). The caller
 * adds the way out for a Runtime that keeps the binding after a success (ProjectWorkspace: a full
 * snapshot taken after the success was seen settles it).
 */
export function awaitingProjection(
  projection: RuntimeProjection,
  operations: RuntimeOperation[],
  link: { instanceId: string; scopeRef: string },
): ProjectionAwaiting[] {
  const newest = new Map<string, RuntimeOperation>();
  for (const op of operations
    .filter(
      (o) =>
        o.origin === "host" &&
        o.method === "runtime.action.invoke" &&
        o.instanceId === link.instanceId &&
        o.scopeRef === link.scopeRef &&
        typeof o.request?.objectRef === "string" &&
        typeof o.request.expectedRevision === "string",
    )
    // The Host's own record times order its own records; the stable sort keeps the list order on a tie.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const objectRef = op.request!.objectRef as string;
    if (!newest.has(objectRef)) newest.set(objectRef, op);
  }
  return [...newest.entries()].flatMap(([objectRef, op]) => {
    const consumed = op.request!.expectedRevision;
    const shown =
      projection.objects.some(
        (o) => o.objectRef === objectRef && o.revision === consumed,
      ) ||
      projection.actions.some(
        (a) => a.objectRef === objectRef && a.expectedRevision === consumed,
      );
    return op.status === "succeeded" && shown
      ? [
          {
            objectRef,
            operationId: op.operationId,
            actionId: String(op.request!.actionId),
          },
        ]
      : [];
  });
}
