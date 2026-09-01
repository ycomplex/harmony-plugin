import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-research skill contract', () => {
  const skill = readSkill('harmony-research');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-research');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('ingests research as Asserted knowledge with research provenance', () => {
    const tools = referencedHarmonyTools(skill.body);
    // ingests as a decision or a fact:
    expect(tools.some((t) => t === 'record_decision' || t === 'assert_fact')).toBe(true);
    expect(tools).toContain('advance_workflow');
    expect(skill.body).toContain('research');           // source_type
    expect(skill.body).toContain('review_by');
    expect(skill.body).toContain('researching');        // the activity
  });
  it('is the human-relayed v1 hand-off (never auto-Accepted)', () => {
    expect(skill.body).toContain('Asserted');
    expect(skill.body.toLowerCase()).toMatch(/paste|relay|run these/);
  });
  it('carries the discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
  });

  // B-870 AC4: the human relay is no longer a bare terminal ask — the prompts ride a worker-question
  // elicitation round, and the answers come back through the round.
  it('the relay runs on the elicitation engine: a worker-question round CARRYING the commands to run', () => {
    const body = skill.body;
    expect(referencedHarmonyTools(body)).toContain('file_elicitation_round');
    expect(body).toContain("trigger: 'worker-question'");
    expect(body).toContain('elicitation-engine.md');
    expect(body).toMatch(/stakes: 'load-bearing'/);
    expect(body).toMatch(/kind: 'open'/);
    // The round carries the runnable prompts themselves.
    expect(body).toMatch(/CARRIES THE COMMANDS TO RUN/);
    expect(body).toMatch(/verbatim and\s*\n?copy-pasteable/);
  });

  it('the answers return THROUGH the round, and filing it is the clean pause', () => {
    const body = skill.body;
    expect(body).toMatch(/answers return THROUGH THE ROUND/i);
    expect(body).toMatch(/get_elicitation/);
    expect(body).toMatch(/awaiting_human_input/);
    expect(body).toMatch(/elicitation-round/);
  });

  it('names WHY a bare terminal ask is wrong — invisible on the board, unrenderable in a daemon worker', () => {
    const body = skill.body;
    expect(body).toMatch(/never on a bare terminal ask/i);
    expect(body).toMatch(/ends the turn with nothing on the board/);
    expect(body).toMatch(/daemon worker has no terminal/);
  });

  it('keeps the inline paste for the ONE case with no ticket to hang a round on', () => {
    expect(skill.body).toMatch(/Outside a ticket-driving session/);
    expect(skill.body).toMatch(/that is the only case/);
  });
});
