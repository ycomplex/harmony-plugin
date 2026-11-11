import { describe, it, expect } from 'vitest';
import { decideStop, type StopGateRow } from './stop-gate.js';
const nowMs = Date.parse('2026-11-10T15:42:00Z');
const marker = { kind: 'ci', ref: '12345', since: '2026-11-10T15:41:52Z', first_since: '2026-11-10T15:41:52Z' };
const row: StopGateRow = { workflow_state: 'Planned', awaiting_human_input: false, waiting_on: marker };
const decide = (r: StopGateRow = row, start?: string, blocksSoFar = 0) => decideStop({ ticket: 'B-1440', row: r, nowMs, legStartedAtMs: start ? Date.parse(start) : undefined, blocksSoFar, stopHookActive: blocksSoFar > 0 });
describe('B-1440 wait boundaries and diagnostics', () => {
  it.each(['2026-11-10T16:00:00Z', '2026-11-10T16:42:00Z', 'invalid'])('ignores future/invalid breadcrumb %s independently of writer', start => expect(decide(row, start).action).toBe('allow'));
  it('accepts a marker declared now with a breadcrumb one hour in the future', () => {
    expect(decide({ ...row, waiting_on: { ...marker, since: '2026-11-10T15:42:00Z' } }, '2026-11-10T16:42:00Z').action).toBe('allow');
  });
  it('retains earlier-leg rejection for a true start', () => expect(decide(row, '2026-11-10T15:41:53Z')).toMatchObject({ action: 'block', message: expect.stringContaining('older than leg start') }));
  it('a skipped resume stamp still accepts a current wait, but cannot distinguish a previous-leg wait after the old start', () => {
    const oldStart = '2026-11-10T15:18:35Z';
    expect(decide(row, oldStart).action).toBe('allow');
    expect(decide({ ...row, waiting_on: { ...marker, since: '2026-11-10T15:20:00Z' } }, oldStart).action).toBe('allow');
  });
  it('works with the full row fallback', () => expect(decide({ ...row, waiting_on: undefined, field_values: { waiting_on: marker } }, '2026-11-10T16:00:00Z').action).toBe('allow'));
  it.each([
    [undefined, 'no marker'],
    [{ ...marker, since: 'invalid' }, 'malformed/unparseable'],
    [{ ...marker, first_since: '2026-11-09T15:42:00Z' }, 'past 24 h ceiling'],
  ])('explains a discounted marker', (waiting_on, reason) => expect(decide({ ...row, waiting_on })).toMatchObject({ action: 'block', message: expect.stringContaining(reason) }));
  it('prints only sanitized marker fields, including on capped degradation', () => {
    const secret = 'sk-synthetic-secret-do-not-print';
    for (const blocks of [0, 2]) {
      const d = decide({ ...row, waiting_on: { kind: secret, ref: secret, since: secret, extra: secret }, field_values: { arbitrary: secret } }, undefined, blocks);
      expect(d.action).toBe(blocks ? 'fail-open' : 'block');
      const message = 'message' in d ? d.message : '';
      expect(message).toContain('kind=[redacted], ref=[redacted], since=[redacted]');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('extra=');
    }
  });
  it.each(['pr#42-checks', 'pr#1', 'pr#42', 'main', 'staging', 'codex:gpt-6.1-sol', 'feature/wait_fix-1', 'https://github.com/ycomplex/harmony-plugin/actions/runs/12345'])('prints legitimate ref %s verbatim', ref => {
    for (const blocks of [0, 2]) {
      const d = decide({ ...row, waiting_on: { ...marker, ref } }, '2026-11-10T15:41:53Z', blocks);
      expect('message' in d && d.message).toContain(`ref=${ref}, since=`);
    }
  });
  it.each(['ghp_synthetic-token', 'gho_synthetic-token', 'github_pat_synthetic-token', 'sk-synthetic-token', 'eyJsynthetic-token', 'a'.repeat(40), 'AbCd0123+/'.repeat(4), 'with space', 'with\nnewline', 'with\u001bcontrol', 'pr#' + 'x-'.repeat(40)])('redacts unsafe ref %j', ref => {
    for (const blocks of [0, 2]) {
      const d = decide({ ...row, waiting_on: { ...marker, ref } }, '2026-11-10T15:41:53Z', blocks);
      expect('message' in d && d.message).toContain('ref=[redacted], since=');
      expect('message' in d && d.message).not.toContain(ref);
    }
  });
  it('redacts a Figma OAuth (figu_) ref whole, even though its shape passes the printable allowlist (B-1452)', () => {
    const ref = ['fi', 'gu_', 'Ab3_x9-Qr7_kL2'].join('');
    for (const blocks of [0, 2]) {
      const d = decide({ ...row, waiting_on: { ...marker, ref } }, '2026-11-10T15:41:53Z', blocks);
      expect('message' in d && d.message).toContain('ref=[redacted], since=');
      expect('message' in d && d.message).not.toContain(ref);
      expect('message' in d && d.message).not.toContain(['fi', 'gu_'].join(''));
    }
  });
});
