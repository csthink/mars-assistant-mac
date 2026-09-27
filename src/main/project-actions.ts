import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../shared/protocol";
import type { Project } from "../shared/projects";
import {
  actionForm,
  formProblem,
  type PreparedProjectAction,
  type ProjectActionReply,
  type ProjectActionRequest,
} from "../shared/project-actions";
import { projectScopeProblem } from "../shared/project-work";
import {
  validEvidenceRef,
  type ProjectionAction,
  type RuntimeOperation,
} from "../shared/runtime-host";
import {
  digestOf,
  packageDir,
  selfContainedProblem,
} from "./runtime-admission";
import { assertProjectFolder } from "./projects";
import type { RuntimeHost } from "./runtime-host";

/**
 * OD-425 R1: an action's payload schema is its own negotiated capability document
 * (the digest of the whole document) or exactly one entry under that document's root
 * `definitions` (the RFC 8785 digest of the entry). Nothing is looked up in another
 * capability's document; any other digest is an unknown schema (Contract: 未知 schema
 * 不尝试通用执行). Entries must be self-contained (R2): admission refuses others, and
 * this repeats the check for a document read at the moment of use.
 */
export function payloadSchemaOf(
  document: unknown,
  documentDigest: string,
  payloadDigest: string,
): unknown {
  if (payloadDigest === documentDigest) return document;
  const definitions =
    document && typeof document === "object" && !Array.isArray(document)
      ? (document as Record<string, unknown>).definitions
      : undefined;
  const entries =
    definitions &&
    typeof definitions === "object" &&
    !Array.isArray(definitions)
      ? Object.values(definitions).filter((e) => digestOf(e) === payloadDigest)
      : [];
  if (entries.length !== 1)
    throw Error(
      entries.length
        ? "该操作的输入格式摘要对应能力文档 definitions 中的多项，无法唯一确定（OD-425 R1），按未知格式拒绝。"
        : "该操作的输入格式摘要既不是其能力文档本身，也不是该文档 definitions 中的一项（OD-425 R1），按未知格式拒绝。",
    );
  if (selfContainedProblem(entries[0]))
    throw Error(
      "能力文档 definitions 中的该项不是自包含的输入格式（含 $ref 或 $id，OD-425 R2），按未知格式拒绝。",
    );
  return entries[0];
}
type Ticket = {
  owner: number;
  value: PreparedProjectAction;
  linkDigest: string;
  grantsDigest: string;
  settled?: boolean;
  read: Set<number>;
  operationId: string;
  payloadDigest?: string;
  result?: Promise<ProjectActionReply>;
};
export class ProjectActions {
  private tickets = new Map<string, Ticket>();
  private inFlight = new Map<string, Promise<ProjectActionReply>>();
  constructor(
    private options: {
      snapshot: () => Snapshot | undefined;
      host: RuntimeHost;
    },
  ) {}
  private project(id: string) {
    const p = this.options.snapshot()?.projects.find((p) => p.id === id);
    if (!p?.runtime) throw Error("项目尚未关联 Runtime。");
    return p;
  }
  private usable(p: Project, current = true) {
    const snapshot = this.options.snapshot()!;
    const issue = projectScopeProblem(snapshot, p.runtime!, current);
    if (issue) throw Error(issue);
    return snapshot.runtimeScopes.find(
      (s) =>
        s.instanceId === p.runtime!.instanceId &&
        s.scopeRef === p.runtime!.scopeRef,
    )!;
  }
  private async folder(p: Project) {
    await assertProjectFolder(p, "项目文件夹身份已变化，未提交操作。");
  }

  private form(p: Project, action: ProjectionAction) {
    const snapshot = this.options.snapshot()!,
      instance = snapshot.runtimeInstances.find(
        (i) => i.instanceId === p.runtime!.instanceId,
      ),
      installation = snapshot.runtimeInstallations.find(
        (i) => i.installationId === instance?.installationId,
      );
    if (
      !installation ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(action.capability.id) ||
      !instance?.negotiation?.capabilities.some(
        (c) => digestOf(c) === digestOf(action.capability),
      ) ||
      !installation.capabilities.some(
        (c) => digestOf(c) === digestOf(action.capability),
      )
    )
      throw Error("当前操作的能力尚未通过协商。");
    const path = join(
      packageDir(
        this.options.host.supervisor.runtimeRoot,
        installation.runtimeId,
        installation.artifactDigest,
      ),
      "capabilities",
      action.capability.id + ".json",
    );
    if (statSync(path).size > 1048576) throw Error("输入格式超过读取上限。");
    const document: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (digestOf(document) !== action.capability.schemaDigest)
      throw Error("能力文档摘要已变化，未提交操作。");
    const form = actionForm(
      payloadSchemaOf(
        document,
        action.capability.schemaDigest,
        action.payloadSchemaDigest,
      ),
    );
    if (form.type !== "object") throw Error("动作输入必须为对象。");
    return form;
  }
  private ticket(owner: number, projectId: string, token: string) {
    const t = this.tickets.get(token);
    if (!t || t.owner !== owner || t.value.projectId !== projectId)
      throw Error("确认已失效或不属于当前窗口，请重新打开操作。");
    if (!t.result && Date.now() > t.value.expiresAt)
      throw Error("确认已过期，请重新核对当前候选。");
    return t;
  }
  private async recheck(t: Ticket) {
    const p = this.project(t.value.projectId);
    await this.folder(p);
    const scope = this.usable(p);
    if (
      digestOf(p.runtime) !== t.linkDigest ||
      digestOf(scope.grantRefs) !== t.grantsDigest
    )
      throw Error("项目关联或授权已变化，请重新核对。");
    const projection = await this.options.host.projection(
      p.runtime!.instanceId,
      p.runtime!.scopeRef,
    );
    const a = projection.actions.find(
        (a) =>
          a.actionId === t.value.action.actionId &&
          a.objectRef === t.value.action.objectRef,
      ),
      o = projection.objects.find(
        (o) => o.objectRef === t.value.object.objectRef,
      );
    if (
      !a ||
      !a.enabled ||
      digestOf(a) !== digestOf(t.value.action) ||
      !o ||
      digestOf(o) !== digestOf(t.value.object)
    )
      throw Error("用户确认的操作或候选已变化，请关闭后重新核对。");
    if (t.value.pending) {
      const pending = projection.pendingItems.find(
        (i) => i.itemRef === t.value.pending!.itemRef,
      );
      if (
        !pending ||
        pending.status !== "pending" ||
        digestOf(pending) !== digestOf(t.value.pending)
      )
        throw Error("该待处理事项已变化或已处理，请重新读取。");
    }
    this.form(p, a);
    this.usable(p);
    return p;
  }
  async request(
    owner: number,
    c: ProjectActionRequest,
  ): Promise<ProjectActionReply> {
    try {
      const p = this.project(c.projectId),
        link = p.runtime!;
      if (c.type === "list")
        return {
          ok: true,
          operations: await this.options.host.projectOperations(
            link.instanceId,
            link.scopeRef,
          ),
        };
      if (c.type === "query") {
        this.usable(p, false);
        const existing = (
          await this.options.host.projectOperations(
            link.instanceId,
            link.scopeRef,
          )
        ).find((o) => o.operationId === c.operationId);
        if (!existing) throw Error("操作不属于当前项目。");
        const result = await this.options.host.operationGet(
          link.instanceId,
          link.scopeRef,
          existing.operationId,
        );
        return {
          ok: true,
          operation: result.operation,
          message: result.error
            ? `结果尚未核实：${result.error.code}`
            : undefined,
        };
      }
      if (c.type === "prepare") {
        await this.folder(p);
        const scope = this.usable(p),
          projection = await this.options.host.projection(
            link.instanceId,
            link.scopeRef,
          );
        const a = projection.actions.find(
            (a) => a.actionId === c.actionId && a.objectRef === c.objectRef,
          ),
          o = projection.objects.find((o) => o.objectRef === c.objectRef);
        if (!a || !o || !a.enabled)
          throw Error(a?.disabledReason || "当前没有可用的该操作。");
        if (
          a.expectedRevision !== c.expectedRevision ||
          a.candidateRef !== c.candidateRef
        )
          throw Error("操作版本已变化，请重新读取。");
        const pending = c.pending
          ? projection.pendingItems.find(
              (i) => i.itemRef === c.pending!.itemRef,
            )
          : undefined;
        if (
          c.pending &&
          (!pending ||
            pending.revision !== c.pending.revision ||
            pending.status !== "pending" ||
            pending.scopeRef !== link.scopeRef ||
            pending.objectRef !== o.objectRef ||
            !pending.actionIds.includes(a.actionId) ||
            digestOf(pending.capability) !== digestOf(a.capability))
        )
          throw Error("该待处理事项已变化或不属于此操作。");
        const form = this.form(p, a);
        const refs = [
          ...o.evidence,
          ...projection.pendingItems
            .filter(
              (i) =>
                i.objectRef === o.objectRef &&
                i.actionIds.includes(a.actionId) &&
                i.status === "pending",
            )
            .flatMap((i) => i.evidence),
        ];
        if (
          !refs.every(
            (r) =>
              validEvidenceRef(r) &&
              (r as Record<string, unknown>).scopeRef === link.scopeRef,
          )
        )
          throw Error("确认所需证据不属于当前项目。");
        const evidence = [
          ...new Map(
            refs.map((r) => [digestOf(r), r as Record<string, unknown>]),
          ).values(),
        ];
        if (evidence.length > 32) throw Error("确认所需证据超过当前入口上限。");
        for (const [key, t] of this.tickets)
          if (Date.now() > t.value.expiresAt && (!t.result || t.settled))
            this.tickets.delete(key);
        if (this.tickets.size >= 128)
          throw Error("打开的操作过多，请稍后再试；已有操作可从记录查询。");
        const value: PreparedProjectAction = {
          token: randomUUID(),
          projectId: p.id,
          projectName: p.name,
          folder: p.folder.path,
          action: a,
          object: o,
          form,
          evidence,
          expiresAt: Date.now() + 10 * 60000,
          ...(pending ? { pending } : {}),
        };
        this.tickets.set(value.token, {
          owner,
          value,
          linkDigest: digestOf(link),
          grantsDigest: digestOf(scope.grantRefs),
          read: new Set(),
          operationId: "op:" + randomUUID(),
        });
        return { ok: true, prepared: value };
      }
      const t = this.ticket(owner, c.projectId, c.token);
      if (c.type === "evidence") {
        const p = await this.recheck(t),
          ref = t.value.evidence[c.index];
        if (!ref) throw Error("证据不存在。");
        if (ref.mediaType === "application/octet-stream")
          throw Error("此二进制证据暂无可用阅读入口。");
        const bytes = await this.options.host.projectEvidence(
          p.runtime!.instanceId,
          p.runtime!.scopeRef,
          ref,
        );
        await this.recheck(t);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        t.read.add(c.index);
        return {
          ok: true,
          evidence: {
            text,
            digest: String(ref.digest),
            mediaType: String(ref.mediaType),
          },
        };
      }
      const payloadDigest = digestOf(c.payload);
      if (t.payloadDigest && t.payloadDigest !== payloadDigest)
        throw Error("该确认已提交其他输入，请从原操作查询结果。");
      if (t.result) {
        this.usable(p, false);
        return t.result;
      }
      const problem = formProblem(t.value.form, c.payload);
      if (problem) throw Error(problem);
      if (
        t.value.action.requiresHumanDecision &&
        t.value.evidence.some((_, i) => !t.read.has(i))
      )
        throw Error("请先打开并核对全部确认依据。");
      t.payloadDigest = payloadDigest;
      const intent = digestOf({
        projectId: p.id,
        action: t.value.action,
        object: t.value.object,
        payload: c.payload,
      });
      const pending = this.inFlight.get(intent);
      t.result = pending ?? this.submit(t, c.payload);
      if (!pending) {
        this.inFlight.set(intent, t.result);
        void t.result.finally(() => this.inFlight.delete(intent));
      }
      void t.result.finally(() => {
        t.settled = true;
      });
      return t.result;
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : "操作未完成。",
      };
    }
  }
  private async submit(
    t: Ticket,
    payload: Record<string, unknown>,
  ): Promise<ProjectActionReply> {
    try {
      const p = await this.recheck(t),
        link = p.runtime!;
      const old = (
        await this.options.host.projectOperations(
          link.instanceId,
          link.scopeRef,
        )
      ).find(
        (o) =>
          o.request?.actionId === t.value.action.actionId &&
          o.request?.objectRef === t.value.action.objectRef &&
          o.request?.expectedRevision === t.value.action.expectedRevision &&
          o.request?.candidateRef === t.value.action.candidateRef &&
          digestOf(o.request?.payload) === digestOf(payload),
      );
      if (old)
        return {
          ok: true,
          operation: old,
          message: "该输入已有操作记录，请查询原操作结果。",
        };
      const input = {
        actionId: t.value.action.actionId,
        objectRef: t.value.action.objectRef,
        payload,
        expectedAction: t.value.action,
        expectedGrantsDigest: t.grantsDigest,
        operationId: t.operationId,
      };
      const operation: RuntimeOperation = t.value.action.requiresHumanDecision
        ? (
            await this.options.host.decide(link.instanceId, link.scopeRef, {
              ...input,
              evidence: t.value.evidence,
              actorRef: "actor:local-user",
            })
          ).operation
        : await this.options.host.invoke(link.instanceId, link.scopeRef, input);
      return { ok: true, operation };
    } catch (e) {
      return {
        ok: false,
        message:
          e instanceof Error ? e.message : "提交结果未确认，请从操作记录查询。",
      };
    }
  }
}
