/**
 * Project repository governance access in the main process (feature-t31 S-06,
 * OD-416). Every step re-checks the project folder identity (PROJECT-01), reads the
 * current Host records and refuses with the actual reason; nothing reads or changes
 * the folder's contents, installs governance content, writes a Runtime's binding file
 * or starts work. Authorization grants exactly the proposal the person reviewed: the
 * renderer sends back the proposal digest and the grant set is rebuilt from the
 * current records and compared before anything is written (ACCESS-01).
 */
import type { Project } from "../shared/projects";
import type { Snapshot } from "../shared/protocol";
import {
  accessLifetimeDays,
  accessOperations,
  accessPurpose,
  proposalGrants,
  type AccessInstance,
  type AccessProposal,
  type ProjectAccessReply,
  type ProjectAccessRequest,
  type ProjectAccessView,
} from "../shared/project-access";
import {
  extensionState,
  extensionStateLabels,
  type RuntimeGrant,
} from "../shared/runtime-host";
import { digestOf } from "./runtime-admission";
import { assertProjectFolder } from "./projects";
import type { RuntimeHost } from "./runtime-host";

const usable = (g: RuntimeGrant) =>
  g.status === "active" && Date.parse(g.expiresAt) > Date.now();
/** A refusal from the Host or the Runtime, with its Contract code when it has one. */
function reason(error: unknown) {
  const code = (error as { code?: unknown }).code;
  const message = String((error as Error)?.message ?? error).slice(0, 600);
  return typeof code === "string" && code ? `${code}：${message}` : message;
}

export class ProjectAccess {
  /** One access step per project at a time: a second click cannot race the first. */
  private busy = new Set<string>();
  constructor(
    private readonly options: {
      snapshot: () => Snapshot | undefined;
      host: Pick<
        RuntimeHost,
        | "registerResource"
        | "openScope"
        | "grantBatch"
        | "authorize"
        | "revokeGrants"
        | "sync"
      >;
    },
  ) {}
  private project(id: string): Project {
    const p = this.options.snapshot()?.projects.find((p) => p.id === id);
    if (!p) throw Error("项目已不存在。");
    return p;
  }
  view(p: Project): ProjectAccessView {
    const s = this.options.snapshot()!;
    const resource =
      s.runtimeResources.find((r) => r.path === p.folder.canonicalPath) ?? null;
    const instances: AccessInstance[] = [];
    for (const installation of s.runtimeInstallations) {
      if (installation.incompatibility) continue;
      const instance = s.runtimeInstances.find(
        (i) => i.installationId === installation.installationId,
      );
      if (!instance) continue;
      const scopes = s.runtimeScopes.filter(
        (x) => x.instanceId === instance.instanceId,
      );
      const card = extensionState(installation, instance, scopes);
      const scope = resource
        ? (scopes.find((x) => x.resourceHandle === resource.handle) ?? null)
        : null;
      const linked = scope
        ? s.projects.find(
            (q) =>
              q.runtime?.instanceId === instance.instanceId &&
              q.runtime.scopeRef === scope.scopeRef,
          )
        : undefined;
      const scoped = scope
        ? s.runtimeGrants.filter(
            (g) =>
              g.instanceId === instance.instanceId &&
              g.scopeRef === scope.scopeRef,
          )
        : [];
      const grants = scoped.filter(usable);
      // Nothing usable: the most recent end (a revocation, or an expiry that has passed) tells how access stopped.
      const ended: NonNullable<AccessInstance["scope"]>["ended"] = grants.length
        ? null
        : (scoped
            .map((g) =>
              g.status === "revoked"
                ? { reason: "revoked" as const, at: g.revokedAt ?? g.createdAt }
                : { reason: "expired" as const, at: g.expiresAt },
            )
            .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null);
      const capabilities =
        instance.negotiation?.capabilities.map((c) => c.id) ?? [];
      const proposal: AccessProposal | null =
        scope && resource && capabilities.length
          ? {
              projectId: p.id,
              installationId: installation.installationId,
              instanceId: instance.instanceId,
              runtimeId: installation.runtimeId,
              version: installation.version,
              publisherId: installation.publisherId,
              scopeRef: scope.scopeRef,
              resourceHandle: resource.handle,
              folder: p.folder.canonicalPath,
              capabilities,
              operations: {
                read: [...accessOperations.read],
                act: [...accessOperations.act],
              },
              lifetimeDays: accessLifetimeDays,
            }
          : null;
      instances.push({
        instanceId: instance.instanceId,
        installationId: installation.installationId,
        runtimeId: installation.runtimeId,
        version: installation.version,
        publisherId: installation.publisherId,
        state: extensionStateLabels[card.state],
        reason: card.reason,
        ready: instance.state === "ready" && !!instance.negotiation,
        instanceDir: instance.launchDirectories?.instanceDir ?? null,
        scope: scope && {
          scopeRef: scope.scopeRef,
          state: scope.state,
          freshness: scope.freshness,
          lastError: scope.lastError,
          activeGrants: grants.length,
          expiresAt: grants.length
            ? grants.map((g) => g.expiresAt).sort()[grants.length - 1]
            : null,
          ended,
          linkedElsewhere:
            linked && linked.id !== p.id
              ? { projectId: linked.id, name: linked.name }
              : null,
          linkedHere: linked?.id === p.id,
        },
        proposal,
        proposalDigest: proposal ? digestOf(proposal) : null,
      });
    }
    return {
      folder: {
        path: p.folder.canonicalPath,
        gitRoot: p.folder.git?.root ?? null,
      },
      resource,
      instances,
    };
  }
  async request(c: ProjectAccessRequest): Promise<ProjectAccessReply> {
    let p: Project;
    try {
      p = this.project(c.projectId);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (c.type === "read") return { ok: true, view: this.view(p) };
    if (this.busy.has(p.id))
      return {
        ok: false,
        message: "上一步接入仍在进行，请等待结果。",
        view: this.view(p),
      };
    this.busy.add(p.id);
    try {
      const message = await this.step(p, c);
      return { ok: true, view: this.view(this.project(p.id)), message };
    } catch (error) {
      const current = this.options
        .snapshot()
        ?.projects.find((q) => q.id === p.id);
      return {
        ok: false,
        message: (error as Error).message,
        view: current ? this.view(current) : undefined,
      };
    } finally {
      this.busy.delete(p.id);
    }
  }
  private async step(
    p: Project,
    c: Exclude<ProjectAccessRequest, { type: "read" }>,
  ): Promise<string> {
    // PROJECT-01: path changes, symbolic links and replaced folders are re-checked before every step.
    await assertProjectFolder(
      p,
      "项目文件夹身份已变化，接入未继续。请核对文件夹后重新创建项目。",
    );
    const host = this.options.host;
    if (c.type === "register") {
      if (this.view(p).resource) return "项目文件夹已登记。";
      const resource = await host
        .registerResource(p.folder.canonicalPath)
        .catch((error) => {
          throw Error("登记未完成：" + reason(error));
        });
      if (resource.path !== p.folder.canonicalPath)
        throw Error("登记的文件夹与项目文件夹不一致，未继续。");
      return "已登记项目文件夹。只记录其身份，未读取或修改文件夹内容。";
    }
    const view = this.view(p);
    const entry = view.instances.find((i) => i.instanceId === c.instanceId);
    if (!entry) throw Error("所选扩展实例不存在或与本机不兼容。");
    if (!view.resource) throw Error("请先登记项目文件夹。");
    if (entry.scope?.linkedElsewhere)
      throw Error(
        `该文件夹的项目范围已由项目“${entry.scope.linkedElsewhere.name}”关联；同一仓库不能作为两个独立项目接入。`,
      );
    if (!entry.ready)
      throw Error(
        `扩展实例未就绪（${entry.state}${entry.reason ? "：" + entry.reason : ""}），请在 设置 → 扩展管理 恢复后重试。`,
      );
    if (c.type === "open") {
      const scope = await host
        .openScope(entry.instanceId, view.resource.handle)
        .catch((error) => {
          throw Error("扩展未打开项目范围（" + reason(error) + "）");
        });
      return scope.state === "active"
        ? "项目范围已打开并处于授权状态。"
        : "已打开项目范围；尚未授权，扩展还不能读取该仓库。";
    }
    if (!entry.scope || entry.scope.scopeRef !== c.scopeRef)
      throw Error("项目范围已变化，请重新核对。");
    if (!entry.proposal || entry.proposalDigest !== c.proposalDigest)
      throw Error("授权范围已变化，请重新核对后再确认。");
    const grants = await host.grantBatch(
      entry.instanceId,
      entry.scope.scopeRef,
      proposalGrants(entry.proposal),
      accessPurpose(p.name),
      accessLifetimeDays * 86_400_000,
    );
    let state: string;
    try {
      state = (await host.authorize(entry.instanceId, entry.scope.scopeRef))
        .state;
    } catch (error) {
      // ACCESS-01: a refused authorization leaves no usable grant behind.
      await host
        .revokeGrants(
          entry.instanceId,
          grants.map((g) => g.ref.id),
        )
        .catch(() => undefined);
      throw Error("扩展拒绝授权，已撤回本次授权记录（" + reason(error) + "）");
    }
    if (state !== "active") {
      await host
        .revokeGrants(
          entry.instanceId,
          grants.map((g) => g.ref.id),
        )
        .catch(() => undefined);
      throw Error(
        "扩展未接受授权，项目范围仍未授权；已撤回本次授权记录。请核对扩展发布方要求后重试。",
      );
    }
    // The projection follows in the background; freshness shows until it is current.
    void host.sync(entry.instanceId, entry.scope.scopeRef).catch(() => {});
    return `已授权 ${grants.length} 项，至 ${new Date(grants[0].expiresAt).toLocaleDateString("zh-CN")}。`;
  }
}
