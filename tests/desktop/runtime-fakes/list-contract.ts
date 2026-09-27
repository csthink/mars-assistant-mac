/** Capability identity of the list-domain fake; pure so tests can import it without side effects. */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  contractVersion,
} from "../../../src/shared/runtime-host";

export const LIST_SCHEMA = {
  type: "object",
  properties: {
    choice: { enum: ["create", "organize", "confirm", "read-foreign"] },
    arguments: { type: "object" },
  },
  required: ["choice"],
  additionalProperties: false,
};
export const LIST_CAPABILITY = {
  id: "csthink.test.list-confirm",
  version: contractVersion,
  schemaDigest: createHash("sha256")
    .update(canonicalJson(LIST_SCHEMA))
    .digest("hex"),
  required: true,
};
