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
    const task = store.snapshot().widgetGeneration!.tasks[0];
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
    const candidate = store.snapshot().widgetGeneration!.candidates[0];
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
