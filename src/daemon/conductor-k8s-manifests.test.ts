// B-1173: structure of the remote conductor's Kubernetes manifests (container/conductor/k8s/*.yaml). No cluster and
// no kubectl: the YAML is parsed with the repo's own `yaml` and the properties the design depends on are pinned.
// (kubectl apply --dry-run=client|server is a founder/verify step; this proves the shape.)

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { HostFileSchema, looksLikeSecretValue, ProjectFileSchema } from '../config/conductor-config.js';
import { KUBE_CONTAINER, KUBE_DEPLOYMENT, KUBE_NAMESPACE } from '../cli/commands/conductor-kube.js';

const dir = fileURLToPath(new URL('../../container/conductor/k8s', import.meta.url));

type Doc = any;
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
const docsOf = (file: string): Doc[] =>
  parseAllDocuments(readFileSync(join(dir, file), 'utf8')).map((d) => {
    expect(d.errors, `${file}: ${d.errors.map(String).join('; ')}`).toHaveLength(0);
    return d.toJS();
  });
const all: Array<{ file: string; doc: Doc }> = files.flatMap((file) => docsOf(file).map((doc) => ({ file, doc })));
const one = (kind: string, name?: string): Doc =>
  all.find((x) => x.doc.kind === kind && (!name || x.doc.metadata.name === name))?.doc ?? (() => { throw new Error(`no ${kind} ${name ?? ''}`); })();
const rawText = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

describe('manifest set', () => {
  it('has the expected files and kinds, every document parses', () => {
    expect(files).toEqual(['00-namespace.yaml', 'configmap.yaml', 'cronjob-sweep.yaml', 'deployment.yaml', 'rbac-conductor.yaml', 'rbac-legs.yaml', 'serviceaccount.yaml']);
    expect(all.map((x) => x.doc.kind).sort()).toEqual(
      ['ConfigMap', 'CronJob', 'Deployment', 'Namespace', 'Role', 'Role', 'RoleBinding', 'RoleBinding', 'ServiceAccount'],
    );
  });

  it('nothing is cluster-wide: no ClusterRole / ClusterRoleBinding, and the only namespaces used are harmony-conductor and (Role/RoleBinding only) harmony-legs', () => {
    for (const { doc } of all) {
      expect(doc.kind).not.toMatch(/^Cluster/);
      if (doc.kind === 'Namespace') continue;
      const ns = doc.metadata.namespace;
      if (ns === 'harmony-legs') expect(['Role', 'RoleBinding']).toContain(doc.kind);
      else expect(ns).toBe('harmony-conductor');
    }
    // and no rule reaches a cluster-scoped resource
    for (const role of all.filter((x) => x.doc.kind === 'Role')) {
      for (const rule of role.doc.rules) {
        for (const r of rule.resources) expect(['nodes', 'namespaces', 'storageclasses', 'persistentvolumes']).not.toContain(r);
      }
    }
  });

  it('the conductor lives in its OWN namespace, not harmony-legs', () => {
    expect(one('Namespace').metadata.name).toBe('harmony-conductor');
    expect(KUBE_NAMESPACE).toBe('harmony-conductor');
    expect(one('Deployment').metadata.namespace).toBe('harmony-conductor');
    expect(one('CronJob').metadata.namespace).toBe('harmony-conductor');
  });

  it('carries no credential: no Secret kind, no secretKeyRef / secret volume, no token or key env', () => {
    expect(all.some((x) => x.doc.kind === 'Secret')).toBe(false);
    expect(rawText).not.toMatch(/secretKeyRef|secretRef|secretName/);
    const envNames = [one('Deployment'), one('CronJob')]
      .flatMap((d) => (d.spec.template ?? d.spec.jobTemplate.spec.template).spec.containers)
      .flatMap((c: Doc) => (c.env ?? []).map((e: Doc) => e.name));
    expect(envNames.join(' ')).not.toMatch(/HARMONY_API_TOKEN|PRIVATE_KEY|TOKEN/);
  });
});

describe('Deployment harmony-conductor', () => {
  const d = one('Deployment', 'harmony-conductor');
  const pod = d.spec.template.spec;
  const c = pod.containers[0];

  it('matches the names the lifecycle code patches', () => {
    expect(d.metadata.name).toBe(KUBE_DEPLOYMENT);
    expect(c.name).toBe(KUBE_CONTAINER);
    expect(pod.containers).toHaveLength(1);
    expect(pod.serviceAccountName).toBe('harmony-conductor');
  });

  it('is one replica with a surge rollout that never drops the running pod, and a 300s deadline', () => {
    expect(d.spec.replicas).toBe(1);
    expect(d.spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
    expect(d.spec.progressDeadlineSeconds).toBe(300);
  });

  it('pins a VERSION tag placeholder, never a moving tag', () => {
    const [repo, tag] = c.image.split(':').length === 2 ? c.image.split(':') : [c.image, ''];
    expect(repo).toBe('us-central1-docker.pkg.dev/harmony-conductor/harmony-workers/harmony-conductor');
    expect(tag).toBe('__CONDUCTOR_VERSION__');
    expect(c.image).not.toMatch(/:(latest|staging|prod|candidate)$/);
    expect(one('CronJob').spec.jobTemplate.spec.template.spec.containers[0].image).toBe(c.image);
  });

  it('is scheduled on the default pool and has NO toleration for the leg pool taint', () => {
    expect(pod.nodeSelector).toEqual({ 'cloud.google.com/gke-nodepool': 'default-pool' });
    expect(pod.tolerations).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('harmony-leg');
  });

  it('has an exec readiness probe on $HARMONY_READY_FILE', () => {
    expect(c.readinessProbe.exec.command.join(' ')).toContain('test -f');
    expect(c.readinessProbe.exec.command.join(' ')).toContain('$HARMONY_READY_FILE');
    const env = Object.fromEntries(c.env.map((e: Doc) => [e.name, e.value]));
    expect(env.HARMONY_READY_FILE).toBe('/tmp/harmony-ready');
  });

  it('requests 50m / 256Mi and limits memory to 512Mi (no CPU limit) — two fit on the e2-medium system node during a rollout', () => {
    expect(c.resources).toEqual({ requests: { cpu: '50m', memory: '256Mi' }, limits: { memory: '512Mi' } });
  });

  it('sets the remote-mode environment', () => {
    const env = Object.fromEntries(c.env.map((e: Doc) => [e.name, e.value]));
    expect(env).toMatchObject({
      HARMONY_CONDUCTOR_REMOTE: '1',
      HARMONY_CONDUCTOR_IMAGE: 'us-central1-docker.pkg.dev/harmony-conductor/harmony-workers/harmony-conductor',
      HARMONY_PLUGIN_POSTURE: 'ack:staging',
      HARMONY_HOME: '/var/harmony',
      HARMONY_CONDUCTOR_HOST_FILE: '/etc/harmony/conductor-host.json',
      HARMONY_GKE_STORAGE_CLASS: 'harmony-ticket-disk',
      CLOUDSDK_CORE_ACCOUNT: 'harmony-conductor@harmony-conductor.iam.gserviceaccount.com',
      CLOUDSDK_CORE_PROJECT: 'harmony-conductor',
    });
  });

  it('documents the node-capacity check as a founder command', () => {
    expect(readFileSync(join(dir, 'deployment.yaml'), 'utf8')).toContain('kubectl describe node <system-node>');
  });
});

describe('ServiceAccount, ConfigMap and RBAC', () => {
  it('the service account is annotated for Workload Identity', () => {
    const sa = one('ServiceAccount');
    expect(sa.metadata.name).toBe('harmony-conductor');
    expect(sa.metadata.annotations['iam.gke.io/gcp-service-account']).toBe('harmony-conductor@harmony-conductor.iam.gserviceaccount.com');
  });

  it('the ConfigMap files validate against the strict schemas and the secrets block holds names only', () => {
    const cm = one('ConfigMap');
    const host = JSON.parse(cm.data['conductor-host.json']);
    const project = JSON.parse(cm.data['conductor-project.json']);
    expect(HostFileSchema.safeParse(host).success).toBe(true);
    expect(ProjectFileSchema.safeParse(project).success).toBe(true);
    for (const v of Object.values(host.secrets) as string[]) expect(looksLikeSecretValue(v)).toBe(false);
    expect(Object.keys(host.secrets).sort()).toEqual(['api_token', 'base', 'codex_auth', 'github_app_private_key']);
    expect(host.github_app.private_key_path).toBeUndefined();
    expect(project.gke.namespace).toBe('harmony-legs');
    expect(project.gke.storage_class).toBe('harmony-ticket-disk');
    expect(JSON.stringify(cm)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  const subject = { kind: 'ServiceAccount', name: 'harmony-conductor', namespace: 'harmony-conductor' };

  it('the harmony-legs Role binds the cross-namespace service account with exactly the launcher/sweep verbs', () => {
    const role = all.find((x) => x.doc.kind === 'Role' && x.doc.metadata.namespace === 'harmony-legs')!.doc;
    const binding = all.find((x) => x.doc.kind === 'RoleBinding' && x.doc.metadata.namespace === 'harmony-legs')!.doc;
    expect(binding.subjects).toEqual([subject]);
    expect(binding.roleRef).toMatchObject({ kind: 'Role', name: role.metadata.name });
    const rule = (res: string, named = false) =>
      role.rules.find((r: Doc) => r.resources.includes(res) && Boolean(r.resourceNames) === named && (res !== 'secrets' || named === Boolean(r.resourceNames)));
    expect(new Set(rule('jobs').verbs)).toEqual(new Set(['create', 'get', 'list', 'watch', 'delete']));
    expect(rule('persistentvolumeclaims').verbs).toEqual(expect.arrayContaining(['create', 'get', 'list', 'watch', 'delete']));
    expect(new Set(rule('secrets').verbs)).toEqual(new Set(['create', 'patch', 'delete']));
    const named = rule('secrets', true);
    expect(named.verbs).toEqual(['get']);
    expect(named.resourceNames).toEqual(['harmony-worker-secrets', 'harmony-codex-auth']);
    expect(rule('pods').resources).toEqual(['pods', 'pods/log']);
    expect(rule('pods').verbs).toEqual(['get', 'list']);
    // no wildcard anywhere
    expect(JSON.stringify(role.rules)).not.toContain('"*"');
  });

  it('the harmony-conductor Role may touch only the named Deployment, plus read replicasets and pods', () => {
    const role = all.find((x) => x.doc.kind === 'Role' && x.doc.metadata.namespace === 'harmony-conductor')!.doc;
    const binding = all.find((x) => x.doc.kind === 'RoleBinding' && x.doc.metadata.namespace === 'harmony-conductor')!.doc;
    expect(binding.subjects).toEqual([subject]);
    const dep = role.rules.find((r: Doc) => r.resources.includes('deployments'));
    expect(dep.resourceNames).toEqual(['harmony-conductor']);
    expect(dep.verbs).toEqual(expect.arrayContaining(['get', 'patch']));
    for (const r of role.rules.filter((x: Doc) => !x.resources.includes('deployments'))) {
      expect(r.verbs.every((v: string) => ['get', 'list', 'watch'].includes(v))).toBe(true);
    }
    expect(JSON.stringify(role.rules)).not.toContain('"*"');
  });
});

describe('CronJob harmony-sweep', () => {
  const cj = one('CronJob', 'harmony-sweep');
  const pod = cj.spec.jobTemplate.spec.template.spec;
  const c = pod.containers[0];

  it('runs every six hours, never overlapping, as the conductor service account', () => {
    expect(cj.spec.schedule).toBe('0 */6 * * *');
    expect(cj.spec.concurrencyPolicy).toBe('Forbid');
    expect(pod.serviceAccountName).toBe('harmony-conductor');
    expect(pod.restartPolicy).toBe('Never');
  });

  it('runs the real sweep script against harmony-legs through the secrets-resolving entrypoint', () => {
    expect(c.args.slice(0, 3)).toEqual(['--with-secrets', 'bash', 'container/gke/sweep-ticket-disks.sh']);
    expect(c.args[c.args.indexOf('--namespace') + 1]).toBe('harmony-legs');
    expect(existsSync(fileURLToPath(new URL('../../container/gke/sweep-ticket-disks.sh', import.meta.url)))).toBe(true);
    expect(c.workingDir).toBe('/opt/harmony-plugin');
  });
});
