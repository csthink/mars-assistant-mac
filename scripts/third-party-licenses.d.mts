/** Types of scripts/third-party-licenses.mjs for the service tests; the module itself is plain JavaScript. */
export const noticesFile: string;
export const acceptedLicenses: string[];
export const copiedPackageFiles: Record<string, string>;

export interface EmbeddedComponent {
  host: string;
  hostVersion: string;
  name: string;
  version: string | null;
  license: string;
  use: string;
  markerFile: string;
  marker: string;
  text: string;
}
export const embeddedComponents: EmbeddedComponent[];

export interface ElectronFramework {
  electronVersion: string;
  name: string;
  framework: string;
  license: string;
  use: string;
  text: string;
}
export const electronFrameworks: ElectronFramework[];
export const electronCoveredFrameworks: string[];
export function installedElectronVersion(root: string): Promise<string>;
export function electronFrameworkProblems(options: {
  bundled: string[];
  electronVersion: string;
  frameworks?: ElectronFramework[];
  covered?: string[];
}): string[];

export function packageDirOf(path: string): string | null;
export function packagesFromMetafiles(
  metafiles: { inputs: Record<string, unknown> }[],
): string[];
export function embeddedInSourceMap(mapPath: string): Promise<string[]>;
export function packagesFromSourceMaps(
  mapDir: string,
  sourceBase: string,
): Promise<{ packages: string[]; embedded: string[] }>;
export function thirdPartyNotices(options: {
  root: string;
  packageDirs: string[];
  electronVersion: string;
  embedded?: EmbeddedComponent[];
  frameworks?: ElectronFramework[];
  product?: string;
}): Promise<{
  text: string;
  packages: { name: string; version: string; license: string }[];
  components: {
    name: string;
    version: string | null;
    license: string;
    host: string;
    hostVersion: string;
  }[];
  frameworks: {
    name: string;
    framework: string;
    license: string;
    electronVersion: string;
  }[];
}>;
