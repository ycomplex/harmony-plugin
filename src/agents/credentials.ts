// B-1075 / B-934: the credential and cost-regime vocabulary every agent adapter speaks.
//
// Pure data + pure functions, no I/O. This module IS the B-934 policy (Accepted) in code:
//
//  - Each runtime family has a fixed credential vocabulary. Claude Code: `subscription-token`
//    (CLAUDE_CODE_OAUTH_TOKEN, long-lived, minted via `claude setup-token`) and `api-key`. Codex:
//    `login-cache`, `api-key`, `workload-identity`, `enterprise-access-token`. The Codex vocabulary
//    is carried as data here because it is policy; there is no Codex adapter yet (B-1076).
//  - The cost regime is DERIVED from the credential, never chosen: login-cache,
//    enterprise-access-token and subscription-token are `plan-included`; api-key and
//    workload-identity are `metered`.
//  - Dogfood permits plan-included only. Production permits plan-included, and metered only with a
//    declared spend ceiling (per deployment, per calendar month, no default) plus a warn_at
//    threshold (default 80% of the ceiling). Metered without a ceiling is a loud config error.
//  - There is no silent fallback between regimes: two credentials present at once is a config
//    error, not a precedence rule (enforced per adapter through its auth seam).

export type RuntimeFamily = 'claude-code' | 'codex';

export type CredentialMode =
  | 'subscription-token'
  | 'api-key'
  | 'login-cache'
  | 'workload-identity'
  | 'enterprise-access-token';

export type CostRegime = 'plan-included' | 'metered';

export type Deployment = 'dogfood' | 'production';

/** Every credential mode, in a stable order. */
export const CREDENTIAL_MODES: readonly CredentialMode[] = [
  'subscription-token',
  'api-key',
  'login-cache',
  'workload-identity',
  'enterprise-access-token',
];

/** The credential vocabulary per runtime family (B-934). */
export const CREDENTIAL_VOCABULARY: Readonly<Record<RuntimeFamily, readonly CredentialMode[]>> = {
  'claude-code': ['subscription-token', 'api-key'],
  codex: ['login-cache', 'api-key', 'workload-identity', 'enterprise-access-token'],
};

/** The one derivation table. Adapters never declare a regime of their own. */
export const COST_REGIME_BY_CREDENTIAL: Readonly<Record<CredentialMode, CostRegime>> = {
  'login-cache': 'plan-included',
  'enterprise-access-token': 'plan-included',
  'subscription-token': 'plan-included',
  'api-key': 'metered',
  'workload-identity': 'metered',
};

/** Default warn_at, as a fraction of the spend ceiling. */
export const DEFAULT_WARN_AT_FRACTION = 0.8;

export function isCredentialMode(value: unknown): value is CredentialMode {
  return typeof value === 'string' && (CREDENTIAL_MODES as readonly string[]).includes(value);
}

/** Derive the cost regime from a credential. Throws on a value outside the vocabulary. */
export function deriveCostRegime(credential: CredentialMode): CostRegime {
  if (!isCredentialMode(credential)) {
    throw new Error(`Unknown credential mode '${String(credential)}' — expected one of: ${CREDENTIAL_MODES.join(', ')}`);
  }
  return COST_REGIME_BY_CREDENTIAL[credential];
}

export interface CredentialDeclaration {
  deployment: Deployment;
  credential: CredentialMode;
  /** When given, the credential must be in this runtime family's vocabulary. */
  runtime?: RuntimeFamily;
  /** Spend ceiling in USD, per deployment per calendar month. No default. */
  spendCeiling?: number;
  /** Warning threshold in USD. Defaults to 80% of the ceiling. */
  warnAt?: number;
}

export interface CredentialValidation {
  ok: boolean;
  errors: string[];
  /** The derived regime, or null when the credential itself is not in the vocabulary. */
  costRegime: CostRegime | null;
  /** The effective warn_at for a valid metered declaration; null otherwise. */
  warnAt: number | null;
}

/** Validate one deployment's credential declaration against the B-934 policy. Never throws. */
export function validateCredentialDeclaration(decl: CredentialDeclaration): CredentialValidation {
  const errors: string[] = [];
  const fail = (costRegime: CostRegime | null): CredentialValidation => ({ ok: false, errors, costRegime, warnAt: null });

  if (decl.deployment !== 'dogfood' && decl.deployment !== 'production') {
    errors.push(`Unknown deployment '${String(decl.deployment)}' — expected 'dogfood' or 'production'.`);
  }
  if (!isCredentialMode(decl.credential)) {
    errors.push(`Unknown credential mode '${String(decl.credential)}' — expected one of: ${CREDENTIAL_MODES.join(', ')}.`);
    return fail(null);
  }
  if (decl.runtime !== undefined) {
    const vocab = CREDENTIAL_VOCABULARY[decl.runtime];
    if (!vocab) {
      errors.push(`Unknown runtime '${String(decl.runtime)}'.`);
    } else if (!vocab.includes(decl.credential)) {
      errors.push(`Credential '${decl.credential}' is not in the ${decl.runtime} vocabulary (${vocab.join(', ')}).`);
    }
  }

  const costRegime = deriveCostRegime(decl.credential);
  const hasCeiling = decl.spendCeiling !== undefined;
  const ceilingValid = typeof decl.spendCeiling === 'number' && Number.isFinite(decl.spendCeiling) && decl.spendCeiling > 0;

  if (costRegime === 'plan-included') {
    if (hasCeiling || decl.warnAt !== undefined) {
      errors.push(`Credential '${decl.credential}' is plan-included; a spend ceiling / warn_at applies only to a metered credential.`);
    }
    return errors.length ? fail(costRegime) : { ok: true, errors, costRegime, warnAt: null };
  }

  // metered
  if (decl.deployment === 'dogfood') {
    errors.push(`Dogfood permits plan-included credentials only; '${decl.credential}' is metered.`);
    return fail(costRegime);
  }
  if (!hasCeiling) {
    errors.push(`Metered credential '${decl.credential}' in production requires a declared spend ceiling (USD per calendar month; there is no default).`);
    return fail(costRegime);
  }
  if (!ceilingValid) {
    errors.push(`Spend ceiling must be a positive finite number of USD; got ${String(decl.spendCeiling)}.`);
    return fail(costRegime);
  }
  const ceiling = decl.spendCeiling as number;
  const warnAt = decl.warnAt ?? ceiling * DEFAULT_WARN_AT_FRACTION;
  if (!Number.isFinite(warnAt) || warnAt <= 0 || warnAt > ceiling) {
    errors.push(`warn_at must be a positive number no greater than the spend ceiling (${ceiling}); got ${String(decl.warnAt)}.`);
    return fail(costRegime);
  }
  return errors.length ? fail(costRegime) : { ok: true, errors, costRegime, warnAt };
}
