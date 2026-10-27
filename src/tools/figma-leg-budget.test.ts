import { it, expect } from "vitest";
import {
  emptyBudget,
  reserveCall,
  recordThrottle,
  resumeBudget,
} from "./figma-leg-budget.js";
const now = Date.parse("2026-10-27T12:00:00Z");
it("honors Retry-After beyond fallback ceiling and refuses immediate retries", () => {
  const state = recordThrottle({ ...emptyBudget(), used: 1 }, now, "120");
  expect(state.retry_at).toBe(now + 120000);
  expect(reserveCall(state, now + 60000).reason).toBe("backoff-wait");
  expect(reserveCall(state, now + 120000).allowed).toBe(true);
});
it("supports HTTP-date, bounded fallback, and persistent-throttle question/resume", () => {
  expect(
    recordThrottle(emptyBudget(), now, "Tue, 27 Oct 2026 12:05:00 GMT")
      .retry_at,
  ).toBe(now + 300000);
  let state = { ...emptyBudget(), used: 5 };
  for (let i = 0; i < 5; i++) state = recordThrottle(state, now);
  expect(reserveCall(state, now + 999999).reason).toBe("operator-question");
  state = resumeBudget(JSON.parse(JSON.stringify(state)), now + 1000, now);
  expect(state.used).toBe(5);
  expect(reserveCall(state, now).allowed).toBe(false);
  const last = reserveCall(state, now + 1000);
  expect(last.allowed).toBe(true);
  expect(reserveCall(last.state, now + 1000).reason).toBe("six-call-cap");
});
