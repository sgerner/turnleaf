export const ALLOWED_ANDROID_PERMISSIONS: readonly string[];
export function extractManifestPackage(manifestXml: string): string | null;
export function extractManifestPermissions(manifestXml: string): string[];
export function assertMergedManifestPermissions(manifestXml: string, label?: string): string[];
export function verifyMergedManifestFile(manifestPath: string, label?: string): string[];
export function mergedManifestPath(variant: 'debug' | 'release', root?: string): string;
export function main(variants?: string[]): void;
