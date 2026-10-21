// B-1173: the remote-conductor image's committed files — Cloud Build file shape, Dockerfile labels, the entrypoint
// and the smoke script. No Docker is needed or used: this pins what can be pinned pre-merge (ordering, labels, the
// entrypoint's real behaviour against a fake resolver). A real build + smoke runs on Cloud Build.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { applyLaunchEnv, launchEnvFromMerged, loadConductorConfigSync, resetConductorWarningDedupe } from '../config/conductor-config.js';

const repo = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(repo(rel), 'utf8');

interface Step {
  id: string;
  name: string;
  args?: string[];
}
const build = parse(read('container/conductor/cloudbuild.yaml')) as {
  substitutions: Record<string, string>;
  steps: Step[];
};
const stepText = (s: Step): string => (s.args ?? []).join('\n');
const ids = build.steps.map((s) => s.id);

describe('container/conductor/cloudbuild.yaml', () => {
  it('is a separate file with the registry image and a channel substitution (project kept in the image substitution)', () => {
    expect(build.substitutions._IMAGE).toBe('us-central1-docker.pkg.dev/harmony-conductor/harmony-workers/harmony-conductor');
    expect(Object.keys(build.substitutions)).toContain('_CHANNEL');
    expect(read('container/cloudbuild.yaml')).not.toContain('harmony-conductor:candidate');
  });

  it('runs build, then smoke, and only afterwards pushes anything; the channel tag is pushed last', () => {
    expect(ids).toEqual(['read-version', 'build', 'smoke', 'push-version', 'push-channel']);
    const firstPush = build.steps.findIndex((s) => /docker push/.test(stepText(s)));
    expect(ids.indexOf('smoke')).toBeLessThan(firstPush);
    const channelPush = build.steps.findIndex((s) => /docker push '\$\{_IMAGE\}:\$\{_CHANNEL\}'/.test(stepText(s)));
    expect(channelPush).toBe(ids.length - 1);
    // no step before the smoke pushes, and the build never tags the channel
    for (const s of build.steps.slice(0, ids.indexOf('smoke') + 1)) expect(stepText(s)).not.toMatch(/docker push/);
    expect(stepText(build.steps[ids.indexOf('build')]!)).not.toContain('${_CHANNEL}');
  });

  it('smoke invokes container/conductor/smoke.sh with the plugin version; the version comes from plugin.json', () => {
    expect(stepText(build.steps[ids.indexOf('smoke')]!)).toContain('container/conductor/smoke.sh');
    expect(stepText(build.steps[ids.indexOf('smoke')]!)).toContain('plugin_version.txt');
    expect(stepText(build.steps[0]!)).toContain('.claude-plugin/plugin.json');
  });

  it('tags :<plugin version> and :<channel>, and labels the image through the PLUGIN_VERSION build-arg', () => {
    expect(stepText(build.steps[ids.indexOf('push-version')]!)).toContain('${_IMAGE}:$(cat /workspace/plugin_version.txt)');
    expect(stepText(build.steps[ids.indexOf('push-channel')]!)).toContain("'${_IMAGE}:${_CHANNEL}'");
    expect(stepText(build.steps[ids.indexOf('build')]!)).toContain('--build-arg PLUGIN_VERSION=');
    expect(read('container/conductor/Dockerfile')).toMatch(/LABEL harmony\.plugin_version="\$\{PLUGIN_VERSION\}"/);
  });

  it('refuses a channel other than staging|prod and a dist-less checkout before building', () => {
    expect(stepText(build.steps[0]!)).toContain('staging|prod');
    expect(stepText(build.steps[0]!)).toContain('[ -d dist ]');
  });
});

describe('container/conductor/Dockerfile', () => {
  const df = read('container/conductor/Dockerfile');
  it('is node:22-slim with gcloud, kubectl and jq, runs non-root, and bakes no credential', () => {
    expect(df).toContain('FROM node:22-bookworm-slim');
    expect(df).toMatch(/google-cloud-cli kubectl/);
    expect(df).toMatch(/\bjq\b/);
    expect(df).toContain('USER node');
    const code = df.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/HARMONY_API_TOKEN|PRIVATE_KEY/);
    expect(df).toContain('COPY dist ./dist');
  });

  // 0.15.88 shipped without scripts/, so every leg launch from the pod died at the token mint before creating a
  // Job. Every path a container/ shell script reaches through $HARMONY_PLUGIN_DIR must be inside a COPY'd dir.
  it('copies every top-level directory the launch path reaches through $HARMONY_PLUGIN_DIR', () => {
    // The shell scripts (container/**/*.sh), the example profiles (container/**/*.json) and the launch-line
    // templates in source (src/**/*.ts, tests excluded) are everything that names a path under the plugin dir.
    const walk = (dir: string, keep: (name: string) => boolean): string[] =>
      readdirSync(repo(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`, keep) : keep(e.name) ? [`${dir}/${e.name}`] : [],
      );
    const files = [
      ...walk('container', (n) => n.endsWith('.sh') || n.endsWith('.json')),
      ...walk('src', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
    ];
    const reached = new Set<string>();
    for (const f of files) {
      for (const m of read(f).matchAll(/\$\{?HARMONY_PLUGIN_DIR\}?\/([A-Za-z0-9_.-]+)\//g)) reached.add(m[1]!);
    }
    expect([...reached]).toEqual(expect.arrayContaining(['container', 'dist', 'scripts']));
    const copied = new Set([...df.matchAll(/^COPY (\S+) \.\/\S+$/gm)].map((m) => m[1]!));
    for (const dir of reached) expect(copied, `$HARMONY_PLUGIN_DIR/${dir}/ is used on the launch path`).toContain(dir);
  });
});

describe('container/conductor/entrypoint.sh and smoke.sh', () => {
  it.each(['container/conductor/entrypoint.sh', 'container/conductor/smoke.sh'])('%s passes bash -n and is executable', (rel) => {
    expect(spawnSync('bash', ['-n', repo(rel)], { encoding: 'utf8' }).status).toBe(0);
    expect(statSync(repo(rel)).mode & 0o111).not.toBe(0);
  });

  const entry = repo('container/conductor/entrypoint.sh');
  const fakePlugin = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'b1173-entry-'));
    mkdirSync(join(dir, 'dist/bin'), { recursive: true });
    writeFileSync(join(dir, 'dist/bin/conductor-boot.js'), 'console.log("BOOT " + process.argv.slice(2).join(" "));\n');
    return dir;
  };

  it('execs a plain command untouched', () => {
    const r = spawnSync('bash', [entry, 'echo', 'hello'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('hello\n');
  });

  it('--with-secrets hands the command to the built resolver (dist/bin/conductor-boot.js exec -- ...)', () => {
    const r = spawnSync('bash', [entry, '--with-secrets', 'bash', 'sweep.sh', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HARMONY_PLUGIN_DIR: fakePlugin() },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('BOOT exec -- bash sweep.sh --dry-run');
  });

  it('refuses no command, and --with-secrets without one (exit 2)', () => {
    expect(spawnSync('bash', [entry], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync('bash', [entry, '--with-secrets'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('smoke.sh runs the credential-free boot preflight inside the candidate image, after the host-file check and before PASS (B-1186)', () => {
    const s = read('container/conductor/smoke.sh');
    const preflight = s.indexOf('--entrypoint node "$IMAGE" /opt/harmony-plugin/dist/bin/conductor-boot.js preflight');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(s.indexOf('conductor-boot.js check-host'));
    expect(preflight).toBeLessThan(s.indexOf('echo "smoke: PASS"'));
    // a non-zero exit fails the build with a clear message; nothing about it can be swallowed
    expect(s).toMatch(/preflight 2>&1\)" \\\n\s+\|\| fail "the pod's boot preflight failed inside the image/);
    // the header's DEPTH list names it
    expect(s.slice(0, s.indexOf('set -euo pipefail'))).toContain('BOOT PREFLIGHT');
    // and the whole smoke still runs before any push (pinned above): the preflight is part of that step
    expect(ids.indexOf('smoke')).toBeLessThan(build.steps.findIndex((st) => /docker push/.test(stepText(st))));
  });

  it('smoke.sh asserts the label, the host-file load and the resolver guard', () => {
    const s = read('container/conductor/smoke.sh');
    expect(s).toContain('harmony.plugin_version');
    expect(s).toContain('conductor-boot.js check-host');
    expect(s).toContain('--with-secrets');
    expect(s).toContain('--entrypoint harmony "$IMAGE" --version');
  });
});

describe('the build script list', () => {
  it('package.json builds conductor-boot into dist/bin (the entrypoint and the smoke depend on it)', () => {
    expect(JSON.parse(read('package.json')).scripts.build).toContain('src/bin/conductor-boot.ts');
  });
});

// B-1186: the pod must boot clean. Load the SHIPPED ConfigMap files and the SHIPPED Deployment + Dockerfile env through
// the config loader exactly as the pod would, then re-read config the way a child process does after the daemon has
// pushed its resolved values into the environment, and assert no `deprecated:` line anywhere.
describe('the shipped pod config boots with no deprecation warnings and no placeholders', () => {
  const k8sText = (f: string): string => read(`container/conductor/k8s/${f}`);
  const configMap = parseAllDocuments(k8sText('configmap.yaml'))[0]!.toJS() as { data: Record<string, string> };
  const deployment = parseAllDocuments(k8sText('deployment.yaml'))[0]!.toJS() as {
    spec: { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
  };
  // The only placeholders the operator fills before applying (runbook: "Put the config in the ConfigMap").
  const FILLED: Record<string, string> = {
    'REPLACE-OWNER/REPLACE-CONFIG-REPO': 'acme/config',
    'REPLACE-WITH-APP-ID': '123',
    'REPLACE-WITH-INSTALLATION-ID': '456',
  };
  const fill = (t: string): string => Object.entries(FILLED).reduce((acc, [k, v]) => acc.split(k).join(v), t);
  const dockerEnv = (): Record<string, string> => {
    const m = /^ENV ((?:.*\\\n)*.*)$/m.exec(read('container/conductor/Dockerfile'));
    const out: Record<string, string> = {};
    for (const tok of (m?.[1] ?? '').replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean)) {
      const i = tok.indexOf('=');
      out[tok.slice(0, i)] = tok.slice(i + 1);
    }
    return out;
  };

  const HOST = '/etc/harmony/conductor-host.json';
  const PROJECT = '/etc/harmony/conductor-project.json';
  const files: Record<string, string> = {
    [HOST]: fill(configMap.data['conductor-host.json']!),
    [PROJECT]: fill(configMap.data['conductor-project.json']!),
  };
  const podEnv = (): Record<string, string> => ({
    ...dockerEnv(),
    ...Object.fromEntries(deployment.spec.template.spec.containers[0]!.env.map((e) => [e.name, e.value])),
    HARMONY_CONDUCTOR_PROJECT_FILE: PROJECT, // the seed stands in for the fetched snapshot
    HARMONY_APP_PRIVATE_KEY: 'resolved-at-boot', // the secret the pod resolves from Secret Manager (name only in the files)
  });
  const load = (env: NodeJS.ProcessEnv, warn: (m: string) => void) => {
    resetConductorWarningDedupe();
    return loadConductorConfigSync({
      env,
      existsSync: (p) => p in files,
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      warn,
    })!;
  };

  it('the only placeholders in the shipped files are the three the runbook has the operator fill', () => {
    const data = Object.values(configMap.data).join('\n');
    const found = new Set(data.match(/REPLACE-[A-Z]+(?:-[A-Z]+)*(?:\/REPLACE-[A-Z]+(?:-[A-Z]+)*)?/g) ?? []);
    expect([...found].sort()).toEqual(Object.keys(FILLED).sort());
    expect(Object.values(files).join('\n')).not.toContain('REPLACE');
  });

  it('the Deployment env and Dockerfile ENV name no legacy knob that the files do not already resolve to', () => {
    const seen: string[] = [];
    const r = load(podEnv(), (m) => seen.push(m));
    expect(seen.filter((m) => m.startsWith('deprecated:'))).toEqual([]);
    expect(r.warnings.filter((m) => m.startsWith('deprecated:'))).toEqual([]);
    expect(r.merged.gcp?.project).toBe('harmony-conductor');
    expect(r.merged.gke?.storage_class).toBe('harmony-ticket-disk');
    expect(r.merged.plugin_dir).toBe('/opt/harmony-plugin');
  });

  it('a child process re-reading config after the daemon applied its launch env logs no deprecated: line', () => {
    const parentSeen: string[] = [];
    const parent = load(podEnv(), (m) => parentSeen.push(m));
    const childEnv: NodeJS.ProcessEnv = podEnv();
    const applied = new Set<string>();
    applyLaunchEnv(childEnv, launchEnvFromMerged(parent.merged), applied);
    expect(childEnv.CLOUDSDK_CORE_PROJECT).toBe('harmony-conductor'); // the daemon really did push legacy-named vars
    expect(childEnv.HARMONY_GKE_CONTEXT).toContain('gke_harmony-conductor_us-central1-a_harmony-legs');
    const childSeen: string[] = [];
    const child = load(childEnv, (m) => childSeen.push(m));
    expect([...parentSeen, ...childSeen].filter((m) => m.includes('deprecated'))).toEqual([]);
    expect(child.merged).toEqual(parent.merged);
  });
});

// B-1186: the runbook ships with the plugin and must be followable with only the plugin installed.
describe('docs/remote-conductor-runbook.md', () => {
  const rb = read('docs/remote-conductor-runbook.md');
  const code = rb.split('\n').filter((l) => /^\s*(\$ |bash |node |kubectl |gcloud |sed |PLUGIN_DIR|M=|test )/.test(l) || l.includes('`')).join('\n');

  it('sets PLUGIN_DIR once and never uses a workspace-relative plugin path or a bare harmony', () => {
    expect(rb).toContain('PLUGIN_DIR="$(ls -d');
    expect(rb).not.toMatch(/plugin\/container\//);
    expect(rb).not.toMatch(/docs\/project\//);
    expect(code).not.toMatch(/(^|[\s`])harmony (conductor|config|login|tasks)\b/m);
    expect(rb).toContain('node "$PLUGIN_DIR/dist/bin/harmony.js"');
    expect(rb).toContain('bash "$PLUGIN_DIR/container/gke/setup-cluster.sh"');
  });

  it('uses the real pod label, lists the operator prerequisites, sizing, PriorityClass and the preemption caveat', () => {
    expect(rb).toContain('app.kubernetes.io/name=harmony-conductor');
    expect(rb).not.toMatch(/-l app=harmony-conductor/);
    expect(rb).toContain('gke-gcloud-auth-plugin');
    expect(rb).toContain('gcloud container clusters get-credentials <cluster>');
    expect(rb).toMatch(/MAXIMUM node count/);
    expect(rb).toContain('konnectivity-agent');
    expect(rb).toContain('kube-dns');
    expect(rb).toContain('--system-nodes');
    expect(rb).toContain('--system-machine-type');
    expect(rb).toContain('DRIFT:');
    expect(rb.indexOf('priorityclass.yaml"')).toBeLessThan(rb.indexOf('/deployment.yaml" | kubectl apply -f -'));
    expect(rb).toMatch(/system-critical/);
    expect(rb).toMatch(/Headroom is the main fix/);
  });

  it('names no Harmony-specific deployment value', () => {
    expect(rb).not.toMatch(/harmony-conductor@harmony-conductor|eioxsunvhakmelhanmnn|meqkdgncdzromunylyxf|\bMac mini\b/);
  });

  it('is indexed from docs/README.md and container/README.md', () => {
    expect(read('docs/README.md')).toContain('remote-conductor-runbook.md');
    expect(read('container/README.md')).toContain('remote-conductor-runbook.md');
  });
});
