// B-846: unit coverage for the run-config plumbing seam's schema + worker-side accessor. This
// ticket adds zero operator-facing behavior — these tests exist to lock in the plumbing itself
// (absence -> {}, both delivery forms, malformed-input handling) before any dependent ticket
// starts writing a real top-level key through it.

import { describe, it, expect } from 'vitest';
import { EMPTY_RUN_CONFIG, RunConfigSchema, getConductionId, getRunConfig } from './run-config.js';

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
