import { z } from 'zod';

// Validate structure only. Keep additive fields and never substitute parsed output for authored data.
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const strings = z.array(z.string());
const track = z.enum(['product-design', 'technical-design', 'ux-ui-design']);
const unproven = z.array(object({ item: z.string(), reason: z.string() }));
const landing = object({
  repos: strings, pr_count: z.number(),
  lands_in: z.enum(['staging', 'production', 'both', 'merged-main']),
  atomicity: z.enum(['single', 'together', 'ordered']), ordering: z.string().optional(),
  irreversible: strings,
  prs: z.array(object({ repo: z.string(), number: z.number(), url: z.string() })).optional(),
});
const floor = { floor_reviewed: strings.optional() };
export const briefFrameSchema = z.discriminatedUnion('kind', [
  object({ kind: z.literal('clarify'), solving: z.string(), in_scope: strings,
    not_solving: z.array(object({ item: z.string(), lands: z.string() })), ...floor }),
  object({ kind: z.literal('decompose'),
    elements: z.array(object({ text: z.string(), surface: z.string().optional(), covers: z.string().optional() })),
    coverage: z.string(), existing_children_checked: z.boolean(), ...floor }),
  object({ kind: z.literal('design'), track,
    tracks: z.array(object({ track, status: z.enum(['accepted', 'this-brief', 'pending', 'not-required']), note: z.string().optional() })),
    reach: strings, not_reopened: strings.optional(),
    derisk: object({ run: strings, not_run: strings }).optional(), files_on_accept: strings.optional(), ...floor }),
  object({ kind: z.literal('plan'),
    scope: object({ repos: strings, surfaces: strings, has_migration: z.boolean() }), steps: strings,
    attestation: object({ base_verified: z.string(), derisked_by_running: z.string().optional() }),
    carried_unproven: unproven, ac_coverage: z.string(), landing: landing.optional(), design_delta: z.string().optional(), ...floor }),
  object({ kind: z.literal('release'), act: landing, unproven,
    evidence_status: object({ proven_by_run: z.number(), walk_at_verify: z.number(), unproven: z.number(), total: z.number(), detail: z.string().optional() }),
    // These values are overwritten by compose; callers need not author them.
    risk_classes: strings.optional(), contradiction_signal: z.unknown().optional(), pr_review_state: z.string().optional(), ...floor }),
  object({ kind: z.literal('verify'), environment: z.enum(['staging', 'production', 'merged-main', 'local']),
    criteria: z.array(object({ ac_id: z.string(), text: z.string(), checked: z.boolean(),
      disposition: z.enum(['walk', 'blocked', 'test-proven', 'not-hand-checkable', 'carried', 'unproven', 'manifest-declared', 'manifest-attested']),
      step_ref: z.string().optional(), blocked_reason: z.string().optional(), carried_to: z.string().optional(), backed_by: z.string().optional() })),
    steps: z.array(object({ ref: z.string(), action: z.string(), expect: z.string(), covers: strings })).optional(),
    exempt_reason: z.string().optional(), evidence_status: z.string(),
    bounded_accept: object({ open_ac_ids: strings, closes_when: z.string() }).optional() }),
]);

export function validateBriefFrame(frame: unknown, expectedKind?: string): void {
  if (frame == null) return; // Optional frame; explicit null retains the existing clear behavior.
  const result = briefFrameSchema.safeParse(frame);
  if (!result.success) {
    throw new Error(`Invalid brief frame:\n${result.error.issues.map(issue =>
      `- doc.frame${issue.path.map(p => typeof p === 'number' ? `[${p}]` : `.${p}`).join('')}: ${issue.message}`).join('\n')}`);
  }
  if (expectedKind && result.data.kind !== expectedKind) {
    throw new Error(`Invalid brief frame: doc.frame.kind must be '${expectedKind}', received '${result.data.kind}'`);
  }
}
