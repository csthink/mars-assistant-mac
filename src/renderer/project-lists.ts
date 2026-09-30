import type { Project } from "../shared/projects";
import type {
  Conversation,
  PinnedRef,
  PinnedSort,
  ProjectSort,
} from "../shared/protocol";
import { pinnedVisible } from "./conversation-lists";

const nameCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  sensitivity: "base",
  numeric: true,
});

/** The full project-section order, including rows below the sidebar's five-row viewport. */
export function orderedSidebarProjects(projects: Project[], sort: ProjectSort) {
  const rows = projects.filter(
    (project) => !project.archivedAt && !project.pinnedAt,
  );
  if (sort === "name")
    rows.sort(
      (a, b) =>
        nameCollator.compare(a.name, b.name) || a.id.localeCompare(b.id),
    );
  else if (sort === "manual")
    rows.sort(
      (a, b) => a.manualPosition - b.manualPosition || a.id.localeCompare(b.id),
    );
  else
    rows.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return rows;
}

/** The sidebar shows at most five unpinned, unarchived projects. Page sorting is separate. */
export function sidebarProjects(projects: Project[], sort: ProjectSort) {
  return orderedSidebarProjects(projects, sort).slice(0, 5);
}

export type PinnedObject =
  | { kind: "conversation"; value: Conversation }
  | { kind: "project"; value: Project };

export function pinnedObjects(
  conversations: Conversation[],
  projects: Project[],
  sort: PinnedSort,
  order: PinnedRef[],
): PinnedObject[] {
  const rows: PinnedObject[] = [
    ...conversations
      .filter(pinnedVisible)
      .map((value) => ({ kind: "conversation" as const, value })),
    ...projects
      .filter((value) => !!value.pinnedAt && !value.archivedAt)
      .map((value) => ({ kind: "project" as const, value })),
  ];
  const key = (row: PinnedObject | PinnedRef) =>
    `${row.kind}:${"value" in row ? row.value.id : row.id}`;
  const byPin = (a: PinnedObject, b: PinnedObject) =>
    b.value.pinnedAt!.localeCompare(a.value.pinnedAt!) ||
    key(a).localeCompare(key(b));
  if (sort === "updated")
    return rows.sort(
      (a, b) =>
        b.value.updatedAt.localeCompare(a.value.updatedAt) || byPin(a, b),
    );
  if (sort === "manual") {
    const positions = new Map(order.map((ref, index) => [key(ref), index]));
    const missing = rows.filter((row) => !positions.has(key(row))).sort(byPin);
    const placed = rows
      .filter((row) => positions.has(key(row)))
      .sort((a, b) => positions.get(key(a))! - positions.get(key(b))!);
    return [...missing, ...placed];
  }
  return rows.sort(byPin);
}
