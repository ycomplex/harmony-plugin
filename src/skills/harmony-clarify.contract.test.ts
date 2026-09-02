import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';
import { CLARIFY_OWNED_TRIGGERS } from '../tools/elicitation.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-clarify skill contract', () => {
  const skill = readSkill('harmony-clarify');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-clarify');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('runs the full gate loop', () => {
    const tools = referencedHarmonyTools(skill.body);
    for (const t of ['query_knowledge', 'record_decision', 'reference_knowledge', 'compose_brief', 'resolve_brief']) {
      expect(tools, `missing ${t}`).toContain(t);
    }
  });
  it('encodes the knowledge-query + research-first discipline', () => {
    expect(skill.body).toContain('query_knowledge');
    expect(skill.body.toLowerCase()).toMatch(/load-bearing|research-first|surface the gap/);
  });
  it('composes the clarification with the correct reason + activity', () => {
    expect(skill.body).toContain('clarification-draft');
    expect(skill.body).toContain('clarifying');
  });
  it('authors deferral knowledge on the defer path (F4 — deferral-as-knowledge)', () => {
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (B-352)
  });
  it('carries the discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
  it('AC-filing idempotency is a per-clarification-brief filing-pass record, not a ticket-wide AC-presence check (B-744)', () => {
    expect(skill.body).toContain('AC-FILING-PASS');
    expect(skill.body).toContain('filing-pass');
    expect(skill.body.toLowerCase()).toContain('this clarification brief\'s own id');
    // the old ticket-wide guard must be gone, not merely supplemented:
    expect(skill.body).not.toMatch(/skip the filing if the ticket already carries acceptance criteria/);
    // the marker predicate is never brief_resolved-keyed:
    expect(skill.body).toMatch(/never `brief_resolved`/);
    // zero-count passes are exactly as loud as N:
    expect(skill.body.toLowerCase()).toContain('a zero-count pass still writes');
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('list_comments');
    expect(tools).toContain('add_comment');
  });
  it('B-744 rework: the filing-pass key is the brief\'s own id, never the decision id (regression: verify-caught mismatch against B-756/B-691)', () => {
    // A prose-only match (e.g. "this clarification brief's id") is not enough — round 1 of this fix
    // said exactly that while plugging in `brief.decision_ref.id` (a DECISION id) underneath. Pin the
    // literal expression written into the marker, not just the surrounding prose.
    expect(skill.body).toMatch(/AC-FILING-PASS brief_id=\$\{brief\.id\}/);
    expect(skill.body).toMatch(/AC-FILING-PASS brief_id=<brief\.id> filed=<N>/);
    expect(skill.body).not.toMatch(/brief\.decision_ref\.id/);
  });
  it('every clarify-owned trigger is named in the resume allowlist sentence (B-796 — the code→prose arm)', () => {
    // The converse of shared.test.ts's prose→code check: every trigger DECLARED clarify-owned in
    // TRIGGER_OWNERS must be named in clarify's own resume allowlist, so registering a new clarify
    // trigger without widening the allowlist fails here instead of silently narrowing the resume branch.

    // A non-empty guard: an empty derived set would satisfy the loop vacuously.
    expect(
      CLARIFY_OWNED_TRIGGERS.length,
      'CLARIFY_OWNED_TRIGGERS is empty — an empty derived set would pass this test vacuously',
    ).toBeGreaterThan(0);

    // Scope the match to the ALLOWLIST SENTENCE, not the whole file. Several trigger names also occur
    // in this skill as ordinary English or as examples of triggers deliberately EXCLUDED from the
    // allowlist (`discuss`, `worker-question`), so a whole-file substring check would pass vacuously
    // for exactly the values most likely to be mis-declared. Use a bounded character window rather
    // than a period-terminated regex — the sentence contains a period inside
    // `src/tools/elicitation.ts`.
    const anchor = 'The clarify-owned set is';
    const idx = skill.body.indexOf(anchor);
    expect(
      idx,
      `harmony-clarify SKILL.md must carry a "${anchor} …" sentence naming the resume allowlist`,
    ).toBeGreaterThan(-1);
    const allowlistSentence = skill.body.slice(idx, idx + 200);

    for (const trigger of CLARIFY_OWNED_TRIGGERS) {
      expect(
        allowlistSentence,
        `trigger '${trigger}' is declared clarify-owned in TRIGGER_OWNERS (src/tools/elicitation.ts) but is not named in harmony-clarify's "${anchor} …" resume allowlist sentence`,
      ).toContain(`\`${trigger}\``);
    }
  });
});
