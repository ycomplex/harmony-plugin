import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveEnvironment } from './environment.js';

// B-800: writes a throwaway deployment config JSON file for the KNOWN_REFS-merge tests below.
function makeDeploymentConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'b800-deployment-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'deployment.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

// A module URL with no .claude-plugin/plugin.json anywhere above it, so the
// version fallback bottoms out at null instead of finding this repo's manifest.
const NOWHERE_URL = 'file:///nonexistent-b488/a/b/c/module.js';

const tempDirs: string[] = [];
function makePluginRoot(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'b488-env-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return root;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveEnvironment', () => {
  it('defaults to the prod Supabase project when HARMONY_SUPABASE_URL is unset', async () => {
    const env = await resolveEnvironment({}, NOWHERE_URL);
    expect(env.supabase_url).toBe('https://eioxsunvhakmelhanmnn.supabase.co');
    expect(env.supabase_project_ref).toBe('eioxsunvhakmelhanmnn');
    expect(env.target).toBe('prod');
  });

  it('maps the staging ref to target staging when HARMONY_SUPABASE_URL points there', async () => {
    const env = await resolveEnvironment(
      { HARMONY_SUPABASE_URL: 'https://meqkdgncdzromunylyxf.supabase.co' },
      NOWHERE_URL,
    );
    expect(env.supabase_url).toBe('https://meqkdgncdzromunylyxf.supabase.co');
    expect(env.supabase_project_ref).toBe('meqkdgncdzromunylyxf');
    expect(env.target).toBe('staging');
  });

  it('maps an unrecognized URL to target custom with its ref extracted', async () => {
    const env = await resolveEnvironment(
      { HARMONY_SUPABASE_URL: 'https://somelocalproject.supabase.co' },
      NOWHERE_URL,
    );
    expect(env.supabase_project_ref).toBe('somelocalproject');
    expect(env.target).toBe('custom');
  });

  it('degrades a malformed URL to target custom with an empty ref (never throws)', async () => {
    const env = await resolveEnvironment({ HARMONY_SUPABASE_URL: 'not a url' }, NOWHERE_URL);
    expect(env.supabase_project_ref).toBe('');
    expect(env.target).toBe('custom');
    expect(env.plugin_version).toBeNull();
  });

  it('reads plugin_version from $CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json first', async () => {
    const root = makePluginRoot('9.9.9');
    const env = await resolveEnvironment({ CLAUDE_PLUGIN_ROOT: root }, NOWHERE_URL);
    expect(env.plugin_version).toBe('9.9.9');
  });

  it('falls back to the manifest relative to the running module (dist/index.js layout)', async () => {
    const root = makePluginRoot('8.8.8');
    // Simulate the bundled entry point: <root>/dist/index.js, manifest one level up.
    const moduleUrl = pathToFileURL(join(root, 'dist', 'index.js')).href;
    const env = await resolveEnvironment({}, moduleUrl);
    expect(env.plugin_version).toBe('8.8.8');
  });

  it('prefers CLAUDE_PLUGIN_ROOT over the module-relative manifest, but falls through when its manifest is unreadable', async () => {
    const root = makePluginRoot('7.7.7');
    const moduleUrl = pathToFileURL(join(root, 'dist', 'bin', 'harmony.js')).href;
    // A bogus root must not mask the module-relative fallback (two levels up for dist/bin/*).
    const env = await resolveEnvironment({ CLAUDE_PLUGIN_ROOT: '/nonexistent-b488-root' }, moduleUrl);
    expect(env.plugin_version).toBe('7.7.7');
  });

  it('returns plugin_version null when no manifest is reachable', async () => {
    const env = await resolveEnvironment({}, NOWHERE_URL);
    expect(env.plugin_version).toBeNull();
  });

  // B-800: KNOWN_REFS is now merged with a deployment config's launcher.supabase_refs.
  it('behaves exactly as before when no deployment config is present at HARMONY_DEPLOYMENT_CONFIG', async () => {
    const env = await resolveEnvironment(
      {
        HARMONY_SUPABASE_URL: 'https://meqkdgncdzromunylyxf.supabase.co',
        HARMONY_DEPLOYMENT_CONFIG: '/nonexistent-b800/deployment.json',
      },
      NOWHERE_URL,
    );
    expect(env.target).toBe('staging');
  });

  it('honors a deployment config ref, MERGED with (not replacing) the two baked-in defaults', async () => {
    const configPath = makeDeploymentConfig({
      launcher: { supabase_refs: { somecustomref: 'staging' } },
    });

    // The new ref from the config resolves.
    const customEnv = await resolveEnvironment(
      {
        HARMONY_SUPABASE_URL: 'https://somecustomref.supabase.co',
        HARMONY_DEPLOYMENT_CONFIG: configPath,
      },
      NOWHERE_URL,
    );
    expect(customEnv.target).toBe('staging');

    // The two baked-in defaults still resolve — the config REF MAP MERGES, it does not replace.
    const prodEnv = await resolveEnvironment(
      { HARMONY_SUPABASE_URL: 'https://eioxsunvhakmelhanmnn.supabase.co', HARMONY_DEPLOYMENT_CONFIG: configPath },
      NOWHERE_URL,
    );
    expect(prodEnv.target).toBe('prod');
  });

  it('B-743: conduction_id is null outside a conduction (no HARMONY_CONDUCTION_ID set)', async () => {
    const env = await resolveEnvironment({}, NOWHERE_URL);
    expect(env.conduction_id).toBeNull();
  });

  it('B-743: conduction_id reflects HARMONY_CONDUCTION_ID when set', async () => {
    const env = await resolveEnvironment({ HARMONY_CONDUCTION_ID: 'cond-743' }, NOWHERE_URL);
    expect(env.conduction_id).toBe('cond-743');
  });

  it('B-743: operator_note is null when no run_config delivery var is set', async () => {
    const env = await resolveEnvironment({}, NOWHERE_URL);
    expect(env.operator_note).toBeNull();
  });

  it("B-743: operator_note reads the base64-decoded HARMONY_RUN_CONFIG_JSON's note key", async () => {
    const inline = Buffer.from(
      JSON.stringify({ note: "don't touch the migration file" }),
      'utf8',
    ).toString('base64');
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: inline }, NOWHERE_URL);
    expect(env.operator_note).toBe("don't touch the migration file");
  });

  it('B-743: operator_note is null when run_config has no note key', async () => {
    const inline = Buffer.from(JSON.stringify({ session_resume: { enabled: true } }), 'utf8').toString(
      'base64',
    );
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: inline }, NOWHERE_URL);
    expect(env.operator_note).toBeNull();
  });

  it('B-743: operator_note degrades to null (never throws) on a malformed HARMONY_RUN_CONFIG_JSON — get_project must never break', async () => {
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: 'not-valid-base64-json!!' }, NOWHERE_URL);
    expect(env.operator_note).toBeNull();
    expect(env.conduction_id).toBeNull(); // sanity: the rest of the block still resolves
  });

  it('degrades to the baked-in defaults (never throws) when the deployment config is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b800-deployment-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'deployment.json');
    writeFileSync(configPath, '{ not valid json');

    const env = await resolveEnvironment(
      { HARMONY_SUPABASE_URL: 'https://eioxsunvhakmelhanmnn.supabase.co', HARMONY_DEPLOYMENT_CONFIG: configPath },
      NOWHERE_URL,
    );
    expect(env.target).toBe('prod');
  });

  it('B-773: auto_approve_gates is null when no run_config delivery var is set', async () => {
    const env = await resolveEnvironment({}, NOWHERE_URL);
    expect(env.auto_approve_gates).toBeNull();
  });

  it("B-773: auto_approve_gates reads the base64-decoded HARMONY_RUN_CONFIG_JSON's auto_approve_gates key", async () => {
    const inline = Buffer.from(
      JSON.stringify({ auto_approve_gates: ['clarify', 'build'] }),
      'utf8',
    ).toString('base64');
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: inline }, NOWHERE_URL);
    expect(env.auto_approve_gates).toEqual(['clarify', 'build']);
  });

  it('B-773: auto_approve_gates is null when run_config has no auto_approve_gates key', async () => {
    const inline = Buffer.from(JSON.stringify({ session_resume: { enabled: true } }), 'utf8').toString(
      'base64',
    );
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: inline }, NOWHERE_URL);
    expect(env.auto_approve_gates).toBeNull();
  });

  it('B-773: auto_approve_gates is null when run_config carries an empty auto_approve_gates array', async () => {
    const inline = Buffer.from(JSON.stringify({ auto_approve_gates: [] }), 'utf8').toString('base64');
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: inline }, NOWHERE_URL);
    expect(env.auto_approve_gates).toBeNull();
  });

  it('B-773: auto_approve_gates degrades to null (never throws) on a malformed HARMONY_RUN_CONFIG_JSON — get_project must never break', async () => {
    const env = await resolveEnvironment({ HARMONY_RUN_CONFIG_JSON: 'not-valid-base64-json!!' }, NOWHERE_URL);
    expect(env.auto_approve_gates).toBeNull();
    expect(env.operator_note).toBeNull(); // sanity: the rest of the block still resolves
  });
});

// =================================================================================================
// B-892: the gate-boundary re-read. resolveEnvironment now prefers the LIVE conductions.run_config
// row over the frozen launch env whenever it has both a conduction id and a client.
// =================================================================================================

/** A stand-in for the one call shape getConduction makes:
 *  `client.from('conductions').select(COLS).eq('id', id).maybeSingle()`. `result` is either the
 *  PostgREST-shaped `{ data, error }` envelope or a thrower (the transport-blew-up case). */
function fakeClient(
  result: { data: unknown; error: unknown } | 'throws',
): { client: SupabaseClient; fromSpy: ReturnType<typeof vi.fn> } {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => {
    if (result === 'throws') throw new Error('transport exploded');
    return result;
  };
  const fromSpy = vi.fn(() => chain);
  return { client: { from: fromSpy } as unknown as SupabaseClient, fromSpy };
}

function rowWith(run_config: unknown): { data: unknown; error: unknown } {
  return { data: { id: 'cond-892', task_id: 't-1', status: 'active', run_config }, error: null };
}

// The launch-env payload every test below contrasts the row against.
const ENV_PAYLOAD = Buffer.from(
  JSON.stringify({ note: 'the FROZEN launch-env note', auto_approve_gates: ['clarify'] }),
  'utf8',
).toString('base64');

const CONDUCTED_ENV = {
  HARMONY_CONDUCTION_ID: 'cond-892',
  HARMONY_RUN_CONFIG_JSON: ENV_PAYLOAD,
};

describe('B-892 resolveEnvironment gate-boundary run_config re-read', () => {
  it('prefers the conduction row over the launch env for operator_note and auto_approve_gates', async () => {
    const { client } = fakeClient(
      rowWith({ note: 'the EDITED row note', auto_approve_gates: ['design', 'build'] }),
    );
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    expect(env.conduction_id).toBe('cond-892');
    expect(env.operator_note).toBe('the EDITED row note');
    expect(env.auto_approve_gates).toEqual(['design', 'build']);
  });

  it('prefers the row WHOLE — an operator who cleared the note in the row clears it here, never re-reads the stale env note', async () => {
    const { client } = fakeClient(rowWith({}));
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    expect(env.operator_note).toBeNull();
    expect(env.auto_approve_gates).toBeNull();
  });

  it('falls back to the launch env when the row query errors', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'permission denied' } });
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    expect(env.operator_note).toBe('the FROZEN launch-env note');
    expect(env.auto_approve_gates).toEqual(['clarify']);
  });

  it('falls back to the launch env when the conduction row does not exist', async () => {
    const { client } = fakeClient({ data: null, error: null });
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    expect(env.operator_note).toBe('the FROZEN launch-env note');
    expect(env.auto_approve_gates).toEqual(['clarify']);
  });

  it('falls back to the launch env (never throws) when the client itself blows up', async () => {
    const { client } = fakeClient('throws');
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    expect(env.operator_note).toBe('the FROZEN launch-env note');
    expect(env.auto_approve_gates).toEqual(['clarify']);
  });

  it('degrades (never throws) when the row carries a MALFORMED run_config payload', async () => {
    const { client } = fakeClient(rowWith({ note: 42, auto_approve_gates: 'not-an-array' }));
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    // Unparseable row => no answer from the row => the launch env still resolves.
    expect(env.operator_note).toBe('the FROZEN launch-env note');
    expect(env.auto_approve_gates).toEqual(['clarify']);
  });

  it('degrades (never throws) when the row carries a run_config that is not an object at all', async () => {
    const { client } = fakeClient(rowWith('garbage'));
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL, client);
    expect(env.operator_note).toBe('the FROZEN launch-env note');
  });

  it('degrades to null (never throws) when BOTH the row and the launch env are unreadable', async () => {
    const { client } = fakeClient('throws');
    const env = await resolveEnvironment(
      { HARMONY_CONDUCTION_ID: 'cond-892', HARMONY_RUN_CONFIG_JSON: 'not-valid-base64-json!!' },
      NOWHERE_URL,
      client,
    );
    expect(env.operator_note).toBeNull();
    expect(env.auto_approve_gates).toBeNull();
    expect(env.conduction_id).toBe('cond-892'); // sanity: the rest of the block still resolves
  });

  it('with NO conduction id, never touches the DB and behaves exactly as before (launch env only)', async () => {
    const { client, fromSpy } = fakeClient(rowWith({ note: 'the EDITED row note' }));
    const env = await resolveEnvironment(
      { HARMONY_RUN_CONFIG_JSON: ENV_PAYLOAD },
      NOWHERE_URL,
      client,
    );
    expect(fromSpy).not.toHaveBeenCalled();
    expect(env.conduction_id).toBeNull();
    expect(env.operator_note).toBe('the FROZEN launch-env note');
    expect(env.auto_approve_gates).toEqual(['clarify']);
  });

  it('with a conduction id but NO client (an MCP session outside a conduction-aware caller), uses the launch env', async () => {
    const env = await resolveEnvironment(CONDUCTED_ENV, NOWHERE_URL);
    expect(env.operator_note).toBe('the FROZEN launch-env note');
    expect(env.auto_approve_gates).toEqual(['clarify']);
  });
});
