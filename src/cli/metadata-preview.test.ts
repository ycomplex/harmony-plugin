import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { previewMetadataRepair } from '../tools/knowledge-repair.js';
import { previewMetadataRepairToFile } from './metadata-preview.js';
vi.mock('../tools/knowledge-repair.js', () => ({ previewMetadataRepair: vi.fn() }));
const client = {} as SupabaseClient;
describe('incremental metadata review file', () => {
  it('publishes readable snapshots before completion, reports progress, and preserves the last snapshot on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metadata-preview-')); const file = join(dir, 'review.json');
    const progress: string[] = [];
    vi.mocked(previewMetadataRepair).mockImplementation(async (_client, project, options) => {
      const m = { version: 1 as const, manifest_id: 'stable', project_id: project, entries: [], counts: { entries: 0 },
        preview: { selectors: { limit: 1 }, complete: false, pages: 0 } };
      await options!.onCheckpoint!(m);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ project_id: project, entries: [], preview: { complete: false } });
      m.counts.entries = 1; m.preview.pages = 1;
      await options!.onCheckpoint!(m);
      expect(JSON.parse(readFileSync(file, 'utf8')).counts.entries).toBe(1);
      throw new Error('second page failed');
    });
    try {
      await expect(previewMetadataRepairToFile(client, 'project', file, { limit: 1 }, line => progress.push(line))).rejects.toThrow('second page failed');
      expect(progress).toEqual([expect.stringContaining('0 entries, 0 pages'), expect.stringContaining('1 entries, 1 pages')]);
      expect(JSON.parse(readFileSync(file, 'utf8')).preview.complete).toBe(false);
      expect(readdirSync(dir)).toEqual(['review.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses to overwrite an existing review file and cleans temporary output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metadata-preview-')); const file = join(dir, 'review.json');
    writeFileSync(file, 'reviewed content');
    vi.mocked(previewMetadataRepair).mockImplementation(async (_client, project, options) => {
      await options!.onCheckpoint!({ version: 1, manifest_id: 'new', project_id: project, entries: [], counts: {},
        preview: { selectors: {}, complete: false, pages: 0 } });
      throw new Error('unreachable');
    });
    try {
      await expect(previewMetadataRepairToFile(client, 'project', file, {}, vi.fn())).rejects.toThrow('EEXIST');
      expect(readFileSync(file, 'utf8')).toBe('reviewed content'); expect(readdirSync(dir)).toEqual(['review.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
