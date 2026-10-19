// Render the gke profile's per-ticket PVC or per-leg Job as JSON (kubectl reads JSON as well as YAML).
// Inputs arrive as environment variables from gke-worker-launch.sh; no secret value passes through
// here — the Job only NAMES its secrets.
import { pathToFileURL } from 'node:url';

const WORKER_UID_GID = '1001:1001';
const INIT_MOUNT = '/ticket';

// The ONE table of what lives on a ticket's disk. Each entry is a subPath of the ticket volume
// (subPath = name) mounted into the worker container. workerOwned entries are prepared by the init
// container (mkdir + non-recursive chown); docker stays root's (dockerd runs as root).
// Session transcripts are NOT on the disk (B-1169): they live in a GCS bucket mounted through the
// Cloud Storage FUSE CSI driver, same <ticket>/<conduction>/{projects,logs} layout as Cloud Run.
export const LEG_DISK_MOUNTS = [
  { name: 'docker', mountPath: '/var/lib/docker', workerOwned: false },
  { name: 'playwright', mountPath: '/home/worker/.cache/ms-playwright', workerOwned: true },
];

const DEFAULT_TRANSCRIPT_BUCKET = 'harmony-conductor-transcripts';
const DEFAULT_SERVICE_ACCOUNT = 'harmony-leg';
const DEFAULT_TROOT = '/mnt/harmony-transcripts';
// uid/gid 1001 = the worker user; implicit-dirs so resume sees folders Cloud Run legs wrote as bare prefixes.
const GCSFUSE_MOUNT_OPTIONS = 'implicit-dirs,uid=1001,gid=1001,file-mode=664,dir-mode=775';

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
  const table = LEG_DISK_MOUNTS;
  const troot = e.TROOT || DEFAULT_TROOT;
  const mounts = table.map((m) => ({ name: 'ticket', mountPath: m.mountPath, subPath: m.name }));
  mounts.push({ name: 'transcripts', mountPath: troot });
  const volumes = [
    { name: 'ticket', persistentVolumeClaim: { claimName: e.PVC_NAME } },
    {
      name: 'transcripts',
      csi: {
        driver: 'gcsfuse.csi.storage.gke.io',
        volumeAttributes: { bucketName: e.TRANSCRIPT_BUCKET || DEFAULT_TRANSCRIPT_BUCKET, mountOptions: GCSFUSE_MOUNT_OPTIONS },
      },
    },
  ];
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
        metadata: {
          labels: legLabels,
          annotations: {
            'gke-gcsfuse/volumes': 'true',
            'gke-gcsfuse/cpu-request': '250m',
            'gke-gcsfuse/memory-request': '256Mi',
            'gke-gcsfuse/ephemeral-storage-request': '1Gi',
          },
        },
        spec: {
          serviceAccountName: e.SERVICE_ACCOUNT || DEFAULT_SERVICE_ACCOUNT,
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
