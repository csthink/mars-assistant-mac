/**
 * Extension catalog: the directory entries the product shows before any bundle is
 * installed, with the display name, purpose and description of each and, once known,
 * the runtime identity and pinned publisher key. Capability schemas themselves travel
 * inside each bundle (capabilities/<id>.json) and are verified against the declared
 * schemaDigest at admission; the Host never decides permissions by catalog entry.
 */
export interface CatalogEntry {
  /** Stable catalog key; not a runtime identity. */
  key: string;
  displayName: string;
  purpose: string;
  description: string;
  /** Contract runtimeId once the publisher has shipped a bundle (hp: J-03), otherwise null. */
  runtimeId: string | null;
  /** SHA-256 of the publisher's SPKI DER public key, pinned when known. */
  publisherKeyDigest: string | null;
  /** Planned entries offer no installation and no executable action (RUNTIME-01). */
  planned: boolean;
}
export const extensionCatalog: CatalogEntry[] = [
  {
    key: "ai-sdlc",
    displayName: "AI-SDLC",
    purpose: "研发工作",
    description:
      "项目默认使用的管理能力。从需求、计划到实现与审阅，在受治理的流程中推进工作。",
    runtimeId: null,
    publisherKeyDigest: null,
    planned: false,
  },
  {
    key: "knowledge",
    displayName: "知识库",
    purpose: "知识整理与检索",
    description: "面向资料整理、知识积累与检索的扩展方向，尚未开放使用。",
    runtimeId: null,
    publisherKeyDigest: null,
    planned: true,
  },
];
/** Publisher pins the supervisor applies before any import record exists. */
export function catalogPins(): Map<string, string> {
  const pins = new Map<string, string>();
  for (const entry of extensionCatalog)
    if (entry.runtimeId && entry.publisherKeyDigest)
      pins.set(entry.runtimeId, entry.publisherKeyDigest);
  return pins;
}
export function catalogEntryFor(runtimeId: string) {
  return extensionCatalog.find((entry) => entry.runtimeId === runtimeId);
}
