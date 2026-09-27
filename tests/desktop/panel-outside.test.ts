import { test } from "node:test";
import assert from "node:assert/strict";
import { PanelOutsideClicks, type Point } from "../../src/main/panel-outside";

test("outside clicks respect panel and Tray bounds across displays and ignore stale subscriptions", () => {
  const callbacks: ((point: Point) => void)[] = [];
  let active = false;
  let dismissed = 0;
  const controller = new PanelOutsideClicks({
    start(callback) {
      active = true;
      callbacks.push(callback);
    },
    stop() {
      active = false;
    },
  });
  let panel = { x: -800, y: -500, width: 420, height: 600 };
  const tray = { x: -700, y: -524, width: 24, height: 24 };
  const watch = () =>
    controller.watch(
      () => panel,
      () => tray,
      () => {
        assert.equal(active, false);
        dismissed++;
      },
    );
  watch();
  for (const point of [
    { x: -800, y: -500 },
    { x: -381, y: 99 },
    { x: -690, y: -515 },
    { x: NaN, y: 0 },
  ])
    callbacks[0](point);
  assert.equal(dismissed, 0);
  panel = { ...panel, x: 100 };
  callbacks[0]({ x: 101, y: 0 });
  assert.equal(dismissed, 0);
  callbacks[0]({ x: 520, y: 0 });
  assert.equal(dismissed, 1);
  watch();
  callbacks[0]({ x: 0, y: 0 });
  assert.equal(dismissed, 1);
  callbacks[1]({ x: 0, y: 0 });
  callbacks[1]({ x: 0, y: 0 });
  assert.equal(dismissed, 2);
  watch();
  controller.stop();
  callbacks[2]({ x: 0, y: 0 });
  assert.equal(dismissed, 2);
});
