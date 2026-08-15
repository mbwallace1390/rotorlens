/**
 * Audits the manifest that Gradle actually merged into an Android variant.
 *
 * Reading only src/main/AndroidManifest.xml misses permissions contributed by a
 * dependency. AndroidX currently contributes one app-local signature permission
 * for its non-exported dynamic receiver; that permission is inert outside this
 * package and is the sole allowlisted request. Any other request is a release
 * failure, especially android.permission.INTERNET.
 */

import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const APP_PACKAGE = 'app.rotorlens';
const ALLOWED = new Set([
  `${APP_PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
]);

/** Returns every permission requested by a merged manifest. */
export function requestedPermissions(xml) {
  const permissions = [];
  const elements = xml.matchAll(/<uses-permission(?:-sdk-\d+)?\b[^>]*>/g);

  for (const element of elements) {
    const name = element[0].match(/\bandroid:name\s*=\s*["']([^"']+)["']/);
    if (name) {
      permissions.push(name[1]);
    }
  }

  return Object.freeze([...new Set(permissions)].sort());
}

/** Returns app-defined permission declarations and their protection levels. */
export function declaredPermissions(xml) {
  const declarations = [];
  const elements = xml.matchAll(/<permission\b[^>]*>/g);

  for (const element of elements) {
    const name = element[0].match(/\bandroid:name\s*=\s*["']([^"']+)["']/)?.[1];
    if (!name) {
      continue;
    }
    const protectionLevel = element[0].match(
      /\bandroid:protectionLevel\s*=\s*["']([^"']+)["']/
    )?.[1] ?? null;
    declarations.push(Object.freeze({name, protectionLevel}));
  }

  return Object.freeze(declarations);
}

/** Throws when the shipped manifest requests anything outside the exact allowlist. */
export function assertSafeMergedManifest(xml, label = 'merged Android manifest') {
  const permissions = requestedPermissions(xml);
  const unexpected = permissions.filter(permission => !ALLOWED.has(permission));

  if (unexpected.length > 0) {
    throw new Error(
      `${label} requests forbidden permission(s): ${unexpected.join(', ')}. `
      + 'Update the privacy and release review before allowing any new permission.'
    );
  }

  const declarations = declaredPermissions(xml);
  const unexpectedDeclarations = declarations.filter(({name}) => !ALLOWED.has(name));
  if (unexpectedDeclarations.length > 0) {
    throw new Error(
      `${label} declares unexpected permission(s): `
      + `${unexpectedDeclarations.map(({name}) => name).join(', ')}`
    );
  }

  for (const permission of permissions) {
    const matching = declarations.filter(({name}) => name === permission);
    if (matching.length !== 1 || matching[0].protectionLevel !== 'signature') {
      throw new Error(
        `${label} must declare ${permission} exactly once with `
        + 'android:protectionLevel="signature"'
      );
    }
  }

  return permissions;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error('usage: node tools/check-android-manifest.mjs <merged-manifest> [...]');
  }

  for (const file of files) {
    const xml = await readFile(path.resolve(file), 'utf8');
    const permissions = assertSafeMergedManifest(xml, file);
    process.stdout.write(
      `${file}: ${permissions.length} requested permission(s), release gate passed\n`
    );
  }
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
