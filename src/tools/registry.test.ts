import { describe, it, expect } from 'vitest';
import { registerTools } from './index.js';

describe('tool registry', () => {
  it('registers the P4 agent-contract tools', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('advance_workflow');
    expect(names).toContain('reference_knowledge');
    expect(names).toContain('list_ticket_knowledge');
  });
});
