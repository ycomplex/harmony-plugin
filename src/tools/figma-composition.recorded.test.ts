import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planComposition, MCP_CALL_CAP, type PlanInput, type CompositionPlan } from './figma-composition.js';

// RECORDED (B-1203 live proof, 2026-10-27): a real use_figma composition against the B-1200 spike file,
// captured by the v1.11 seat from an interactive session with Figma's hosted MCP server. See the fixture's _recorded.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/figma-composition.live-2026-10-27.json', import.meta.url)), 'utf8'),
) as {
  plan_input: PlanInput;
  plan: CompositionPlan;
  call_ledger: Array<{ tool: string; purpose: string; counts_toward_compose: boolean }>;
  create_session_required: boolean;
  compose_response: { createdFrames: Array<{ id: string; name: string; order: number; recommended: boolean }>; importedComponents: string[] };
};

describe('planComposition against the recorded live proof', () => {
  it('reproduces the recorded plan from the recorded input', () => {
    expect(planComposition(fixture.plan_input)).toEqual(fixture.plan);
  });

  it('the live compose built one frame per planned frame, in order, with exactly one recommendation', () => {
    const created = fixture.compose_response.createdFrames;
    expect(created.map((f) => [f.order, f.name])).toEqual(fixture.plan.frames.map((f) => [f.order, f.name]));
    expect(created.filter((f) => f.recommended)).toHaveLength(1);
  });

  it('the live compose instantiated every planned library instance and nothing else', () => {
    const planned = fixture.plan.frames.flatMap((f) => f.instances.map((i) => i.component));
    expect(fixture.compose_response.importedComponents).toEqual(planned);
  });

  it('composing cost one MCP call, without create_session, well under the cap', () => {
    const compose = fixture.call_ledger.filter((c) => c.counts_toward_compose);
    expect(compose).toHaveLength(fixture.plan.calls.length);
    expect(compose.every((c) => c.tool === 'use_figma')).toBe(true);
    expect(fixture.create_session_required).toBe(false);
    expect(fixture.call_ledger.length).toBeLessThanOrEqual(MCP_CALL_CAP);
  });
});
