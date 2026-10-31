import { z } from 'zod';
import { designRuleSchema, ruleReachSchema } from './design-rules.js';

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
// B-1203 — optional flow-sketch record on the clarify frame (Figma-connected workspaces only).
const sketch = object({
  file_link: z.string(), pinned_version: z.string(),
  frames: z.array(object({ name: z.string(), caption: z.string() })),
  preview_attachment_ids: strings, mcp_call_count: z.number(),
});
const floor = { floor_reviewed: strings.optional() };
export const briefFrameSchema = z.discriminatedUnion('kind', [
  object({ kind: z.literal('clarify'), solving: z.string(), in_scope: strings,
    not_solving: z.array(object({ item: z.string(), lands: z.string() })),
    sketch: sketch.optional(), ...floor }),
  object({ kind: z.literal('decompose'),
    elements: z.array(object({ text: z.string(), surface: z.string().optional(), covers: z.string().optional() })),
    coverage: z.string(), existing_children_checked: z.boolean(), ...floor }),
  object({ kind: z.literal('design'), track,
    tracks: z.array(object({ track, status: z.enum(['accepted', 'this-brief', 'pending', 'not-required']), note: z.string().optional() })),
    reach: strings, decision_reach: ruleReachSchema.optional(), rules: z.array(designRuleSchema).optional(), not_reopened: strings.optional(),
    derisk: object({ run: strings, not_run: strings }).optional(), files_on_accept: strings.optional(),
    designer_frames: z.array(object({ id: z.string(), name: z.string(), file_key: z.string(),
      verdict: z.enum(['adopted', 'off-library', 'not-covering', 'unreadable', 'not-checked']), reason: z.string(),
      preview_attachment_id: z.string().optional(), preview_filename: z.string().optional() })).optional(), ...floor }),
  object({ kind: z.literal('plan'),
    scope: object({ repos: strings, surfaces: strings, has_migration: z.boolean() }), steps: strings,
    attestation: object({ base_verified: z.string(), derisked_by_running: z.string().optional() }),
    carried_unproven: unproven, ac_coverage: z.string(), landing: landing.optional(), design_delta: z.string().optional(),
    design_read: object({ version_id: z.string().nullable(), screens: strings, drift: z.enum(['changed', 'unchanged', 'unchecked']) }).optional(), ...floor }),
  object({ kind: z.literal('release'), act: landing, unproven,
    settled_beyond_design: z.array(object({ behaviour: z.string().trim().min(1), ac: z.string().trim().min(1),
      knowledge_entry_id: z.string().trim().min(1) })).optional(),
    evidence_status: object({ proven_by_run: z.number(), walk_at_verify: z.number(), unproven: z.number(), total: z.number(), detail: z.string().optional() }),
    // These values are overwritten by compose; callers need not author them.
    risk_classes: strings.optional(), contradiction_signal: z.unknown().optional(), pr_review_state: z.string().optional(), ...floor }),
  object({ kind: z.literal('verify'), environment: z.enum(['staging', 'production', 'merged-main', 'local']),
    criteria: z.array(object({ ac_id: z.string(), text: z.string(), checked: z.boolean(),
      disposition: z.enum(['walk', 'blocked', 'test-proven', 'not-hand-checkable', 'carried', 'unproven', 'manifest-declared', 'manifest-attested']),
      step_ref: z.string().optional(), blocked_reason: z.string().optional(), carried_to: z.string().optional(), backed_by: z.string().optional() })),
    steps: z.array(object({ ref: z.string(), action: z.string(), expect: z.string(), covers: strings,
      design_node: object({ node_id: z.string(), name: z.string(), caption: z.string().optional(),
        preview_attachment_id: z.string(), preview_filename: z.string() }).optional() })).optional(),
    design_comparison: z.string().optional(),
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
  if (result.data.kind === 'design') {
    const frame = result.data;
    if (frame.rules?.length && !frame.decision_reach) throw new Error('Rules require decision_reach');
    if (frame.decision_reach && frame.decision_reach !== 'this_ticket_only' && !frame.rules?.length) {
      throw new Error('Broader decision reach requires a non-empty rules array');
    }
    if (frame.decision_reach === 'this_ticket_only' && frame.rules?.some(rule => rule.operation !== 'reference')) {
      throw new Error('Ticket-only decisions cannot create or amend rules');
    }
  }
}
