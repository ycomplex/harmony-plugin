import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBrief, lintBrief, composeBrief, composeBriefTool, isMissingComposeBriefRevision, getBrief, resolveBrief, resolveBriefTool, reshapeBrief, reshapeBriefTool, validateResolutionProvenance, PROVENANCE_AGENT_SYNTHESIZED, PROVENANCE_WEB_ONLY, fetchPendingResolution, fetchPendingRemark, consumeAcceptRemark, SENTENCE_WORD_LIMIT, DEFAULT_TAIL, STALE_PATCH_TAIL, PROPOSED_ACS_HEADING, PROMISED_WRITES_HEADING, DE_SCOPE_HEADING, ENTRY_PROVENANCE_PREFIX, frameUnits, readBuildPr, readBuildPrReferences, FRAME_KIND_FOR_REASON, type BriefDoc, type BriefItem, type GateFrame, type CriterionRow } from './briefs.js';

// Pass-through: the handlers delegate id resolution to resolveTaskId (like the sibling task tools); the
// mock returns the input verbatim so the call-order assertions below stay valid for any id shape.
vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => input),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

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

  it('renders the low-confidence (non-cede) suffix', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', confidence: 'low' } }));
    expect(md).toContain('**Recommend (low confidence — see below):** Option A');
  });

  it('renders the high-confidence suffix (B-445)', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', confidence: 'high' } }));
    expect(md).toContain('**Recommend (high confidence):** Option A');
  });

  it('renders the moderate-confidence suffix (B-445)', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', confidence: 'medium' } }));
    expect(md).toContain('**Recommend (moderate confidence):** Option A');
  });

  it('renders the alternatives and context sections', () => {
    const md = renderBrief(baseDoc({
      alternatives: [{ option: 'Top-level nav item', rejection: 'crowds the primary nav' }],
      context: ['B-187 shipped list-action icons'],
    }));
    expect(md).toContain('**Alternatives:**');
    expect(md).toContain('- Top-level nav item — crowds the primary nav');
    expect(md).toContain('**Context:**');
    expect(md).toContain('- B-187 shipped list-action icons');
  });

  it('renders a custom tail line in place of the default', () => {
    const md = renderBrief(baseDoc({ tail: 'Reply with your pick.' }));
    expect(md).toContain('> Reply with your pick.');
    expect(md).not.toContain('Type `accept`');
  });

  it('drops derived-constraint items from the rendered "You need to" list', () => {
    const md = renderBrief(baseDoc({ items: [decision(), { kind: 'derived-constraint', text: 'Confidentiality rule is already fixed' }] }));
    expect(md).toContain('- [ ] Pick sidebar placement');
    expect(md).not.toContain('Confidentiality rule is already fixed');
  });

  it('appends the depth-pointer footer when a decision_ref is supplied (B-674)', () => {
    const md = renderBrief(baseDoc(), { type: 'specification', id: 'abc' });
    expect(md).toContain('fuller depth lives in the linked decision entry');
  });

  it('omits the depth-pointer footer when no decision_ref is supplied (B-674)', () => {
    const md = renderBrief(baseDoc());
    expect(md).not.toContain('fuller depth lives in the linked decision entry');
  });
});

// B-874 — the render's compose-time contract. These are EXACT-STRING pins, deliberately: each line
// below is prose a human reads at an irreversible gate, and the archive of resolved briefs keeps the
// bytes it was rendered with forever. A drift here is a silent divergence between old briefs and new.
describe('renderBrief — compose-time context (B-874)', () => {
  describe('the On accept: spine line', () => {
    it('states the transition accept will apply', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'clarification-draft', accept: { from: 'Proposed', to: 'Clarified' } });
      expect(md).toContain('**On accept:** advances Proposed → Clarified');
    });

    it('drops the from-state when the ticket has none yet (from: null)', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'clarification-draft', accept: { from: null, to: 'Proposed' } });
      expect(md).toContain('**On accept:** advances to Proposed');
      expect(md).not.toContain('advances null');
    });

    it('says "no state change" when the brief advances nothing (accept: null)', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'release-decision-pending', accept: null });
      expect(md).toContain('**On accept:** no state change');
    });

    it('says "no state change" when `accept` is simply absent from the context', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'release-decision-pending' });
      expect(md).toContain('**On accept:** no state change');
    });

    it('sits directly under the recommendation and above the reasoning', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'clarification-draft', accept: { from: 'Proposed', to: 'Clarified' } });
      expect(md).toContain('**Recommend:** Sub-section under project views.\n\n**On accept:** advances Proposed → Clarified\n\n**Why:**');
    });

    it('BACK-COMPAT: a 1-arg call emits NO On accept: line', () => {
      expect(renderBrief(baseDoc())).not.toContain('**On accept:**');
    });

    it('BACK-COMPAT: a 2-arg call emits NO On accept: line', () => {
      expect(renderBrief(baseDoc(), { type: 'specification', id: 'abc' })).not.toContain('**On accept:**');
    });
  });

  describe('the gate-specific command tail', () => {
    // Pinned VERBATIM: on a stale-patch brief `defer` REJECTS the patch (the flag clears anyway and it
    // cannot be undone), which the default tail does not say. This exact wording is the fix.
    it('pins the stale-patch tail byte-for-byte', () => {
      expect(STALE_PATCH_TAIL).toBe(
        '`accept` applies this patch and clears the stale flag (state unchanged). `defer` REJECTS it — the flag clears anyway, the divergence is recorded, and the ticket proceeds on the retired decision; this is not a park and cannot be undone. Or `edit` / `iterate <feedback>`.',
      );
    });

    it('emits the stale-patch tail for reason stale-patch-review', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'stale-patch-review', accept: null });
      expect(md).toContain(`> ${STALE_PATCH_TAIL}`);
      expect(md).not.toContain(DEFAULT_TAIL);
    });

    it.each([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft',
      'release-decision-pending', 'verification-ack-pending', 'revise-scope-review',
    ])('keeps the default tail for reason %s', (reason) => {
      const md = renderBrief(baseDoc(), null, { reason, accept: null });
      expect(md).toContain(`> ${DEFAULT_TAIL}`);
      expect(md).not.toContain('REJECTS it');
    });

    it('keeps the default tail when no context is supplied at all', () => {
      expect(renderBrief(baseDoc())).toContain('> Type `accept`, `edit`, `iterate <feedback>`, or `defer`.');
    });

    it('an explicit doc.tail still overrides the reason-specific tail', () => {
      const md = renderBrief(baseDoc({ tail: 'Reply with your pick.' }), null, { reason: 'stale-patch-review', accept: null });
      expect(md).toContain('> Reply with your pick.');
      expect(md).not.toContain('REJECTS it');
    });
  });

  describe('the clarify proposed-acceptance-criteria block', () => {
    const withAcs = (over: Partial<BriefDoc> = {}) => baseDoc({
      payload: [
        { write_kind: 'acceptance_criterion', ref: 'ac-saved-filter-persists', content: 'A saved filter persists per-user across sessions' },
        { write_kind: 'acceptance_criterion', ref: 'ac-saved-filter-renames', content: 'A saved filter can be renamed' },
        { write_kind: 'label_add', ref: 'label-decision-only', label_name: 'decision-only' },
      ],
      ...over,
    });

    // Byte-stable forever: older resolved briefs keep the bytes they were rendered with. Both of clarify's
    // filing headings are pinned here (B-877) — the rendered one above and the prose-authored de-scope one —
    // because they are the same kind of promise and a reader looking for one will look for the other.
    it('pins both clarify filing headings byte-for-byte', () => {
      expect(PROPOSED_ACS_HEADING).toBe('Proposed acceptance criteria (happy path) — filed on accept:');
      expect(DE_SCOPE_HEADING).toBe('De-scope — re-ticketed on accept:');
    });

    it('derives one line per acceptance_criterion payload item', () => {
      const md = renderBrief(withAcs(), null, { reason: 'clarification-draft', accept: { from: 'Proposed', to: 'Clarified' } });
      expect(md).toContain(
        'Proposed acceptance criteria (happy path) — filed on accept:\n- A saved filter persists per-user across sessions\n- A saved filter can be renamed\n',
      );
    });

    // B-866 SUPERSEDES the original form of this pin ("other write kinds stay unrendered"). The clarify
    // AC block is still ACs-only — byte-stable — but the other promised writes are no longer swallowed:
    // they render under PROMISED_WRITES_HEADING, because a gate that promises a write the reader never
    // sees is the same defect as prose that disagrees with the write.
    it('keeps the AC block ACs-only; other write kinds render under the promise heading (B-866)', () => {
      const md = renderBrief(withAcs(), null, { reason: 'clarification-draft', accept: null });
      const acBlock = md.slice(md.indexOf(PROPOSED_ACS_HEADING), md.indexOf(PROMISED_WRITES_HEADING));
      expect(acBlock).not.toContain('decision-only');
      expect(md).toContain(`${PROMISED_WRITES_HEADING}\n- label — decision-only`);
      expect(md).not.toContain('label_add');
    });

    it('sits in the Context region — after Context, before You need to', () => {
      const md = renderBrief(withAcs({ context: ['B-187 shipped list-action icons'] }), null, { reason: 'clarification-draft', accept: null });
      expect(md.indexOf('**Context:**')).toBeLessThan(md.indexOf(PROPOSED_ACS_HEADING));
      expect(md.indexOf(PROPOSED_ACS_HEADING)).toBeLessThan(md.indexOf('**You need to:**'));
    });

    it.each([
      'decomposition-proposal', 'design-decision-draft', 'plan-draft',
      'release-decision-pending', 'verification-ack-pending', 'stale-patch-review', 'revise-scope-review',
    ])('is emitted for NO other reason (%s) — the ACs move to the promise block (B-866)', (reason) => {
      const md = renderBrief(withAcs(), null, { reason, accept: null });
      // The clarify heading stays clarify-only, byte-stable.
      expect(md).not.toContain(PROPOSED_ACS_HEADING);
      // B-866: the promise itself is no longer swallowed at the other seven gates — every payload-bearing
      // reason renders its promise FROM THE PAYLOAD ITS ACCEPT WILL EXECUTE. Before this, a decompose
      // brief promised three children in the payload and showed the human none of them.
      expect(md).toContain(PROMISED_WRITES_HEADING);
      expect(md).toContain('- acceptance criterion — A saved filter persists per-user across sessions');
    });

    it('emits nothing when the payload carries no acceptance_criterion items', () => {
      const md = renderBrief(baseDoc({ payload: [{ write_kind: 'label_add', ref: 'label-decision-only', label_name: 'decision-only' }] }),
        null, { reason: 'clarification-draft', accept: null });
      expect(md).not.toContain(PROPOSED_ACS_HEADING);
    });

    it('emits nothing when the doc carries no payload at all', () => {
      const md = renderBrief(baseDoc(), null, { reason: 'clarification-draft', accept: null });
      expect(md).not.toContain(PROPOSED_ACS_HEADING);
    });

    it('BACK-COMPAT: a 2-arg call never renders the payload', () => {
      expect(renderBrief(withAcs(), null)).not.toContain(PROPOSED_ACS_HEADING);
    });
  });
});

describe('lintBrief', () => {
  const lint = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc));
  const filler = (n: number) => [Array.from({ length: n }, (_, i) => `w${i}`).join(' ')];

  it('passes a well-formed decision brief', () => {
    const r = lint(baseDoc({ recommend: { text: 'Sub-section under project views.', confidence: 'high' } }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
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
    const r = lint(baseDoc({ why: filler(700) })); // 1 item -> tier budget 675; ~730 rendered words
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/soft budget/i);
  });

  it('scales the budget by structure (B-467): a length that warns for a minimal brief is tolerated by a larger one', () => {
    const small = lint(baseDoc({ why: filler(700) })); // 1 item -> budget 675; ~730 rendered words

    expect(small.warnings.join(' ')).toMatch(/soft budget/i);

    const large = lint(baseDoc({
      items: [decision(), decision(), decision(), decision()], // 4 units -> budget 600 + 75*4 = 900
      why: filler(700),
    }));
    expect(large.warnings.join(' ')).not.toMatch(/soft budget/i);
    expect(large.ok).toBe(true);
  });

  it('counts alternatives toward the tier budget (B-467)', () => {
    const r = lint(baseDoc({
      alternatives: [
        { option: 'A', rejection: 'x' }, { option: 'B', rejection: 'y' }, { option: 'C', rejection: 'z' },
      ], // 1 item + 3 alternatives = 4 units -> budget 900
      why: filler(400),
    }));
    expect(r.warnings.join(' ')).not.toMatch(/soft budget/i);
    expect(r.ok).toBe(true);
  });

  it('caps the tier budget and still warns past the cap (B-467)', () => {
    const items = Array.from({ length: 11 }, () => decision()); // 11 units -> 600 + 75*11 = 1425 -> capped 1400
    const r = lint(baseDoc({ items, why: filler(1500) }));      // ~1660 rendered words > 1400
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/soft budget 1400/);
  });

  it('warns (does not fail) when a recommendation has no confidence level (B-445)', () => {
    const r = lint(baseDoc()); // baseDoc recommend has no confidence level
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/no confidence level/i);
  });

  it('does not nag when an explicit confidence level is set (B-445)', () => {
    const r = lint(baseDoc({ recommend: { text: 'x', confidence: 'medium' } }));
    expect(r.warnings.join(' ')).not.toMatch(/no confidence level/i);
  });

  it('does not nag for a confidence level on a ceded values-call (B-445)', () => {
    const r = lint(baseDoc({ recommend: { text: 'x', cede: true } }));
    expect(r.warnings.join(' ')).not.toMatch(/no confidence level/i);
  });

  it('does not nag for a confidence level on a research-first brief with no recommend (B-445)', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: ['Q?'], items: [decision({ deferred: true })] }));
    expect(r.warnings.join(' ')).not.toMatch(/no confidence level/i);
  });
});

// ——— B-660 legibility nudges: warn-only, calibrated two-sided ———
describe('lintBrief legibility nudges (B-660)', () => {
  // Confidence set so the only warnings in play are the nudges under test.
  const quiet = (over: Partial<BriefDoc> = {}): BriefDoc =>
    baseDoc({ recommend: { text: 'Adopt.', confidence: 'high' }, ...over });
  const lint = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc));
  const NUDGE_A = /one idea per sentence/i;
  const NUDGE_B = /unstack these/i;

  const longSentence =
    Array.from({ length: SENTENCE_WORD_LIMIT + 5 }, (_, i) => `word${i}`).join(' ') + '.';

  it(`Nudge A fires on a sentence over ${SENTENCE_WORD_LIMIT} words — and never flips ok`, () => {
    const r = lint(quiet({ why: [longSentence] }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(NUDGE_A);
  });

  it('Nudge A is silent on short-sentence prose', () => {
    const r = lint(quiet({ why: ['Short sentences read fast. Each carries one idea. That is the contract.'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge A is silent when the long word-run sits inside an inline code span', () => {
    const r = lint(quiet({ why: ['`' + longSentence + '` explains it.'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge A is silent when the long word-run sits inside a fenced code block', () => {
    const r = lint(quiet({ why: ['```\n' + longSentence + '\n```'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge A treats rendered checkbox items as template chrome (structured fields, not prose)', () => {
    const itemText = Array.from({ length: SENTENCE_WORD_LIMIT + 5 }, (_, i) => `w${i}`).join(' ');
    const r = lint(quiet({ items: [decision({ text: itemText })] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge B fires on a nested parenthetical (an aside inside an aside) — and never flips ok', () => {
    const r = lint(quiet({ why: ['The guard (the reconciliation path (consume-on-pickup)) covers it.'] }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(NUDGE_B);
  });

  it('Nudge B fires on immediately-adjacent parenthetical pairs', () => {
    const r = lint(quiet({ why: ['The guard (the reconciliation path) (consume-on-pickup) covers it.'] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(NUDGE_B);
  });

  it('Nudge B is SILENT on two separate parentheticals in one sentence — never a per-sentence count', () => {
    const r = lint(quiet({ why: ['The guard (the reconciliation path) covers it for now (until the redesign).'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_B);
  });

  it('Nudge B is silent on code spans containing parens — a tool call is not a parenthetical', () => {
    const r = lint(quiet({ why: ['Call `manage_subtasks(task_id)` then `get_task(id)` to confirm the split.'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_B);
  });

  // ——— Two-sided calibration (B-660) ———
  // SYNTHETIC POSITIVE reconstructed from B-550's documented failure signature — stacked
  // parentheticals (asides inside asides), five-clause 50+ word sentences, inline substrate
  // jargon. The ORIGINAL illegible brief is unrecoverable: compose_brief iterates the active
  // brief in place, so the rejected text survives in no activity event and no doc. Both
  // nudges must fire on this reconstruction.
  const B550_SYNTHETIC_POSITIVE = `## DECIDE: Adopt the gate-ui conductor split for B-550?

**Recommend (high confidence):** Adopt the reconciliation-guard sub-track split (the B-482 guard (the consume-on-auto-pickup path) already half-covers it), which lands the elicitation-claim coupling on the brief row, keeps the underwriting ids on the prune path, folds the pending_resolution consume into the iterate re-compose, threads the awaiting_human_ref through the P3 substrate's partial unique index, and defers the reshape surface to the web repo because the poll-loop arm (the B-500 auto-watch (armed at hard floors)) serializes the sub-tracks anyway.

**Why:**
- The P3 substrate already carries the partial unique index (scoped to the active row (status alone is not enough)) so the coupling rides the existing slot.

**You need to:**
- [ ] Adopt the split — *recommend: adopt*

> Type \`accept\`, \`edit\`, \`iterate <feedback>\`, or \`defer\`.`;

  it('trips BOTH nudges on the synthetic B-550 positive (reconstruction — original unrecoverable)', () => {
    const r = lintBrief(quiet(), B550_SYNTHETIC_POSITIVE);
    expect(r.ok).toBe(true); // warn-only even on the worst offender
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(NUDGE_A);
    expect(r.warnings.join(' ')).toMatch(NUDGE_B);
  });

  // BRIEF-5 from the B-660 calibration corpus — a REAL plan brief authored under the contract
  // (the shortest of the five clean negatives; all five measured silent at calibration). A
  // representative real brief must produce zero warnings of any kind.
  const CORPUS_BRIEF_5_PLAN = `## DECIDE: Approve B-660's execution plan?

**Recommend (high confidence):** Proceed. One plugin PR in a worktree created inside plugin/: recover the B-550 illegible-brief anchor, author brief-authoring.md, wire the eight skill pointers, add the two nudges to lintBrief with the compose_brief description backstop, write the nudge tests plus the pointer contract test, re-tune the budget from measurement, then full suite, typecheck, verify:dist, and a version bump to 0.14.52.

**Why:**
- Executes the two Accepted design decisions (d97ac598 product, 30bb02d1 technical) with no open choices left.
- Base verified: lintBrief, the eight compose sites, and the AC mechanics were all read in current code this session; no DB objects are touched, so there is no CREATE OR REPLACE to rebase.

**Context:**
- Build order: (1) worktree inside plugin/ — never the workspace root; (2) recover the B-550 positive anchor from activity events or the session record, else reconstruct and say so in the test; (3) brief-authoring.md; (4) the eight §-pointers; (5) compose_brief description essence + pointer; (6) the two nudges in lintBrief, code spans and URLs stripped first; (7) tests — nudges two-sided (fire on the anchor, silent on this run's briefs, never flip ok) + the compose-site pointer contract test; (8) budget re-tune from measured briefs + draft the 9599c855 dated-banner amendment, applied with the release and surfaced on its brief; (9) npm run typecheck, full npm test, npm run verify:dist, bump plugin.json to 0.14.52; (10) commit, push, PR — then stop at the release hard floor.
- Plan is the lead-by-system gate under the contract this ticket encodes: this brief is deliberately terse, and the disciplines it attests to are enforced in the build steps, not in prose the human must audit.

**You need to:**
- [ ] Execute the ten-step single-PR plan above in a plugin/ worktree — *recommend: Proceed — accept advances to Planned and the build starts*

> Type \`accept\`, \`edit\`, \`iterate <feedback>\`, or \`defer\`.`;

  it('passes a real corpus brief (BRIEF-5, the plan brief) with zero warnings', () => {
    const r = lintBrief(quiet(), CORPUS_BRIEF_5_PLAN);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

// A chainable supabase mock whose terminal methods (single/maybeSingle) and direct `await` pop a queued
// response in call order. `then` makes the builder awaitable for the trailing tasks-update.
function makeClient(
  responses: Array<{ data: unknown; error?: unknown }>,
  rpcResponses: Record<string, { data: unknown; error?: unknown }> = {},
) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'is', 'not', 'order', 'limit']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => next());
  chain.single = vi.fn(async () => next());
  chain.then = (resolve: (v: unknown) => unknown) => resolve(next());
  // B-843: the iterate path now calls `compose_brief_revision` FIRST. An RPC with no queued response
  // defaults to the B-383 "function does not exist" shape — i.e. a PRE-MIGRATION DB — so every test
  // written before B-843 keeps exercising the in-place fallback it was written against, byte for byte.
  chain.rpc = vi.fn(async (name: string) =>
    rpcResponses[name] ?? { data: null, error: { code: '42883', message: `function public.${name} does not exist` } });
  return chain;
}

const okDoc = { decide: 'x', recommend: { text: 'y' }, items: [{ kind: 'decision', text: 'Pick', recommendation: 'A' }] };

describe('composeBrief', () => {
  const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 1 };

  it('renders + lints, validates pending_activity, inserts, then sets awaiting_human_input', async () => {
    // responses: [task state] -> [transition exists] -> [no active brief] -> [insert row] -> [task update]
    const client = makeClient([
      { data: { workflow_state: 'Proposed' } },
      { data: { to_state: 'Clarified' } },
      { data: null },
      { data: briefRow },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      pending_activity: 'clarifying', decision_ref: { type: 'decision', id: 'dec-1' },
    });
    expect(result.brief).toEqual(briefRow);
    expect(result.lint.ok).toBe(true);
    // content is derived (rendered), not passed in
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      task_id: 'task-1', reason: 'clarification-draft', content: expect.stringContaining('## DECIDE: x'),
    }));
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      awaiting_human_input: true, awaiting_human_reason: 'clarification-draft',
      awaiting_human_ref: { type: 'brief', id: 'brief-1' },
    }));
  });

  // B-874 — the compose-time seam: the transition lookup is hoisted ABOVE the render, so the persisted
  // content states what the accept actually does. The lookup itself is unchanged (same reads, same order).
  it('persists the resolved transition as the On accept: line (B-874)', async () => {
    // responses: [task state] -> [transition exists] -> [no active brief] -> [insert row] -> [task update]
    const client = makeClient([
      { data: { workflow_state: 'Proposed' } },
      { data: { to_state: 'Clarified' } },
      { data: null },
      { data: briefRow },
      { data: null },
    ]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'clarifying',
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('**On accept:** advances Proposed → Clarified'),
    }));
  });

  it('persists "no state change" when the brief advances nothing — and still reads no task row (B-874)', async () => {
    // responses: [build_pr read (B-732, release only)] -> [no active brief] -> [insert row] -> [task
    // update]. The `pending_activity: null` path must add NO network read of its own: the tasks
    // workflow_state / workflow_transitions lookups stay inside the guard.
    const client = makeClient([{ data: { field_values: {} } }, { data: null }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'release-decision-pending', doc: okDoc as any, pending_activity: null as any,
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('**On accept:** no state change'),
    }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  it('renders the stale-patch tail from the gate reason (B-874)', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'stale-patch-review', doc: okDoc as any, pending_activity: null as any,
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(STALE_PATCH_TAIL),
    }));
  });

  it('renders the proposed-AC block from doc.payload on a clarification brief (B-874)', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', pending_activity: null as any,
      doc: {
        ...okDoc,
        payload: [{ write_kind: 'acceptance_criterion', ref: 'ac-x', content: 'The board exports a PDF' }],
      } as any,
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(`${PROPOSED_ACS_HEADING}\n- The board exports a PDF`),
    }));
  });

  it('updates the active brief IN PLACE (iterate) and bumps iteration (no pending_activity guard)', async () => {
    // no pending_activity -> guard skipped. responses: [active found] -> [update row] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: { ...briefRow, iteration: 2 } }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ iteration: 2 }));
    expect((result.brief as any).iteration).toBe(2);
  });

  it('NULLS pending_resolution on the iterate re-compose — consumes the browser reshape (B-485 marker-clear)', async () => {
    // The in-place iterate IS the consume moment: re-composing must clear any browser-submitted reshape so
    // it is not re-consumed on the next poll. responses: [active found] -> [update row] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: { ...briefRow, iteration: 2 } }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    // the brief update (not the trailing tasks flag) carries pending_resolution: null
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ pending_resolution: null }));
  });

  it('NULLS pending_resolution on a first compose too (insert path)', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_resolution: null }));
  });

  it('degrades gracefully if pending_resolution column is absent (older DB) — retries the write without it', async () => {
    // The first iterate update 400s because the column is missing; compose retries without pending_resolution.
    // responses: [active found] -> [update errors: column absent] -> [retry update succeeds] -> [task update]
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1 } },
      { data: null, error: { message: 'column briefs.pending_resolution does not exist' } },
      { data: { ...briefRow, iteration: 2 } },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect((result.brief as any).iteration).toBe(2);
    // the retry dropped pending_resolution from the payload
    expect(client.update).toHaveBeenLastCalledWith(expect.not.objectContaining({ pending_resolution: null }));
  });

  it('throws on a lint failure (naked fork) before any DB write', async () => {
    const client = makeClient([]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft',
        doc: { decide: 'x', items: [{ kind: 'decision', text: 'Pick' }] } as any, // no recommendation
      }),
    ).rejects.toThrow(/pre-send lint/i);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('throws when pending_activity has no transition from the current state', async () => {
    // responses: [task state] -> [transition lookup returns null]
    const client = makeClient([{ data: { workflow_state: 'Built' } }, { data: null }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'clarifying',
      }),
    ).rejects.toThrow(/no valid transition/i);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('rejects an unknown reason', async () => {
    const client = makeClient([]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, { task_id: 't', reason: 'bogus' as any, doc: okDoc as any }),
    ).rejects.toThrow(/reason/i);
  });

  // B-466: a literal pending_activity:null must be accepted and treated as "field omitted".
  it('advertises pending_activity as nullable so a literal null is a valid input (B-466 — the defect site)', () => {
    // The defect: the advertised JSON Schema typed pending_activity as 'string', so the MCP client/harness
    // rejected a literal null before the (already null-safe) handler ran. The contract must permit null.
    const t = (composeBriefTool.inputSchema.properties as any).pending_activity.type;
    expect(t).toEqual(['string', 'null']);
  });

  it('treats pending_activity:null identically to omitting it — writes null, skips the transition guard (B-466 parity)', async () => {
    // Parity regression-lock: the handler is already null-safe (if(pending_activity) guard + ?? null), so a
    // literal null must behave exactly like an omitted field — accept advances no state. Insert path only:
    // [no active brief] -> [insert row] -> [task update]; the transition guard (workflow_transitions) must
    // NOT be queried.
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: null as any,
    });
    expect(result.lint.ok).toBe(true);
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: null }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  // B-625: a literal-STRING "null" is the string-serialized form of JSON null — it must be normalized to
  // omitted (parity with B-466's null≡omitted), not fed to the transition guard (where 'null' has no row).
  it('treats the literal string "null" as omitted — writes null, skips the transition guard (B-625)', async () => {
    // Insert path only: [no active brief] -> [insert row] -> [task update]; workflow_transitions must NOT be queried.
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'null',
    });
    expect(result.lint.ok).toBe(true);
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: null }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  // B-625: the normalization is case-insensitive and whitespace-trimmed — these variants must behave identically.
  it.each(['NULL', 'Null', ' null '])('normalizes the case/whitespace variant %j to omitted (B-625)', async (variant) => {
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: variant,
    });
    expect(result.lint.ok).toBe(true);
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: null }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  // B-625 over-reach guard: a REAL activity must still validate against workflow_transitions and write through.
  it('still validates a real pending_activity — the "null" normalization does not over-reach (B-625)', async () => {
    // responses: [task state] -> [transition exists] -> [no active brief] -> [insert row] -> [task update]
    const client = makeClient([
      { data: { workflow_state: 'Proposed' } },
      { data: { to_state: 'Clarified' } },
      { data: null },
      { data: briefRow },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'clarifying',
    });
    expect(result.lint.ok).toBe(true);
    expect(client.from).toHaveBeenCalledWith('workflow_transitions');
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: 'clarifying' }));
  });

  // B-625 over-reach guard: a genuine typo is NOT "null" — it must still hit the guard and throw.
  it('still throws on a typo\'d unknown activity — only the exact "null" token is normalized (B-625)', async () => {
    // responses: [task state] -> [transition lookup returns null]
    const client = makeClient([{ data: { workflow_state: 'Built' } }, { data: null }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'buildng',
      }),
    ).rejects.toThrow(/no valid transition/i);
    expect(client.insert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// B-843 — an iterate RETAINS its predecessor: compose_brief_revision + the absent-vs-null patch.
//
// Two things are load-bearing here and are asserted separately, because conflating them is exactly how
// the original bug got in:
//   * WHAT IS SENT — the patch carries ONLY what changed. A field the caller did not pass must be ABSENT
//     from the patch (so the DB carries it forward), not present-as-null (which would clear it). The
//     `decision_ref` case is the specific silent data loss this ticket exists to close.
//   * WHAT HAPPENS WHEN THE RPC IS NOT THERE — plugin `main` reaches the prod board before harmony-web's
//     migration does, so an absent RPC must degrade to today's in-place iterate, and ONLY an absent RPC:
//     a permission error or a transient blip must be loud.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// ——— B-866 step 5: the depth-pointer survives a PARTIAL recompose ————————————————————————————————
describe('composeBrief — the render takes decision_ref from the MERGED revision (B-866)', () => {
  const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 2 };
  const POINTER = '_This brief is a summary — fuller depth lives in the linked decision entry._';

  it('CARRY-FORWARD: an iterate that omits decision_ref keeps the pointer in the rendered content', async () => {
    // The defect: the B-843 revision patch is a PARTIAL, so an omitted decision_ref carries forward on
    // the ROW — but the render read `args.decision_ref`, so the content silently lost the pointer.
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1, decision_ref: { type: 'specification', id: 'dec-1' } } },
      { data: briefRow },
      { data: null },
    ]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: null as any,
    });
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(POINTER),
      decision_ref: { type: 'specification', id: 'dec-1' },
    }));
  });

  it('an EXPLICIT null still clears the pointer — absent and null are different claims', async () => {
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1, decision_ref: { type: 'specification', id: 'dec-1' } } },
      { data: briefRow },
      { data: null },
    ]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      pending_activity: null as any, decision_ref: null as any,
    });
    const written = client.update.mock.calls[0][0] as { content: string; decision_ref: unknown };
    expect(written.content).not.toContain(POINTER);
    expect(written.decision_ref).toBeNull();
  });

  it('a first compose with no prior revision is unchanged: the passed ref drives the pointer', async () => {
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      pending_activity: null as any, decision_ref: { type: 'specification', id: 'dec-1' },
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(POINTER) }));
  });
});

describe('composeBrief — B-843 retained revisions (compose_brief_revision)', () => {
  const revisionRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 2, lineage_id: 'lin-1', iterate_feedback: 'lead with the tradeoff' };
  const revisionOk = { compose_brief_revision: { data: revisionRow, error: null } };

  /** The single `compose_brief_revision` call's params. */
  function patchOf(client: any): any {
    const call = client.rpc.mock.calls.find((c: any[]) => c[0] === 'compose_brief_revision');
    return call?.[1];
  }

  it('iterates through the RPC — the prior revision is superseded server-side, never updated in place', async () => {
    // responses: [active brief found] -> (rpc) -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      iterate_feedback: 'lead with the tradeoff',
    });
    expect(client.rpc).toHaveBeenCalledWith('compose_brief_revision', expect.objectContaining({
      _task_id: 'task-1', _iterate_feedback: 'lead with the tradeoff', _created_by: USER_ID,
    }));
    expect(result.brief).toEqual(revisionRow);
    // The in-place UPDATE of the briefs row must NOT happen — the only update left is the tasks flag.
    expect(client.update).not.toHaveBeenCalledWith(expect.objectContaining({ iteration: expect.anything() }));
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      awaiting_human_input: true, awaiting_human_ref: { type: 'brief', id: 'brief-1' },
    }));
  });

  it('OMITS decision_ref from the patch when the caller does not pass one — the pointer carries forward', async () => {
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, iterate_feedback: 'again',
    });
    // ABSENT, not null. `_patch: { decision_ref: null }` is the old destructive write wearing a new hat.
    expect(patchOf(client)._patch).not.toHaveProperty('decision_ref');
    expect(patchOf(client)._patch).not.toHaveProperty('pending_activity');
    expect(patchOf(client)._patch).not.toHaveProperty('expand_sections');
    expect(patchOf(client)._patch).not.toHaveProperty('related');
  });

  it('sends decision_ref when the caller passes one, and an explicit null when they pass null', async () => {
    const c1 = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    await composeBrief(c1, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      decision_ref: { type: 'decision', id: 'dec-9' },
    });
    expect(patchOf(c1)._patch.decision_ref).toEqual({ type: 'decision', id: 'dec-9' });

    const c2 = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    await composeBrief(c2, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      decision_ref: null as any,
    });
    expect(patchOf(c2)._patch).toHaveProperty('decision_ref');
    expect(patchOf(c2)._patch.decision_ref).toBeNull();
  });

  it('sends pending_activity only when the caller passes it — including an explicit null', async () => {
    // pending_activity: null -> the transition guard is skipped, and the key IS present (clear it).
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'stale-patch-review', doc: okDoc as any, pending_activity: null as any,
    });
    expect(patchOf(client)._patch).toHaveProperty('pending_activity');
    expect(patchOf(client)._patch.pending_activity).toBeNull();
  });

  it('the patch always carries the recomposed reason, doc and rendered content', async () => {
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      expand_sections: { reasoning: 'long form' }, related: [{ type: 'ticket', id: 'B-1' }],
    });
    const patch = patchOf(client)._patch;
    expect(patch.reason).toBe('clarification-draft');
    expect(patch.doc).toEqual(expect.objectContaining({ decide: 'x' }));
    expect(patch.content).toContain('## DECIDE: x');
    expect(patch.expand_sections).toEqual({ reasoning: 'long form' });
    expect(patch.related).toEqual([{ type: 'ticket', id: 'B-1' }]);
  });

  it('passes _iterate_feedback: null on a re-compose with no feedback — never fabricates one', async () => {
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: null }], revisionOk);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(patchOf(client)._iterate_feedback).toBeNull();
  });

  it('a FIRST compose never calls the revision RPC — there is no predecessor to supersede', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: { id: 'brief-1' } }, { data: null }], revisionOk);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, iterate_feedback: 'ignored here',
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.insert).toHaveBeenCalled();
  });

  // ── the guarded degradation (B-383): only an ABSENT RPC degrades ─────────────────────────────────
  it('degrades to the in-place iterate when compose_brief_revision does not exist (42883)', async () => {
    // responses: [active found] -> [in-place update row] -> [task update]
    const client = makeClient(
      [{ data: { id: 'brief-1', iteration: 1 } }, { data: { id: 'brief-1', iteration: 2 } }, { data: null }],
      { compose_brief_revision: { data: null, error: { code: '42883', message: 'function public.compose_brief_revision(uuid, jsonb, text, uuid) does not exist' } } },
    );
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, iterate_feedback: 'lost on an old DB, by design',
    });
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ iteration: 2 }));
    expect((result.brief as any).iteration).toBe(2);
  });

  it('degrades on the PostgREST schema-cache shape (PGRST202) too', async () => {
    const client = makeClient(
      [{ data: { id: 'brief-1', iteration: 1 } }, { data: { id: 'brief-1', iteration: 2 } }, { data: null }],
      { compose_brief_revision: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.compose_brief_revision in the schema cache' } } },
    );
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ iteration: 2 }));
  });

  it('the in-place fallback still carries the pre-B-843 payload — including the pending_resolution clear', async () => {
    const client = makeClient(
      [{ data: { id: 'brief-1', iteration: 1 } }, { data: { id: 'brief-1', iteration: 2 } }, { data: null }],
      { compose_brief_revision: { data: null, error: { code: '42883', message: 'does not exist' } } },
    );
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ pending_resolution: null, iteration: 2 }));
  });

  it('RETHROWS a permission error from the RPC — never silently falls back to the destructive write', async () => {
    const client = makeClient(
      [{ data: { id: 'brief-1', iteration: 1 } }, { data: { id: 'brief-1', iteration: 2 } }, { data: null }],
      { compose_brief_revision: { data: null, error: { code: '42501', message: 'permission denied for table briefs' } } },
    );
    await expect(composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    })).rejects.toThrow(/permission denied/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('RETHROWS a transient error from the RPC — a blip is not "substrate absent"', async () => {
    const client = makeClient(
      [{ data: { id: 'brief-1', iteration: 1 } }, { data: { id: 'brief-1', iteration: 2 } }, { data: null }],
      { compose_brief_revision: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } },
    );
    await expect(composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    })).rejects.toThrow(/statement timeout/);
  });

  describe('isMissingComposeBriefRevision', () => {
    it('matches only the two schema-absence shapes', () => {
      expect(isMissingComposeBriefRevision({ code: '42883', message: 'x' })).toBe(true);
      expect(isMissingComposeBriefRevision({ code: 'PGRST202', message: 'x' })).toBe(true);
      expect(isMissingComposeBriefRevision({ message: 'Could not find the function public.compose_brief_revision in the schema cache' })).toBe(true);
    });
    it('never matches a permission, transient or unrelated error', () => {
      expect(isMissingComposeBriefRevision({ code: '42501', message: 'permission denied' })).toBe(false);
      expect(isMissingComposeBriefRevision({ code: '57014', message: 'statement timeout' })).toBe(false);
      expect(isMissingComposeBriefRevision({ message: 'compose_brief_revision returned null' })).toBe(false);
      expect(isMissingComposeBriefRevision(null)).toBe(false);
      expect(isMissingComposeBriefRevision(undefined)).toBe(false);
    });
  });

  it('compose_brief exposes iterate_feedback as a string parameter', () => {
    const props = composeBriefTool.inputSchema.properties as any;
    expect(props.iterate_feedback.type).toBe('string');
    expect(props.iterate_feedback.description).toMatch(/VERBATIM/);
    // Never required: a first draft has no causing feedback.
    expect(composeBriefTool.inputSchema.required).not.toContain('iterate_feedback');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// B-843 — the three gate skills that own an iterate branch must tell the composer to pass the feedback.
// Prose contract test, same pattern as the B-876 / B-732 skill-pointer tests below.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe.each([
  ['harmony-clarify', 'skills/harmony-clarify/SKILL.md'],
  ['harmony-decompose', 'skills/harmony-decompose/SKILL.md'],
  ['harmony-design-decide', 'skills/harmony-design-decide/SKILL.md'],
])('B-843 iterate_feedback threading — %s', (_name, rel) => {
  const prose = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

  it('its edit/iterate branch names iterate_feedback and demands the human\'s VERBATIM words', () => {
    const line = prose.split('\n').find((l) => l.includes('**edit** / **iterate**'));
    expect(line).toBeDefined();
    expect(line).toContain('iterate_feedback');
    expect(line).toMatch(/VERBATIM/);
  });

  it('it warns that omitted fields CARRY FORWARD rather than being cleared', () => {
    const line = prose.split('\n').find((l) => l.includes('**edit** / **iterate**'));
    expect(line).toMatch(/CARRY FORWARD/);
    expect(line).toContain('decision_ref');
  });
});

describe('composeBrief — B-715 stale gate (substrate guard)', () => {
  const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 1 };

  it('refuses to compose a state-advancing brief on a stale ticket', async () => {
    const client = makeClient([{ data: { workflow_state: 'Designed', stale: true } }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'plan-draft', doc: okDoc as any, pending_activity: 'planning',
      }),
    ).rejects.toThrow(/stale/i);
  });

  it('allows composing a stale-patch-review brief on a stale ticket', async () => {
    // pending_activity: null means the guard exercises only on `reason`, not a specific transition.
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'stale-patch-review', doc: okDoc as any, pending_activity: null as any,
      }),
    ).resolves.not.toThrow();
  });

  it('allows composing a revise-scope-review brief on a stale ticket', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'revise-scope-review', doc: okDoc as any, pending_activity: null as any,
      }),
    ).resolves.not.toThrow();
  });

  it('still allows a normal compose when stale is false', async () => {
    // responses: [task state] -> [transition exists] -> [no active brief] -> [insert row] -> [task update]
    const client = makeClient([
      { data: { workflow_state: 'Proposed', stale: false } },
      { data: { to_state: 'Clarified' } },
      { data: null },
      { data: briefRow },
      { data: null },
    ]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'clarifying',
      }),
    ).resolves.not.toThrow();
  });
});

// B-645 iterate-prune: the in-place iterate is the elicitation-claim disposal moment. When
// `underwriting_claim_ids` (the KEPT set) is passed, coupled dangling claims — Asserted rows whose
// underwriting_brief_id is the active brief — are archived unless kept. The mock can't filter rows,
// so "archives drop1 but not keep1 and not uncoupled/foreign rows" is expressed as the exact filter
// chain: eq(underwriting_brief_id, <active brief>) + eq(status,'Asserted') scopes OUT rows coupled to
// other briefs (e.g. a force-quit claim underwriting a different brief) and non-Asserted rows, and
// not(id, in, (keep…)) spares the kept set.
describe('composeBrief — B-645 elicitation-claim iterate-prune', () => {
  const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 2 };

  it('on iterate with underwriting_claim_ids=[keep1]: archives coupled Asserted claims NOT kept', async () => {
    // responses: [active found] -> [brief update] -> [prune await] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: briefRow }, { data: null }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: ['keep1'],
    });
    expect(client.from).toHaveBeenCalledWith('knowledge_decisions');
    expect(client.update).toHaveBeenCalledWith({ status: 'Archived' });
    // Scoped to THIS brief's coupled Asserted claims (drop1 matches; keep1 is spared by the not-in;
    // an uncoupled or other-brief force-quit claim never matches the underwriting_brief_id filter).
    expect(client.eq).toHaveBeenCalledWith('underwriting_brief_id', 'brief-1');
    expect(client.eq).toHaveBeenCalledWith('status', 'Asserted');
    expect(client.not).toHaveBeenCalledWith('id', 'in', '(keep1)');
  });

  it('empty array = archive ALL coupled Asserted claims (no not-in filter)', async () => {
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: briefRow }, { data: null }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: [],
    });
    expect(client.update).toHaveBeenCalledWith({ status: 'Archived' });
    expect(client.eq).toHaveBeenCalledWith('underwriting_brief_id', 'brief-1');
    expect(client.not).not.toHaveBeenCalled();
  });

  it('omitted param = NO prune call (back-compat)', async () => {
    // responses: [active found] -> [brief update] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.from).not.toHaveBeenCalledWith('knowledge_decisions');
    expect(client.update).not.toHaveBeenCalledWith({ status: 'Archived' });
  });

  it('no prune on a FIRST compose even when the param is passed (nothing is coupled yet)', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: { ...briefRow, iteration: 1 } }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: ['keep1'],
    });
    expect(client.from).not.toHaveBeenCalledWith('knowledge_decisions');
  });

  it('tolerates a missing claim column on an older DB (guarded — compose still succeeds)', async () => {
    // responses: [active found] -> [brief update] -> [prune errors: column absent] -> [task update]
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1 } },
      { data: briefRow },
      { data: null, error: { message: 'column knowledge_decisions.underwriting_brief_id does not exist' } },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: ['keep1'],
    });
    expect(result.brief).toEqual(briefRow);
  });

  it('rethrows a REAL prune failure (only the missing-column error is tolerated)', async () => {
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1 } },
      { data: briefRow },
      { data: null, error: { message: 'permission denied for table knowledge_decisions' } },
    ]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
        underwriting_claim_ids: ['keep1'],
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('getBrief', () => {
  it('returns the active brief for a task, with pending_resolution surfaced (B-485)', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    // responses: [brief row] -> [pending_resolution read: none]
    const client = makeClient([{ data: row }, { data: { pending_resolution: null } }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(client.from).toHaveBeenCalledWith('briefs');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(result).toEqual({ ...row, pending_resolution: null });
  });

  it('surfaces a browser-submitted reshape marker on pending_resolution (B-485 / AC3)', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    const pending = { command: 'iterate', detail: 'narrow the scope' };
    // responses: [brief row] -> [pending_resolution read: the reshape marker]
    const client = makeClient([{ data: row }, { data: { pending_resolution: pending } }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toEqual({ ...row, pending_resolution: pending });
  });

  it('returns null (not an enriched object) when there is no active brief', async () => {
    const client = makeClient([{ data: null }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toBeNull();
  });

  it('degrades pending_resolution to null when the column read errors (older DB, no 400 on the core read)', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    // responses: [brief row] -> [pending_resolution read errors: column absent]
    const client = makeClient([{ data: row }, { data: null, error: { message: 'column briefs.pending_resolution does not exist' } }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toEqual({ ...row, pending_resolution: null });
  });

  it('resolves a visual ID via resolveTaskId before looking up the brief', async () => {
    const client = makeClient([{ data: { id: 'brief-1', task_id: 'uuid-x', status: 'active' } }, { data: { pending_resolution: null } }]);
    await getBrief(client, PROJECT_ID, { task_id: 'B-42' });
    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, 'B-42');
  });
});

describe('fetchPendingResolution (B-485 — the conductor auto-pickup detector)', () => {
  it('returns the reshape marker when the active brief has one', async () => {
    const pending = { command: 'iterate', detail: 'defer the migration' };
    const client = makeClient([{ data: { pending_resolution: pending } }]);
    const result = await fetchPendingResolution(client, 'task-1');
    expect(result).toEqual(pending);
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
  });

  it('returns null when there is no pending reshape', async () => {
    const client = makeClient([{ data: { pending_resolution: null } }]);
    expect(await fetchPendingResolution(client, 'task-1')).toBeNull();
  });

  it('returns null when there is no active brief', async () => {
    const client = makeClient([{ data: null }]);
    expect(await fetchPendingResolution(client, 'task-1')).toBeNull();
  });

  it('returns null (never throws) when the column is absent on an older DB', async () => {
    const client = makeClient([{ data: null, error: { message: 'column briefs.pending_resolution does not exist' } }]);
    expect(await fetchPendingResolution(client, 'task-1')).toBeNull();
  });
});

describe('fetchPendingRemark (B-503 — the accept-with-remark detector)', () => {
  it('returns { brief_id, reason, detail } for the most recent unconsumed remark', async () => {
    const client = makeClient([{ data: { id: 'brief-9', reason: 'decomposition-proposal', accept_remark: 'auto-accept decompose if no-split' } }]);
    const r = await fetchPendingRemark(client, 'task-1');
    expect(r).toMatchObject({ brief_id: 'brief-9', reason: 'decomposition-proposal', detail: 'auto-accept decompose if no-split' });
    // The filters that define "unconsumed": remark present AND consumed-stamp NULL.
    expect(client.not).toHaveBeenCalledWith('accept_remark', 'is', null);
    expect(client.is).toHaveBeenCalledWith('accept_remark_consumed_at', null);
  });

  // B-866 — the remark's REFERENT: what a light amendment is applied TO.
  describe('the remark referent (B-866)', () => {
    const briefRow = (over: Record<string, unknown> = {}) => ({
      id: 'brief-9', reason: 'design-decision-draft', accept_remark: 'tighten the scope sentence', ...over,
    });

    it('resolves the promoted knowledge entry via decision_ref and hands back its LIVE content', async () => {
      const client = makeClient([
        { data: briefRow({ decision_ref: { type: 'technical-design', id: 'dec-7' } }) },
        { data: { id: 'dec-7', title: 'B-1: the shape', content: 'the stored entry prose' } },
      ]);
      const r = await fetchPendingRemark(client, 'task-1');
      expect(r?.decision_ref).toEqual({ type: 'technical-design', id: 'dec-7' });
      expect(r?.referent).toEqual({ status: 'entry', entry_id: 'dec-7', title: 'B-1: the shape', content: 'the stored entry prose' });
      expect(client.from).toHaveBeenCalledWith('knowledge_decisions');
    });

    it('DEGRADES VISIBLY when the entry cannot be read: a reconstruction, and it says so', async () => {
      const client = makeClient([
        { data: briefRow({ decision_ref: { type: 'technical-design', id: 'dec-7' }, doc: { decide: 'Pick the shape.', recommend: { text: 'Shape A.' }, items: [] } }) },
        { data: null, error: { message: 'relation "knowledge_decisions" does not exist' } },
      ]);
      const referent = (await fetchPendingRemark(client, 'task-1'))!.referent;
      expect(referent.status).toBe('reconstructed');
      // The whole point: never silently pass a reconstruction off as the real thing.
      expect(referent).toHaveProperty('warning');
      expect((referent as { warning: string }).warning).toContain('LOCAL RECONSTRUCTION');
      expect((referent as { warning: string }).warning).toContain('dec-7');
      // ...and the reconstruction is the SAME projection the accept would have promoted.
      expect((referent as { content: string }).content).toContain('**Decision:** Shape A.');
      expect((referent as { content: string }).content).toContain(ENTRY_PROVENANCE_PREFIX);
    });

    it('states the degradation when the brief carried no decision_ref at all', async () => {
      const client = makeClient([{ data: briefRow({ doc: { decide: 'Pick the shape.', items: [] } }) }]);
      const referent = (await fetchPendingRemark(client, 'task-1'))!.referent;
      expect(referent.status).toBe('reconstructed');
      expect((referent as { warning: string }).warning).toContain('no decision_ref');
      expect(referent.entry_id).toBeNull();
    });

    it('reports unavailable rather than guessing when even the doc cannot be read', async () => {
      const client = makeClient([
        { data: briefRow({ decision_ref: { type: 'technical-design', id: 'dec-7' } }) },
        { data: null, error: { message: 'boom' } },
      ]);
      const referent = (await fetchPendingRemark(client, 'task-1'))!.referent;
      expect(referent).toEqual({
        status: 'unavailable',
        entry_id: 'dec-7',
        warning: expect.stringContaining('no reconstruction is possible'),
      });
    });
  });

  it('returns null when no brief carries an unconsumed remark', async () => {
    const client = makeClient([{ data: null }]);
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });

  it('returns null on the missing-column error (older DB) — never throws (B-383 class)', async () => {
    const client = makeClient([{ data: null, error: { message: 'column briefs.accept_remark does not exist' } }]);
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });

  it('returns null for a blank remark (nothing to consume)', async () => {
    const client = makeClient([{ data: { id: 'brief-9', reason: 'plan-draft', accept_remark: '   ' } }]);
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });
});

describe('consumeAcceptRemark (B-503)', () => {
  it('stamps accept_remark_consumed_at where currently NULL — { consumed: true }', async () => {
    const client = makeClient([{ data: { id: 'brief-9' } }]);
    const r = await consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' });
    expect(r).toEqual({ brief_id: 'brief-9', consumed: true });
    expect(client.update).toHaveBeenCalledWith({ accept_remark_consumed_at: expect.any(String) });
    // The idempotency filter: only an un-stamped remark is stamped.
    expect(client.is).toHaveBeenCalledWith('accept_remark_consumed_at', null);
  });

  it('is idempotent: a second call matches zero rows — { consumed: false, already: true }, no error', async () => {
    const client = makeClient([{ data: null }]);
    const r = await consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' });
    expect(r).toEqual({ brief_id: 'brief-9', consumed: false, already: true });
  });

  it('pre-migration guard: the missing-column error returns { unsupported: true } cleanly (B-383 class)', async () => {
    const client = makeClient([{ data: null, error: { message: "Could not find the 'accept_remark_consumed_at' column of 'briefs' in the schema cache" } }]);
    const r = await consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' });
    expect(r).toEqual({ brief_id: 'brief-9', consumed: false, unsupported: true });
  });

  it('rethrows any OTHER error (a real failure must be loud)', async () => {
    const client = makeClient([{ data: null, error: { message: 'permission denied for table briefs' } }]);
    await expect(consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' })).rejects.toThrow(/permission denied/);
  });

  it('requires brief_id', async () => {
    const client = makeClient([]);
    await expect(consumeAcceptRemark(client, PROJECT_ID, { brief_id: '' })).rejects.toThrow(/brief_id/);
  });
});

describe('resolveBrief', () => {
  function makeRpcClient(active: unknown, rpcResult: unknown) {
    const chain: any = {};
    for (const m of ['from', 'select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: active, error: null }));
    chain.rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    return chain;
  }

  it('looks up the (unique) active brief then calls the resolve_brief RPC for accept', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_id: 'brief-1', workflow_state: 'Clarified', brief_status: 'accepted' });
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('resolve_brief', { _brief_id: 'brief-1', _command: 'accept', _detail: null, p_provenance: 'human-in-session' });
    expect(result).toEqual({ brief_id: 'brief-1', workflow_state: 'Clarified', brief_status: 'accepted' });
  });

  it('passes the detail through for defer', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_status: 'deferred' });
    await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'defer', detail: 'later', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('resolve_brief', { _brief_id: 'brief-1', _command: 'defer', _detail: 'later', p_provenance: 'human-in-session' });
  });

  it('rejects commands other than accept/defer', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, {});
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'iterate' as any, provenance: 'human-in-session' }))
      .rejects.toThrow(/only accept\/defer/i);
  });

  it('throws when there is no active brief', async () => {
    const client = makeRpcClient(null, {});
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' }))
      .rejects.toThrow(/no active brief/i);
  });

  it('returns the RPC payload verbatim, including the idempotent flag', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_id: 'brief-1', command: 'accept', workflow_state: 'Clarified', brief_status: 'accepted', idempotent: true });
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' });
    expect(result).toEqual({ brief_id: 'brief-1', command: 'accept', workflow_state: 'Clarified', brief_status: 'accepted', idempotent: true });
  });
});

// B-883: the plugin can carry a remark on an accept — the channel B-503 built and only the browser
// could reach. The governing rule for this whole surface: a remark is either recorded and consumable, or
// the caller is TOLD it was not. There is no third outcome where a remark is accepted and quietly dropped.
describe('resolveBrief — accept-with-remark (B-883)', () => {
  // A stateful fake standing in for the briefs row, so the headline test can be a REAL round trip:
  // resolveBrief WRITES through the RPC, then fetchPendingRemark (what backs get_task's pending_remark)
  // READS it back. Both are the production functions; only the database is faked.
  function makeRoundTripClient(opts: { supportsRemarkParam?: boolean } = {}) {
    const supportsRemarkParam = opts.supportsRemarkParam !== false;
    const store: { accept_remark: string | null; accept_remark_consumed_at: string | null } = {
      accept_remark: null,
      accept_remark_consumed_at: null,
    };
    const chain: any = { store, rpcCalls: [] as unknown[] };
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit']) chain[m] = vi.fn(() => chain);

    // Reads: the active-brief lookup (resolveBrief) and the pending-remark read (fetchPendingRemark).
    let readMode: 'active' | 'remark' = 'active';
    chain.select = vi.fn((cols: string) => { readMode = cols.includes('accept_remark') ? 'remark' : 'active'; return chain; });
    chain.maybeSingle = vi.fn(async () => {
      if (readMode === 'active') return { data: { id: 'brief-1' }, error: null };
      if (store.accept_remark && !store.accept_remark_consumed_at) {
        return { data: { id: 'brief-1', reason: 'plan-draft', accept_remark: store.accept_remark }, error: null };
      }
      return { data: null, error: null };
    });

    chain.rpc = vi.fn(async (_name: string, params: any) => {
      chain.rpcCalls.push(params);
      if ('p_remark' in params && !supportsRemarkParam) {
        // What PostgREST returns when the deployed function signature lacks the parameter (PGRST202).
        return { data: null, error: { message: 'Could not find the function public.resolve_brief(_brief_id, _command, _detail, p_provenance, p_remark) in the schema cache' } };
      }
      // The RPC's own guard: a blank remark writes nothing.
      if (typeof params.p_remark === 'string' && params.p_remark.trim() !== '') store.accept_remark = params.p_remark;
      return { data: { brief_id: 'brief-1', command: params._command, workflow_state: 'Planned', brief_status: 'accepted' }, error: null };
    });
    return chain;
  }

  it('ROUND TRIP: an accept carrying a remark is afterwards visible as pending_remark', async () => {
    const client = makeRoundTripClient();
    await resolveBrief(client, PROJECT_ID, {
      task_id: 'task-1', command: 'accept', remark: 'bump to 0.14.135, read the version from main',
      provenance: 'human-in-session',
    });
    // Forwarded as the RPC parameter that actually writes briefs.accept_remark.
    expect(client.rpcCalls[0]).toEqual({
      _brief_id: 'brief-1', _command: 'accept', _detail: null,
      p_provenance: 'human-in-session', p_remark: 'bump to 0.14.135, read the version from main',
    });
    // ...and read back through the SAME projection the conductor picks up on.
    expect(await fetchPendingRemark(client, 'task-1')).toMatchObject({
      brief_id: 'brief-1', reason: 'plan-draft', detail: 'bump to 0.14.135, read the version from main',
    });
  });

  it('a bare accept is unchanged: no p_remark parameter, no remark_recorded flag', async () => {
    const client = makeRoundTripClient();
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' });
    expect(client.rpcCalls[0]).not.toHaveProperty('p_remark');
    expect(result).not.toHaveProperty('remark_recorded');
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });

  it('reports remark_recorded: true when the remark landed', async () => {
    const client = makeRoundTripClient();
    const result: any = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', remark: 'do the thing', provenance: 'human-in-session' });
    expect(result.remark_recorded).toBe(true);
  });

  it('REJECTS a remark supplied with defer, naming the reason — before any write', async () => {
    const client = makeRoundTripClient();
    await expect(resolveBrief(client, PROJECT_ID, {
      task_id: 'task-1', command: 'defer', remark: 'do this next', provenance: 'human-in-session',
    })).rejects.toThrow(/remark cannot accompany 'defer'/i);
    // Pre-RPC: nothing was written, so there is no partial state to reason about.
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('a plain defer is unaffected — detail still passes through', async () => {
    const client = makeRoundTripClient();
    await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'defer', detail: 'later', provenance: 'human-in-session' });
    expect(client.rpcCalls[0]).toEqual({ _brief_id: 'brief-1', _command: 'defer', _detail: 'later', p_provenance: 'human-in-session' });
  });

  it('a blank / whitespace-only remark behaves exactly as NO remark', async () => {
    for (const blank of ['', '   ', '\n\t ']) {
      const client = makeRoundTripClient();
      const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', remark: blank, provenance: 'human-in-session' });
      expect(client.rpcCalls[0]).not.toHaveProperty('p_remark');
      expect(result).not.toHaveProperty('remark_recorded');
      expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
    }
  });

  it('a blank remark on a DEFER is not rejected either (blank is absent, so nothing rides on the defer)', async () => {
    const client = makeRoundTripClient();
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'defer', remark: '   ', provenance: 'human-in-session' })).resolves.toBeDefined();
  });

  // The visible-degrade rule. A SILENT degrade here would rebuild this ticket's own bug inside its fix.
  it('SCHEMA DRIFT: the accept still succeeds (retried without p_remark) and reports remark_recorded: false', async () => {
    const client = makeRoundTripClient({ supportsRemarkParam: false });
    const result: any = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', remark: 'do the thing', provenance: 'human-in-session' });
    // First attempt carried the parameter; the retry dropped it so the accept could land.
    expect(client.rpcCalls).toHaveLength(2);
    expect(client.rpcCalls[0]).toHaveProperty('p_remark');
    expect(client.rpcCalls[1]).not.toHaveProperty('p_remark');
    // The accept happened...
    expect(result.brief_status).toBe('accepted');
    // ...and the loss is VISIBLE, not silent.
    expect(result.remark_recorded).toBe(false);
  });

  it('the drift predicate is NOT the read-side accept_remark guard — a p_remark error must still be caught', async () => {
    // Regression pin: isMissingAcceptRemark matches 'accept_remark' (the column). This message names
    // 'p_remark' (the parameter) and contains no 'accept_remark' substring, so reusing that guard would
    // never fire and this accept would throw instead of degrading.
    const msg = 'Could not find the function public.resolve_brief(_brief_id, _command, _detail, p_provenance, p_remark) in the schema cache';
    expect(msg).not.toContain('accept_remark');
    const client = makeRoundTripClient({ supportsRemarkParam: false });
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', remark: 'x', provenance: 'human-in-session' })).resolves.toBeDefined();
  });

  it('a NON-drift RPC error is still loud (never swallowed by the retry path)', async () => {
    const client = makeRoundTripClient();
    client.rpc = vi.fn(async () => ({ data: null, error: { message: 'permission denied for table briefs' } }));
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', remark: 'x', provenance: 'human-in-session' }))
      .rejects.toThrow(/permission denied/);
  });

  it('the tool surface distinguishes remark from detail', async () => {
    expect(resolveBriefTool.inputSchema.properties).toHaveProperty('remark');
    // remark is optional — a bare accept must stay valid.
    expect(resolveBriefTool.inputSchema.required).not.toContain('remark');
    expect((resolveBriefTool.inputSchema.properties as any).detail.description).toMatch(/never surfaced as pending_remark/i);
    expect((resolveBriefTool.inputSchema.properties as any).remark.description).toMatch(/pending_remark/);
    expect(resolveBriefTool.description).toMatch(/DIFFERENT CHANNELS/);
  });
});

// B-734 Phase B: provenance is a REQUIRED, VALIDATED input. The DB stores it verbatim and harmony-web
// attributes on an EXACT match, so a wrong value is not a soft failure — it renders as unattributed
// forever and reads as a data problem. The plugin therefore rejects rather than passes through.
describe('resolveBrief — provenance (B-734)', () => {
  function makeRpcClient(active: unknown, rpcResult: unknown) {
    const chain: any = {};
    for (const m of ['from', 'select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: active, error: null }));
    chain.rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    return chain;
  }

  const accept = (client: any, provenance: any) =>
    resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance });

  it.each([
    ['human-in-session', 'the human typed the decision in the running session'],
    ['agent-synthesized', 'the conductor synthesized it, mode unstated'],
    ['agent-synthesized:unattended', 'synthesized under --unattended'],
    ['agent-synthesized:escalate', 'synthesized under --escalate'],
    ['agent-synthesized:pause-at:designed', 'a mode string may itself contain a colon'],
  ])('accepts %s (%s) and threads it to the RPC as p_provenance', async (value) => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_status: 'accepted' });
    await accept(client, value);
    expect(client.rpc).toHaveBeenCalledWith(
      'resolve_brief',
      expect.objectContaining({ p_provenance: value }),
    );
  });

  it("REJECTS 'human-in-browser' — the plugin is never the browser", async () => {
    const client = makeRpcClient({ id: 'brief-1' }, {});
    await expect(accept(client, 'human-in-browser')).rejects.toThrow(
      /'human-in-browser' is the web client's alone/,
    );
    // The anti-forgery property: nothing reached the DB.
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("REJECTS the British-spelling near-miss 'agent-synthesised' rather than storing it", async () => {
    const client = makeRpcClient({ id: 'brief-1' }, {});
    await expect(accept(client, 'agent-synthesised')).rejects.toThrow(
      /unrecognised provenance 'agent-synthesised'/,
    );
    await expect(accept(client, 'agent-synthesised')).rejects.toThrow(
      /accepted values are 'human-in-session', 'agent-synthesized', or 'agent-synthesized:<mode>'/,
    );
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['human', 'a truncation'],
    ['HUMAN-IN-SESSION', 'wrong case — the web match is exact'],
    ['agent', 'a truncation'],
    ['agentsynthesized', 'a missing hyphen'],
    ['agent-synthesized:', 'a colon naming no mode'],
    ['agent-synthesized:   ', 'a colon naming only whitespace'],
  ])('REJECTS %s (%s)', async (value) => {
    const client = makeRpcClient({ id: 'brief-1' }, {});
    await expect(accept(client, value)).rejects.toThrow();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['a non-string', 42],
  ])('REJECTS a %s provenance — absence of provenance is never evidence of a human', async (_label, value) => {
    const client = makeRpcClient({ id: 'brief-1' }, {});
    await expect(accept(client, value)).rejects.toThrow(/provenance is required/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('tolerates surrounding whitespace (not a semantic near-miss) and stores the trimmed value', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_status: 'accepted' });
    await accept(client, '  human-in-session  ');
    expect(client.rpc).toHaveBeenCalledWith(
      'resolve_brief',
      expect.objectContaining({ p_provenance: 'human-in-session' }),
    );
  });

  it('the tool schema declares provenance REQUIRED, and the description names the accepted values', () => {
    expect(resolveBriefTool.inputSchema.properties).toHaveProperty('provenance');
    expect(resolveBriefTool.inputSchema.required).toContain('provenance');
    expect(resolveBriefTool.description).toContain('human-in-session');
    expect(resolveBriefTool.description).toContain('agent-synthesized');
    expect(resolveBriefTool.description).toMatch(/FAILS CLOSED/);
  });
});

describe('validateResolutionProvenance (B-734) — the unit behind the tool', () => {
  it('returns the accepted value unchanged', () => {
    expect(validateResolutionProvenance('human-in-session')).toBe('human-in-session');
    expect(validateResolutionProvenance('agent-synthesized')).toBe('agent-synthesized');
    expect(validateResolutionProvenance('agent-synthesized:unattended')).toBe('agent-synthesized:unattended');
  });

  it('never returns a rejected value — it throws, so nothing can be passed through by accident', () => {
    for (const bad of ['human-in-browser', 'agent-synthesised', 'human', '', null, undefined, 7]) {
      expect(() => validateResolutionProvenance(bad)).toThrow();
    }
  });
});

// B-517: brief-less umbrella verify-ack. A trigger-rolled-up umbrella's verify gate has no active brief,
// so the normal path can't ack it; on `accept` of such a sentinel we advance Deployed→Verified via the
// fixed-contract ack_umbrella_verify RPC. The normal active-brief path must stay completely unchanged.
describe('resolveBrief — brief-less umbrella verify-ack (B-517)', () => {
  // Two queued maybeSingle responses in call order: [active brief lookup] -> [task-row lookup]. rpc returns
  // its own result. The rpc-name assertions confirm we called the umbrella RPC, not resolve_brief.
  function makeUmbrellaClient(briefRow: unknown, taskRow: unknown, rpcResult: unknown) {
    const responses = [{ data: briefRow, error: null }, { data: taskRow, error: null }];
    let i = 0;
    const chain: any = {};
    for (const m of ['from', 'select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => responses[i++] ?? { data: null, error: null });
    chain.rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    return chain;
  }

  const sentinel = {
    workflow_state: 'Deployed',
    awaiting_human_reason: 'verification-ack-pending',
    awaiting_human_ref: { kind: 'umbrella-auto-verify' },
  };

  it('on accept with NO active brief, calls ack_umbrella_verify and returns its result', async () => {
    const rpcResult = { task_id: 'task-1', workflow_state: 'Verified' };
    const client = makeUmbrellaClient(null, sentinel, rpcResult);
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('ack_umbrella_verify', { _task_id: 'task-1' });
    // and it did NOT fall through to the resolve_brief RPC
    expect(client.rpc).not.toHaveBeenCalledWith('resolve_brief', expect.anything());
    expect(result).toEqual(rpcResult);
  });

  // B-734: ack_umbrella_verify is a FIXED-CONTRACT RPC that takes no provenance. The plugin still
  // requires the input (it is one tool), but must NOT thread it into this call.
  it('does NOT thread provenance into the fixed-contract ack_umbrella_verify RPC', async () => {
    const client = makeUmbrellaClient(null, sentinel, { task_id: 'task-1', workflow_state: 'Verified' });
    await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'agent-synthesized:unattended' });
    expect(client.rpc).toHaveBeenCalledWith('ack_umbrella_verify', { _task_id: 'task-1' });
    expect(client.rpc.mock.calls[0][1]).not.toHaveProperty('p_provenance');
  });

  it('leaves the normal active-brief accept path UNCHANGED — still calls resolve_brief, never ack_umbrella_verify', async () => {
    // active brief present -> umbrella branch is never entered.
    const client = makeUmbrellaClient({ id: 'brief-1' }, sentinel, { brief_status: 'accepted' });
    await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('resolve_brief', { _brief_id: 'brief-1', _command: 'accept', _detail: null, p_provenance: 'human-in-session' });
    expect(client.rpc).not.toHaveBeenCalledWith('ack_umbrella_verify', expect.anything());
  });

  it('still errors (no ack) when the brief-less task is NOT an umbrella-auto-verify sentinel', async () => {
    const notSentinel = { workflow_state: 'Built', awaiting_human_reason: null, awaiting_human_ref: null };
    const client = makeUmbrellaClient(null, notSentinel, { task_id: 'task-1' });
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept', provenance: 'human-in-session' }))
      .rejects.toThrow(/no active brief/i);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('does NOT ack a brief-less umbrella on defer — that stays out of scope (still errors)', async () => {
    const client = makeUmbrellaClient(null, sentinel, { task_id: 'task-1' });
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'defer', detail: 'later', provenance: 'human-in-session' }))
      .rejects.toThrow(/no active brief/i);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// B-734 — harmony-conduct §4b prose ↔ provenance contract.
//
// §4b is the ONE path that resolves a brief without a human present: the conductor synthesizes the
// human's accept and routes it through the owning gate skill's own accept path, authenticating with
// the founder's token. If that call omits `agent-synthesized`, the resulting `brief_resolved` entry
// records the founder as having personally decided — forging exactly the warrant B-734 creates, and
// on the common case rather than a corner (forward gates are all delegation may touch).
//
// Prose cannot be type-checked, so this pins it. The B-745 guard for finish-work's O1 evidence-
// missing re-fire (now an ordinary compose_brief re-fire, not a dedicated tool) lives in release-approval.test.ts.
const conductPath = fileURLToPath(new URL('../../skills/harmony-conduct/SKILL.md', import.meta.url));

describe('harmony-conduct §4b synthesized-accept prose ↔ provenance contract (B-734)', () => {
  const prose = readFileSync(conductPath, 'utf8');

  it('declares the agent-synthesized provenance on the auto-advance path', () => {
    expect(prose).toContain(PROVENANCE_AGENT_SYNTHESIZED);
  });

  it('carries the delegation mode with it, not a bare marker', () => {
    expect(prose).toContain(`${PROVENANCE_AGENT_SYNTHESIZED}:<mode>`);
  });

  it('never tells the conductor to claim a browser click', () => {
    // human-in-browser is the web's alone. The conductor reaching for it would let an agent assert
    // that a person clicked Accept; the plugin tool rejects the value, and the prose must not ask.
    expect(prose).not.toMatch(
      new RegExp(`resolve_brief\\([^)]*${PROVENANCE_WEB_ONLY}`),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// B-877 — the de-scope filing heading: constant ↔ prose contract.
//
// `DE_SCOPE_HEADING` is byte-stable forever (older resolved briefs keep their rendered bytes), but unlike
// the proposed-AC heading it is not emitted by the renderer — the skills author it. That split is exactly
// how it drifts: an editor rewording the heading in one SKILL.md leaves the other, and the archive,
// disagreeing, with nothing to catch it. This pins the constant against BOTH prose sites.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const skillPath = (skill: string) => fileURLToPath(new URL(`../../skills/${skill}/SKILL.md`, import.meta.url));

describe('the de-scope heading matches the skill prose that authors and reads it (B-877)', () => {
  it.each([
    ['harmony-clarify', 'authors the block'],
    ['harmony-decompose', 'reads the block'],
  ])('%s (%s) still carries the exact heading', (skill) => {
    expect(readFileSync(skillPath(skill), 'utf8')).toContain(DE_SCOPE_HEADING);
  });

  it('POSITIVE CONTROL — the assertion can fail: a reworded heading is not present in either file', () => {
    const reworded = DE_SCOPE_HEADING.replace('—', '-');
    expect(reworded).not.toBe(DE_SCOPE_HEADING);
    for (const skill of ['harmony-clarify', 'harmony-decompose']) {
      expect(readFileSync(skillPath(skill), 'utf8')).not.toContain(reworded);
    }
  });
});

// ---------------------------------------------------------------------------
// B-732 AC-3: a release brief for a BOT-AUTHORED PR must name the approval requirement
// ---------------------------------------------------------------------------
//
// Why this is a lint and not just prose: the instruction DID exist in finish-work's O1, but the
// daemon flow composes its release brief in start-work's O3 and finish-work skips drafting
// entirely — so the guidance sat in a path that never ran. B-738 then shipped a release brief
// whose entire ask was "Release B-738 … to production?" with no mention of approval. Enforcing it
// in compose_brief makes the omission impossible regardless of which skill composes the brief.

describe('lintBrief — bot-authored release brief must name the approval requirement (B-732)', () => {
  const releaseDoc = (extraContext: string[] = []): BriefDoc => ({
    decide: 'Release B-999 — merge the built artefact?',
    recommend: { text: 'Merge it. Gates are green.', confidence: 'high' },
    context: ['PR: https://github.com/ycomplex/harmony-web/pull/362', ...extraContext],
    items: [
      {
        kind: 'decision',
        text: 'Ship the built artefact',
        recommendation: 'release',
      },
    ],
  });

  const botPr = {
    author_is_bot: true,
    pr_url: 'https://github.com/ycomplex/harmony-web/pull/362',
    pr_number: 362,
  };

  it('REJECTS a bot-authored release brief that says nothing about approval', () => {
    const doc = releaseDoc();
    const lint = lintBrief(doc, renderBrief(doc), {
      reason: 'release-decision-pending',
      buildPr: botPr,
    });

    expect(lint.ok).toBe(false);
    expect(lint.errors.join(' ')).toMatch(/BOT-AUTHORED/);
    // The error must name the PR so the author knows which one needs approving.
    expect(lint.errors.join(' ')).toContain('pull/362');
  });

  it('ACCEPTS a bot-authored release brief that names the approval requirement', () => {
    const doc = releaseDoc([
      'This PR is authored by harmony-daemon[bot] and needs your approval on GitHub before it can merge. Current reviewDecision: REVIEW_REQUIRED.',
    ]);
    const lint = lintBrief(doc, renderBrief(doc), {
      reason: 'release-decision-pending',
      buildPr: botPr,
    });

    expect(lint.ok).toBe(true);
  });

  it('does NOT require the approval line for a FOUNDER-authored PR (the interactive path)', () => {
    const doc = releaseDoc();
    const lint = lintBrief(doc, renderBrief(doc), {
      reason: 'release-decision-pending',
      buildPr: { author_is_bot: false, pr_url: 'https://example.test/pr/1', pr_number: 1 },
    });

    expect(lint.ok).toBe(true);
  });

  it('does not apply to a pre-B-732 ticket whose build_pr records no author', () => {
    // Backward compatibility: build_pr records written before author_is_bot existed must not
    // suddenly fail the release gate.
    const doc = releaseDoc();
    const lint = lintBrief(doc, renderBrief(doc), {
      reason: 'release-decision-pending',
      buildPr: { pr_url: 'https://example.test/pr/1', pr_number: 1 },
    });

    expect(lint.ok).toBe(true);
  });

  it('does not apply to non-release briefs even when a bot build_pr exists', () => {
    const doc: BriefDoc = {
      decide: 'Is this the right approach?',
      recommend: { text: 'Yes', confidence: 'high' },
      items: [{ kind: 'decision', text: 'Approach', recommendation: 'proceed' }],
    };
    const lint = lintBrief(doc, renderBrief(doc), {
      reason: 'design-decision-draft',
      buildPr: botPr,
    });

    expect(lint.ok).toBe(true);
  });

  it('is not fooled by the word "approve" used for the brief-accept verb alone', () => {
    // "Approve this plan?" must NOT satisfy the rule — the requirement is about a GitHub review.
    const doc = releaseDoc(['Approve this and I will merge.']);
    const lint = lintBrief(doc, renderBrief(doc), {
      reason: 'release-decision-pending',
      buildPr: botPr,
    });

    expect(lint.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// B-876 — the per-gate frame
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('B-876 gate frame', () => {
  // ——— fixtures, one per variant ———
  const clarifyFrame = (over: Record<string, unknown> = {}): GateFrame => ({
    kind: 'clarify',
    solving: 'Every gate brief states its own gate-specific must-have in a typed field.',
    in_scope: ['the frame field', 'the render positions'],
    not_solving: [{ item: 'the clarify authoring', lands: 'B-877' }],
    ...over,
  } as GateFrame);

  const decomposeFrame = (over: Record<string, unknown> = {}): GateFrame => ({
    kind: 'decompose',
    elements: [{ text: 'the typed frame', surface: 'harmony-plugin: briefs.ts', covers: 'AC1' }],
    coverage: 'Every acceptance criterion maps to one element and no element is claimed twice.',
    existing_children_checked: true,
    ...over,
  } as GateFrame);

  const designFrame = (over: Record<string, unknown> = {}): GateFrame => ({
    kind: 'design',
    track: 'technical-design',
    tracks: [
      { track: 'product-design', status: 'accepted' },
      { track: 'technical-design', status: 'this-brief' },
      { track: 'ux-ui-design', status: 'not-required', note: 'no rendered surface' },
    ],
    reach: ['the web cards view must learn the frame before it renders'],
    not_reopened: ['the accepted decomposition'],
    derisk: { run: ['rendered all six variants'], not_run: ['nothing load-bearing outstanding'] },
    ...over,
  } as GateFrame);

  const planFrame = (over: Record<string, unknown> = {}): GateFrame => ({
    kind: 'plan',
    scope: { repos: ['harmony-plugin'], surfaces: ['briefs.ts', 'five skills'], has_migration: false },
    steps: ['Add the types', 'Render per gate', 'Lint warn-only'],
    attestation: { base_verified: 'renderBrief and lintBrief were read in current code this session.' },
    carried_unproven: [],
    ac_coverage: 'All nine acceptance criteria.',
    ...over,
  } as GateFrame);

  const releaseFrame = (over: Record<string, unknown> = {}): GateFrame => ({
    kind: 'release',
    act: {
      repos: ['harmony-plugin'],
      pr_count: 1,
      lands_in: 'staging',
      atomicity: 'single',
      irreversible: [],
    },
    unproven: [{ item: 'the web cards view', reason: 'it does not render the frame yet' }],
    evidence_status: { proven_by_run: 7, walk_at_verify: 2, unproven: 0, total: 9 },
    risk_classes: [],
    ...over,
  } as GateFrame);

  const criterionRow = (i: number, over: Partial<CriterionRow> = {}): CriterionRow => ({
    ac_id: `ac-${i}`,
    text: `Criterion ${i} — the frame renders in the right place`,
    checked: false,
    disposition: 'walk',
    step_ref: String(i),
    ...over,
  });

  const verifyFrame = (rows = 3, over: Record<string, unknown> = {}): GateFrame => ({
    kind: 'verify',
    environment: 'staging',
    criteria: Array.from({ length: rows }, (_, i) => criterionRow(i + 1)),
    evidence_status: '✓ complete',
    ...over,
  } as GateFrame);

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // THE ACCEPTANCE CRITERION: a frame-less doc renders EXACTLY today's bytes.
  //
  // Both strings below were captured from the PRE-B-876 renderer (git HEAD before this change,
  // bundled and executed), not from the new one — so they are a genuine before/after pin, not a
  // snapshot of whatever the code happens to produce now.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('a frame-absent doc renders byte-identical output to today', () => {
    const PRE_B876_RELEASE_SHAPED = "## DECIDE: Release B-876 — merge the plugin PR and deploy to staging?\n\n**Recommend (high confidence):** Ship it.\n\n**On accept:** advances Built → Deployed\n\n**Why:**\n- The suite is green.\n- The change is additive.\n\n**Alternatives:**\n- Hold for the next batch — nothing else is queued\n\n**Context:**\n- PR: https://example.invalid/pull/1\n\n**You need to:**\n- [ ] Ship the built artefact — *recommend: release*\n\n_This brief is a summary — fuller depth lives in the linked decision entry._\n\n> Type `accept`, `edit`, `iterate <feedback>`, or `defer`.";

    const PRE_B876_CLARIFY_SHAPED = "## DECIDE: Lock the clarified scope for B-876?\n\n**Recommend (moderate confidence):** Lock it.\n\n**On accept:** no state change\n\n**Why:**\n- The boundary held through two rounds.\n\n**Context:**\n- B-865 is the parent frame decision.\n\nProposed acceptance criteria (happy path) — filed on accept:\n- The frame renders per gate\n\n**You need to:**\n- [ ] Lock the scope — *recommend: lock*\n- [ ] Name the excluded surface *(your input needed)*\n\n> Type `accept`, `edit`, `iterate <feedback>`, or `defer`.";

    const releaseShapedDoc = (): BriefDoc => ({
      decide: 'Release B-876 — merge the plugin PR and deploy to staging?',
      recommend: { text: 'Ship it.', confidence: 'high' },
      why: ['The suite is green.', 'The change is additive.'],
      alternatives: [{ option: 'Hold for the next batch', rejection: 'nothing else is queued' }],
      context: ['PR: https://example.invalid/pull/1'],
      items: [{ kind: 'decision', text: 'Ship the built artefact', recommendation: 'release' }],
    });

    const clarifyShapedDoc = (): BriefDoc => ({
      decide: 'Lock the clarified scope for B-876?',
      recommend: { text: 'Lock it.', confidence: 'medium' },
      why: ['The boundary held through two rounds.'],
      context: ['B-865 is the parent frame decision.'],
      items: [
        { kind: 'decision', text: 'Lock the scope', recommendation: 'lock' },
        { kind: 'content-input', text: 'Name the excluded surface' },
      ],
      payload: [{ write_kind: 'acceptance_criterion', ref: 'ac-x', content: 'The frame renders per gate' }],
    });

    it('renders the pre-B-876 bytes exactly, for a full release-shaped doc with no frame', () => {
      const md = renderBrief(releaseShapedDoc(), { type: 'decision', id: 'dec-1' }, {
        reason: 'release-decision-pending', accept: { from: 'Built', to: 'Deployed' },
      });
      expect(md).toBe(PRE_B876_RELEASE_SHAPED);
    });

    it('renders the pre-B-876 bytes exactly, for a clarify-shaped doc with a payload-derived AC block', () => {
      const md = renderBrief(clarifyShapedDoc(), null, { reason: 'clarification-draft', accept: null });
      expect(md).toBe(PRE_B876_CLARIFY_SHAPED);
    });

    it('an explicitly-undefined frame and revision are indistinguishable from omitting them', () => {
      const withKeys = { ...releaseShapedDoc(), frame: undefined, revision: undefined };
      const md = renderBrief(withKeys, { type: 'decision', id: 'dec-1' }, {
        reason: 'release-decision-pending', accept: { from: 'Built', to: 'Deployed' },
      });
      expect(md).toBe(PRE_B876_RELEASE_SHAPED);
    });

    it('still renders today’s bytes on a bare 1-arg call (no decisionRef, no ctx)', () => {
      const md = renderBrief(releaseShapedDoc());
      expect(md).not.toContain('**On accept:**');
      expect(md).toContain('## DECIDE: Release B-876');
      expect(md.endsWith(`> ${DEFAULT_TAIL}`)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Position, per gate — including both exceptions.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('render position', () => {
    const render = (frame: GateFrame, over: Partial<BriefDoc> = {}) =>
      renderBrief(baseDoc({ recommend: { text: 'Proceed.', confidence: 'high' }, frame, ...over }), null, {
        reason: 'x', accept: { from: 'A', to: 'B' },
      });

    it('EXCEPTION 1 — clarify renders ABOVE ## DECIDE:', () => {
      const md = render(clarifyFrame());
      expect(md.indexOf('## SOLVING:')).toBeGreaterThanOrEqual(0);
      expect(md.indexOf('## SOLVING:')).toBeLessThan(md.indexOf('## DECIDE:'));
      expect(md).toContain('**In scope:**');
      expect(md).toContain('- the clarify authoring — B-877');
    });

    it('EXCEPTION 2 — release renders AFTER DECIDE and BEFORE Recommend', () => {
      const md = render(releaseFrame());
      const decide = md.indexOf('## DECIDE:');
      const act = md.indexOf('**This accept executes:**');
      const rec = md.indexOf('**Recommend');
      expect(decide).toBeLessThan(act);
      expect(act).toBeLessThan(rec);
      expect(md).toContain('**One-way in this:** nothing — every step is revertable');
      expect(md).toContain('**Risk (path-derived from the diff):** none');
      expect(md).toContain('**Evidence (mechanical):** 7/9 proven by a test that RAN');
    });

    it('decompose renders after Recommend and above the On-accept line', () => {
      const md = render(decomposeFrame());
      const rec = md.indexOf('**Recommend');
      const elements = md.indexOf('**The elements — 1:**');
      const onAccept = md.indexOf('**On accept:**');
      expect(rec).toBeLessThan(elements);
      expect(elements).toBeLessThan(onAccept);
      expect(md).toContain('**Coverage:**');
      expect(md).toContain('**Existing children checked:** yes');
    });

    it('design renders after Recommend, with the track map and an explicit empty reach', () => {
      const md = render(designFrame({ reach: [] }));
      expect(md.indexOf('**Recommend')).toBeLessThan(md.indexOf('**Track:**'));
      expect(md).toContain('**Track:** technical-design · product-design accepted · ux-ui-design not-required (no rendered surface)');
      expect(md).toContain('**Reach beyond this ticket:** none — this decision reaches nothing outside the ticket');
      expect(md).toContain('**De-risked by running:**');
    });

    it('plan renders its frame after Recommend and its STEPS under **Plan:** just above the ask', () => {
      const md = render(planFrame(), { context: ['a context bullet'] });
      const rec = md.indexOf('**Recommend');
      const touches = md.indexOf('**Touches:**');
      const plan = md.indexOf('**Plan:**');
      const needTo = md.indexOf('**You need to:**');
      expect(rec).toBeLessThan(touches);
      expect(touches).toBeLessThan(plan);
      expect(plan).toBeLessThan(needTo);
      expect(md).toContain('1. Add the types');
      expect(md).toContain('**Carried into build unproven:** nothing');
    });

    it('verify renders the criteria ledger as a table after Recommend', () => {
      const md = render(verifyFrame(2));
      expect(md.indexOf('**Recommend')).toBeLessThan(md.indexOf('**Verifying against'));
      expect(md).toContain('**Verifying against — 2 criteria on file · you can confirm 2 today**');
      expect(md).toContain('| # | Criterion (as filed) | Disposition | Step | Backed by |');
      expect(md).toContain('| 1 | Criterion 1 — the frame renders in the right place | ✅ walk now | 1 | — |');
      expect(md).toContain('**Covers:** staging');
    });

    it('escapes a pipe inside a criterion so one AC cannot break the ledger table', () => {
      const md = render(verifyFrame(1, { criteria: [criterionRow(1, { text: 'a | b' })] }));
      expect(md).toContain('| 1 | a \\| b |');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // The revision block.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('the revision block', () => {
    it('renders directly under the On-accept line on round 2, never above the frame', () => {
      const md = renderBrief(
        baseDoc({
          frame: decomposeFrame(),
          revision: { round: 2, changes: [{ change: 'Priced the rejected cut', responds_to: 'your round-1 note on shippability' }] },
        }),
        null,
        { reason: 'decomposition-proposal', accept: { from: 'Clarified', to: 'Decomposed' } },
      );
      const frame = md.indexOf('**The elements');
      const onAccept = md.indexOf('**On accept:**');
      const changed = md.indexOf('**Changed this round:**');
      const why = md.indexOf('**Why:**');
      expect(frame).toBeLessThan(onAccept);
      expect(onAccept).toBeLessThan(changed);
      expect(changed).toBeLessThan(why);
      expect(md).toContain('- Priced the rejected cut — *answers: your round-1 note on shippability*');
    });

    it('renders under the clarify frame too — the frame stays the top line at every round', () => {
      const md = renderBrief(
        baseDoc({ frame: clarifyFrame(), revision: { round: 3, changes: [{ change: 'Narrowed the boundary', responds_to: 'iterate: too broad' }] } }),
        null,
        { reason: 'clarification-draft', accept: null },
      );
      expect(md.indexOf('## SOLVING:')).toBeLessThan(md.indexOf('**Changed this round:**'));
    });

    it('is ABSENT on a first-round brief that carries no revision block', () => {
      const md = renderBrief(baseDoc({ frame: decomposeFrame() }), null, { reason: 'decomposition-proposal', accept: null });
      expect(md).not.toContain('**Changed this round:**');
    });

    it('is absent when the revision block carries no changes', () => {
      const md = renderBrief(baseDoc({ revision: { round: 2, changes: [] } }), null, { reason: 'plan-draft', accept: null });
      expect(md).not.toContain('**Changed this round:**');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // frameUnits + the tier word budget.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('frameUnits and the tier-aware budget', () => {
    it('counts nothing for an absent frame', () => {
      expect(frameUnits(undefined)).toBe(0);
    });

    it('counts criteria rows, elements, act steps and unproven entries', () => {
      expect(frameUnits(verifyFrame(14))).toBe(14);
      expect(frameUnits(decomposeFrame())).toBe(1);
      // release: 1 unproven + (1 repo + 0 irreversible)
      expect(frameUnits(releaseFrame())).toBe(2);
      // plan: 3 steps + 0 carried_unproven + no landing
      expect(frameUnits(planFrame())).toBe(3);
      expect(frameUnits(clarifyFrame())).toBe(3);
    });

    it('prevents a FALSE bloat warning on a large criteria ledger (same bytes, budget differs)', () => {
      const content = 'word '.repeat(900);
      const framed = baseDoc({ frame: verifyFrame(14), recommend: { text: 'Ack.', confidence: 'high' } });
      const unframed = baseDoc({ recommend: { text: 'Ack.', confidence: 'high' } });
      const bloat = /soft budget/;
      // Positive control: the identical rendered length DOES warn without the frame's units.
      expect(lintBrief(unframed, content).warnings.join(' ')).toMatch(bloat);
      expect(lintBrief(framed, content).warnings.join(' ')).not.toMatch(bloat);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // stripForLegibility additions (exercised through the two B-660 nudges).
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('stripForLegibility treats frame output as structured, not prose', () => {
    const NUDGE_A = /one idea per sentence/i;
    const NUDGE_B = /unstack these/i;
    const quiet = baseDoc({ recommend: { text: 'Adopt.', confidence: 'high' } });
    const longRun = Array.from({ length: SENTENCE_WORD_LIMIT + 5 }, (_, i) => `word${i}`).join(' ');

    it('does not read a Markdown table row as a sentence (the verify ledger)', () => {
      const content = `## DECIDE: x\n\n| # | Criterion | Disposition |\n|---|---|---|\n| 1 | ${longRun} (an aside (inside an aside)) | walk |\n`;
      const r = lintBrief(quiet, content);
      expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
      expect(r.warnings.join(' ')).not.toMatch(NUDGE_B);
    });

    it('does not read a **Label:** field line as prose', () => {
      const content = `## DECIDE: x\n\n**Coverage:** ${longRun} (an aside (inside an aside)).\n`;
      const r = lintBrief(quiet, content);
      expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
      expect(r.warnings.join(' ')).not.toMatch(NUDGE_B);
    });

    it('POSITIVE CONTROL — the same words as an ordinary paragraph still trip both nudges', () => {
      const content = `## DECIDE: x\n\n${longRun} (an aside (inside an aside)).\n`;
      const r = lintBrief(quiet, content);
      expect(r.warnings.join(' ')).toMatch(NUDGE_A);
      expect(r.warnings.join(' ')).toMatch(NUDGE_B);
    });

    it('POSITIVE CONTROL — the **Recommend:** line is NOT stripped (the B-660 calibration anchor)', () => {
      const content = `## DECIDE: x\n\n**Recommend (high confidence):** ${longRun} (an aside (inside an aside)).\n`;
      const r = lintBrief(quiet, content);
      expect(r.warnings.join(' ')).toMatch(NUDGE_A);
      expect(r.warnings.join(' ')).toMatch(NUDGE_B);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // THE OTHER ACCEPTANCE CRITERION: every new rule is a WARNING. Nothing refuses a brief.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('every frame rule warns and none errors', () => {
    const FRAMED_REASONS = Object.keys(FRAME_KIND_FOR_REASON);
    const wellFormed: Record<string, GateFrame> = {
      'clarification-draft': clarifyFrame(),
      'decomposition-proposal': decomposeFrame(),
      'design-decision-draft': designFrame(),
      'plan-draft': planFrame(),
      'release-decision-pending': releaseFrame(),
      'verification-ack-pending': verifyFrame(2),
    };

    it.each(FRAMED_REASONS)('a MISSING frame at %s warns and never errors', (reason) => {
      const doc = baseDoc();
      const r = lintBrief(doc, renderBrief(doc, null, { reason }), { reason });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('carries no `doc.frame`');
    });

    it.each(FRAMED_REASONS)('a MISMATCHED frame kind at %s warns and never errors', (reason) => {
      const otherReason = FRAMED_REASONS.find((x) => x !== reason)!;
      const doc = baseDoc({ frame: wellFormed[otherReason] });
      const r = lintBrief(doc, renderBrief(doc, null, { reason }), { reason });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain("but this brief's reason is");
    });

    it.each(FRAMED_REASONS)('a MALFORMED frame at %s warns and never errors', (reason) => {
      // The bare `kind` alone — every required sub-field missing.
      const doc = baseDoc({ frame: { kind: FRAME_KIND_FOR_REASON[reason] } as GateFrame });
      const r = lintBrief(doc, renderBrief(doc, null, { reason }), { reason });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.length).toBeGreaterThan(0);
    });

    it('a malformed frame still RENDERS without throwing at every framed reason', () => {
      for (const reason of FRAMED_REASONS) {
        const doc = baseDoc({ frame: { kind: FRAME_KIND_FOR_REASON[reason] } as GateFrame });
        expect(() => renderBrief(doc, null, { reason })).not.toThrow();
      }
    });

    it('names the specific decompose gaps: empty elements, blank coverage, absent alternatives', () => {
      const doc = baseDoc({ frame: decomposeFrame({ elements: [], coverage: '  ' }) });
      const w = lintBrief(doc, renderBrief(doc), { reason: 'decomposition-proposal' });
      expect(w.errors).toEqual([]);
      expect(w.warnings.join(' ')).toContain('`frame.elements` is empty');
      expect(w.warnings.join(' ')).toContain('`frame.coverage` is blank');
      expect(w.warnings.join(' ')).toContain('no `alternatives`');
    });

    it('warns on an absent reach KEY at design — the highest-signal rule, and still only a warning', () => {
      const frame = designFrame();
      delete (frame as unknown as Record<string, unknown>).reach;
      const doc = baseDoc({ frame, alternatives: [{ option: 'a', rejection: 'b' }] });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'design-decision-draft' });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('`frame.reach` is absent');
    });

    it('exempts the ux-ui-design track from the alternatives rule (visual-handoff §D2)', () => {
      const doc = baseDoc({ frame: designFrame({ track: 'ux-ui-design' }) });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'design-decision-draft' });
      expect(r.warnings.join(' ')).not.toContain('no `alternatives`');
    });

    it('warns when a not-required track carries no note', () => {
      const doc = baseDoc({
        alternatives: [{ option: 'a', rejection: 'b' }],
        frame: designFrame({ tracks: [{ track: 'ux-ui-design', status: 'not-required' }] }),
      });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'design-decision-draft' });
      expect(r.warnings.join(' ')).toContain("declared not-required with no note");
    });

    it('warns when a multi-repo or migration plan states no landing shape', () => {
      const doc = baseDoc({ frame: planFrame({ scope: { repos: ['harmony-web', 'harmony-plugin'], surfaces: [], has_migration: true } }) });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'plan-draft' });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('`frame.landing` is absent');
    });

    it('warns when an ordered release names no ordering', () => {
      const doc = baseDoc({
        frame: releaseFrame({ act: { repos: ['a', 'b'], pr_count: 2, lands_in: 'staging', atomicity: 'ordered', irreversible: ['the migration'] } }),
      });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'release-decision-pending' });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain("`frame.act.ordering` is blank");
    });

    it("warns when a 'walk' criterion names no step_ref", () => {
      const doc = baseDoc({ frame: verifyFrame(1, { criteria: [criterionRow(1, { step_ref: undefined })] }) });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'verification-ack-pending' });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain("names no `step_ref`");
    });

    it("warns on an empty criteria ledger with no exempt_reason, and stays silent when one is given", () => {
      const bare = baseDoc({ frame: verifyFrame(0) });
      expect(lintBrief(bare, renderBrief(bare), { reason: 'verification-ack-pending' }).warnings.join(' '))
        .toContain('acks against nothing');
      const exempt = baseDoc({ frame: verifyFrame(0, { exempt_reason: 'umbrella — carried by children' }) });
      expect(lintBrief(exempt, renderBrief(exempt), { reason: 'verification-ack-pending' }).warnings.join(' '))
        .not.toContain('acks against nothing');
    });

    it('leaves `frame` UNCONSTRAINED at stale-patch-review and revise-scope-review', () => {
      for (const reason of ['stale-patch-review', 'revise-scope-review']) {
        const doc = baseDoc();
        const r = lintBrief(doc, renderBrief(doc, null, { reason }), { reason });
        expect(r.errors).toEqual([]);
        expect(r.warnings.join(' ')).not.toContain('doc.frame');
      }
    });

    it('a well-formed frame produces no frame warnings at its own gate', () => {
      const cases: Array<[string, BriefDoc]> = [
        ['decomposition-proposal', baseDoc({ frame: decomposeFrame(), alternatives: [{ option: 'split by repo', rejection: 'no independent shippability' }] })],
        ['design-decision-draft', baseDoc({ frame: designFrame(), alternatives: [{ option: 'a sibling column', rejection: 'splits the canonical artefact' }] })],
        ['plan-draft', baseDoc({ frame: planFrame() })],
        ['release-decision-pending', baseDoc({ frame: releaseFrame() })],
        ['verification-ack-pending', baseDoc({ frame: verifyFrame(2) })],
        ['clarification-draft', baseDoc({ frame: clarifyFrame() })],
      ];
      for (const [reason, doc] of cases) {
        const r = lintBrief(doc, renderBrief(doc, null, { reason }), { reason });
        expect(r.errors).toEqual([]);
        expect(r.warnings.filter((w) => /`frame\./.test(w) || /doc\.frame/.test(w))).toEqual([]);
      }
    });

    it('warns (never errors) on a round-1 revision block and an unbound change', () => {
      const doc = baseDoc({ revision: { round: 1, changes: [{ change: 'Rewrote the ask', responds_to: '' }] } });
      const r = lintBrief(doc, renderBrief(doc), {});
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('is a round-2+ artefact');
      expect(r.warnings.join(' ')).toContain('names no feedback it responds to');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // B-877 — the CLARIFY frame rules, pinned as a regression.
  //
  // The rules themselves shipped with B-876; what B-877 adds is the skill prose that authors the frame.
  // These tests exist so the shipped clarify case cannot silently regress under the new prose, and they
  // assert `ok: true` with zero errors in EVERY case including the failures — a frame defect must never
  // be able to refuse a brief.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('the clarify frame warns on each defect and never refuses the brief', () => {
    const CLARIFY = 'clarification-draft';
    const lintClarify = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc, null, { reason: CLARIFY }), { reason: CLARIFY });
    const frameWarnings = (r: { warnings: string[] }) => r.warnings.filter((w) => /`frame\./.test(w) || /doc\.frame/.test(w));

    it('1. no `doc.frame` at all — warns, no error', () => {
      const r = lintClarify(baseDoc());
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('carries no `doc.frame`');
    });

    it('2. a blank `frame.solving` — warns that it is the OUTCOME, no error', () => {
      const r = lintClarify(baseDoc({ frame: clarifyFrame({ solving: '   ' }) }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('`frame.solving` is blank');
      expect(r.warnings.join(' ')).toContain('OUTCOME');
    });

    it('3. an ABSENT `not_solving` key — warns that `[]` is the legal way to say "nothing", no error', () => {
      const frame = clarifyFrame();
      delete (frame as unknown as Record<string, unknown>).not_solving;
      const r = lintClarify(baseDoc({ frame }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('`frame.not_solving` is absent');
    });

    it('3b. an exclusion naming no destination — warns, no error', () => {
      const r = lintClarify(baseDoc({ frame: clarifyFrame({ not_solving: [{ item: 'saved sort order', lands: '' }] }) }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('names no destination');
    });

    it('3c. an EMPTY `not_solving` list is a legal, silent answer', () => {
      const r = lintClarify(baseDoc({ frame: clarifyFrame({ not_solving: [] }) }));
      expect(r.errors).toEqual([]);
      expect(frameWarnings(r)).toEqual([]);
    });

    it('4. a `frame.kind` mismatched against the reason — warns, no error', () => {
      const r = lintClarify(baseDoc({ frame: planFrame() }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain("but this brief's reason is 'clarification-draft'");
    });

    it('5. a fully valid clarify frame is clean — no frame warnings, no errors', () => {
      const r = lintClarify(baseDoc({ frame: clarifyFrame() }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(frameWarnings(r)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // B-877 — the iteration-gated half of the revision rule (audit §4.2).
  //
  // The sharp edge is the off-by-one: `ctx.iteration` is the POST-increment round, so a FIRST compose is
  // 1 and must never warn. Getting this wrong would fire on every brief ever composed.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('a round-2+ brief owes a revision block (warn-only)', () => {
    const OWED = /carries no `doc.revision`/;
    const lintAt = (doc: BriefDoc, iteration?: number) => lintBrief(doc, renderBrief(doc), { iteration });

    it('warns when the compose will land as iteration 2 and the doc carries no revision', () => {
      const r = lintAt(baseDoc(), 2);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toMatch(OWED);
      expect(r.warnings.join(' ')).toContain('round 2');
    });

    it('does NOT warn on a FIRST compose (iteration 1) — the off-by-one this rule must not get wrong', () => {
      expect(lintAt(baseDoc(), 1).warnings.join(' ')).not.toMatch(OWED);
    });

    it('does NOT warn when the caller supplies no iteration at all', () => {
      expect(lintAt(baseDoc(), undefined).warnings.join(' ')).not.toMatch(OWED);
      expect(lintBrief(baseDoc(), renderBrief(baseDoc()), {}).warnings.join(' ')).not.toMatch(OWED);
    });

    it('is silent at iteration 2 once a well-formed revision block rides the doc', () => {
      const doc = baseDoc({ revision: { round: 2, changes: [{ change: 'Narrowed the boundary', responds_to: 'iterate: too broad' }] } });
      const r = lintAt(doc, 2);
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).not.toMatch(OWED);
      expect(r.warnings.join(' ')).not.toContain('is a round-2+ artefact');
      expect(r.warnings.join(' ')).not.toContain('names no feedback it responds to');
    });

    it('still warns at a high iteration, and stays warn-only', () => {
      const r = lintAt(baseDoc({ frame: clarifyFrame() }), 7);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('round 7');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // The PR-reference rule (warn-only), and the defensive build_pr read.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('the release brief must name its pull request (warn-only)', () => {
    const refs = [{ key: 'build_pr', pr_url: 'https://github.com/ycomplex/harmony-plugin/pull/184', pr_number: 184 }];

    it('warns when the doc names no PR reference at all', () => {
      const doc = baseDoc({ frame: releaseFrame() });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'release-decision-pending', buildPrRefs: refs });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toContain('names no PR reference');
    });

    it('is silent once the PR url rides the doc', () => {
      const doc = baseDoc({ frame: releaseFrame(), context: [`PR: ${refs[0].pr_url}`] });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'release-decision-pending', buildPrRefs: refs });
      expect(r.warnings.join(' ')).not.toContain('names no PR reference');
    });

    it('is silent when only the PR number is cited', () => {
      const doc = baseDoc({ decide: 'Release — merge #184 to staging?', frame: releaseFrame() });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'release-decision-pending', buildPrRefs: refs });
      expect(r.warnings.join(' ')).not.toContain('names no PR reference');
    });

    it('does not apply at any other gate', () => {
      const doc = baseDoc({ frame: planFrame() });
      const r = lintBrief(doc, renderBrief(doc), { reason: 'plan-draft', buildPrRefs: refs });
      expect(r.warnings.join(' ')).not.toContain('names no PR reference');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Reading `field_values.build_pr` defensively — against the THREE REAL live shapes, verbatim.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('readBuildPrReferences tolerates every observed field_values shape', () => {
    const B740_SIBLING_KEYS = JSON.parse('{"build_pr":{"base":"main","branch":"feat/b740-stranded-tickets","pr_url":"https://github.com/ycomplex/harmony-web/pull/411","head_sha":"ddc78b89614fd8ffe840bb21bdd593612b82677c","opened_at":"2026-08-26T10:27:40Z","pr_number":411,"author_login":"app/harmony-daemon","author_is_bot":true},"build_pr_plugin":{"base":"main","branch":"feat/b740-stranded-tickets","pr_url":"https://github.com/ycomplex/harmony-plugin/pull/184","head_sha":"ddcd3b666ac7a9b542db1a932e1d92d64ba21e26","opened_at":"2026-08-26T10:27:50Z","pr_number":184,"author_login":"app/harmony-daemon","author_is_bot":true}}');

    const B743_NESTED = JSON.parse('{"build_pr":{"base":"main","branch":"feat/b743-run-options","pr_url":"https://github.com/ycomplex/harmony-plugin/pull/185","web_pr":{"pr_url":"https://github.com/ycomplex/harmony-web/pull/413","head_sha":"ae91f7db515f0f942be60c0716e547dfe5c7abb8","pr_number":413,"author_login":"app/harmony-daemon","author_is_bot":true},"head_sha":"04090fd80428393f76bfc67dea20442142ab2c88","opened_at":"2026-08-26T10:50:00Z","plugin_pr":{"pr_url":"https://github.com/ycomplex/harmony-plugin/pull/185","head_sha":"04090fd80428393f76bfc67dea20442142ab2c88","pr_number":185,"author_login":"app/harmony-daemon","author_is_bot":true},"pr_number":185,"author_login":"app/harmony-daemon","author_is_bot":true}}');

    const B844_WORK_BRANCH = JSON.parse('{"build_pr":{"base":"main","branch":"fix/daemon-error-format-v2","pr_url":"https://github.com/ycomplex/harmony-plugin/pull/183","head_sha":"c210423e8bf3560b079bcfae6fc0cfe888e2ccdb","opened_at":"2026-08-26T08:25:00Z","pr_number":183,"author_login":"app/harmony-daemon","author_is_bot":true},"work_branch":{"branch":"fix/daemon-error-format-v2","started_at":"2026-08-26T08:20:00Z"}}');

    it('B-740 SIBLING KEYS — names both PRs, the primary first', () => {
      const refs = readBuildPrReferences(B740_SIBLING_KEYS);
      expect(refs.map((r) => [r.key, r.pr_number])).toEqual([
        ['build_pr', 411],
        ['build_pr_plugin', 184],
      ]);
      expect(refs[0].author_is_bot).toBe(true);
      expect(refs[0].pr_url).toBe('https://github.com/ycomplex/harmony-web/pull/411');
    });

    it('B-743 NESTED — names the parent and the distinct nested web PR, deduping the repeated plugin PR', () => {
      const refs = readBuildPrReferences(B743_NESTED);
      expect(refs.map((r) => [r.key, r.pr_number])).toEqual([
        ['build_pr', 185],
        ['build_pr.web_pr', 413],
      ]);
    });

    it('B-844 work_branch — reads the one PR and does NOT invent one out of a branch record', () => {
      const refs = readBuildPrReferences(B844_WORK_BRANCH);
      expect(refs.map((r) => [r.key, r.pr_number])).toEqual([['build_pr', 183]]);
    });

    it('never throws, whatever it is handed', () => {
      for (const junk of [null, undefined, 'a string', 42, [], [1, 2], {}, { build_pr: 'nope' }, { build_pr: null }, { build_pr: [] }]) {
        expect(() => readBuildPrReferences(junk)).not.toThrow();
        expect(readBuildPrReferences(junk)).toEqual([]);
      }
    });

    it('readBuildPr yields the PRIMARY record for the B-732 approval rule, on all three shapes', () => {
      expect(readBuildPr(B740_SIBLING_KEYS)?.author_is_bot).toBe(true);
      expect(readBuildPr(B743_NESTED)?.pr_number).toBe(185);
      expect(readBuildPr(B844_WORK_BRANCH)?.pr_url).toBe('https://github.com/ycomplex/harmony-plugin/pull/183');
      expect(readBuildPr({ build_pr: 'nope' })).toBeUndefined();
      expect(readBuildPr(null)).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // compose is AUTHORITATIVE for a release frame's risk_classes.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  describe('composeBrief computes frame.risk_classes from changed_paths', () => {
    const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'release-decision-pending', content: 'r', status: 'active', iteration: 1 };
    const releaseDoc = (risk: string[]) => ({
      decide: 'Release — merge the PR?',
      recommend: { text: 'Ship.', confidence: 'high' },
      items: [{ kind: 'decision', text: 'Ship it', recommendation: 'release' }],
      frame: { ...(releaseFrame() as Record<string, unknown>), risk_classes: risk },
    });
    // responses: [field_values read] -> [no active brief] -> [insert] -> [task update]
    const client4 = () => makeClient([{ data: { field_values: {} } }, { data: null }, { data: briefRow }, { data: null }]);

    const insertedFrame = (client: any) =>
      (client.insert.mock.calls[0][0] as { doc: { frame: { risk_classes: string[] } } }).doc.frame;

    it('derives the classes from the DIFF, overwriting whatever the skill authored', async () => {
      const client = client4();
      await composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'release-decision-pending', pending_activity: null as any,
        doc: releaseDoc(['irreversible-destructive']) as any,
        changed_paths: ['web/supabase/migrations/20260831_add_column.sql'],
      });
      expect(insertedFrame(client).risk_classes).toEqual(['data-migration']);
    });

    it('NO DIFF ⇒ an empty list — never a prose guess', async () => {
      const client = client4();
      await composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'release-decision-pending', pending_activity: null as any,
        doc: releaseDoc(['auth', 'data-migration']) as any,
      });
      expect(insertedFrame(client).risk_classes).toEqual([]);
    });

    it('a clean diff that touches no risk surface yields an empty list', async () => {
      const client = client4();
      await composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'release-decision-pending', pending_activity: null as any,
        doc: releaseDoc([]) as any,
        changed_paths: ['plugin/skills/finish-work/SKILL.md'],
      });
      expect(insertedFrame(client).risk_classes).toEqual([]);
    });

    it('does not mutate the caller’s doc', async () => {
      const client = client4();
      const doc = releaseDoc(['auth']);
      await composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'release-decision-pending', pending_activity: null as any,
        doc: doc as any, changed_paths: ['web/src/pages/Board.tsx'],
      });
      expect((doc.frame as { risk_classes: string[] }).risk_classes).toEqual(['auth']);
      expect(insertedFrame(client).risk_classes).toEqual([]);
    });

    it('leaves a NON-release frame alone — the field only exists on the release variant', async () => {
      // responses: [no active brief] -> [insert] -> [task update]
      const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
      await composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'plan-draft', pending_activity: null as any,
        doc: { ...okDoc, frame: planFrame() } as any,
        changed_paths: ['web/supabase/migrations/x.sql'],
      });
      const inserted = (client.insert.mock.calls[0][0] as { doc: { frame: Record<string, unknown> } }).doc.frame;
      expect(inserted.kind).toBe('plan');
      expect(inserted.risk_classes).toBeUndefined();
    });

    it('advertises changed_paths, frame and revision on the tool schema', () => {
      const props = composeBriefTool.inputSchema.properties as Record<string, unknown>;
      expect(props.changed_paths).toBeDefined();
      const docProps = (props.doc as { properties: Record<string, unknown> }).properties;
      expect(docProps.frame).toBeDefined();
      expect(docProps.revision).toBeDefined();
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// B-896 — reshape_brief: the terminal RESHAPE verb (send an active brief back for rework).
//
// A SIBLING of resolve_brief that composes two already-granted RPCs. The whole point of the tool is
// that an agent-authored reshape is DISTINGUISHABLE from a human's, so the provenance-bearing audit
// row is written FIRST and the marker SECOND — every test below that touches the write path pins
// that order, because the reverse would produce a marker with no provenance.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('reshapeBrief (B-896)', () => {
  const LOG = 'log_brief_decision_event';
  const SUBMIT = 'submit_brief_command';

  function makeReshapeClient(opts: {
    active?: { id: string; reason: string } | null;
    latest?: { id: string; status: string; resolved_command?: string | null } | null;
    failOn?: string;
    failMessage?: string;
  } = {}) {
    const active = opts.active === undefined ? { id: 'brief-1', reason: 'plan-draft' } : opts.active;
    const chain: any = { rpcCalls: [] as Array<{ name: string; params: any }> };
    for (const m of ['from', 'eq', 'order', 'limit', 'is', 'not']) chain[m] = vi.fn(() => chain);
    // The two reads are told apart by their projections: the active lookup asks for 'id, reason';
    // the never-composed-vs-already-resolved lookup asks for 'id, status, resolved_command'.
    let readMode: 'active' | 'latest' = 'active';
    chain.select = vi.fn((cols: string) => { readMode = cols.includes('status') ? 'latest' : 'active'; return chain; });
    chain.maybeSingle = vi.fn(async () =>
      readMode === 'active' ? { data: active, error: null } : { data: opts.latest ?? null, error: null });
    chain.rpc = vi.fn(async (name: string, params: any) => {
      chain.rpcCalls.push({ name, params });
      if (opts.failOn === name) return { data: null, error: { message: opts.failMessage ?? 'boom' } };
      if (name === LOG) return { data: null, error: null }; // returns void
      return { data: { brief_id: params._brief_id, task_id: 'task-1', command: params._command }, error: null };
    });
    return chain;
  }

  const reshape = (client: any, over: Record<string, unknown> = {}) =>
    reshapeBrief(client, PROJECT_ID, {
      task_id: 'task-1', feedback: 'the release brief omits the migration ordering', provenance: 'human-in-session',
      ...over,
    } as any);

  // ——— the ordering safety property ————————————————————————————————————————————————————————————
  it('writes PROVENANCE FIRST, MARKER SECOND — the crash between them must orphan an audit row, never orphan a marker', async () => {
    const client = makeReshapeClient({ active: { id: 'brief-7', reason: 'release-decision-pending' } });
    await reshape(client, { provenance: 'agent-synthesized:unattended' });
    expect(client.rpcCalls.map((c: any) => c.name)).toEqual([LOG, SUBMIT]);
    expect(client.rpcCalls[0].params).toEqual({
      p_task_id: 'task-1',
      p_brief_id: 'brief-7',
      p_command: 'iterate',
      // The brief's OWN reason — what the reshape was decided AT.
      p_reason: 'release-decision-pending',
      p_provenance: 'agent-synthesized:unattended',
      p_detail: 'the release brief omits the migration ordering',
    });
    expect(client.rpcCalls[1].params).toEqual({
      _brief_id: 'brief-7', _command: 'iterate', _detail: 'the release brief omits the migration ordering',
    });
  });

  it('returns an ack naming the brief, the gate it was reshaped at, and the recorded provenance', async () => {
    const client = makeReshapeClient();
    const result: any = await reshape(client);
    expect(result).toMatchObject({
      brief_id: 'brief-1', task_id: 'task-1', command: 'iterate',
      reason: 'plan-draft', provenance: 'human-in-session',
    });
    // B-683: the ack confirms SERVER state — the caller's own feedback text is not echoed back.
    expect(result).not.toHaveProperty('feedback');
  });

  it('trims the feedback it forwards (surrounding whitespace is not content)', async () => {
    const client = makeReshapeClient();
    await reshape(client, { feedback: '  redo the risk table\n' });
    expect(client.rpcCalls[0].params.p_detail).toBe('redo the risk table');
    expect(client.rpcCalls[1].params._detail).toBe('redo the risk table');
  });

  // ——— feedback is REQUIRED ———————————————————————————————————————————————————————————————————
  it.each([[''], ['   '], ['\n\t '], [undefined as any], [null as any]])(
    'REFUSES blank/absent feedback (%j) and writes NOTHING — neither RPC fires',
    async (feedback) => {
      const client = makeReshapeClient();
      await expect(reshape(client, { feedback })).rejects.toThrow(/feedback is required/i);
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it('says nothing was written when it refuses blank feedback', async () => {
    const client = makeReshapeClient();
    await expect(reshape(client, { feedback: '   ' })).rejects.toThrow(/nothing was written/i);
  });

  // ——— NO FLOOR VETO (acceptance criterion) ————————————————————————————————————————————————————
  // floor-veto.ts is scoped to pre-ACCEPTING a hard-floor gate. Declining is the opposite act, and
  // the motivating incident was three RELEASE briefs that needed rework — so these must succeed.
  it.each([
    ['release-decision-pending', 'the release hard floor'],
    ['verification-ack-pending', 'the verify hard floor'],
    ['stale-patch-review', 'a stale-patch review'],
  ])('reshapes a %s brief (%s) — there is NO floor veto on sending work back', async (reason) => {
    const client = makeReshapeClient({ active: { id: 'brief-9', reason } });
    await expect(reshape(client)).resolves.toBeDefined();
    expect(client.rpcCalls.map((c: any) => c.name)).toEqual([LOG, SUBMIT]);
    expect(client.rpcCalls[0].params.p_reason).toBe(reason);
  });

  it('does not import the accept-side floor veto at all', () => {
    const source = readFileSync(fileURLToPath(new URL('./briefs.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain("from './floor-veto.js'");
  });

  // ——— no active brief: refuse, write nothing, distinguish the two cases ————————————————————————
  it('REFUSES when no brief has ever been composed — naming that case, writing nothing', async () => {
    const client = makeReshapeClient({ active: null, latest: null });
    await expect(reshape(client)).rejects.toThrow(/no brief has ever been composed/i);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('REFUSES when the brief is already resolved — naming THAT case instead, writing nothing', async () => {
    const client = makeReshapeClient({
      active: null,
      latest: { id: 'brief-3', status: 'accepted', resolved_command: 'accept' },
    });
    await expect(reshape(client)).rejects.toThrow(/already resolved/i);
    await expect(reshape(client)).rejects.toThrow(/brief-3 is 'accepted' \(resolved via 'accept'\)/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('the two refusals are DISTINGUISHABLE — neither message could be mistaken for the other', async () => {
    const never = makeReshapeClient({ active: null, latest: null });
    const done = makeReshapeClient({ active: null, latest: { id: 'brief-3', status: 'deferred', resolved_command: 'defer' } });
    const neverMsg = await reshape(never).catch((e: Error) => e.message);
    const doneMsg = await reshape(done).catch((e: Error) => e.message);
    expect(neverMsg).not.toBe(doneMsg);
    expect(neverMsg).not.toMatch(/already resolved/i);
    expect(doneMsg).not.toMatch(/never been composed/i);
    for (const msg of [neverMsg, doneMsg]) expect(msg).toMatch(/nothing was written/i);
  });

  // ——— provenance fails closed (the same validator resolve_brief uses) ——————————————————————————
  it("REJECTS 'human-in-browser' — the plugin is never the browser, and a forged reshape is the exact harm", async () => {
    const client = makeReshapeClient();
    await expect(reshape(client, { provenance: PROVENANCE_WEB_ONLY }))
      .rejects.toThrow(/'human-in-browser' is the web client's alone/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([[undefined as any], [''], ['agent-synthesised'], ['human'], ['agent-synthesized:']])(
    'FAILS CLOSED on provenance %j — nothing is written',
    async (provenance) => {
      const client = makeReshapeClient();
      await expect(reshape(client, { provenance })).rejects.toThrow();
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([['human-in-session'], ['agent-synthesized'], ['agent-synthesized:unattended']])(
    'threads accepted provenance %s to the audit row verbatim',
    async (provenance) => {
      const client = makeReshapeClient();
      await reshape(client, { provenance });
      expect(client.rpcCalls[0].params.p_provenance).toBe(provenance);
    },
  );

  // ——— schema drift degrades clearly (B-383 class) ——————————————————————————————————————————————
  it('DRIFT on the audit RPC: fails clearly and NEVER attempts the marker (no marker without provenance)', async () => {
    const client = makeReshapeClient({
      failOn: LOG,
      failMessage: 'Could not find the function public.log_brief_decision_event(p_task_id, p_brief_id, p_command, p_reason, p_provenance, p_detail) in the schema cache',
    });
    await expect(reshape(client)).rejects.toThrow(/reshape is unavailable on this database/i);
    await expect(reshape(client)).rejects.toThrow(/log_brief_decision_event/);
    // The load-bearing half: the marker RPC was never reached.
    expect(client.rpcCalls.map((c: any) => c.name)).toEqual([LOG, LOG]);
  });

  it('DRIFT on the handoff RPC: fails clearly, says the reshape did NOT land, and names the harmless orphan', async () => {
    const client = makeReshapeClient({
      failOn: SUBMIT,
      failMessage: 'Could not find the function public.submit_brief_command(_brief_id, _command, _detail) in the schema cache',
    });
    await expect(reshape(client)).rejects.toThrow(/reshape is unavailable on this database/i);
    await expect(reshape(client)).rejects.toThrow(/did NOT land/);
    await expect(reshape(client)).rejects.toThrow(/orphan/i);
  });

  it('a NON-drift RPC error stays loud on either call (never swallowed by the drift guard)', async () => {
    for (const failOn of [LOG, SUBMIT]) {
      const client = makeReshapeClient({ failOn, failMessage: 'permission denied for table briefs' });
      await expect(reshape(client)).rejects.toThrow(/permission denied/);
    }
  });

  it('a lookup error is not swallowed either', async () => {
    const client = makeReshapeClient();
    client.maybeSingle = vi.fn(async () => ({ data: null, error: { message: 'permission denied for table briefs' } }));
    await expect(reshape(client)).rejects.toThrow(/permission denied/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  // ——— the tool surface ————————————————————————————————————————————————————————————————————————
  it('advertises feedback and provenance as REQUIRED, under its own name', () => {
    expect(reshapeBriefTool.name).toBe('reshape_brief');
    expect(reshapeBriefTool.inputSchema.required).toEqual(['task_id', 'feedback', 'provenance']);
    expect(reshapeBriefTool.description).toMatch(/RELEASE or VERIFY brief CAN be reshaped/);
  });

  it("resolve_brief's description now points iterate at this tool, not at compose_brief", () => {
    expect(resolveBriefTool.description).toContain('reshape_brief');
    expect(resolveBriefTool.description).not.toMatch(/edit\/iterate are skill-side LLM work via compose_brief/);
  });

  // ——— the round trip: what we WRITE is what the consumer READS (B-896 ← B-843) ——————————————————
  // The write payload is pinned above. This pins the OTHER half: the keys `submit_brief_command`
  // derives from those params are exactly the keys the consume side reads. The RPC builds the marker
  // server-side as jsonb_build_object('command', _command, 'detail', _detail), so `_command`/`_detail`
  // surface as `command`/`detail` — the shape harmony-conduct §4c case 2 switches on, and the shape
  // B-843's compose_brief_revision path then consumes by starting its successor row at the NULL
  // default. Without this pin, a rename on either side would pass every other test in this file.
  it('writes a marker whose consumed shape is exactly what fetchPendingResolution reads (round trip)', async () => {
    const client = makeReshapeClient({ active: { id: 'brief-9', reason: 'release-decision-pending' } });
    await reshape(client, { feedback: 'rebase onto main first' });
    const sent = client.rpcCalls.find((c: any) => c.name === SUBMIT).params;

    // What the DB stores, derived from those params exactly as the RPC's jsonb_build_object does.
    const stored = { command: sent._command, detail: sent._detail };

    const reader: any = {};
    for (const m of ['from', 'eq', 'order', 'limit']) reader[m] = vi.fn(() => reader);
    reader.select = vi.fn(() => reader);
    reader.maybeSingle = vi.fn(async () => ({ data: { pending_resolution: stored }, error: null }));

    expect(await fetchPendingResolution(reader, 'task-1')).toEqual({
      command: 'iterate',
      detail: 'rebase onto main first',
    });
  });

});

// B-896 — §2b's self-heal keys on a `brief_resolved` entry to recover the clarification brief's id.
// This ticket puts a SECOND command value ('iterate') into that same event type with the same reason,
// so the predicate must discriminate on command. Prose cannot be type-checked; this pins it.
describe('harmony-design-decide §2b self-heal predicate filters on command (B-896)', () => {
  const prose = readFileSync(skillPath('harmony-design-decide'), 'utf8');

  it("requires metadata.command === 'accept' alongside the reason", () => {
    expect(prose).toContain("e.metadata?.command === 'accept'");
  });

  it('still keys on the clarification reason (the command filter is an addition, not a replacement)', () => {
    expect(prose).toContain("e.metadata?.reason === 'clarification-draft'");
  });
});
