/**
 * Files macOS writes into a folder on its own, which therefore say nothing about who else
 * uses the folder. Directory checks that accept only this application's own entries skip them,
 * and never delete them.
 *
 * - `.DS_Store`: the Finder writes it into any folder a person opens in a Finder window.
 * - `._<name>`: an AppleDouble file that carries the extended attributes of `<name>` on volumes
 *   without native support for them (network shares, exFAT and FAT disks, some copy and archive
 *   tools). It is skipped only when `<name>` is itself accepted (or is `.DS_Store`), so an
 *   AppleDouble file never vouches for a foreign entry.
 *
 * `.localized` is not skipped: macOS puts it only into its own standard folders (Documents,
 * Downloads and the like) to show their localized names, not into folders an application creates,
 * so in a data folder it is someone else's file.
 */
export function isMacMetadata(
  name: string,
  accepted: (name: string) => boolean = () => false,
): boolean {
  if (name === ".DS_Store") return true;
  if (!name.startsWith("._") || name.length === 2) return false;
  const base = name.slice(2);
  return base === ".DS_Store" || accepted(base);
}
