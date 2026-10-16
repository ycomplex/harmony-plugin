// B-1078: the runtime / credential-kind / cost-regime facts `harmony leg-cost record` stamps on a row.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRuntimeFacts } from './leg-cost.js';

const SECRET = 'sk-ant-oat-SECRET';
const envelope = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 's1',
  total_cost_usd: 0.1,
  usage: { input_tokens: 1, output_tokens: 2 },
});

afterEach(() => vi.restoreAllMocks());

describe('resolveRuntimeFacts', () => {
  it('subscription token => claude-code / subscription-token / plan-included', () => {
    const f = resolveRuntimeFacts(envelope, 'claude-opus-5', {}, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(f).toEqual({ runtime: 'claude-code', credential_kind: 'subscription-token', cost_regime: 'plan-included' });
    expect(JSON.stringify(f)).not.toContain(SECRET);
  });

  it('api key => metered', () => {
    const f = resolveRuntimeFacts(envelope, null, {}, { ANTHROPIC_API_KEY: 'sk-ant-api-SECRET' }, {});
    expect(f).toEqual({ runtime: 'claude-code', credential_kind: 'api-key', cost_regime: 'metered' });
  });

  it('an unparseable capture still records the env-derived facts', () => {
    const f = resolveRuntimeFacts('not json', null, {}, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(f).toEqual({ runtime: 'claude-code', credential_kind: 'subscription-token', cost_regime: 'plan-included' });
  });

  it('no credential => runtime only, credential and regime null', () => {
    const f = resolveRuntimeFacts(envelope, null, {}, {}, {});
    expect(f).toEqual({ runtime: 'claude-code', credential_kind: null, cost_regime: null });
  });

  it('an unresolvable adapter => all null, never throws', () => {
    const f = resolveRuntimeFacts(envelope, null, {}, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, { agent: { adapter: 'nope' } } as never);
    expect(f).toEqual({ runtime: null, credential_kind: null, cost_regime: null });
  });

  it('a valid credential-kind override wins and re-derives the regime', () => {
    const f = resolveRuntimeFacts(envelope, null, { credentialKind: 'api-key' }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(f.credential_kind).toBe('api-key');
    expect(f.cost_regime).toBe('metered');
  });

  it('an invalid credential-kind override is ignored with a stderr warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = resolveRuntimeFacts(envelope, null, { credentialKind: 'bogus' }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(f.credential_kind).toBe('subscription-token');
    expect(err).toHaveBeenCalledOnce();
  });

  it('an inconsistent cost-regime override is ignored (derived wins) with a warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = resolveRuntimeFacts(envelope, null, { costRegime: 'metered' }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(f.cost_regime).toBe('plan-included');
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('a consistent cost-regime override is silent', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveRuntimeFacts(envelope, null, { costRegime: 'plan-included' }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(err).not.toHaveBeenCalled();
  });

  it('a runtime override replaces the adapter id', () => {
    const f = resolveRuntimeFacts(envelope, null, { runtime: 'codex' }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, {});
    expect(f.runtime).toBe('codex');
  });
});
