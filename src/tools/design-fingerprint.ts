// B-1203 — content fingerprint of an accepted Figma design. The leg that consumes the design accept takes it
// (`harmony design fingerprint take`), the plan and build gates compare it (`... compare`). One REST GET of
// the accepted frames' nodes; the digest covers what a designer would call "the design" and nothing volatile:
// a canvas drag, a file save, a thumbnail refresh or a prototype tweak must not change it.
//
// EXPECTED FAILURES NEVER THROW and never carry the token or a response body: they come back as a typed
// 'not-taken' record with a reason. The web only displays the stored status; it never calls Figma.
//
// Fixture note: src/tools/__fixtures__/design-fingerprint.live-2026-10-29.json is a REAL nodes response for
// frame 25:205; three reads ~100 s apart were byte-identical (sha256 c349e903ba5b1e68024003f79d17c0c718bac33f6c5ff9ae33d9fd3670804e37).
import { createHash } from 'node:crypto';

export const FINGERPRINT_ALGORITHM = 'sha256-16/nodes-v1';

export type NotTakenReason = 'no-token' | 'figma-unreachable' | 'rate-limited' | 'unauthorized' | 'frame-missing' | 'http-error';

export interface FrameDigest { id: string; digest: string }

export interface TakenFingerprint {
  schema_version: 1;
  algorithm: typeof FINGERPRINT_ALGORITHM;
  digest: string;
  frames: FrameDigest[];
  accepted_at: string;
  taken_at: string;
  status: 'taken';
}
export interface NotTakenFingerprint {
  schema_version: 1;
  algorithm: typeof FINGERPRINT_ALGORITHM;
  accepted_at: string;
  taken_at: string;
  status: 'not-taken';
  reason: NotTakenReason;
}
export type FingerprintRecord = TakenFingerprint | NotTakenFingerprint;
export type TakeResult =
  | { status: 'taken'; record: TakenFingerprint }
  | { status: 'not-taken'; record: NotTakenFingerprint };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (n: number, places: number): number => {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Normalise a JSON value: sorted keys, numbers to 2 decimals (colour channels r,g,b,a to 4), undefined dropped. */
function norm(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? round(v, 2) : null;
  if (Array.isArray(v)) return v.map(norm);
  if (!isObj(v)) return v === undefined ? undefined : v;
  const isColour = ['r', 'g', 'b'].every((k) => typeof v[k] === 'number');
  const out: Obj = {};
  for (const k of Object.keys(v).sort()) {
    const x = v[k];
    if (x === undefined) continue;
    out[k] = isColour && (k === 'r' || k === 'g' || k === 'b' || k === 'a') && typeof x === 'number' ? round(x, 4) : norm(x);
  }
  return out;
}

const VALUE_FIELDS = [
  'characters', 'componentId', 'componentProperties', 'fills', 'strokes', 'strokeWeight', 'effects', 'cornerRadius',
  'opacity', 'style', 'visible',
  'layoutMode', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing',
  'primaryAxisAlignItems', 'counterAxisAlignItems',
] as const;

function canonNode(n: Obj, origin: { x: number; y: number }): Obj {
  const box = isObj(n.absoluteBoundingBox) ? n.absoluteBoundingBox : null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const out: Obj = { id: n.id, type: n.type, name: n.name };
  for (const f of VALUE_FIELDS) if (n[f] !== undefined) out[f] = n[f];
  if (box) {
    out.width = num(box.width);
    out.height = num(box.height);
    out.x = num(box.x) === null ? null : (box.x as number) - origin.x;
    out.y = num(box.y) === null ? null : (box.y as number) - origin.y;
  }
  const normed = norm(out) as Obj;
  const kids = Array.isArray(n.children) ? n.children.filter(isObj) : [];
  normed.children = kids.map((c) => canonNode(c, origin));
  return normed;
}

/** The canonical JSON string of one frame's tree (exported for tests). */
export function canonicalFrame(doc: Obj): string {
  const box = isObj(doc.absoluteBoundingBox) ? doc.absoluteBoundingBox : null;
  const origin = { x: typeof box?.x === 'number' ? box.x : 0, y: typeof box?.y === 'number' ? box.y : 0 };
  return JSON.stringify(canonNode(doc, origin));
}

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function overallDigest(frames: FrameDigest[]): string {
  return sha16(frames.map((f) => `${f.id}:${f.digest}`).join('\n'));
}

export type FingerprintFramesResult =
  | { ok: true; digest: string; frames: FrameDigest[] }
  | { ok: false; reason: 'frame-missing'; missing: string[] };

/** Digest the frames, in the order of `frameIds`, from a REST nodes response. Pure; never throws for a missing frame. */
export function fingerprintFrames(response: unknown, frameIds: string[]): FingerprintFramesResult {
  const nodes = isObj(response) && isObj(response.nodes) ? response.nodes : {};
  const missing: string[] = [];
  const frames: FrameDigest[] = [];
  for (const id of frameIds) {
    const entry = nodes[id];
    const doc = isObj(entry) && isObj(entry.document) ? entry.document : null;
    if (!doc) { missing.push(id); continue; }
    frames.push({ id, digest: sha16(canonicalFrame(doc)) });
  }
  if (missing.length || frames.length === 0) return { ok: false, reason: 'frame-missing', missing: missing.length ? missing : frameIds };
  return { ok: true, digest: overallDigest(frames), frames };
}

export type FingerprintFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** ONE REST GET for the frames' nodes -> a taken record, or a typed not-taken record. Never throws. */
export async function takeFingerprint(opts: {
  fileKey: string;
  frameIds: string[];
  token: string | undefined | null;
  acceptedAt: string;
  now?: () => Date;
  fetcher?: FingerprintFetch;
}): Promise<TakeResult> {
  const taken_at = (opts.now ?? (() => new Date()))().toISOString();
  const notTaken = (reason: NotTakenReason): TakeResult => ({
    status: 'not-taken',
    record: { schema_version: 1, algorithm: FINGERPRINT_ALGORITHM, accepted_at: opts.acceptedAt, taken_at, status: 'not-taken', reason },
  });
  const res = await fetchNodes(opts);
  if (!res.ok) return notTaken(res.reason);
  const fp = fingerprintFrames(res.body, opts.frameIds);
  if (!fp.ok) return notTaken('frame-missing');
  return {
    status: 'taken',
    record: {
      schema_version: 1, algorithm: FINGERPRINT_ALGORITHM, digest: fp.digest, frames: fp.frames,
      accepted_at: opts.acceptedAt, taken_at, status: 'taken',
    },
  };
}

/** Shared by take and compare: fetch the live nodes. Failure carries only a reason. */
export async function fetchNodes(opts: {
  fileKey: string;
  frameIds: string[];
  token: string | undefined | null;
  fetcher?: FingerprintFetch;
}): Promise<{ ok: true; body: unknown } | { ok: false; reason: NotTakenReason }> {
  if (!opts.token) return { ok: false, reason: 'no-token' };
  if (!/^[a-zA-Z0-9]+$/.test(opts.fileKey) || opts.frameIds.length === 0) return { ok: false, reason: 'frame-missing' };
  const fetcher: FingerprintFetch = opts.fetcher ?? ((url, init) => fetch(url, init));
  const url = `https://api.figma.com/v1/files/${opts.fileKey}/nodes?ids=${encodeURIComponent(opts.frameIds.join(','))}`;
  try {
    const r = await fetcher(url, { method: 'GET', headers: { 'X-Figma-Token': opts.token }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      if (r.status === 429) return { ok: false, reason: 'rate-limited' };
      if (r.status === 401 || r.status === 403) return { ok: false, reason: 'unauthorized' };
      if (r.status === 404) return { ok: false, reason: 'frame-missing' };
      return { ok: false, reason: 'http-error' };
    }
    try { return { ok: true, body: await r.json() }; } catch { return { ok: false, reason: 'http-error' }; }
  } catch {
    return { ok: false, reason: 'figma-unreachable' };
  }
}

export interface FingerprintComparison {
  status: 'unchanged' | 'changed';
  changed_frame_ids: string[];
  added_frame_ids: string[];
  removed_frame_ids: string[];
  /** Same frames, different order. */
  reordered: boolean;
}

/** Compare a stored taken record's frames with freshly computed ones. A different frame set or order is a change. */
export function compareFingerprint(
  stored: { frames: FrameDigest[] },
  fresh: { frames: FrameDigest[] },
): FingerprintComparison {
  const s = new Map(stored.frames.map((f) => [f.id, f.digest]));
  const f = new Map(fresh.frames.map((x) => [x.id, x.digest]));
  const changed_frame_ids = stored.frames.filter((x) => f.has(x.id) && f.get(x.id) !== x.digest).map((x) => x.id);
  const added_frame_ids = fresh.frames.filter((x) => !s.has(x.id)).map((x) => x.id);
  const removed_frame_ids = stored.frames.filter((x) => !f.has(x.id)).map((x) => x.id);
  const common = (frames: FrameDigest[], other: Map<string, string>) => frames.filter((x) => other.has(x.id)).map((x) => x.id).join('|');
  const reordered = common(stored.frames, f) !== common(fresh.frames, s);
  const changed = changed_frame_ids.length > 0 || added_frame_ids.length > 0 || removed_frame_ids.length > 0 || reordered;
  return { status: changed ? 'changed' : 'unchanged', changed_frame_ids, added_frame_ids, removed_frame_ids, reordered };
}
