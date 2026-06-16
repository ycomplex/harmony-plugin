// B-449 — MCP/agent attachment tools (thin reuse of the B-448 substrate).
//
// Design refs: knowledge 364fb4ca (technical), bef0f83e (clarified intent),
// 9f4bd7d3 (B-448 substrate contract).
//
// This is NOT new server logic. The plugin already authenticates as the
// contributor's Supabase user (HARMONY_API_TOKEN → auth-token → user JWT; the
// shared client sends `Authorization: Bearer <jwt>`), so B-448's edge functions
// (verify_jwt=false; they verify the caller JWT + membership/role + feature gate
// themselves) accept the plugin's JWT with no adapter. We call them via the same
// `functions.invoke` pattern used for `embed-knowledge` in tools/knowledge.ts —
// no service credentials, no duplicated server logic.
//
//   - download tool: invoke('attachments-download') → signed URL → fetch bytes →
//     write to a local path → return the path (+ URL). Viewers may download.
//   - upload tool: read the local file → invoke('attachments-create-upload')
//     (server-side cap + type pre-flight) → PUT bytes to the signed upload URL →
//     invoke('attachments-finalize') (server-side magic-byte sniff) → return the
//     finalized metadata. Write-roles only (server-enforced; we surface the
//     server's error/upgrade message cleanly).
//
// Attachment SEEING is folded into get_task (see tasks.ts) — no separate list tool.

import type { SupabaseClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTaskId } from './resolve-task-id.js';

// ── helpers ──────────────────────────────────────────────────────────

// `functions.invoke` resolves with `{ data, error }`. The B-448 functions answer
// a non-2xx with a JSON body `{ error, code?, upgrade? }`; supabase-js surfaces
// that as a FunctionsHttpError whose `.context` is the original Response, so the
// human-readable message lives in the response body, not `error.message`. Pull it
// out so the agent (and a blocked viewer) sees the real server message, e.g.
// "Viewers cannot modify attachments" or the size-limit / upgrade prompt.
async function invokeFn<T>(
  client: SupabaseClient,
  fn: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await (client as unknown as {
    functions: { invoke: (n: string, o: { body: unknown }) => Promise<{ data: unknown; error: unknown }> };
  }).functions.invoke(fn, { body });
  if (error) {
    const err = error as { message?: string; context?: { json?: () => Promise<unknown> } };
    let message = err.message ?? `${fn} failed`;
    const ctx = err.context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = (await ctx.json()) as { error?: string } | null;
        if (parsed?.error) {
          message = parsed.error;
        }
      } catch {
        // non-JSON body — keep the generic message.
      }
    }
    throw new Error(message);
  }
  return data as T;
}

// ── download ─────────────────────────────────────────────────────────

export const downloadAttachmentTool = {
  name: 'download_attachment',
  description:
    'Download a task attachment to a local file and return its path so you can read it with native file tools. ' +
    'Available to read-only/viewer tokens. Provide the attachment_id (from get_task). Optionally pass output_path ' +
    '(a full file path) or output_dir (a directory; the original filename is used). Defaults to a temp directory.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      attachment_id: { type: 'string', description: 'Attachment UUID (from get_task).' },
      output_path: { type: 'string', description: 'Full local file path to write to. Optional.' },
      output_dir: {
        type: 'string',
        description: 'Local directory to write into (original filename is used). Optional; defaults to a temp dir.',
      },
    },
    required: ['attachment_id'],
  },
};

interface DownloadResponse {
  attachment_id: string;
  signed_url: string;
  filename: string;
  content_type: string;
  inline: boolean;
  expires_in: number;
}

export async function downloadAttachment(
  client: SupabaseClient,
  args: { attachment_id: string; output_path?: string; output_dir?: string },
) {
  if (!args.attachment_id) throw new Error('attachment_id is required');

  const meta = await invokeFn<DownloadResponse>(client, 'attachments-download', {
    attachment_id: args.attachment_id,
  });

  // Resolve the local destination path.
  let destPath: string;
  if (args.output_path) {
    destPath = path.resolve(args.output_path);
  } else {
    const dir = args.output_dir
      ? path.resolve(args.output_dir)
      : await fs.mkdtemp(path.join(os.tmpdir(), 'harmony-attachment-'));
    destPath = path.join(dir, meta.filename || meta.attachment_id);
  }

  // Make sure the parent directory exists (e.g. an output_path into a new dir).
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  // Fetch the bytes from the (short-TTL) signed URL and write them locally.
  const res = await fetch(meta.signed_url);
  if (!res.ok) {
    throw new Error(`Failed to fetch attachment bytes (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);

  return {
    attachment_id: meta.attachment_id,
    path: destPath,
    filename: meta.filename,
    content_type: meta.content_type,
    byte_size: buf.byteLength,
    signed_url: meta.signed_url,
    expires_in: meta.expires_in,
  };
}

// ── upload ───────────────────────────────────────────────────────────

export const attachFileTool = {
  name: 'attach_file',
  description:
    'Attach a local file to a task. Reads the file by path and uploads it via the substrate ' +
    '(server-enforced size cap, file-type allowlist, and magic-byte sniff). Write-role tokens only — ' +
    'viewers get a clear server error. Provide task_id and file_path; optionally override filename.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43).' },
      file_path: { type: 'string', description: 'Local path to the file to attach.' },
      filename: { type: 'string', description: 'Override the stored filename. Optional; defaults to the file basename.' },
    },
    required: ['task_id', 'file_path'],
  },
};

interface CreateUploadResponse {
  attachment_id: string;
  object_key: string;
  signed_url: string;
  token: string;
  path: string;
}

interface FinalizeResponse {
  attachment_id: string;
  status: string;
  content_type: string;
  byte_size: number;
}

// ── extension → MIME (B-481) ─────────────────────────────────────────
// The `task-attachments` bucket has a curated `allowed_mime_types` allowlist
// (harmony-web migration 20260612180000_attachments_substrate.sql). It does NOT
// include `application/octet-stream`, so PUTting bytes with a hardcoded
// octet-stream Content-Type is rejected by Storage with HTTP 400 for EVERY file
// type. So the byte PUT must declare a Content-Type that the allowlist accepts.
//
// We hand-roll the map (no new npm dep → no lockfile/CI churn) directly from the
// bucket's allowlist. The Content-Type only needs to be allowlist-acceptable —
// the authoritative type check is the server-side magic-byte sniff at finalize
// (defence-in-depth). The "more correct" fix is to have the server thread the
// content_type through `attachments-create-upload`'s response (single source of
// truth), but that's cross-repo and out of scope for this fast fix.
const EXTENSION_MIME: Record<string, string> = {
  // images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // documents
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  // office (docx / xlsx / pptx)
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Resolve a filename to an allowlist-acceptable Content-Type for the byte PUT.
// Throws a clear, pre-PUT error for any extension not on the bucket allowlist —
// silently sending octet-stream (or any unlisted type) would just reproduce the
// HTTP-400 rejection with a confusing "Failed to upload file bytes (400)".
function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mime = EXTENSION_MIME[ext];
  if (!mime) {
    const supported = Object.keys(EXTENSION_MIME).join(', ');
    throw new Error(
      `Unsupported file type "${ext || '(none)'}" for "${filename}". ` +
        `The attachment bucket only accepts: ${supported}.`,
    );
  }
  return mime;
}

export async function attachFile(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; file_path: string; filename?: string },
) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.file_path) throw new Error('file_path is required');

  // Read the local file (Node fs) — bytes never travel through the tool call.
  const absPath = path.resolve(args.file_path);
  const bytes = await fs.readFile(absPath);
  const filename = args.filename ?? path.basename(absPath);

  // Derive the byte-PUT Content-Type from the filename up front (B-481). Done
  // BEFORE create-upload so an unsupported type fails fast with a clear message
  // instead of minting an upload URL only for Storage to 400 the PUT.
  const contentType = contentTypeForFilename(filename);

  // Resolve a visual/number task id to the UUID the edge function expects.
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);

  // 1) create-upload — server-side write-role check, feature gate, plan cap
  //    pre-flight (on the declared byte_size); mints a signed upload URL.
  const created = await invokeFn<CreateUploadResponse>(client, 'attachments-create-upload', {
    task_id: resolvedId,
    filename,
    byte_size: bytes.byteLength,
  });

  // 2) PUT the bytes straight to the signed upload URL (the plugin is the client).
  //    The Content-Type MUST be an allowlist-acceptable value (B-481) — the bucket
  //    rejects application/octet-stream → HTTP 400. We send the type derived from
  //    the filename above; the authoritative check is finalize's magic-byte sniff.
  const putRes = await fetch(created.signed_url, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': contentType },
  });
  if (!putRes.ok) {
    throw new Error(`Failed to upload file bytes (${putRes.status})`);
  }

  // 3) finalize — server-side magic-byte sniff + true-size re-check; flips the
  //    row to `finalized`. A rejection here (blocked type / oversize) deletes the
  //    object + row server-side; we surface the server's message.
  const finalized = await invokeFn<FinalizeResponse>(client, 'attachments-finalize', {
    attachment_id: created.attachment_id,
  });

  return {
    attachment_id: finalized.attachment_id,
    task_id: resolvedId,
    filename,
    content_type: finalized.content_type,
    byte_size: finalized.byte_size,
    status: finalized.status,
  };
}
