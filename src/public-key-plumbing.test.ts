import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { CODEX_MCP_ENV_VARS } from './agents/codex.js';
import { redact } from './daemon/conductor-logger.js';
const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('public key deployment compatibility', () => {
  it('passes the new name to Codex MCP and redacts it from conductor diagnostics', () => {
    expect(CODEX_MCP_ENV_VARS).toContain('HARMONY_SUPABASE_PUBLISHABLE_KEY');
    expect(redact('diagnostic synthetic-public-key-value', {
      HARMONY_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key-value',
    })).not.toContain('synthetic-public-key-value');
  });
  it('keeps both Figma jobs compatible with old secrets and optional new bindings', () => {
    const jobs = parseAllDocuments(read('container/figma/refresh-cronjob.yaml'))
      .map(doc => doc.toJSON()).filter(doc => doc.kind === 'CronJob');
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const env = job.spec.jobTemplate.spec.template.spec.containers[0].env;
      expect(env.find((entry: { name: string }) => entry.name === 'HARMONY_SUPABASE_ANON_KEY').valueFrom.secretKeyRef)
        .toMatchObject({ key: 'anon-key', optional: true });
      expect(env.find((entry: { name: string }) => entry.name === 'HARMONY_SUPABASE_PUBLISHABLE_KEY').valueFrom.secretKeyRef)
        .toMatchObject({ key: 'publishable-key', optional: true });
    }
  });
  const source = read('container/provision.sh');
  const start = source.indexOf('# Refuse conflicting aliases');
  const end = source.indexOf('# --- Wire the run directory', start);
  const guard = source.slice(start, end);
  it.each([
    { HARMONY_TARGET: 'prod' },
    { HARMONY_TARGET: 'staging', HARMONY_SUPABASE_ANON_KEY: 'synthetic-legacy' },
    { HARMONY_TARGET: 'staging', HARMONY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic' },
    { HARMONY_TARGET: 'custom', HARMONY_SUPABASE_ANON_KEY: 'same', HARMONY_SUPABASE_PUBLISHABLE_KEY: 'same' },
  ])('accepts fresh-worker key validation without external setup: %j', env => {
    expect(() => execFileSync('bash', ['-eu', '-c', guard], { env: { PS1: 'test', ...env } })).not.toThrow();
  });
  it('refuses a missing non-prod key and conflicts with names-only errors', () => {
    for (const env of [{ HARMONY_TARGET: 'staging' }, { HARMONY_TARGET: 'prod',
      HARMONY_SUPABASE_ANON_KEY: 'synthetic-old', HARMONY_SUPABASE_PUBLISHABLE_KEY: 'synthetic-new' }]) {
      const result = spawnSync('bash', ['-eu', '-c', guard], { env: { PS1: 'test', ...env }, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('HARMONY_SUPABASE_PUBLISHABLE_KEY');
      expect(result.stderr).not.toContain('synthetic-old');
      expect(result.stderr).not.toContain('synthetic-new');
    }
  });
});
