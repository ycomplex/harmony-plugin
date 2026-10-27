import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

const uuid = z.string().uuid();
const NodeSchema = z.object({ id: z.string().min(1), name: z.string().min(1), caption: z.string(), preview_attachment_id: uuid, preview_filename: z.string().min(1) }).strict();
const base = { schema_version: z.literal(1), composed_at: z.string().datetime(), provenance_notes: z.string(), mcp_call_count: z.number().int().nonnegative() };
export const DesignArtefactSchema = z.discriminatedUnion('tool', [
  z.object({ ...base, tool: z.literal('figma'), file_key: z.string().regex(/^[a-zA-Z0-9]+$/), file_url: z.string().url().refine(s => { const u = new URL(s); return u.protocol === 'https:' && u.hostname === 'www.figma.com'; }), version_id: z.string().min(1), nodes: z.array(NodeSchema).min(1) }).strict(),
  z.object({ ...base, tool: z.literal('html'), surface_attachment_id: uuid, surface_filename: z.string().min(1), nodes: z.array(NodeSchema).max(0).optional() }).strict(),
]);
export type DesignArtefact = z.infer<typeof DesignArtefactSchema>;
export interface DesignDrift { status: 'unchanged' | 'changed' | 'unchecked'; checked_at: string; latest_version_id?: string; }
export function designAttachmentIds(a: DesignArtefact): string[] { return a.tool === 'html' ? [a.surface_attachment_id] : a.nodes.map(n => n.preview_attachment_id); }
export async function validateDesignAttachments(client: SupabaseClient, taskId: string, raw: unknown): Promise<DesignArtefact> {
  const a = DesignArtefactSchema.parse(raw);
  const { data: capability, error: capError } = await client.rpc('design_artefact_capability');
  if (capError || capability?.schema_version !== 1) throw new Error('Design artefacts require the B-1202 web migration on this board; promote web before composing artefacts.');
  const ids = [...new Set(designAttachmentIds(a))];
  const { data, error } = await client.from('attachments').select('id, filename, content_type').eq('task_id', taskId).eq('status', 'finalized').in('id', ids);
  if (error) throw new Error(error.message);
  for (const id of ids) {
    const row = data?.find((r: { id: string }) => r.id === id);
    const filename = a.tool === 'html' ? a.surface_filename : a.nodes.find(n => n.preview_attachment_id === id)!.preview_filename;
    if (!row || row.filename !== filename || (a.tool === 'html' ? row.content_type !== 'text/html' : !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(row.content_type))) throw new Error('Design preview must reference a finalized same-ticket attachment with its actual filename and expected media type.');
  }
  return a;
}
export function renderDesignArtefact(a: DesignArtefact): string[] {
  if (a.tool === 'html') return [`**Design preview:** ${a.surface_filename} (ticket attachment ${a.surface_attachment_id}; download and open locally)`];
  return [`**Design previews:** [Open Figma file — version ${a.version_id}](${a.file_url})`, ...a.nodes.map(n => `- ${n.name}: ${n.caption} — ${n.preview_filename} (ticket attachment ${n.preview_attachment_id})`)];
}
/** Credential injection is optional; no credential storage or secret access belongs here. */
export async function observeDesignDrift(a: DesignArtefact, token: string | undefined, request: typeof fetch = fetch): Promise<DesignDrift> {
  const checked_at = new Date().toISOString();
  if (a.tool !== 'figma' || !token) return { status: 'unchecked', checked_at };
  try {
    const r = await request(`https://api.figma.com/v1/files/${a.file_key}/nodes?ids=${encodeURIComponent(a.nodes.map(n => n.id).join(","))}`, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('lookup failed');
    const body = await r.json() as { version?: string };
    if (!body.version) throw new Error('missing version');
    return { status: body.version === a.version_id ? 'unchanged' : 'changed', checked_at, latest_version_id: body.version };
  } catch { return { status: 'unchecked', checked_at }; }
}
/** Bounded autosave wait; BOTH frame presence and a non-null versioned image are required. */
export async function prepareVersionedPreviews(fileKey: string, nodeIds: string[], token: string, request: typeof fetch = fetch, pause: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
  if (!/^[a-zA-Z0-9]+$/.test(fileKey) || !nodeIds.length) throw new Error('File and frames are required');
  const headers = { 'X-Figma-Token': token };
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await request(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeIds.join(','))}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!current.ok) throw new Error(`Figma nodes: HTTP ${current.status}`);
    const { version } = await current.json() as { version?: string };
    if (!version) throw new Error('Figma nodes returned no version');
    const suffix = `ids=${encodeURIComponent(nodeIds.join(','))}&version=${encodeURIComponent(version)}`;
    const pinned = await request(`https://api.figma.com/v1/files/${fileKey}/nodes?${suffix}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!pinned.ok) throw new Error(`Pinned Figma nodes: HTTP ${pinned.status}`);
    const body = await pinned.json() as { nodes?: Record<string, unknown> };
    if (nodeIds.every(id => body.nodes?.[id])) {
      const images = await request(`https://api.figma.com/v1/images/${fileKey}?${suffix}&format=png`, { headers, signal: AbortSignal.timeout(10000) });
      if (!images.ok) throw new Error(`Pinned Figma images: HTTP ${images.status}`);
      const result = await images.json() as { err?: unknown; images?: Record<string, string | null> };
      if (!result.err && nodeIds.every(id => result.images?.[id])) {
        const previews = await Promise.all(nodeIds.map(async id => {
          // Signed URLs are transient transport only, never part of the durable result.
          const url = new URL(result.images![id]!);
          if (url.protocol !== 'https:') throw new Error('Figma image URL must use HTTPS');
          const response = await request(url, { signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error(`Preview download: HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) throw new Error('Figma preview is not a PNG');
          return { id, bytes };
        }));
        return { version_id: version, previews };
      }
    }
    if (attempt < 11) await pause(10000);
  }
  throw new Error('Figma autosave did not capture every frame within 12 attempts; save the file and retry. No latest screenshots were substituted.');
}
