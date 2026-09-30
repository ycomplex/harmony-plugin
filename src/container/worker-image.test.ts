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
  isLibRequirement,
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
      expect(out).toContain(isLibRequirement(req) ? `dpkg -s ${req.lib}` : `command -v ${req.bin}`);
    }
  });

  it('carries the prospectery-shaped pnpm requirement the docs promise', () => {
    const requirements = parseRequirements(readFileSync(examplePath, 'utf8'), examplePath);
    expect(
      requirements.some((r) => !isLibRequirement(r) && r.bin === 'pnpm' && r.npm?.startsWith('pnpm@')),
    ).toBe(true);
  });

  it('B-1085 — carries a lib entry, so the CI-built example image proves the library kind too', () => {
    const requirements = parseRequirements(readFileSync(examplePath, 'utf8'), examplePath);
    expect(requirements.some(isLibRequirement)).toBe(true);
  });
});

// --- B-1085: a library-only package, and a checksum-pinned static binary --------------------------
const SHA = 'a'.repeat(64);
const URL_OK = 'https://github.com/jdx/mise/releases/download/v2026.9.17/mise-v2026.9.17-linux-x64';

describe('worker-image generator: lib entries (B-1085)', () => {
  it('installs a lib through apt and asserts it with dpkg -s, never command -v', () => {
    const out = render([{ bin: 'jq' }, { lib: 'libicu72' }]);
    expect(out).toMatch(/apt-get install[\s\S]*\n {6}libicu72 \\/);
    expect(out).toContain('dpkg -s libicu72 > /dev/null');
    expect(out).not.toContain('command -v libicu72');
    expect(out).toContain('command -v jq');
  });

  it('renders a list of libs only (a lib is a requirement, the list is not empty)', () => {
    const out = render([{ lib: 'libicu72' }]);
    expect(out).toContain('dpkg -s libicu72 > /dev/null');
    // no bin assertion LINE (the generated header's prose still mentions `command -v`)
    expect(out).not.toMatch(/^\s+command -v /m);
  });

  it('installs a lib once when a bin already names the same apt package', () => {
    const out = render([{ bin: 'icuinfo', apt: 'libicu72' }, { lib: 'libicu72' }]);
    expect(out.match(/\n {6}libicu72 \\/g)).toHaveLength(1);
  });

  it('rejects a lib entry that also declares a bin or a source', () => {
    expect(() => parseRequirements('[{"lib":"libicu72","bin":"icu"}]')).toThrow(/EITHER a bin or a lib/);
    expect(() => parseRequirements('[{"lib":"libicu72","apt":"libicu72"}]')).toThrow(/EITHER a bin or a lib/);
  });

  it('rejects a duplicate lib and an unsafe lib value', () => {
    expect(() => parseRequirements('[{"lib":"libicu72"},{"lib":"libicu72"}]')).toThrow(/lib "libicu72" twice/);
    expect(() => parseRequirements('[{"lib":"libicu72; rm -rf /"}]')).toThrow(/unsafe "lib"/);
  });

  it('is deterministic across input order with libs and bins mixed', () => {
    const a = render([{ lib: 'zlib1g' }, { bin: 'jq' }, { lib: 'libicu72' }]);
    const b = render([{ lib: 'libicu72' }, { lib: 'zlib1g' }, { bin: 'jq' }]);
    expect(a).toBe(b);
  });
});

describe('worker-image generator: checksum-pinned static binaries (B-1085)', () => {
  it('downloads over https to /usr/local/bin/<bin>, verifies the checksum, then makes it executable', () => {
    const out = render([{ bin: 'mise', url: URL_OK, sha256: SHA }]);
    expect(out).toContain(`curl -fsSL --proto =https --tlsv1.2 -o /usr/local/bin/mise ${URL_OK}`);
    expect(out).toContain(`echo "${SHA}  /usr/local/bin/mise" | sha256sum -c -`);
    expect(out).toContain('chmod 0755 /usr/local/bin/mise');
    // verify BEFORE chmod: a checksum mismatch must fail the build before the file is executable
    expect(out.indexOf('sha256sum -c -')).toBeLessThan(out.indexOf('chmod 0755 /usr/local/bin/mise'));
    expect(out).toContain('command -v mise');
    // a url-sourced bin is never also apt-installed
    expect(out).not.toMatch(/apt-get install[\s\S]*\n {6}mise \\/);
  });

  it('rejects a url without a sha256 — no unpinned download', () => {
    expect(() => parseRequirements(`[{"bin":"mise","url":"${URL_OK}"}]`)).toThrow(/checksum-pinned/);
  });

  it('rejects a sha256 without a url, and a malformed sha256', () => {
    expect(() => parseRequirements(`[{"bin":"mise","sha256":"${SHA}"}]`)).toThrow(/sha256 with no url/);
    expect(() => parseRequirements(`[{"bin":"mise","url":"${URL_OK}","sha256":"ABC"}]`)).toThrow(/64 lowercase hex/);
  });

  it('rejects a non-https url', () => {
    expect(() => parseRequirements(`[{"bin":"mise","url":"http://example.com/mise","sha256":"${SHA}"}]`)).toThrow(/not https/);
  });

  it('rejects a url with shell metacharacters or a query string', () => {
    expect(() => parseRequirements(`[{"bin":"mise","url":"https://example.com/mise?x=1","sha256":"${SHA}"}]`)).toThrow(/unsafe "url"/);
    expect(() => parseRequirements(`[{"bin":"mise","url":"https://example.com/m;id","sha256":"${SHA}"}]`)).toThrow(/unsafe "url"/);
  });

  it('rejects a url-sourced bin that carries a path (it becomes a file name under /usr/local/bin)', () => {
    expect(() => parseRequirements(`[{"bin":"bin/mise","url":"${URL_OK}","sha256":"${SHA}"}]`)).toThrow(/file name under \/usr\/local\/bin/);
  });

  it('rejects a bin declaring a url alongside apt or npm (one source per bin)', () => {
    expect(() => parseRequirements(`[{"bin":"mise","apt":"mise","url":"${URL_OK}","sha256":"${SHA}"}]`)).toThrow(/pick one source per bin/);
    expect(() => parseRequirements(`[{"bin":"mise","npm":"mise","url":"${URL_OK}","sha256":"${SHA}"}]`)).toThrow(/pick one source per bin/);
  });

  it('normalizes the accepted shape, and still names the full key set on an unknown key', () => {
    expect(parseRequirements(`[{"bin":"mise","url":"${URL_OK}","sha256":"${SHA}"},{"lib":"libicu72"}]`)).toEqual([
      { bin: 'mise', url: URL_OK, sha256: SHA },
      { lib: 'libicu72' },
    ]);
    expect(() => parseRequirements('[{"bin":"x","script":"https://mise.run"}]')).toThrow(/unknown key\(s\) script/);
  });
});
