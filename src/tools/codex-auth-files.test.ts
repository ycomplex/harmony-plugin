import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { atomicPrivateJson, claimRefresh } from './codex-auth-files.js';
import { codexLoginFailure } from './codex-auth.js';

describe('private credential publication', () => {
  it('parallel readers see complete generations and permissions stay private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-fixture-'));
    try {
      const file = join(dir, 'auth.json');
      await atomicPrivateJson(file, { generation: 1, fixture: 'a'.repeat(2000) });
      const observations = await Promise.all([
        atomicPrivateJson(file, { generation: 2, fixture: 'b'.repeat(2000) }),
        ...Array.from({ length: 30 }, async () => JSON.parse(await readFile(file, 'utf8'))),
      ]);
      for (const value of observations.slice(1)) expect([1, 2]).toContain(value.generation);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      // An interrupted staged write cannot replace the last installed complete generation.
      await writeFile(`${file}.interrupted.next`, '{');
      expect(JSON.parse(await readFile(file, 'utf8')).generation).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('durably excludes concurrent and replacement owners until explicit founder recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-owner-fixture-'));
    try {
      const marker = join(dir, 'in-flight');
      expect((await Promise.all([claimRefresh(marker), claimRefresh(marker)])).sort()).toEqual([false, true]);
      expect(await claimRefresh(marker)).toBe(false);
      expect(await readFile(marker, 'utf8')).toBe('refresh attempt claimed\n');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('recognizes only explicit structured login errors, without returning their contents', () => {
    expect(codexLoginFailure(JSON.stringify({ type: 'error', message: 'token_expired fixture-sensitive' }))).toBe('codex-login-expired');
    expect(codexLoginFailure(JSON.stringify({ type: 'turn.failed', error: { message: 'refresh token already used fixture-sensitive' } }))).toBe('codex-login-expired');
    for (const message of ['HTTP401', 'quota exhausted', 'rate limit', 'network timeout', 'application network policy is unavailable']) {
      expect(codexLoginFailure(JSON.stringify({ type: 'error', message }))).toBeNull();
    }
    expect(codexLoginFailure(JSON.stringify({ type: 'item.completed', message: 'token_expired' }))).toBeNull();
    expect(codexLoginFailure('')).toBeNull();
  });
});
