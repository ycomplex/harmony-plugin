// B-732: unit coverage for the App-token mint script's pure parts.
//
// The network exchange itself is exercised at the build gate against the real App (the private key
// is in founder custody, so it cannot run here). What IS testable without a key — and what carries
// the security properties — is the JWT claim shape, the env-file composition, and the file mode.

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildJwt,
  composeEnvFile,
  writeEnvFile,
  mintInstallationToken,
  resolveDeploymentConfigPath,
  flattenEnvSection,
  resolveBaseContent,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs helper module, deliberately dependency-free and untyped
} from '../scripts/mint-installation-token.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('buildJwt', () => {
  it('signs an RS256 JWT whose claims match what GitHub requires of an App JWT', () => {
    const now = 1_800_000_000;
    const jwt = buildJwt({ appId: 4366664, privateKey, nowSeconds: now });

    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
    expect(decodeSegment(headerSeg)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = decodeSegment(payloadSeg);
    // `iss` must be the App id, and GitHub compares it as a string.
    expect(payload.iss).toBe('4366664');
    // Backdated `iat` absorbs clock skew; GitHub rejects a JWT issued in its future.
    expect(payload.iat).toBe(now - 60);
    // GitHub caps the lifetime at 10 minutes — staying under it is the property that matters.
    expect((payload.exp as number) - now).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(payload.iat as number);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signatureSeg, 'base64url'))).toBe(true);
  });

  it('refuses to build without an app id or a private key', () => {
    expect(() => buildJwt({ appId: undefined, privateKey })).toThrow(/appId is required/);
    expect(() => buildJwt({ appId: 1, privateKey: undefined })).toThrow(/privateKey is required/);
  });
});

describe('composeEnvFile', () => {
  // The load-bearing one. The base env-file already carries the founder PAT as GIT_TOKEN. If the
  // minted token were merely appended, bot authorship would depend on --env-file duplicate-key
  // precedence; a stale PAT winning would produce a founder-authored PR from a worker run, which
  // is the exact fail-open B-732 closes. So the old line must be GONE, not merely outranked.
  it('STRIPS a pre-existing GIT_TOKEN rather than relying on override order', () => {
    const composed = composeEnvFile({
      baseContent: 'HARMONY_API_TOKEN=abc\nGIT_TOKEN=ghp_stale_founder_pat\nOTHER=keep\n',
      token: 'ghs_minted',
    });

    expect(composed).not.toContain('ghp_stale_founder_pat');
    expect(composed.match(/^GIT_TOKEN=/gm)).toHaveLength(1);
    expect(composed).toContain('GIT_TOKEN=ghs_minted');
  });

  it('preserves every other credential line in the base file', () => {
    const composed = composeEnvFile({
      baseContent: 'HARMONY_API_TOKEN=abc\nCLAUDE_CODE_OAUTH_TOKEN=xyz\n',
      token: 'ghs_minted',
    });

    expect(composed).toContain('HARMONY_API_TOKEN=abc');
    expect(composed).toContain('CLAUDE_CODE_OAUTH_TOKEN=xyz');
    expect(composed.endsWith('GIT_TOKEN=ghs_minted\n')).toBe(true);
  });

  it('handles an empty base without emitting a leading blank line', () => {
    expect(composeEnvFile({ baseContent: '', token: 'ghs_minted' })).toBe('GIT_TOKEN=ghs_minted\n');
  });

  it('ignores a commented-out GIT_TOKEN, matching only a real assignment', () => {
    const composed = composeEnvFile({
      baseContent: '# GIT_TOKEN=documentation-example\n',
      token: 'ghs_minted',
    });
    expect(composed).toContain('# GIT_TOKEN=documentation-example');
  });

  it('refuses to compose without a token', () => {
    expect(() => composeEnvFile({ baseContent: '', token: '' })).toThrow(/token is required/);
  });
});

describe('writeEnvFile', () => {
  it('creates the env-file owner-read/write only', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'b732-')), 'run.env');
    writeEnvFile(out, 'GIT_TOKEN=ghs_minted\n');

    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toBe('GIT_TOKEN=ghs_minted\n');
  });

  it('tightens the mode of a pre-existing permissive file instead of inheriting it', () => {
    // writeFileSync's `mode` applies only on CREATE, so overwriting a world-readable leftover
    // would silently keep 0644 and leak the token to every user on the host.
    const out = join(mkdtempSync(join(tmpdir(), 'b732-')), 'run.env');
    writeFileSync(out, 'stale\n', { mode: 0o644 });
    expect(statSync(out).mode & 0o777).toBe(0o644);

    writeEnvFile(out, 'GIT_TOKEN=ghs_minted\n');
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe('mintInstallationToken', () => {
  it('posts to the installation access_tokens endpoint with the JWT as a bearer token', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    const fetchImpl = async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, json: async () => ({ token: 'ghs_minted' }) } as unknown as Response;
    };

    const token = await mintInstallationToken({
      jwt: 'jwt-value',
      installationId: '12345',
      fetchImpl,
    });

    expect(token).toBe('ghs_minted');
    expect(seenUrl).toBe('https://api.github.com/app/installations/12345/access_tokens');
    expect(seenInit.method).toBe('POST');
    expect((seenInit.headers as Record<string, string>).Authorization).toBe('Bearer jwt-value');
  });

  it('surfaces GitHub status and message on failure so a bad key or installation id is diagnosable', async () => {
    const fetchImpl = async () =>
      ({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }) as unknown as Response;

    await expect(
      mintInstallationToken({ jwt: 'jwt-value', installationId: '404', fetchImpl }),
    ).rejects.toThrow(/HTTP 404 — Not Found/);
  });

  it('fails loudly when GitHub returns a body with no token', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({}) }) as unknown as Response;

    await expect(
      mintInstallationToken({ jwt: 'jwt-value', installationId: '1', fetchImpl }),
    ).rejects.toThrow(/no token/);
  });
});

// B-800 item 2: --base <file> is superseded by a deployment config's `env` section when one is
// present at the resolved path — see resolveBaseContent's own doc comment in the .mjs file for
// the full precedence. Fake fs (no real filesystem touched) mirrors
// src/config/deployment-config.test.ts's fakeFs style, for the same injectable-IO reason.
function fakeFs(files: Record<string, string>) {
  return {
    existsImpl: (path: string) => path in files,
    readImpl: (path: string) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files[path];
    },
  };
}

describe('resolveDeploymentConfigPath', () => {
  it('prefers an explicit configPath over everything else', () => {
    expect(
      resolveDeploymentConfigPath({
        configPath: '/explicit/path.json',
        env: { HARMONY_DEPLOYMENT_CONFIG: '/env/path.json' },
      }),
    ).toBe('/explicit/path.json');
  });

  it('falls back to HARMONY_DEPLOYMENT_CONFIG when no explicit path is given', () => {
    expect(
      resolveDeploymentConfigPath({ env: { HARMONY_DEPLOYMENT_CONFIG: '/env/path.json' } }),
    ).toBe('/env/path.json');
  });

  it('defaults to ~/.harmony/deployment.json when neither is set', () => {
    expect(resolveDeploymentConfigPath({ env: {} })).toMatch(/\.harmony[/\\]deployment\.json$/);
  });
});

describe('flattenEnvSection', () => {
  it('flattens a { KEY: value } object into KEY=value lines', () => {
    expect(flattenEnvSection({ HARMONY_API_TOKEN: 'abc', GIT_USER_NAME: 'Harmony Worker' })).toBe(
      'HARMONY_API_TOKEN=abc\nGIT_USER_NAME=Harmony Worker\n',
    );
  });

  it('returns an empty string for an absent, empty, or non-object section', () => {
    expect(flattenEnvSection(undefined)).toBe('');
    expect(flattenEnvSection({})).toBe('');
    expect(flattenEnvSection(null)).toBe('');
  });

  it('skips null/undefined values but keeps every other key', () => {
    expect(flattenEnvSection({ A: 'x', B: undefined, C: null, D: 'y' })).toBe('A=x\nD=y\n');
  });
});

describe('resolveBaseContent', () => {
  it('builds base content from the deployment config env section when the config file exists', () => {
    const io = fakeFs({
      '/deployment.json': JSON.stringify({ env: { HARMONY_API_TOKEN: 'tok', GIT_USER_NAME: 'Bot' } }),
    });
    const content = resolveBaseContent({ base: '/should/not/be/read.env', configPath: '/deployment.json', ...io });
    expect(content).toBe('HARMONY_API_TOKEN=tok\nGIT_USER_NAME=Bot\n');
  });

  it('falls back to reading --base <file> unchanged when no deployment config exists at the resolved path', () => {
    const io = fakeFs({ '/legacy.env': 'HARMONY_API_TOKEN=legacy-tok\n' });
    const content = resolveBaseContent({ base: '/legacy.env', configPath: '/nowhere/deployment.json', ...io });
    expect(content).toBe('HARMONY_API_TOKEN=legacy-tok\n');
  });

  it('returns an empty string when neither --base nor a deployment config resolves', () => {
    const io = fakeFs({});
    expect(resolveBaseContent({ configPath: '/nowhere/deployment.json', ...io })).toBe('');
  });

  it('resolves the deployment config path via HARMONY_DEPLOYMENT_CONFIG when no --config is given', () => {
    const io = fakeFs({ '/env-configured.json': JSON.stringify({ env: { GIT_TOKEN: 'stale' } }) });
    const content = resolveBaseContent({
      env: { HARMONY_DEPLOYMENT_CONFIG: '/env-configured.json' },
      ...io,
    });
    expect(content).toBe('GIT_TOKEN=stale\n');
  });

  it('throws a clear error for a deployment config that exists but is malformed JSON', () => {
    const io = fakeFs({ '/deployment.json': '{ not valid json' });
    expect(() => resolveBaseContent({ configPath: '/deployment.json', ...io })).toThrow(
      /not valid JSON/,
    );
  });

  it('handles a deployment config with no "env" section as empty base content', () => {
    const io = fakeFs({ '/deployment.json': JSON.stringify({ profiles: {} }) });
    expect(resolveBaseContent({ configPath: '/deployment.json', ...io })).toBe('');
  });
});

describe('resolveBaseContent + composeEnvFile integration (B-800 end-to-end shape)', () => {
  it('a stale GIT_TOKEN in the deployment config env section is still stripped, same as --base', () => {
    const io = fakeFs({
      '/deployment.json': JSON.stringify({
        env: { HARMONY_API_TOKEN: 'tok', GIT_TOKEN: 'ghp_stale_founder_pat' },
      }),
    });
    const baseContent = resolveBaseContent({ configPath: '/deployment.json', ...io });
    const composed = composeEnvFile({ baseContent, token: 'ghs_minted' });
    expect(composed).not.toContain('ghp_stale_founder_pat');
    expect(composed).toContain('HARMONY_API_TOKEN=tok');
    expect(composed).toContain('GIT_TOKEN=ghs_minted');
  });
});
