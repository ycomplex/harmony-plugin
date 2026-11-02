import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConductionRecord } from './conduction-record.js';

/** New columns travel only through these feature-detected RPCs, never ordinary selects. */
export interface CleanupClaim extends ConductionRecord {
  cleanup_token: string;
  cleanup_holder: string;
  cleanup_until: string;
  cleanup_error: string | null;
}
export interface ConductionCleanup {
  list(): Promise<CleanupClaim[] | null>;
  claim(row: ConductionRecord): Promise<CleanupClaim | null>;
  finish(row: CleanupClaim, error?: string): Promise<boolean>;
}
const absent = (e: { code?: string; message?: string }) =>
  ['42883', 'PGRST202'].includes(e.code ?? '') && /conduction_cleanup/.test(e.message ?? '');

export function createConductionCleanup(
  client: SupabaseClient, projectId: string, holder: string, staleMs: number,
): ConductionCleanup {
  return {
    async list() {
      const { data, error } = await client.rpc('list_conduction_cleanup', { p_project_id: projectId });
      if (error) { if (absent(error)) return null; throw error; }
      return data as CleanupClaim[];
    },
    async claim(row) {
      const { data, error } = await client.rpc('claim_conduction_cleanup', {
        p_id: row.id, p_updated_at: row.updated_at, p_holder: holder,
        p_stale_before: new Date(Date.now() - staleMs).toISOString(),
      });
      if (error) throw error;
      return (data?.[0] as CleanupClaim | undefined) ?? null;
    },
    async finish(row, errorText) {
      const { data, error } = await client.rpc('finish_conduction_cleanup', {
        p_id: row.id, p_token: row.cleanup_token, p_holder: holder,
        p_worker_ref: row.worker_ref, p_leg_started_at: row.leg_started_at,
        p_error: errorText ?? null,
      });
      if (error) throw error;
      return data === true;
    },
  };
}
