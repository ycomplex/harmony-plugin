import { describe, it, expect } from 'vitest';
import { renderBrief, lintBrief, type BriefDoc, type BriefItem } from './briefs.js';

const decision = (over: Partial<BriefItem> = {}): BriefItem => ({
  kind: 'decision', text: 'Pick sidebar placement', recommendation: 'Sub-section under project views', ...over,
});

const baseDoc = (over: Partial<BriefDoc> = {}): BriefDoc => ({
  decide: 'Saved views — sidebar placement.',
  recommend: { text: 'Sub-section under project views.' },
  why: ['Sidebar is where users navigate views'],
  items: [decision()],
  ...over,
});

describe('renderBrief', () => {
  it('renders the BLUF skeleton: DECIDE, Recommend, Why, You need to, tail', () => {
    const md = renderBrief(baseDoc());
    expect(md).toContain('## DECIDE: Saved views — sidebar placement.');
    expect(md).toContain('**Recommend:** Sub-section under project views.');
    expect(md).toContain('**Why:**');
    expect(md).toContain('- Sidebar is where users navigate views');
    expect(md).toContain('**You need to:**');
    expect(md).toContain('- [ ] Pick sidebar placement — *recommend: Sub-section under project views*');
    expect(md).toContain('> Type `accept`, `edit`, `iterate <feedback>`, or `defer`.');
  });

  it('renders the cede suffix for a values call', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', cede: true } }));
    expect(md).toContain('**Recommend (low confidence — this is a values call you should own):** Option A');
  });

  it('renders content-input items as a request, not a recommended fork', () => {
    const md = renderBrief(baseDoc({ items: [{ kind: 'content-input', text: 'Provide the survey questions' }] }));
    expect(md).toContain('- [ ] Provide the survey questions *(your input needed)*');
  });

  it('renders research-first when a load-bearing gap is declared', () => {
    const md = renderBrief(baseDoc({
      recommend: undefined, load_bearing_gap: true,
      research: ['What is the GDPR retention limit?'], items: [decision({ deferred: true })],
    }));
    expect(md).toContain("I don't know enough yet");
    expect(md).toContain('**Research first:**');
    expect(md).toContain('1. What is the GDPR retention limit?');
  });
});

describe('lintBrief', () => {
  const lint = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc));

  it('passes a well-formed decision brief', () => {
    const r = lint(baseDoc());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('flags a naked fork: a decision item with no recommendation', () => {
    const r = lint(baseDoc({ items: [decision({ recommendation: '' })] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/naked fork/i);
  });

  it('flags a derived constraint asked as an actionable item', () => {
    const r = lint(baseDoc({ items: [decision(), { kind: 'derived-constraint', text: 'Confirm confidentiality rule applies' }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/derived constraint.*move it to Context/i);
  });

  it('accepts a content-input item without faking a recommendation', () => {
    const r = lint(baseDoc({ items: [decision(), { kind: 'content-input', text: 'Provide the survey questions' }] }));
    expect(r.ok).toBe(true);
  });

  it('errors when a load-bearing gap is declared but no research is supplied', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: [], items: [decision({ deferred: true })] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/no research/i);
  });

  it('errors when a load-bearing gap still asks a substantive (un-deferred) decision', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: ['Q?'], items: [decision()] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/defer the recommendation/i);
  });

  it('passes a research-first brief: gap declared, research supplied, decision deferred', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: ['Q?'], items: [decision({ deferred: true })] }));
    expect(r.ok).toBe(true);
  });

  it('warns (does not fail) when the rendered brief exceeds the soft word budget', () => {
    const r = lint(baseDoc({ why: [Array.from({ length: 350 }, (_, i) => `w${i}`).join(' ')] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/soft budget/i);
  });
});
