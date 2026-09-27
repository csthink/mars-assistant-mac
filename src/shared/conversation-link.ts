import { validId } from "./protocol";
export function conversationLink(id: string) {
  if (!validId(id)) throw new Error("无效对话身份");
  return `csthink-assistant://conversation/${id}`;
}
export function parseConversationLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const match = /^csthink-assistant:\/\/conversation\/([a-fA-F0-9-]+)$/.exec(
    value,
  );
  return match && validId(match[1]) ? match[1] : null;
}
