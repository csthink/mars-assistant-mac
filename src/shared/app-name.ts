/**
 * The product's display name. The packaged bundle localizes its name for exactly two
 * languages (`zh_CN.lproj` and `en.lproj`, see scripts/package-macos.mjs); every other
 * language falls back to the base Info.plist value, which is the English name. Window
 * titles, the menu bar icon and the application menu follow the same rule, so the name
 * inside the app matches the one macOS shows in the Dock, the Finder and the menu bar.
 *
 * The internal application name (`app.setName("csthink-assistant")`), the bundle
 * identifier, the data directories and the keychain item are not display names and do
 * not change with it.
 */
export const displayNames = { chinese: "青鸾", english: "Qingluan" } as const;
export type DisplayName = (typeof displayNames)[keyof typeof displayNames];

/** Simplified Chinese locales (as reported by Chromium or as BCP 47 tags) get the Chinese name. */
export function displayNameFor(locale: string): DisplayName {
  const tag = locale.trim().toLowerCase().replace(/_/g, "-");
  const simplified =
    tag === "zh" ||
    tag.startsWith("zh-cn") ||
    tag.startsWith("zh-sg") ||
    tag.startsWith("zh-hans");
  return simplified ? displayNames.chinese : displayNames.english;
}

/** The value the main process hands to each window's preload; anything else falls back to the English name. */
export function validDisplayName(value: unknown): DisplayName {
  return value === displayNames.chinese ? value : displayNames.english;
}
