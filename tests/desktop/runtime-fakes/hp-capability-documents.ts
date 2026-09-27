/**
 * hp action payload schemas (hp-action-schemas.json) and the capability documents
 * OD-425 describes (feature-t31 S-06): each capability's primary action schema stays
 * the document root (R2) and every other action schema of that capability, without
 * its `$id` (R2: no nested $id), becomes a root `definitions` entry named by its
 * actionId. hp delivery-r4 is expected to package this shape; these documents and
 * their digests are recomputed here, not announced by a real Runtime.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../../src/shared/runtime-host";

export interface HpAction {
  capability: string;
  capabilitySchemaDigest: string;
  payloadSchemaDigest: string;
  label: string;
  requiresHumanDecision: boolean;
  schema: Record<string, unknown>;
}
/** hp main 73502f20's action payload schemas, each bound to the digest delivery-r3 announced. */
export const hpActions = (
  JSON.parse(
    readFileSync(new URL("./hp-action-schemas.json", import.meta.url), "utf8"),
  ) as { actions: Record<string, HpAction> }
).actions;
export const schemaDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface HpCapabilityDocument {
  id: string;
  document: Record<string, unknown>;
  digest: string;
  /** actionId to the payloadSchemaDigest an OD-425 Runtime announces for it. */
  payloadDigests: Record<string, string>;
}
export function hpCapabilityDocuments(): HpCapabilityDocument[] {
  const byCapability = new Map<string, [string, HpAction][]>();
  for (const entry of Object.entries(hpActions))
    byCapability.set(entry[1].capability, [
      ...(byCapability.get(entry[1].capability) ?? []),
      entry,
    ]);
  return [...byCapability].map(([id, actions]) => {
    const primary = actions.find(
      ([, a]) => a.payloadSchemaDigest === a.capabilitySchemaDigest,
    )!;
    const definitions = Object.fromEntries(
      actions
        .filter((entry) => entry !== primary)
        .map(([actionId, a]) => {
          const { $id: _id, ...entry } = a.schema;
          void _id;
          return [actionId, entry];
        }),
    );
    const document = { ...primary[1].schema, definitions };
    const digest = schemaDigest(document);
    return {
      id,
      document,
      digest,
      payloadDigests: Object.fromEntries(
        actions.map(([actionId]) => [
          actionId,
          actionId === primary[0]
            ? digest
            : schemaDigest(definitions[actionId]),
        ]),
      ),
    };
  });
}
