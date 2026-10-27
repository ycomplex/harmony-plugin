import { describe, it, expect } from 'vitest';
import { renderSlot, type BriefDoc } from './briefs.js';
import { validateBriefFrame } from './brief-frame-schema.js';

const base = { kind: 'clarify' as const, solving: 's', in_scope: ['a'], not_solving: [{ item: 'x', lands: 'y' }] };
const doc = (frame: BriefDoc['frame']): BriefDoc => ({ decide: 'd', items: [], frame });
const sketch = {
  file_link: 'https://figma.com/design/abc', pinned_version: '123',
  frames: [{ name: 'B-1 · 1. Start', caption: 'Pick' }, { name: 'B-1 · 2. Done', caption: 'Confirm' }],
  preview_attachment_ids: ['att-1', 'att-2'], mcp_call_count: 3,
};

describe('clarify sketch record (B-1203)', () => {
  it('validates an optional sketch and projects it onto the clarify slot', () => {
    expect(() => validateBriefFrame({ ...base, sketch }, 'clarify')).not.toThrow();
    expect(renderSlot(doc({ ...base, sketch }), 'clarify')!.sketch).toEqual(sketch);
  });
  it('rejects a malformed sketch', () => {
    expect(() => validateBriefFrame({ ...base, sketch: { ...sketch, mcp_call_count: 'x' } }, 'clarify')).toThrow('doc.frame.sketch.mcp_call_count');
  });
  it('a frame without a sketch projects the exact same slot as before (no sketch key)', () => {
    const slot = renderSlot(doc(base), 'clarify')!;
    expect(slot).toEqual({ solving: 's', in_scope: ['a'], not_solving: [{ item: 'x', lands: 'y' }] });
    expect('sketch' in slot).toBe(false);
  });
});
