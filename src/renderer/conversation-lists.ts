import type { Conversation, PinnedRef, PinnedSort } from "../shared/protocol";

/**
 * Membership and order of the sidebar's conversation lists, computed from the snapshot and the local
 * preferences only. Every object appears once at the top level of the sidebar: a pinned conversation that is
 * not archived or deleted is in the pinned section, every other listed conversation is in the recent list.
 * Unused conversations stand for the new-conversation page and are in neither.
 */
export type DateGroup = "today" | "yesterday" | "week" | "earlier" | "unknown";
export const dateGroups: DateGroup[] = [
  "today",
  "yesterday",
  "week",
  "earlier",
  "unknown",
];
export const dateGroupLabels: Record<DateGroup, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "本周",
  earlier: "更早",
  unknown: "日期未提供",
};

const day = 86_400_000;
/** Local midnight at the start of the given moment's day. */
function startOfDay(moment: Date) {
  return new Date(
    moment.getFullYear(),
    moment.getMonth(),
    moment.getDate(),
  ).getTime();
}
/** Local midnight at the start of the week (Monday) that contains the given moment. */
function startOfWeek(moment: Date) {
  const monday = (moment.getDay() + 6) % 7;
  return new Date(
    moment.getFullYear(),
    moment.getMonth(),
    moment.getDate() - monday,
  ).getTime();
}
/** The next local midnight after the given moment: the list regroups then. */
export function nextMidnight(now: Date) {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).getTime();
}

/**
 * The date group of a creation time in the local time zone: today, yesterday, earlier this week (weeks start
 * on Monday), earlier, or unknown when the creation time was never recorded. A time later than now counts as
 * today; nothing is inferred from other times.
 */
export function dateGroup(createdAt: string | null, now: Date): DateGroup {
  if (!createdAt) return "unknown";
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "unknown";
  const today = startOfDay(now);
  if (created >= today) return "today";
  // Days may be 23 or 25 hours long around a clock change; compare calendar days, not durations.
  const yesterday = startOfDay(new Date(today - day / 2));
  if (created >= yesterday) return "yesterday";
  if (created >= startOfWeek(now)) return "week";
  return "earlier";
}

/** Shown in the pinned section: pinned and neither archived nor deleted. */
export function pinnedVisible(c: Conversation) {
  return !!c.pinnedAt && !c.archivedAt && !c.deletedAt;
}
/** Listed at the top level of the sidebar (pinned section or recent list). */
export function listed(c: Conversation) {
  return !c.archivedAt && !c.deletedAt && !c.unused;
}

/**
 * The pinned section in the chosen order: newest pin first; last update first; or the manual order, where
 * objects missing from the saved order come first, newest pin first. Pin times never change here.
 */
export function pinnedRows(
  conversations: Conversation[],
  sort: PinnedSort,
  order: PinnedRef[],
): Conversation[] {
  const rows = conversations.filter(pinnedVisible);
  const byPin = (a: Conversation, b: Conversation) =>
    b.pinnedAt!.localeCompare(a.pinnedAt!) || b.creationOrder - a.creationOrder;
  if (sort === "updated")
    return [...rows].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byPin(a, b),
    );
  if (sort === "manual") {
    const position = new Map(order.map((ref, index) => [ref.id, index]));
    const missing = rows.filter((c) => !position.has(c.id)).sort(byPin);
    const placed = rows
      .filter((c) => position.has(c.id))
      .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    return [...missing, ...placed];
  }
  return [...rows].sort(byPin);
}

/**
 * The recent list grouped by creation date, newest creation first inside and across groups (the creation
 * order is also the order of the groups, since unknown dates belong to the oldest rows). Renaming, new
 * messages and drafts change neither the group nor the position. The title filter narrows only this list.
 */
export function recentGroups(
  conversations: Conversation[],
  now: Date,
  filter = "",
): { group: DateGroup; items: Conversation[] }[] {
  const needle = filter.trim().toLowerCase();
  const rows = conversations
    .filter((c) => listed(c) && !pinnedVisible(c))
    .filter((c) => !needle || c.title.toLowerCase().includes(needle))
    .sort((a, b) => b.creationOrder - a.creationOrder);
  return dateGroups
    .map((group) => ({
      group,
      items: rows.filter((c) => dateGroup(c.createdAt, now) === group),
    }))
    .filter((entry) => entry.items.length);
}

/** Archived conversations, newest creation first. */
export function archivedRows(conversations: Conversation[]) {
  return conversations
    .filter((c) => c.archivedAt && !c.deletedAt)
    .sort((a, b) => b.creationOrder - a.creationOrder);
}

/** How many listed conversations share each title, to mark same-name rows. */
export function sameNameCounts(conversations: Conversation[]) {
  const counts = new Map<string, number>();
  for (const c of conversations.filter(listed))
    counts.set(c.title, (counts.get(c.title) ?? 0) + 1);
  return counts;
}
