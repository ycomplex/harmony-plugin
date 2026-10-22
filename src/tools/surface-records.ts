import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
const text = z.string().trim().min(1);
export const readSurfaceSchema = z
  .object({ owner_surface: text, component_ref: text.optional() })
  .strict();
export const captureSurfaceSchema = z
  .object({
    owner_surface: text,
    component_ref: text,
    labels: z.array(text),
    buttons: z.array(text),
    headings: z.array(text),
    source_kind: z.enum(['component-source', 'screenshot-alt-text']),
    source_locator: text,
    source_fingerprint: text,
  })
  .strict();
// Probe the actual optional RPC on every call: no cached absence and no fallback writes.
async function call(
  client: SupabaseClient,
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  read: boolean,
) {
  const parameters = Object.fromEntries(
    Object.entries(args)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [`p_${k}`, v]),
  );
  const { data, error } = await client.rpc(name, {
    p_project_id: projectId,
    ...parameters,
  });
  if (error) {
    if (
      ['PGRST202', '42883', '42P01', 'PGRST205'].includes(error.code ?? '') &&
      /(?:read_surface_records|capture_surface_record|knowledge_surface_records)/i.test(
        error.message ?? '',
      )
    ) {
      if (read) return { availability: 'unavailable', records: [] };
      throw new Error(
        'Rendered surface storage is unavailable. Deploy the web migration before capture; no account or decision was changed.',
      );
    }
    throw new Error(
      `Rendered surface operation failed (${error.code ?? 'unknown'}): ${error.message}`,
    );
  }
  if (!data || typeof data !== 'object')
    throw new Error('Invalid rendered surface response');
  return data;
}
export async function captureSurfaceRecord(
  client: SupabaseClient,
  projectId: string,
  args: unknown,
) {
  return call(
    client,
    projectId,
    'capture_surface_record',
    captureSurfaceSchema.parse(args),
    false,
  );
}
export async function readSurfaceRecords(
  client: SupabaseClient,
  projectId: string,
  args: unknown,
) {
  const result = await call(
    client,
    projectId,
    'read_surface_records',
    readSurfaceSchema.parse(args),
    true,
  );
  if (
    !['available', 'not-found', 'unavailable'].includes(result.availability) ||
    !Array.isArray(result.records)
  )
    throw new Error('Invalid rendered surface read response');
  return result;
}
const identity = {
  owner_surface: {
    type: 'string',
    description:
      'Existing project-scoped owner surface from read_feature_accounts',
  },
  component_ref: {
    type: 'string',
    description: 'Stable repository-relative component reference',
  },
};
export const surfaceRecordTools = [
  {
    name: 'read_surface_records',
    description:
      'Read source-labelled rendered labels, buttons and headings separately from the owner account current_text (read context only). Empty records means no capture; unavailable means schema not deployed. Permission and network errors remain errors.',
    inputSchema: {
      type: 'object',
      properties: identity,
      required: ['owner_surface'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_surface_record',
    description:
      'Capture or refresh observed component wording under an existing owner surface. Cite component source or screenshot alt text and a source fingerprint (SHA-256 recommended). Unchanged fingerprint is a no-op; changed fingerprint replaces the capture. Never writes accounts or decisions; refuses missing schema or owner identity.',
    inputSchema: {
      type: 'object',
      properties: {
        ...identity,
        labels: { type: 'array', items: { type: 'string' } },
        buttons: { type: 'array', items: { type: 'string' } },
        headings: { type: 'array', items: { type: 'string' } },
        source_kind: {
          type: 'string',
          enum: ['component-source', 'screenshot-alt-text'],
        },
        source_locator: { type: 'string' },
        source_fingerprint: { type: 'string' },
      },
      required: [
        'owner_surface',
        'component_ref',
        'labels',
        'buttons',
        'headings',
        'source_kind',
        'source_locator',
        'source_fingerprint',
      ],
      additionalProperties: false,
    },
  },
];
