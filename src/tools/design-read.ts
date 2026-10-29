/**
 * B-1205 — read the accepted design off a ticket, check it for drift, and plan the build against it.
 *
 * Pure: no I/O of its own. The accepted design lives at `field_values.gate_slots.design` (B-1202's record
 * contract), its fields under that slot's `content` (B-1327). The Figma version lookup sits behind `DesignVersionPort`; an absent or failing port yields
 * `unchecked`, never a silent pass. Generated React/Tailwind from the design tools is reference only, so
 * nothing in this module carries source code through.
 */

export type DriftWord = 'changed' | 'unchanged' | 'unchecked';

export interface DesignScreen {
  nodeId: string;
  name: string;
  caption: string | null;
  previewAttachmentId: string | null;
  previewFilename: string | null;
}

export type AcceptedDesign =
  | { status: 'absent' }
  | {
      status: 'present';
      tool: 'figma' | 'html' | null;
      versionId: string | null;
      fileKey: string | null;
      fileUrl: string | null;
      screens: DesignScreen[];
      skippedNodes: number;
      sourceBriefId: string | null;
      acceptedDrift: DriftWord | null;
      /** B-1203: the content fingerprint stored on the ticket (`field_values.design_fingerprint`), or null. */
      fingerprint: FingerprintView | null;
    };

/** What the plan/build gates read of `field_values.design_fingerprint`; tolerant of anything malformed. */
export interface FingerprintView {
  /** 'taken' | 'not-taken'; 'unknown' when the record is malformed. */
  status: 'taken' | 'not-taken' | 'unknown';
  reason: string | null;
  drift: { status: 'changed' | 'unchanged' | 'not-checked'; checkedBy: string | null; changedFrameIds: string[]; reason: string | null } | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The object that carries the accepted design's fields. An accepted design is stored by gate-slots.ts as
 * `{ content: { design_artefact, drift, accepted_at, source_brief_id }, ratified_at, ratified_by }` (B-1327), so
 * `slot.content` is read first. The two shapes this reader used to know stay as fallbacks, in this order:
 * `slot.design_artefact`, then the slot itself carrying a bare `nodes` list.
 */
function designHolder(slot: Obj): Obj {
  return isObj(slot.content) && (isObj(slot.content.design_artefact) || Array.isArray(slot.content.nodes)) ? slot.content : slot;
}

/** Find the artefact: `content.design_artefact` (the stored shape), else `slot.design_artefact`, else the holder itself. */
function findArtefact(slot: Obj): Obj | null {
  const holder = designHolder(slot);
  if (isObj(holder.design_artefact)) return holder.design_artefact;
  if (Array.isArray(holder.nodes)) return holder;
  return null;
}

/** The drift observation recorded at acceptance: a bare word, or an object carrying one. */
function readAcceptedDrift(slot: Obj, artefact: Obj): DriftWord | null {
  const holder = designHolder(slot);
  for (const src of [holder.drift, holder.acceptance_drift, holder.drift_observation, slot.drift, slot.acceptance_drift, slot.drift_observation, artefact.drift]) {
    const word = isObj(src) ? (src.observation ?? src.drift ?? src.status) : src;
    if (word === 'changed' || word === 'unchanged' || word === 'unchecked') return word;
  }
  return null;
}

function readFingerprint(fieldValues: Obj): FingerprintView | null {
  const fp = fieldValues.design_fingerprint;
  if (!isObj(fp)) return null;
  const status = fp.status === 'taken' || fp.status === 'not-taken' ? fp.status : 'unknown';
  const d = fp.drift;
  const ds = isObj(d) ? d.status : null;
  const drift: FingerprintView['drift'] = isObj(d) && (ds === 'changed' || ds === 'unchanged' || ds === 'not-checked')
    ? {
        status: ds, checkedBy: str(d.checked_by), reason: str(d.reason),
        changedFrameIds: Array.isArray(d.changed_frame_ids) ? d.changed_frame_ids.filter((x): x is string => typeof x === 'string') : [],
      }
    : null;
  return { status, reason: str(fp.reason), drift };
}

export function readAcceptedDesign(fieldValues: unknown): AcceptedDesign {
  try {
    if (!isObj(fieldValues) || !isObj(fieldValues.gate_slots)) return { status: 'absent' };
    const slot = fieldValues.gate_slots.design;
    if (!isObj(slot)) return { status: 'absent' };
    const artefact = findArtefact(slot);
    // An html design (B-1202) carries a surface attachment and no nodes; it is still an accepted design.
    if (!artefact || (!Array.isArray(artefact.nodes) && artefact.tool !== 'html')) return { status: 'absent' };
    const screens: DesignScreen[] = [];
    let skippedNodes = 0;
    for (const n of Array.isArray(artefact.nodes) ? artefact.nodes : []) {
      const id = isObj(n) ? str(n.id) : null;
      const name = isObj(n) ? str(n.name) : null;
      if (!isObj(n) || !id || !name) { skippedNodes++; continue; }
      screens.push({
        nodeId: id, name, caption: str(n.caption),
        previewAttachmentId: str(n.preview_attachment_id), previewFilename: str(n.preview_filename),
      });
    }
    const tool = artefact.tool === 'figma' || artefact.tool === 'html' ? artefact.tool : null;
    return {
      status: 'present', tool,
      versionId: str(artefact.version_id), fileKey: str(artefact.file_key), fileUrl: str(artefact.file_url),
      screens, skippedNodes,
      sourceBriefId: str(designHolder(slot).source_brief_id) ?? str(slot.source_brief_id) ?? str(artefact.source_brief_id),
      acceptedDrift: readAcceptedDrift(slot, artefact),
      fingerprint: readFingerprint(fieldValues),
    };
  } catch {
    return { status: 'absent' };
  }
}

/** The seam B-1201 fills. An absent port means "unconnected". */
export interface DesignVersionPort {
  latestVersionId(fileKey: string): Promise<string | null>;
}

export interface DriftResult {
  drift: DriftWord;
  acceptedVersionId: string | null;
  liveVersionId: string | null;
  note: string;
  /** B-1203: present only when the answer came from the content fingerprint. */
  source?: 'fingerprint';
  changedFrameIds?: string[];
}

/** B-1203: drift from the stored fingerprint. Used when the accepted figma design has no version_id, or the ticket carries a fingerprint. */
function fingerprintDrift(design: Extract<AcceptedDesign, { status: 'present' }>): DriftResult {
  const fp = design.fingerprint;
  const mk = (drift: DriftWord, note: string, changedFrameIds?: string[]): DriftResult => ({
    drift, acceptedVersionId: design.versionId, liveVersionId: null, note, source: 'fingerprint', ...(changedFrameIds ? { changedFrameIds } : {}),
  });
  if (!fp) return mk('unchecked', 'no design fingerprint was stored for this ticket');
  if (fp.status === 'not-taken') return mk('unchecked', `the design fingerprint was not taken${fp.reason ? ` (${fp.reason})` : ''}`);
  if (fp.status !== 'taken') return mk('unchecked', 'the stored design fingerprint is malformed');
  if (!fp.drift || fp.drift.status === 'not-checked') return mk('unchecked', `the design fingerprint has not been compared${fp.drift?.reason ? ` (${fp.drift.reason})` : ''}`);
  if (fp.drift.status === 'changed') return mk('changed', `the design content differs from the accepted fingerprint${fp.drift.changedFrameIds.length ? ` (frames ${fp.drift.changedFrameIds.join(', ')})` : ''}`, fp.drift.changedFrameIds);
  return mk('unchanged', 'the design content matches the accepted fingerprint');
}

export async function checkDrift(
  design: AcceptedDesign,
  port?: DesignVersionPort | null,
): Promise<DriftResult> {
  const accepted = design.status === 'present' ? design.versionId : null;
  const unchecked = (note: string): DriftResult => ({ drift: 'unchecked', acceptedVersionId: accepted, liveVersionId: null, note });
  if (design.status !== 'present') return unchecked('no accepted design');
  if (design.tool === 'html') return unchecked('html design has no Figma version; nothing to compare');
  if (design.tool === 'figma' && (design.fingerprint || !design.versionId)) return fingerprintDrift(design);
  if (!design.fileKey || !accepted) return unchecked('accepted design records no Figma file key or version');
  if (!port) return unchecked('no Figma token available');
  let live: string | null;
  try {
    live = await port.latestVersionId(design.fileKey);
  } catch {
    return unchecked('version lookup failed');
  }
  if (!live) return unchecked('version lookup returned nothing');
  return {
    drift: live === accepted ? 'unchanged' : 'changed',
    acceptedVersionId: accepted, liveVersionId: live,
    note: live === accepted ? 'live version matches the accepted version' : 'live version differs from the accepted version',
  };
}

export function describeDrift(r: DriftResult): string {
  if (r.source === 'fingerprint') return `Drift check: ${r.drift} (${r.note}).`;
  if (r.drift === 'changed') return `Drift check: changed (accepted version ${r.acceptedVersionId ?? 'unknown'}, live version ${r.liveVersionId ?? 'unknown'}).`;
  if (r.drift === 'unchanged') return `Drift check: unchanged (version ${r.acceptedVersionId ?? 'unknown'}).`;
  return `Drift check: unchecked (${r.note}).`;
}

export function assertBuildMayStart(
  r: DriftResult,
  namedDifferences: string[],
): { allowed: true } | { allowed: false; reason: string } {
  if (r.drift !== 'changed') return { allowed: true };
  if (namedDifferences.some((d) => d.trim())) return { allowed: true };
  if (r.source === 'fingerprint') {
    return {
      allowed: false,
      reason: `The design changed since acceptance (${r.note}). Name the difference in a plan step, or re-accept the design, before building.`,
    };
  }
  return {
    allowed: false,
    reason: `The design changed since acceptance (accepted version ${r.acceptedVersionId ?? 'unknown'}, live version ${r.liveVersionId ?? 'unknown'}). Name the difference in a plan step, or re-accept the design, before building.`,
  };
}

export interface ComponentPorts {
  codeConnectMap?: Record<string, string> | null;
  workspaceMap?: Record<string, string> | null;
}
export interface ComponentResolution {
  source: 'code-connect' | 'workspace-map' | 'unmapped';
  repoComponent: string | null;
}

/** Map a designed node to the repo's own component. Carries a path/name only, never generated source. */
export function resolveComponent(
  node: { nodeId?: string; id?: string; name?: string },
  ports: ComponentPorts,
): ComponentResolution {
  const keys = [node.nodeId ?? node.id, node.name].filter((k): k is string => !!k);
  const lookup = (m?: Record<string, string> | null): string | null => {
    if (!m) return null;
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(m, k) && m[k]) return m[k];
    return null;
  };
  const cc = lookup(ports.codeConnectMap);
  if (cc) return { source: 'code-connect', repoComponent: cc };
  const wm = lookup(ports.workspaceMap);
  if (wm) return { source: 'workspace-map', repoComponent: wm };
  return { source: 'unmapped', repoComponent: null };
}

export interface DesignReadPlan {
  design_read: { version_id: string | null; screens: string[]; drift: DriftWord };
  checklist: string[];
}

export function planDesignRead(fieldValues: unknown, drift: DriftResult): DesignReadPlan | null {
  const design = readAcceptedDesign(fieldValues);
  if (design.status !== 'present') return null;
  return {
    design_read: { version_id: design.versionId, screens: design.screens.map((s) => s.name), drift: drift.drift },
    checklist: design.screens.map((s) =>
      `Build screen '${s.name}' from the accepted design${s.previewFilename ? ` (compare with '${s.previewFilename}')` : ''}`),
  };
}
