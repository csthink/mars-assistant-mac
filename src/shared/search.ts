export type SearchCategory = "all" | "conversation" | "project" | "widget";
export type SearchKind = Exclude<SearchCategory, "all">;
export const searchCategories: SearchCategory[] = [
  "all",
  "conversation",
  "project",
  "widget",
];
export interface SearchRequest {
  sequence: number;
  query: string;
  category: SearchCategory;
  /** Opaque position after the last hit of the previous page; null for the first page. */
  cursor: string | null;
}
/**
 * One result. Conversations give one hit per matching title or saved message; projects and retained widgets give
 * one hit per object. `conversationId` is set only for conversation hits. `updatedAt` is null when the object has
 * no confirmable time (retained widgets), so no time is shown.
 */
export interface SearchHit {
  kind: SearchKind;
  objectId: string;
  conversationId: string | null;
  messageId: string | null;
  archived: boolean;
  title: string;
  titleRanges: [number, number][];
  text: string;
  ranges: [number, number][];
  updatedAt: string | null;
  /** Project name of a project conversation; null elsewhere. */
  projectName: string | null;
}
export type SearchCounts = Record<SearchKind, number>;
export type SearchReply =
  | {
      ok: true;
      sequence: number;
      query: string;
      category: SearchCategory;
      /** Matches per kind, read in the same transaction as the hits; zero for an empty query. */
      counts: SearchCounts;
      hits: SearchHit[];
      next: string | null;
      hasMore: boolean;
      /** Index generation and revision the counts and hits were read from. */
      snapshot: { generation: number; revision: number };
    }
  | {
      ok: false;
      code: "INVALID_QUERY" | "SUPERSEDED" | "TIMEOUT" | "UNAVAILABLE";
      message: string;
    };
export function validSearch(value: unknown): value is SearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join(",") === "category,cursor,query,sequence" &&
    typeof v.query === "string" &&
    [...v.query].length <= 200 &&
    !v.query.includes("\0") &&
    Number.isSafeInteger(v.sequence) &&
    Number(v.sequence) >= 0 &&
    searchCategories.includes(v.category as SearchCategory) &&
    (v.cursor === null ||
      (typeof v.cursor === "string" &&
        v.cursor.length > 0 &&
        v.cursor.length <= 1024))
  );
}
// Unicode canonical normalization and caseless literal matching. These expansions
// preserve mapping to original graphemes (not normalized-string offsets).
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ς/g, "σ");
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = normalizeSearch(query.trim());
  if (!needle) return [];
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const n = normalizeSearch(segment);
    normalized += n;
    for (let i = 0; i < n.length; i++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  const ranges: [number, number][] = [];
  let at = 0;
  while ((at = normalized.indexOf(needle, at)) !== -1) {
    const start = starts[at],
      end = ends[at + needle.length - 1];
    const last = ranges.at(-1);
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
    at += needle.length;
    if (ranges.length === 100) break;
  }
  return ranges;
}
export function searchSnippet(
  text: string,
  query: string,
): { text: string; ranges: [number, number][] } {
  const at = normalizeSearch(text).indexOf(normalizeSearch(query.trim()));
  // Only the bounded neighborhood is grapheme-mapped; long messages stay cheap.
  // Use full mapping when prefix normalization changes offsets near a match.
  const target = at < 0 ? 0 : at;
  let cursor = 0,
    start = 0,
    end = text.length;
  for (const part of segmenter.segment(text)) {
    const next = cursor + normalizeSearch(part.segment).length;
    if (next < Math.max(0, target - 55))
      start = part.index + part.segment.length;
    if (cursor > target + query.length + 140) {
      end = part.index;
      break;
    }
    cursor = next;
  }
  const excerpt =
    (start ? "…" : "") +
    text.slice(start, end) +
    (end < text.length ? "…" : "");
  return { text: excerpt, ranges: matchRanges(excerpt, query) };
}
