// B-929: the requirements-list generator's contract, asserted on the EMITTED TEXT.
//
// The "build the emitted image and run it" half of AC4 cannot run here (no docker in the build
// environment) and is delegated to the toolchain-contract CI job, which builds an image from THIS
// generator's output and asserts every declared bin resolves inside it. What IS provable in
// process — and is what actually keeps the contract honest — is that the emitted text says what it
// must: FROM the shared base, one install per declared source, one `command -v` per declared bin,
// deterministic ordering, and a loud failure on a malformed list.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRequirements,
  renderWorkerImageDockerfile,
  type WorkerImageRequirement,
} from './worker-image.js';

const BASE = 'harmony-build-env';

function render(requirements: WorkerImageRequirement[], base = BASE): string {
  return renderWorkerImageDockerfile(requirements, { base, source: 'reqs.json' });
}

describe('worker-image generator: emitted Dockerfile', () => {
  it('builds FROM the shared worker base, never from a distro image', () => {
    const out = render([{ bin: 'jq' }]);
    expect(out).toContain(`FROM ${BASE}`);
    expect(out).not.toMatch(/FROM\s+(debian|ubuntu|node):/);
  });

  it('installs an apt source for a bin that declares neither apt nor npm (apt defaults to bin)', () => {
    const out = render([{ bin: 'ripgrep' }]);
    expect(out).toContain('apt-get install -y --no-install-recommends');
    expect(out).toContain('      ripgrep \\');
  });

  it('uses the declared apt package name when it differs from the bin', () => {
    const out = render([{ bin: 'convert', apt: 'imagemagick' }]);
    expect(out).toContain('      imagemagick \\');
    expect(out).not.toContain('      convert \\');
    // …but the ASSERTION is still on the bin, which is the thing a build actually invokes.
    expect(out).toContain('command -v convert');
  });

  it('installs an npm source globally instead of an apt package', () => {
    const out = render([{ bin: 'pnpm', npm: 'pnpm@11.21.0' }]);
    expect(out).toContain('RUN npm install -g pnpm@11.21.0');
    expect(out).not.toContain('apt-get install');
  });

  it('emits a `command -v` assertion for EVERY declared bin (AC4: an unresolved requirement fails the BUILD)', () => {
    const out = render([{ bin: 'pnpm', npm: 'pnpm@11.21.0' }, { bin: 'jq' }, { bin: 'rsync' }]);
    for (const bin of ['pnpm', 'jq', 'rsync']) {
      expect(out).toContain(`command -v ${bin}`);
    }
    // The assertions are a RUN, so docker build fails on them — not a comment, not an ENV.
    const assertionBlock = out.slice(out.indexOf('RUN set -eux'));
    expect(assertionBlock).toContain('command -v pnpm');
    expect(assertionBlock).toContain('command -v jq');
    expect(assertionBlock).toContain('command -v rsync');
  });

  it('runs the installs as root and the assertions back as the non-root worker', () => {
    const out = render([{ bin: 'jq' }]);
    const rootAt = out.indexOf('USER root');
    const workerAt = out.indexOf('USER worker');
    const assertAt = out.indexOf('RUN set -eux');
    expect(rootAt).toBeGreaterThan(0);
    expect(workerAt).toBeGreaterThan(rootAt);
    expect(assertAt).toBeGreaterThan(workerAt);
  });

  it('is DETERMINISTIC: the same requirements in a different input order emit byte-identical text', () => {
    const a = render([{ bin: 'rsync' }, { bin: 'jq' }, { bin: 'pnpm', npm: 'pnpm@11.21.0' }]);
    const b = render([{ bin: 'pnpm', npm: 'pnpm@11.21.0' }, { bin: 'jq' }, { bin: 'rsync' }]);
    expect(a).toBe(b);
  });

  it('omits the apt block entirely when every requirement is npm-sourced (and vice versa)', () => {
    const npmOnly = render([{ bin: 'pnpm', npm: 'pnpm@11.21.0' }]);
    expect(npmOnly).not.toContain('apt-get');
    const aptOnly = render([{ bin: 'jq' }]);
    expect(aptOnly).not.toContain('npm install -g');
  });

  it('refuses to emit anything for an empty requirements list', () => {
    expect(() => render([])).toThrow(/empty/);
  });

  it('refuses to emit without a base image', () => {
    expect(() => render([{ bin: 'jq' }], '')).toThrow(/base image/);
  });
});

describe('worker-image generator: malformed requirements lists fail loudly', () => {
  it('rejects input that is not JSON at all', () => {
    expect(() => parseRequirements('{not json', 'reqs.json')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON object at the top level (the contract is a flat ARRAY)', () => {
    expect(() => parseRequirements('{"bin":"jq"}', 'reqs.json')).toThrow(/must be a JSON ARRAY/);
  });

  it('rejects an entry that is not an object', () => {
    expect(() => parseRequirements('["jq"]', 'reqs.json')).toThrow(/entry 0 must be an object/);
  });

  it('rejects an entry with no bin', () => {
    expect(() => parseRequirements('[{"apt":"jq"}]', 'reqs.json')).toThrow(/missing a non-empty "bin"/);
  });

  it('rejects an entry declaring BOTH apt and npm (one source per bin)', () => {
    expect(() => parseRequirements('[{"bin":"pnpm","apt":"pnpm","npm":"pnpm@11"}]', 'reqs.json')).toThrow(
      /declares BOTH apt and npm/,
    );
  });

  it('rejects an unknown key, so a typo like "npmm" is never silently ignored', () => {
    expect(() => parseRequirements('[{"bin":"pnpm","npmm":"pnpm@11"}]', 'reqs.json')).toThrow(
      /unknown key\(s\) npmm/,
    );
  });

  it('rejects a duplicate bin', () => {
    expect(() => parseRequirements('[{"bin":"jq"},{"bin":"jq"}]', 'reqs.json')).toThrow(/twice/);
  });

  it('rejects a value carrying shell metacharacters rather than escaping it into a RUN line', () => {
    expect(() => parseRequirements('[{"bin":"jq","apt":"jq; rm -rf /"}]', 'reqs.json')).toThrow(
      /unsafe "apt" value/,
    );
  });

  it('accepts the well-formed shape and normalizes it', () => {
    const parsed = parseRequirements('[{"bin":"pnpm","npm":"pnpm@11.21.0"},{"bin":"jq"}]', 'reqs.json');
    expect(parsed).toEqual([{ bin: 'pnpm', npm: 'pnpm@11.21.0' }, { bin: 'jq' }]);
  });
});

// The COMMITTED example list is the file a new project copies — if it stops parsing, or stops
// producing a layer that carries its own assertions, the documented starting point is broken.
describe('the committed container/worker-image/requirements.example.json', () => {
  const examplePath = fileURLToPath(
    new URL('../../container/worker-image/requirements.example.json', import.meta.url),
  );

  it('parses under the real contract and renders a layer asserting every bin it declares', () => {
    const requirements = parseRequirements(readFileSync(examplePath, 'utf8'), examplePath);
    expect(requirements.length).toBeGreaterThan(0);
    const out = renderWorkerImageDockerfile(requirements, { base: BASE, source: examplePath });
    expect(out).toContain(`FROM ${BASE}`);
    for (const req of requirements) {
      expect(out).toContain(`command -v ${req.bin}`);
    }
  });

  it('carries the prospectery-shaped pnpm requirement the docs promise', () => {
    const requirements = parseRequirements(readFileSync(examplePath, 'utf8'), examplePath);
    expect(requirements.some((r) => r.bin === 'pnpm' && r.npm?.startsWith('pnpm@'))).toBe(true);
  });
});
