// B-1203 — pure planner for composing UX/UI option screens and flows in Figma. No network: it produces
// the ordered use_figma call plan; the skill executes it. See skills/harmony-visual-handoff/SKILL.md 3c.
//
// DEPENDENCIES (B-1201): the saved component map, the connection reader and the shared per-identity
// RateLimiter (10/min, 200/day). The stored record is B-1202's
// `design_artefact` (schema_version 1): tool, composed_at, provenance_notes, mcp_call_count, ordered
// nodes[{ id, name, caption, preview_attachment_id, preview_filename }] and, Figma only, file_key, file_url,
// version_id; no signed URLs. Not persisted until B-1202's capability exists.

export type Provenance = 'real' | 'invented' | 'illustrative' | 'human-in-tool'; // B-1204: 'human-in-tool' = a designer's edit read back from Figma

export interface ProvenanceNote {
  element: string;
  provenance: Provenance;
  note?: string;
}

/** Saved component map: logical component name -> library component key. */
export type ComponentMap = Record<string, string>;

export interface OptionInput {
  name: string;
  recommended?: boolean;
  /** Logical component names, each resolved to a library INSTANCE via the component map. */
  components: string[];
  provenance: ProvenanceNote[];
}

export interface FlowStepInput {
  name: string;
  caption: string;
  components: string[];
  provenance?: ProvenanceNote[];
}

export interface PlannedFrame {
  order: number;
  name: string;
  instances: Array<{ component: string; componentKey: string }>;
  recommended?: boolean;
  caption?: string;
  notes: string[];
}

export interface CompositionCall {
  tool: 'use_figma';
  purpose: 'compose' | 'fix';
  frames: PlannedFrame[];
}

export interface CompositionPlan {
  kind: 'options' | 'flow';
  calls: CompositionCall[];
  frames: PlannedFrame[];
  /** Components with no entry in the saved map: reported, never imported as raw layers. */
  unmapped: string[];
}

export const MCP_CALL_CAP = 6;
export const TYPICAL_MCP_CALLS = '2-3';

export type PlanInput = {
  ticket: string;
  componentMap: ComponentMap;
  cap?: number;
} & ({ options: OptionInput[]; flow?: undefined } | { flow: FlowStepInput[]; options?: undefined });

function noteLines(notes: ProvenanceNote[]): string[] {
  return notes.map((n) => `${n.provenance}: ${n.element}${n.note ? ` — ${n.note}` : ''}`);
}

export function planComposition(input: PlanInput): CompositionPlan {
  const unmapped = new Set<string>();
  const resolve = (components: string[]) =>
    components.flatMap((c) => {
      const key = input.componentMap[c];
      if (!key) { unmapped.add(c); return []; }
      return [{ component: c, componentKey: key }];
    });

  let frames: PlannedFrame[];
  let kind: 'options' | 'flow';
  if (input.options) {
    kind = 'options';
    const recommended = input.options.filter((o) => o.recommended);
    if (recommended.length !== 1) {
      throw new Error(`planComposition: exactly one option must be recommended, got ${recommended.length}`);
    }
    frames = input.options.map((o, i) => ({
      order: i + 1,
      name: `${input.ticket} · ${o.name}`,
      instances: resolve(o.components),
      ...(o.recommended ? { recommended: true } : {}),
      notes: [...(o.recommended ? ['Recommended'] : []), ...noteLines(o.provenance)],
    }));
  } else {
    kind = 'flow';
    frames = input.flow!.map((s, i) => ({
      order: i + 1,
      name: `${input.ticket} · ${i + 1}. ${s.name}`,
      instances: resolve(s.components),
      caption: s.caption,
      notes: noteLines(s.provenance ?? []),
    }));
  }
  // All frames are built in ONE use_figma call (typical budget 2-3 calls per leg).
  return { kind, frames, calls: [{ tool: 'use_figma', purpose: 'compose', frames }], unmapped: [...unmapped] };
}

/** Hard cap on MCP calls per leg. */
export class CallBudget {
  private used = 0;
  constructor(readonly cap: number = MCP_CALL_CAP) {}
  get count(): number { return this.used; }
  get exhausted(): boolean { return this.used >= this.cap; }
  /** Record one MCP call. Returns false (and does NOT count) once the cap is reached. */
  tryConsume(): boolean {
    if (this.exhausted) return false;
    this.used += 1;
    return true;
  }
  /** The line for the brief when composing had to stop at the cap; null while under it. */
  stopMessage(): string | null {
    return this.exhausted
      ? `Composing stopped at the ${this.cap}-call MCP cap for this leg (${this.used} used); remaining options were not composed in Figma.`
      : null;
  }
  /** The count recorded on the brief / sketch (`mcp_call_count`). */
  record(): number { return this.used; }
}

/** Shared per-identity limiter port (B-1201: 10/min, 200/day). Absent => no limiting. */
export interface RateLimiter {
  acquire(): Promise<void>;
}

/** Every MCP call must pass through this. */
export async function limited<T>(limiter: RateLimiter | undefined, call: () => Promise<T>): Promise<T> {
  if (limiter) await limiter.acquire();
  return call();
}

export interface FigmaVersion {
  id: string;
  created_at: string;
}

export type VersionWait = { ok: true; version: FigmaVersion } | { ok: false; message: string };

/** Measured 2026-10-27: autosave created a version 79 s after a compose. 15 s x 12 = 3 minutes. */
export const FRESHNESS_WAIT = { intervalMs: 15_000, maxAttempts: 12 } as const;

/** Poll for a file version created after `afterIso`; bounded, with injected attempts/interval/sleep. */
export async function waitForVersionAfter(opts: {
  listVersions: () => Promise<FigmaVersion[]>;
  afterIso: string;
  maxAttempts: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VersionWait> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const after = Date.parse(opts.afterIso);
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const versions = await opts.listVersions();
    const fresh = versions
      .filter((v) => Date.parse(v.created_at) > after)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (fresh) return { ok: true, version: fresh };
    if (attempt < opts.maxAttempts) await sleep(opts.intervalMs);
  }
  return {
    ok: false,
    message: `No Figma file version created after ${opts.afterIso} appeared in ${opts.maxAttempts} attempts; the new frames cannot be pinned for preview rendering.`,
  };
}

/**
 * Throttle (HTTP 429) backoff. Bounded: 5 attempts, 2 s doubling, never above 60 s. A retry is NEVER immediate.
 * CallBudget choice: a backoff wait is not a call, but every request actually issued is, so each retry
 * after a 429 calls `tryConsume()` once (the throttled attempt counted when it was issued). The hard cap
 * therefore still bounds total requests, and an exhausted cap stops the retries too.
 */
export const THROTTLE_BACKOFF = { baseMs: 2_000, maxMs: 60_000, maxAttempts: 5 } as const;

export type ThrottleDelay = { retry: true; delayMs: number } | { retry: false; reason: 'backoff-exhausted' };

/**
 * Pure: the wait before retrying a throttled call. `attempt` is the 1-based number of the throttled
 * attempt just made. Retry-After (seconds) wins when present and positive, capped at maxMs; otherwise
 * exponential baseMs * 2^(attempt-1), capped at maxMs. The delay is always at least 1 ms.
 */
export function nextThrottleDelay(opts: {
  attempt: number;
  retryAfterSeconds?: number;
  baseMs?: number;
  maxMs?: number;
  maxAttempts?: number;
}): ThrottleDelay {
  const baseMs = Math.max(1, opts.baseMs ?? THROTTLE_BACKOFF.baseMs);
  const maxMs = Math.max(1, opts.maxMs ?? THROTTLE_BACKOFF.maxMs);
  const maxAttempts = opts.maxAttempts ?? THROTTLE_BACKOFF.maxAttempts;
  if (opts.attempt >= maxAttempts) return { retry: false, reason: 'backoff-exhausted' };
  const ra = opts.retryAfterSeconds;
  const raw = ra !== undefined && Number.isFinite(ra) && ra > 0
    ? ra * 1000
    : baseMs * 2 ** Math.max(0, opts.attempt - 1);
  return { retry: true, delayMs: Math.max(1, Math.min(maxMs, Math.ceil(raw))) };
}
