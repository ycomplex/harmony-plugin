import { describe, it, expect } from 'vitest';
import { loadDaemonConfig, renderTemplate } from './config.js';

const PROFILE_JSON = JSON.stringify({
  launch: "docker run --rm --name harmony-worker-{conduction_id} img worker '{ticket}'",
  reap: 'docker rm -f harmony-worker-{conduction_id}',
});

function envWith(overrides: Record<string, string | undefined> = {}) {
  return { HARMONY_DAEMON_PROFILE: '/etc/harmony/profile.json', ...overrides };
}

const readProfile = (p: string) => {
  if (p !== '/etc/harmony/profile.json') throw new Error(`unexpected path ${p}`);
  return PROFILE_JSON;
};

describe('loadDaemonConfig', () => {
  it('applies the design defaults: poll 25s, heartbeat 30s, stale 5min', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.pollMs).toBe(25000);
    expect(cfg.heartbeatMs).toBe(30000);
    expect(cfg.staleMs).toBe(300000);
  });

  it('reads the cadence knobs from env when set', () => {
    const cfg = loadDaemonConfig(
      envWith({
        HARMONY_DAEMON_POLL_MS: '10000',
        HARMONY_DAEMON_HEARTBEAT_MS: '15000',
        HARMONY_DAEMON_STALE_MS: '60000',
      }),
      readProfile,
    );
    expect(cfg.pollMs).toBe(10000);
    expect(cfg.heartbeatMs).toBe(15000);
    expect(cfg.staleMs).toBe(60000);
  });

  it('parses the profile JSON from the HARMONY_DAEMON_PROFILE path', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.profile.launch).toContain('harmony-worker-{conduction_id}');
    expect(cfg.profile.reap).toBe('docker rm -f harmony-worker-{conduction_id}');
  });

  it('throws when HARMONY_DAEMON_PROFILE is missing, naming the env var (no baked default command)', () => {
    expect(() => loadDaemonConfig({}, readProfile)).toThrow(/HARMONY_DAEMON_PROFILE/);
  });

  it('treats an EMPTY env value as unset (the B-694 empty-env-value shadow class)', () => {
    expect(() => loadDaemonConfig({ HARMONY_DAEMON_PROFILE: '' }, readProfile)).toThrow(
      /HARMONY_DAEMON_PROFILE/,
    );
    const cfg = loadDaemonConfig(envWith({ HARMONY_DAEMON_POLL_MS: '' }), readProfile);
    expect(cfg.pollMs).toBe(25000);
  });

  it('throws loudly when the profile JSON lacks a launch or reap template', () => {
    expect(() => loadDaemonConfig(envWith(), () => JSON.stringify({ launch: 'x' }))).toThrow(/reap/);
    expect(() => loadDaemonConfig(envWith(), () => JSON.stringify({ reap: 'x' }))).toThrow(/launch/);
  });

  it('throws loudly on a non-numeric cadence knob', () => {
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_POLL_MS: 'soon' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_POLL_MS/);
  });

  it('carries the optional log path from HARMONY_DAEMON_LOG', () => {
    expect(loadDaemonConfig(envWith(), readProfile).logPath).toBeUndefined();
    expect(
      loadDaemonConfig(envWith({ HARMONY_DAEMON_LOG: '/var/log/hd.log' }), readProfile).logPath,
    ).toBe('/var/log/hd.log');
  });
});

describe('renderTemplate', () => {
  it('substitutes BOTH placeholders, every occurrence', () => {
    expect(
      renderTemplate('run --name harmony-worker-{conduction_id} w {ticket} # {conduction_id}', {
        conduction_id: 'cond-1',
        ticket: 'B-696',
      }),
    ).toBe('run --name harmony-worker-cond-1 w B-696 # cond-1');
  });

  it('throws LOUDLY on an unknown {placeholder} — never silently leaves it in the command', () => {
    expect(() =>
      renderTemplate('run {conduction_id} {worker_image}', { conduction_id: 'c', ticket: 't' }),
    ).toThrow(/worker_image/);
  });

  it('leaves non-placeholder shell syntax (e.g. $HOME) untouched', () => {
    expect(renderTemplate('run --env-file $HOME/.env {ticket}', { conduction_id: 'c', ticket: 'B-1' })).toBe(
      'run --env-file $HOME/.env B-1',
    );
  });
});
