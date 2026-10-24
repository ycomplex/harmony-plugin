import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const parser = fileURLToPath(new URL('../../container/gke/gke-startup-status.mjs', import.meta.url));
const pending = { items: [{ metadata: { uid: 'pod' }, status: { phase: 'Pending' } }] };
const pvc = { metadata: { uid: 'disk' }, status: { phase: 'Pending' } };
const event = (uid: string, reason: string) => ({ involvedObject: { uid }, reason, lastTimestamp: '2026-10-24T08:00:00Z' });
const progress = (pods: unknown, events: unknown) => execFileSync('node', [parser, 'progress'], {
  input: [pods, events, pvc].map(v => JSON.stringify(v)).join('\x1c'), encoding: 'utf8',
}).trim();

describe('GKE cold-start progress evidence', () => {
  it.each(['TriggeredScaleUp', 'Pulling', 'Pulled'])('recognizes current pod %s, excludes other Jobs', reason => {
    expect(progress(pending, { items: [event('pod', reason)] })).toContain(reason);
    expect(progress(pending, { items: [event('old-pod', reason)] })).toBe('');
  });
  it('PVC failure overrides cold-start progress', () => {
    expect(progress(pending, { items: [event('pod', 'Pulling'), event('disk', 'ProvisioningFailed')] })).toBe('');
  });
  it('image backoff overrides historical pull progress', () => {
    const pods = { items: [{ metadata: { uid: 'pod' }, status: { containerStatuses: [
      { name: 'worker', state: { waiting: { reason: 'ImagePullBackOff' } } },
    ] } }] };
    expect(progress(pods, { items: [event('pod', 'Pulling')] })).toBe('');
  });
  it('reports failed reads separately from absent objects', () => {
    const text = execFileSync('node', [parser, 'diagnose'], {
      input: [{ readError: 'connect localhost:8080 refused' }, pvc, { readError: 'Forbidden' }].map(v => JSON.stringify(v)).join('\x1c'), encoding: 'utf8',
    });
    expect(text).toContain('pod read failed: connect localhost:8080 refused');
    expect(text).toContain('events read failed: Forbidden');
    expect(text).toContain('PVC Pending');
  });
});
