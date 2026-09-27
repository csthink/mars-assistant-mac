import { createHash } from "node:crypto";
import {
  canonicalJson,
  contractVersion,
} from "../../../src/shared/runtime-host";
/**
 * A second action payload schema of the journey capability (OD-425): 补充说明
 * (task.annotate, shown when fault.json sets annotate) takes it, located by the RFC 8785
 * digest of this entry under the capability document's root definitions.
 */
export const JOURNEY_ANNOTATE_SCHEMA = {
  type: "object",
  title: "补充说明",
  description: "为合成任务补充一条说明，不改变任务阶段。",
  properties: {
    note: { type: "string", title: "说明", minLength: 1, maxLength: 200 },
    tags: {
      type: "array",
      title: "标签",
      maxItems: 4,
      items: { type: "string", title: "标签", minLength: 1, maxLength: 32 },
    },
  },
  required: ["note"],
  additionalProperties: false,
};
export const JOURNEY_SCHEMA = {
  type: "object",
  title: "本次处理",
  properties: {
    decision: { type: "string", title: "处理方式", enum: ["继续", "拒绝"] },
    limit: { type: "integer", title: "评审次数额度", minimum: 1, maximum: 5 },
    // The shape of a Task Definition submission (hp definition.submit): a list of objects,
    // nullable text and a map; 冻结定义 takes it, the other actions leave it out.
    definition: {
      type: "object",
      title: "定义候选",
      properties: {
        commit: {
          type: "string",
          title: "定义提交",
          pattern: "^[0-9a-f]{40}$",
        },
        author: {
          type: "object",
          title: "撰写方",
          properties: {
            tool: { type: ["string", "null"], title: "工具", maxLength: 256 },
            model: { type: ["string", "null"], title: "模型", maxLength: 256 },
            humanOnly: { type: "boolean", title: "仅由人撰写" },
            evidenceRefs: {
              type: "array",
              title: "依据",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  commit: {
                    type: "string",
                    title: "提交",
                    pattern: "^[0-9a-f]{40}$",
                  },
                  path: {
                    type: "string",
                    title: "路径",
                    minLength: 1,
                    maxLength: 1024,
                  },
                },
                required: ["commit", "path"],
                additionalProperties: false,
              },
            },
          },
          required: ["tool", "model", "humanOnly", "evidenceRefs"],
          additionalProperties: false,
        },
        notes: {
          type: "object",
          title: "说明",
          maxProperties: 4,
          additionalProperties: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
        },
      },
      required: ["commit", "author"],
      additionalProperties: false,
    },
  },
  required: ["decision"],
  additionalProperties: false,
  definitions: { "task.annotate": JOURNEY_ANNOTATE_SCHEMA },
};
export const JOURNEY_CAPABILITY = {
  id: "csthink.test.journey",
  version: contractVersion,
  schemaDigest: createHash("sha256")
    .update(canonicalJson(JOURNEY_SCHEMA))
    .digest("hex"),
  required: true,
};
