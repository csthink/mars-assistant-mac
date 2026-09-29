import { test } from "node:test";
import assert from "node:assert/strict";
import {
  columnLayout,
  expandsAsOverlay,
  COLUMN,
} from "../../src/renderer/column-layout";

const base = {
  sidebarCollapsed: false,
  rightOpen: false,
  rightWidth: null,
  takeover: false,
} as const;

test("column layout: the four constants and the widths they imply", () => {
  assert.deepEqual(COLUMN, {
    rail: 56,
    sidebar: 248,
    centerMin: 480,
    rightMin: 320,
    rightDefault: 400,
    rightStep: 24,
  });
  // Four columns side by side need rail + sidebar + centre minimum + right minimum.
  assert.equal(
    COLUMN.rail + COLUMN.sidebar + COLUMN.centerMin + COLUMN.rightMin,
    1104,
  );
});

test("column layout: the measured samples of the prototype at 1440, 1150, 1100, 900 and 840", () => {
  // 1440 with the right column open: 56, 248, 736, 400.
  const wide = columnLayout({ ...base, width: 1440, rightOpen: true });
  assert.deepEqual(
    [wide.rail, wide.sidebarWidth, wide.center, wide.right],
    [56, 248, 736, 400],
  );
  assert.equal(wide.sidebar, "expanded");
  assert.equal(wide.rightMax, 1440 - 784);
  // 1150: the default 400 does not fit next to an expanded sidebar; the right column takes W − 784.
  const middle = columnLayout({ ...base, width: 1150, rightOpen: true });
  assert.deepEqual(
    [middle.rail, middle.sidebarWidth, middle.center, middle.right],
    [56, 248, 480, 366],
  );
  // 1100 with the right column open: the sidebar folds automatically.
  const narrow = columnLayout({ ...base, width: 1100, rightOpen: true });
  assert.deepEqual(
    [narrow.rail, narrow.sidebarWidth, narrow.center, narrow.right],
    [56, 0, 644, 400],
  );
  assert.equal(narrow.sidebar, "auto-collapsed");
  // 900 × 680: right open gives centre 480 and right 364; closing it restores the sidebar and centre 596.
  const minimum = columnLayout({ ...base, width: 900, rightOpen: true });
  assert.deepEqual([minimum.center, minimum.right], [480, 364]);
  assert.equal(minimum.rightMax, 364);
  assert.equal(minimum.sidebar, "auto-collapsed");
  const closed = columnLayout({ ...base, width: 900 });
  assert.deepEqual(
    [closed.sidebar, closed.sidebarWidth, closed.center, closed.right],
    ["expanded", 248, 596, 0],
  );
  // 840 is below the supported minimum: the right column only opens by taking over the centre.
  const below = columnLayout({ ...base, width: 840, rightOpen: true });
  assert.equal(below.takeoverOnly, true);
  assert.equal(below.takeover, true);
  assert.equal(below.center, 0);
  assert.equal(below.right, 840 - 56);
});

test("column layout: every row of the window width table", () => {
  for (let width = 900; width <= 1600; width += 7) {
    for (const rightOpen of [false, true]) {
      for (const sidebarCollapsed of [false, true]) {
        const layout = columnLayout({
          ...base,
          width,
          rightOpen,
          sidebarCollapsed,
        });
        const label = `${width} right=${rightOpen} collapsed=${sidebarCollapsed}`;
        assert.equal(layout.rail, 56, label);
        // The columns always fill the window exactly, with the centre at least 480.
        assert.equal(
          layout.rail + layout.sidebarWidth + layout.center + layout.right,
          width,
          label,
        );
        assert.ok(layout.center >= 480, label);
        if (sidebarCollapsed) assert.equal(layout.sidebar, "collapsed", label);
        else if (rightOpen && width < 1104)
          assert.equal(layout.sidebar, "auto-collapsed", label);
        else assert.equal(layout.sidebar, "expanded", label);
        if (rightOpen) {
          assert.ok(layout.right >= 320, label);
          assert.equal(layout.right, Math.min(400, layout.rightMax), label);
          assert.equal(
            layout.rightMax,
            width - 56 - layout.sidebarWidth - 480,
            label,
          );
        } else assert.equal(layout.right, 0, label);
      }
    }
  }
});

test("column layout: a saved width is clamped to the current window and never rewritten", () => {
  const saved = 600;
  const wide = columnLayout({
    ...base,
    width: 1440,
    rightOpen: true,
    rightWidth: saved,
  });
  assert.equal(wide.right, 600);
  const narrower = columnLayout({
    ...base,
    width: 1180,
    rightOpen: true,
    rightWidth: saved,
  });
  assert.equal(narrower.right, 1180 - 784);
  const tiny = columnLayout({
    ...base,
    width: 1440,
    rightOpen: true,
    rightWidth: 100,
  });
  assert.equal(tiny.right, 320);
});

test("column layout: taking over the centre keeps the rail and the sidebar and hides the centre", () => {
  const layout = columnLayout({
    ...base,
    width: 1440,
    rightOpen: true,
    takeover: true,
  });
  assert.deepEqual(
    [layout.rail, layout.sidebarWidth, layout.center, layout.right],
    [56, 248, 0, 1440 - 56 - 248],
  );
  const closed = columnLayout({ ...base, width: 1440, takeover: true });
  assert.equal(
    closed.takeover,
    false,
    "no takeover without an open right column",
  );
});

test("column layout: expanding a folded sidebar overlays it only when the columns cannot sit side by side", () => {
  assert.equal(expandsAsOverlay({ width: 900, rightOpen: true }), true);
  assert.equal(expandsAsOverlay({ width: 1103, rightOpen: true }), true);
  assert.equal(expandsAsOverlay({ width: 1104, rightOpen: true }), false);
  assert.equal(expandsAsOverlay({ width: 900, rightOpen: false }), false);
});
