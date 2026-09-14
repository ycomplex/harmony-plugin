import { describe, it, expect } from 'vitest';
import {
  detectRiskClasses,
  labelToRiskClass,
  PATH_GLOB_TABLE,
  RISK_CLASSES,
  type RiskClass,
} from './risk-class.js';

describe('risk-class detector (conductor floor)', () => {
  it('exposes exactly the four canonical classes', () => {
    expect(RISK_CLASSES).toEqual(['auth', 'data-migration', 'irreversible-destructive', 'shared-core']);
  });

  describe('clean input → []', () => {
    it('returns [] for empty / whitespace / undefined input', () => {
      expect(detectRiskClasses({})).toEqual([]);
      expect(detectRiskClasses({ text: '' })).toEqual([]);
      expect(detectRiskClasses({ text: '   \n\t  ' })).toEqual([]);
      expect(detectRiskClasses({ text: undefined, changedPaths: undefined, labels: undefined })).toEqual([]);
    });

    it('returns [] for benign text and benign paths (no false positives)', () => {
      expect(
        detectRiskClasses({
          text: 'Add a dropdown to the dashboard header and tidy up the author byline copy.',
          changedPaths: ['src/components/Header.tsx', 'src/lib/format.ts', 'README.md'],
        }),
      ).toEqual([]);
    });

    it('does not trip `auth` on the substring "author"/"authored" (word-boundary discipline)', () => {
      expect(detectRiskClasses({ text: 'Display the author and the authored-at timestamp.' })).toEqual([]);
    });

    it('does not trip `irreversible-destructive` on "dropdown" (boundary discipline)', () => {
      expect(detectRiskClasses({ text: 'Build a dropdown menu component.' })).toEqual([]);
    });
  });

  describe('auth class', () => {
    it('trips on representative text', () => {
      for (const t of [
        'Refactor the login flow',
        'Rotate the session token',
        'Tighten an RLS policy',
        'Add an OAuth provider',
        'Reset password endpoint',
        'Change a user role / permission check',
      ]) {
        expect(detectRiskClasses({ text: t })).toContain<RiskClass>('auth');
      }
    });

    it('trips on representative paths', () => {
      expect(detectRiskClasses({ changedPaths: ['web/src/features/auth/login.ts'] })).toContain<RiskClass>('auth');
      expect(detectRiskClasses({ changedPaths: ['src/auth.ts'] })).toContain<RiskClass>('auth');
      expect(detectRiskClasses({ changedPaths: ['app/rls/policies.sql'] })).toContain<RiskClass>('auth');
    });

    it('conservative bias — a ticket merely MENTIONING auth trips it', () => {
      expect(
        detectRiskClasses({ text: 'This is mostly a copy change but it lives near the auth screen.' }),
      ).toContain<RiskClass>('auth');
    });
  });

  describe('data-migration class', () => {
    it('trips on representative text', () => {
      for (const t of [
        'Write a migration to add a column',
        'Change the schema',
        'ALTER TABLE tasks ADD COLUMN foo',
        'Backfill the new field',
        'DROP COLUMN legacy_status',
      ]) {
        expect(detectRiskClasses({ text: t })).toContain<RiskClass>('data-migration');
      }
    });

    it('trips on representative paths', () => {
      expect(
        detectRiskClasses({ changedPaths: ['supabase/migrations/20260618_add_col.sql'] }),
      ).toContain<RiskClass>('data-migration');
      expect(detectRiskClasses({ changedPaths: ['db/schema.sql'] })).toContain<RiskClass>('data-migration');
    });
  });

  describe('irreversible-destructive class', () => {
    it('trips on representative text', () => {
      for (const t of [
        'DROP TABLE old_events',
        'DELETE FROM tasks WHERE archived',
        'TRUNCATE the staging table',
        'This change is irreversible',
        'Hard-delete the account',
        'Purge expired sessions', // also auth via "sessions" — that's fine, multi-class
        'Permanently delete the row',
      ]) {
        expect(detectRiskClasses({ text: t })).toContain<RiskClass>('irreversible-destructive');
      }
    });

    it('has no innocent path signature — destructiveness lives in content', () => {
      // A path alone never trips destructive; only text/labels do.
      expect(detectRiskClasses({ changedPaths: ['src/lib/cleanup.ts'] })).not.toContain<RiskClass>(
        'irreversible-destructive',
      );
    });
  });

  describe('shared-core class', () => {
    it('trips on curated shared module names in text', () => {
      expect(detectRiskClasses({ text: 'Edit supabase.ts to add a client option' })).toContain<RiskClass>(
        'shared-core',
      );
      expect(detectRiskClasses({ text: 'Update registerTools in the tool registry' })).toContain<RiskClass>(
        'shared-core',
      );
    });

    it('trips on curated shared-core paths', () => {
      expect(detectRiskClasses({ changedPaths: ['plugin/src/supabase.ts'] })).toContain<RiskClass>('shared-core');
      expect(detectRiskClasses({ changedPaths: ['src/tools/index.ts'] })).toContain<RiskClass>('shared-core');
    });
  });

  describe('label override', () => {
    it('force-trips the named class regardless of text/paths', () => {
      expect(detectRiskClasses({ labels: ['auth'] })).toEqual(['auth']);
      expect(detectRiskClasses({ labels: ['risk:data-migration'] })).toEqual(['data-migration']);
      expect(detectRiskClasses({ labels: ['destructive'] })).toEqual(['irreversible-destructive']);
      expect(detectRiskClasses({ labels: ['core'] })).toEqual(['shared-core']);
    });

    it('ignores unknown labels', () => {
      expect(detectRiskClasses({ labels: ['frontend', 'nice-to-have'] })).toEqual([]);
    });

    it('labelToRiskClass normalizes aliases and rejects junk', () => {
      expect(labelToRiskClass('risk:auth')).toBe('auth');
      expect(labelToRiskClass('Migration')).toBe('data-migration');
      expect(labelToRiskClass('irreversible')).toBe('irreversible-destructive');
      expect(labelToRiskClass('shared core')).toBe('shared-core');
      expect(labelToRiskClass('whatever')).toBeNull();
    });
  });

  describe('multiple classes together', () => {
    it('returns every tripped class, in canonical order (discovery gate — no diff, no down-weight)', () => {
      // No changedPaths ⇒ a discovery gate: prose hits are NOT down-weighted, so every
      // prose-derived class trips. (B-516: the build-gate down-weight only fires with a real diff.)
      const result = detectRiskClasses({
        text: 'Write a migration that runs DROP COLUMN on the auth tokens table; edit supabase.ts',
      });
      expect(result).toEqual(['auth', 'data-migration', 'irreversible-destructive', 'shared-core']);
    });

    it('returns every tripped class when the diff CORROBORATES each prose class (B-516 down-weight is path-corroborated)', () => {
      // With a real diff present, each prose class must be corroborated by a touching path
      // to survive the down-weight (destructive has no path signature, so its prose hit stands).
      const result = detectRiskClasses({
        text: 'Write a migration that runs DROP COLUMN on the auth tokens table',
        changedPaths: ['src/auth.ts', 'supabase/migrations/x.sql', 'src/supabase.ts'],
      });
      expect(result).toEqual(['auth', 'data-migration', 'irreversible-destructive', 'shared-core']);
    });

    it('combines text + path + label sources (auth prose corroborated by an auth path under a real diff)', () => {
      // A real diff is present, so the auth PROSE hit ("login") must be corroborated by an auth
      // path to survive the down-weight; data-migration comes from a path, destructive from a label.
      const result = detectRiskClasses({
        text: 'tweak the login copy', // auth (text) — corroborated by src/auth.ts below
        changedPaths: ['supabase/migrations/x.sql', 'web/src/features/auth/login.ts'], // data-migration + auth (path)
        labels: ['destructive'], // irreversible-destructive (label)
      });
      expect(result).toEqual(['auth', 'data-migration', 'irreversible-destructive']);
    });

    it('B-516: a real diff down-weights every UNCORROBORATED prose class (only the path/label/destructive hits survive)', () => {
      // The companion of the test above: same prose, but the diff touches ONLY shared-core —
      // so the auth + data-migration PROSE hits are down-weighted, while destructive (no path
      // signature) and shared-core (path hit) stand. This is the exact false-positive B-516 fixes.
      const result = detectRiskClasses({
        text: 'Write a migration that runs DROP COLUMN on the auth tokens table',
        changedPaths: ['src/supabase.ts'],
      });
      expect(result).toEqual(['irreversible-destructive', 'shared-core']);
    });
  });

  it('is defensive against malformed input (never throws)', () => {
    // @ts-expect-error — intentionally malformed
    expect(() => detectRiskClasses({ text: 42, changedPaths: 'nope', labels: { a: 1 } })).not.toThrow();
    // @ts-expect-error — intentionally malformed
    expect(detectRiskClasses({ changedPaths: [null, 5, 'src/auth.ts'] })).toContain('auth');
  });

  // =========================================================================
  // B-516 — SCOPE-AWARENESS regression lock.
  // The detector is deterministic + conservative-on-ambiguity: it suppresses a
  // keyword hit ONLY on a CLEAR negation / wrong word-sense / clean-diff
  // contradiction, and otherwise still fires (a false negative is the failure
  // the floor exists to catch). These cases lock the real-world false-positives
  // the floor produced (Ev1/Ev1b/Ev1c) AND prove the genuine positives still trip.
  // =========================================================================
  describe('B-516 negation-scoping (discovery-gate prose)', () => {
    it('Ev1: "no schema, no RPC, no migration" does NOT fire data-migration', () => {
      expect(
        detectRiskClasses({ text: 'This adds no schema, no RPC, no migration — purely a UI tweak.' }),
      ).not.toContain<RiskClass>('data-migration');
    });

    it('Ev1b: "no second surface (no schema/RPC/DB, no MCP, no migration) to coordinate" does NOT fire data-migration', () => {
      expect(
        detectRiskClasses({
          text: 'There is no second surface (no schema/RPC/DB, no MCP, no migration) to coordinate here.',
        }),
      ).not.toContain<RiskClass>('data-migration');
    });

    it('suppresses on the full range of negation cues (not / without / n\'t / zero / neither-nor)', () => {
      expect(detectRiskClasses({ text: 'We do not change the schema.' })).not.toContain<RiskClass>('data-migration');
      expect(detectRiskClasses({ text: 'Ships without a migration.' })).not.toContain<RiskClass>('data-migration');
      expect(detectRiskClasses({ text: "There isn't a migration involved." })).not.toContain<RiskClass>(
        'data-migration',
      );
      expect(detectRiskClasses({ text: 'Zero schema changes.' })).not.toContain<RiskClass>('data-migration');
      expect(detectRiskClasses({ text: 'Neither a migration nor a backfill.' })).not.toContain<RiskClass>(
        'data-migration',
      );
    });

    it('CONSERVATIVE-ON-AMBIGUITY: a negation far from the keyword still trips (only the SHORT window suppresses)', () => {
      // "no" is well outside the ~4-token preceding window of "migration" → not a clear negation → still fires.
      expect(
        detectRiskClasses({
          text: 'There is no doubt that this carefully-planned, much-discussed change needs a migration.',
        }),
      ).toContain<RiskClass>('data-migration');
    });

    it('MUST still fire: a genuine, un-negated migration/schema mention', () => {
      expect(detectRiskClasses({ text: 'Run a migration to add the new column.' })).toContain<RiskClass>(
        'data-migration',
      );
      expect(detectRiskClasses({ text: 'ALTER TABLE tasks ADD COLUMN foo;' })).toContain<RiskClass>('data-migration');
    });

    // -- B-516 review fix: clause-boundary-bounded backward scan + hyphen-aware tokenizer --
    describe('B-516 review: negation must NOT cross a clause boundary, and hyphenated cues stay intact', () => {
      it('MUST FIRE — a cue that negates a DIFFERENT clause does not suppress (comma boundary)', () => {
        // "no" negates *downtime*, not *migration* — the comma stops the backward scan.
        expect(
          detectRiskClasses({ text: 'with no downtime, run the migration' }),
        ).toContain<RiskClass>('data-migration');
      });

      it('MUST FIRE — `no-op` is one token, not the cue `no` (hyphen-aware tokenizer)', () => {
        expect(
          detectRiskClasses({ text: 'no-op guard; ALTER TABLE foo' }),
        ).toContain<RiskClass>('data-migration');
      });

      it('MUST FIRE — `none affected; DROP TABLE` — the semicolon stops the scan (none stays safe to keep as a cue)', () => {
        expect(
          detectRiskClasses({ text: 'none affected; DROP TABLE staging' }),
        ).toContain<RiskClass>('irreversible-destructive');
      });

      it('MUST FIRE — a cue across an em-dash/coordinating-clause boundary does not suppress the next clause', () => {
        // "no breaking changes" — then "backfill the column" is a fresh clause; the em-dash + the
        // distance keep `no` out of `backfill`'s in-clause window.
        expect(
          detectRiskClasses({ text: 'no breaking changes — backfill the column' }),
        ).toContain<RiskClass>('data-migration');
      });

      it('MUST NOT FIRE — the original B-516 enumeration repros stay green (cue is in the SAME clause as the keyword)', () => {
        expect(
          detectRiskClasses({ text: 'no schema, no RPC, no migration' }),
        ).not.toContain<RiskClass>('data-migration');
        expect(
          detectRiskClasses({
            text: 'no second surface (no schema/RPC/DB, no MCP, no migration) to coordinate',
          }),
        ).not.toContain<RiskClass>('data-migration');
      });
    });
  });

  describe('B-516 word-sense tightening (token → auth)', () => {
    it('Ev1c: "workflow_state gate token" does NOT fire auth (state-machine sense)', () => {
      expect(detectRiskClasses({ text: 'Advance via the workflow_state gate token.' })).not.toContain<RiskClass>(
        'auth',
      );
      expect(detectRiskClasses({ text: 'Consume the workflow_state token on resolve.' })).not.toContain<RiskClass>(
        'auth',
      );
      expect(detectRiskClasses({ text: 'The gate token is the durable signal.' })).not.toContain<RiskClass>('auth');
      expect(detectRiskClasses({ text: 'Pass the state token forward.' })).not.toContain<RiskClass>('auth');
      expect(detectRiskClasses({ text: 'A bare "the workflow state token" reference.' })).not.toContain<RiskClass>(
        'auth',
      );
    });

    it('a bare/unqualified "token" does NOT fire auth on its own', () => {
      expect(detectRiskClasses({ text: 'Each item carries a unique token.' })).not.toContain<RiskClass>('auth');
    });

    it('MUST still fire: a real auth-sense token (auth/bearer/jwt/session/refresh qualifier)', () => {
      expect(detectRiskClasses({ text: 'Rotate the auth token on login.' })).toContain<RiskClass>('auth');
      expect(detectRiskClasses({ text: 'Validate the bearer token in the header.' })).toContain<RiskClass>('auth');
      expect(detectRiskClasses({ text: 'Refresh the JWT token.' })).toContain<RiskClass>('auth');
      expect(detectRiskClasses({ text: 'Persist the session token.' })).toContain<RiskClass>('auth');
      // qualifier can FOLLOW the token word too ("token refresh")
      expect(detectRiskClasses({ text: 'Implement token refresh.' })).toContain<RiskClass>('auth');
    });

    it('the OTHER auth keywords are unaffected by the token guard', () => {
      // "workflow_state gate token" should not fire — but a real login/RLS mention still does.
      expect(detectRiskClasses({ text: 'Tighten the RLS policy on the login flow.' })).toContain<RiskClass>('auth');
    });

    // -- B-516 review fix: a PRESENT auth qualifier WINS, even when a state word is nearby --
    describe('B-516 review: a present auth qualifier beats a nearby state word (no over-suppression)', () => {
      it('MUST FIRE — "validate the bearer token in the gate handler" → auth (bearer qualifier present)', () => {
        expect(
          detectRiskClasses({ text: 'validate the bearer token in the gate handler' }),
        ).toContain<RiskClass>('auth');
      });

      it('MUST FIRE — "refresh the JWT token used by the state service" → auth (refresh/jwt present)', () => {
        expect(
          detectRiskClasses({ text: 'refresh the JWT token used by the state service' }),
        ).toContain<RiskClass>('auth');
      });

      it('MUST NOT FIRE — "workflow_state gate token" → not auth (no auth qualifier)', () => {
        expect(detectRiskClasses({ text: 'workflow_state gate token' })).not.toContain<RiskClass>('auth');
      });

      it('MUST NOT FIRE — "the gate token advances the state" → not auth (no auth qualifier)', () => {
        expect(detectRiskClasses({ text: 'the gate token advances the state' })).not.toContain<RiskClass>('auth');
      });
    });
  });

  describe('B-516 build-gate changed_paths-clean down-weight (build gate ONLY)', () => {
    it('prose mentions "migration" but changed_paths touch no migration glob → down-weighted', () => {
      expect(
        detectRiskClasses({
          text: 'Follow-up to the big migration; this just relabels a button.',
          changedPaths: ['src/components/Foo.tsx'],
        }),
      ).not.toContain<RiskClass>('data-migration');
    });

    it('prose mentions "migration" WITH a migration path in changed_paths → still fires', () => {
      expect(
        detectRiskClasses({
          text: 'Follow-up to the big migration; this just relabels a button.',
          changedPaths: ['supabase/migrations/20260622_x.sql'],
        }),
      ).toContain<RiskClass>('data-migration');
    });

    it('DISCOVERY gate (no changed_paths) does NOT down-weight — absence-of-diff ≠ clean-diff', () => {
      // Same prose, but NO changed_paths passed (a discovery gate) → the prose hit stands.
      expect(
        detectRiskClasses({ text: 'This needs a migration to add the column.' }),
      ).toContain<RiskClass>('data-migration');
    });

    it('a path-only hit is never down-weighted (a real diff signal stands on its own)', () => {
      expect(
        detectRiskClasses({ text: 'Pure copy change.', changedPaths: ['supabase/migrations/x.sql'] }),
      ).toContain<RiskClass>('data-migration');
    });

    it('irreversible-destructive (no path signature) is NOT down-weighted by a clean diff — floor stays protective', () => {
      // It has no path-glob to corroborate against, so a clean diff can't debunk a destructive prose hit.
      expect(
        detectRiskClasses({ text: 'DROP TABLE old_events;', changedPaths: ['src/components/Foo.tsx'] }),
      ).toContain<RiskClass>('irreversible-destructive');
    });

    // -- B-516 review fix (test gap): the down-weight must also cover shared-core, both directions --
    it('shared-core: prose mentions a shared-core module but changed_paths touch no shared-core glob → down-weighted', () => {
      expect(
        detectRiskClasses({
          text: 'Edit supabase.ts to add a client option.',
          changedPaths: ['src/components/Foo.tsx'],
        }),
      ).not.toContain<RiskClass>('shared-core');
    });

    it('shared-core: prose mentions a shared-core module WITH a corroborating shared-core path → still fires', () => {
      expect(
        detectRiskClasses({
          text: 'Edit supabase.ts to add a client option.',
          changedPaths: ['plugin/src/supabase.ts'],
        }),
      ).toContain<RiskClass>('shared-core');
    });
  });

  // =========================================================================
  // B-932 — word-sense-aware auth BASENAME matching for path-glob detection.
  // The unanchored glob `**/*auth*.ts` used to trip on any `.ts` filename merely
  // CONTAINING the substring "auth" (e.g. `brief-authoring.contract.test.ts`,
  // `coauthor.ts`). The basename check now tokenizes (split on `-`/`_`/`.`/digit-run/
  // camelCase boundaries) and tests each token WHOLE against the same word-sense
  // regexes the prose detector uses — so a real auth term still trips regardless of
  // delimiter style, while a merely-containing name does not.
  // =========================================================================
  describe('B-932 auth path-glob basename word-sense matching', () => {
    it('positive control: the unanchored glob was removed (6 -> 5 entries)', () => {
      expect(PATH_GLOB_TABLE.auth.length).toBe(5);
    });

    it('MUST TRIP: camelCase / delimiter-separated real-auth basenames', () => {
      for (const p of [
        'src/authService.ts',
        'src/useAuth.ts',
        'src/authClient.ts',
        'src/oauth2.ts',
        'src/auth.ts',
        'src/oauth-client.ts',
        'src/authz.ts',
      ]) {
        expect(detectRiskClasses({ changedPaths: [p] })).toContain<RiskClass>('auth');
      }
    });

    it('MUST NOT TRIP: a basename that merely CONTAINS the substring "auth"', () => {
      for (const p of ['src/brief-authoring.contract.test.ts', 'src/coauthor.ts', 'src/Coauthor.ts']) {
        expect(detectRiskClasses({ changedPaths: [p] })).not.toContain<RiskClass>('auth');
      }
    });

    it('CONSERVATIVE-ON-AMBIGUITY: no token boundary before "auth" (mid-token) does NOT trip', () => {
      for (const p of ['src/Unauthorized.ts', 'src/unauthenticated.ts']) {
        expect(detectRiskClasses({ changedPaths: [p] })).not.toContain<RiskClass>('auth');
      }
    });

    it('round 1 glob-path positives still trip (glob-check path and basename-check path each pinned)', () => {
      for (const p of ['src/auth.ts', 'src/oauth-client.ts', 'src/auth/middleware.ts', 'middleware/auth-check.ts']) {
        expect(detectRiskClasses({ changedPaths: [p] })).toContain<RiskClass>('auth');
      }
    });
  });

  describe('B-516 genuine-positive floor protection (the floor still bites)', () => {
    it('real auth token / bearer token → auth', () => {
      expect(detectRiskClasses({ text: 'rotate the auth token' })).toContain<RiskClass>('auth');
      expect(detectRiskClasses({ text: 'check the bearer token' })).toContain<RiskClass>('auth');
    });

    it('ALTER TABLE / a real run-a-migration → data-migration', () => {
      expect(detectRiskClasses({ text: 'ALTER TABLE foo ADD COLUMN bar' })).toContain<RiskClass>('data-migration');
      expect(detectRiskClasses({ text: 'we will run a migration for this' })).toContain<RiskClass>('data-migration');
    });

    it('DROP TABLE / DELETE FROM → irreversible-destructive', () => {
      expect(detectRiskClasses({ text: 'DROP TABLE legacy' })).toContain<RiskClass>('irreversible-destructive');
      expect(detectRiskClasses({ text: 'DELETE FROM tasks WHERE archived' })).toContain<RiskClass>(
        'irreversible-destructive',
      );
    });
  });

  // =========================================================================
  // B-889 — negation scope widening (hard vs list-connector clause boundaries,
  // window 4→6) + two new word-sense guards (migration CI-trigger prose,
  // reading-qualifier auth prose). Same conservative-on-ambiguity contract as
  // B-516: suppress ONLY a clear negation / wrong sense, never on ambiguity.
  // =========================================================================
  describe('B-889 negation-scoping: list-connector vs hard clause boundary', () => {
    it('AC1/AC2: a single shared "no" crossing "and" over a plain list item does NOT trip data-migration', () => {
      expect(
        detectRiskClasses({
          text: 'This adds no client-side detector port and no tasks table migration.',
        }),
      ).not.toContain<RiskClass>('data-migration');
      expect(
        detectRiskClasses({ text: 'adds no client-side detector port and migration' }),
      ).not.toContain<RiskClass>('data-migration');
    });

    it('AC1/AC2: the other literal B-889 negation specimens do NOT trip data-migration', () => {
      expect(detectRiskClasses({ text: 'no schema change, no migration' })).not.toContain<RiskClass>(
        'data-migration',
      );
      expect(detectRiskClasses({ text: 'builds no column' })).not.toContain<RiskClass>('data-migration');
    });

    it('AC5 control: a list-connector followed by a SUBJECT_STARTER_WORD stops the scan — a genuine NEW clause after "and" still fires', () => {
      // "no" negates *downtime* only; "this" is a subject-starter right after "and", so the scan
      // stops there and "migration" is a fresh, un-negated clause.
      expect(
        detectRiskClasses({ text: 'There is no downtime and this migration must run before deploy.' }),
      ).toContain<RiskClass>('data-migration');
    });
  });

  describe('B-889 word-sense: migrations? rejected next to a CI-trigger PR/pull-request noun', () => {
    it('AC3: "on a migration PR" does NOT trip data-migration', () => {
      expect(
        detectRiskClasses({ text: "Harmony's Playwright E2E on a migration PR" }),
      ).not.toContain<RiskClass>('data-migration');
    });

    it('AC3: "on non-migration PRs" does NOT trip data-migration', () => {
      expect(detectRiskClasses({ text: 'web E2E on non-migration PRs' })).not.toContain<RiskClass>(
        'data-migration',
      );
    });

    it('AC5 control: a genuine migration mention near an unrelated "PR" elsewhere in the sentence still trips', () => {
      // "PR" is not the word immediately after "migration" — this is a real schema migration,
      // not CI-trigger-condition prose.
      expect(
        detectRiskClasses({ text: 'We should ship a database migration before merging this PR.' }),
      ).toContain<RiskClass>('data-migration');
    });
  });

  describe('B-889 word-sense: credentials?/session/tokens?/permissions? rejected near a reading-qualifier word', () => {
    it('AC4: the B-930 literal specimens do NOT trip auth', () => {
      expect(detectRiskClasses({ text: '403 Resource not accessible by integration' })).not.toContain<RiskClass>(
        'auth',
      );
      expect(
        detectRiskClasses({ text: "has not been exercised from inside a worker's credentials" }),
      ).not.toContain<RiskClass>('auth');
    });

    it('B-936: the same ticket text read twice (once bare, once with reading-qualifier brief prose added) produces a STABLE class set', () => {
      const baseText =
        'Investigate flaky CI: the worker task probably needs another look at the daemon retry logs.';
      const withBrief =
        baseText +
        ' The failure trace shows the daemon reading the existing session state before the retry; ' +
        'the current credentials remain untouched here — under normal operation the token file ' +
        'is left as-is by this fix.';
      const before = detectRiskClasses({ text: baseText });
      const after = detectRiskClasses({ text: withBrief });
      expect(before).toEqual([]);
      // The added prose mentions session/credentials/token, but ALL are reading-qualifier hits
      // (existing/current/under) with no authoring verb nearby — the class set must not flip.
      expect(after).toEqual(before);
    });

    it('AC5 control: an authoring-verb signal WINS over a nearby reading-qualifier word — still trips auth', () => {
      expect(
        detectRiskClasses({
          text: 'Add a new auth check under the existing session middleware to require credentials.',
        }),
      ).toContain<RiskClass>('auth');
      // Isolated case with NO unconditional auth keyword (no "auth"/"login"/etc.) — proves the
      // authoring-verb-wins behaviour on credentials/session specifically, not a different keyword.
      expect(
        detectRiskClasses({
          text: 'Implement a new step that requires credentials under the existing session flow.',
        }),
      ).toContain<RiskClass>('auth');
    });
  });
});
