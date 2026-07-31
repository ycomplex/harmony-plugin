import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-design-decide skill contract', () => {
  const skill = readSkill('harmony-design-decide');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-design-decide');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('handles all three design sub-tracks + the last-track advance rule', () => {
    for (const t of ['product-design', 'technical-design', 'ux-ui-design']) {
      expect(skill.body).toContain(t);
    }
    expect(skill.body).toContain('design-decision-draft');
    // pending_activity='designing' only on the last required sub-track:
    expect(skill.body.toLowerCase()).toContain('last required sub-track');
  });
  it('reads sub-track completion ticket-scoped + states one-brief serialization (F3)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('list_ticket_knowledge');
    expect(skill.body.toLowerCase()).toContain('one active brief per task');
    expect(skill.body.toLowerCase()).toContain('serialized');
  });
  it('runs the gate loop with knowledge discipline', () => {
    const tools = referencedHarmonyTools(skill.body);
    for (const t of ['query_knowledge', 'record_decision', 'reference_knowledge', 'compose_brief', 'resolve_brief']) {
      expect(tools, `missing ${t}`).toContain(t);
    }
  });
  it('authors deferral knowledge on the defer path (reconciliation F4 — deferral-as-knowledge)', () => {
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (B-352)
  });
  it('carries the discovery role profile (no commit)', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
  it('routes the UX/UI sub-track to the visual hand-off generator (P6)', () => {
    expect(skill.body).toContain('harmony-visual-handoff');
    // the ux-ui experience decision is decided through a generated, manipulable surface — not prose-only.
    // N1: pin the actual phrase (was /generated.*surface|manipulable/ — "manipulable" alone kept this green):
    expect(skill.body.toLowerCase()).toMatch(/generated,?\s+manipulable\s+surface/);
  });
  it('the product-design self-heal keys AC-filing idempotency on the CLARIFICATION brief, via the same filing-pass-record predicate as clarify (B-744)', () => {
    expect(skill.body).toContain('AC-FILING-PASS');
    expect(skill.body).toContain('filing-pass');
    // the old EMPTY-set self-heal trigger must be gone, not merely supplemented:
    expect(skill.body).not.toMatch(/\*\*If EMPTY\*\*/);
    // scoped to CLARIFY's brief, never this sub-track's own product-design brief:
    expect(skill.body.toLowerCase()).toContain('clarification\'s brief_id');
    expect(skill.body).toMatch(/never .*`brief_resolved`/);
    expect(skill.body.toLowerCase()).toContain('a zero-count pass still writes');
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('list_comments');
    expect(tools).toContain('add_comment');
    expect(tools).toContain('list_ticket_knowledge');
  });

  it('runs the filing self-heal on EVERY sub-track, not only the product track (B-747)', () => {
    // B-744 fixed WHAT the self-heal checks; the reachability was the remaining defect. Scoping the
    // self-heal to the product track meant a browser-accepted product brief — or a ticket needing no
    // product track — never re-entered the step that owns the filing.
    expect(skill.body).toMatch(/EVERY sub-track/);
    // The refine/extend half legitimately stays product-track-only; the split must be explicit.
    expect(skill.body.toLowerCase()).toMatch(/refine and extend step that follows stays product-track/);
  });
});
