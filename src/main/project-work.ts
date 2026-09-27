import type { Project } from "../shared/projects";
import type { Reply, Snapshot } from "../shared/protocol";
import type {
  ProjectRequest,
  ProjectRole,
  ProjectWorkReply,
  ProjectWorkView,
} from "../shared/project-work";
import { projectScopeProblem } from "../shared/project-work";
import {
  awaitingProjection,
  type ProjectionAwaiting,
} from "../shared/project-actions";
import type { RuntimeProjection, RuntimeScope } from "../shared/runtime-host";
import type { RuntimeHost } from "./runtime-host";
import type { ExecutionProfile } from "./runtime-execution-port";
import { assertProjectFolder } from "./projects";
import { claudeImplementerProfileId } from "./execution-claude";
import { codexReviewerProfileId } from "./execution-codex";
export class ProjectWorkspace {
  constructor(
    private readonly options: {
      snapshot: () => Snapshot | undefined;
      host: Pick<RuntimeHost, "projection" | "roleBinding">;
      profiles: () => ExecutionProfile[];
      save: (command: {
        type: "projectWork";
        request: Exclude<ProjectRequest, { type: "read" }>;
      }) => Promise<Reply>;
    },
  ) {}
  /**
   * KB-308 way out: the snapshotId under which each awaiting operation was first seen. Should a
   * Runtime keep an action's binding after it succeeded, no event would ever move it; a full
   * snapshot taken after the success was seen is a consistent state that already contains the
   * success, so an operation first seen under another snapshotId no longer holds its object.
   * “重新同步” asks for such a snapshot (runtime:control reverify); a reconnection takes one too.
   */
  private readonly awaitingSeen = new Map<string, string | null>();
  private awaiting(
    scope: RuntimeScope,
    projection: RuntimeProjection,
    snapshot: Snapshot,
  ): ProjectionAwaiting[] {
    const key = (operationId: string) =>
      `${scope.instanceId}|${scope.scopeRef}|${operationId}`;
    const candidates = awaitingProjection(
      projection,
      snapshot.runtimeOperations,
      scope,
    );
    const live = new Set(candidates.map((a) => key(a.operationId)));
    const prefix = `${scope.instanceId}|${scope.scopeRef}|`;
    for (const seen of [...this.awaitingSeen.keys()])
      if (seen.startsWith(prefix) && !live.has(seen))
        this.awaitingSeen.delete(seen);
    return candidates.filter((a) => {
      const seen = key(a.operationId);
      if (!this.awaitingSeen.has(seen))
        this.awaitingSeen.set(seen, scope.snapshotId);
      return this.awaitingSeen.get(seen) === scope.snapshotId;
    });
  }
  private project(id: string) {
    const p = this.options.snapshot()?.projects.find((p) => p.id === id);
    if (!p) throw Error("项目已不存在。");
    return p;
  }
  private async folder(project: Project) {
    await assertProjectFolder(
      project,
      "项目文件夹身份已变化，关联与上下文未更新。",
    );
  }

  private profileProblem(project: Project, role: ProjectRole) {
    if (!project.runtime) return "尚未关联项目 Runtime。";
    const profile = this.options
      .profiles()
      .find(
        (p) =>
          p.id ===
            (role === "implementer"
              ? claudeImplementerProfileId
              : codexReviewerProfileId) &&
          p.purpose ===
            (role === "implementer" ? "coding-implementer" : "review"),
      );
    if (!profile) return "执行能力尚未核验，请在全局模型设置检查连接。";
    const instance = this.options
      .snapshot()
      ?.runtimeInstances.find(
        (i) => i.instanceId === project.runtime!.instanceId,
      );
    if (
      !instance?.negotiation?.executionProfiles.some(
        (p) =>
          p.id === profile.id &&
          p.version === profile.version &&
          p.digest === profile.digest,
      )
    )
      return "Runtime 尚未接纳当前角色的执行配置，不能保存该选择。";
    return "";
  }
  async request(c: ProjectRequest): Promise<ProjectWorkReply> {
    try {
      let p = this.project(c.projectId);
      if (c.type === "read") {
        const snapshot = this.options.snapshot()!;
        const scopes = snapshot.runtimeScopes.filter(
          (s) =>
            snapshot.runtimeResources.find((r) => r.handle === s.resourceHandle)
              ?.path === p.folder.canonicalPath,
        );
        const scope = p.runtime
          ? (snapshot.runtimeScopes.find(
              (s) =>
                s.instanceId === p.runtime!.instanceId &&
                s.scopeRef === p.runtime!.scopeRef,
            ) ?? null)
          : null;
        const view: ProjectWorkView = {
          scopes,
          scope,
          projection: scope
            ? await this.options.host.projection(
                scope.instanceId,
                scope.scopeRef,
              )
            : null,
          roles: [],
          unavailable: p.runtime
            ? projectScopeProblem(snapshot, p.runtime)
            : "尚无已关联的 Runtime 数据。",
          awaiting: [],
        };
        for (const role of ["implementer", "reviewer"] as const) {
          const binding = scope
            ? await this.options.host.roleBinding(
                scope.instanceId,
                scope.scopeRef,
                `role:${role}`,
              )
            : null;
          const reason = view.unavailable || this.profileProblem(p, role);
          view.roles.push({ role, binding, available: !reason, reason });
        }
        // Read may span service requests: do not advertise an earlier grant or freshness as current.
        if (p.runtime) {
          const latest = this.options.snapshot()!;
          view.unavailable = projectScopeProblem(latest, p.runtime);
          // Operations read after the projection: a success that arrived meanwhile is not missed.
          const current = latest.runtimeScopes.find(
            (s) =>
              s.instanceId === p.runtime!.instanceId &&
              s.scopeRef === p.runtime!.scopeRef,
          );
          if (current && view.projection)
            view.awaiting = this.awaiting(current, view.projection, latest);
        }
        return { ok: true, view };
      }
      if (
        c.type === "bind" ||
        c.type === "role" ||
        (c.type === "context" && c.objectRef)
      ) {
        await this.folder(p);
        p = this.project(c.projectId);
      }
      if (c.type === "role") {
        const problem = this.profileProblem(p, c.role);
        if (problem) throw Error(problem);
      }
      const reply = await this.options.save({
        type: "projectWork",
        request: c,
      });
      return reply.ok ? { ok: true } : { ok: false, message: reply.message };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "项目操作未完成。",
      };
    }
  }
}
