import type { SupabaseClient } from '@supabase/supabase-js';
import { hasUnparsedAttestedMarker, parseAttestedKeys } from '../config/manifest-evidence.js';

/**
 * B-1015 — the ONE reader of a ticket's attestation lineage, shared by the verify-brief compose
 * (`briefs.ts`) and `get_build_evidence_status` (`evidence-status.ts`). Before this each had its own
 * read, and they disagreed: the brief read `resolved_detail` + `pending_resolution.detail`, the status
 * tool read `resolved_detail` only, and NEITHER read `briefs.accept_remark` — the accept remark box the
 * `backed_by` hint tells the human to type the marker into. On B-974's own verify gate the founder's
 * `ATTESTED: staging-channel-smoke` landed in that column, correctly formed, and was unreadable by both.
 *
 * Three places a human's words land on a `verification-ack-pending` revision, all read here:
 *   - `resolved_detail` — what a previous accept/iterate recorded as its inert note;
 *   - `pending_resolution.detail` — a browser-submitted command not yet consumed;
 *   - `accept_remark` — B-503's accept-with-remark column, the "accept remark box".
 *
 * Column-degrading, in the pattern the brief's reader already used: `pending_resolution` and
 * `accept_remark` each postdate some live databases, so a 400 on the full select retries narrower,
 * down to `resolved_detail` alone. Any failure at all yields nothing attested — the safe direction (an
 * entry stays visibly outstanding rather than silently reading as confirmed).
 */
export async function readAttestationDetails(
  client: SupabaseClient,
  taskId: string,
): Promise<Array<string | null | undefined>> {
  const selects = [
    'reason, resolved_detail, pending_resolution, accept_remark',
    'reason, resolved_detail, pending_resolution',
    'reason, resolved_detail',
  ];
  try {
    let rows: Array<Record<string, unknown>> | null = null;
    for (const columns of selects) {
      // One filter, the gate filtered in memory: the lineage is a handful of rows, and a single `eq`
      // keeps the read shape every existing caller's test double already serves.
      const res = await client.from('briefs').select(columns).eq('task_id', taskId);
      if (!res.error) {
        // A dynamic column list defeats supabase-js's select typing, hence the detour through unknown.
        rows = (res.data as unknown as Array<Record<string, unknown>>) ?? [];
        break;
      }
    }
    if (rows === null) return [];
    const details: Array<string | null | undefined> = [];
    for (const row of rows) {
      if (row.reason !== 'verification-ack-pending') continue;
      if (typeof row.resolved_detail === 'string') details.push(row.resolved_detail);
      const pending = row.pending_resolution as { detail?: unknown } | null | undefined;
      if (pending && typeof pending === 'object' && typeof pending.detail === 'string') {
        details.push(pending.detail);
      }
      if (typeof row.accept_remark === 'string') details.push(row.accept_remark);
    }
    return details;
  } catch {
    return [];
  }
}

export interface AttestationReadback {
  /** Keys the lineage attests — `parseAttestedKeys` over every detail read. */
  attestedKeys: string[];
  /** B-1015: some detail contains the marker but no key parsed out of it. */
  unparsedMarker: boolean;
}

/** Read the lineage and judge it in one call — what both callers actually want. */
export async function readAttestation(client: SupabaseClient, taskId: string): Promise<AttestationReadback> {
  const details = await readAttestationDetails(client, taskId);
  return { attestedKeys: parseAttestedKeys(details), unparsedMarker: hasUnparsedAttestedMarker(details) };
}
