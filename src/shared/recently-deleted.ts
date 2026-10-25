/**
 * Recently deleted projects and retained widgets (WB-04, PROJECT-03, D-03). Deleted conversations keep their own
 * columns and the organizeConversation command (CHAT-02); the settings page shows all three kinds together.
 * An ordinary deletion keeps the object for at least 30 days; a retention can be extended by 30 days; a permanent
 * deletion needs its own confirmation and is checked against protected references when it commits.
 */
export const retentionDays = 30;
export const retentionMs = retentionDays * 86_400_000;

/** A retained widget moved to recently deleted, with the neighbours it had in the workbench order. */
export interface DeletedWidget {
  id: string;
  name: string;
  deletedAt: string;
  retainUntil: string;
  /** Changes with every restore, extension or purge attempt that commits; commands quote it. */
  trashRevision: number;
  /** The widget before and after it in the order when it was deleted. */
  previousId: string | null;
  nextId: string | null;
  /** Why a permanent deletion is refused now, or null. */
  protection: string | null;
}
/** A project moved to recently deleted: only its organization record is removed (PROJECT-03). */
export interface DeletedProject {
  id: string;
  name: string;
  deletedAt: string;
  retainUntil: string;
  /** The project revision; commands quote it. */
  revision: number;
  /** Conversations of the project; they stay in the recent list. */
  chatCount: number;
  /** Why a permanent deletion is refused now, or null. */
  protection: string | null;
}
export interface RecentlyDeletedSnapshot {
  projects: DeletedProject[];
  widgets: DeletedWidget[];
}
export type DeletedKind = "project" | "widget";
export type RecentlyDeletedCommand =
  | {
      type: "deleteWidget";
      id: string;
      /** The retained widget's revision as the user saw it. */
      revision: number;
      confirmed: boolean;
    }
  | { type: "deleteProject"; id: string; revision: number; confirmed: boolean }
  | { type: "restoreDeleted"; kind: DeletedKind; id: string; revision: number }
  | { type: "extendDeleted"; kind: DeletedKind; id: string; revision: number }
  | {
      type: "purgeDeleted";
      kind: DeletedKind;
      id: string;
      revision: number;
      confirmed: boolean;
    };
/** Where a restored widget went: after its former previous neighbour, before its former next one, or at the end. */
export type WidgetPlacement = "after" | "before" | "end";

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 128;
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function validRecentlyDeletedCommand(
  v: unknown,
): v is RecentlyDeletedCommand {
  if (!obj(v)) return false;
  const keys = Object.keys(v).sort().join(",");
  if (v.type === "deleteWidget" || v.type === "deleteProject")
    return (
      keys === "confirmed,id,revision,type" &&
      identity(v.id) &&
      revision(v.revision) &&
      typeof v.confirmed === "boolean"
    );
  const kind = v.kind === "project" || v.kind === "widget";
  if (v.type === "restoreDeleted" || v.type === "extendDeleted")
    return (
      keys === "id,kind,revision,type" &&
      kind &&
      identity(v.id) &&
      revision(v.revision)
    );
  if (v.type === "purgeDeleted")
    return (
      keys === "confirmed,id,kind,revision,type" &&
      kind &&
      identity(v.id) &&
      revision(v.revision) &&
      typeof v.confirmed === "boolean"
    );
  return false;
}
/** The later of the current retention end and now, plus 30 days. */
export function extendedRetention(retainUntil: string, now: string) {
  return new Date(
    Math.max(Date.parse(retainUntil), Date.parse(now)) + retentionMs,
  ).toISOString();
}
