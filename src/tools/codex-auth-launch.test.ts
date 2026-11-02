import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
const read = (path: string) => readFileSync(path, 'utf8');
describe('inert token-only deployment', () => {
  it('does nothing without the explicit flag, even with inaccessible credential paths', () => {
    const result = spawnSync('bash', ['-c', '. container/codex-token-launch.sh; codex_token_context; echo "$CODEX_TOKEN_ONLY"'], {
      env: { PATH: process.env.PATH, CODEX_RUN: '1', CODEX_PROVIDER: 'openai' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('0');
  });
  it('enables only the OpenAI Codex path with an exact access-only resource name', () => {
    for (const [provider, resource, status, output] of [
      ['openai', 'projects/fixture/secrets/harmony-codex-access', 0, '1'],
      ['openrouter', '', 0, '0'], ['openai', 'projects/fixture/secrets/harmony-codex-auth', 1, ''],
    ] as const) {
      const result = spawnSync('bash', ['-c', '. container/codex-token-launch.sh; codex_token_context; echo "$CODEX_TOKEN_ONLY"'], {
        env: { PATH: process.env.PATH, CODEX_RUN: '1', CODEX_PROVIDER: provider, HARMONY_CODEX_TOKEN_ONLY: '1', HARMONY_CODEX_ACCESS_RESOURCE: resource }, encoding: 'utf8',
      });
      expect(result.status).toBe(status); expect(result.stdout.trim()).toBe(output);
    }
  });
  it('all launchers deliver the switch and resource and provisioning starts the updater before render', () => {
    for (const path of ['container/cloud-worker-launch.sh', 'container/docker-host-worker-launch.sh', 'container/gke/gke-worker-launch.sh']) {
      const source = read(path);
      expect(source).toContain('codex_token_context');
      expect(source).toContain('HARMONY_CODEX_TOKEN_ONLY');
      expect(source).toContain('HARMONY_CODEX_ACCESS_RESOURCE');
      expect(spawnSync('bash', ['-n', path]).status).toBe(0);
    }
    const source = read('container/provision.sh');
    expect(source.indexOf('codex-auth.js" worker --once')).toBeLessThan(source.indexOf('agent render --plugin-dir'));
    expect(source).toContain('codex-auth.js" worker --watch');
    expect(source).toContain('codex-auth.js" check-output');
    expect(spawnSync('bash', ['-n', 'container/provision.sh']).status).toBe(0);
  });
  it('CronJob is suspended, never retries, and has no full-login secret mount', () => {
    const docs = parseAllDocuments(read('container/codex-auth/refresh-cronjob.yaml')).map(d => d.toJSON());
    const cron = docs.find(d => d.kind === 'CronJob');
    expect(cron.spec.suspend).toBe(true); expect(cron.spec.concurrencyPolicy).toBe('Forbid');
    expect(cron.spec.jobTemplate.spec.backoffLimit).toBe(0);
    expect(cron.spec.jobTemplate.spec.template.spec.volumes).toEqual([{ name: 'owner', persistentVolumeClaim: { claimName: 'harmony-codex-refresh' } }]);
    expect(read('container/codex-auth/refresh-rbac.yaml')).not.toContain('resources: [secrets]');
  });
});
