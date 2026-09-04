#!/usr/bin/env node
// B-929: CLI entry for the requirements-list image generator. Thin I/O shell around
// src/container/worker-image.ts — every decision (and every rejection) lives there and is unit
// tested there; this file only reads the file, writes the output, and picks the exit code.
//
// Usage:
//   node dist/bin/worker-image.js --requirements <list.json> [--base <image>] [--out <Dockerfile>]
//
// With no --out the Dockerfile goes to stdout, so it pipes straight into a build:
//   node dist/bin/worker-image.js --requirements container/worker-image/requirements.example.json \
//     | docker build -f - -t my-project-build-env container/

import { readFileSync, writeFileSync } from 'node:fs';
import { WORKER_IMAGE_DEFAULT } from '../config/deployment-config.js';
import { parseRequirements, renderWorkerImageDockerfile } from '../container/worker-image.js';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const requirementsPath = flag('requirements');
if (!requirementsPath) {
  process.stderr.write(
    'usage: worker-image --requirements <list.json> [--base <image>] [--out <Dockerfile>]\n',
  );
  process.exit(2);
}

// The base defaults to the shared worker image name (the same default `worker_image` carries), so
// the common case — "the Harmony base plus these three tools" — needs no flag.
const base = flag('base') ?? WORKER_IMAGE_DEFAULT;
const out = flag('out');

try {
  const raw = readFileSync(requirementsPath, 'utf8');
  const dockerfile = renderWorkerImageDockerfile(parseRequirements(raw, requirementsPath), {
    base,
    source: requirementsPath,
  });
  if (out) {
    writeFileSync(out, dockerfile, 'utf8');
    process.stderr.write(`worker-image: wrote ${out} (FROM ${base})\n`);
  } else {
    process.stdout.write(dockerfile);
  }
} catch (err) {
  process.stderr.write(`worker-image: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
