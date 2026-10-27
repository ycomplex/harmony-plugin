import { it, expect } from "vitest";
import { assertFigmaReady, renderFigmaMcp } from "./figma.js";
import { parseFigmaRedirect } from "./oauth.js";
const now = Date.parse("2026-10-27T12:00:00Z");
it("configured failures never fall back, while absence needs no token", () => {
  expect(() => assertFigmaReady({ state: "disconnected" }, now)).not.toThrow();
  expect(() => assertFigmaReady({ state: "reconnect" }, now)).toThrow(
    "reconnection",
  );
  expect(() =>
    assertFigmaReady(
      { state: "connected", access_expires_at: "2026-10-26T12:00:00Z" },
      now,
    ),
  ).toThrow("reconnection");
});
it("renders native transport auth without OAuth credentials or refresh-token paths", () => {
  const claude = JSON.parse(renderFigmaMcp("claude-code", "fixture-access"));
  expect(claude).toEqual({
    type: "http",
    url: "https://mcp.figma.com/mcp",
    headers: { Authorization: "Bearer fixture-access" },
  });
  const codex = renderFigmaMcp("codex");
  expect(codex).toContain('bearer_token_env_var = "FIGMA_MCP_ACCESS_TOKEN"');
  expect(codex).not.toContain("fixture-access");
  expect(codex).not.toContain("refresh");
});
it("validates OAuth redirect origin, state, issuer and code", () => {
  expect(
    parseFigmaRedirect(
      "http://localhost:1457/callback?state=fixture&code=one",
      "fixture",
    ),
  ).toBe("one");
  for (const url of [
    "https://evil.invalid/callback?state=fixture&code=one",
    "http://localhost:1457/callback?state=wrong&code=one",
    "http://localhost:1457/callback?state=fixture",
    "http://localhost:1457/callback?state=fixture&code=one&iss=https://evil.invalid",
  ])
    expect(() => parseFigmaRedirect(url, "fixture")).toThrow();
});
