import type { ConnectionSnapshot, Message } from "./protocol";
import type { BuiltWidget } from "./widget";

export const generationLimits = {
  active: 3,
  generation: 1,
  domain: 1,
  waiting: 20,
  attempts: 3,
} as const;
export type GenerationState =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";
export interface WidgetDraft {
  id: string;
  name: string;
  input: string;
  revision: number;
  requirementRevision: number;
  sourceConversationId: string | null;
  widgetId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface GenerationTask {
  id: string;
  draftId: string;
  requestId: string;
  executionId: string;
  attempt: number;
  requirement: string;
  requirementRevision: number;
  state: GenerationState;
  connection: ConnectionSnapshot;
  partialText: string;
  error: string | null;
  candidateId: string | null;
  createdAt: string;
  endedAt: string | null;
}
export interface GenerationContext {
  messages: Message[];
  attachments: {
    attachmentId: string;
    sha256: string;
    messageId: string;
    position: number;
  }[];
  access: { grantedConnections: string[]; permissionRevision: number };
}
export interface GeneratedCandidate {
  id: string;
  taskId: string;
  draftId: string;
  digest: string;
  name: string;
  requirementRevision: number;
  state: "preview" | "retained" | "discarded" | "unchanged";
  differences: { path: string; before: string | null; after: string | null }[];
  widgetId: string | null;
}
export interface SavedWidget {
  id: string;
  name: string;
  candidateId: string;
  digest: string;
  revision: number;
  position: number;
}
export interface WidgetGenerationSnapshot {
  drafts: WidgetDraft[];
  tasks: GenerationTask[];
  candidates: GeneratedCandidate[];
  widgets: SavedWidget[];
  selected?: { main: string | null; panel: string | null };
}
export type WidgetGenerationCommand =
  | { type: "selectWidgetDraft"; id: string | null }
  | {
      type: "createWidgetDraft";
      id: string;
      name: string;
      sourceConversationId: string | null;
    }
  | {
      type: "saveWidgetDraft";
      id: string;
      revision: number;
      name: string;
      input: string;
    }
  | {
      type: "submitWidgetGeneration";
      draftId: string;
      requestId: string;
      revision: number;
      connectionId: string;
      model: string;
    }
  | { type: "stopWidgetGeneration"; taskId: string }
  | { type: "retryWidgetGeneration"; taskId: string; attempt: number }
  | {
      type: "retainWidgetCandidate" | "discardWidgetCandidate";
      candidateId: string;
      digest: string;
      requirementRevision: number;
    };
export type WidgetGenerationHostCommand =
  | { type: "claimWidgetGeneration"; taskId: string; executionId: string }
  | { type: "loadWidgetGeneration"; taskId: string; executionId: string }
  | {
      type: "widgetGenerationDelta";
      taskId: string;
      executionId: string;
      text: string;
    }
  | {
      type: "finishWidgetGeneration";
      taskId: string;
      executionId: string;
      state: "completed" | "stopped" | "failed" | "interrupted";
      error: string | null;
    }
  | {
      type: "receiveWidgetCandidate";
      taskId: string;
      executionId: string;
      build: BuiltWidget;
    }
  | { type: "loadGeneratedWidget"; candidateId: string };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length + 1 &&
  keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(v);
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown, max: number) =>
  typeof v === "string" &&
  !v.includes("\0") &&
  new TextEncoder().encode(v).length <= max;
const name = (v: unknown) => text(v, 160) && (v as string).trim().length > 0;
const digest = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validWidgetGenerationCommand(
  v: unknown,
): v is WidgetGenerationCommand {
  if (!object(v)) return false;
  switch (v.type) {
    case "selectWidgetDraft":
      return exact(v, ["id"]) && (v.id === null || id(v.id));
    case "createWidgetDraft":
      return (
        exact(v, ["id", "name", "sourceConversationId"]) &&
        id(v.id) &&
        name(v.name) &&
        (v.sourceConversationId === null || id(v.sourceConversationId))
      );
    case "saveWidgetDraft":
      return (
        exact(v, ["id", "revision", "name", "input"]) &&
        id(v.id) &&
        revision(v.revision) &&
        name(v.name) &&
        text(v.input, 64000)
      );
    case "submitWidgetGeneration":
      return (
        exact(v, [
          "draftId",
          "requestId",
          "revision",
          "connectionId",
          "model",
        ]) &&
        id(v.draftId) &&
        id(v.requestId) &&
        id(v.connectionId) &&
        revision(v.revision) &&
        text(v.model, 256) &&
        !!v.model
      );
    case "stopWidgetGeneration":
      return exact(v, ["taskId"]) && id(v.taskId);
    case "retryWidgetGeneration":
      return (
        exact(v, ["taskId", "attempt"]) && id(v.taskId) && revision(v.attempt)
      );
    case "retainWidgetCandidate":
    case "discardWidgetCandidate":
      return (
        exact(v, ["candidateId", "digest", "requirementRevision"]) &&
        id(v.candidateId) &&
        digest(v.digest) &&
        revision(v.requirementRevision)
      );
    default:
      return false;
  }
}
export function validWidgetGenerationHostCommand(
  v: unknown,
): v is WidgetGenerationHostCommand {
  if (!object(v)) return false;
  if (v.type === "loadGeneratedWidget")
    return exact(v, ["candidateId"]) && id(v.candidateId);
  if (!id(v.taskId) || !id(v.executionId)) return false;
  switch (v.type) {
    case "claimWidgetGeneration":
    case "loadWidgetGeneration":
      return exact(v, ["taskId", "executionId"]);
    case "widgetGenerationDelta":
      return exact(v, ["taskId", "executionId", "text"]) && text(v.text, 64000);
    case "finishWidgetGeneration":
      return (
        exact(v, ["taskId", "executionId", "state", "error"]) &&
        ["completed", "stopped", "failed", "interrupted"].includes(
          String(v.state),
        ) &&
        (v.error === null || text(v.error, 4096))
      );
    case "receiveWidgetCandidate":
      return (
        exact(v, ["taskId", "executionId", "build"]) &&
        object(v.build) &&
        digest(v.build.digest) &&
        object(v.build.manifest) &&
        object(v.build.resources)
      );
    default:
      return false;
  }
}
