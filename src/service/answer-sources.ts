import type { DatabaseSync } from "node:sqlite";
import {
  presets,
  type AnswerSource,
  type ConnectionSnapshot,
  type ContextMessage,
  type Message,
} from "../shared/protocol";

/**
 * Attaches to every assistant message the source recorded with its turn (CONN-04): the
 * connection, provider and model name snapshots, and whether that connection, address and model
 * are the ones of `current`. An answer without a turn or turn snapshot gets null: its source is
 * unknown and is never inferred from current defaults, content or time. User messages are
 * returned unchanged.
 */
export function withAnswerSources(
  db: DatabaseSync,
  messages: Message[],
  current: ConnectionSnapshot | null,
): ContextMessage[] {
  const lookup = db.prepare(
    "SELECT connection_snapshot AS snapshot FROM turns WHERE id=?",
  );
  const sources = new Map<string, AnswerSource | null>();
  const sourceOf = (turnId: string | null): AnswerSource | null => {
    if (!turnId) return null;
    if (sources.has(turnId)) return sources.get(turnId)!;
    const row = lookup.get(turnId) as { snapshot: string } | undefined;
    let source: AnswerSource | null = null;
    try {
      const s = row ? (JSON.parse(row.snapshot) as ConnectionSnapshot) : null;
      if (
        s &&
        typeof s.provider === "string" &&
        Object.hasOwn(presets, s.provider) &&
        typeof s.name === "string" &&
        typeof s.model === "string" &&
        s.model
      )
        source = {
          provider: s.provider,
          connectionName: s.name,
          model: s.model,
          sameAsTurn:
            !!current &&
            s.connectionId === current.connectionId &&
            s.baseUrl === current.baseUrl &&
            s.model === current.model,
        };
    } catch {
      source = null;
    }
    sources.set(turnId, source);
    return source;
  };
  return messages.map((m) =>
    m.role === "assistant" ? { ...m, source: sourceOf(m.turnId) } : m,
  );
}
