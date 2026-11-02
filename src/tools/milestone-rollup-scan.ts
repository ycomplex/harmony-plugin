import { z } from 'zod';

const member = z.object({ id: z.string(), title: z.string(), status: z.string(), workflow_state: z.string().nullable() });
const rollup = z.object({ task_id: z.string(), visual_id: z.string(), title: z.string(), comment_id: z.string(),
  rollup_key: z.string(), item_count: z.number().int().nonnegative().nullable(), needs_review: z.boolean(),
  items: z.array(z.object({ id: z.string(), tag: z.enum(['do-now', 'defer-with-trigger', 'drop']), text: z.string() })) });
const scanSchema = z.object({ schema_version: z.literal(1), scanned_host_count: z.number().int().nonnegative(),
  open_rollup_count: z.number().int().nonnegative(), rollups: z.array(rollup), members: z.array(member),
  needs_review: z.array(z.object({ task_id: z.string(), visual_id: z.string(), title: z.string(), comment_id: z.string(),
    item_count: z.null(), reason: z.string() })) });
export type RollupScan = z.infer<typeof scanSchema>;
export class RollupScanUnavailable extends Error {
  constructor() { super('The follow-up check is not yet available in this environment. Retry after deployment.'); }
}
export class RollupScanChanged extends Error {
  constructor(public scan: RollupScan) { super('Follow-ups changed since review. Review the updated list before shipping.'); }
}
export function parseRollupScan(data: unknown): RollupScan {
  const scan = scanSchema.parse(data);
  if (scan.scanned_host_count !== scan.members.length || scan.open_rollup_count !== scan.rollups.length ||
      new Set(scan.members.map(m => m.id)).size !== scan.members.length ||
      scan.rollups.some(r => !scan.members.some(m => m.id === r.task_id) ||
        (!r.needs_review && r.item_count !== r.items.length))) throw new Error('Incomplete follow-up check');
  return scan;
}
export function scanNeedsReview(scan: RollupScan): boolean {
  return scan.needs_review.length > 0 || scan.rollups.some(r => r.needs_review || r.item_count === null);
}
// Stable server ordering makes the complete serialized result the review token, including membership.
export function scanToken(scan: RollupScan): string { return JSON.stringify(scan); }
export function scanError(error: { code?: string; message?: string }): never {
  if (error.code === 'PGRST202') throw new RollupScanUnavailable();
  throw new Error(error.message || 'Follow-up check failed');
}
