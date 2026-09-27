import { validEvidenceRef } from "../shared/runtime-host";
import type { Snapshot } from "../shared/protocol";
import {
  evidenceAt,
  type ProjectEvidenceReply,
  type ProjectEvidenceRequest,
} from "../shared/project-evidence";
import { projectScopeProblem } from "../shared/project-work";
import { assertProjectFolder } from "./projects";
import { digestOf } from "./runtime-admission";
import type { RuntimeHost } from "./runtime-host";
export class ProjectEvidence {
  constructor(
    private options: {
      snapshot: () => Snapshot | undefined;
      host: RuntimeHost;
    },
  ) {}
  async read(input: ProjectEvidenceRequest): Promise<ProjectEvidenceReply> {
    try {
      const p = this.options
        .snapshot()
        ?.projects.find((p) => p.id === input.projectId);
      if (!p?.runtime) throw Error("项目尚未关联 Runtime。");
      const link = p.runtime,
        linkDigest = digestOf(link);
      const recheck = async () => {
        const snapshot = this.options.snapshot(),
          current = snapshot?.projects.find((p) => p.id === input.projectId);
        if (
          !snapshot ||
          !current?.runtime ||
          digestOf(current.runtime) !== linkDigest
        )
          throw Error("项目关联已变化，保留上一内容。");
        const problem = projectScopeProblem(snapshot, current.runtime);
        if (problem) throw Error(problem);
        await assertProjectFolder(current);
        const projection = await this.options.host.projection(
          link.instanceId,
          link.scopeRef,
        );
        if ("itemRef" in input) {
          const item = projection.pendingItems.find(
            (i) => i.itemRef === input.itemRef,
          );
          const ref = item?.evidence[input.index];
          const latest = this.options.snapshot();
          if (!latest || projectScopeProblem(latest, link))
            throw Error("读取期间项目授权或连接已变化。");
          if (
            !item ||
            item.revision !== input.revision ||
            !validEvidenceRef(ref)
          )
            throw Error("待处理事项或固定依据已变化，请重新读取。");
          return ref as Record<string, unknown>;
        }
        const object = projection.objects.find(
          (o) => o.objectRef === input.objectRef,
        );
        if (!object || object.revision !== input.revision)
          throw Error("内容版本已变化，请重新选择；上一内容已保留。");
        const latest = this.options.snapshot();
        if (!latest || projectScopeProblem(latest, link))
          throw Error("读取期间项目授权或连接已变化。");
        return evidenceAt(object, input.source);
      };
      const ref = await recheck();
      if (ref.scopeRef !== link.scopeRef) throw Error("证据不属于当前项目。");
      if (ref.mediaType === "application/octet-stream")
        throw Error("此二进制产物暂无可用阅读入口。");
      const bytes = await this.options.host.projectEvidence(
        link.instanceId,
        link.scopeRef,
        ref,
      );
      if (digestOf(await recheck()) !== digestOf(ref))
        throw Error("证据引用已变化，请重新读取。");
      return {
        ok: true,
        evidence: ref,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e ? String(e.code) : "";
      const messages: Record<string, string> = {
        INTEGRITY_MISMATCH: "证据的长度、偏移或摘要不匹配，未更新内容。",
        NOT_FOUND: "固定版本的证据不可用，上一内容已保留。",
        PERMISSION_DENIED: "证据读取权限已失效。",
        PERMISSION_REVOKED: "证据读取权限已撤销。",
      };
      return {
        ok: false,
        message:
          messages[code] ??
          (e instanceof Error ? e.message : "证据未读取，上一内容已保留。"),
      };
    }
  }
}
