import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBuildEvidenceStatus, CRITERIA_FLOOR_CONTRACT } from './evidence-status.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('task-uuid'),
}));

/**
 * B-747 — the acceptance-criteria floor's CONTRACT TEST.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM evidence-status.test.ts. That suite proves this tool behaves
 * correctly given a mocked RPC. It cannot prove the thing the floor actually depends on: that the plugin
 * and the SUBSTRATE GUARD are reading the same definition. The floor is enforced twice — once by
 * `tasks_workflow_guard` calling `task_criteria_floor_status`, once by this tool reading it — and "one
 * definition" is a claim about the pair, not about either half.
 *
 * The pair is pinned from both ends:
 *   - HERE: every field of CRITERIA_FLOOR_CONTRACT is asserted, and the case table below is asserted
 *     against the tool's own behaviour. A rename on the SQL side makes the tool THROW (asserted below)
 *     rather than degrade to its local fallback, so a divergence surfaces the first time it happens
 *     instead of quietly turning the floor off.
 *   - IN harmony-web: `supabase/tests/b747_criteria_floor.test.sql` asserts the SAME case table against
 *     the deployed function, run by `npm run test:db:b747-criteria-floor`.
 *
 * HONEST RESIDUAL: the two case tables live in separate repositories and are kept in step by whoever
 * edits either side — that linkage is human, not mechanical. What IS mechanical is the shape check: the
 * plugin cannot silently stop consulting the authority. Closing the remaining gap would mean a
 * live-database test in this repo, which needs credentials CI does not have (see B-748).
 */

const PROJECT_ID = 'proj-1';

/**
 * THE CASE TABLE — the narrow subset the two implementations must agree on.
 * Mirrored in harmony-web supabase/tests/b747_criteria_floor.test.sql. Keep the two in step.
 */
const CONTRACT_CASES = [
  { name: 'no criteria, not exempt', criteria: [], expectPresence: false },
  { name: 'one UNCHECKED criterion', criteria: [{ id: 'a1', checked: false }], expectPresence: true },
  { name: 'one CHECKED criterion', criteria: [{ id: 'a1', checked: true }], expectPresence: true },
  {
    name: 'several criteria, none checked',
    criteria: [{ id: 'a1', checked: false }, { id: 'a2', checked: false }],
    expectPresence: true,
  },
] as const;

/** A client whose RPC answers exactly what the deployed function would for the given rows. */
function clientFor(criteria: readonly { id: string; checked: boolean }[], rpcOverride?: unknown) {
  return {
    rpc: vi.fn(() =>
      Promise.resolve(
        rpcOverride !== undefined
          ? (rpcOverride as { data: unknown; error: unknown })
          : {
              data: [
                {
                  [CRITERIA_FLOOR_CONTRACT.presenceColumn]: criteria.length >= 1,
                  [CRITERIA_FLOOR_CONTRACT.exemptColumn]: false,
                  [CRITERIA_FLOOR_CONTRACT.exemptReasonColumn]: null,
                },
              ],
              error: null,
            },
      ),
    ),
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((col: string) => {
        if (table === 'acceptance_criteria') return Promise.resolve({ data: [...criteria], error: null });
        if (table === 'tasks' && col === 'id') return Promise.resolve({ data: [{ field_values: {} }], error: null });
        return Promise.resolve({ data: [], error: null });
      }),
    })),
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('acceptance-criteria floor contract (B-747)', () => {
  describe('the dependency on the SQL authority is PINNED, not implied', () => {
    it('names the function and argument the substrate guard also uses', () => {
      // If these drift from harmony-web's migration the floor silently splits in two.
      expect(CRITERIA_FLOOR_CONTRACT.rpc).toBe('task_criteria_floor_status');
      expect(CRITERIA_FLOOR_CONTRACT.arg).toBe('p_task_id');
    });

    it('names the three columns the function returns', () => {
      expect(CRITERIA_FLOOR_CONTRACT.presenceColumn).toBe('has_criteria');
      expect(CRITERIA_FLOOR_CONTRACT.exemptColumn).toBe('is_exempt');
      expect(CRITERIA_FLOOR_CONTRACT.exemptReasonColumn).toBe('exempt_reason');
    });

    it('pins PRESENCE semantics — unchecked criteria count (never B-560s all-checked predicate)', () => {
      expect(CRITERIA_FLOOR_CONTRACT.presenceCountsUncheckedCriteria).toBe(true);
    });

    it('pins the exemption precedence: umbrella beats decision-only', () => {
      expect(CRITERIA_FLOOR_CONTRACT.exemptPrecedence).toEqual(['umbrella', 'decision-only']);
    });

    it('pins 42883 as the ONLY degradable SQLSTATE', () => {
      expect(CRITERIA_FLOOR_CONTRACT.degradableSqlState).toBe('42883');
    });

    it('actually CALLS the contract-named function with the contract-named argument', () => {
      // Pins the wiring, not just the constant: a hand-edited literal in the call site would pass the
      // assertions above while calling something else entirely.
      const client = clientFor([{ id: 'a1', checked: false }]);
      return getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' }).then(() => {
        expect(client.rpc).toHaveBeenCalledWith('task_criteria_floor_status', { p_task_id: 'task-uuid' });
      });
    });
  });

  describe('the case table both implementations must agree on', () => {
    for (const c of CONTRACT_CASES) {
      it(`${c.name} ⇒ has_acceptance_criteria = ${c.expectPresence}`, async () => {
        const res = await getBuildEvidenceStatus(clientFor(c.criteria), PROJECT_ID, { task_id: 'B-1' });
        expect(res.has_acceptance_criteria).toBe(c.expectPresence);
      });
    }

    it('presence and all-checked genuinely diverge on the unchecked case', () => {
      // The single most important row in the table. If these two ever coincide, someone has keyed the
      // floor on the wrong predicate and every in-progress build will be refused.
      return getBuildEvidenceStatus(
        clientFor([{ id: 'a1', checked: false }]),
        PROJECT_ID,
        { task_id: 'B-1' },
      ).then((res) => {
        expect(res.has_acceptance_criteria).toBe(true);
        expect(res.all_acs_checked).toBe(false);
      });
    });
  });

  describe('a DIVERGENCE is loud, not silent', () => {
    it('THROWS when the row omits the presence column — never degrades to the local read', async () => {
      // The failure this guards: rename has_criteria on the SQL side and the plugin would keep returning
      // a plausible local answer while no longer consulting the authority at all. The floor would still
      // "work" in every test and no longer be one definition.
      const client = clientFor([{ id: 'a1', checked: false }], {
        data: [{ renamed_presence: true, is_exempt: false, exempt_reason: null }],
        error: null,
      });
      await expect(getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' })).rejects.toThrow(
        /DIVERGED/,
      );
    });

    it('THROWS when the presence column is present but not a boolean', async () => {
      const client = clientFor([], { data: [{ has_criteria: 'yes' }], error: null });
      await expect(getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' })).rejects.toThrow(
        /without a boolean/,
      );
    });

    it('names both sides in the error so the reconciliation target is obvious', async () => {
      const client = clientFor([], { data: [{ nope: 1 }], error: null });
      await expect(getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' })).rejects.toThrow(
        /b747_acceptance_criteria_floor\.sql/,
      );
    });

    it('still degrades on an EMPTY result set — the function judged nothing, so invent nothing', async () => {
      // Distinct from a shape violation: no row is not a divergence, it is an absence of an answer.
      const client = clientFor([{ id: 'a1', checked: true }], { data: [], error: null });
      const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
      expect(res.has_acceptance_criteria).toBe(true); // the local read
    });

    it('still degrades on 42883 only — the pre-migration window the daemon hits by default', async () => {
      const client = clientFor([{ id: 'a1', checked: true }], {
        data: null,
        error: { message: 'function does not exist', code: CRITERIA_FLOOR_CONTRACT.degradableSqlState },
      });
      const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
      expect(res.has_acceptance_criteria).toBe(true);
    });
  });
});
