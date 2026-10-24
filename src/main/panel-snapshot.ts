import type { Snapshot } from "../shared/protocol";

/**
 * What the menu bar panel's renderer receives of the business snapshot (WB-03, architecture 可信界面): the
 * retained widgets with their order and layout, the settings that style the page, and the identity and revision
 * that order snapshots. Conversations, drafts, candidates, generation tasks, connections, permissions, pending
 * items, projects and Runtime records stay with the main window; the panel never shows them.
 */
export function panelSnapshot(snapshot: Snapshot): Snapshot {
  const widgets = snapshot.widgetGeneration;
  return {
    revision: snapshot.revision,
    rootId: snapshot.rootId,
    dataRoot: "",
    settings: snapshot.settings,
    selected: { main: null, panel: null },
    widgetGeneration: widgets && {
      ...(widgets.layout ? { layout: widgets.layout } : {}),
      widgets: widgets.widgets,
      orderRevision: widgets.orderRevision,
      drafts: [],
      tasks: [],
      candidates: [],
      selected: { main: null, panel: null },
    },
    projects: [],
    permissions: [],
    toolOperations: [],
    workbenchActions: [],
    conversations: [],
    pinnedOrder: [],
    connections: [],
    messages: [],
    turns: [],
    attachments: [],
    draftAttachments: [],
    messageAttachments: [],
    activeTurns: [],
    pendingItems: [],
    events: [],
    runtimeInstallations: [],
    runtimeInstances: [],
    runtimeResources: [],
    runtimeScopes: [],
    runtimeGrants: [],
    runtimeOperations: [],
    runtimeDecisions: [],
    runtimeContextSnapshots: [],
    runtimeExecutions: [],
  };
}
