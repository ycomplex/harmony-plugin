// B-1337: the Figma refresh image's committed files — the per-channel Cloud Build file, the Dockerfile labels, the
// smoke script, both CronJobs and the narrow repin RBAC. No Docker, registry or cluster is used: this pins the step
// ordering and file shapes, and runs the build steps' own shell (after Cloud Build-style substitution) against a temp
// dir with fake docker / gcloud / kubectl binaries so the channel, version, digest and read-back guards really behave.
// A real build, smoke, push and repin run on Cloud Build.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const repo = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(repo(rel), 'utf8');

interface Step {
  id: string;
  name: string;
  args?: string[];
}
const build = parse(read('container/figma/cloudbuild.yaml')) as {
  substitutions: Record<string, string>;
  steps: Step[];
};
const stepText = (s: Step): string => (s.args ?? []).join('\n');
const ids = build.steps.map((s) => s.id);
const step = (id: string): Step => build.steps[ids.indexOf(id)]!;
const IMAGE = 'us-central1-docker.pkg.dev/harmony-conductor/harmony-workers/harmony-figma-refresh';

// Cloud Build substitution: `$$` is a literal `$`; `${_X}` / `${BUILTIN}` take their values. One pass, like the real one.
const substitute = (script: string, subs: Record<string, string>, workspace: string): string =>
  script
    .replace(/\$\$|\$\{(\w+)\}/g, (m, name: string | undefined) => {
      if (m === '$$') return '$';
      if (!(name! in subs)) throw new Error(`unknown substitution ${name}`);
      return subs[name!]!;
    })
    .split('/workspace/')
    .join(`${workspace}/`);

const runStep = (
  id: string,
  opts: { channel?: string; version?: string; files?: Record<string, string>; bins?: Record<string, string> } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'b1337-step-'));
  const ws = join(dir, 'workspace');
  const bin = join(dir, 'bin');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(ws);
  mkdirSync(bin);
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ version: opts.version ?? '0.16.60' }));
  for (const [f, v] of Object.entries(opts.files ?? {})) writeFileSync(join(ws, f), v);
  for (const [b, v] of Object.entries(opts.bins ?? {})) {
    writeFileSync(join(bin, b), `#!/usr/bin/env bash\n${v}\n`);
    chmodSync(join(bin, b), 0o755);
  }
  const subs = {
    ...build.substitutions,
    _CHANNEL: opts.channel ?? 'staging',
    COMMIT_SHA: 'abc123',
    PROJECT_ID: 'harmony-conductor',
  };
  const script = substitute(stepText(step(id)).replace(/^-c\n/, ''), subs, ws);
  const r = spawnSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: join(dir, 'calls.log') },
  });
  const out = (f: string): string | null => {
    try {
      return readFileSync(join(ws, f), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const calls = (): string => {
    try {
      return readFileSync(join(dir, 'calls.log'), 'utf8');
    } catch {
      return '';
    }
  };
  return { ...r, out, calls };
};

describe('container/figma/cloudbuild.yaml', () => {
  it('is a separate file with the refresh image default and the channel, cluster, zone and namespace substitutions', () => {
    expect(build.substitutions).toEqual({
      _IMAGE: IMAGE,
      _CHANNEL: 'staging',
      _CLUSTER: 'harmony-legs',
      _ZONE: 'us-central1-a',
      _NAMESPACE: 'harmony-conductor',
    });
    expect(read('container/cloudbuild.yaml')).not.toContain('harmony-figma-refresh');
    expect(read('container/conductor/cloudbuild.yaml')).not.toContain('harmony-figma-refresh');
  });

  it('runs its steps in exactly this order', () => {
    expect(ids).toEqual(['read-version', 'build', 'smoke', 'push-version', 'push-channel', 'resolve-digest', 'repin']);
  });

  it('smokes before any push, pushes the channel tag last, and repins only as the last step after both pushes', () => {
    const pushes = build.steps.map((s, i) => (/docker push/.test(stepText(s)) ? i : -1)).filter((i) => i >= 0);
    expect(pushes).toEqual([ids.indexOf('push-version'), ids.indexOf('push-channel')]);
    expect(ids.indexOf('smoke')).toBeLessThan(pushes[0]!);
    for (const s of build.steps.slice(0, ids.indexOf('smoke') + 1)) expect(stepText(s)).not.toMatch(/docker push/);
    const channelPush = build.steps.findIndex((s) => /docker push '\$\{_IMAGE\}:\$\{_CHANNEL\}'/.test(stepText(s)));
    expect(channelPush).toBe(pushes[pushes.length - 1]);
    expect(ids.indexOf('repin')).toBe(ids.length - 1);
    expect(ids.indexOf('repin')).toBeGreaterThan(channelPush);
    // no other step touches the cluster
    for (const s of build.steps.slice(0, -1)) expect(stepText(s)).not.toMatch(/kubectl/);
    expect(stepText(step('build'))).not.toContain('${_CHANNEL}');
  });

  it('builds the figma Dockerfile with the version and source-commit build-args, and smokes the candidate', () => {
    const b = stepText(step('build'));
    expect(b).toContain('-f container/figma/Dockerfile');
    expect(b).toContain('--build-arg PLUGIN_VERSION="$(cat /workspace/plugin_version.txt)"');
    expect(b).toContain("--build-arg SOURCE_COMMIT='${COMMIT_SHA}'");
    expect(b).toContain("-t '${_IMAGE}:candidate' .");
    expect(stepText(step('smoke'))).toContain(`bash container/figma/smoke.sh '\${_IMAGE}:candidate' "$(cat /workspace/plugin_version.txt)"`);
    expect(stepText(step('push-version'))).toContain('docker push "${_IMAGE}:$(cat /workspace/plugin_version.txt)-${_CHANNEL}"');
  });

  it('repin uses `set image cronjob/` on the refresh container and reads the image back', () => {
    const r = stepText(step('repin'));
    expect(step('repin').name).toBe('gcr.io/cloud-builders/kubectl');
    expect(r).toContain("gcloud container clusters get-credentials '${_CLUSTER}' --zone '${_ZONE}'");
    expect(r).toMatch(/kubectl -n '\$\{_NAMESPACE\}' set image "cronjob\/\$\$cronjob" "refresh=\$\$pinned"/);
    expect(r).toContain("-o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}'");
    expect(r).toContain('docs/figma-connection-rollout.md');
  });

  describe('read-version, executed', () => {
    it('maps staging to harmony-figma-refresh and prod to harmony-figma-refresh-prod', () => {
      const s = runStep('read-version', { channel: 'staging' });
      expect(s.status, s.stderr).toBe(0);
      expect(s.out('plugin_version.txt')).toBe('0.16.60');
      expect(s.out('cronjob_name.txt')).toBe('harmony-figma-refresh');
      const p = runStep('read-version', { channel: 'prod' });
      expect(p.status, p.stderr).toBe(0);
      expect(p.out('cronjob_name.txt')).toBe('harmony-figma-refresh-prod');
    });

    it.each(['main', 'Prod', '', 'staging;prod'])('rejects channel %j', (channel) => {
      const r = runStep('read-version', { channel });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('_CHANNEL must be staging or prod');
      expect(r.out('cronjob_name.txt')).toBeNull();
    });

    it('refuses main\'s inert 0.0.0-dev', () => {
      const r = runStep('read-version', { version: '0.0.0-dev' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('not main');
      expect(r.out('plugin_version.txt')).toBeNull();
    });
  });

  describe('resolve-digest, executed against a fake docker', () => {
    const hex = 'a'.repeat(64);
    const files = { 'plugin_version.txt': '0.16.60\n' };
    const docker = (digests: string[]) =>
      `[ "$1" = inspect ] || exit 9\n[ "\${@: -1}" = "${IMAGE}:0.16.60-staging" ] || exit 8\nprintf '%s\\n' ${digests.map((d) => `'${d}'`).join(' ')}`;

    it('picks the digest of this image repository', () => {
      const r = runStep('resolve-digest', {
        files,
        bins: { docker: docker([`other.example/x@sha256:${'b'.repeat(64)}`, `${IMAGE}@sha256:${hex}`]) },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.out('pinned_ref.txt')).toBe(`${IMAGE}@sha256:${hex}`);
    });

    it.each([[[] as string[]], [[`${IMAGE}@sha256:short`]], [[`other.example/x@sha256:${hex}`]]])('fails on %j', (digests) => {
      const r = runStep('resolve-digest', { files, bins: { docker: docker(digests) } });
      expect(r.status).not.toBe(0);
      expect(r.out('pinned_ref.txt')).toBeNull();
    });
  });

  describe('repin, executed against fake gcloud and kubectl', () => {
    const pinned = `${IMAGE}@sha256:${'c'.repeat(64)}`;
    const files = { 'cronjob_name.txt': 'harmony-figma-refresh-prod\n', 'pinned_ref.txt': `${pinned}\n` };
    const gcloud = 'echo "gcloud $*" >> "$FAKE_LOG"';
    const kubectl = (readBack: string, setFails = false) =>
      `echo "kubectl $*" >> "$FAKE_LOG"\ncase "$*" in *"set image"*) ${setFails ? 'echo \'Error from server (Forbidden): cronjobs.batch "x" is forbidden\'; exit 1' : 'echo updated'} ;; *"get cronjob"*) printf '%s' '${readBack}' ;; esac`;

    it('sets the image on the channel CronJob and passes when it reads back the pinned ref', () => {
      const r = runStep('repin', { files, bins: { gcloud, kubectl: kubectl(pinned) } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.calls()).toContain('gcloud container clusters get-credentials harmony-legs --zone us-central1-a --project harmony-conductor');
      expect(r.calls()).toContain(`kubectl -n harmony-conductor set image cronjob/harmony-figma-refresh-prod refresh=${pinned}`);
      expect(r.calls()).toContain('kubectl -n harmony-conductor get cronjob harmony-figma-refresh-prod -o jsonpath=');
    });

    it('fails when the read-back differs', () => {
      const r = runStep('repin', { files, bins: { gcloud, kubectl: kubectl(`${IMAGE}@sha256:${'d'.repeat(64)}`) } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('reads back');
    });

    it('names the founder step on a permission error', () => {
      const r = runStep('repin', { files, bins: { gcloud, kubectl: kubectl(pinned, true) } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('may not patch cronjob/harmony-figma-refresh-prod');
      expect(r.stderr).toContain('docs/figma-connection-rollout.md');
      expect(r.stderr).toContain('founder steps 2 and 4');
      expect(r.stderr).toContain('harmony-figma-refresh-build@harmony-conductor.iam.gserviceaccount.com');
    });
  });
});

describe('container/figma/Dockerfile', () => {
  const df = read('container/figma/Dockerfile');
  it('labels the final stage with the plugin version and source commit, and still runs non-root', () => {
    const final = df.slice(df.lastIndexOf('FROM '));
    expect(final).toContain('ARG PLUGIN_VERSION');
    expect(final).toContain('ARG SOURCE_COMMIT');
    expect(final).toContain('harmony.plugin_version="${PLUGIN_VERSION}"');
    expect(final).toContain('harmony.source_commit="${SOURCE_COMMIT}"');
    expect(final).toContain('USER node');
    expect(df).toContain('ENTRYPOINT ["node", "/app/dist/figma-refresh-runner.js"]');
  });
});

describe('container/figma/smoke.sh', () => {
  const s = read('container/figma/smoke.sh');
  it('passes bash -n and is executable', () => {
    expect(spawnSync('bash', ['-n', repo('container/figma/smoke.sh')], { encoding: 'utf8' }).status).toBe(0);
    expect(statSync(repo('container/figma/smoke.sh')).mode & 0o111).not.toBe(0);
  });

  it('checks the files, non-root user, label and the auth guard', () => {
    expect(s).toContain('/app/dist/figma-refresh-runner.js');
    expect(s).toContain('/app/dist/THIRD_PARTY_NOTICES');
    expect(s).toContain('harmony.plugin_version');
    expect(s).toContain('No active project. Run \\`harmony login\\` to add one.');
    expect(s).toContain('getAuthenticatedContext');
    expect(s).toContain('--network none');
    const header = s.slice(0, s.indexOf('set -euo pipefail'));
    expect(header).toContain('DEPTH ACHIEVED');
    expect(header).toContain('NOT proved');
  });

  it('does not assert any specific library-map version, so a map-version bump never fails the build', () => {
    expect(s).not.toContain('LIBRARY_MAP_VERSION');
  });
});

describe('container/figma/refresh-repin-rbac.yaml', () => {
  const docs = parseAllDocuments(read('container/figma/refresh-repin-rbac.yaml')).map((d) => d.toJS()) as {
    kind: string;
    metadata: { name: string; namespace?: string };
    rules?: { apiGroups: string[]; resources: string[]; resourceNames: string[]; verbs: string[] }[];
    roleRef?: { kind: string; name: string };
    subjects?: { kind: string; name: string }[];
  }[];

  it('is a namespaced Role and RoleBinding only, nothing cluster-wide', () => {
    expect(docs.map((d) => d.kind)).toEqual(['Role', 'RoleBinding']);
    for (const d of docs) expect(d.metadata.namespace).toBe('harmony-conductor');
    expect(read('container/figma/refresh-repin-rbac.yaml')).not.toMatch(/ClusterRole/);
  });

  it('grants exactly get and patch on the two refresh CronJobs', () => {
    const role = docs[0]!;
    expect(role.metadata.name).toBe('harmony-figma-refresh-repin');
    expect(role.rules).toEqual([
      {
        apiGroups: ['batch'],
        resources: ['cronjobs'],
        resourceNames: ['harmony-figma-refresh', 'harmony-figma-refresh-prod'],
        verbs: ['get', 'patch'],
      },
    ]);
  });

  it('binds it to the dedicated build service account as a User, never a default compute account', () => {
    const rb = docs[1]!;
    expect(rb.roleRef).toMatchObject({ kind: 'Role', name: 'harmony-figma-refresh-repin' });
    expect(rb.subjects).toEqual([
      expect.objectContaining({ kind: 'User', name: 'harmony-figma-refresh-build@harmony-conductor.iam.gserviceaccount.com' }),
    ]);
    for (const s of rb.subjects!) expect(s.name).not.toMatch(/-compute@developer\.gserviceaccount\.com$/);
    expect(read('container/figma/refresh-repin-rbac.yaml')).not.toContain('REPLACE_WITH');
  });
});

describe('container/figma/refresh-cronjob.yaml', () => {
  type CronJob = {
    kind: string;
    metadata: { name: string; namespace: string };
    spec: {
      suspend: boolean;
      jobTemplate: {
        spec: {
          template: {
            spec: {
              serviceAccountName: string;
              containers: { name: string; image: string; env: { name: string; valueFrom: { secretKeyRef: { name: string } } }[] }[];
            };
          };
        };
      };
    };
  };
  const docs = parseAllDocuments(read('container/figma/refresh-cronjob.yaml')).map((d) => d.toJS()) as CronJob[];
  const crons = docs.filter((d) => d.kind === 'CronJob');

  it('keeps the ServiceAccount and defines both CronJobs, suspended, with the image placeholder', () => {
    expect(docs.filter((d) => d.kind === 'ServiceAccount').map((d) => d.metadata.name)).toEqual(['harmony-figma-refresh']);
    expect(crons.map((c) => c.metadata.name)).toEqual(['harmony-figma-refresh', 'harmony-figma-refresh-prod']);
    for (const c of crons) {
      expect(c.metadata.namespace).toBe('harmony-conductor');
      expect(c.spec.suspend).toBe(true);
      const pod = c.spec.jobTemplate.spec.template.spec;
      expect(pod.serviceAccountName).toBe('harmony-figma-refresh');
      expect(pod.containers[0]!.name).toBe('refresh');
      expect(pod.containers[0]!.image).toBe('REPLACE_WITH_TESTED_PINNED_REFRESH_IMAGE');
    }
  });

  it('reads each board Secret by channel', () => {
    const secrets = (c: CronJob) =>
      new Set(c.spec.jobTemplate.spec.template.spec.containers[0]!.env.map((e) => e.valueFrom.secretKeyRef.name));
    expect([...secrets(crons[0]!)]).toEqual(['harmony-figma-refresh-board']);
    expect([...secrets(crons[1]!)]).toEqual(['harmony-figma-refresh-board-prod']);
  });
});
