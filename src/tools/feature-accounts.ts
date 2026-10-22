import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const uuid = z.string().uuid();
const operation = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('replace'), clause_id: z.string().trim().min(1), content: z.string() })
    .strict(),
  z
    .object({
      op: z.literal('insert'),
      clause_id: z.string().trim().min(1),
      content: z.string(),
      ordinal: z.number().int().positive(),
    })
    .strict(),
]);
export const createAccountSchema = z
  .object({ owner_surface: z.string().trim().min(1), concept_id: uuid.optional() })
  .strict();
export const readAccountsSchema = z
  .object({
    account_id: uuid.optional(),
    owner_surface: z.string().optional(),
    history_limit: z.number().int().min(1).max(100).optional(),
    history_before: z.number().int().positive().optional(),
  })
  .strict();
export const previewAmendmentSchema = z
  .object({
    account_id: uuid,
    expected_revision: z.number().int().nonnegative(),
    operations: z.array(operation).min(1),
  })
  .strict();
export const proposeAmendmentSchema = previewAmendmentSchema.extend({
  source_decision_id: uuid,
  source_task_id: uuid,
  idempotency_key: z.string().trim().min(1),
  leaves_untouched: z.array(
    z
      .object({
        account_id: uuid.optional(),
        entry_id: uuid.optional(),
        owner_surface: z.string().min(1).optional(),
        clause_id: z.string().min(1).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'Name the untouched scope'),
  ),
  evidence: z
    .object({ pr_url: z.string().url().optional(), commit: z.string().min(1).optional() })
    .strict()
    .optional(),
});
export const applyAmendmentSchema = z
  .object({
    amendment_id: uuid,
    production_event_id: uuid.optional(),
    confirm_production: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => !!value.production_event_id !== (value.confirm_production === true),
    'Provide one production event or explicitly confirm post-promotion production',
  );

// Only the dedicated capability may degrade. Permission, network and all other
// failures remain errors; never cache absence or retry a failed write as a read.
export function missingAccountCapability(error: { code?: string; message?: string }): boolean {
  return (
    ['PGRST202', '42883', '42P01', 'PGRST205'].includes(error.code ?? '') &&
    /(?:feature_account|feature_amendment|knowledge_feature_)/i.test(error.message ?? '')
  );
}
async function call(
  client: SupabaseClient,
  name: string,
  projectId: string,
  args: Record<string, unknown>,
  read = false,
) {
  const parameters = Object.fromEntries(
    Object.entries(args)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`p_${key}`, value]),
  );
  const { data, error } = await client.rpc(name, { p_project_id: projectId, ...parameters });
  if (error) {
    if (missingAccountCapability(error)) {
      if (read) return { availability: 'unavailable' as const, accounts: [] };
      throw new Error(
        'Current account storage is unavailable. Deploy the web migration before writing; no change was made.',
      );
    }
    throw new Error(
      `Current account operation failed (${error.code ?? 'unknown'}): ${error.message}`,
    );
  }
  if (!data || typeof data !== 'object') throw new Error('Invalid current account response');
  return data;
}
export async function createFeatureAccount(
  client: SupabaseClient,
  projectId: string,
  args: unknown,
) {
  return call(client, 'create_feature_account', projectId, createAccountSchema.parse(args));
}
export async function readFeatureAccounts(
  client: SupabaseClient,
  projectId: string,
  args: unknown = {},
) {
  const result = await call(
    client,
    'read_feature_accounts',
    projectId,
    readAccountsSchema.parse(args),
    true,
  );
  if (
    !['available', 'unavailable', 'not-found'].includes(result.availability) ||
    !Array.isArray(result.accounts)
  )
    throw new Error('Invalid current account read response');
  return result;
}
export async function previewFeatureAmendment(
  client: SupabaseClient,
  projectId: string,
  args: unknown,
) {
  return call(client, 'preview_feature_amendment', projectId, previewAmendmentSchema.parse(args));
}
export async function proposeFeatureAmendment(
  client: SupabaseClient,
  projectId: string,
  args: unknown,
) {
  return call(client, 'propose_feature_amendment', projectId, proposeAmendmentSchema.parse(args));
}
export async function applyFeatureAmendment(
  client: SupabaseClient,
  projectId: string,
  args: unknown,
) {
  return call(client, 'apply_feature_amendment', projectId, applyAmendmentSchema.parse(args));
}
const properties = {
  account_id: { type: 'string', description: 'Stable account UUID' },
  expected_revision: { type: 'integer', minimum: 0 },
  operations: {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['replace', 'insert'] },
        clause_id: { type: 'string' },
        content: { type: 'string' },
        ordinal: { type: 'integer', minimum: 1 },
      },
      required: ['op', 'clause_id', 'content'],
      additionalProperties: false,
    },
    description:
      'Ordered replacements or insertions. Insert requires a new clause_id and final ordinal. Replace preserves order.',
  },
};
export const featureAccountTools = [
  {
    name: 'create_feature_account',
    description:
      'Create a project/surface current-account identity with no live text. Existing normalized surface returns the same identity. Optional concept_id shares the workspace concept UUID.',
    inputSchema: {
      type: 'object',
      properties: { owner_surface: { type: 'string' }, concept_id: { type: 'string' } },
      required: ['owner_surface'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_feature_accounts',
    description:
      'Read live current_text and ordered clauses separately from labelled pending_amendments and immutable history. Returns available, not-found or unavailable; permission/network errors stay errors. History is newest first; pass its last revision as history_before for the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: properties.account_id,
        owner_surface: { type: 'string' },
        history_limit: { type: 'integer', minimum: 1, maximum: 100 },
        history_before: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_feature_amendment',
    description:
      'Preview named clause operations at the expected live revision without proposing or publishing. Returns preview_text labelled live=false.',
    inputSchema: {
      type: 'object',
      properties,
      required: ['account_id', 'expected_revision', 'operations'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_feature_amendment',
    description:
      'Register an idempotent pending amendment from an accepted project decision and source ticket. Names clauses replaced, insertion order and neighbours left untouched. Records amendment-proposed; does not change live current_text. PR/commit evidence optional.',
    inputSchema: {
      type: 'object',
      properties: {
        ...properties,
        source_decision_id: { type: 'string' },
        source_task_id: { type: 'string' },
        idempotency_key: { type: 'string' },
        leaves_untouched: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              account_id: { type: 'string' },
              entry_id: { type: 'string' },
              owner_surface: { type: 'string' },
              clause_id: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        evidence: {
          type: 'object',
          properties: { pr_url: { type: 'string' }, commit: { type: 'string' } },
          additionalProperties: false,
        },
      },
      required: [
        'account_id',
        'expected_revision',
        'operations',
        'leaves_untouched',
        'source_decision_id',
        'source_task_id',
        'idempotency_key',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_feature_amendment',
    description:
      'Publish a pending amendment atomically ONLY with a trusted production-live re-stamped event, or confirm_production=true explicitly after promotion. Never call merely because a ticket merged, reached Deployed or Verified. Stale revision fails unchanged; successful retry creates no duplicate history/events.',
    inputSchema: {
      type: 'object',
      properties: {
        amendment_id: { type: 'string' },
        production_event_id: { type: 'string' },
        confirm_production: { type: 'boolean' },
      },
      required: ['amendment_id'],
      additionalProperties: false,
    },
  },
];
