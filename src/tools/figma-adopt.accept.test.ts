import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assembleAdoptedArtefact } from './figma-adopt.js';
import { writeGateSlot } from './gate-slots.js';
import { readAcceptedDesign } from './design-read.js';

// B-1320 — an adopted design, written exactly as the design accept writes its gate slot
// (`field_values.gate_slots.design = { content: { design_artefact, ... }, ratified_by, ratified_at }`),
// must read back through readAcceptedDesign as the designer's figma frames, in order.
function fakeClient(row: { field_values: Record<string, unknown> }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
      update: (patch: { field_values: Record<string, unknown> }) => ({ eq: async () => { row.field_values = patch.field_values; return { error: null }; } }),
    }),
  } as unknown as SupabaseClient;
}

describe('adopted design -> accepted design slot -> readAcceptedDesign', () => {
  it('reads back as a present figma design with the adopted frame ids as screens, in order', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const ids = ['1:1', '1:3', '2:5'];
    const built = assembleAdoptedArtefact({
      fileKey: 'AAA111',
      frames: ids.map((id) => ({ id, name: `Frame ${id}`, caption: `Caption ${id}` })),
      nodes: Object.fromEntries(ids.map((id) => [id, { document: { id, type: 'FRAME' } }])),
      images: Object.fromEntries(ids.map((id) => [id, { bytes: png }])),
      attachments: Object.fromEntries(ids.map((id, i) => [id, { attachment_id: `${i + 1}${i + 1}111111-1111-4111-8111-111111111111`, filename: `f${i}.png` }])),
      composedAt: '2026-10-29T10:00:00.000Z',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const row = { field_values: {} as Record<string, unknown> };
    await writeGateSlot(fakeClient(row), { gate: 'design', content: { design_artefact: built.artefact }, target: { via: 'task', task_id: 't1' } });
    const read = readAcceptedDesign(row.field_values);
    expect(read.status).toBe('present');
    if (read.status !== 'present') return;
    expect(read.tool).toBe('figma');
    expect(read.fileKey).toBe('AAA111');
    expect(read.screens.map((s) => s.nodeId)).toEqual(ids);
  });
});
