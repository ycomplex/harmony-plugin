/** Real local PostgREST smoke; opt in with HARMONY_TEST_LOCAL_ACCOUNTS=1. Never targets hosted data. */
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import {
  createFeatureAccount,
  readFeatureAccounts,
} from './feature-accounts.js';
import { captureSurfaceRecord, readSurfaceRecords } from './surface-records.js';
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
const fixture = '00000000-0000-0000-0000-000000123690';
describe.skipIf(process.env.HARMONY_TEST_LOCAL_SURFACES !== '1')(
  'surface real shared-handler smoke',
  () => {
    it('captures, repeats, refreshes, retrieves and degrades only schema absence', async () => {
      db(`INSERT INTO auth.users(id,email,aud,role) VALUES('${fixture}','surface-smoke@test.local','authenticated','authenticated');
  INSERT INTO public.workspaces(id,name,created_by) VALUES('${fixture}','Surface smoke','${fixture}');
  INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES('${fixture}','${fixture}','owner');
  INSERT INTO public.projects(id,workspace_id,name,key,created_by) VALUES('${fixture}','${fixture}','Surface smoke','SURF36','${fixture}');`);
      let held = false;
      try {
        const a = await createFeatureAccount(admin, fixture, {
          owner_surface: 'Views',
        });
        const args = {
          owner_surface: 'Views',
          component_ref: 'web/src/Views.tsx',
          labels: ['Name'],
          buttons: ['Save'],
          headings: ['Views'],
          source_kind: 'component-source',
          source_locator: 'web/src/Views.tsx@a',
          source_fingerprint: 'sha256:a',
        };
        const first = await captureSurfaceRecord(admin, fixture, args);
        expect(await captureSurfaceRecord(admin, fixture, args)).toEqual({
          ...first,
          changed: false,
        });
        const next = await captureSurfaceRecord(admin, fixture, {
          ...args,
          buttons: ['Apply'],
          source_fingerprint: 'sha256:b',
        });
        expect(next).toMatchObject({
          record_id: first.record_id,
          changed: true,
        });
        expect(
          await readSurfaceRecords(admin, fixture, { owner_surface: 'Views' }),
        ).toMatchObject({
          account_id: a.account_id,
          current_text: '',
          records: [{ buttons: ['Apply'] }],
        });
        expect(
          (await readFeatureAccounts(admin, fixture)).accounts[0],
        ).toMatchObject({
          current_revision: 0,
          current_text: '',
          history: [{ revision: 0 }],
        });
        db(
          "ALTER FUNCTION public.read_surface_records(uuid,text,text) RENAME TO b1236_read_held; ALTER FUNCTION public.capture_surface_record(uuid,text,text,text[],text[],text[],text,text,text) RENAME TO b1236_capture_held; NOTIFY pgrst,'reload schema';",
        );
        held = true;
        await expect
          .poll(
            async () =>
              (
                await readSurfaceRecords(admin, fixture, {
                  owner_surface: 'Views',
                })
              ).availability,
          )
          .toBe('unavailable');
        await expect(
          captureSurfaceRecord(admin, fixture, args),
        ).rejects.toThrow('Deploy the web migration');
        expect((await readFeatureAccounts(admin, fixture)).availability).toBe(
          'available',
        );
        db(
          "ALTER FUNCTION public.b1236_read_held(uuid,text,text) RENAME TO read_surface_records; ALTER FUNCTION public.b1236_capture_held(uuid,text,text,text[],text[],text[],text,text,text) RENAME TO capture_surface_record; NOTIFY pgrst,'reload schema';",
        );
        held = false;
        await expect
          .poll(
            async () =>
              (
                await readSurfaceRecords(admin, fixture, {
                  owner_surface: 'Views',
                })
              ).availability,
          )
          .toBe('available');
      } finally {
        if (held)
          db(
            "ALTER FUNCTION public.b1236_read_held(uuid,text,text) RENAME TO read_surface_records; ALTER FUNCTION public.b1236_capture_held(uuid,text,text,text[],text[],text[],text,text,text) RENAME TO capture_surface_record; NOTIFY pgrst,'reload schema';",
          );
        db(`DELETE FROM knowledge_surface_records WHERE account_id IN (SELECT account_id FROM knowledge_feature_accounts WHERE project_id='${fixture}');
   DELETE FROM knowledge_feature_revisions WHERE account_id IN (SELECT account_id FROM knowledge_feature_accounts WHERE project_id='${fixture}');
   DELETE FROM knowledge_feature_accounts WHERE project_id='${fixture}'; DELETE FROM knowledge_decisions WHERE project_id='${fixture}';
   DELETE FROM projects WHERE id='${fixture}'; DELETE FROM workspace_members WHERE workspace_id='${fixture}'; DELETE FROM workspaces WHERE id='${fixture}'; DELETE FROM auth.users WHERE id='${fixture}';`);
      }
    }, 30000);
  },
);
