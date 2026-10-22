import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  captureSurfaceRecord,
  readSurfaceRecords,
  surfaceRecordTools,
} from './surface-records.js';
import { handleToolCall, registerTools } from './index.js';
const args = {
  owner_surface: 'Views',
  component_ref: 'web/src/Views.tsx',
  labels: ['Name'],
  buttons: ['Save'],
  headings: [],
  source_kind: 'component-source',
  source_locator: 'web/src/Views.tsx',
  source_fingerprint: 'sha256:a',
};
function mock(data: unknown = null, error: unknown = null) {
  return {
    rpc: vi.fn().mockResolvedValue({ data, error }),
  } as unknown as SupabaseClient;
}
describe('rendered surface shared handlers', () => {
  it('validates before a write and rejects inferred wording shapes', async () => {
    const c = mock();
    await expect(
      captureSurfaceRecord(c, 'p', { ...args, buttons: 'Save' }),
    ).rejects.toThrow();
    expect(c.rpc).not.toHaveBeenCalled();
    await expect(
      captureSurfaceRecord(c, 'p', { ...args, source_kind: 'design' }),
    ).rejects.toThrow();
  });
  it('passes structured observations to only the capture RPC', async () => {
    const c = mock({
      record_id: 'r',
      changed: true,
      captured_at: '2026-10-22T00:00:00Z',
    });
    expect(await captureSurfaceRecord(c, 'p', args)).toMatchObject({
      changed: true,
    });
    expect(c.rpc).toHaveBeenCalledExactlyOnceWith(
      'capture_surface_record',
      Object.fromEntries([
        ['p_project_id', 'p'],
        ...Object.entries(args).map(([k, v]) => [`p_${k}`, v]),
      ]),
    );
  });
  it.each(['PGRST202', '42883', '42P01', 'PGRST205'])(
    'degrades optional absence %s but explicitly refuses capture',
    async (code) => {
      expect(
        await readSurfaceRecords(
          mock(null, { code, message: 'read_surface_records missing' }),
          'p',
          { owner_surface: 'Views' },
        ),
      ).toEqual({ availability: 'unavailable', records: [] });
      await expect(
        captureSurfaceRecord(
          mock(null, { code, message: 'capture_surface_record missing' }),
          'p',
          args,
        ),
      ).rejects.toThrow('Deploy the web migration');
    },
  );
  it.each(['42501', 'PGRST301', '08006', 'XX000'])(
    'preserves failure %s on reads and writes',
    async (code) => {
      const c = mock(null, {
        code,
        message: 'read_surface_records / capture_surface_record denied',
      });
      await expect(
        readSurfaceRecords(c, 'p', { owner_surface: 'Views' }),
      ).rejects.toThrow(code);
      await expect(captureSurfaceRecord(c, 'p', args)).rejects.toThrow(code);
    },
  );
  it('does not degrade another missing function or malformed responses', async () => {
    await expect(
      readSurfaceRecords(
        mock(null, { code: '42883', message: 'other_function missing' }),
        'p',
        { owner_surface: 'Views' },
      ),
    ).rejects.toThrow('failed');
    await expect(
      readSurfaceRecords(mock({ records: [] }), 'p', {
        owner_surface: 'Views',
      }),
    ).rejects.toThrow('Invalid');
  });
  it('registers both tools and projects mutation acknowledgements without echoing wording', async () => {
    for (const tool of surfaceRecordTools)
      expect(registerTools().some((t) => t.name === tool.name)).toBe(true);
    const c = mock({
      record_id: 'r',
      changed: false,
      captured_at: '2026-10-22T00:00:00Z',
      labels: ['Secret'],
    });
    const response = await handleToolCall(
      'capture_surface_record',
      args,
      c,
      'p',
      'u',
    );
    expect(response.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({
      record_id: 'r',
      changed: false,
      captured_at: '2026-10-22T00:00:00Z',
    });
  });
});
