// Render the gke profile's per-ticket PVC or per-leg Job as JSON (kubectl reads JSON as well as YAML).
// Inputs arrive as environment variables from gke-worker-launch.sh; no secret value passes through
// here — the Job only NAMES its secrets.
import { pathToFileURL } from 'node:url';

const WORKER_UID_GID = '1001:1001';
const INIT_MOUNT = '/ticket';

// The ONE table of what lives on a ticket's disk. Each entry is a subPath of the ticket volume
// (subPath = name) mounted into the worker container. workerOwned entries are prepared by the init
// container (mkdir + non-recursive chown); docker stays root's (dockerd runs as root).
export const LEG_DISK_MOUNTS = [
  { name: 'docker', mountPath: '/var/lib/docker', workerOwned: false },
  { name: 'transcripts', mountPath: '/mnt/harmony-transcripts', workerOwned: true },
  { name: 'playwright', mountPath: '/home/worker/.cache/ms-playwright', workerOwned: true },
];

function mountsFor(e) {
  return LEG_DISK_MOUNTS.map((m) => (m.name === 'transcripts' && e.TROOT ? { ...m, mountPath: e.TROOT } : m));
}

export function renderLeg(e) {
  const labels = { 'harmony-ticket': e.TICKET.replace(/[^A-Za-z0-9._-]/g, '-'), 'app.kubernetes.io/part-of': 'harmony-legs' };

  if (e.WHAT === 'pvc') {
    return {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: e.PVC_NAME, labels },
      spec: { accessModes: ['ReadWriteOnce'], storageClassName: e.SC, resources: { requests: { storage: e.DISK } } },
    };
  }

  const legLabels = { ...labels, 'conduction-id': e.CONDUCTION_ID };
  const table = mountsFor(e);
  const mounts = table.map((m) => ({ name: 'ticket', mountPath: m.mountPath, subPath: m.name }));
  const volumes = [{ name: 'ticket', persistentVolumeClaim: { claimName: e.PVC_NAME } }];
  if (e.CODEX_RUN === '1') {
    mounts.push({ name: 'codex-auth', mountPath: e.CODEX_DIR, readOnly: true });
    volumes.push({ name: 'codex-auth', secret: { secretName: e.CODEX_SECRET } });
  }

  // No fsGroup anywhere: it would walk the whole disk, including /var/lib/docker layer trees, and
  // rewrite permissions inside nested images. Ownership is set once, non-recursively, by the init container.
  const owned = table.filter((m) => m.workerOwned).map((m) => `${INIT_MOUNT}/${m.name}`);
  const initCommand = `mkdir -p ${owned.join(' ')} && chown ${WORKER_UID_GID} ${owned.join(' ')}`;

  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: e.JOB_NAME, labels: legLabels },
    spec: {
      backoffLimit: 0, // the daemon's retry ladder owns retries
      activeDeadlineSeconds: Number(e.DEADLINE),
      ttlSecondsAfterFinished: Number(e.JOB_TTL_S),
      template: {
        metadata: { labels: legLabels },
        spec: {
          restartPolicy: 'Never',
          nodeSelector: { 'harmony-leg': 'true' },
          tolerations: [{ key: 'harmony-leg', operator: 'Equal', value: 'true', effect: 'NoSchedule' }],
          initContainers: [{
            name: 'ticket-dirs', image: e.IMAGE, securityContext: { runAsUser: 0 },
            command: ['sh', '-c', initCommand],
            volumeMounts: [{ name: 'ticket', mountPath: INIT_MOUNT }],
          }],
          containers: [{
            name: 'worker', image: e.IMAGE,
            args: ['headless', `/harmony-plugin:harmony-conduct ${e.TICKET} --one-shot`],
            securityContext: { privileged: true },
            resources: { requests: { cpu: e.CPU, memory: e.MEM } },
            envFrom: [{ secretRef: { name: e.BASE_SECRET } }, { secretRef: { name: e.LEG_SECRET } }],
            volumeMounts: mounts,
          }],
          volumes,
        },
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(renderLeg(process.env)));
}
