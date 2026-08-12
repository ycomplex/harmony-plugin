import { describe, it, expect, vi } from 'vitest';
import { DECISION_ONLY_LABEL_CONTRACT, applyAcceptanceEventPayload, type AcceptanceEventPayloadItem, type PendingAcceptanceEvent } from './acceptance-events.js';

/**
 * B-688 — the decision-only stamping guard's CONTRACT TEST.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM acceptance-events.test.ts. That suite proves the `label_add`
 * dispatch behaves correctly given a mocked RPC. It cannot prove the plugin is naming the SAME function/
 * args/columns harmony-web's substrate actually exposes — `DECISION_ONLY_LABEL_CONTRACT` is that pin, and
 * this file asserts every field of it, plus that the dispatch site actually calls the RPC with the
 * contract-named args (so a hand-edited literal in the call site can't drift from the constant while
 * still passing the naming assertions).
 *
 * UNLIKE `criteria-floor-contract.test.ts` — which also exercises a LIVE wrapper-with-fallback function
 * (`getBuildEvidenceStatus`) that reads `can_mark_decision_only`'s B-747 counterpart directly and THROWS
 * on a shape divergence — this feature has no such wrapper: `can_mark_decision_only` is consumed entirely
 * server-side, inside `consume_label_add_write`, before its ledger insert. So this test is scoped to
 * PINNING THE SHAPE (naming assertions + the dispatch-calls-the-RPC-with-these-args assertion), not the
 * full DIVERGED-throw machinery — there is nothing here to validate a live row's shape against.
 *
 * The counterpart lives in harmony-web: `supabase/tests/b688_decision_only_guard.test.sql` exercises both
 * `can_mark_decision_only` and `consume_label_add_write` directly against a live DB (self-isolating, one
 * transaction, rolled back). The two are kept in step by hand — same honest residual as the B-747 pairing
 * (`criteria-floor-contract.test.ts`'s header comment explains why: the repos are separate, so the linkage
 * is human, not mechanical; what IS mechanical is that a hand-edit here fails a named assertion instead of
 * silently drifting).
 */

describe('decision-only label contract (B-688)', () => {
  describe('the dependency on the SQL authority is PINNED, not implied', () => {
    it('names can_mark_decision_only and its argument', () => {
      expect(DECISION_ONLY_LABEL_CONTRACT.guard.rpc).toBe('can_mark_decision_only');
      expect(DECISION_ONLY_LABEL_CONTRACT.guard.arg).toBe('_task_id');
    });

    it('names the two columns can_mark_decision_only returns', () => {
      expect(DECISION_ONLY_LABEL_CONTRACT.guard.allowedColumn).toBe('allowed');
      expect(DECISION_ONLY_LABEL_CONTRACT.guard.blockReasonColumn).toBe('block_reason');
    });

    it('pins the two block_reason values, in the order terminal is checked before build-shape', () => {
      expect(DECISION_ONLY_LABEL_CONTRACT.guard.blockReasons).toEqual(['terminal', 'build-shape']);
    });

    it('names consume_label_add_write and its three arguments', () => {
      expect(DECISION_ONLY_LABEL_CONTRACT.write.rpc).toBe('consume_label_add_write');
      expect(DECISION_ONLY_LABEL_CONTRACT.write.eventIdArg).toBe('_event_id');
      expect(DECISION_ONLY_LABEL_CONTRACT.write.externalRefArg).toBe('_external_ref');
      expect(DECISION_ONLY_LABEL_CONTRACT.write.labelNameArg).toBe('_label_name');
    });
  });

  describe('the label_add dispatch actually calls the RPC with these exact args', () => {
    it('calls consume_label_add_write with the contract-named argument keys', async () => {
      const rpc = vi.fn(async () => ({ data: { applied: true, result_id: 'label-1' }, error: null }));
      const client = { rpc } as any;
      const item: AcceptanceEventPayloadItem = { write_kind: 'label_add', ref: 'label-decision-only', label_name: 'decision-only' };
      const event: PendingAcceptanceEvent = {
        id: 'event-1', task_id: 'task-1', brief_id: 'brief-1', reason: 'clarification-draft',
        payload: { items: [item] }, pending_activity: 'clarifying', status: 'pending',
      };
      await applyAcceptanceEventPayload(client, event);

      expect(rpc).toHaveBeenCalledWith(
        DECISION_ONLY_LABEL_CONTRACT.write.rpc,
        expect.objectContaining({
          [DECISION_ONLY_LABEL_CONTRACT.write.eventIdArg]: 'event-1',
          [DECISION_ONLY_LABEL_CONTRACT.write.externalRefArg]: 'label-decision-only',
          [DECISION_ONLY_LABEL_CONTRACT.write.labelNameArg]: 'decision-only',
        }),
      );
    });
  });
});
