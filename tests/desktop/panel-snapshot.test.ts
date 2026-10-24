import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/service/store";
import { panelSnapshot } from "../../src/main/panel-snapshot";
import {
  seedRetainedWidgets,
  seedWidgetCandidate,
} from "./widget-generation-fixture";

// mac-feature-t12 (WB-03, architecture 可信界面): the menu bar panel receives what it shows and nothing else.
test("panel snapshot: retained widgets, their order, layout and settings reach the panel; drafts, candidates, tasks, conversations and grants do not", () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/panel-snapshot-"));
  const widgets = seedRetainedWidgets(root, ["便笺", "计时"]);
  seedWidgetCandidate(root);
  const store = new Store(root);
  try {
    assert(store.execute({ type: "create", id: randomUUID() }, "main").ok);
    const full = store.snapshot();
    assert(full.conversations.length > 0);
    assert(full.connections.length > 0);
    assert(full.widgetGeneration!.drafts.length > 0);
    assert(full.widgetGeneration!.candidates.length > 0);
    const panel = panelSnapshot(full);
    assert.deepEqual(
      panel.widgetGeneration!.widgets.map((w) => w.id),
      widgets.map((w) => w.id),
    );
    assert.equal(
      panel.widgetGeneration!.orderRevision,
      full.widgetGeneration!.orderRevision,
    );
    assert.deepEqual(
      panel.widgetGeneration!.layout,
      full.widgetGeneration!.layout,
    );
    assert.deepEqual(panel.settings, full.settings);
    assert.equal(panel.revision, full.revision);
    assert.equal(panel.rootId, full.rootId);
    assert.equal(panel.dataRoot, "");
    assert.deepEqual(panel.selected, { main: null, panel: null });
    for (const key of ["drafts", "tasks", "candidates"] as const)
      assert.deepEqual(panel.widgetGeneration![key], [], key);
    for (const [key, value] of Object.entries(panel))
      if (Array.isArray(value)) assert.deepEqual(value, [], key);
    // Nothing of the full snapshot's text reaches the panel apart from the widgets and settings it shows.
    const text = JSON.stringify(panel);
    for (const c of full.conversations) assert(!text.includes(c.id));
    for (const c of full.connections) assert(!text.includes(c.id));
    for (const d of full.widgetGeneration!.drafts) assert(!text.includes(d.id));
  } finally {
    store.close();
  }
});
