/**
 * Seat-start / stand-down markers (B-1422, docs/harmony-watch-files.md):
 *
 *   SEAT-START v1 seat=<name> milestone=<id> session=<id>
 *   SEAT-STANDDOWN v1 seat=<name> milestone=<id> session=<id>
 *
 * A session has an OPEN seat-start when its latest marker is a SEAT-START with no later
 * SEAT-STANDDOWN for the same session. The watch only warns about an open seat-start from another
 * session; it never blocks.
 */
import type { MarkerComment } from './board-read.js';

export interface SeatMarker {
  kind: 'start' | 'standdown';
  seat: string;
  milestone: string;
  session: string;
  at: string;
  task_id: string;
}

const MARKER_RE = /^\s*SEAT-(START|STANDDOWN) v1 seat=(\S+) milestone=(\S+) session=(\S+)\s*$/;

export function parseMarkers(comments: readonly MarkerComment[]): SeatMarker[] {
  const out: SeatMarker[] = [];
  for (const c of comments) {
    for (const line of c.content.split(/\r?\n/)) {
      const m = MARKER_RE.exec(line);
      if (!m) continue;
      out.push({
        kind: m[1] === 'START' ? 'start' : 'standdown',
        seat: m[2],
        milestone: m[3],
        session: m[4],
        at: c.created_at,
        task_id: c.task_id,
      });
    }
  }
  return out;
}

/** Open seat-starts (latest marker per session is a start), excluding `ownSession`. */
export function openSeatStarts(comments: readonly MarkerComment[], ownSession: string | null): SeatMarker[] {
  const markers = parseMarkers(comments).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = new Map<string, SeatMarker>();
  for (const m of markers) latest.set(m.session, m);
  return [...latest.values()].filter((m) => m.kind === 'start' && m.session !== ownSession);
}
