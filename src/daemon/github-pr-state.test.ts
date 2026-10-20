import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createGithubPrMergeStateReader, parseGithubPrUrl, prMergeStateFromPullJson } from './github-pr-state.js';
import { findReleaseAccept } from './fasttrack-release-recording.js';

const PR = 'https://github.com/ycomplex/harmony-plugin/pull/42';
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

describe('github-pr-state (B-1073)', () => {
  it('parses PR URLs and rejects everything else', () => {
    expect(parseGithubPrUrl(PR)).toEqual({ owner: 'ycomplex', repo: 'harmony-plugin', number: 42 });
    expect(parseGithubPrUrl(`${PR}/files`)).toEqual({ owner: 'ycomplex', repo: 'harmony-plugin', number: 42 });
    expect(parseGithubPrUrl('https://example.com/x')).toBeNull();
  });

  it.each([
    [{ merged: true, state: 'closed' }, 'merged'],
    [{ merged: false, state: 'open' }, 'open'],
    [{ merged: false, state: 'closed' }, 'closed'],
    [{}, 'unknown'],
    [null, 'unknown'],
  ])('maps %j to %s', (body, expected) => {
    expect(prMergeStateFromPullJson(body)).toBe(expected);
  });

  it('is undefined (no interception) when the env carries no GitHub credential source', () => {
    expect(createGithubPrMergeStateReader({ env: { HARMONY_API_TOKEN: 'x' } })).toBeUndefined();
    expect(createGithubPrMergeStateReader({ env: { HARMONY_APP_ID: '1' } })).toBeUndefined(); // incomplete App identity
  });

  it('with a static GH_TOKEN: GETs the PR with a bearer token and maps the result', async () => {
    const fetchImpl = vi.fn(async () => json({ merged: true, state: 'closed' }));
    const read = createGithubPrMergeStateReader({ env: { GH_TOKEN: 'tok' }, fetchImpl: fetchImpl as any })!;
    expect(await read(PR)).toBe('merged');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/ycomplex/harmony-plugin/pulls/42');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('with the harmony-daemon App identity: mints an installation token once (cached) then reads', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/access_tokens')
        ? json({ token: 'inst-tok', expires_at: new Date(Date.now() + 3600_000).toISOString() })
        : json({ merged: false, state: 'open' }),
    );
    const read = createGithubPrMergeStateReader({
      env: { HARMONY_APP_ID: '7', HARMONY_APP_INSTALLATION_ID: '99', HARMONY_APP_PRIVATE_KEY_PATH: '/k.pem' },
      fetchImpl: fetchImpl as any,
      readFile: () => pem,
    })!;
    expect(await read(PR)).toBe('open');
    expect(await read(PR)).toBe('open');
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls.filter((u) => u.includes('/access_tokens'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/pulls/42'))).toHaveLength(2);
  });

  it('B-1173: reads with an App identity whose key is INLINE (no key file in the pod)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/access_tokens') ? json({ token: 'inst-tok', expires_at: new Date(Date.now() + 3600_000).toISOString() }) : json({ merged: true, state: 'closed' }),
    );
    const read = createGithubPrMergeStateReader({
      env: { HARMONY_APP_ID: '7', HARMONY_APP_INSTALLATION_ID: '99', HARMONY_APP_PRIVATE_KEY: pem },
      fetchImpl: fetchImpl as any,
      readFile: () => { throw new Error('must not read a key file'); },
    })!;
    expect(await read(PR)).toBe('merged');
  });

  it('every failure is unknown, never a throw', async () => {
    const bad = createGithubPrMergeStateReader({ env: { GH_TOKEN: 't' }, fetchImpl: (async () => json({}, false)) as any })!;
    expect(await bad(PR)).toBe('unknown');
    const boom = createGithubPrMergeStateReader({ env: { GH_TOKEN: 't' }, fetchImpl: (async () => { throw new Error('net'); }) as any })!;
    expect(await boom(PR)).toBe('unknown');
    expect(await boom('https://example.com/nope')).toBe('unknown');
  });
});

describe('findReleaseAccept (B-1073 — finish-work O1 step 3 evidence rule)', () => {
  const built = (t: string) => ({ type: 'event', timestamp: t, event_type: 'field_change', field_name: 'workflow_state', new_value: 'Built' });
  const accept = (t: string, over: Record<string, unknown> = {}) => ({
    type: 'event', timestamp: t, event_type: 'brief_resolved',
    metadata: { reason: 'release-decision-pending', command: 'accept', brief_id: 'b1', ...over },
  });
  it('finds an accept after the latest Built', () => {
    expect(findReleaseAccept([built('1'), accept('2')])).toEqual({ timestamp: '2', brief_id: 'b1' });
  });
  it('no Built entry at all => null (fail closed)', () => {
    expect(findReleaseAccept([accept('2')])).toBeNull();
  });
  it('an accept before the latest Built is a previous cycle => null', () => {
    expect(findReleaseAccept([built('1'), accept('2'), built('3')])).toBeNull();
  });
  it('wrong reason / defer / non-event are not accepts', () => {
    expect(findReleaseAccept([built('1'), accept('2', { reason: 'plan-draft' })])).toBeNull();
    expect(findReleaseAccept([built('1'), accept('2', { command: 'defer' })])).toBeNull();
    expect(findReleaseAccept([built('1'), { type: 'comment', timestamp: '2' }])).toBeNull();
  });
});
