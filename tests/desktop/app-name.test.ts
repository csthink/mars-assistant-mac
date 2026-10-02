import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displayName } from "../../src/shared/app-name";

test("app name: the single display name is 青鸾, the Chinese name of the Chinese-only interface", () => {
  assert.equal(displayName, "青鸾");
});

test("app name: the packaging script writes the same display name into the bundle", () => {
  const script = readFileSync("scripts/package-macos.mjs", "utf8");
  assert.match(
    script,
    new RegExp(`^const displayName = "${displayName}";$`, "m"),
  );
  assert.match(script, /CFBundleDevelopmentRegion: "zh_CN"/);
});
