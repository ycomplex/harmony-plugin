/**
 * B-1429: `harmony watch` on a REAL pipe. The fixture (watch-pipe.fixture.ts) runs the real
 * registered command with a fake board; it is bundled once with esbuild (a devDependency, as in
 * model-startup.test.ts) and run under plain node, so the real stdout error listener, process
 * guards and `exitAfterDrain` meet a real pipe whose reader this test controls. Hermetic: no
 * token, no network, a temp HARMONY home.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLocks, readHeartbeat } from '../../watch/seat-files.js';

const dir = mkdtempSync(join(tmpdir(), 'b1429-pipe-'));
const bundle = join(dir, 'fixture.mjs');

beforeAll(async () => {
  await build({
    entryPoints: [resolve(import.meta.dirname, 'watch-pipe.fixture.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}, 30_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  lines: string[];
  stderr: string;
  ms: number;
}

/**
 * Run the fixture. `closeAfter`: destroy the read end after that many lines (a reader that goes
 * away). `slowMs`: read nothing for that long, then read everything (a slow but live reader).
 */
async function run(home: string, tickets: number, args: string[], reader: { closeAfter?: number; slowMs?: number }): Promise<Run> {
  const t0 = Date.now();
  const child = spawn(process.execPath, [bundle, home, String(tickets), 'watch', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr += c;
  });
  let buf = '';
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('error', () => {});
  const onData = (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (reader.closeAfter !== undefined && lines.length >= reader.closeAfter) {
        child.stdout.off('data', onData);
        child.stdout.destroy();
        return;
      }
    }
  };
  if (reader.slowMs) {
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on('data', onData);
      child.stdout.resume();
    }, reader.slowMs);
  } else {
    child.stdout.on('data', onData);
  }
  const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(killer);
  return { code, lines, stderr, ms: Date.now() - t0 };
}

describe('harmony watch on a real pipe (B-1429)', () => {
  it('--once into a reader that closes after one line exits 141 promptly, with no guard noise', async () => {
    const home = mkdtempSync(join(dir, 'h-'));
    const r = await run(home, 3000, ['--milestone', 'm1', '--once', '--json'], { closeAfter: 1 });
    expect(r.code).toBe(141);
    expect(r.ms).toBeLessThan(5_000);
    expect(JSON.parse(r.lines[0]).event).toBe('start');
    expect(r.stderr).not.toMatch(/uncaught-exception|unhandled-rejection|EPIPE/);
  });

  it.each([['--follow'], ['--until-event']])('%s into a reader that closes after one line exits 141, frees the lock, leaves no heartbeat', async (mode) => {
    const home = mkdtempSync(join(dir, 'h-'));
    const r = await run(home, 3, ['--milestone', 'm1', '--seat', 'orch', mode, '--json'], { closeAfter: 1 });
    expect(r.code).toBe(141);
    expect(r.ms).toBeLessThan(5_000);
    expect(r.stderr).not.toMatch(/uncaught-exception|unhandled-rejection/);
    expect(listLocks('B', 'orch', { home })).toEqual([]);
    expect(readHeartbeat('B', 'orch', { home }).status).toBe('absent');
  });

  it('--once --json into a slow but live reader delivers every line and exits 0', async () => {
    const home = mkdtempSync(join(dir, 'h-'));
    const tickets = 3000;
    const r = await run(home, tickets, ['--milestone', 'm1', '--once', '--json'], { slowMs: 500 });
    expect(r.code).toBe(0);
    // start, one ready event per paused ticket, then one current row per ticket
    expect(r.lines).toHaveLength(1 + 2 * tickets);
    const parsed = r.lines.map((l) => JSON.parse(l));
    expect(parsed[0].event).toBe('start');
    expect(parsed.filter((l) => l.event === 'ready')).toHaveLength(tickets);
    expect(parsed.filter((l) => l.event === 'current')).toHaveLength(tickets);
    expect(r.stderr).toBe('');
  });
});
