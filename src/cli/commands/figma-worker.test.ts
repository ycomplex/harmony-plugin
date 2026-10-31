import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMountedFigmaToken, renderFigmaMcp } from "../../agents/design-tools/figma.js";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { registerFigmaCommands } from "./figma.js";
import { getAuthenticatedContext } from "../auth.js";
vi.mock("../auth.js", () => ({ getAuthenticatedContext: vi.fn() }));
vi.mock("../../agents/design-tools/figma.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../agents/design-tools/figma.js")>(),
  readMountedFigmaToken: vi.fn(() => "fixture-access"),
}));
beforeEach(() => {
  vi.stubEnv(
    "HARMONY_FIGMA_CONTEXT_B64",
    Buffer.from(JSON.stringify({ state: "connected" })).toString("base64"),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});
it.each([{ state: "disconnected" }, { state: "reconnect" }, {
  state: "connected",
  access_expires_at: "2000-01-01T00:00:00Z",
}])("worker skips Figma installation for %j", async (meta) => {
  vi.mocked(getAuthenticatedContext).mockResolvedValue(
    { client: { rpc: async () => ({ data: meta, error: null }) } } as never,
  );
  const program = new Command();
  registerFigmaCommands(program);
  await program.parseAsync([
    "figma",
    "install-worker",
    "--adapter",
    "codex",
    "--plugin-dir",
    "/nonexistent",
  ], { from: "user" });
  expect(process.exitCode ?? 0).toBe(0);
});
it("auth or context transport failure cannot abort an unrelated worker", async () => {
  vi.mocked(getAuthenticatedContext).mockRejectedValue(
    new Error("unavailable"),
  );
  const program = new Command();
  registerFigmaCommands(program);
  await program.parseAsync([
    "figma",
    "install-worker",
    "--adapter",
    "codex",
    "--plugin-dir",
    "/nonexistent",
  ], { from: "user" });
  expect(process.exitCode ?? 0).toBe(0);
});

it("publishes an effective disconnected context for provision after a transport error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "figma-worker-"));
  const path = join(dir, "context");
  vi.stubEnv("HARMONY_FIGMA_WORKER_CONTEXT_FILE", path);
  vi.mocked(getAuthenticatedContext).mockRejectedValue(
    new Error("unavailable"),
  );
  try {
    const program = new Command();
    registerFigmaCommands(program);
    await program.parseAsync([
      "figma",
      "install-worker",
      "--adapter",
      "codex",
      "--plugin-dir",
      "/nonexistent",
    ], { from: "user" });
    expect(
      JSON.parse(Buffer.from(readFileSync(path, "utf8"), "base64").toString()),
    ).toEqual({ state: "disconnected", connections_enabled: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["absent", "existing", "duplicate", "header-only"])("Codex installation converges after two runs with %s Figma tables", async (initial) => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-31T12:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "figma-repeat-"));
  const meta = { state: "connected", connections_enabled: true, generation: 1,
    access_version: "access-1", pat_version: "pat-1", access_expires_at: "2026-11-01T12:00:00Z" };
  vi.stubEnv("HARMONY_FIGMA_CONTEXT_B64", Buffer.from(JSON.stringify(meta)).toString("base64"));
  vi.stubEnv("CODEX_HOME", dir);
  vi.mocked(getAuthenticatedContext).mockResolvedValue({ client: { rpc: async () => ({ data: meta, error: null }) } } as never);
  const before = 'model = "gpt-6.1-sol"\n[mcp_servers.harmony]\ncommand = "node"\n';
  const after = '[projects."/workspace"]\ntrust_level = "trusted"\n';
  const stale = '[mcp_servers.figma]\nurl = "https://stale.invalid"\n';
  const path = join(dir, "config.toml");
  writeFileSync(path, initial === "header-only" ? before + after + "[mcp_servers.figma]" : before + (initial === "absent" ? "" : stale.repeat(initial === "duplicate" ? 2 : 1)) + after);
  try {
    const install = async () => {
      const program = new Command();
      registerFigmaCommands(program);
      await program.parseAsync(["figma", "install-worker", "--adapter", "codex", "--plugin-dir", dir], { from: "user" });
      expect(process.exitCode ?? 0).toBe(0);
    };
    await install();
    const once = readFileSync(path, "utf8");
    await install();
    const twice = readFileSync(path, "utf8");
    expect(twice).toBe(once);
    expect(twice.match(/^\[mcp_servers\.figma\]$/gm)).toHaveLength(1);
    expect(twice).toContain(before);
    expect(twice).toContain(after);
    expect(twice).toContain(renderFigmaMcp("codex").trimStart());
    expect(twice).not.toContain("stale.invalid");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readMountedFigmaToken).toHaveBeenCalled();
    // Same real-CLI invocation as codex-drift.test.ts; no inherited credentials.
    const binary = process.env.HARMONY_CODEX_BIN ?? "codex";
    const available = spawnSync(binary, ["--version"], { encoding: "utf8" });
    if (initial === "existing" && available.status === 0) {
      const probe = (content: string) => {
        writeFileSync(path, content);
        const result = spawnSync(binary, ["exec", "--strict-config", "--skip-git-repo-check", "--json", "x"], {
          cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, CODEX_HOME: dir },
          encoding: "utf8", timeout: 8_000,
        });
        expect(result.error?.message ?? "").not.toMatch(/ENOENT/);
        return result.stdout + result.stderr;
      };
      expect(probe(twice)).not.toMatch(/Error loading config\.toml|unknown configuration field|duplicate key|duplicate table|invalid configuration/i);
      expect(probe(twice + renderFigmaMcp("codex"))).toMatch(/duplicate key|duplicate table/i);
      expect(probe('zzz_not_a_codex_key = 1\n' + twice)).toMatch(/unknown configuration field/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  }
}, 60_000);
