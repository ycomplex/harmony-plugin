#!/usr/bin/env node
// scripts/build-release.mjs — B-1475: build the released download for one plugin commit.
//
// Usage:
//   node scripts/build-release.mjs --commit <sha-or-ref> --channel prod|staging --base-url <https url> --out <dir> [--repo <path>]
//
// Writes into <out>:
//   harmony-plugin-<version>.zip  `git archive --format=zip <commit>` (plugin root at the top level, no prefix)
//   marketplace.json              the Claude Code marketplace file pointing at the zip (url + sha256)
//   release.json                  the release record (schema 1)
//   manifest.txt                  one line per object: `immutable|pointer <local file> <object path>`
//   manifest.json                 the same, as JSON
// The publish step (scripts/publish-release.sh) reads manifest.txt and knows nothing about naming.
//
// Pure and deterministic: everything is read from the commit itself (version from its plugin.json, built_at from its
// committer date), so two builds of the same commit are byte-identical. Contract: docs/plugin-release-artefact.md.
// No dependencies beyond Node and git.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CHANNELS = ['prod', 'staging'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

class ReleaseError extends Error {}

function fail(message) {
  throw new ReleaseError(message);
}

function parseArgs(argv) {
  const opts = {};
  const known = new Set(['--commit', '--channel', '--base-url', '--out', '--repo']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!known.has(flag)) fail(`unknown argument '${flag}'`);
    const value = argv[i + 1];
    if (value === undefined || known.has(value)) fail(`${flag} needs a value`);
    opts[flag.slice(2)] = value;
    i++;
  }
  return opts;
}

/** https only, no trailing slash (one is stripped). Throws before any work otherwise. */
export function normalizeBaseUrl(raw) {
  if (!raw) fail('--base-url is required (the public https base the channels are served under)');
  let url = String(raw).trim();
  if (url.endsWith('/')) url = url.slice(0, -1);
  let parsed;
  try { parsed = new URL(url); } catch { fail(`--base-url is not a URL: '${raw}'`); }
  if (parsed.protocol !== 'https:') fail(`--base-url must be https://, got '${raw}'`);
  if (parsed.search || parsed.hash || parsed.username || parsed.password) fail(`--base-url must carry no query, fragment or credentials: '${raw}'`);
  if (url.endsWith('/')) fail(`--base-url must not end with a slash: '${raw}'`);
  return url;
}

export function buildRelease(argv) {
  const opts = parseArgs(argv);
  // Validate every input before anything is built.
  if (!opts.channel || !CHANNELS.includes(opts.channel)) fail(`--channel must be prod or staging, got '${opts.channel ?? ''}'`);
  const baseUrl = normalizeBaseUrl(opts['base-url']);
  if (!opts.commit) fail('--commit is required');
  if (!opts.out) fail('--out is required');
  const repo = resolve(opts.repo ?? process.cwd());
  const channel = opts.channel;

  const git = (args, encoding = 'utf8') => execFileSync('git', ['-C', repo, ...args], { encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
  let commit;
  try { commit = git(['rev-parse', '--verify', `${opts.commit}^{commit}`]).trim(); } catch { fail(`commit '${opts.commit}' is not in the repository at ${repo}`); }

  let manifest;
  try { manifest = JSON.parse(git(['show', `${commit}:.claude-plugin/plugin.json`])); } catch { fail(`.claude-plugin/plugin.json is missing or not JSON at ${commit}`); }
  const version = manifest?.version;
  if (version === '0.0.0-dev') fail(`plugin.json at ${commit} carries the inert version 0.0.0-dev: build from the staging or prod branch, not main`);
  if (typeof version !== 'string' || !SEMVER.test(version)) fail(`plugin.json at ${commit} has no semver version (got '${version}')`);
  try { git(['cat-file', '-e', `${commit}:dist/index.js`]); } catch { fail(`dist/index.js is not in the tree of ${commit}: build from the staging or prod branch (main carries no dist/)`); }

  const builtAt = new Date(git(['show', '-s', '--format=%cI', commit]).trim()).toISOString().replace(/\.000Z$/, 'Z');
  const zipBytes = git(['archive', '--format=zip', commit], 'buffer');
  const sha256 = createHash('sha256').update(zipBytes).digest('hex');

  const zipName = `harmony-plugin-${version}.zip`;
  const releaseDir = `channels/${channel}/releases/${version}`;
  const objects = {
    zip: `${releaseDir}/${zipName}`,
    marketplace: `${releaseDir}/marketplace.json`,
    release: `${releaseDir}/release.json`,
    marketplacePointer: `channels/${channel}/marketplace.json`,
    releasePointer: `channels/${channel}/release.json`,
  };

  const marketplace = {
    name: channel === 'prod' ? 'harmony' : 'harmony-staging',
    owner: { name: 'ycomplex' },
    description: `Harmony project management for Claude Code (${channel} channel)`,
    metadata: { version },
    plugins: [
      {
        name: 'harmony-plugin',
        description: 'Harmony project management integration for Claude Code — MCP tools and workflow skills',
        version,
        source: { source: 'archive', url: `${baseUrl}/${channel}/releases/${version}/${zipName}`, sha256 },
      },
    ],
  };
  const release = {
    schema: 1,
    channel,
    version,
    commit,
    built_at: builtAt,
    zip: { object: objects.zip, sha256, bytes: zipBytes.length },
    marketplace_object: objects.marketplace,
  };

  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, zipName), zipBytes);
  writeFileSync(join(out, 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  // Order is the publish order: the three immutable objects first, the two pointers last.
  const entries = [
    { kind: 'immutable', file: zipName, object: objects.zip },
    { kind: 'immutable', file: 'marketplace.json', object: objects.marketplace },
    { kind: 'immutable', file: 'release.json', object: objects.release },
    { kind: 'pointer', file: 'marketplace.json', object: objects.marketplacePointer },
    { kind: 'pointer', file: 'release.json', object: objects.releasePointer },
  ];
  writeFileSync(join(out, 'manifest.txt'), entries.map((e) => `${e.kind} ${e.file} ${e.object}\n`).join(''));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ channel, version, objects: entries }, null, 2)}\n`);
  return { channel, version, commit, sha256, bytes: zipBytes.length, out, objects };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    const r = buildRelease(process.argv.slice(2));
    console.log(`built harmony-plugin ${r.version} (${r.channel}) from ${r.commit}: ${r.bytes} bytes, sha256 ${r.sha256} -> ${r.out}`);
  } catch (err) {
    if (err instanceof ReleaseError) {
      console.error(`build-release: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

