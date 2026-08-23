#!/usr/bin/env node

/**
 * Verifies that package-lock.json actually reflects what the package.json
 * files declare. `npm ci` catches a lockfile whose dependency list drifted,
 * but it does NOT catch a lockfile that ignores the root `overrides` block:
 * a plain `npm install` preserves resolutions that already satisfy their
 * parent's range, so an override added later never takes effect and the
 * tree silently keeps the version the override exists to replace.
 *
 * That is not hypothetical — this repo shipped a lockfile pinning
 * `diff@7.0.0` and `serialize-javascript@6.0.2` while the root overrides
 * named 8.0.3 and 7.0.6 to clear advisories. Every CI job was green.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

const lock = readJson('package-lock.json');
const rootPkg = readJson('package.json');
const WORKSPACES = ['packages/dilithium5', 'packages/mldsa87'];

const overrides = rootPkg.overrides ?? {};
const errors = [];

// A lock key is a filesystem path; the resolved package is whatever follows
// the last `node_modules/` segment (scoped names keep their `@scope/` half).
const packageNameOf = (lockKey) => lockKey.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];

// 1. Every root override is applied everywhere it resolves. Bundled entries
//    ship inside their parent's tarball (npm's own dependencies), so npm
//    cannot rewrite them and neither can an override.
let applied = 0;
let bundled = 0;
for (const [lockKey, entry] of Object.entries(lock.packages)) {
  const name = packageNameOf(lockKey);
  if (name === undefined || !(name in overrides)) continue;
  if (entry.inBundle) {
    bundled += 1;
    continue;
  }
  if (entry.version !== overrides[name]) {
    errors.push(`${lockKey} resolves ${name}@${entry.version}, but the root overrides pin ${overrides[name]}`);
  } else {
    applied += 1;
  }
}

// 2. npm honours `overrides` only from the root of a workspace install, so a
//    workspace-level block is inert: at best it duplicates the root, at worst
//    it names a version nothing enforces. Overrides live in one place.
for (const workspace of WORKSPACES) {
  const workspaceOverrides = readJson(`${workspace}/package.json`).overrides ?? {};
  for (const [name, version] of Object.entries(workspaceOverrides)) {
    errors.push(
      `${workspace}/package.json overrides ${name}@${version} — npm ignores workspace overrides in a workspace install; declare it in the root package.json instead`
    );
  }
}

// 3. The lockfile mirrors each manifest's declared dependencies. This is the
//    drift `npm ci` also rejects; checking it here names the offending entry
//    instead of failing mid-install.
for (const [lockKey, manifestPath] of [
  ['', 'package.json'],
  ...WORKSPACES.map((workspace) => [workspace, `${workspace}/package.json`]),
]) {
  const mirrored = lock.packages[lockKey];
  if (mirrored === undefined) {
    errors.push(`package-lock.json has no entry for ${manifestPath}`);
    continue;
  }
  const manifest = readJson(manifestPath);
  for (const field of ['dependencies', 'devDependencies']) {
    const inLock = mirrored[field] ?? {};
    const declared = manifest[field] ?? {};
    for (const name of new Set([...Object.keys(inLock), ...Object.keys(declared)])) {
      if (inLock[name] !== declared[name]) {
        errors.push(
          `${manifestPath} declares ${field}.${name}=${declared[name] ?? '(absent)'} but the lockfile records ${inLock[name] ?? '(absent)'}`
        );
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`MISMATCH: ${error}`);
  console.error(
    '\npackage-lock.json is out of sync with the package.json files.' +
      '\nA plain `npm install` will not fix a stale override — it keeps resolutions that' +
      '\nalready satisfy their parent range. Force a clean resolve instead:' +
      '\n\n  rm package-lock.json && npm install\n'
  );
  process.exit(1);
}

console.log(
  `Lockfile in sync: ${applied} override resolution(s) applied ` +
    `(${bundled} bundled entr(ies) skipped), manifests mirrored.`
);
