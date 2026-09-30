// B-929: the requirements-list image generator — the "second project needs a system package"
// escape hatch, and the producer half of lever 2 (`worker_image`,
// src/config/deployment-config.ts).
//
// THE POINT (B-929 AC4): a project never hand-writes a Dockerfile. It declares a flat list of what
// its build needs, and this module emits the image layer. Two consequences fall out of that, and
// both are the reason for the shape:
//
//   1. Every emitted layer ends in an assertion PER DECLARED REQUIREMENT (`command -v <bin>`, or
//      `dpkg -s <lib>` for a library). An unresolved requirement therefore fails the image BUILD —
//      loudly, once, at publish time — instead of failing a build LEG at 2am with "pnpm: command
//      not found" after the worker has already claimed the ticket.
//   2. The output is FROM the shared base (container/Dockerfile's `base`/`agent` target), so a
//      second project's image inherits git/gh/jq/python3/node/corepack/fnm and the entrypoint
//      contract for free. It is a LAYER, never a fork of the base.
//
// INPUT CONTRACT (this ticket owns the CONSUMER's contract only — deliberately NOT the
// `.harmony/project.yml` manifest format, which B-936 will own as the PRODUCER): a flat JSON array
// of objects
//
//   [ { "bin": "pnpm", "npm": "pnpm@11.21.0" },
//     { "bin": "convert", "apt": "imagemagick" },
//     { "bin": "mise", "url": "https://…/mise-v2026.9.17-linux-x64", "sha256": "<64 hex>" },
//     { "lib": "libicu72" } ]
//
//   bin     — the executable that MUST exist in the built image. Exactly one source:
//     apt     (optional) — the Debian package that provides it. Defaults to `bin`.
//     npm     (optional) — an npm spec to install globally instead of an apt package.
//     url + sha256 (B-1085) — a PINNED static binary: downloaded over https to
//               /usr/local/bin/<bin>, checksum-verified, made executable.
//   lib     (B-1085) — a Debian package that provides NO binary (a shared library). Asserted with
//             `dpkg -s` instead of `command -v`. An entry is EITHER a `bin` or a `lib`.
//
// B-1085 — why these two kinds and no "installer script" kind: the first third-party project
// (a .NET build whose toolchain is pinned through mise) needed `mise` — not in Debian's apt, not an
// npm package — and ICU, a library with no binary to assert. Both are expressible as a checksum-
// pinned download and a library entry. A `curl … | sh` source was deliberately NOT added: a
// requirements list must not become an arbitrary-script surface, and an unpinned download makes the
// same list build two different images on two different days.
//
// A flat array of scalars-only objects is exactly what a YAML list of the same shape parses into,
// so a later producer can emit this file with a one-line yaml->json conversion and no schema
// negotiation.

/** A declared executable. Exactly one source: `npm`, `url` (+ `sha256`), or apt (`apt` or `bin`). */
export interface WorkerImageBinRequirement {
  bin: string;
  apt?: string;
  npm?: string;
  /** B-1085: https URL of a static binary, installed as /usr/local/bin/<bin>. Needs `sha256`. */
  url?: string;
  /** B-1085: lowercase hex SHA-256 of the file at `url`. */
  sha256?: string;
}

/** B-1085: a Debian package with no binary (a shared library), asserted with `dpkg -s`. */
export interface WorkerImageLibRequirement {
  lib: string;
}

export type WorkerImageRequirement = WorkerImageBinRequirement | WorkerImageLibRequirement;

export function isLibRequirement(r: WorkerImageRequirement): r is WorkerImageLibRequirement {
  return 'lib' in r;
}

export interface RenderOptions {
  /** The image this layer builds FROM — the shared worker base. */
  base: string;
  /** Where the requirements came from, for the generated file's own provenance header. */
  source?: string;
}

const KNOWN_KEYS = ['bin', 'apt', 'npm', 'url', 'sha256', 'lib'] as const;
const UNSAFE_VALUE = /[^A-Za-z0-9._@+/:-]/;
/** A url-sourced bin becomes a file NAME under /usr/local/bin, so it may not carry a path. */
const UNSAFE_FILE_NAME = /[^A-Za-z0-9._+-]/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

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
    throw new Error(
      `${source} must be a JSON ARRAY of { bin, apt? | npm? | url + sha256 } or { lib } objects`,
    );
  }

  const seenBins = new Set<string>();
  const seenLibs = new Set<string>();
  const requirements: WorkerImageRequirement[] = [];
  parsed.forEach((entry, index) => {
    const at = `${source} entry ${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} must be an object of { bin, apt? | npm? | url + sha256 } or { lib }`);
    }
    const record = entry as Record<string, unknown>;
    const extra = Object.keys(record).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) {
      throw new Error(
        `${at} has unknown key(s) ${extra.join(', ')} — only ${KNOWN_KEYS.join(', ')} exist`,
      );
    }
    const { bin, apt, npm, url, sha256, lib } = record;

    // ---- a library entry: { lib } and nothing else ------------------------------------------
    if (lib !== undefined) {
      if (typeof lib !== 'string' || lib.trim() === '') {
        throw new Error(`${at} has a non-empty-string "lib"`);
      }
      const others = (['bin', 'apt', 'npm', 'url', 'sha256'] as const).filter(
        (k) => record[k] !== undefined,
      );
      if (others.length > 0) {
        throw new Error(
          `${at} ("${lib}") is a lib entry but also declares ${others.join(', ')} — a lib is an apt ` +
            'package with no binary; an entry is EITHER a bin or a lib',
        );
      }
      if (UNSAFE_VALUE.test(lib)) {
        throw new Error(
          `${at} ("${lib}") has an unsafe "lib" value ${JSON.stringify(lib)} — allowed: ` +
            'letters, digits and . _ @ + / : -',
        );
      }
      if (seenLibs.has(lib)) {
        throw new Error(`${source} declares lib "${lib}" twice — each lib may appear once`);
      }
      seenLibs.add(lib);
      requirements.push({ lib });
      return;
    }

    // ---- a bin entry ------------------------------------------------------------------------
    if (typeof bin !== 'string' || bin.trim() === '') {
      throw new Error(`${at} is missing a non-empty "bin" (or a "lib" for a library-only package)`);
    }
    for (const [key, value] of [
      ['apt', apt],
      ['npm', npm],
      ['url', url],
      ['sha256', sha256],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`${at} ("${bin}") has a non-empty-string "${key}"`);
      }
    }
    // One bin, one source. Declaring two would make the emitted layer's install order — and so
    // which one actually wins — an implementation detail, which is exactly the ambiguity this
    // generator exists to remove.
    const sources = (['apt', 'npm', 'url'] as const).filter((k) => typeof record[k] === 'string');
    if (sources.length > 1) {
      throw new Error(
        `${at} ("${bin}") declares BOTH ${sources.join(' and ')} — pick one source per bin`,
      );
    }
    // A download is pinned or it is not accepted: `url` and `sha256` travel together.
    if (typeof url === 'string' && typeof sha256 !== 'string') {
      throw new Error(
        `${at} ("${bin}") declares a url with no sha256 — a downloaded binary must be checksum-pinned`,
      );
    }
    if (typeof sha256 === 'string' && typeof url !== 'string') {
      throw new Error(`${at} ("${bin}") declares a sha256 with no url to verify`);
    }
    // Shell-metacharacter guard: these strings are interpolated into a RUN line, so anything that
    // could end the command is rejected rather than escaped.
    for (const [key, value] of [
      ['bin', bin],
      ['apt', apt],
      ['npm', npm],
      ['url', url],
    ] as const) {
      if (typeof value === 'string' && UNSAFE_VALUE.test(value)) {
        throw new Error(
          `${at} ("${bin}") has an unsafe "${key}" value ${JSON.stringify(value)} — allowed: ` +
            'letters, digits and . _ @ + / : -',
        );
      }
    }
    if (typeof url === 'string') {
      if (!url.startsWith('https://')) {
        throw new Error(`${at} ("${bin}") has a url that is not https:// — ${JSON.stringify(url)}`);
      }
      if (UNSAFE_FILE_NAME.test(bin)) {
        throw new Error(
          `${at} ("${bin}") is url-sourced, so its bin becomes a file name under /usr/local/bin and ` +
            'may only contain letters, digits and . _ + -',
        );
      }
      if (typeof sha256 === 'string' && !SHA256_HEX.test(sha256)) {
        throw new Error(
          `${at} ("${bin}") has a sha256 that is not 64 lowercase hex characters — ` +
            JSON.stringify(sha256),
        );
      }
    }
    if (seenBins.has(bin)) {
      throw new Error(`${source} declares "${bin}" twice — each bin may appear once`);
    }
    seenBins.add(bin);
    requirements.push({
      bin,
      ...(typeof apt === 'string' ? { apt } : {}),
      ...(typeof npm === 'string' ? { npm } : {}),
      ...(typeof url === 'string' && typeof sha256 === 'string' ? { url, sha256 } : {}),
    });
  });
  return requirements;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Emit the Dockerfile text for a worker image carrying `requirements`, layered on `base`. */
export function renderWorkerImageDockerfile(
  requirements: WorkerImageRequirement[],
  opts: RenderOptions,
): string {
  if (!opts.base || opts.base.trim() === '') {
    throw new Error('renderWorkerImageDockerfile needs a non-empty base image');
  }
  if (requirements.length === 0) {
    throw new Error(
      'the requirements list is empty — an image with no declared requirement is a no-op',
    );
  }
  // Deterministic ordering: bins sorted by `bin`, libs sorted by name, so the same list in a
  // different order emits a byte-identical Dockerfile (and therefore the same layer cache key).
  const bins = requirements
    .filter((r): r is WorkerImageBinRequirement => !isLibRequirement(r))
    .sort((a, b) => byString(a.bin, b.bin));
  const libs = requirements
    .filter(isLibRequirement)
    .map((r) => r.lib)
    .sort(byString);

  const aptFromBins = bins
    .filter((r) => r.npm === undefined && r.url === undefined)
    .map((r) => r.apt ?? r.bin);
  // A lib that some bin's apt package already names is installed once.
  const aptPackages = [...aptFromBins, ...libs.filter((l) => !aptFromBins.includes(l))];
  const npmSpecs = bins.flatMap((r) => (r.npm === undefined ? [] : [r.npm]));
  const downloads = bins.filter(
    (r): r is WorkerImageBinRequirement & { url: string; sha256: string } =>
      r.url !== undefined && r.sha256 !== undefined,
  );

  const lines: string[] = [
    '# GENERATED — do not edit by hand.',
    `# Emitted by the B-929 requirements-list generator (src/container/worker-image.ts) from ${opts.source ?? '<requirements>'}.`,
    '# Regenerate instead: node dist/bin/worker-image.js --requirements <list.json> --base <image>',
    '#',
    '# Every declared requirement is asserted at the END of this file (`command -v` per bin,',
    '# `dpkg -s` per lib), so an unresolved requirement fails the image BUILD rather than a build leg.',
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
  for (const d of downloads) {
    // B-1085: https only, checksum verified BEFORE the file is made executable; a mismatch fails
    // the image build. `curl` is part of the shared base image.
    lines.push(
      'RUN set -eux; \\',
      `    curl -fsSL --proto =https --tlsv1.2 -o /usr/local/bin/${d.bin} ${d.url}; \\`,
      `    echo "${d.sha256}  /usr/local/bin/${d.bin}" | sha256sum -c -; \\`,
      `    chmod 0755 /usr/local/bin/${d.bin}`,
    );
  }

  const assertions = [
    ...bins.map((r) => `command -v ${r.bin}`),
    ...libs.map((l) => `dpkg -s ${l} > /dev/null`),
  ];
  lines.push(
    'USER worker',
    '',
    '# One assertion per declared requirement (B-929 AC4; `dpkg -s` for a lib, B-1085).',
    'RUN set -eux; \\',
    ...assertions.map((a, i) => `    ${a}${i === assertions.length - 1 ? '' : '; \\'}`),
    '',
  );
  return lines.join('\n');
}
