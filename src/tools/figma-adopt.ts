// B-1320 — adopt a designer's library-built Figma frames as the ticket's design, instead of recomposing options.
// PURE / INJECTABLE: every network port (node reads, component-key lookups, sleep) is handed in, so the unit
// tests need no network. Everything is read over Figma REST (header X-Figma-Token), never through the hosted
// Figma tool server, so a fully adopted design spends 0 MCP composition calls. Nothing here writes to Figma.
//
// "Library-built" is decided against the component's PUBLISHED file, not the saved component map (which matched
// only 1 of 4 real library components, B-1321's finding): each instance's componentId is resolved through the
// node response's `components` map to a component key, and GET /v1/components/<key> says which file owns it.
// A frame is adopted only when EVERY instance resolves to the workspace library file. Partial evidence (lookup
// cap reached, backoff exhausted, lookup failed) yields `not-checked`, which is never adopted.
import {
  FigmaRestError, FIGMA_API_BASE, assemblePendingArtefact,
  type FetchLike, type FigmaComponentMeta, type FigmaNode, type FigmaNodesResponse,
} from './figma-reconcile.js';
import { nextThrottleDelay, type ProvenanceNote } from './figma-composition.js';

// ——— 1. links ————————————————————————————————————————————————————————————————————————————————

export interface FigmaLink {
  /** The file key; for a branch URL, the BRANCH key (that is the file to read). */
  fileKey: string;
  /** `1:2` form, or null when the link names no (readable) frame. */
  nodeId: string | null;
  url: string;
}

const LINK_RE = /https?:\/\/(?:www\.)?figma\.com\/(design|file)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?[^\s<>"'`)\]]*/gi;

function parseNodeId(url: string): string | null {
  const m = /[?&]node-id=([^&#\s]+)/i.exec(url);
  if (!m) return null;
  let raw = m[1];
  try { raw = decodeURIComponent(raw); } catch { return null; }
  const id = raw.replace(/-/g, ':');
  return /^\d+:\d+$/.test(id) ? id : null;
}

/**
 * Figma design links in the given texts (ticket description, comments). /board/, /slides/ and /make/ links are
 * ignored. De-duplicated on (fileKey, nodeId), in order of first appearance. A link without a node id is
 * returned with nodeId null so a caller can say "names no frame"; it never guesses a frame.
 */
export function findFigmaLinks(texts: string[]): FigmaLink[] {
  const out: FigmaLink[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(LINK_RE)) {
      const url = m[0].replace(/[.,;:!]+$/, '');
      const fileKey = m[3] ?? m[2];
      const nodeId = parseNodeId(url);
      const k = `${fileKey}|${nodeId ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ fileKey, nodeId, url });
    }
  }
  return out;
}

// ——— 2. instances ————————————————————————————————————————————————————————————————————————————

export interface InstanceRef { nodeId: string; name: string; componentId: string | null }

/** Every INSTANCE node in the tree, the root included, in document order. */
export function collectInstances(frame: FigmaNode): InstanceRef[] {
  const out: InstanceRef[] = [];
  const walk = (n: FigmaNode): void => {
    if (n.type === 'INSTANCE') out.push({ nodeId: n.id, name: n.name ?? n.id, componentId: n.componentId ?? null });
    for (const c of n.children ?? []) walk(c);
  };
  walk(frame);
  return out;
}

// ——— 3. throttled calls ——————————————————————————————————————————————————————————————————————

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

type Attempt<T> =
  | { ok: true; value: T; requests: number }
  | { ok: false; kind: 'backoff-exhausted' | 'error'; error: unknown; requests: number };

/** Run a REST call, backing off on 429 with the shared helper. Counts every request issued. */
async function withBackoff<T>(call: () => Promise<T>, sleep: Sleep): Promise<Attempt<T>> {
  let requests = 0;
  for (let attempt = 1; ; attempt++) {
    requests++;
    try {
      return { ok: true, value: await call(), requests };
    } catch (err) {
      if (!(err instanceof FigmaRestError) || err.code !== 'rate-limited') return { ok: false, kind: 'error', error: err, requests };
      const next = nextThrottleDelay({ attempt, retryAfterSeconds: err.retryAfterSeconds ?? undefined });
      if (!next.retry) return { ok: false, kind: 'backoff-exhausted', error: err, requests };
      await sleep(next.delayMs);
    }
  }
}

// ——— 4. library membership ———————————————————————————————————————————————————————————————————

/** Per-leg ceiling on component-key lookups (each request issued counts, retries included). */
export const DEFAULT_LOOKUP_CAP = 40;

/** Resolve a component key to the file that publishes it. Throws FigmaRestError on failure (429 => 'rate-limited'). */
export type LookupComponentFile = (key: string) => Promise<{ fileKey: string }>;

export function createComponentLookup(opts: { token: string; fetch: FetchLike; baseUrl?: string }): LookupComponentFile {
  const base = (opts.baseUrl ?? FIGMA_API_BASE).replace(/\/+$/, '');
  return async (key) => {
    const path = `/v1/components/${encodeURIComponent(key)}`;
    const res = await opts.fetch(`${base}${path}`, { method: 'GET', headers: { 'X-Figma-Token': opts.token } });
    if (res.ok) {
      const body = (await res.json()) as { meta?: { file_key?: unknown } };
      const fk = body?.meta?.file_key;
      if (typeof fk !== 'string' || !fk) throw new FigmaRestError('http-error', 'Figma returned no file_key for the component.', res.status);
      return { fileKey: fk };
    }
    if (res.status === 429) {
      const raw = res.headers.get('retry-after');
      const secs = raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
      throw new FigmaRestError('rate-limited', 'Figma rate-limited the component lookup (429).', 429, secs);
    }
    if (res.status === 404) throw new FigmaRestError('file-not-found', 'Figma has no published component for that key (404).', 404);
    if (res.status === 401 || res.status === 403) throw new FigmaRestError('unauthorized', `Figma refused the token (${res.status}).`, res.status);
    throw new FigmaRestError('http-error', `Figma returned HTTP ${res.status} for ${path}.`, res.status);
  };
}

export type MembershipVerdict = 'library' | 'off-library' | 'not-checked';
export interface FrameMembership { frameId: string; verdict: MembershipVerdict; reason: string; instances: number; lookups: number }

export interface MembershipFrame { id: string; instances: InstanceRef[]; components: Record<string, FigmaComponentMeta> }

type KeyResult = { kind: 'file'; fileKey: string } | { kind: 'unresolved'; reason: string };

/**
 * Decide, frame by frame, whether every instance belongs to the library file. Each DISTINCT component key is
 * looked up once (shared across frames). A reached cap or an exhausted backoff leaves the affected frames
 * `not-checked`; they are never judged on partial evidence. A frame that already holds a definite off-library
 * instance is off-library whatever else is unchecked.
 */
export async function checkLibraryMembership(opts: {
  frames: MembershipFrame[];
  libraryFileKey: string;
  lookupComponentFile: LookupComponentFile;
  cap?: number;
  sleep?: Sleep;
}): Promise<{ frames: FrameMembership[]; lookupsUsed: number; lookupCap: number }> {
  const cap = opts.cap ?? DEFAULT_LOOKUP_CAP;
  const sleep = opts.sleep ?? realSleep;
  const cache = new Map<string, KeyResult>();
  let used = 0;
  let halted: string | null = null; // set once backoff is exhausted: later keys are not attempted

  async function resolveKey(key: string): Promise<{ result: KeyResult; requests: number }> {
    const hit = cache.get(key);
    if (hit) return { result: hit, requests: 0 };
    if (halted) return { result: { kind: 'unresolved', reason: halted }, requests: 0 };
    if (used >= cap) return { result: { kind: 'unresolved', reason: `the lookup cap of ${cap} was reached` }, requests: 0 };
    const a = await withBackoff(() => opts.lookupComponentFile(key), sleep);
    used += a.requests;
    let result: KeyResult;
    if (a.ok) result = { kind: 'file', fileKey: a.value.fileKey };
    else if (a.kind === 'backoff-exhausted') {
      halted = 'Figma kept rate-limiting the component lookups';
      result = { kind: 'unresolved', reason: halted };
    } else {
      const msg = a.error instanceof Error ? a.error.message : String(a.error);
      result = { kind: 'unresolved', reason: `the component lookup failed (${msg})` };
    }
    // Only a definite answer is cached; a transient failure may be retried by a later frame within the cap.
    if (result.kind === 'file' || (a.ok === false && a.kind === 'error' && a.error instanceof FigmaRestError && a.error.status === 404)) cache.set(key, result);
    return { result, requests: a.requests };
  }

  const out: FrameMembership[] = [];
  for (const f of opts.frames) {
    const base = { frameId: f.id, instances: f.instances.length };
    let lookups = 0;
    if (f.instances.length === 0) {
      out.push({ ...base, verdict: 'off-library', reason: 'it holds no library component instances', lookups });
      continue;
    }
    // Pass 1: structural verdicts that need no lookup.
    let offReason: string | null = null;
    const keys: Array<{ key: string; name: string }> = [];
    for (const inst of f.instances) {
      const meta = inst.componentId ? f.components[inst.componentId] : undefined;
      if (!inst.componentId || !meta) { offReason = `"${inst.name}" is not a published component (no entry in the file's component map)`; break; }
      if (meta.remote === false) { offReason = `"${inst.name}" is a local component of the designer's file, not a library component`; break; }
      if (!meta.key) { offReason = `"${inst.name}" has no component key`; break; }
      keys.push({ key: meta.key, name: meta.name ?? inst.name });
    }
    if (offReason) { out.push({ ...base, verdict: 'off-library', reason: `Off-library: ${offReason}`, lookups }); continue; }

    // Pass 2: distinct keys, looked up once.
    let unresolved: string | null = null;
    let wrongFile: string | null = null;
    for (const { key, name } of [...new Map(keys.map((k) => [k.key, k])).values()]) {
      const r = await resolveKey(key);
      lookups += r.requests;
      if (r.result.kind === 'unresolved') { unresolved ??= r.result.reason; continue; }
      if (r.result.fileKey !== opts.libraryFileKey) { wrongFile = `"${name}" comes from another file (${r.result.fileKey}), not the workspace library`; break; }
    }
    if (wrongFile) out.push({ ...base, verdict: 'off-library', reason: `Off-library: ${wrongFile}`, lookups });
    else if (unresolved) out.push({ ...base, verdict: 'not-checked', reason: `Not checked: ${unresolved}; not adopting on partial evidence`, lookups });
    else out.push({ ...base, verdict: 'library', reason: `Every one of its ${f.instances.length} component instance(s) comes from the workspace library`, lookups });
  }
  return { frames: out, lookupsUsed: used, lookupCap: cap };
}

// ——— 5. verdicts —————————————————————————————————————————————————————————————————————————————

export type AdoptVerdict = 'adopted' | 'off-library' | 'unreadable' | 'not-checked';

export interface FrameVerdict {
  id: string | null;
  name: string | null;
  fileKey: string;
  verdict: AdoptVerdict;
  reason: string;
  instances: number;
  lookups: number;
}

export type ReadNodes = (fileKey: string, ids: string[]) => Promise<FigmaNodesResponse>;

const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'INSTANCE']);

function readFailure(a: Extract<Attempt<unknown>, { ok: false }>): { verdict: AdoptVerdict; reason: string } {
  const e = a.error;
  if (a.kind === 'backoff-exhausted') return { verdict: 'not-checked', reason: 'Not checked: Figma kept rate-limiting the read' };
  if (e instanceof FigmaRestError) {
    if (e.code === 'unauthorized') return { verdict: 'unreadable', reason: `Unreadable: Figma refused the token for this file (${e.status})` };
    if (e.code === 'file-not-found' || e.code === 'version-not-found') return { verdict: 'unreadable', reason: 'Unreadable: the file was not found or the token cannot see it (404)' };
    return { verdict: 'not-checked', reason: `Not checked: ${e.message}` };
  }
  return { verdict: 'not-checked', reason: `Not checked: ${e instanceof Error ? e.message : String(e)}` };
}

/**
 * Link list -> one verdict per frame. A PAGE link expands to the page's top-level FRAME children in page order;
 * a FRAME/COMPONENT/SECTION/INSTANCE node is itself the frame. A frame reached twice is judged once. Whether a
 * library-built frame actually COVERS the decision is the agent's call in the skill, not code's.
 */
export async function classifyFrames(opts: {
  links: FigmaLink[];
  libraryFileKey: string;
  readNodes: ReadNodes;
  lookupComponentFile: LookupComponentFile;
  cap?: number;
  sleep?: Sleep;
}): Promise<{ frames: FrameVerdict[]; lookupsUsed: number; lookupCap: number }> {
  const sleep = opts.sleep ?? realSleep;
  type Slot = { kind: 'verdict'; v: FrameVerdict } | { kind: 'frame'; fileKey: string; node: FigmaNode; components: Record<string, FigmaComponentMeta> };
  const slots: Slot[] = [];
  const fail = (fileKey: string, id: string | null, verdict: AdoptVerdict, reason: string): Slot =>
    ({ kind: 'verdict', v: { id, name: null, fileKey, verdict, reason, instances: 0, lookups: 0 } });

  // One read per file, with every node id that file's links name.
  const idsByFile = new Map<string, string[]>();
  for (const l of opts.links) if (l.nodeId) idsByFile.set(l.fileKey, [...new Set([...(idsByFile.get(l.fileKey) ?? []), l.nodeId])]);
  const reads = new Map<string, Attempt<FigmaNodesResponse>>();
  for (const [fileKey, ids] of idsByFile) reads.set(fileKey, await withBackoff(() => opts.readNodes(fileKey, ids), sleep));

  for (const l of opts.links) {
    if (!l.nodeId) { slots.push(fail(l.fileKey, null, 'unreadable', 'Unreadable: the link names no frame (no node-id), so no frame is guessed')); continue; }
    const read = reads.get(l.fileKey)!;
    if (!read.ok) { const f = readFailure(read); slots.push(fail(l.fileKey, l.nodeId, f.verdict, f.reason)); continue; }
    const entry = read.value.nodes?.[l.nodeId];
    if (!entry?.document) { slots.push(fail(l.fileKey, l.nodeId, 'unreadable', 'Unreadable: the node is absent from the file (deleted, or the link is stale)')); continue; }
    const doc = entry.document;
    const components = entry.components ?? {};
    if (doc.type === 'CANVAS') {
      const frames = (doc.children ?? []).filter((c) => c.type === 'FRAME');
      if (frames.length === 0) slots.push(fail(l.fileKey, l.nodeId, 'unreadable', 'Unreadable: the page holds no top-level frames'));
      for (const c of frames) slots.push({ kind: 'frame', fileKey: l.fileKey, node: c, components });
    } else if (doc.type !== undefined && FRAME_TYPES.has(doc.type)) {
      slots.push({ kind: 'frame', fileKey: l.fileKey, node: doc, components });
    } else {
      slots.push(fail(l.fileKey, l.nodeId, 'unreadable', `Unreadable: the node is a ${doc.type ?? 'unknown node'}, not a frame`));
    }
  }

  // De-duplicate frames reached twice (a page link plus a frame link), keeping first appearance.
  const seen = new Set<string>();
  const unique = slots.filter((s) => {
    if (s.kind !== 'frame') return true;
    const k = `${s.fileKey}|${s.node.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const toCheck = unique.filter((s): s is Extract<Slot, { kind: 'frame' }> => s.kind === 'frame');
  const membership = await checkLibraryMembership({
    frames: toCheck.map((s) => ({ id: `${s.fileKey}|${s.node.id}`, instances: collectInstances(s.node), components: s.components })),
    libraryFileKey: opts.libraryFileKey,
    lookupComponentFile: opts.lookupComponentFile,
    cap: opts.cap,
    sleep,
  });
  const byKey = new Map(membership.frames.map((m) => [m.frameId, m]));

  const frames = unique.map((s): FrameVerdict => {
    if (s.kind === 'verdict') return s.v;
    const m = byKey.get(`${s.fileKey}|${s.node.id}`)!;
    return {
      id: s.node.id, name: s.node.name ?? s.node.id, fileKey: s.fileKey,
      verdict: m.verdict === 'library' ? 'adopted' : m.verdict,
      reason: m.reason, instances: m.instances, lookups: m.lookups,
    };
  });
  return { frames, lookupsUsed: membership.lookupsUsed, lookupCap: membership.lookupCap };
}

// ——— 6. the adopted artefact —————————————————————————————————————————————————————————————————

/**
 * The design_artefact for adopted frames: tool 'figma', nodes in the given order, every node marked
 * 'human-in-tool' (the designer drew it), mcp_call_count 0, and NO version_id (B-1203: previews come from the
 * live file; the content fingerprint is taken at accept). Delegates to assemblePendingArtefact so the result is
 * parsed with DesignArtefactSchema. The frames must all belong to `fileKey`.
 */
export function assembleAdoptedArtefact(input: {
  fileKey: string;
  fileUrl?: string;
  frames: Array<{ id: string; name: string; caption: string }>;
  nodes: FigmaNodesResponse['nodes'];
  images: Record<string, { bytes: Uint8Array | null } | undefined>;
  attachments: Record<string, { attachment_id: string; filename: string } | undefined>;
  composedAt: string;
}): ReturnType<typeof assemblePendingArtefact> {
  const notes: ProvenanceNote[] = input.frames.map((f) => ({
    element: f.id, provenance: 'human-in-tool', note: `Drawn by the designer in Figma and adopted as drawn: ${f.name}`,
  }));
  return assemblePendingArtefact({
    fileKey: input.fileKey,
    fileUrl: input.fileUrl ?? `https://www.figma.com/design/${input.fileKey}`,
    frames: input.frames,
    nodesAtVersion: input.nodes,
    images: input.images,
    attachments: input.attachments,
    composedAt: input.composedAt,
    provenanceNotes: notes,
    mcpCallCount: 0,
  });
}
