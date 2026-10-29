// B-1320 — adopt a designer's library-built Figma frames as the ticket's design, instead of recomposing options.
// PURE / INJECTABLE: every port (node reads, the saved library map, the ambiguous-name candidates, sleep) is
// handed in, so the unit tests need no network. Frames are read over Figma REST (header X-Figma-Token), never
// through the hosted Figma tool server, so a fully adopted design spends 0 MCP composition calls. Nothing here
// writes to Figma.
//
// B-1338: library membership is decided against the WORKSPACE'S SAVED LIBRARY MAP (figma_launch_context's
// library_components, version 2) plus the stored ambiguous-name candidates (figma_library_candidates), never a
// Figma component lookup (GET /v1/components/<key> answers 403 to the workspace token). Each instance's
// componentId is resolved through the node response's `components` map to a component key; the key must be one
// of the map's values, or (for a standalone component) one of the candidates stored for its bare name. A name
// that matches the library while the key does not was drawn from another copy of the kit: off-library. A frame
// is adopted only when EVERY instance is library. A missing, empty, out-of-date (version < 2) or errored map
// yields `not-checked` for every frame, which is never adopted.
import {
  FigmaRestError, assemblePendingArtefact,
  type FigmaComponentMeta, type FigmaComponentSetMeta, type FigmaNode, type FigmaNodesResponse,
} from './figma-reconcile.js';
import { nextThrottleDelay, type ProvenanceNote } from './figma-composition.js';
import { SET_SEPARATOR } from './figma-library-map.js';

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

/** The saved library map, indexed for membership checks. Built from figma_launch_context by buildLibraryIndex. */
export type LibraryIndex =
  | { status: 'ok'; fileKey: string; keys: Set<string>; names: Map<string, string>; refreshedAt: string | null }
  | { status: 'unavailable'; reason: string };

/** The figma_launch_context fields the check reads (everything optional: the RPC is parsed defensively). */
export interface LibraryContext {
  state?: unknown;
  library_file_key?: unknown;
  library_components?: unknown;
  library_map_version?: unknown;
  library_map_error?: unknown;
  library_refreshed_at?: unknown;
}

/** The current saved-map shape (set-qualified variant names, B-1321). An older map is not trusted. */
export const CURRENT_LIBRARY_MAP_VERSION = 2;

const REFRESH = 'refresh the map and run again';

export function buildLibraryIndex(ctx: LibraryContext | null | undefined): LibraryIndex {
  if (!ctx || ctx.state === 'disconnected' || typeof ctx.library_file_key !== 'string' || !ctx.library_file_key) {
    return { status: 'unavailable', reason: 'Not checked: Figma is not connected for this workspace (no library file)' };
  }
  if (typeof ctx.library_map_error === 'string' && ctx.library_map_error.trim()) {
    return { status: 'unavailable', reason: `Not checked: the workspace's saved library map failed its last refresh (${ctx.library_map_error.trim()}); ${REFRESH}` };
  }
  const raw = ctx.library_components;
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    : [];
  if (entries.length === 0) {
    return { status: 'unavailable', reason: `Not checked: the workspace's saved library map is ${raw ? 'empty' : 'missing'}; ${REFRESH}` };
  }
  const version = typeof ctx.library_map_version === 'number' ? ctx.library_map_version : null;
  if (version === null || version < CURRENT_LIBRARY_MAP_VERSION) {
    return { status: 'unavailable', reason: `Not checked: the workspace's saved library map is out of date (map version ${version ?? 'unknown'}); ${REFRESH}` };
  }
  return {
    status: 'ok',
    fileKey: ctx.library_file_key,
    keys: new Set(entries.map(([, k]) => k)),
    names: new Map(entries),
    refreshedAt: typeof ctx.library_refreshed_at === 'string' && ctx.library_refreshed_at ? ctx.library_refreshed_at : null,
  };
}

/** The component keys stored for one ambiguous bare name (figma_library_candidates). Throws when unreadable. */
export type ReadCandidates = (name: string) => Promise<string[]>;

export type InstanceVerdictKind = 'library' | 'off-library' | 'not-checked';
export interface InstanceVerdict {
  nodeId: string;
  name: string;
  /** The library-map spelling: `"<Set> :: <Variant>"` for a set variant, else the bare component name. */
  component: string;
  verdict: InstanceVerdictKind;
  reason: string;
}

export type MembershipVerdict = 'library' | 'off-library' | 'not-checked';
export interface FrameMembership { frameId: string; verdict: MembershipVerdict; reason: string; instance_count: number; instances: InstanceVerdict[] }

export interface MembershipFrame {
  id: string;
  instances: InstanceRef[];
  components: Record<string, FigmaComponentMeta>;
  componentSets?: Record<string, FigmaComponentSetMeta>;
}

/** The library-map spelling of a component, and whether it is a standalone (no named set). */
export function qualifiedComponentName(meta: FigmaComponentMeta, sets: Record<string, FigmaComponentSetMeta> | undefined, fallback: string): { name: string; standalone: boolean } {
  const bare = meta.name ?? fallback;
  const setName = meta.componentSetId ? sets?.[meta.componentSetId]?.name : undefined;
  return setName ? { name: `${setName}${SET_SEPARATOR}${bare}`, standalone: false } : { name: bare, standalone: true };
}

/**
 * Decide, frame by frame and instance by instance, whether every instance is a component of the workspace
 * library: its key is in the saved map, or (standalone only) among the candidates stored for its bare name.
 * Candidate reads are cached per name for the run. An unreadable candidate list leaves the instance (and so the
 * frame) `not-checked`; a frame that also holds a definite off-library instance is off-library.
 */
export async function checkLibraryMembership(opts: {
  frames: MembershipFrame[];
  library: LibraryIndex;
  candidates: ReadCandidates;
}): Promise<{ frames: FrameMembership[]; candidateReads: number }> {
  if (opts.library.status !== 'ok') {
    const reason = opts.library.reason;
    return {
      frames: opts.frames.map((f) => ({ frameId: f.id, verdict: 'not-checked', reason, instance_count: f.instances.length, instances: [] })),
      candidateReads: 0,
    };
  }
  const lib: Extract<LibraryIndex, { status: 'ok' }> = opts.library;
  const cache = new Map<string, string[]>();
  let reads = 0;
  async function candidatesFor(name: string): Promise<string[]> {
    const hit = cache.get(name);
    if (hit) return hit;
    reads++;
    const keys = await opts.candidates(name);
    cache.set(name, keys);
    return keys;
  }
  const refreshed = lib.refreshedAt ? lib.refreshedAt.slice(0, 10) : 'at an unknown date';

  async function judge(inst: InstanceRef, f: MembershipFrame): Promise<InstanceVerdict> {
    const meta = inst.componentId ? f.components[inst.componentId] : undefined;
    const base = { nodeId: inst.nodeId, name: inst.name };
    if (!inst.componentId || !meta || !meta.key) {
      return { ...base, component: meta?.name ?? inst.name, verdict: 'off-library', reason: `"${inst.name}" is not a published component (no component key in the file's component map)` };
    }
    const q = qualifiedComponentName(meta, f.componentSets, inst.name);
    const v = (verdict: InstanceVerdictKind, reason: string): InstanceVerdict => ({ ...base, component: q.name, verdict, reason });
    if (meta.remote === false) return v('off-library', `'${q.name}' is a local component of the designer's file, not a library component`);
    if (lib.keys.has(meta.key)) return v('library', `'${q.name}' is in the workspace's saved library map`);
    let candidateKeys: string[] = [];
    if (q.standalone) {
      try {
        candidateKeys = await candidatesFor(q.name);
      } catch (err) {
        return v('not-checked', `the library candidates for '${q.name}' could not be read (${err instanceof Error ? err.message : String(err)})`);
      }
      if (candidateKeys.includes(meta.key)) return v('library', `'${q.name}' is one of the workspace library's components of that name`);
    }
    if (lib.names.has(q.name) || candidateKeys.length > 0) {
      return v('off-library', `drawn from another copy of the library: '${q.name}' matches the workspace library by name but not by component key`);
    }
    return v('off-library', `'${q.name}' is not in the workspace's saved library map (refreshed ${refreshed}); if it was added to the library since, refresh the map`);
  }

  const out: FrameMembership[] = [];
  for (const f of opts.frames) {
    const base = { frameId: f.id, instance_count: f.instances.length };
    if (f.instances.length === 0) {
      out.push({ ...base, verdict: 'off-library', reason: 'Off-library: it holds no library component instances', instances: [] });
      continue;
    }
    const instances: InstanceVerdict[] = [];
    for (const inst of f.instances) instances.push(await judge(inst, f));
    const off = instances.find((i) => i.verdict === 'off-library');
    const unchecked = instances.find((i) => i.verdict === 'not-checked');
    if (off) out.push({ ...base, verdict: 'off-library', reason: `Off-library: ${off.reason}`, instances });
    else if (unchecked) out.push({ ...base, verdict: 'not-checked', reason: `Not checked: ${unchecked.reason}; not adopting on partial evidence`, instances });
    else out.push({ ...base, verdict: 'library', reason: `Every one of its ${f.instances.length} component instance(s) is in the workspace library`, instances });
  }
  return { frames: out, candidateReads: reads };
}

// ——— 5. verdicts —————————————————————————————————————————————————————————————————————————————

export type AdoptVerdict = 'adopted' | 'off-library' | 'unreadable' | 'not-checked';

export interface FrameVerdict {
  id: string | null;
  name: string | null;
  fileKey: string;
  verdict: AdoptVerdict;
  reason: string;
  instance_count: number;
  instances: InstanceVerdict[];
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
  library: LibraryIndex;
  readNodes: ReadNodes;
  candidates: ReadCandidates;
  sleep?: Sleep;
}): Promise<{ frames: FrameVerdict[]; candidateReads: number }> {
  const sleep = opts.sleep ?? realSleep;
  type Slot = { kind: 'verdict'; v: FrameVerdict } | { kind: 'frame'; fileKey: string; node: FigmaNode; components: Record<string, FigmaComponentMeta>; componentSets: Record<string, FigmaComponentSetMeta> };
  const slots: Slot[] = [];
  const fail = (fileKey: string, id: string | null, verdict: AdoptVerdict, reason: string): Slot =>
    ({ kind: 'verdict', v: { id, name: null, fileKey, verdict, reason, instance_count: 0, instances: [] } });

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
    const componentSets = entry.componentSets ?? {};
    if (doc.type === 'CANVAS') {
      const frames = (doc.children ?? []).filter((c) => c.type === 'FRAME');
      if (frames.length === 0) slots.push(fail(l.fileKey, l.nodeId, 'unreadable', 'Unreadable: the page holds no top-level frames'));
      for (const c of frames) slots.push({ kind: 'frame', fileKey: l.fileKey, node: c, components, componentSets });
    } else if (doc.type !== undefined && FRAME_TYPES.has(doc.type)) {
      slots.push({ kind: 'frame', fileKey: l.fileKey, node: doc, components, componentSets });
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
    frames: toCheck.map((s) => ({ id: `${s.fileKey}|${s.node.id}`, instances: collectInstances(s.node), components: s.components, componentSets: s.componentSets })),
    library: opts.library,
    candidates: opts.candidates,
  });
  const byKey = new Map(membership.frames.map((m) => [m.frameId, m]));

  const frames = unique.map((s): FrameVerdict => {
    if (s.kind === 'verdict') return s.v;
    const m = byKey.get(`${s.fileKey}|${s.node.id}`)!;
    return {
      id: s.node.id, name: s.node.name ?? s.node.id, fileKey: s.fileKey,
      verdict: m.verdict === 'library' ? 'adopted' : m.verdict,
      reason: m.reason, instance_count: m.instance_count, instances: m.instances,
    };
  });
  return { frames, candidateReads: membership.candidateReads };
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
