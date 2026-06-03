import { describe, it, expect } from 'vitest';
import { getProject } from './project.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function clientReturning(row: Record<string, unknown>) {
  let selected = '';
  const builder: Record<string, unknown> = {
    select(cols: string) { selected = cols; return builder; },
    eq() { return builder; },
    single() { return Promise.resolve({ data: { __selected: selected, ...row }, error: null }); },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('get_project', () => {
  it('selects and returns the project mode', async () => {
    const data = await getProject(clientReturning({ id: 'p', mode: 'opinionated' }), 'p');
    expect((data as { __selected: string }).__selected).toContain('mode');
    expect((data as { mode: string }).mode).toBe('opinionated');
  });
});
