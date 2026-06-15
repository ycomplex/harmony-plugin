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
  const putRes = await fetch(created.signed_url, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
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
