// B-1171: the board-side reads the conductor lifecycle commands decide on, ported from
// container/gke/switch-daemon-profile.sh (held_by / adoption_state). The conductor's lease holder is
// `<hostname>:<pid>:<suffix>` (src/bin/daemon.ts); "held by this process" is a prefix match on
// `<hostname>:<pid>:`. Adoption is judged from the BOARD (lease holder + a fresh heartbeat), never from a
// log line.

export interface BoardRow {
  id: string;
  ticket: string | null;
  status: string;
  lease_holder: string | null;
  last_heartbeat_at: string | null;
  leg_started_at?: string | null;
  clean_shutdown_at?: string | null;
}

export const holderPrefix = (host: string, pid: number): string => `${host}:${pid}:`;

/** Active conductions whose lease holder starts with the prefix. */
export function heldBy(rows: BoardRow[], prefix: string): BoardRow[] {
  return rows.filter((r) => r.status === 'active' && typeof r.lease_holder === 'string' && r.lease_holder.startsWith(prefix));
}

export type AdoptionState = { state: 'ok' } | { state: 'gone' } | { state: 'wait'; why: string };

/** Has the conduction been adopted by the holder `prefix` with a heartbeat younger than freshMs? `gone`
 *  means it is no longer active (it settled meanwhile), which counts as resolved. */
export function adoptionState(rows: BoardRow[], id: string, prefix: string, freshMs: number, nowMs: number): AdoptionState {
  const r = rows.find((x) => x.id === id);
  if (!r || r.status !== 'active') return { state: 'gone' };
  if (typeof r.lease_holder !== 'string' || !r.lease_holder.startsWith(prefix)) {
    return { state: 'wait', why: `lease holder is ${r.lease_holder || 'none'}` };
  }
  const hb = Date.parse(r.last_heartbeat_at || '');
  if (!Number.isFinite(hb) || nowMs - hb > freshMs) {
    return { state: 'wait', why: `heartbeat ${r.last_heartbeat_at || 'missing'} is not fresh` };
  }
  return { state: 'ok' };
}

export interface LeaseView {
  id: string;
  ticket: string;
  holder: string | null;
  last_heartbeat_at: string | null;
  /** held by the running conductor, held by an earlier process on this host, or held on another host. */
  owner: 'this-conductor' | 'previous-process' | 'other-host';
  fresh: boolean;
}

/** Every active conduction, classified against the conductor running here (pid null = none running). */
export function classifyLeases(rows: BoardRow[], host: string, runningPid: number | null, freshMs: number, nowMs: number): LeaseView[] {
  const out: LeaseView[] = [];
  for (const r of rows) {
    if (r.status !== 'active') continue;
    const holder = r.lease_holder;
    let owner: LeaseView['owner'] = 'other-host';
    if (typeof holder === 'string' && holder.startsWith(`${host}:`)) {
      owner = runningPid !== null && holder.startsWith(holderPrefix(host, runningPid)) ? 'this-conductor' : 'previous-process';
    }
    const hb = Date.parse(r.last_heartbeat_at || '');
    out.push({
      id: r.id,
      ticket: r.ticket ?? '?',
      holder: holder ?? null,
      last_heartbeat_at: r.last_heartbeat_at,
      owner,
      fresh: Number.isFinite(hb) && nowMs - hb <= freshMs,
    });
  }
  return out;
}
