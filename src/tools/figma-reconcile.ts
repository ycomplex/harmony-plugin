// B-1204 — reconcile a designer's Figma edits back into the design brief. "I've made edits in Figma" is the
// fourth verb on a design brief; this module is the read-back half. PURE / INJECTABLE: the only I/O is the
// `fetch` handed to createFigmaRestClient, so every path is testable with hand-authored responses.
//
// REST ONLY. The read-back uses Figma's REST API (header X-Figma-Token) at EXPLICIT versions and makes ZERO
// calls through the hosted Figma tool server: its call budget and limiter (B-1201) belong to composing, not to reading.
// A 429 is a typed rate-limited error carrying retry-after; there is NO retry loop here and NO fallback to
// another transport. This module NEVER edits the Figma file: every request below is a GET.
//
// SPLIT OF OWNERSHIP: the stored record is B-1202's `design_artefact` (schema_version 1). This module builds
// the pending value (assemblePendingArtefact) but does not validate it against B-1202's validator, detect
// B-1202's capability, or write the recomposed brief; the caller passes `capabilityPresent` explicitly.
import {
  FRESHNESS_WAIT,
  waitForVersionAfter,
  type FigmaVersion,
  type ProvenanceNote,
} from './figma-composition.js';

// ——— (a) REST client ——————————————————————————————————————————————————————————————————————————

export type FigmaRestErrorCode = 'version-not-found' | 'file-not-found' | 'rate-limited' | 'unauthorized' | 'http-error';

/** A typed REST failure. `version-not-found` is NEVER to be read as "no change": a missing version is a 404. */
export class FigmaRestError extends Error {
  constructor(
    readonly code: FigmaRestErrorCode,
    message: string,
    readonly status: number,
    /** 429 only: seconds from the Retry-After header, or null when absent/unparseable. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'FigmaRestError';
  }
}

/** The slice of the fetch API the client uses (a global `fetch` is assignable). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface FigmaFileMeta {
  /** ISO time of the file's last modification, or null when the response does not carry it. */
  lastModified: string | null;
  /** The file's current version id, or null. */
  version: string | null;
  name: string | null;
}

/** One entry of GET /v1/images: node id -> render URL, or null when the frame is absent at that version. */
export type ImageUrls = Record<string, string | null>;

export interface FigmaNodesResponse {
  nodes: Record<string, { document: FigmaNode } | null>;
}

export interface FigmaRestClient {
  fileMeta(): Promise<FigmaFileMeta>;
  listVersions(): Promise<FigmaVersion[]>;
  getNodesAtVersion(ids: string[], versionId: string, opts?: { depth?: number }): Promise<FigmaNodesResponse>;
  renderImagesAtVersion(ids: string[], versionId: string): Promise<ImageUrls>;
  /** Download rendered images. null bytes = the URL was null, the download was not 2xx, or the body was empty. */
  downloadImages(urls: ImageUrls): Promise<Record<string, { bytes: Uint8Array | null }>>;
}

export const FIGMA_API_BASE = 'https://api.figma.com';

export function createFigmaRestClient(opts: {
  token: string;
  fetch: FetchLike;
  baseUrl?: string;
  fileKey: string;
}): FigmaRestClient {
  const base = (opts.baseUrl ?? FIGMA_API_BASE).replace(/\/+$/, '');
  const key = encodeURIComponent(opts.fileKey);

  async function get(path: string, versioned: boolean): Promise<unknown> {
    const res = await opts.fetch(`${base}${path}`, { method: 'GET', headers: { 'X-Figma-Token': opts.token } });
    if (res.ok) return res.json();
    if (res.status === 404) {
      throw versioned
        ? new FigmaRestError('version-not-found', `Figma returned 404 for ${path.split('?')[0]} at the requested version: the version (or file) does not exist. This is NOT "no change".`, 404)
        : new FigmaRestError('file-not-found', `Figma returned 404 for ${path.split('?')[0]}: the file was not found or the token cannot see it.`, 404);
    }
    if (res.status === 429) {
      const raw = res.headers.get('retry-after');
      const secs = raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
      throw new FigmaRestError(
        'rate-limited',
        `Figma rate-limited the read-back (429${secs !== null ? `, retry after ${secs}s` : ''}). Not retrying and not falling back to another transport; press the action again later.`,
        429,
        secs,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new FigmaRestError('unauthorized', `Figma refused the token (${res.status}); reconnect Figma in project settings.`, res.status);
    }
    throw new FigmaRestError('http-error', `Figma returned HTTP ${res.status} for ${path.split('?')[0]}.`, res.status);
  }

  return {
    async fileMeta() {
      const body = (await get(`/v1/files/${key}?depth=1`, false)) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      return { lastModified: str(body.lastModified), version: str(body.version), name: str(body.name) };
    },
    async listVersions() {
      const body = (await get(`/v1/files/${key}/versions`, false)) as { versions?: Array<{ id: string; created_at: string }> };
      return (body.versions ?? []).map((v) => ({ id: v.id, created_at: v.created_at }));
    },
    async getNodesAtVersion(ids, versionId, o) {
      const depth = o?.depth !== undefined ? `&depth=${o.depth}` : '';
      return (await get(
        `/v1/files/${key}/nodes?ids=${encodeURIComponent(ids.join(','))}&version=${encodeURIComponent(versionId)}${depth}`,
        true,
      )) as FigmaNodesResponse;
    },
    async renderImagesAtVersion(ids, versionId) {
      const body = (await get(
        `/v1/images/${key}?ids=${encodeURIComponent(ids.join(','))}&version=${encodeURIComponent(versionId)}&format=png`,
        true,
      )) as { err?: unknown; images?: ImageUrls };
      // A 200 can still carry null for a frame absent at that version: pass the nulls through untouched.
      return body.images ?? {};
    },
    async downloadImages(urls) {
      const out: Record<string, { bytes: Uint8Array | null }> = {};
      for (const [id, url] of Object.entries(urls)) {
        if (!url) { out[id] = { bytes: null }; continue; }
        // Render URLs are pre-signed: no token header, and the URL is never stored.
        const res = await opts.fetch(url, { method: 'GET' });
        if (!res.ok) { out[id] = { bytes: null }; continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        out[id] = { bytes: bytes.length > 0 ? bytes : null };
      }
      return out;
    },
  };
}

// ——— (b) choose the fresh version ———————————————————————————————————————————————————————————

export const SAVE_VERSION_QUESTION =
  'I could not find a saved Figma version that contains your latest edits. In Figma choose File > Save to version history, then press "I\'ve made edits in Figma" again.';

export type FreshVersion =
  | { ok: true; version: FigmaVersion; via: 'last-modified' | 'newest-differs-from-pinned' }
  | { ok: false; message: string; becomesQuestion: true };

/**
 * Pick the version to read the designer's edits from.
 *
 * The wait is anchored on the FILE'S last-modified time, never on the time the designer pressed the action:
 * an autosave taken before the press already contains the edit, and waiting for one created after the press
 * would hang. If last-modified is unavailable, fall back to "the newest version whose id differs from the
 * pinned one"; if there is none, return a not-ok result that becomes a question item (save a version, press
 * again). Bounded: FRESHNESS_WAIT unless overridden; injected sleep for tests.
 */
export async function chooseFreshVersion(opts: {
  client: Pick<FigmaRestClient, 'fileMeta' | 'listVersions'>;
  pinnedVersionId: string;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}): Promise<FreshVersion> {
  const meta = await opts.client.fileMeta();
  if (meta.lastModified && Number.isFinite(Date.parse(meta.lastModified))) {
    const wait = await waitForVersionAfter({
      listVersions: () => opts.client.listVersions(),
      afterIso: meta.lastModified,
      maxAttempts: opts.maxAttempts ?? FRESHNESS_WAIT.maxAttempts,
      intervalMs: opts.intervalMs ?? FRESHNESS_WAIT.intervalMs,
      sleep: opts.sleep,
    });
    if (wait.ok) return { ok: true, version: wait.version, via: 'last-modified' };
    return { ok: false, becomesQuestion: true, message: `${SAVE_VERSION_QUESTION} (No version newer than the file's last edit, ${meta.lastModified}, appeared.)` };
  }
  const versions = await opts.client.listVersions();
  const newest = [...versions].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (newest && newest.id !== opts.pinnedVersionId) return { ok: true, version: newest, via: 'newest-differs-from-pinned' };
  return { ok: false, becomesQuestion: true, message: SAVE_VERSION_QUESTION };
}

// ——— (c) snapshot + diff ————————————————————————————————————————————————————————————————————

/** The subset of a Figma node (REST file schema) that the snapshot reads. */
export interface FigmaNode {
  id: string;
  name?: string;
  type?: string;
  characters?: string;
  componentId?: string;
  componentProperties?: unknown;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: unknown;
  strokes?: unknown;
  strokeWeight?: unknown;
  effects?: unknown;
  cornerRadius?: unknown;
  opacity?: unknown;
  style?: unknown;
  children?: FigmaNode[];
}

interface NodeSnap {
  id: string;
  name: string;
  type: string;
  text: string | null;
  component: string | null;
  geometry: string | null;
  style: string | null;
}

export interface FrameSnap {
  id: string;
  name: string;
  /** Every descendant (and the frame itself), keyed by node id. */
  nodes: Record<string, NodeSnap>;
}

export interface Snapshot {
  versionId: string;
  /** Frames in document order. */
  frames: FrameSnap[];
}

const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
    : x);

function snapNode(n: FigmaNode, into: Record<string, NodeSnap>): void {
  const box = n.absoluteBoundingBox;
  into[n.id] = {
    id: n.id,
    name: n.name ?? n.id,
    type: n.type ?? 'UNKNOWN',
    text: n.type === 'TEXT' || typeof n.characters === 'string' ? (n.characters ?? '') : null,
    component: n.type === 'INSTANCE' || n.componentId ? canon({ componentId: n.componentId ?? null, props: n.componentProperties ?? null }) : null,
    geometry: box ? canon([box.x, box.y, box.width, box.height]) : null,
    style: canon({
      fills: n.fills, strokes: n.strokes, strokeWeight: n.strokeWeight, effects: n.effects,
      cornerRadius: n.cornerRadius, opacity: n.opacity, style: n.style,
    }),
  };
  for (const c of n.children ?? []) snapNode(c, into);
}

/**
 * Build a snapshot from the container node read at `versionId` (the page or section that holds the brief's
 * frames; the frames are its direct children, in document order). `only`, when given, restricts to those
 * child ids PLUS any child not in `knownIds` is still reported as added: pass nothing to see every child.
 */
export function buildSnapshot(res: FigmaNodesResponse, containerId: string, versionId: string, filter?: (n: FigmaNode) => boolean): Snapshot {
  const entry = res.nodes[containerId];
  if (!entry) throw new Error(`buildSnapshot: container ${containerId} is absent at version ${versionId}`);
  const frames = (entry.document.children ?? []).filter((c) => (filter ? filter(c) : c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'SECTION' || c.type === undefined));
  return {
    versionId,
    frames: frames.map((f) => {
      const nodes: Record<string, NodeSnap> = {};
      snapNode(f, nodes);
      return { id: f.id, name: f.name ?? f.id, nodes };
    }),
  };
}

export type ChangeKind =
  | 'frame-added' | 'frame-removed' | 'frame-reordered'
  | 'text-changed' | 'instance-swapped' | 'geometry-changed' | 'style-changed' | 'unclassified';

export interface Change {
  kind: ChangeKind;
  frameId: string;
  frameName: string;
  nodeId?: string;
  nodeName?: string;
  /** Human-readable, one line. */
  detail: string;
  /** unclassified only: a stable shape key so repeats of the same oddity collapse into one question. */
  shape?: string;
}

/** Compare two snapshots by node id. Never mutates either. */
export function diffSnapshots(base: Snapshot, fresh: Snapshot): Change[] {
  const changes: Change[] = [];
  const baseById = new Map(base.frames.map((f) => [f.id, f]));
  const freshById = new Map(fresh.frames.map((f) => [f.id, f]));

  for (const f of fresh.frames) {
    if (!baseById.has(f.id)) changes.push({ kind: 'frame-added', frameId: f.id, frameName: f.name, detail: `Frame added: "${f.name}"` });
  }
  for (const f of base.frames) {
    if (!freshById.has(f.id)) changes.push({ kind: 'frame-removed', frameId: f.id, frameName: f.name, detail: `Frame removed: "${f.name}"` });
  }

  // Order among the frames present in BOTH snapshots.
  const baseOrder = base.frames.filter((f) => freshById.has(f.id)).map((f) => f.id);
  const freshOrder = fresh.frames.filter((f) => baseById.has(f.id)).map((f) => f.id);
  if (baseOrder.join('|') !== freshOrder.join('|')) {
    for (const id of freshOrder) {
      const from = baseOrder.indexOf(id) + 1;
      const to = freshOrder.indexOf(id) + 1;
      if (from !== to) {
        const f = freshById.get(id)!;
        changes.push({ kind: 'frame-reordered', frameId: id, frameName: f.name, detail: `Frame "${f.name}" moved from position ${from} to ${to}` });
      }
    }
  }

  for (const bf of base.frames) {
    const ff = freshById.get(bf.id);
    if (!ff) continue;
    for (const [nid, bn] of Object.entries(bf.nodes)) {
      const fn = ff.nodes[nid];
      const at = { frameId: ff.id, frameName: ff.name, nodeId: nid, nodeName: fn?.name ?? bn.name };
      if (!fn) {
        changes.push({ ...at, kind: 'unclassified', shape: 'node-removed-in-frame', detail: `Layer "${bn.name}" (${bn.type}) was removed from "${ff.name}"` });
        continue;
      }
      if (bn.type !== fn.type) {
        changes.push({ ...at, kind: 'unclassified', shape: 'node-type-changed', detail: `Layer "${fn.name}" in "${ff.name}" changed type from ${bn.type} to ${fn.type}` });
        continue;
      }
      if (bn.text !== fn.text) {
        changes.push({ ...at, kind: 'text-changed', detail: `Text in "${ff.name}" / "${fn.name}" changed from ${JSON.stringify(bn.text)} to ${JSON.stringify(fn.text)}` });
      }
      if (bn.component !== fn.component) {
        changes.push({ ...at, kind: 'instance-swapped', detail: `Component instance "${fn.name}" in "${ff.name}" was swapped or had its properties overridden` });
      }
      if (bn.geometry !== fn.geometry) {
        changes.push({ ...at, kind: 'geometry-changed', detail: `"${fn.name}" in "${ff.name}" was moved or resized` });
      }
      if (bn.style !== fn.style) {
        changes.push({ ...at, kind: 'style-changed', detail: `"${fn.name}" in "${ff.name}" changed style (fill, stroke, effect, radius, opacity or type style)` });
      }
    }
    for (const [nid, fn] of Object.entries(ff.nodes)) {
      if (!bf.nodes[nid]) {
        changes.push({
          kind: 'unclassified', shape: 'node-added-in-frame', frameId: ff.id, frameName: ff.name, nodeId: nid, nodeName: fn.name,
          detail: `Layer "${fn.name}" (${fn.type}) was added to "${ff.name}"`,
        });
      }
    }
  }
  return changes;
}

// ——— (d) interpret ———————————————————————————————————————————————————————————————————————————

export interface ReconcileQuestion {
  kind: ChangeKind;
  /** How many changes this one question stands for. */
  count: number;
  text: string;
}

const ASKS: Partial<Record<ChangeKind, string>> = {
  'text-changed': 'text',
  'frame-added': 'added frame',
  'frame-removed': 'removed frame',
  'instance-swapped': 'swapped component',
};

const METHOD_QUESTION = 'is this a change to the method (the design should follow it) or illustrative only?';

/**
 * Turn changes into brief material. `lines` is the plain "What changed in Figma" block (one per change).
 * `questions` become decision items:
 *   - geometry, style and order changes are change lines ONLY;
 *   - text changes, added/removed frames and swapped instances are a line AND a question;
 *   - repeats of one kind COLLAPSE into ONE question (seven rows edited the same way = one question);
 *   - an unclassified change is a question (collapsed per shape), never dropped.
 */
export function interpret(changes: Change[]): { lines: string[]; questions: ReconcileQuestion[] } {
  const lines = changes.map((c) => c.detail);
  const questions: ReconcileQuestion[] = [];
  const group = new Map<string, Change[]>();
  for (const c of changes) {
    if (c.kind === 'geometry-changed' || c.kind === 'style-changed' || c.kind === 'frame-reordered') continue;
    const key = c.kind === 'unclassified' ? `unclassified:${c.shape ?? ''}` : c.kind;
    group.set(key, [...(group.get(key) ?? []), c]);
  }
  for (const [key, cs] of group) {
    const kind = cs[0].kind;
    const eg = cs.slice(0, 3).map((c) => (c.nodeName ? `"${c.nodeName}" in "${c.frameName}"` : `"${c.frameName}"`)).join(', ');
    const more = cs.length > 3 ? ` and ${cs.length - 3} more` : '';
    const text = kind === 'unclassified'
      ? `The designer made a change I could not classify (${cs.length === 1 ? cs[0].detail : `${cs.length} like it, ${key.slice('unclassified:'.length)}: e.g. ${eg}${more}`}). What should the design make of it, and is it a change to the method or illustrative only?`
      : cs.length === 1
        ? `The designer made a ${ASKS[kind]} change (${cs[0].detail}): ${METHOD_QUESTION}`
        : `The designer made the same kind of ${ASKS[kind]} change in ${cs.length} places (${eg}${more}): ${METHOD_QUESTION}`;
    questions.push({ kind, count: cs.length, text });
  }
  return { lines, questions };
}

/** Ids of the elements the designer changed (for markHumanInTool): the node when known, else the frame. */
export function changedElementIds(changes: Change[]): string[] {
  return [...new Set(changes.map((c) => c.nodeId ?? c.frameId))];
}

// ——— provenance —————————————————————————————————————————————————————————————————————————————

/**
 * Mark designer-changed elements 'human-in-tool'. Existing notes (the agent's own 'real' / 'invented' /
 * 'illustrative' lines) are returned UNCHANGED and in place; one new note per changed element is appended,
 * idempotently (an element already marked human-in-tool is not duplicated). `element` is the id passed in;
 * `labels` optionally supplies a readable name for the note text.
 */
export function markHumanInTool(
  notes: ProvenanceNote[],
  changedElementIds: string[],
  labels: Record<string, string> = {},
): ProvenanceNote[] {
  const out = notes.map((n) => ({ ...n }));
  const marked = new Set(out.filter((n) => n.provenance === 'human-in-tool').map((n) => n.element));
  for (const id of changedElementIds) {
    if (marked.has(id)) continue;
    marked.add(id);
    out.push({ element: id, provenance: 'human-in-tool', note: `Changed by the designer in Figma${labels[id] ? `: ${labels[id]}` : ''}` });
  }
  return out;
}

// ——— pending artefact (PARTIAL by design) ————————————————————————————————————————————————————

/** B-1202's stored record, schema_version 1 (Figma flavour). Built here, validated and written elsewhere. */
export interface PendingDesignArtefact {
  schema_version: 1;
  tool: 'figma';
  composed_at: string;
  provenance_notes: ProvenanceNote[];
  mcp_call_count: number;
  nodes: Array<{ id: string; name: string; caption: string; preview_attachment_id: string; preview_filename: string }>;
  file_key: string;
  file_url: string;
  version_id: string;
}

export const CAPABILITY_PREREQUISITE_MESSAGE =
  "Cannot record the reconciled design: the design_artefact capability (B-1202) is not live yet. B-1202's web migration must be promoted and the plugin's design_artefact validator must be live before a Figma design brief can be recomposed with previews. Nothing was written.";

export type AssembleResult =
  | { ok: true; artefact: PendingDesignArtefact }
  | { ok: false; code: 'capability-absent' | 'frame-missing' | 'image-missing' | 'attachment-missing' | 'unsafe-url'; message: string; ids: string[] };

/**
 * Assemble the pending design_artefact from what was read AT `versionId`, enforcing the compose rule:
 * every requested frame exists at that version, every image is non-null and has bytes, every frame has an
 * attachment. Any gap is a typed failure; this NEVER substitutes the latest version. `capabilityPresent` is
 * required and explicit: false is a refusal carrying the prerequisite message. B-1202's own validator,
 * capability detection and the recompose write are NOT here.
 */
export function assemblePendingArtefact(input: {
  capabilityPresent: boolean;
  fileKey: string;
  fileUrl: string;
  versionId: string;
  /** Ordered frames to preview, with the caption the brief shows. */
  frames: Array<{ id: string; name: string; caption: string }>;
  /** getNodesAtVersion(...).nodes — null (or missing) for an id absent at that version. */
  nodesAtVersion: FigmaNodesResponse['nodes'];
  /** Image results keyed by node id; bytes null = not downloadable. */
  images: Record<string, { bytes: Uint8Array | null } | undefined>;
  /** Caller-supplied attachment ids/filenames keyed by node id. */
  attachments: Record<string, { attachment_id: string; filename: string } | undefined>;
  composedAt: string;
  provenanceNotes: ProvenanceNote[];
  mcpCallCount?: number;
}): AssembleResult {
  if (input.capabilityPresent !== true) {
    return { ok: false, code: 'capability-absent', message: CAPABILITY_PREREQUISITE_MESSAGE, ids: [] };
  }
  if (/[?&#](token|access_token|signature|x-amz-[a-z-]+|x-goog-[a-z-]+|sig)=/i.test(input.fileUrl)) {
    return { ok: false, code: 'unsafe-url', message: 'file_url carries a token or signature; store the plain file URL only.', ids: [] };
  }
  const ids = input.frames.map((f) => f.id);
  const missingFrames = ids.filter((id) => !input.nodesAtVersion[id]);
  if (missingFrames.length) {
    return {
      ok: false, code: 'frame-missing', ids: missingFrames,
      message: `Frame(s) ${missingFrames.join(', ')} do not exist at version ${input.versionId}; not substituting a later version.`,
    };
  }
  const badImages = ids.filter((id) => !input.images[id]?.bytes || input.images[id]!.bytes!.length === 0);
  if (badImages.length) {
    return {
      ok: false, code: 'image-missing', ids: badImages,
      message: `No downloadable preview for frame(s) ${badImages.join(', ')} at version ${input.versionId} (a 200 with a null image is a failure); not substituting a later version.`,
    };
  }
  const noAttachment = ids.filter((id) => !input.attachments[id]);
  if (noAttachment.length) {
    return { ok: false, code: 'attachment-missing', ids: noAttachment, message: `No attachment recorded for the preview of frame(s) ${noAttachment.join(', ')}.` };
  }
  return {
    ok: true,
    artefact: {
      schema_version: 1,
      tool: 'figma',
      composed_at: input.composedAt,
      provenance_notes: input.provenanceNotes,
      mcp_call_count: input.mcpCallCount ?? 0,
      nodes: input.frames.map((f) => ({
        id: f.id, name: f.name, caption: f.caption,
        preview_attachment_id: input.attachments[f.id]!.attachment_id,
        preview_filename: input.attachments[f.id]!.filename,
      })),
      file_key: input.fileKey,
      file_url: input.fileUrl,
      version_id: input.versionId,
    },
  };
}
