import { describe, it, expect } from 'vitest';
import {
  detectRiskClasses,
  labelToRiskClass,
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
    it('returns every tripped class, in canonical order', () => {
      const result = detectRiskClasses({
        text: 'Write a migration that runs DROP COLUMN on the auth tokens table',
        changedPaths: ['src/supabase.ts'],
      });
      expect(result).toEqual(['auth', 'data-migration', 'irreversible-destructive', 'shared-core']);
    });

    it('combines text + path + label sources', () => {
      const result = detectRiskClasses({
        text: 'tweak the login copy', // auth (text)
        changedPaths: ['supabase/migrations/x.sql'], // data-migration (path)
        labels: ['destructive'], // irreversible-destructive (label)
      });
      expect(result).toEqual(['auth', 'data-migration', 'irreversible-destructive']);
    });
  });

  it('is defensive against malformed input (never throws)', () => {
    // @ts-expect-error — intentionally malformed
    expect(() => detectRiskClasses({ text: 42, changedPaths: 'nope', labels: { a: 1 } })).not.toThrow();
    // @ts-expect-error — intentionally malformed
    expect(detectRiskClasses({ changedPaths: [null, 5, 'src/auth.ts'] })).toContain('auth');
  });
});
