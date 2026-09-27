/** Capability identity of the Coding graph-domain fake; pure so tests and the bundle builder share one digest. */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  contractVersion,
} from "../../../src/shared/runtime-host";

/** Kept byte-identical (after canonicalization) with GRAPH_SCHEMA in graph_fake.py. */
export const GRAPH_SCHEMA = {
  type: "object",
  properties: {
    choice: { type: "string", minLength: 1, maxLength: 64 },
    arguments: { type: "object" },
  },
  required: ["choice"],
  additionalProperties: false,
};
export const GRAPH_CAPABILITY = {
  id: "csthink.test.graph",
  version: contractVersion,
  schemaDigest: createHash("sha256")
    .update(canonicalJson(GRAPH_SCHEMA))
    .digest("hex"),
  required: true,
};
export const GRAPH_OPERATIONS = ["graph.read", "graph.execute"] as const;
