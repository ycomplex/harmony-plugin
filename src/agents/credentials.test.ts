// B-1075 / B-934: the credential vocabulary, the derived cost regime, and the policy validator.

import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_MODES,
  CREDENTIAL_VOCABULARY,
  deriveCostRegime,
  validateCredentialDeclaration,
  type CredentialMode,
} from './credentials.js';

describe('B-934 vocabulary', () => {
  it('Claude Code speaks subscription-token and api-key', () => {
    expect(CREDENTIAL_VOCABULARY['claude-code']).toEqual(['subscription-token', 'api-key']);
  });
  it('Codex speaks login-cache, api-key, workload-identity, enterprise-access-token', () => {
    expect(CREDENTIAL_VOCABULARY.codex).toEqual(['login-cache', 'api-key', 'workload-identity', 'enterprise-access-token']);
  });
});

describe('deriveCostRegime', () => {
  it.each<[CredentialMode, string]>([
    ['login-cache', 'plan-included'],
    ['enterprise-access-token', 'plan-included'],
    ['subscription-token', 'plan-included'],
    ['api-key', 'metered'],
    ['workload-identity', 'metered'],
  ])('%s ⇒ %s', (credential, regime) => {
    expect(deriveCostRegime(credential)).toBe(regime);
  });
  it('covers every credential mode', () => {
    for (const c of CREDENTIAL_MODES) expect(['plan-included', 'metered']).toContain(deriveCostRegime(c));
  });
  it('throws on an unknown credential', () => {
    expect(() => deriveCostRegime('password' as CredentialMode)).toThrow(/Unknown credential mode/);
  });
});

describe('validateCredentialDeclaration', () => {
  it('dogfood accepts plan-included', () => {
    const r = validateCredentialDeclaration({ deployment: 'dogfood', credential: 'subscription-token' });
    expect(r).toEqual({ ok: true, errors: [], costRegime: 'plan-included', warnAt: null });
  });
  it('dogfood refuses metered, even with a ceiling', () => {
    const r = validateCredentialDeclaration({ deployment: 'dogfood', credential: 'api-key', spendCeiling: 100 });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/Dogfood permits plan-included/);
  });
  it('production accepts plan-included', () => {
    expect(validateCredentialDeclaration({ deployment: 'production', credential: 'login-cache' }).ok).toBe(true);
  });
  it('production metered without a ceiling is a loud config error', () => {
    const r = validateCredentialDeclaration({ deployment: 'production', credential: 'workload-identity' });
    expect(r.ok).toBe(false);
    expect(r.costRegime).toBe('metered');
    expect(r.errors.join()).toMatch(/requires a declared spend ceiling/);
  });
  it('production metered with a ceiling defaults warn_at to 80%', () => {
    const r = validateCredentialDeclaration({ deployment: 'production', credential: 'api-key', spendCeiling: 500 });
    expect(r).toEqual({ ok: true, errors: [], costRegime: 'metered', warnAt: 400 });
  });
  it('honours an explicit warn_at and rejects one above the ceiling', () => {
    expect(validateCredentialDeclaration({ deployment: 'production', credential: 'api-key', spendCeiling: 500, warnAt: 250 }).warnAt).toBe(250);
    expect(validateCredentialDeclaration({ deployment: 'production', credential: 'api-key', spendCeiling: 500, warnAt: 600 }).ok).toBe(false);
  });
  it('rejects a non-positive ceiling', () => {
    expect(validateCredentialDeclaration({ deployment: 'production', credential: 'api-key', spendCeiling: 0 }).ok).toBe(false);
  });
  it('rejects a ceiling on a plan-included credential', () => {
    expect(validateCredentialDeclaration({ deployment: 'production', credential: 'subscription-token', spendCeiling: 10 }).ok).toBe(false);
  });
  it('rejects a credential outside the runtime vocabulary', () => {
    const r = validateCredentialDeclaration({ deployment: 'production', credential: 'login-cache', runtime: 'claude-code' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/not in the claude-code vocabulary/);
  });
  it('rejects an unknown credential without throwing', () => {
    const r = validateCredentialDeclaration({ deployment: 'production', credential: 'password' as CredentialMode });
    expect(r).toMatchObject({ ok: false, costRegime: null });
  });
});
