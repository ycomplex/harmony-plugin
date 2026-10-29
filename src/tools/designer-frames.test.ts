// B-1338 — the design brief frame carries the designer's linked frames (verdict, reason, live preview).
import { describe, it, expect, vi } from 'vitest';
import { renderBrief, renderSlot, type BriefDoc } from './briefs.js';
import { validateDesignerFrameAttachments, renderDesignerFrames, type DesignerFrame } from './design-artefact.js';
import { validateBriefFrame } from './brief-frame-schema.js';

const PREVIEW = '10000000-0000-4000-8000-0000000000aa';
const frames: DesignerFrame[] = [
  { id: '32:195', name: 'Owner — recommended', file_key: 'cE0x', verdict: 'adopted', reason: 'Every one of its 19 component instance(s) is in the workspace library', preview_attachment_id: PREVIEW, preview_filename: 'owner.png' },
  { id: '91:567', name: 'Frame 1', file_key: 'cE0x', verdict: 'off-library', reason: "Off-library: drawn from another copy of the library: 'Button :: Primary' matches the workspace library by name but not by component key" },
];
const base = { decide: 'Review the design', items: [], frame: { kind: 'design', track: 'ux-ui-design', tracks: [], reach: [] } } as unknown as BriefDoc;
const withFrames = { ...base, frame: { ...base.frame!, designer_frames: frames } } as BriefDoc;

describe('designer_frames on the design frame', () => {
  it('renders a "Designer\'s frames" block: name — verdict — reason, and the preview filename when present', () => {
    const md = renderBrief(withFrames);
    expect(md).toContain("**Designer's frames:**");
    expect(md).toContain(`- Owner — recommended — adopted — Every one of its 19 component instance(s) is in the workspace library — owner.png (ticket attachment ${PREVIEW})`);
    expect(md).toContain("- Frame 1 — off-library — Off-library: drawn from another copy of the library");
    expect(md.indexOf("**Designer's frames:**")).toBeLessThan(md.indexOf('**Track:**'));
    expect(renderDesignerFrames([frames[1]])[1]).not.toContain('ticket attachment');
  });
  it('an absent field renders byte-identically (and an empty list too)', () => {
    const empty = { ...base, frame: { ...base.frame!, designer_frames: [] } } as BriefDoc;
    expect(renderBrief(empty)).toBe(renderBrief(base));
    expect(renderBrief(withFrames)).not.toBe(renderBrief(base));
  });
  it('is not the ticket design: never written to the design slot', () => {
    expect(renderSlot(withFrames, 'design')).toBeNull();
  });
  it('the frame schema accepts it and rejects an unknown verdict', () => {
    expect(() => validateBriefFrame(withFrames.frame, 'design')).not.toThrow();
    expect(() => validateBriefFrame({ ...withFrames.frame, designer_frames: [{ ...frames[0], verdict: 'maybe' }] }, 'design')).toThrow(/Invalid brief frame/);
  });
  it('a preview must be a finalized same-ticket image attachment with its actual filename', async () => {
    const inQuery = vi.fn().mockResolvedValue({ data: [] });
    const chain = { select: () => chain, eq: () => chain, in: inQuery };
    const client = { from: vi.fn(() => chain) };
    await expect(validateDesignerFrameAttachments(client as never, 'task', frames)).rejects.toThrow(/same-ticket image attachment/);
    inQuery.mockResolvedValue({ data: [{ id: PREVIEW, filename: 'other.png', content_type: 'image/png' }] });
    await expect(validateDesignerFrameAttachments(client as never, 'task', frames)).rejects.toThrow(/Owner — recommended/);
    inQuery.mockResolvedValue({ data: [{ id: PREVIEW, filename: 'owner.png', content_type: 'text/html' }] });
    await expect(validateDesignerFrameAttachments(client as never, 'task', frames)).rejects.toThrow();
    inQuery.mockResolvedValue({ data: [{ id: PREVIEW, filename: 'owner.png', content_type: 'image/png' }] });
    await expect(validateDesignerFrameAttachments(client as never, 'task', frames)).resolves.toBeUndefined();
    client.from.mockClear();
    await expect(validateDesignerFrameAttachments(client as never, 'task', [frames[1]])).resolves.toBeUndefined();
    expect(client.from).not.toHaveBeenCalled();
  });
});
