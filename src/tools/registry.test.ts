import { describe, it, expect } from 'vitest';
import { registerTools } from './index.js';

describe('tool registry', () => {
  it('registers the P4 agent-contract tools', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('advance_workflow');
    expect(names).toContain('reference_knowledge');
    expect(names).toContain('list_ticket_knowledge');
  });

  it('registers the B-551 intent-only retrieval tool', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('search_ticket_intents');
  });

  it('registers the B-552 lexical ticket-search tool', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('search_tasks');
  });

  it('registers the B-560 build-evidence-status tool', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('get_build_evidence_status');
  });

  it('registers the B-503 accept-with-remark consume tool', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('consume_accept_remark');
  });

  it('registers the B-645 elicitation exchange tools', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('start_elicitation');
    expect(names).toContain('file_elicitation_round');
    expect(names).toContain('get_elicitation');
    expect(names).toContain('conclude_elicitation');
  });
});
