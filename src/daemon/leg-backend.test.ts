import { describe, expect, it } from 'vitest';
import { deriveBackendTag, resolveBackendTemplates } from './leg-backend.js';
import {
  isMissingLegBackendColumn,
  readConductionLegBackend,
  writeConductionLegBackend,
} from '../tools/conduction-record.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const p = (script: string) => ({ launch: `bash "$HARMONY_PLUGIN_DIR/container/${script}" {conduction_id}`, reap: `reap-${script}`, probe: `probe-${script}` });

describe('B-1171 deriveBackendTag', () => {
  it('derives the tag from the shipped launch wrapper, else the profile name', () => {
    expect(deriveBackendTag('x', p('gke/gke-worker-launch.sh'))).toBe('gke');
    expect(deriveBackendTag('x', p('cloud-worker-launch.sh'))).toBe('cloud');
    expect(deriveBackendTag('x', p('docker-worker-launch.sh'))).toBe('docker');
    expect(deriveBackendTag('x', p('docker-host-worker-launch.sh'))).toBe('docker-host');
    expect(deriveBackendTag('custom', { launch: 'my-launcher' })).toBe('custom');
    expect(deriveBackendTag(undefined, { launch: 'my-launcher' })).toBe('unnamed');
  });

  it('resolves a recorded tag to the owning profile\'s reap/probe, or null', () => {
    const profiles = { a: p('gke/gke-worker-launch.sh'), b: p('cloud-worker-launch.sh') };
    expect(resolveBackendTemplates(profiles, 'cloud')).toEqual({ reap: 'reap-cloud-worker-launch.sh', probe: 'probe-cloud-worker-launch.sh' });
    expect(resolveBackendTemplates(profiles, 'docker')).toBeNull();
    expect(resolveBackendTemplates(undefined, 'gke')).toBeNull();
  });
});

describe('B-1171 leg_backend accessors tolerate a missing column', () => {
  it('recognises the missing-column error shapes and nothing else', () => {
    expect(isMissingLegBackendColumn({ code: '42703', message: 'column conductions.leg_backend does not exist' })).toBe(true);
    expect(isMissingLegBackendColumn({ code: 'PGRST204', message: "Could not find the 'leg_backend' column of 'conductions' in the schema cache" })).toBe(true);
    expect(isMissingLegBackendColumn({ message: 'column "leg_backend" does not exist' })).toBe(true);
    expect(isMissingLegBackendColumn({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingLegBackendColumn({ message: 'column foo does not exist' })).toBe(false);
    expect(isMissingLegBackendColumn(null)).toBe(false);
  });

  const chain = (result: { data?: unknown; error?: unknown }) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq']) c[m] = () => c;
    c.maybeSingle = async () => result;
    return { from: () => c } as unknown as SupabaseClient;
  };

  it('read: value / null / absent / rethrows other errors', async () => {
    expect(await readConductionLegBackend(chain({ data: { leg_backend: 'gke' } }), 'c')).toEqual({ absent: false, backend: 'gke' });
    expect(await readConductionLegBackend(chain({ data: { leg_backend: null } }), 'c')).toEqual({ absent: false, backend: null });
    expect(await readConductionLegBackend(chain({ error: { code: '42703', message: 'column conductions.leg_backend does not exist' } }), 'c')).toEqual({ absent: true });
    await expect(readConductionLegBackend(chain({ error: { code: '42501', message: 'denied' } }), 'c')).rejects.toBeDefined();
  });

  it('write: ok / lease-lost / missing-column / rethrows other errors', async () => {
    expect(await writeConductionLegBackend(chain({ data: { id: 'c' } }), 'c', 'me', 'gke')).toBe('ok');
    expect(await writeConductionLegBackend(chain({ data: null }), 'c', 'me', 'gke')).toBe('lease-lost');
    expect(await writeConductionLegBackend(chain({ error: { code: 'PGRST204', message: "Could not find the 'leg_backend' column" } }), 'c', 'me', 'gke')).toBe('missing-column');
    await expect(writeConductionLegBackend(chain({ error: { code: '500', message: 'boom' } }), 'c', 'me', 'gke')).rejects.toBeDefined();
  });
});
