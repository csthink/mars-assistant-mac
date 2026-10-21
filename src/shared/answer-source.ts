import { presets, type AnswerSource, type Provider } from "./protocol";

/**
 * Source notes for saved answers sent to a model (CONN-04). A note names only the connection,
 * provider and model name snapshots recorded with the answer's turn: never an address, a key,
 * a connection id or a provider's own session identity.
 */
export interface Generator {
  name: string;
  provider: Provider;
  model: string;
}
const label = (g: Generator) =>
  `${g.name}（${presets[g.provider].label} · ${g.model}）`;

/** The note sent with a saved answer; a missing source is stated as unknown, never guessed. */
export function answerSourceNote(source: AnswerSource | null | undefined) {
  return source
    ? `【历史回答来源：${label({ name: source.connectionName, provider: source.provider, model: source.model })}】`
    : "【历史回答来源：未知，保存时没有记录提供方与模型】";
}

/**
 * Notes are attached only when the history holds an answer another connection or model wrote,
 * or one whose source is unknown; then every saved answer carries one. A conversation that
 * stayed on one connection and model is sent unchanged. Messages captured without source
 * information (no source field) do not by themselves call for notes.
 */
export function needsAnswerSources(
  messages: { role: string; source?: AnswerSource | null }[],
) {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      "source" in m &&
      (m.source === null || m.source?.sameAsTurn === false),
  );
}

/** States which connection answers now and how to read the notes on earlier answers. */
export function answerSourcePrompt(current: Generator) {
  return `本回合由 ${label(current)}回答。对话历史中每条助手回答附带的【历史回答来源：…】由应用标注，说明该回答当时由哪个连接、提供方与模型生成；标为未知的回答没有保存来源记录。来源与本回合不同或未知的回答不是你生成的。不要在你的回答中输出这类标注。`;
}
