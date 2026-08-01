import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

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
});
