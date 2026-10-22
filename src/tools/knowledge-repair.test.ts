import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyMetadataRepair,
  verifiedPrPaths,
  type RepairManifest,
} from './knowledge-repair.js';
import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
function manifest(): RepairManifest {
  return {
    version: 1,
    project_id: 'project',
    manifest_id: 'manifest',
    counts: {},
    entries: [
      {
        id: 'entry',
        title: 'Claim',
        content: 'Body',
        current_scope: null,
        fingerprint: 'before',
        reviewed: true,
        scope: 'product',
        evidence: [],
        state: 'uncertain',
        surfaces: ['surface:web/FABRICATED'],
        prs: [
          {
            repo: 'ycomplex/harmony-web',
            number: 42,
            paths: ['web/FABRICATED'],
          },
        ],
        tags_before: 2,
      },
    ],
  };
}
beforeEach(() => {
  vi.mocked(execFileSync).mockImplementation((_command, args) =>
    args?.[0] === 'pr'
      ? JSON.stringify({
          state: 'MERGED',
          url: 'https://github.com/ycomplex/harmony-web/pull/42',
        })
      : 'src/features/queue/deleted.ts\nsrc/features/queue/kept.ts\n',
  );
});
describe('reviewed metadata repair', () => {
  it('re-fetches complete merged PR paths including deletions, never trusting edited manifest paths', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({
        data: {
          applied: true,
          scope: 'product',
          tags_before: 2,
          tags_after: 3,
        },
      });
    expect(
      await applyMetadataRepair(
        { rpc } as unknown as SupabaseClient,
        'project',
        manifest(),
      ),
    ).toMatchObject({
      applied: 1,
      tags_before: 2,
      tags_after: 3,
      product_after: 1,
    });
    expect(rpc).toHaveBeenLastCalledWith(
      'knowledge_apply_metadata_repair',
      expect.objectContaining({
        p_surface_tags: ['surface:web/src/features/queue'],
        p_fingerprint: 'before',
      }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        '--paginate',
        'repos/ycomplex/harmony-web/pulls/42/files',
        '--jq',
        '.[].filename',
      ],
      { encoding: 'utf8' },
    );
  });
  it('skips unreviewed entries and refuses another project before reading or writing', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true });
    const m = manifest();
    m.entries[0].reviewed = false;
    expect(
      await applyMetadataRepair(
        { rpc } as unknown as SupabaseClient,
        'project',
        m,
      ),
    ).toMatchObject({ skipped: 1, applied: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(
      applyMetadataRepair({ rpc } as unknown as SupabaseClient, 'other', m),
    ).rejects.toThrow('does not belong');
  });
  it('reports replay and never guesses surfaces without PR evidence', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: { applied: false } });
    const m = manifest();
    m.entries[0].prs = [];
    expect(
      await applyMetadataRepair(
        { rpc } as unknown as SupabaseClient,
        'project',
        m,
      ),
    ).toMatchObject({ replayed: 1, missing_pr: 1 });
    expect(rpc).toHaveBeenLastCalledWith(
      'knowledge_apply_metadata_repair',
      expect.objectContaining({ p_surface_tags: [] }),
    );
  });
  it('surfaces stale fingerprint refusal for re-review', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({
        error: { message: 'Entry changed since review' },
      });
    await expect(
      applyMetadataRepair(
        { rpc } as unknown as SupabaseClient,
        'project',
        manifest(),
      ),
    ).rejects.toThrow('entry: Entry changed since review');
  });
  it('refuses open PR evidence', () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ state: 'OPEN', url: 'pr' }),
    );
    expect(() => verifiedPrPaths('ycomplex/harmony-web', 42)).toThrow(
      'not merged',
    );
  });
});
