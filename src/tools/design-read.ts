/**
 * B-1205 — read the accepted design off a ticket, check it for drift, and plan the build against it.
 *
 * Pure: no I/O of its own. The accepted design lives at `field_values.gate_slots.design` (B-1202's record
 * contract). The Figma version lookup sits behind `DesignVersionPort`; an absent or failing port yields
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
    };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Find the artefact in either `slot.design_artefact` or the slot itself. */
function findArtefact(slot: Obj): Obj | null {
  if (isObj(slot.design_artefact)) return slot.design_artefact;
  if (Array.isArray(slot.nodes)) return slot;
  return null;
}

/** The drift observation recorded at acceptance: a bare word, or an object carrying one. */
function readAcceptedDrift(slot: Obj, artefact: Obj): DriftWord | null {
  for (const src of [slot.drift, slot.acceptance_drift, slot.drift_observation, artefact.drift]) {
    const word = isObj(src) ? (src.observation ?? src.drift ?? src.status) : src;
    if (word === 'changed' || word === 'unchanged' || word === 'unchecked') return word;
  }
  return null;
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
      sourceBriefId: str(slot.source_brief_id) ?? str(artefact.source_brief_id),
      acceptedDrift: readAcceptedDrift(slot, artefact),
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
}

export async function checkDrift(
  design: AcceptedDesign,
  port?: DesignVersionPort | null,
): Promise<DriftResult> {
  const accepted = design.status === 'present' ? design.versionId : null;
  const unchecked = (note: string): DriftResult => ({ drift: 'unchecked', acceptedVersionId: accepted, liveVersionId: null, note });
  if (design.status !== 'present') return unchecked('no accepted design');
  if (design.tool === 'html') return unchecked('html design has no Figma version; nothing to compare');
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
