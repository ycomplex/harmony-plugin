import { describe, expect, it, vi } from 'vitest';
import { createConductorLogger, createRotatingFile, redact, type RotatingFileFs } from './conductor-logger.js';
import type { LogEntry, LogShipper } from './log-shipper.js';

const FIXED = new Date('2026-10-20T12:00:00.000Z');

/** The pre-B-1174 daemon log function, verbatim, with an injected clock/sinks. */
function legacyLog(out: string[], text: string[], logPath?: string) {
  return (line: string): void => {
    const stamped = `${FIXED.toISOString()} ${line}\n`;
    out.push(stamped);
    if (logPath) text.push(stamped);
  };
}

function memFs() {
  const files = new Map<string, string>();
  const fs: RotatingFileFs = {
    appendFileSync: (p, d) => void files.set(p, (files.get(p) ?? '') + d),
    statSync: (p) => ({ size: Buffer.byteLength(files.get(p) ?? '') }),
    renameSync: (a, b) => {
      files.set(b, files.get(a) ?? '');
      files.delete(a);
    },
    unlinkSync: (p) => void files.delete(p),
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
  };
  return { files, fs };
}

function build(env: NodeJS.ProcessEnv = {}, withShipper = false) {
  const out: string[] = [];
  const text: string[] = [];
  const m = memFs();
  const shipped: LogEntry[] = [];
  const order: string[] = [];
  const shipper: LogShipper = { enqueue: (e) => (order.push('ship'), shipped.push(e)), flush: async () => {}, start() {}, stop() {}, stats: () => ({ queued: 0, dropped: 0 }) };
  const file = createRotatingFile('/l/conductor.log', { fs: { ...m.fs, appendFileSync: (p, d) => (order.push('file'), m.fs.appendFileSync(p, d)) } });
  const logger = createConductorLogger({
    env,
    now: () => FIXED,
    writeStdout: (s) => out.push(s),
    getTextLogPath: () => '/t/daemon.log',
    appendText: (_p, s) => text.push(s),
    jsonFile: file,
    shipper: withShipper ? shipper : undefined,
  });
  return { logger, out, text, files: m.files, shipped, order };
}

const ID = '123e4567-e89b-12d3-a456-426614174000';
const SAMPLE_LINES = [
  'conductor daemon up: lease holder host:1:abcd, poll 5000ms, heartbeat 30000ms, stale 90000ms, worker timeout 3600000ms, hints off',
  `conduction ${ID}: adopted cleanly-released lease from host:9:ffff`,
  `conduction ${ID}: took over stale lease from host:9:ffff — reaped`,
  `conduction ${ID}: reconciling the held leg`,
  'B-12 "Some title": wake (ball) — queued',
  '[worker] some output\nsecond line',
  'boot preflight failed: no docker',
  'conductor config: sources=[a; b]',
];

describe('stdout is unchanged by the logger adapter (B-1174)', () => {
  it('byte-equal to the pre-B-1174 log function for representative call sites', () => {
    const old: string[] = [];
    const oldText: string[] = [];
    const legacy = legacyLog(old, oldText, '/t/daemon.log');
    const b = build();
    for (const l of SAMPLE_LINES) {
      legacy(l);
      b.logger.line(l);
    }
    expect(b.out.join('')).toBe(old.join(''));
    expect(b.text.join('')).toBe(oldText.join('')); // HARMONY_DAEMON_LOG copy unchanged too
  });

  it('boot lines (before config loads) never touched the text file and still do not', () => {
    const b = build();
    b.logger.bootLine('conductor config: x');
    expect(b.out).toEqual([`${FIXED.toISOString()} conductor config: x\n`]);
    expect(b.text).toEqual([]);
  });

  it('adoption lines still match what container/gke/switch-daemon-profile.sh greps (conduction id + adopt|took over|reconcil)', () => {
    const b = build();
    for (const l of SAMPLE_LINES.slice(1, 4)) b.logger.line(l);
    for (const s of b.out) {
      expect(s.includes(ID)).toBe(true);
      expect(/adopt|took over|reconcil|re-attach|settle|reap/i.test(s)).toBe(true);
    }
  });

  it('the structured log() renders the same text line as line()', () => {
    const b = build();
    b.logger.log('info', 'x', 'hello');
    b.logger.line('hello');
    expect(b.out[0]).toBe(b.out[1]);
  });
});

describe('JSON file entries', () => {
  it('carry level+event, ids when present, and the project key', () => {
    const b = build();
    b.logger.setProjectKey('B');
    b.logger.log('error', 'leg.exit', 'leg ended', { ticket: 'B-1', conduction: 'c', leg: 'l' });
    b.logger.log('info', 'tick', 'no ids');
    const [a, c] = b.files.get('/l/conductor.log')!.trim().split('\n').map((x) => JSON.parse(x));
    expect(a).toEqual({ ts: FIXED.toISOString(), level: 'error', event: 'leg.exit', message: 'leg ended', ticket: 'B-1', conduction: 'c', leg: 'l', project: 'B' });
    expect(c.ticket).toBeUndefined();
    expect(c.level).toBe('info');
  });

  it('string-only call sites get ticket/conduction extracted from the text', () => {
    const b = build();
    b.logger.line(`B-12 "t": conduction ${ID}: wake`);
    const e = JSON.parse(b.files.get('/l/conductor.log')!);
    expect(e.ticket).toBe('B-12');
    expect(e.conduction).toBe(ID);
    expect(e.event).toBe('daemon');
  });

  it('the file is written BEFORE the entry is queued for shipping', () => {
    const b = build({}, true);
    b.logger.line('x');
    expect(b.order).toEqual(['file', 'ship']);
  });

  it('a shipper that throws never loses the local entry or breaks the caller', () => {
    const b = build();
    const logger = createConductorLogger({
      env: {},
      writeStdout: () => {},
      jsonFile: { append: (l) => void b.files.set('x', l) },
      shipper: { enqueue: () => { throw new Error('boom'); }, flush: async () => {}, start() {}, stop() {}, stats: () => ({ queued: 0, dropped: 0 }) },
    });
    expect(() => logger.line('a')).not.toThrow();
    expect(b.files.get('x')).toContain('"a"');
  });

  it('remote mode (HARMONY_CONDUCTOR_REMOTE=1) writes JSON to stdout; KUBERNETES_SERVICE_HOST alone does not', () => {
    const remote = build({ HARMONY_CONDUCTOR_REMOTE: '1' });
    remote.logger.log('info', 'e', 'm');
    expect(JSON.parse(remote.out[0]).event).toBe('e');
    const k8s = build({ KUBERNETES_SERVICE_HOST: '10.0.0.1' });
    k8s.logger.log('info', 'e', 'm');
    expect(k8s.out[0]).toBe(`${FIXED.toISOString()} m\n`);
  });
});

describe('redaction', () => {
  it('no secret value reaches stdout, the text copy, the JSON file or the shipper', () => {
    const env = { HARMONY_API_TOKEN: 'harmony-secret-value-1', GIT_TOKEN: 'ghs_gitsecretvalue2', MY_CUSTOM_SECRET: 'custom-secret-3333', HOME: '/home/x' };
    const b = build(env, true);
    b.logger.line('using harmony-secret-value-1 and ghs_gitsecretvalue2');
    b.logger.log('info', 'e', 'x custom-secret-3333 y', { ticket: 'B-1' });
    const all = [b.out.join(''), b.text.join(''), b.files.get('/l/conductor.log')!, JSON.stringify(b.shipped)].join('\n');
    for (const v of ['harmony-secret-value-1', 'ghs_gitsecretvalue2', 'custom-secret-3333']) expect(all).not.toContain(v);
    expect(b.out[0]).toContain('[HARMONY_API_TOKEN]');
    expect(b.out[0]).toContain('[GIT_TOKEN]');
  });

  it('ignores short values and non-secret vars', () => {
    expect(redact('abc home /x', { GH_TOKEN: 'abc', HOME: '/x' })).toBe('abc home /x');
  });
});

describe('rotation', () => {
  it('rotates at the limit, keeps N files, and removes the oldest', () => {
    const m = memFs();
    const f = createRotatingFile('/l/c.log', { maxBytes: 20, keep: 3, fs: m.fs });
    for (let i = 1; i <= 8; i++) f.append(`line-${i}-xxxxxxxx\n`); // 16 bytes each: one per file
    expect([...m.files.keys()].sort()).toEqual(['/l/c.log', '/l/c.log.1', '/l/c.log.2', '/l/c.log.3']);
    expect(m.files.get('/l/c.log')).toContain('line-8');
    expect(m.files.get('/l/c.log.1')).toContain('line-7');
    expect(m.files.get('/l/c.log.3')).toContain('line-5');
    const all = [...m.files.values()].join('');
    expect(all).not.toContain('line-1-');
    expect(all).not.toContain('line-4-');
  });

  it('defaults are 10 MB / keep 5', async () => {
    const mod = await import('./conductor-logger.js');
    expect(mod.ROTATE_BYTES).toBe(10 * 1024 * 1024);
    expect(mod.ROTATE_KEEP).toBe(5);
  });

  it('local file keeps every entry while shipping is cut (never lost)', () => {
    const b = build({}, true);
    for (let i = 0; i < 50; i++) b.logger.line(`l${i}`);
    expect(b.files.get('/l/conductor.log')!.trim().split('\n')).toHaveLength(50);
  });

  it('a failing disk never throws', () => {
    const f = createRotatingFile('/x', { fs: { ...memFs().fs, appendFileSync: () => { throw new Error('ENOSPC'); } } });
    expect(() => f.append('a\n')).not.toThrow();
  });
});
