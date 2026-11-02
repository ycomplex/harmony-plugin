import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const pin = read('container/codex-version').trim();
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pin-'));
  dirs.push(dir);
  return dir;
}

describe('supported Codex version contract', () => {
  it('accepts only an exact supported CLI and refuses missing/malformed pins', () => {
    const dir = fixture();
    const path = join(dir, 'version');
    for (const [value, actual, expected] of [
      [pin, `codex-cli ${pin}`, 0],
      [pin, 'codex-cli 999.0.0', 1],
      [pin, `codex-cli ${pin}-preview`, 1],
      ['latest', `codex-cli ${pin}`, 1],
      ['', `codex-cli ${pin}`, 1],
      [`${pin}\n999.0.0`, `codex-cli ${pin}`, 1],
    ] as const) {
      writeFileSync(path, value);
      const r = spawnSync('bash', ['-c', '. "$1"; codex_version_matches "$2" "$3"', 'fixture',
        join(root, 'container/codex-version.sh'), path, actual]);
      expect(r.status).toBe(expected);
    }
    rmSync(path);
    expect(spawnSync('bash', ['-c', '. "$1"; codex_supported_version "$2"', 'fixture',
      join(root, 'container/codex-version.sh'), path]).status).toBe(1);
  });

  it('executes Cloud Build version resolution from the committed file, without npm', () => {
    const config = parse(read('container/cloudbuild.yaml'));
    const step = config.steps.find((s: { id: string }) => s.id === 'resolve-codex-version');
    const dir = fixture();
    const script = step.args[1].replaceAll('/workspace/codex_version.txt', join(dir, 'resolved'));
    const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, 'resolved'), 'utf8').trim()).toBe(pin);
    expect(script).not.toContain('npm view');
    expect(read('container/Dockerfile')).not.toContain('ARG CODEX_VERSION=latest');
    expect(read('container/Dockerfile')).toContain('COPY codex-version /etc/harmony-codex-supported-version');
    expect(read('container/Dockerfile')).toContain('test "$CODEX_VERSION" = "$supported"');
    expect(read('container/provision.sh')).toContain('codex_version_matches "$PLUGIN_DIR/container/codex-version" "$(codex --version)"');
    expect(read('container/smoke.sh')).toContain('/codex-version" "$codex_out"');
  });

  it('executes the Docker install block with the file default and refuses a conflicting build argument', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'pin'), pin);
    writeFileSync(join(dir, 'guard'), read('container/codex-version.sh'));
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\n echo "$*" > "$INSTALL_LOG"\n');
    writeFileSync(join(dir, 'codex'), `#!/bin/sh\necho 'codex-cli ${pin}'\n`);
    chmodSync(join(dir, 'npm'), 0o755);
    chmodSync(join(dir, 'codex'), 0o755);
    const block = read('container/Dockerfile').match(/RUN bash -ec '(.*)'/u)![1]
      .replaceAll('/usr/local/lib/harmony-codex-version.sh', join(dir, 'guard'))
      .replaceAll('/etc/harmony-codex-supported-version', join(dir, 'pin'))
      .replaceAll('/etc/harmony-codex-version', join(dir, 'installed'));
    for (const argument of ['', pin, '999.0.0']) {
      const result = spawnSync('bash', ['-ec', block], { encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH}`, CODEX_VERSION: argument, INSTALL_LOG: join(dir, 'install-log') } });
      expect(result.status, result.stderr).toBe(argument === '999.0.0' ? 1 : 0);
      if (argument !== '999.0.0') {
        expect(readFileSync(join(dir, 'install-log'), 'utf8').trim()).toBe(`install -g @openai/codex@${pin}`);
        expect(readFileSync(join(dir, 'installed'), 'utf8').trim()).toBe(pin);
        rmSync(join(dir, 'install-log'));
      }
    }
  });

  it('runs the real smoke script and rejects an unsupported CLI even when its baked marker agrees', () => {
    const dir = fixture();
    const docker = join(dir, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash
case "$*" in
  *'codex --version'*) echo "codex-cli $FAKE_CODEX_VERSION" ;;
  *'cat /etc/harmony-codex-version'*) echo "$FAKE_CODEX_VERSION" ;;
  *'codex exec --help'*) echo '--json --cd --add-dir --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --strict-config' ;;
  *'HARMONY_REPOS_JSON=!!!'*) echo 'did not decode to a non-empty JSON array'; exit 1 ;;
  *'HARMONY_REPOS_JSON='*) echo 'no repos[] entry has is_plugin:true'; exit 1 ;;
  *'fixture-image shell'*) echo GIT_TOKEN; exit 1 ;;
esac
`);
    chmodSync(docker, 0o755);
    for (const [version, expected] of [[pin, 0], ['999.0.0', 1]]) {
      const result = spawnSync('bash', ['container/smoke.sh', 'fixture-image'], {
        cwd: root, encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, FAKE_CODEX_VERSION: String(version) },
      });
      expect(result.status, result.stdout + result.stderr).toBe(expected);
      if (expected === 1) expect(result.stderr).toContain('committed supported Codex version');
      else expect(result.stdout).toContain('smoke: PASS');
    }
  });
});
