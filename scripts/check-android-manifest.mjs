import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_ANDROID_PERMISSIONS = [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.INTERNET',
];

const FORBIDDEN_STORAGE_PERMISSIONS = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
]);

const SELF_DYNAMIC_RECEIVER_SUFFIX = '.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION';

export function extractManifestPackage(manifestXml) {
  const rootMatch = /<manifest\b([^>]*)>/s.exec(manifestXml);
  if (!rootMatch?.[1]) return null;
  return /\bpackage\s*=\s*"([^"]+)"/.exec(rootMatch[1])?.[1] ?? null;
}

export function extractManifestPermissions(manifestXml) {
  const permissions = [];
  const tagPattern = /<uses-permission(?:-sdk-23)?\b([^>]*?)\/?>/gs;
  for (const match of manifestXml.matchAll(tagPattern)) {
    const attributes = match[1] ?? '';
    const nodeAction = /\btools:node\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
    if (nodeAction === 'remove') continue;
    const name = /\bandroid:name\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
    if (name) permissions.push(name);
  }
  return [...new Set(permissions)].sort();
}

export function assertMergedManifestPermissions(manifestXml, label = 'AndroidManifest.xml') {
  const packageName = extractManifestPackage(manifestXml);
  const selfReceiverPermission = packageName
    ? `${packageName}${SELF_DYNAMIC_RECEIVER_SUFFIX}`
    : null;

  const declared = extractManifestPermissions(manifestXml);
  const externalPermissions = declared.filter((name) =>
    selfReceiverPermission
      ? name !== selfReceiverPermission
      : !name.endsWith(SELF_DYNAMIC_RECEIVER_SUFFIX),
  );

  for (const forbidden of FORBIDDEN_STORAGE_PERMISSIONS) {
    if (declared.includes(forbidden)) {
      throw new Error(
        `${label} must not declare legacy or external storage permission ${forbidden}.`,
      );
    }
  }

  const expected = [...ALLOWED_ANDROID_PERMISSIONS].sort();
  if (
    externalPermissions.length !== expected.length ||
    externalPermissions.some((permission, index) => permission !== expected[index])
  ) {
    throw new Error(
      `${label} declared unexpected permissions: [${externalPermissions.join(', ')}]; ` +
        `expected only [${expected.join(', ')}].`,
    );
  }

  return externalPermissions;
}

export function verifyMergedManifestFile(manifestPath, label = manifestPath) {
  const xml = readFileSync(manifestPath, 'utf8');
  return assertMergedManifestPermissions(xml, label);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);

export function mergedManifestPath(variant, root = projectRoot) {
  const capitalized = variant[0].toUpperCase() + variant.slice(1);
  return join(
    root,
    'android',
    'app',
    'build',
    'intermediates',
    'merged_manifest',
    variant,
    `process${capitalized}MainManifest`,
    'AndroidManifest.xml',
  );
}

export function main(variants = process.argv.slice(2)) {
  const targets = variants.length > 0 ? variants : ['debug', 'release'];
  for (const variant of targets) {
    if (variant !== 'debug' && variant !== 'release') {
      throw new Error(`Unsupported Android manifest variant: ${variant}`);
    }
    const path = mergedManifestPath(variant);
    const verified = verifyMergedManifestFile(path, `${variant} merged AndroidManifest.xml`);
    console.log(
      `Verified ${variant} merged AndroidManifest.xml permissions: ${verified.join(', ')}.`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
