import { describe, expect, it } from 'vitest';
import { harmonyEnv } from './env.js';

describe('harmonyEnv — B-1036 EVAL_* fallback', () => {
  it('takes the EVAL_-prefixed twin when the ordinary name is unset (the eval sandbox case)', () => {
    expect(harmonyEnv('HARMONY_API_TOKEN', { EVAL_HARMONY_API_TOKEN: 'from-eval' })).toBe('from-eval');
    expect(harmonyEnv('HARMONY_SUPABASE_URL', { EVAL_HARMONY_SUPABASE_URL: 'https://x.supabase.co' })).toBe(
      'https://x.supabase.co',
    );
  });

  it('the ordinary name wins when both are set — an installed plugin never sees the twin', () => {
    expect(
      harmonyEnv('HARMONY_API_TOKEN', { HARMONY_API_TOKEN: 'ordinary', EVAL_HARMONY_API_TOKEN: 'from-eval' }),
    ).toBe('ordinary');
  });

  it('is undefined when neither is set, so callers keep their own "required" handling', () => {
    expect(harmonyEnv('HARMONY_SUPABASE_ANON_KEY', {})).toBeUndefined();
  });
});
