import { describe, it, expect } from 'vitest';
import { getWorkspaceModelPolicy } from './model-policy.js';

type Result = { data: unknown; error: { code?: string; message?: string } | null };

/** A fake client recording the projects read and resolving `.maybeSingle()` to `result`. */
function fakeClient(result: Result) {
  const calls: { table?: string; cols?: string; eq?: [string, unknown] } = {};
  const chain = {
    select(cols: string) {
      calls.cols = cols;
      return chain;
    },
    eq(col: string, val: unknown) {
      calls.eq = [col, val];
      return chain;
    },
    maybeSingle: async () => result,
    single: async () => result,
  };
  const client = {
    from(table: string) {
      calls.table = table;
      return chain;
    },
  };
  return { client: client as never, calls };
}

describe('getWorkspaceModelPolicy (B-1346)', () => {
  it('reads the owning workspace model_policy through the projects embed', async () => {
    const { client, calls } = fakeClient({
      data: { workspace: { model_policy: { allowed_aliases: ['claude-opus-5', 'codex:gpt-6.1-sol'] } } },
      error: null,
    });
    await expect(getWorkspaceModelPolicy(client, 'proj-1')).resolves.toEqual({
      allowed: ['claude-opus-5', 'codex:gpt-6.1-sol'],
    });
    expect(calls.table).toBe('projects');
    expect(calls.cols).toBe('workspace:workspaces!projects_workspace_id_fkey(model_policy)');
    expect(calls.eq).toEqual(['id', 'proj-1']);
  });

  it('accepts the embed as a single-element array', async () => {
    const { client } = fakeClient({
      data: { workspace: [{ model_policy: { allowed_aliases: ['claude-opus-5'] } }] },
      error: null,
    });
    await expect(getWorkspaceModelPolicy(client, 'proj-1')).resolves.toEqual({ allowed: ['claude-opus-5'] });
  });

  it.each([
    ['42703', { code: '42703', message: 'column workspaces.model_policy does not exist' }],
    ['PGRST204', { code: 'PGRST204', message: "Could not find the 'model_policy' column" }],
  ])('a missing-column error (%s) means no restriction', async (_label, error) => {
    const { client } = fakeClient({ data: null, error });
    await expect(getWorkspaceModelPolicy(client, 'proj-1')).resolves.toEqual({ allowed: [] });
  });

  it('any other error propagates', async () => {
    const { client } = fakeClient({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(getWorkspaceModelPolicy(client, 'proj-1')).rejects.toThrow('permission denied');
  });

  it.each([
    ['no row', null],
    ['no workspace', { workspace: null }],
    ['a null policy', { workspace: { model_policy: null } }],
    ['an absent policy', { workspace: {} }],
    ['an empty policy object', { workspace: { model_policy: {} } }],
    ['a non-array allowed_aliases', { workspace: { model_policy: { allowed_aliases: 'claude-opus-5' } } }],
    ['an empty allowed_aliases', { workspace: { model_policy: { allowed_aliases: [] } } }],
  ])('%s means no restriction', async (_label, data) => {
    const { client } = fakeClient({ data, error: null });
    await expect(getWorkspaceModelPolicy(client, 'proj-1')).resolves.toEqual({ allowed: [] });
  });

  it('a null client means no restriction', async () => {
    await expect(getWorkspaceModelPolicy(null, 'proj-1')).resolves.toEqual({ allowed: [] });
    await expect(getWorkspaceModelPolicy(undefined, 'proj-1')).resolves.toEqual({ allowed: [] });
  });
});
