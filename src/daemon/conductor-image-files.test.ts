// B-1173: the remote-conductor image's committed files — Cloud Build file shape, Dockerfile labels, the entrypoint
// and the smoke script. No Docker is needed or used: this pins what can be pinned pre-merge (ordering, labels, the
// entrypoint's real behaviour against a fake resolver). A real build + smoke runs on Cloud Build.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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
