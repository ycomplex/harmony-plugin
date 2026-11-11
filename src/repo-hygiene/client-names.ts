// B-1459: no client or adopter name in this public repository.
//
// What it guards: every tracked file (code, docs, tests, fixtures, skill prose, container files).
// `client-names.test.ts` scans the repository and fails the suite when a listed name reappears,
// reporting only file:line, never the matched text.
//
// Only salted SHA-256 hashes of the normalized names are stored here, never a name in clear.
// Hashing keeps the names out of plain text and out of code search; it does NOT hide them from
// someone who guesses a candidate and hashes it. It is a tripwire against accidental reuse, not
// a secret.
//
// To add a name: run `node scripts/hash-client-name.mjs "<name>"` locally and append the printed
// hash to LISTED_HASHES. Never paste the name itself into a commit, a PR or a comment.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SALT = 'harmony-no-client-names:';

export const LISTED_HASHES: readonly string[] = [
  'b0427a6008a4499ef4c057ed27bf91873e6f50cce45ada0be9d36f1a37803c39',
  '3254c9053a2436072bf6bad8da6665398db47c92e8fde550e58ef39a08ce3098',
];

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Lowercase, strip every character outside [a-z0-9], then hex SHA-256 of SALT + the result. */
export function hashName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return createHash('sha256').update(SALT + normalized).digest('hex');
}

export interface NameHit { line: number }
export interface FileHit { file: string; line: number }

/**
 * Flags each line (1-based) on which a single lowercase [a-z0-9]+ token, or two adjacent tokens
 * concatenated, hashes into `hashes`. Only line numbers are returned, never the matched text.
 */
export function findListedNames(text: string, hashes: readonly string[] = LISTED_HASHES,
  cache: Map<string, string> = new Map()): NameHit[] {
  const set = new Set(hashes);
  const hashed = (token: string): string => {
    let h = cache.get(token);
    if (h === undefined) { h = hashName(token); cache.set(token, h); }
    return h;
  };
  const hits: NameHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const tokens = lines[i].toLowerCase().match(/[a-z0-9]+/g);
    if (!tokens) continue;
    let hit = false;
    for (let t = 0; t < tokens.length && !hit; t++) {
      if (set.has(hashed(tokens[t]))) hit = true;
      else if (t + 1 < tokens.length && set.has(hashed(tokens[t] + tokens[t + 1]))) hit = true;
    }
    if (hit) hits.push({ line: i + 1 });
  }
  return hits;
}

/** Scans every file `git ls-files` tracks under `root`; skips files over 2 MB or containing a NUL byte. */
export function scanRepository(root: string, hashes: readonly string[] = LISTED_HASHES): FileHit[] {
  const listing = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  const files = listing.toString('utf8').split('\0').filter(Boolean);
  const cache = new Map<string, string>();
  const hits: FileHit[] = [];
  for (const file of files) {
    const path = join(root, file);
    let buf: Buffer;
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue;
      buf = readFileSync(path);
    } catch {
      continue; // tracked but absent in the working tree (deleted, or a submodule/dir entry)
    }
    if (buf.includes(0)) continue;
    for (const { line } of findListedNames(buf.toString('utf8'), hashes, cache)) hits.push({ file, line });
  }
  return hits;
}
