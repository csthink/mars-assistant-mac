import type { Locator } from "@playwright/test";

/**
 * Scrolls an element to the vertical center of its scroll container before a test reads its box
 * for a layout bound. scrollIntoViewIfNeeded brings a partly visible element in by aligning its
 * nearest edge, and at devicePixelRatio 1 the resulting scroll position is rounded to a whole
 * device pixel, which can leave the element's bottom edge less than a pixel past the viewport.
 * Centered, the element sits clear of the viewport edges, so the bound assertions no longer
 * depend on that rounding.
 */
export async function scrollIntoCenter(locator: Locator) {
  await locator.evaluate((el) =>
    el.scrollIntoView({ block: "center", inline: "nearest" }),
  );
}
