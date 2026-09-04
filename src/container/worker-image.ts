// B-929: the requirements-list image generator — the "second project needs a system package"
// escape hatch, and the producer half of lever 2 (`worker_image`,
// src/config/deployment-config.ts).
//
// THE POINT (B-929 AC4): a project never hand-writes a Dockerfile. It declares a flat list of the
// BINARIES its build needs, and this module emits the image layer. Two consequences fall out of
// that, and both are the reason for the shape:
//
//   1. Every emitted layer ends in a `command -v <bin>` assertion PER DECLARED BIN. An unresolved
//      requirement therefore fails the image BUILD — loudly, once, at publish time — instead of
//      failing a build LEG at 2am with "pnpm: command not found" after the worker has already
//      claimed the ticket.
//   2. The output is FROM the shared base (container/Dockerfile's `base`/`agent` target), so a
//      second project's image inherits git/gh/jq/python3/node/corepack/fnm and the entrypoint
//      contract for free. It is a LAYER, never a fork of the base.
//
// INPUT CONTRACT (this ticket owns the CONSUMER's contract only — deliberately NOT the
// `.harmony/project.yml` manifest format, which B-936 will own as the PRODUCER): a flat JSON array
// of objects
//
//   [ { "bin": "pnpm", "npm": "pnpm@11.21.0" }, { "bin": "convert", "apt": "imagemagick" } ]
//
//   bin  (required) — the executable that MUST exist in the built image.
//   apt  (optional) — the Debian package that provides it. Defaults to `bin`.
//   npm  (optional) — an npm spec to install globally instead of an apt package.
//
// A flat array of scalars-only objects is exactly what a YAML list of the same shape parses into,
// so a later producer can emit this file with a one-line yaml->json conversion and no schema
// negotiation.

/** One declared requirement. Exactly one source: `npm` when set, otherwise apt (`apt` or `bin`). */
export interface WorkerImageRequirement {
  bin: string;
  apt?: string;
  npm?: string;
}

export interface RenderOptions {
  /** The image this layer builds FROM — the shared worker base. */
  base: string;
  /** Where the requirements came from, for the generated file's own provenance header. */
  source?: string;
}

/** Malformed input fails HERE, with a message naming the offending entry — never downstream as a
 *  confusing docker build error. Accepts the raw file text so the caller (a CLI, a test) does not
 *  have to duplicate the JSON.parse error handling. */
export function parseRequirements(raw: string, source = '<input>'): WorkerImageRequirement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON ARRAY of { bin, apt?, npm? } objects`);
  }

  const seen = new Set<string>();
  const requirements: WorkerImageRequirement[] = [];
  parsed.forEach((entry, index) => {
    const at = `${source} entry ${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} must be an object of { bin, apt?, npm? }`);
    }
    const { bin, apt, npm, ...rest } = entry as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length > 0) {
      throw new Error(`${at} has unknown key(s) ${extra.join(', ')} — only bin, apt and npm exist`);
    }
    if (typeof bin !== 'string' || bin.trim() === '') {
      throw new Error(`${at} is missing a non-empty "bin"`);
    }
    for (const [key, value] of [
      ['apt', apt],
      ['npm', npm],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`${at} ("${bin}") has a non-empty-string "${key}"`);
      }
    }
    // One bin, one source. Declaring both would make the emitted layer's install order — and so
    // which one actually wins — an implementation detail, which is exactly the ambiguity this
    // generator exists to remove.
    if (typeof apt === 'string' && typeof npm === 'string') {
      throw new Error(`${at} ("${bin}") declares BOTH apt and npm — pick one source per bin`);
    }
    // Shell-metacharacter guard: these strings are interpolated into a RUN line, so anything that
    // could end the command is rejected rather than escaped.
    for (const [key, value] of [
      ['bin', bin],
      ['apt', apt],
      ['npm', npm],
    ] as const) {
      if (typeof value === 'string' && /[^A-Za-z0-9._@+/:-]/.test(value)) {
        throw new Error(
          `${at} ("${bin}") has an unsafe "${key}" value ${JSON.stringify(value)} — allowed: ` +
            'letters, digits and . _ @ + / : -',
        );
      }
    }
    if (seen.has(bin)) {
      throw new Error(`${source} declares "${bin}" twice — each bin may appear once`);
    }
    seen.add(bin);
    requirements.push({
      bin,
      ...(typeof apt === 'string' ? { apt } : {}),
      ...(typeof npm === 'string' ? { npm } : {}),
    });
  });
  return requirements;
}

/** Deterministic ordering: sorted by `bin`, so the same list in a different order emits a
 *  byte-identical Dockerfile (and therefore the same image layer cache key). */
function ordered(requirements: WorkerImageRequirement[]): WorkerImageRequirement[] {
  return [...requirements].sort((a, b) => (a.bin < b.bin ? -1 : a.bin > b.bin ? 1 : 0));
}

/** Emit the Dockerfile text for a worker image carrying `requirements`, layered on `base`. */
export function renderWorkerImageDockerfile(
  requirements: WorkerImageRequirement[],
  opts: RenderOptions,
): string {
  if (!opts.base || opts.base.trim() === '') {
    throw new Error('renderWorkerImageDockerfile needs a non-empty base image');
  }
  if (requirements.length === 0) {
    throw new Error('the requirements list is empty — an image with no declared bins is a no-op');
  }
  const reqs = ordered(requirements);
  const aptPackages = reqs.filter((r) => r.npm === undefined).map((r) => r.apt ?? r.bin);
  const npmSpecs = reqs.flatMap((r) => (r.npm === undefined ? [] : [r.npm]));

  const lines: string[] = [
    '# GENERATED — do not edit by hand.',
    `# Emitted by the B-929 requirements-list generator (src/container/worker-image.ts) from ${opts.source ?? '<requirements>'}.`,
    '# Regenerate instead: node dist/bin/worker-image.js --requirements <list.json> --base <image>',
    '#',
    '# Every declared bin is asserted with `command -v` at the END of this file, so an unresolved',
    '# requirement fails the image BUILD rather than a build leg.',
    '',
    `FROM ${opts.base}`,
    '',
    '# The base image ends as the non-root `worker` user; installs need root, and the assertions',
    '# below deliberately run back AS worker, so they prove what the leg will actually resolve.',
    'USER root',
  ];

  if (aptPackages.length > 0) {
    lines.push(
      'RUN apt-get update \\',
      '    && apt-get install -y --no-install-recommends \\',
      ...aptPackages.map((p) => `      ${p} \\`),
      '    && rm -rf /var/lib/apt/lists/*',
    );
  }
  if (npmSpecs.length > 0) {
    lines.push(`RUN npm install -g ${npmSpecs.join(' ')}`);
  }

  lines.push(
    'USER worker',
    '',
    '# One assertion per declared bin (B-929 AC4).',
    'RUN set -eux; \\',
    ...reqs.map((r, i) => `    command -v ${r.bin}${i === reqs.length - 1 ? '' : '; \\'}`),
    '',
  );
  return lines.join('\n');
}
