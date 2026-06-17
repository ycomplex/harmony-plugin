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

  it('selects the owning-workspace agent_trust embed', async () => {
    const data = await getProject(clientReturning({ id: 'p', mode: 'opinionated' }), 'p');
    expect((data as { __selected: string }).__selected).toContain('agent_trust');
    expect((data as { __selected: string }).__selected).toContain('workspaces');
  });

  it('resolves the dial to balanced when the workspace has the empty {} default', async () => {
    const data = await getProject(
      clientReturning({ id: 'p', mode: 'opinionated', workspace: { agent_trust: {} } }),
      'p',
    );
    expect((data as { agent_trust: { level: string } }).agent_trust.level).toBe('balanced');
  });

  it('surfaces a cautious dial level (the conductor kill-switch)', async () => {
    const data = await getProject(
      clientReturning({ id: 'p', mode: 'opinionated', workspace: { agent_trust: { level: 'cautious' } } }),
      'p',
    );
    expect((data as { agent_trust: { level: string } }).agent_trust.level).toBe('cautious');
  });

  it('surfaces an autonomous dial level + overrides', async () => {
    const data = await getProject(
      clientReturning({
        id: 'p',
        mode: 'opinionated',
        workspace: { agent_trust: { level: 'autonomous', overrides: { require_human_one_way_decisions: true } } },
      }),
      'p',
    );
    const trust = (data as { agent_trust: { level: string; overrides: Record<string, unknown> } }).agent_trust;
    expect(trust.level).toBe('autonomous');
    expect(trust.overrides.require_human_one_way_decisions).toBe(true);
  });

  it('normalizes the embed when PostgREST returns the workspace as a single-element array', async () => {
    const data = await getProject(
      clientReturning({ id: 'p', mode: 'opinionated', workspace: [{ agent_trust: { level: 'autonomous' } }] }),
      'p',
    );
    expect((data as { agent_trust: { level: string } }).agent_trust.level).toBe('autonomous');
  });

  it('defaults to balanced when the embed is absent or an unknown level', async () => {
    const noWs = await getProject(clientReturning({ id: 'p', mode: 'opinionated' }), 'p');
    expect((noWs as { agent_trust: { level: string } }).agent_trust.level).toBe('balanced');

    const badLevel = await getProject(
      clientReturning({ id: 'p', mode: 'opinionated', workspace: { agent_trust: { level: 'banana' } } }),
      'p',
    );
    expect((badLevel as { agent_trust: { level: string } }).agent_trust.level).toBe('balanced');
  });

  it('strips the raw workspace embed from the returned project', async () => {
    const data = await getProject(
      clientReturning({ id: 'p', mode: 'opinionated', workspace: { agent_trust: { level: 'cautious' } } }),
      'p',
    );
    expect((data as Record<string, unknown>).workspace).toBeUndefined();
  });
});
