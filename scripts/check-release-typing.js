#!/usr/bin/env node
// Asserts that a change to what a package actually ships is carried by a
// commit type semantic-release publishes on.
//
// The CJS builds embed @noble/hashes (it is ESM-only), so CJS consumers get
// dependency updates only through a release of these packages — SECURITY.md
// "Bundled Dependencies in the CJS Artifact". A runtime dependency bumped
// under a `deps:` or `build:` commit therefore rebuilds the bundle, passes
// dist-check, merges clean, and never reaches anyone: releaseRules publish
// on feat/fix/perf/breaking only. That happened with @noble/hashes 2.3.0.
//
// Usage: check-release-typing.js [baseRef] [headRef]   (default: origin/main HEAD)
// Env:   BASE_SHA / HEAD_SHA override the positional arguments (CI passes these).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publishablePackages } from './release/packages.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const base = process.env.BASE_SHA || process.argv[2] || 'origin/main';
const head = process.env.HEAD_SHA || process.argv[3] || 'HEAD';

// GitHub reports the base branch's tip, which may have advanced past the point
// this branch left it. `base..head` already counts commits from the merge base,
// so the artifact snapshot has to come from there too — measured against a moved
// tip, a change main made after the branch point reads as this PR reverting it.
const mergeBase = git('merge-base', base, head);

// Types that produce a release, per .releaserc.json releaseRules. A `!` marker
// or a BREAKING CHANGE footer releases whatever the type is.
const RELEASING_TYPES = new Set(['feat', 'fix', 'perf']);

// A trailer, not a loose token: a bare marker matches any commit that merely
// mentions it — a revert, a doc change, or the commit that introduced this
// check — silently disabling the gate for the whole PR. Requiring a line-start
// trailer with a reason means opting out has to be deliberate and explained.
const SKIP_TRAILER = /^Skip-Release-Check:[ \t]*(?<reason>\S.*)$/m;

const releases = (message) => {
  const header = message.split('\n', 1)[0];
  const match = header.match(/^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?:/i);
  if (!match) return false;
  if (match.groups.breaking) return true;
  if (/^BREAKING[ -]CHANGE:/m.test(message)) return true;
  return RELEASING_TYPES.has(match.groups.type.toLowerCase());
};

const commits = git('log', '--no-merges', '--format=%H', `${base}..${head}`)
  .split('\n')
  .filter(Boolean)
  .map((sha) => ({
    sha,
    message: git('show', '-s', '--format=%B', sha),
    files: git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean),
  }));

if (commits.length === 0) {
  console.log(`No commits in ${base}..${head}; nothing to check.`);
  process.exit(0);
}

const skipped = commits.find((commit) => SKIP_TRAILER.test(commit.message));
if (skipped) {
  const { reason } = skipped.message.match(SKIP_TRAILER).groups;
  console.log(`Skip-Release-Check on ${skipped.sha.slice(0, 7)}: ${reason.trim()}`);
  process.exit(0);
}

// Runtime `dependencies` are compared manifest-to-manifest rather than by
// reading diffs: the question is whether what ships changed between the two
// commits, not how many times it was edited along the way.
const runtimeDependencies = (ref, packagePath) => {
  try {
    return JSON.parse(git('show', `${ref}:${packagePath}/package.json`)).dependencies ?? {};
  } catch {
    return {};
  }
};

const errors = [];
const checked = [];

for (const pkg of publishablePackages()) {
  const reasons = [];

  const before = runtimeDependencies(mergeBase, pkg.path);
  const after = runtimeDependencies(head, pkg.path);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[name] !== after[name]) {
      reasons.push(`runtime dependency ${name} ${before[name] ?? '(absent)'} -> ${after[name] ?? '(absent)'}`);
    }
  }

  const bundleChanged = git('diff', '--name-only', `${mergeBase}..${head}`, '--', `${pkg.path}/dist/cjs`);
  if (bundleChanged) reasons.push('the published CJS bundle changed');

  if (reasons.length === 0) continue;

  // semantic-release attributes a commit to a package by the files it touches,
  // so the releasing commit has to be one that touches THIS package.
  const releasing = commits.find(
    (commit) => releases(commit.message) && commit.files.some((file) => file.startsWith(`${pkg.path}/`))
  );

  if (releasing) {
    checked.push(`${pkg.name}: ${reasons.join('; ')} — released by ${releasing.sha.slice(0, 7)}`);
  } else {
    errors.push(
      `${pkg.name} changes what it ships (${reasons.join('; ')}) but no commit touching ${pkg.path}/ has a releasing type`
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`UNRELEASED: ${error}`);
  console.error(
    '\nsemantic-release publishes on feat/fix/perf/breaking only, so this change would' +
      '\nmerge without ever reaching npm — and for a bundled dependency that means CJS' +
      '\nconsumers keep the old copy indefinitely (SECURITY.md "Bundled Dependencies in' +
      '\nthe CJS Artifact").' +
      '\n\nEither type the change `fix:` (the dependency-patch playbook), or, when the' +
      '\nchange is already committed, add a releasing commit that touches each package:' +
      '\n\n  npm run release:touch-packages' +
      `\n  git commit -m "fix: <what now ships>"` +
      '\n\nIf the change genuinely should not publish, add a commit trailer:' +
      '\n\n  Skip-Release-Check: <why this must not publish>\n'
  );
  process.exit(1);
}

if (checked.length > 0) {
  for (const line of checked) console.log(`Release-typed: ${line}`);
} else {
  console.log(`No shipped-artifact changes in ${base}..${head}.`);
}
