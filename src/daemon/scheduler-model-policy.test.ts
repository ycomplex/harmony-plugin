// B-1170: the conductor config's model_policy folds into the run_config the daemon hands the worker —
// ABSENT keys only, into BOTH {run_config_json} and {model} — so the worker's own re-resolution agrees.
import { describe, expect, it } from 'vitest';
import { getModelForGate, type RunConfig } from '../config/run-config.js';
import { applyModelPolicy, templateVars, type DaemonTask } from './scheduler.js';
import type { ConductionRecord } from '../tools/conduction-record.js';

const row = (run_config: unknown): ConductionRecord =>
  ({ id: 'c1', task_id: 't1', run_config }) as unknown as ConductionRecord;
const task = (workflow_state: string): DaemonTask => ({ id: 't1', task_number: 7, workflow_state }) as unknown as DaemonTask;
const decode = (b64: string): RunConfig => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

describe('model policy fold (templateVars)', () => {
  it('fills model.default and per_gate when the conduction names no model', () => {
    const v = templateVars(row({}), task('Planned'), 'B', undefined, { default: 'policy-default', per_gate: { build: 'policy-build' } });
    const rc = decode(v.run_config_json);
    expect(rc.model).toEqual({ default: 'policy-default', per_gate: { build: 'policy-build' } });
    // {model} and what the worker re-resolves from the rendered run_config are the SAME value.
    expect(v.model).toBe(getModelForGate(rc, 'build'));
    expect(v.model).toBe('policy-build');
  });

  it('uses the policy default for a gate the policy has no per_gate entry for', () => {
    const v = templateVars(row({}), task('Planned'), 'B', undefined, { default: 'policy-default' });
    expect(v.model).toBe('policy-default');
    expect(decode(v.run_config_json).model).toEqual({ default: 'policy-default' });
  });

  it('never overrides an explicit conduction default', () => {
    const rc = { model: { default: 'mine' } };
    const v = templateVars(row(rc), task('Planned'), 'B', undefined, { default: 'policy', per_gate: { build: 'policy-build' } });
    expect(v.model).toBe('mine');
    expect(decode(v.run_config_json)).toEqual(rc);
  });

  it('never overrides an explicit per_gate entry for this gate, and fills nothing around it', () => {
    const rc = { model: { per_gate: { build: 'mine' } } };
    const v = templateVars(row(rc), task('Planned'), 'B', undefined, { default: 'policy' });
    expect(v.model).toBe('mine');
    expect(decode(v.run_config_json)).toEqual(rc);
  });

  it("a conduction's per_gate for ANOTHER gate survives and wins per key when the policy fills", () => {
    const v = templateVars(row({ model: { per_gate: { design: 'mine' } } }), task('Planned'), 'B', undefined, {
      default: 'policy',
      per_gate: { design: 'policy-design', verify: 'policy-verify' },
    });
    expect(decode(v.run_config_json).model).toEqual({ default: 'policy', per_gate: { design: 'mine', verify: 'policy-verify' } });
    expect(v.model).toBe('policy');
  });

  it('leaves the other run_config keys alone', () => {
    const v = templateVars(row({ note: "it's", fast_track: true }), task('Planned'), 'B', undefined, { default: 'p' });
    expect(decode(v.run_config_json)).toMatchObject({ note: "it's", fast_track: true, model: { default: 'p' } });
  });

  it('absent or empty policy is byte-identical to today', () => {
    for (const rc of [{}, { model: { default: 'x' } }, { note: 'n' }]) {
      const before = templateVars(row(rc), task('Planned'), 'B');
      expect(templateVars(row(rc), task('Planned'), 'B', undefined, undefined)).toEqual(before);
      expect(templateVars(row(rc), task('Planned'), 'B', undefined, {})).toEqual(before);
    }
    const r = row({ note: 'n' });
    expect(templateVars(r, task('Planned'), 'B').run_config_json).toBe(
      Buffer.from(JSON.stringify(r.run_config), 'utf8').toString('base64'),
    );
  });

  it('does not hand a Claude policy to a non-Claude run', () => {
    const rc = { agent: { adapter: 'codex' } };
    expect(applyModelPolicy(rc as RunConfig, 'build', { default: 'claude-x' })).toBe(rc);
  });

  it('applyModelPolicy returns the same object when nothing applies', () => {
    const rc = {} as RunConfig;
    expect(applyModelPolicy(rc, 'build', undefined)).toBe(rc);
  });
});

describe('B-1185 first-launch model spelling', () => {
  const catalog = [{ alias: 'codex:gpt-6.1-sol', model_id: 'gpt-6.1-sol', agent: 'codex', label: 'Sol', active: true, verified_at: null, context_budget_bytes: 1 }];
  it.each(['codex:gpt-6.1-sol', 'gpt-6.1-sol'])('launches %s as the runtime id for defaults and overrides', (model) => {
    for (const config of [{ default: model }, { default: 'other', per_gate: { build: model } }]) {
      const r = row({ agent: { adapter: 'codex' }, model: config });
      const v = templateVars(r, task('Planned'), 'B', undefined, undefined, catalog);
      expect(v.model).toBe('gpt-6.1-sol');
      expect(getModelForGate(decode(v.run_config_json), 'build', {}, catalog)).toBe(v.model);
      expect(templateVars(r, task('Planned'), 'B').model).toBe(model);
    }
  });
});
