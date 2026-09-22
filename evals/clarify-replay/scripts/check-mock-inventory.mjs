#!/usr/bin/env node
// B-1037 -- clarify-replay eval CI wiring: the derived-inventory diff.
//
// WHY THIS EXISTS. Full eval traces are gitignored (evals/clarify-replay/results/) and never
// committed, so "the mock inventory is derived from a trace" can't mean "read a committed trace
// file" -- it means a ONE-TIME extraction (done at B-1037 build time, from the 15 real tool names
// already named in the ratified plan) into the small COMMITTED manifest this script reads:
// evals/clarify-replay/reference-tool-calls.json. This script is the ongoing check that keeps the
// mock directory honest against that manifest, run as its own fast CI step BEFORE the mocked eval
// run (a static check, no sandbox, no cost).
//
// WHAT IT CHECKS. Every tool name listed in the manifest (reads + writes) must have a
// corresponding <tool>.md file directly under evals/clarify-replay/mocks/plugin_harmony-plugin_harmony/
// (excluding _server.md, _tools.json, fixtures/, .replay/ -- none of those are per-tool mock files).
// A manifest tool with no mock file is a LOUD, named, non-zero-exit failure: the mocked eval run
// would otherwise silently fall through to whatever `claude plugin eval`'s default handling of an
// unmocked tool call is, which is exactly the kind of "green without genuinely evaluating" failure
// mode AC6 forbids.
//
// It deliberately does NOT fail on an EXTRA mock file with no manifest entry -- a suite author
// adding a mock ahead of a manifest update is not a regression; a manifest entry with a MISSING
// mock is.
//
// Usage:
//   node evals/clarify-replay/scripts/check-mock-inventory.mjs
//   node evals/clarify-replay/scripts/check-mock-inventory.mjs --manifest <path> --mocks-dir <path>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(HERE, '..', 'reference-tool-calls.json');
const DEFAULT_MOCKS_DIR = join(HERE, '..', 'mocks', 'plugin_harmony-plugin_harmony');

// Non-per-tool entries that legitimately live in the mock directory alongside the per-tool .md
// files -- see the "Mock file format" section of RUNBOOK.md / the B-1037 ticket.
const EXCLUDED_ENTRIES = new Set(['_server.md', '_tools.json', 'fixtures', '.replay']);

/** Read the manifest and return the flat array of every tool name it declares (reads ++ writes).
 *  Pure, no I/O beyond the one read -- exported so tests can also exercise readManifest against a
 *  temp-file fixture without touching the real committed manifest. */
export function manifestTools(manifestJson) {
  const reads = Array.isArray(manifestJson?.reads) ? manifestJson.reads : [];
  const writes = Array.isArray(manifestJson?.writes) ? manifestJson.writes : [];
  return [...reads, ...writes];
}

/** List the per-tool mock file basenames (without .md) present in a mocks directory, skipping the
 *  excluded non-per-tool entries. Pure given a directory listing -- exported separately from the
 *  fs walk (mockToolNamesFromDir) so the diff logic itself needs no filesystem at all. */
export function mockToolNamesFromEntries(entries) {
  return entries
    .filter((e) => !EXCLUDED_ENTRIES.has(e))
    .filter((e) => e.endsWith('.md'))
    .map((e) => e.slice(0, -'.md'.length));
}

/** The diff itself: which manifest tools have no matching mock file. Pure function -- this is what
 *  the vitest tests import directly, per the B-1037 ticket's "extract the check into a small pure
 *  function the test imports directly" instruction. Returns { missing, ok }. */
export function diffMockInventory(manifestToolNames, presentMockToolNames) {
  const present = new Set(presentMockToolNames);
  const missing = manifestToolNames.filter((t) => !present.has(t));
  return { missing, ok: missing.length === 0 };
}

function mockToolNamesFromDir(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((e) => {
    // Only real files count as a per-tool mock; a directory entry (fixtures/, .replay/) is excluded
    // by name above but this guards any OTHER stray directory too.
    try {
      return statSync(join(dir, e)).isFile();
    } catch {
      return false;
    }
  });
  return mockToolNamesFromEntries(entries);
}

function main() {
  const argv = process.argv.slice(2);
  const flagValue = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const manifestPath = flagValue('--manifest', DEFAULT_MANIFEST);
  const mocksDir = flagValue('--mocks-dir', DEFAULT_MOCKS_DIR);

  let manifestJson;
  try {
    manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`check-mock-inventory: cannot read/parse manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const tools = manifestTools(manifestJson);
  const present = mockToolNamesFromDir(mocksDir);
  const { missing, ok } = diffMockInventory(tools, present);

  if (!ok) {
    console.error(
      `check-mock-inventory: ${missing.length} tool(s) in ${manifestPath} have NO mock file under ${mocksDir}:\n` +
        missing.map((t) => `  - ${t} (expected ${join(mocksDir, `${t}.md`)})`).join('\n') +
        '\n\nEither the skill stopped calling a tool the manifest still lists (update reference-tool-calls.json), ' +
        'or a mock file was never authored for a tool the manifest already declares (author it) -- see RUNBOOK.md.',
    );
    process.exit(1);
  }

  console.log(`check-mock-inventory: OK -- all ${tools.length} manifest tool(s) have a mock file under ${mocksDir}.`);
}

// Only run as a CLI when invoked directly (not when imported by the vitest tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
