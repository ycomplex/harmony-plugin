// B-1475: scripts/publish-release.sh against its local backend — the same create-only / compare / pointers-last
// semantics the gs:// backend implements with `gcloud storage cp --if-generation-match=0`.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PUBLISH_SCRIPT, build, makeRepo } from './test/release-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function tmp() { const d = mkdtempSync(join(tmpdir(), 'b1475-pub-')); roots.push(d); return d; }

function publish(out: string, dest: string): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [PUBLISH_SCRIPT, out, dest], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

function listing(dest: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else files[relative(dest, p)] = readFileSync(p).toString('base64');
    }
  };
  walk(dest);
  return files;
}

function release(version: string, extra?: string) {
  const r = makeRepo(); roots.push(r.root);
  const c = r.commit(version, { extra });
  const out = tmp();
  expect(build(r.dir, { commit: c, channel: 'staging', out }).status).toBe(0);
  return out;
}

const V = (v: string) => `channels/staging/releases/${v}`;

describe('publish-release.sh (local backend)', () => {
  it('first publish writes the three versioned objects and the two pointers', () => {
    const out = release('1.0.0');
    const dest = tmp();
    const res = publish(out, dest);
    expect(res.status, res.output).toBe(0);
    expect(Object.keys(listing(dest)).sort()).toEqual([
      'channels/staging/marketplace.json',
      `${V('1.0.0')}/harmony-plugin-1.0.0.zip`,
      `${V('1.0.0')}/marketplace.json`,
      `${V('1.0.0')}/release.json`,
      'channels/staging/release.json',
    ].sort());
    expect(readFileSync(join(dest, 'channels/staging/marketplace.json')).equals(readFileSync(join(dest, V('1.0.0'), 'marketplace.json')))).toBe(true);
    expect(readFileSync(join(dest, 'channels/staging/release.json')).equals(readFileSync(join(out, 'release.json')))).toBe(true);
  });

  it('re-publishing an identical build changes nothing', () => {
    const out = release('1.0.0');
    const dest = tmp();
    publish(out, dest);
    const before = listing(dest);
    const pointerMtime = statSync(join(dest, 'channels/staging/marketplace.json')).mtimeMs;
    const res = publish(out, dest);
    expect(res.status, res.output).toBe(0);
    expect(res.output).toMatch(/unchanged .*harmony-plugin-1\.0\.0\.zip/);
    expect(res.output).toMatch(/already current/);
    expect(listing(dest)).toEqual(before);
    expect(statSync(join(dest, 'channels/staging/marketplace.json')).mtimeMs).toBe(pointerMtime);
  });

  it('a clashing version (same version, different bytes) fails and leaves the pointers at the earlier release', () => {
    const first = release('1.0.0', 'first');
    const clash = release('1.0.0', 'second');
    const dest = tmp();
    publish(first, dest);
    const before = listing(dest);
    const res = publish(clash, dest);
    expect(res.status).not.toBe(0);
    expect(res.output).toMatch(/harmony-plugin-1\.0\.0\.zip is already published with DIFFERENT bytes/);
    expect(listing(dest)).toEqual(before);
  });

  it('a newer version moves the pointers and keeps the older release', () => {
    const dest = tmp();
    publish(release('1.0.0'), dest);
    const newer = release('1.0.1');
    const res = publish(newer, dest);
    expect(res.status, res.output).toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'channels/staging/release.json'), 'utf8')).version).toBe('1.0.1');
    expect(readFileSync(join(dest, 'channels/staging/marketplace.json')).equals(readFileSync(join(newer, 'marketplace.json')))).toBe(true);
    expect(Object.keys(listing(dest))).toContain(`${V('1.0.0')}/harmony-plugin-1.0.0.zip`);
  });

  it('an older release published late never moves the pointers backwards', () => {
    const dest = tmp();
    const older = release('1.0.0');
    publish(release('1.0.1'), dest);
    const res = publish(older, dest);
    expect(res.status, res.output).toBe(0);
    expect(res.output).toMatch(/pointers left at 1\.0\.1/);
    expect(JSON.parse(readFileSync(join(dest, 'channels/staging/release.json'), 'utf8')).version).toBe('1.0.1');
    expect(Object.keys(listing(dest))).toContain(`${V('1.0.0')}/release.json`);
  });

  it('refuses a build directory with no manifest', () => {
    const empty = tmp();
    writeFileSync(join(empty, 'release.json'), '{}');
    const res = publish(empty, tmp());
    expect(res.status).not.toBe(0);
    expect(res.output).toMatch(/no manifest\.txt/);
  });
});
