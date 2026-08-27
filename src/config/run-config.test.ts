// B-846: unit coverage for the run-config plumbing seam's schema + worker-side accessor. This
// ticket adds zero operator-facing behavior — these tests exist to lock in the plumbing itself
// (absence -> {}, both delivery forms, malformed-input handling) before any dependent ticket
// starts writing a real top-level key through it.

import { describe, it, expect } from 'vitest';
import {
  EMPTY_RUN_CONFIG,
  PINNED_DEFAULT_MODEL_BY_PROFILE,
  RunConfigSchema,
  getConductionId,
  getModelForGate,
  getOperatorNote,
  getRunConfig,
  isSessionResumeEnabled,
} from './run-config.js';
import type { RunConfig } from './run-config.js';

describe('RunConfigSchema', () => {
  it('accepts an empty object', () => {
    expect(RunConfigSchema.parse({})).toEqual({});
  });

  it('passes through unknown keys (forward-compat with a not-yet-known dependent-ticket key)', () => {
    expect(RunConfigSchema.parse({ steering_note: 'be terse' })).toEqual({
      steering_note: 'be terse',
    });
  });

  it('rejects a non-object payload (array, string, number, null)', () => {
    expect(() => RunConfigSchema.parse([])).toThrow();
    expect(() => RunConfigSchema.parse('nope')).toThrow();
    expect(() => RunConfigSchema.parse(42)).toThrow();
    expect(() => RunConfigSchema.parse(null)).toThrow();
  });
});

describe('RunConfigSchema session_resume (B-718)', () => {
  it('accepts { session_resume: { enabled: true } }', () => {
    expect(RunConfigSchema.parse({ session_resume: { enabled: true } })).toEqual({
      session_resume: { enabled: true },
    });
  });

  it('accepts { session_resume: { enabled: false } }', () => {
    expect(RunConfigSchema.parse({ session_resume: { enabled: false } })).toEqual({
      session_resume: { enabled: false },
    });
  });

  it('rejects a session_resume object missing the required enabled boolean', () => {
    expect(() => RunConfigSchema.parse({ session_resume: {} })).toThrow();
  });

  it('rejects a non-boolean enabled value', () => {
    expect(() => RunConfigSchema.parse({ session_resume: { enabled: 'yes' } })).toThrow();
  });

  it('still passes through unrelated unknown keys alongside session_resume', () => {
    expect(
      RunConfigSchema.parse({ session_resume: { enabled: true }, steering_note: 'be terse' }),
    ).toEqual({ session_resume: { enabled: true }, steering_note: 'be terse' });
  });
});

describe('isSessionResumeEnabled', () => {
  it('defaults to false on the empty run_config ({})', () => {
    expect(isSessionResumeEnabled(EMPTY_RUN_CONFIG)).toBe(false);
  });

  it('is false when session_resume is present but enabled is false', () => {
    expect(isSessionResumeEnabled({ session_resume: { enabled: false } })).toBe(false);
  });

  it('is true only when session_resume.enabled is explicitly true', () => {
    expect(isSessionResumeEnabled({ session_resume: { enabled: true } })).toBe(true);
  });

  it('is false when session_resume is absent but other unrelated keys are present', () => {
    expect(isSessionResumeEnabled({ steering_note: 'be terse' })).toBe(false);
  });
});

describe('RunConfigSchema note (B-743)', () => {
  it('accepts a run_config carrying a free-text note', () => {
    expect(RunConfigSchema.parse({ note: 'be terse, and skip the design gate write-up' })).toEqual({
      note: 'be terse, and skip the design gate write-up',
    });
  });

  it('accepts a note containing a single quote — the exact shape v1 used to forbid', () => {
    expect(RunConfigSchema.parse({ note: "don't touch the migration file" })).toEqual({
      note: "don't touch the migration file",
    });
  });

  it('still passes through unrelated unknown keys alongside note', () => {
    expect(
      RunConfigSchema.parse({ note: 'be terse', session_resume: { enabled: true } }),
    ).toEqual({ note: 'be terse', session_resume: { enabled: true } });
  });

  it('rejects a non-string note', () => {
    expect(() => RunConfigSchema.parse({ note: 42 })).toThrow();
  });
});

describe('getOperatorNote', () => {
  it('returns undefined on the empty run_config ({})', () => {
    expect(getOperatorNote(EMPTY_RUN_CONFIG)).toBeUndefined();
  });

  it('returns undefined when note is an empty string', () => {
    expect(getOperatorNote({ note: '' })).toBeUndefined();
  });

  it('returns the note text when present', () => {
    expect(getOperatorNote({ note: "can't stop, won't stop" })).toBe("can't stop, won't stop");
  });

  it('returns undefined when note is absent but other unrelated keys are present', () => {
    expect(getOperatorNote({ session_resume: { enabled: true } })).toBeUndefined();
  });
});

describe('getConductionId', () => {
  it('returns the plain HARMONY_CONDUCTION_ID value when set', () => {
    expect(getConductionId({ HARMONY_CONDUCTION_ID: 'cond-123' })).toBe('cond-123');
  });

  it('returns undefined when absent — never throws for absence', () => {
    expect(getConductionId({})).toBeUndefined();
  });

  it('treats an empty-string value as absent (B-694 empty-env-value shadow class)', () => {
    expect(getConductionId({ HARMONY_CONDUCTION_ID: '' })).toBeUndefined();
  });
});

describe('getRunConfig', () => {
  it('defaults to EMPTY_RUN_CONFIG ({}) when neither delivery var is set', () => {
    expect(getRunConfig({})).toEqual(EMPTY_RUN_CONFIG);
  });

  it('reads + parses the mounted file when HARMONY_RUN_CONFIG_PATH is set', () => {
    const readFileSync = (p: string) => {
      expect(p).toBe('/home/worker/.claude/run-config.json');
      return '{"steering_note":"be terse"}';
    };
    expect(
      getRunConfig({ HARMONY_RUN_CONFIG_PATH: '/home/worker/.claude/run-config.json' }, { readFileSync }),
    ).toEqual({ steering_note: 'be terse' });
  });

  it('base64-decodes + parses HARMONY_RUN_CONFIG_JSON when no path is set', () => {
    const inline = Buffer.from(JSON.stringify({ steering_note: 'be terse' }), 'utf8').toString(
      'base64',
    );
    expect(getRunConfig({ HARMONY_RUN_CONFIG_JSON: inline })).toEqual({ steering_note: 'be terse' });
  });

  it('the file path takes precedence over the inline var when both are somehow set', () => {
    const inline = Buffer.from(JSON.stringify({ from: 'inline' }), 'utf8').toString('base64');
    const readFileSync = () => JSON.stringify({ from: 'file' });
    expect(
      getRunConfig(
        { HARMONY_RUN_CONFIG_PATH: '/some/path.json', HARMONY_RUN_CONFIG_JSON: inline },
        { readFileSync },
      ),
    ).toEqual({ from: 'file' });
  });

  it('throws on malformed JSON text read from the file (never swallowed into the empty default)', () => {
    const readFileSync = () => '{ not valid json';
    expect(() =>
      getRunConfig({ HARMONY_RUN_CONFIG_PATH: '/some/path.json' }, { readFileSync }),
    ).toThrow();
  });

  it('throws on malformed base64/JSON text from the inline var', () => {
    expect(() => getRunConfig({ HARMONY_RUN_CONFIG_JSON: 'not-valid-json-once-decoded!!' })).toThrow();
  });

  it('throws when the file-delivered payload parses to a non-object (array)', () => {
    const readFileSync = () => '[]';
    expect(() =>
      getRunConfig({ HARMONY_RUN_CONFIG_PATH: '/some/path.json' }, { readFileSync }),
    ).toThrow();
  });

  it('throws when the inline-delivered payload parses to a non-object (string)', () => {
    const inline = Buffer.from('"just a string"', 'utf8').toString('base64');
    expect(() => getRunConfig({ HARMONY_RUN_CONFIG_JSON: inline })).toThrow();
  });

  it('empty-string values for both vars are treated as absent, falling through to EMPTY_RUN_CONFIG', () => {
    expect(getRunConfig({ HARMONY_RUN_CONFIG_PATH: '', HARMONY_RUN_CONFIG_JSON: '' })).toEqual(
      EMPTY_RUN_CONFIG,
    );
  });
});

describe('RunConfigSchema model (B-772)', () => {
  it('accepts a run_config carrying only model.default', () => {
    expect(RunConfigSchema.parse({ model: { default: 'claude-opus-4-1' } })).toEqual({
      model: { default: 'claude-opus-4-1' },
    });
  });

  it('accepts a run_config carrying only model.per_gate', () => {
    expect(RunConfigSchema.parse({ model: { per_gate: { build: 'claude-opus-4-1' } } })).toEqual({
      model: { per_gate: { build: 'claude-opus-4-1' } },
    });
  });

  it('accepts a run_config carrying both model.default and model.per_gate', () => {
    expect(
      RunConfigSchema.parse({
        model: { default: 'claude-sonnet-5', per_gate: { build: 'claude-opus-4-1' } },
      }),
    ).toEqual({ model: { default: 'claude-sonnet-5', per_gate: { build: 'claude-opus-4-1' } } });
  });

  it('accepts an empty model object', () => {
    expect(RunConfigSchema.parse({ model: {} })).toEqual({ model: {} });
  });

  it('accepts a per_gate key this build does not recognize as a Gate (forward-compat parse)', () => {
    expect(
      RunConfigSchema.parse({ model: { per_gate: { 'some-future-gate': 'claude-opus-4-1' } } }),
    ).toEqual({ model: { per_gate: { 'some-future-gate': 'claude-opus-4-1' } } });
  });

  it('rejects a non-string model.default', () => {
    expect(() => RunConfigSchema.parse({ model: { default: 42 } })).toThrow();
  });

  it('rejects a non-string value inside model.per_gate', () => {
    expect(() => RunConfigSchema.parse({ model: { per_gate: { build: 42 } } })).toThrow();
  });

  it('still passes through unrelated unknown keys alongside model', () => {
    expect(
      RunConfigSchema.parse({ model: { default: 'claude-sonnet-5' }, note: 'be terse' }),
    ).toEqual({ model: { default: 'claude-sonnet-5' }, note: 'be terse' });
  });
});

describe('getModelForGate (B-772 three-level fallback)', () => {
  const PROD_ENV = { HARMONY_SUPABASE_URL: 'https://eioxsunvhakmelhanmnn.supabase.co' };
  const STAGING_ENV = { HARMONY_SUPABASE_URL: 'https://meqkdgncdzromunylyxf.supabase.co' };

  it('level 1: an explicit per_gate override for the resolved gate wins over everything else', () => {
    const runConfig: RunConfig = {
      model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
    };
    expect(getModelForGate(runConfig, 'build', PROD_ENV)).toBe('per-gate-build-model');
  });

  it('level 1 only applies to the gate it names — a different gate falls through to level 2', () => {
    const runConfig: RunConfig = {
      model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
    };
    expect(getModelForGate(runConfig, 'release', PROD_ENV)).toBe('run-default-model');
  });

  it('level 1 is skipped entirely when gate is null (e.g. a terminal-state ticket)', () => {
    const runConfig: RunConfig = {
      model: { default: 'run-default-model', per_gate: { build: 'per-gate-build-model' } },
    };
    expect(getModelForGate(runConfig, null, PROD_ENV)).toBe('run-default-model');
  });

  it('level 2: model.default applies when no per_gate override matches', () => {
    const runConfig: RunConfig = { model: { default: 'run-default-model' } };
    expect(getModelForGate(runConfig, 'clarify', PROD_ENV)).toBe('run-default-model');
  });

  it('level 3: an empty run_config falls through to the pinned per-deployment-profile default (prod)', () => {
    expect(getModelForGate(EMPTY_RUN_CONFIG, 'build', PROD_ENV)).toBe(
      PINNED_DEFAULT_MODEL_BY_PROFILE.prod,
    );
  });

  it('level 3: resolves the STAGING pin when HARMONY_SUPABASE_URL points at the staging project', () => {
    expect(getModelForGate(EMPTY_RUN_CONFIG, 'build', STAGING_ENV)).toBe(
      PINNED_DEFAULT_MODEL_BY_PROFILE.staging,
    );
  });

  it('level 3: an empty run_config with a null gate still falls through to the pinned default', () => {
    expect(getModelForGate(EMPTY_RUN_CONFIG, null, PROD_ENV)).toBe(
      PINNED_DEFAULT_MODEL_BY_PROFILE.prod,
    );
  });

  it('level 3: an unrecognized/custom Supabase URL falls back to the prod pin, never undefined', () => {
    expect(
      getModelForGate(EMPTY_RUN_CONFIG, 'build', { HARMONY_SUPABASE_URL: 'https://example.com' }),
    ).toBe(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('level 3: a malformed Supabase URL degrades to the prod pin rather than throwing', () => {
    expect(
      getModelForGate(EMPTY_RUN_CONFIG, 'build', { HARMONY_SUPABASE_URL: 'not a url' }),
    ).toBe(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('defaults env to process.env when no third argument is given (never throws)', () => {
    expect(() => getModelForGate(EMPTY_RUN_CONFIG, 'build')).not.toThrow();
    expect(typeof getModelForGate(EMPTY_RUN_CONFIG, 'build')).toBe('string');
  });
});

describe('PINNED_DEFAULT_MODEL_BY_PROFILE', () => {
  it('carries an explicit, non-empty pin for both known deployment profiles', () => {
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.prod).toEqual(expect.any(String));
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.prod.length).toBeGreaterThan(0);
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.staging).toEqual(expect.any(String));
    expect(PINNED_DEFAULT_MODEL_BY_PROFILE.staging.length).toBeGreaterThan(0);
  });
});
