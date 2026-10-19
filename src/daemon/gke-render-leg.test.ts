// B-1161: the gke Job/PVC renderer (container/gke/gke-render-leg.mjs), imported as a pure function.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs with no type declarations
import { renderLeg, LEG_DISK_MOUNTS } from '../../container/gke/gke-render-leg.mjs';

const SCRIPT = fileURLToPath(new URL('../../container/gke/gke-render-leg.mjs', import.meta.url));

const baseEnv = (over: Record<string, string> = {}) => ({
  WHAT: 'job', PVC_NAME: 'ticket-b-1161', JOB_NAME: 'leg-abcd1234-1', LEG_SECRET: 'leg-abcd1234-1-env', TICKET: 'B-1161',
  CONDUCTION_ID: 'cid-1', IMAGE: 'reg/img:latest', CPU: '6', MEM: '20Gi', DISK: '100Gi', SC: 'standard-rwo', DEADLINE: '5400',
  JOB_TTL_S: '3600', BASE_SECRET: 'harmony-worker-secrets', CODEX_RUN: '0', CODEX_SECRET: 'harmony-codex-auth',
  CODEX_DIR: '/home/worker/.codex-auth-src', TROOT: '/mnt/harmony-transcripts',
  TRANSCRIPT_BUCKET: 'harmony-conductor-transcripts', SERVICE_ACCOUNT: 'harmony-leg', ...over,
});
const job = (over: Record<string, string> = {}): any => renderLeg(baseEnv(over));
const podSpec = (over: Record<string, string> = {}): any => job(over).spec.template.spec;

describe('LEG_DISK_MOUNTS', () => {
  it('has exactly docker and playwright (transcripts live in the bucket, B-1169)', () => {
    expect(LEG_DISK_MOUNTS).toEqual([
      { name: 'docker', mountPath: '/var/lib/docker', workerOwned: false },
      { name: 'playwright', mountPath: '/home/worker/.cache/ms-playwright', workerOwned: true },
    ]);
  });

  it('generates the worker volumeMounts: same PVC volume, subPath = entry name', () => {
    const mounts = podSpec().containers[0].volumeMounts;
    const ticketMounts = mounts.filter((m: { name: string }) => m.name === 'ticket');
    expect(ticketMounts).toEqual(LEG_DISK_MOUNTS.map((m: { name: string; mountPath: string }) => ({ name: 'ticket', mountPath: m.mountPath, subPath: m.name })));
    expect(mounts.some((m: { subPath?: string }) => m.subPath === 'transcripts')).toBe(false);
    expect(podSpec().volumes[0]).toEqual({ name: 'ticket', persistentVolumeClaim: { claimName: 'ticket-b-1161' } });
  });
});

describe('the transcript bucket mount (B-1169)', () => {
  const tvol = (over: Record<string, string> = {}) => podSpec(over).volumes.find((v: { name: string }) => v.name === 'transcripts');

  it('is a Cloud Storage FUSE CSI volume on the bucket with implicit-dirs and the worker uid/gid', () => {
    const v = tvol();
    expect(v.csi.driver).toBe('gcsfuse.csi.storage.gke.io');
    expect(v.csi.volumeAttributes.bucketName).toBe('harmony-conductor-transcripts');
    const opts = v.csi.volumeAttributes.mountOptions.split(',');
    expect(opts).toEqual(expect.arrayContaining(['implicit-dirs', 'uid=1001', 'gid=1001']));
  });

  it('honours TRANSCRIPT_BUCKET and defaults when unset', () => {
    expect(tvol({ TRANSCRIPT_BUCKET: 'other-bucket' }).csi.volumeAttributes.bucketName).toBe('other-bucket');
    expect(tvol({ TRANSCRIPT_BUCKET: '' }).csi.volumeAttributes.bucketName).toBe('harmony-conductor-transcripts');
  });

  it('is mounted into the worker at TROOT, with no subPath', () => {
    expect(podSpec().containers[0].volumeMounts).toContainEqual({ name: 'transcripts', mountPath: '/mnt/harmony-transcripts' });
    expect(podSpec({ TROOT: '/mnt/elsewhere' }).containers[0].volumeMounts).toContainEqual({ name: 'transcripts', mountPath: '/mnt/elsewhere' });
  });

  it('annotates the pod for the gcsfuse sidecar', () => {
    const a = job().spec.template.metadata.annotations;
    expect(a['gke-gcsfuse/volumes']).toBe('true');
    expect(a['gke-gcsfuse/cpu-request']).toBe('250m');
    expect(a['gke-gcsfuse/memory-request']).toBe('256Mi');
  });

  it('runs as the service account, defaulting to harmony-leg', () => {
    expect(podSpec().serviceAccountName).toBe('harmony-leg');
    expect(podSpec({ SERVICE_ACCOUNT: 'custom-ksa' }).serviceAccountName).toBe('custom-ksa');
    expect(podSpec({ SERVICE_ACCOUNT: '' }).serviceAccountName).toBe('harmony-leg');
  });
});

describe('the rendered Job', () => {
  it('has no fsGroup and no fsGroupChangePolicy anywhere', () => {
    for (const codex of ['0', '1']) {
      const s = JSON.stringify(job({ CODEX_RUN: codex }));
      expect(s).not.toContain('fsGroup');
      expect(s).not.toContain('fsGroupChangePolicy');
    }
  });

  it('the init container mounts the whole volume at /ticket and prepares exactly the worker-owned dirs, non-recursively, never docker', () => {
    const init = podSpec().initContainers[0];
    expect(init.image).toBe('reg/img:latest');
    expect(init.securityContext).toEqual({ runAsUser: 0 });
    expect(init.volumeMounts).toEqual([{ name: 'ticket', mountPath: '/ticket' }]);
    const cmd = init.command.join(' ');
    expect(cmd).toContain('mkdir -p /ticket/playwright');
    expect(cmd).toContain('chown 1001:1001 /ticket/playwright');
    expect(cmd).not.toContain('transcripts');
    expect(cmd).not.toContain('docker');
    expect(cmd).not.toMatch(/\s-R\b|--recursive/);
  });

  it('requests cpu/memory from the knobs; defaults the launch passes are 6 / 20Gi', () => {
    expect(podSpec().containers[0].resources.requests).toEqual({ cpu: '6', memory: '20Gi' });
    expect(podSpec({ CPU: '3', MEM: '8Gi' }).containers[0].resources.requests).toEqual({ cpu: '3', memory: '8Gi' });
  });

  it('ttl, backoff, deadline, restart policy, node pool and privileged worker', () => {
    const j = job({ JOB_TTL_S: '120' });
    expect(j.spec.ttlSecondsAfterFinished).toBe(120);
    expect(j.spec.backoffLimit).toBe(0);
    expect(j.spec.activeDeadlineSeconds).toBe(5400);
    const p = j.spec.template.spec;
    expect(p.restartPolicy).toBe('Never');
    expect(p.nodeSelector).toEqual({ 'harmony-leg': 'true' });
    expect(p.tolerations).toEqual([{ key: 'harmony-leg', operator: 'Equal', value: 'true', effect: 'NoSchedule' }]);
    expect(p.containers[0].securityContext).toEqual({ privileged: true });
  });

  it('args, envFrom and labels', () => {
    const j = job();
    const w = j.spec.template.spec.containers[0];
    expect(w.args).toEqual(['headless', '/harmony-plugin:harmony-conduct B-1161 --one-shot']);
    expect(w.envFrom).toEqual([{ secretRef: { name: 'harmony-worker-secrets' } }, { secretRef: { name: 'leg-abcd1234-1-env' } }]);
    expect(j.metadata.labels['conduction-id']).toBe('cid-1');
    expect(j.spec.template.metadata.labels['conduction-id']).toBe('cid-1');
  });

  it('mounts the Codex secret read-only only when CODEX_RUN=1', () => {
    expect(JSON.stringify(job())).not.toContain('codex-auth');
    const p = podSpec({ CODEX_RUN: '1' });
    expect(p.containers[0].volumeMounts).toContainEqual({ name: 'codex-auth', mountPath: '/home/worker/.codex-auth-src', readOnly: true });
    expect(p.volumes).toContainEqual({ name: 'codex-auth', secret: { secretName: 'harmony-codex-auth' } });
  });
});

describe('the rendered PVC and the CLI entry', () => {
  it('renders a ReadWriteOnce claim', () => {
    const pvc = renderLeg(baseEnv({ WHAT: 'pvc' }));
    expect(pvc.kind).toBe('PersistentVolumeClaim');
    expect(pvc.metadata.name).toBe('ticket-b-1161');
    expect(pvc.spec).toEqual({ accessModes: ['ReadWriteOnce'], storageClassName: 'standard-rwo', resources: { requests: { storage: '100Gi' } } });
  });

  it('the CLI prints the same JSON when invoked directly', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: baseEnv() });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(job());
  });
});
