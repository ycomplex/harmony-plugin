// B-1037 — unit coverage for the fixture-export script's REFUSAL logic
// (evals/clarify-replay/scripts/fixture-export.mjs's checkTicketIsPreClarify). Per the plan-gate
// orchestrator remark carried into this build: "FX IS NO LONGER PRE-CLARIFY STATE ... the
// fixture-export script must REFUSE to export any ticket that carries a clarify gate slot, filed
// ACs or briefs". Tested at the pure-function level, against mocked ticket rows — no live board.

import { describe, it, expect } from 'vitest';
import {
  checkTicketIsPreClarify,
  READ_FIXTURE_KINDS,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs helper module, deliberately dependency-free and untyped
} from '../evals/clarify-replay/scripts/fixture-export.mjs';

describe('checkTicketIsPreClarify', () => {
  it('allows a clean pre-clarify ticket (no gate slot, no ACs, no brief)', () => {
    const row = { visual_id: 'FX-818', field_values: {}, acceptance_criteria: [], has_any_brief: false };
    expect(checkTicketIsPreClarify(row)).toBeNull();
  });

  it('allows a ticket whose gate_slots.clarify is an empty object', () => {
    const row = {
      visual_id: 'FX-818',
      field_values: { gate_slots: { clarify: {} } },
      acceptance_criteria: [],
      has_any_brief: false,
    };
    expect(checkTicketIsPreClarify(row)).toBeNull();
  });

  it('refuses (names the ticket) when field_values.gate_slots.clarify is populated', () => {
    const row = {
      visual_id: 'FX-818',
      field_values: { gate_slots: { clarify: { solving: 'x', in_scope: [], not_solving: [] } } },
      acceptance_criteria: [],
      has_any_brief: false,
    };
    const reason = checkTicketIsPreClarify(row);
    expect(reason).not.toBeNull();
    expect(reason).toContain('FX-818');
    expect(reason).toContain('gate_slots.clarify');
  });

  it('refuses (names the ticket) when acceptance_criteria is non-empty', () => {
    const row = { visual_id: 'FX-904', field_values: {}, acceptance_criteria: [{ id: 'ac1' }], has_any_brief: false };
    const reason = checkTicketIsPreClarify(row);
    expect(reason).toContain('FX-904');
    expect(reason).toContain('acceptance criteri');
  });

  it('refuses (names the ticket) when a brief already exists', () => {
    const row = { visual_id: 'FX-917', field_values: {}, acceptance_criteria: [], has_any_brief: true };
    const reason = checkTicketIsPreClarify(row);
    expect(reason).toContain('FX-917');
    expect(reason).toContain('brief');
  });

  it('refuses on the has_active_brief / brief-object shape too', () => {
    expect(checkTicketIsPreClarify({ visual_id: 'FX-1', field_values: {}, acceptance_criteria: [], has_active_brief: true })).toContain('FX-1');
    expect(checkTicketIsPreClarify({ visual_id: 'FX-2', field_values: {}, acceptance_criteria: [], brief: { id: 'b1' } })).toContain('FX-2');
  });
});

describe('READ_FIXTURE_KINDS', () => {
  it('names exactly the 9 observed read tools', () => {
    expect(READ_FIXTURE_KINDS).toEqual([
      'query_knowledge',
      'search_tasks',
      'list_comments',
      'query_entities',
      'get_task',
      'get_project',
      'find_related_tickets',
      'get_brief',
      'get_elicitation',
    ]);
  });
});
