import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { buildWidgetPackage } from "../../src/main/widget-package";
import type { Command, HostCommand } from "../../src/shared/protocol";
/** Offline fixture: a validated artifact enters the real store, never a model acceptance claim. */
export function seedWidgetCandidate(root: string, unchanged = false) {
  const store = new Store(root),
    draftId = randomUUID(),
    connectionId = randomUUID();
  function command(c: Command | HostCommand, host = false) {
    const reply = store.execute(c, "main", host ? "host" : "renderer");
    if (!reply.ok) throw new Error(reply.message);
    return reply;
  }
  try {
    command({
      type: "upsertConnection",
      id: connectionId,
      name: "Offline artifact",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "offline-only",
      secretRef: randomUUID(),
      imageInput: "unknown",
      contextChars: null,
      revision: 0,
    });
    command({
      type: "createWidgetDraft",
      id: draftId,
      name: "Seven counter",
      sourceConversationId: null,
    });
    command({
      type: "saveWidgetDraft",
      id: draftId,
      name: "Seven counter",
      input: "Count by seven",
      revision: 0,
    });
    command({
      type: "submitWidgetGeneration",
      draftId,
      requestId: randomUUID(),
      revision: 1,
      connectionId,
      model: "offline-only",
    });
    const task = store
      .snapshot()
      .widgetGeneration!.tasks.find((t) => t.draftId === draftId)!;
    command(
      {
        type: "claimWidgetGeneration",
        taskId: task.id,
        executionId: task.executionId,
      },
      true,
    );
    const build = buildWidgetPackage(
      JSON.stringify({
        schemaVersion: 1,
        name: "Seven counter",
        view: {
          html: "<button id='seven'>0</button>",
          css: "button{font-size:24px;color:#163d27;background:#dff4df;border:0;border-radius:12px;padding:24px}",
          js: "document.querySelector('#seven').addEventListener('click',()=>{document.querySelector('#seven').textContent='7'});",
        },
        config: [],
        draftFields: [],
        capabilities: [],
        resources: [],
      }),
    );
    command(
      {
        type: "receiveWidgetCandidate",
        taskId: task.id,
        executionId: task.executionId,
        build,
      },
      true,
    );
    command(
      {
        type: "finishWidgetGeneration",
        taskId: task.id,
        executionId: task.executionId,
        state: "completed",
        error: null,
      },
      true,
    );
    const candidate = store
      .snapshot()
      .widgetGeneration!.candidates.find((c) => c.draftId === draftId)!;
    if (unchanged)
      store.db
        .prepare(
          "UPDATE generated_candidates SET state='unchanged',differences='[]' WHERE id=?",
        )
        .run(candidate.id);
    command({ type: "selectWidgetDraft", id: draftId });
    return { draftId, candidateId: candidate.id };
  } finally {
    store.close();
  }
}

export function seedWidgetCandidateSet(root: string) {
  const first = seedWidgetCandidate(root),
    second = seedWidgetCandidate(root);
  const store = new Store(root);
  const command = (c: Command | HostCommand, host = false) => {
    const r = store.execute(c, "main", host ? "host" : "renderer");
    if (!r.ok) throw new Error(r.message);
  };
  try {
    for (const id of [first.candidateId, second.candidateId]) {
      const c = store
        .snapshot()
        .widgetGeneration!.candidates.find((c) => c.id === id)!;
      command({
        type: "retainWidgetCandidate",
        candidateId: id,
        digest: c.digest,
        requirementRevision: c.requirementRevision,
      });
    }
    const targets = store.snapshot().widgetGeneration!.widgets;
    const draftId = randomUUID();
    command({
      type: "createWidgetEditDraft",
      id: draftId,
      widgetIds: targets.map((w) => w.id),
    });
    command({
      type: "saveWidgetDraft",
      id: draftId,
      revision: 0,
      name: "两个计数控件",
      input: "分别改变两项行为，保持顺序，使用紧凑布局",
    });
    command({
      type: "submitWidgetGeneration",
      draftId,
      requestId: randomUUID(),
      revision: 1,
      connectionId: store.snapshot().connections[0].id,
      model: "offline-only",
    });
    const t = store
      .snapshot()
      .widgetGeneration!.tasks.find((t) => t.draftId === draftId)!;
    command(
      {
        type: "claimWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
      },
      true,
    );
    const builds = targets.map((w, i) => ({
      widgetId: w.id,
      build: buildWidgetPackage(
        JSON.stringify({
          schemaVersion: 1,
          name: `计数控件 ${i + 1}`,
          view: {
            html: `<button>计数 ${i + 1}</button>`,
            css: "button{font-size:24px;padding:24px;border:0;border-radius:12px;color:#163d27;background:#dff4df}",
            js: "",
          },
          config: [],
          draftFields: [],
          capabilities: [],
          resources: [],
        }),
      ),
    }));
    command(
      {
        type: "receiveWidgetCandidateSet",
        taskId: t.id,
        executionId: t.executionId,
        builds,
        layout: { minWidth: 300, gap: 12, density: "compact" },
      },
      true,
    );
    command(
      {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "completed",
        error: null,
      },
      true,
    );
    command({ type: "selectWidgetDraft", id: draftId });
    return { draftId, targets };
  } finally {
    store.close();
  }
}
