/**
 * The product's display name: the single source for every name the app shows itself (window
 * and page titles, the sidebar heading, the menu bar icon tooltip, the application menu and the
 * About panel). The packaged bundle carries the same name in every localization of its
 * InfoPlist.strings (scripts/package-macos.mjs), so the Finder, the Dock and the menu bar agree.
 *
 * The interface is in Chinese only, so the name is 青鸾 whatever the system language. The
 * English name Qingluan is used only for the app bundle and disk image file names and the
 * Release and Homebrew names. When an English interface is added, this becomes a choice per
 * locale again, here and in the packaging script together.
 *
 * The internal application name (`app.setName("csthink-assistant")`), the bundle identifier, the
 * data directories and the keychain item are not display names and do not change with it.
 */
export const displayName = "青鸾";
