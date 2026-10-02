import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayNameFor,
  displayNames,
  validDisplayName,
} from "../../src/shared/app-name";

test("app name: Simplified Chinese locales get 青鸾, every other locale gets Qingluan", () => {
  for (const locale of [
    "zh-CN",
    "zh_CN",
    "zh",
    "zh-Hans",
    "zh-Hans-CN",
    "zh-SG",
    " ZH-cn ",
  ])
    assert.equal(displayNameFor(locale), displayNames.chinese, locale);
  for (const locale of [
    "en-US",
    "en",
    "en-GB",
    "ja",
    "zh-TW",
    "zh-HK",
    "zh-Hant-TW",
    "fr-FR",
    "",
  ])
    assert.equal(displayNameFor(locale), displayNames.english, locale);
});

test("app name: the preload accepts only the two known names and falls back to Qingluan", () => {
  assert.equal(validDisplayName("青鸾"), "青鸾");
  assert.equal(validDisplayName("Qingluan"), "Qingluan");
  for (const value of [undefined, "", "csthink-assistant", "青鸞", 1, null])
    assert.equal(validDisplayName(value), "Qingluan");
});
