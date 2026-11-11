#!/usr/bin/env node
// B-1459: print the salted hash of a client name for LISTED_HASHES in src/repo-hygiene/client-names.ts.
// Run it locally; never paste the name itself into a commit, a PR or a comment.
// Duplicates hashName() there on purpose (dependency-free, no TypeScript import): keep the two in step.
import { createHash } from 'node:crypto';

const SALT = 'harmony-no-client-names:';
const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/hash-client-name.mjs "<name>"');
  process.exit(2);
}
const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
console.log(createHash('sha256').update(SALT + normalized).digest('hex'));
