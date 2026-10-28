import { describe, it, expect } from 'vitest';
import { renderBrief, renderEntry, renderSlot, type BriefDoc } from './briefs.js';
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
  it('names the Figma link beside the frame count in the brief text and the derived entry', () => {
    const md = renderBrief(doc({ ...base, sketch }));
    expect(md).toContain('**Flow sketch:** 2 frames in Figma — https://figma.com/design/abc (version 123, 3 MCP calls)');
    expect(md).toContain('- B-1 · 1. Start — Pick\n- B-1 · 2. Done — Confirm');
    const entry = renderEntry(doc({ ...base, sketch }));
    expect(entry.split('**Flow sketch:**').length).toBe(2);
  });
  it('a frame without a sketch renders byte-identically (no sketch text)', () => {
    const md = renderBrief(doc(base));
    expect(md).not.toContain('Flow sketch');
    expect(md).not.toContain('in Figma');
    const withSketch = renderBrief(doc({ ...base, sketch }));
    const block = withSketch.slice(withSketch.indexOf('\n\n**Flow sketch:**'), withSketch.indexOf('- B-1 · 2. Done — Confirm') + '- B-1 · 2. Done — Confirm'.length);
    expect(withSketch.replace(block, '')).toBe(md);
  });
});
