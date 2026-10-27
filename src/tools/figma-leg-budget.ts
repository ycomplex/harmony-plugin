export interface LegBudget {
  used: number;
  throttles: number;
  retry_at: number;
  needs_answer: boolean;
}
export const emptyBudget = (): LegBudget => ({
  used: 0,
  throttles: 0,
  retry_at: 0,
  needs_answer: false,
});
export function reserveCall(
  state: LegBudget,
  now: number,
): { allowed: boolean; reason?: string; state: LegBudget } {
  if (state.needs_answer)
    return { allowed: false, reason: "operator-question", state };
  if (state.retry_at > now)
    return { allowed: false, reason: "backoff-wait", state };
  if (state.used >= 6) return { allowed: false, reason: "six-call-cap", state };
  return { allowed: true, state: { ...state, used: state.used + 1 } };
}
export function recordThrottle(
  state: LegBudget,
  now: number,
  retryAfter?: string,
): LegBudget {
  const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
  const date = retryAfter === undefined ? NaN : Date.parse(retryAfter);
  const specified =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Number.isFinite(date)
        ? date - now
        : NaN;
  const delay =
    Number.isFinite(specified) && specified > 0
      ? specified
      : Math.min(60000, 2000 * 2 ** state.throttles);
  return {
    ...state,
    throttles: state.throttles + 1,
    retry_at: now + Math.max(1, delay),
    needs_answer: state.throttles + 1 >= 5,
  };
}
export function resumeBudget(
  state: LegBudget,
  resumeAt: number,
  now: number,
): LegBudget {
  if (!state.needs_answer || !Number.isFinite(resumeAt) || resumeAt < now)
    throw new Error("A future operator-supplied resume time is required");
  return { ...state, needs_answer: false, throttles: 0, retry_at: resumeAt };
}
