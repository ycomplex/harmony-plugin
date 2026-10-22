/** Real local PostgREST smoke; opt in with HARMONY_TEST_LOCAL_ACCOUNTS=1. Never targets hosted data. */
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import {
  readFeatureAccounts,
  createFeatureAccount,
  previewFeatureAmendment,
  proposeFeatureAmendment,
  applyFeatureAmendment,
} from './feature-accounts.js';
const key =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const admin = createClient('http://127.0.0.1:54321', key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const db = (sql: string) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_lhgljwwetammvsngmbic',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8' },
  );
const fixture = '00000000-0000-0000-0000-000000123590';
describe.skipIf(process.env.HARMONY_TEST_LOCAL_ACCOUNTS !== '1')(
  'B-1235 pending maintenance local smoke',
  () => {
    it('proposes traceable pending replacements and preserves neighbours', async () => {
      let account: { account_id: string; entry_id: string } | undefined;
      db(`INSERT INTO auth.users(id,email,aud,role) VALUES('${fixture}','local-b1235-smoke@test.local','authenticated','authenticated');
      INSERT INTO public.workspaces(id,name,created_by) VALUES('${fixture}','B1235 smoke','${fixture}');
      INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES('${fixture}','${fixture}','owner');
      INSERT INTO public.projects(id,workspace_id,name,key,created_by) VALUES('${fixture}','${fixture}','B1235 smoke','SM1235','${fixture}');
      INSERT INTO public.tasks(id,project_id,title,created_by) VALUES('${fixture}','${fixture}','Smoke source','${fixture}');
      INSERT INTO public.knowledge_decisions(id,workspace_id,project_id,title,content,type,status,created_by) VALUES('${fixture}','${fixture}','${fixture}','Smoke accepted decision','Intention','technical-design','Accepted','${fixture}');`);
      try {
        account = await createFeatureAccount(admin, fixture, {
          owner_surface: 'Shared handler smoke',
        });
        const ops = [
          {
            op: 'insert',
            clause_id: 'first',
            ordinal: 1,
            content: 'Only live after explicit production apply.',
          },
          {
            op: 'insert',
            clause_id: 'neighbour',
            ordinal: 2,
            content: 'Unchanged neighbouring behaviour.',
          },
        ];
        expect(
          await previewFeatureAmendment(admin, fixture, {
            account_id: account!.account_id,
            expected_revision: 0,
            operations: ops,
          }),
        ).toMatchObject({
          live: false,
          preview_text: ops.map((op) => op.content).join('\n\n'),
        });
        const proposal = {
          account_id: account!.account_id,
          expected_revision: 0,
          operations: ops,
          source_decision_id: fixture,
          source_task_id: fixture,
          idempotency_key: 'smoke',
          leaves_untouched: [{ owner_surface: 'other' }],
        };
        const amendment = await proposeFeatureAmendment(admin, fixture, proposal);
        expect(await proposeFeatureAmendment(admin, fixture, proposal)).toMatchObject({
          amendment_id: amendment.amendment_id,
        });
        // The filtered RPC signature can still be absent while PostgREST reloads.
        await expect
          .poll(
            async () =>
              (
                await readFeatureAccounts(admin, fixture, {
                  account_id: account!.account_id,
                })
              ).availability,
          )
          .toBe('available');
        expect(
          (
            await readFeatureAccounts(admin, fixture, {
              account_id: account!.account_id,
            })
          ).accounts[0],
        ).toMatchObject({
          current_text: '',
          current_revision: 0,
          pending_amendments: [{ amendment_id: amendment.amendment_id }],
        });
        const proposedEvents = await admin
          .from('knowledge_events')
          .select('metadata')
          .contains('metadata', {
            kind: 'amendment-proposed',
            amendment_id: amendment.amendment_id,
          });
        expect(proposedEvents.error).toBeNull();
        expect(proposedEvents.data).toHaveLength(1);
        expect(proposedEvents.data?.[0].metadata).toMatchObject({
          source_task_id: fixture,
          source_decision_id: fixture,
        });
        await applyFeatureAmendment(admin, fixture, {
          amendment_id: amendment.amendment_id,
          confirm_production: true,
        });
        await applyFeatureAmendment(admin, fixture, {
          amendment_id: amendment.amendment_id,
          confirm_production: true,
        });
        expect(
          (
            await readFeatureAccounts(admin, fixture, {
              account_id: account!.account_id,
            })
          ).accounts[0],
        ).toMatchObject({
          current_text: ops.map((op) => op.content).join('\n\n'),
          current_revision: 1,
          pending_amendments: [],
        });
        const concurrentBase = {
          account_id: account!.account_id,
          expected_revision: 1,
          source_decision_id: fixture,
          source_task_id: fixture,
          leaves_untouched: [{ clause_id: 'neighbour' }],
        };
        const [left] = await Promise.all(
          ['left', 'right'].map((side) =>
            proposeFeatureAmendment(admin, fixture, {
              ...concurrentBase,
              idempotency_key: side,
              operations: [{ op: 'replace', clause_id: 'first', content: side }],
            }),
          ),
        );
        const pending = (
          await readFeatureAccounts(admin, fixture, {
            account_id: account!.account_id,
          })
        ).accounts[0];
        expect(pending.current_revision).toBe(1);
        expect(
          pending.clauses.map((clause: { content: string }) => clause.content),
        ).toEqual(ops.map((op) => op.content));
        expect(pending.pending_amendments).toHaveLength(2);
        // PostgreSQL rejects stale revisions. The local PostgREST 40001 response
        // retries until gateway timeout; that HTTP limitation is tracked separately.
        db(`DO $smoke$ BEGIN
          PERFORM public.propose_feature_amendment('${fixture}','${account!.account_id}',0,
            '[{"op":"replace","clause_id":"first","content":"stale"}]',
            '[{"clause_id":"neighbour"}]','${fixture}','${fixture}','stale');
          RAISE EXCEPTION 'Expected stale revision rejection';
        EXCEPTION WHEN serialization_failure THEN NULL;
        END $smoke$;`);
        await applyFeatureAmendment(admin, fixture, {
          amendment_id: left.amendment_id,
          confirm_production: true,
        });
        const final = (
          await readFeatureAccounts(admin, fixture, {
            account_id: account!.account_id,
          })
        ).accounts[0];
        expect(final.clauses[1]).toMatchObject({
          clause_id: 'neighbour',
          content: ops[1].content,
        });
        const events = await admin
          .from('knowledge_events')
          .select('metadata')
          .contains('metadata', {
            kind: 'amended',
            amendment_id: amendment.amendment_id,
          });
        expect(events.error).toBeNull();
        expect(events.data).toHaveLength(2);
      } finally {
        db(`DELETE FROM public.knowledge_feature_revisions WHERE account_id IN (SELECT account_id FROM public.knowledge_feature_accounts WHERE project_id='${fixture}');
        DELETE FROM public.knowledge_feature_amendments WHERE account_id IN (SELECT account_id FROM public.knowledge_feature_accounts WHERE project_id='${fixture}');
        DELETE FROM public.knowledge_feature_clauses WHERE account_id IN (SELECT account_id FROM public.knowledge_feature_accounts WHERE project_id='${fixture}');
        DELETE FROM public.knowledge_feature_accounts WHERE project_id='${fixture}';
        DELETE FROM public.knowledge_decisions WHERE project_id='${fixture}'; DELETE FROM public.tasks WHERE project_id='${fixture}';
        DELETE FROM public.projects WHERE id='${fixture}'; DELETE FROM public.workspaces WHERE id='${fixture}'; DELETE FROM auth.users WHERE id='${fixture}';`);
      }
    }, 30000);
  },
);
