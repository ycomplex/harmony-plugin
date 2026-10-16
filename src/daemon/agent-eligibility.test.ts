// B-1077: the daemon's fire-time agent eligibility check — pure, so every refusal is pinned here.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROFILE_AGENTS,
  evaluateAgentEligibility,
  formatAgentIneligibleComment,
  unknownAdapterMessage,
  type AgentEligibility,
} from './agent-eligibility.js';
import { getAdapter } from '../agents/registry.js';
import { RunConfigSchema, type RunConfig } from '../config/run-config.js';

const rc = (v: unknown): RunConfig => RunConfigSchema.parse(v);
const refused = (r: AgentEligibility) => {
  expect(r.eligible).toBe(false);
  return r as Extract<AgentEligibility, { eligible: false }>;
};

describe('evaluateAgentEligibility', () => {
  it('an absent agent key on a profile with no agents list launches claude-code (unchanged default)', () => {
    expect(evaluateAgentEligibility({ runConfig: {}, templateDeliversRunConfig: false })).toEqual({
      eligible: true,
      adapter: 'claude-code',
    });
  });

  it('an explicit claude-code is eligible even on a template without {run_config_json}', () => {
    expect(
      evaluateAgentEligibility({ runConfig: rc({ agent: { adapter: 'claude-code' } }), templateDeliversRunConfig: false }),
    ).toEqual({ eligible: true, adapter: 'claude-code' });
  });

  it('an unregistered adapter is REFUSED with the registry message naming the registered adapters — no fallback', () => {
    const r = refused(
      evaluateAgentEligibility({
        runConfig: rc({ agent: { adapter: 'codex' } }),
        profileAgents: ['claude-code', 'codex'],
        templateDeliversRunConfig: true,
      }),
    );
    expect(r.adapter).toBe('codex');
    expect(r.reason).toContain("Unknown agent adapter 'codex' — registered: claude-code");
    expect(r.reason).toContain('This launch profile allows: claude-code, codex.');
  });

  it('a malformed agent value is REFUSED (never read as claude-code)', () => {
    const r = refused(evaluateAgentEligibility({ runConfig: rc({ agent: { adapter: 7 } }), templateDeliversRunConfig: true }));
    expect(r.adapter).toBeNull();
    expect(r.reason).toMatch(/run_config\.agent\.adapter must be a non-empty adapter id string/);
    expect(r.reason).toContain('Registered agent adapters: claude-code.');
  });

  it("a registered adapter missing from the profile's agents list is REFUSED", () => {
    const r = refused(
      evaluateAgentEligibility({ runConfig: {}, profileAgents: ['codex'], templateDeliversRunConfig: true }),
    );
    expect(r.adapter).toBe('claude-code');
    expect(r.reason).toContain("Agent adapter 'claude-code' is not allowed on this launch profile");
    expect(r.reason).toContain('This launch profile allows: codex.');
  });

  it('the unknown-adapter message is byte-identical to the registry getAdapter error', () => {
    expect(() => getAdapter('codex')).toThrow(unknownAdapterMessage('codex', ['claude-code']));
  });

  it('a registered NON-default adapter on a template without {run_config_json} is REFUSED (the worker would silently run claude-code)', () => {
    const input = {
      runConfig: rc({ agent: { adapter: 'codex' } }),
      profileAgents: ['claude-code', 'codex'],
      registeredAdapters: ['claude-code', 'codex'],
    };
    const r = refused(evaluateAgentEligibility({ ...input, templateDeliversRunConfig: false }));
    expect(r.reason).toContain('no {run_config_json} placeholder');
    expect(evaluateAgentEligibility({ ...input, templateDeliversRunConfig: true })).toEqual({ eligible: true, adapter: 'codex' });
  });

  it('the default profile list is claude-code only', () => {
    expect(DEFAULT_PROFILE_AGENTS).toEqual(['claude-code']);
  });

  it('config-only rollback: switching an unknown adapter back to claude-code makes eligibility pass', () => {
    const base = { profileAgents: ['claude-code'], templateDeliversRunConfig: true };
    expect(evaluateAgentEligibility({ ...base, runConfig: rc({ agent: { adapter: 'codex' } }) }).eligible).toBe(false);
    expect(evaluateAgentEligibility({ ...base, runConfig: rc({ agent: { adapter: 'claude-code' } }) })).toEqual({
      eligible: true,
      adapter: 'claude-code',
    });
    expect(evaluateAgentEligibility({ ...base, runConfig: {} })).toEqual({ eligible: true, adapter: 'claude-code' });
  });

  it('the refusal comment carries the reason and the fix', () => {
    const r = refused(evaluateAgentEligibility({ runConfig: rc({ agent: { adapter: 'codex' } }), templateDeliversRunConfig: true }));
    const comment = formatAgentIneligibleComment(r);
    expect(comment).toContain("Unknown agent adapter 'codex' — registered: claude-code");
    expect(comment).toContain('run_config.agent.adapter');
  });
});
