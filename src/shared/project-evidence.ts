import {
  validEvidenceRef,
  validRef,
  type ProjectionObject,
} from "./runtime-host";
export type EvidenceSource =
  | { kind: "evidence"; index: number }
  | { kind: "document" | "before" | "after" };
interface ObjectEvidenceRequest {
  projectId: string;
  objectRef: string;
  revision: string;
  source: EvidenceSource;
}
export type ProjectEvidenceRequest =
  | ObjectEvidenceRequest
  | { projectId: string; itemRef: string; revision: string; index: number };
export type ProjectEvidenceReply =
  | { ok: true; evidence: Record<string, unknown>; text: string }
  | { ok: false; message: string };
export function validProjectEvidenceRequest(
  v: unknown,
): v is ProjectEvidenceRequest {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") === "index,itemRef,projectId,revision")
    return (
      typeof r.projectId === "string" &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.projectId) &&
      validRef(r.itemRef) &&
      validRef(r.revision) &&
      Number.isInteger(r.index) &&
      Number(r.index) >= 0 &&
      Number(r.index) < 32
    );
  if (
    Object.keys(r).sort().join(",") !== "objectRef,projectId,revision,source" ||
    typeof r.projectId !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.projectId) ||
    !validRef(r.objectRef) ||
    !validRef(r.revision)
  )
    return false;
  if (!r.source || typeof r.source !== "object" || Array.isArray(r.source))
    return false;
  const s = r.source as Record<string, unknown>;
  return s.kind === "evidence"
    ? Object.keys(s).sort().join(",") === "index,kind" &&
        Number.isInteger(s.index) &&
        Number(s.index) >= 0 &&
        Number(s.index) < 32
    : Object.keys(s).join(",") === "kind" &&
        ["document", "before", "after"].includes(String(s.kind));
}
export function evidenceAt(
  object: ProjectionObject,
  source: EvidenceSource,
): Record<string, unknown> {
  const value =
    source.kind === "evidence"
      ? object.evidence[source.index]
      : source.kind === "document" && object.view.kind === "document"
        ? object.view.content
        : ["before", "after"].includes(source.kind) &&
            object.view.kind === "diff"
          ? object.view[source.kind]
          : null;
  if (!validEvidenceRef(value)) throw Error("当前对象没有这个证据入口。");
  return value as Record<string, unknown>;
}
