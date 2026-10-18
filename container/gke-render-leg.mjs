// B-1060 SPIKE: render the gke profile's per-ticket PVC or per-leg Job as JSON (kubectl reads
// JSON as well as YAML). Inputs arrive as environment variables from gke-worker-launch.sh; no
// secret value passes through here — the Job only NAMES its secrets.
const e = process.env;

const labels = { 'harmony-ticket': e.TICKET.replace(/[^A-Za-z0-9._-]/g, '-'), 'app.kubernetes.io/part-of': 'harmony-legs' };

if (e.WHAT === 'pvc') {
  process.stdout.write(JSON.stringify({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: e.PVC_NAME, labels },
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: e.SC, resources: { requests: { storage: e.DISK } } },
  }));
  process.exit(0);
}

const legLabels = { ...labels, 'conduction-id': e.CONDUCTION_ID };
const mounts = [
  { name: 'ticket', mountPath: '/var/lib/docker', subPath: 'docker' },
  { name: 'ticket', mountPath: e.TROOT, subPath: 'transcripts' },
];
const volumes = [{ name: 'ticket', persistentVolumeClaim: { claimName: e.PVC_NAME } }];
if (e.CODEX_RUN === '1') {
  mounts.push({ name: 'codex-auth', mountPath: e.CODEX_DIR, readOnly: true });
  volumes.push({ name: 'codex-auth', secret: { secretName: e.CODEX_SECRET } });
}

process.stdout.write(JSON.stringify({
  apiVersion: 'batch/v1', kind: 'Job',
  metadata: { name: e.JOB_NAME, labels: legLabels },
  spec: {
    backoffLimit: 0,                       // the daemon's retry ladder owns retries
    activeDeadlineSeconds: Number(e.DEADLINE),
    ttlSecondsAfterFinished: 3600,
    template: {
      metadata: { labels: legLabels },
      spec: {
        restartPolicy: 'Never',
        nodeSelector: { 'harmony-leg': 'true' },
        tolerations: [{ key: 'harmony-leg', operator: 'Equal', value: 'true', effect: 'NoSchedule' }],
        initContainers: [{
          // subPath directories are created root-owned; the worker (uid 1001) must own its
          // transcript tree. The engine's tree stays root's (dockerd runs as root).
          name: 'ticket-dirs', image: e.IMAGE, securityContext: { runAsUser: 0 },
          command: ['sh', '-c', `chown 1001:1001 ${e.TROOT}`],
          volumeMounts: [{ name: 'ticket', mountPath: e.TROOT, subPath: 'transcripts' }],
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
}));
