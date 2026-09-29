import {
  validProjectRequest,
  type ProjectRequest,
  type ProjectWork,
} from "./project-work";
/** Project organization belongs to the Host; Runtime domain state does not. */
export interface ProjectFolder {
  path: string;
  canonicalPath: string;
  identity: string;
  git: null | {
    root: string;
    commonDirectory: string;
    identity: string;
    remotes: { name: string; url: string }[];
  };
}
export interface Project extends ProjectWork {
  id: string;
  name: string;
  goal: string;
  folder: ProjectFolder;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  manualPosition: number;
}
export interface ProjectUndo {
  token: string;
  id: string;
  expiresAt: string;
}
export type ProjectCommand =
  | {
      type: "projectEdit";
      id: string;
      name: string;
      goal: string;
      revision: number;
    }
  | { type: "projectArchive"; id: string; archived: boolean; revision: number }
  | { type: "projectPin"; id: string; pinned: boolean; revision: number }
  | { type: "moveProject"; id: string; before: string | null; revision: number }
  | { type: "projectUndo"; id: string; token: string };
export type ProjectHostCommand =
  | { type: "projectWork"; request: Exclude<ProjectRequest, { type: "read" }> }
  | {
      type: "projectCreate";
      id: string;
      name: string;
      goal: string;
      folder: ProjectFolder;
    };
export type ProjectCreateInput = { token: string; name: string; goal: string };
export type ProjectFolderReply =
  | { ok: true; token: string; folder: ProjectFolder }
  | {
      ok: false;
      cancelled?: boolean;
      code?: string;
      message: string;
      selectedPath?: string;
    };
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, s: string) =>
  Object.keys(v).sort().join(",") === s;
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const path = (v: unknown): v is string =>
  typeof v === "string" &&
  v.startsWith("/") &&
  v.length <= 4096 &&
  !/[\u0000-\u001f\u007f]/u.test(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  [...v].length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
export const validProjectName = (v: unknown): v is string =>
  text(v, 60) && v.trim().length > 0 && !/[\r\n\t]/u.test(v);
export const validProjectGoal = (v: unknown): v is string => text(v, 4000);
export function validProjectFolder(v: unknown): v is ProjectFolder {
  if (
    !obj(v) ||
    !keys(v, "canonicalPath,git,identity,path") ||
    !path(v.path) ||
    !path(v.canonicalPath) ||
    typeof v.identity !== "string" ||
    !/^\d+:\d+$/.test(v.identity)
  )
    return false;
  if (v.git === null) return true;
  const g = v.git;
  return (
    obj(g) &&
    keys(g, "commonDirectory,identity,remotes,root") &&
    path(g.root) &&
    path(g.commonDirectory) &&
    typeof g.identity === "string" &&
    /^\d+:\d+$/.test(g.identity) &&
    Array.isArray(g.remotes) &&
    g.remotes.length <= 100 &&
    g.remotes.every(
      (r) =>
        obj(r) && keys(r, "name,url") && text(r.name, 200) && text(r.url, 4096),
    )
  );
}
export function validProjectCreateInput(v: unknown): v is ProjectCreateInput {
  return (
    obj(v) &&
    keys(v, "goal,name,token") &&
    id(v.token) &&
    validProjectName(v.name) &&
    validProjectGoal(v.goal)
  );
}
export function validProjectHostCommand(v: unknown): v is ProjectHostCommand {
  if (obj(v) && keys(v, "request,type") && v.type === "projectWork")
    return validProjectRequest(v.request) && v.request.type !== "read";
  return (
    obj(v) &&
    keys(v, "folder,goal,id,name,type") &&
    v.type === "projectCreate" &&
    id(v.id) &&
    validProjectName(v.name) &&
    validProjectGoal(v.goal) &&
    validProjectFolder(v.folder)
  );
}
export function validProjectCommand(v: unknown): v is ProjectCommand {
  if (!obj(v) || !id(v.id)) return false;
  if (v.type === "projectUndo") return keys(v, "id,token,type") && id(v.token);
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0) return false;
  if (v.type === "projectEdit")
    return (
      keys(v, "goal,id,name,revision,type") &&
      validProjectName(v.name) &&
      validProjectGoal(v.goal)
    );
  if (v.type === "projectPin")
    return keys(v, "id,pinned,revision,type") && typeof v.pinned === "boolean";
  if (v.type === "moveProject")
    return (
      keys(v, "before,id,revision,type") &&
      (v.before === null || (id(v.before) && v.before !== v.id))
    );
  return (
    v.type === "projectArchive" &&
    keys(v, "archived,id,revision,type") &&
    typeof v.archived === "boolean"
  );
}
