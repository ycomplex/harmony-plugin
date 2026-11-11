import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
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
  // B-1451: install-worker checks the token with one POST; never reach the network from a test.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  vi.stubEnv(
    "HARMONY_FIGMA_CONTEXT_B64",
    Buffer.from(JSON.stringify({ state: "connected" })).toString("base64"),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
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

// --- B-1451: the Claude config leaves every checkout; the token check; non-fatal failures. ----------
describe("B-1451 install-worker", () => {
  const meta = { state: "connected", connections_enabled: true, generation: 1,
    access_version: "access-1", pat_version: "pat-1", access_expires_at: "2999-01-01T00:00:00Z" };
  let dir: string;
  let stderr: string[];
  let stdout: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b1451-figma-"));
    mkdirSync(join(dir, "plugin"));
    writeFileSync(join(dir, "plugin", ".mcp.json"), "{}");
    vi.stubEnv("HARMONY_FIGMA_CONTEXT_B64", Buffer.from(JSON.stringify(meta)).toString("base64"));
    vi.stubEnv("HARMONY_FIGMA_MCP_CONFIG", join(dir, "home", ".harmony", "figma-mcp.json"));
    vi.stubEnv("HARMONY_FIGMA_WORKER_CONTEXT_FILE", join(dir, "context"));
    vi.mocked(getAuthenticatedContext).mockResolvedValue({ client: { rpc: async () => ({ data: meta, error: null }) } } as never);
    stderr = []; stdout = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => { stderr.push(String(c)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation((c) => { stdout.push(String(c)); return true; });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = async (adapter = "claude-code") => {
    const program = new Command();
    registerFigmaCommands(program);
    await program.parseAsync(["figma", "install-worker", "--adapter", adapter, "--plugin-dir", join(dir, "plugin")], { from: "user" });
  };
  const target = () => join(dir, "home", ".harmony", "figma-mcp.json");

  it("writes the --mcp-config file in $HOME (0700/0600) and nothing under --plugin-dir", async () => {
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(readFileSync(join(dir, "plugin", ".mcp.json"), "utf8")).toBe("{}");
    expect(readdirSync(join(dir, "plugin"))).toEqual([".mcp.json"]);
    const doc = JSON.parse(readFileSync(target(), "utf8"));
    expect(doc.mcpServers.figma.type).toBe("http");
    expect(doc.mcpServers.figma.url).toBe("https://mcp.figma.com/mcp");
    expect(doc.mcpServers.figma.headers.Authorization).toBe("Bearer ${FIGMA_MCP_ACCESS_TOKEN}");
    expect(readFileSync(target(), "utf8")).not.toContain("fixture-access");
    expect(statSync(target()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "home", ".harmony")).mode & 0o777).toBe(0o700);
    expect(stdout.join("")).toContain(target());
    expect(stdout.join("") + stderr.join("")).not.toContain("fixture-access");
  });
  it("refuses a target inside a git work tree, non-fatally", async () => {
    mkdirSync(join(dir, "home", ".git"), { recursive: true });
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(target())).toBe(false);
    expect(stderr.join("")).toMatch(/refusing to write the Figma server config inside a git work tree/);
  });
  it.each([401, 403])("HTTP %i: configures nothing and prints one skip line", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(target())).toBe(false);
    expect(stderr.join("")).toBe(`Figma: the connection token failed to authenticate (HTTP ${status}); this leg runs without Figma.\n`);
    expect(JSON.parse(Buffer.from(readFileSync(join(dir, "context"), "utf8"), "base64").toString()).state).toBe("reconnect");
  });
  it("timeout: configures Figma as optional with one line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }));
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(target())).toBe(true);
    expect(stderr.join("")).toBe("Figma: could not verify the connection token (timed out); Figma is configured as optional for this leg.\n");
  });
  it("5xx: configures Figma as optional", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await run();
    expect(stderr.join("")).toContain("could not verify the connection token (HTTP 503)");
  });
  it("any failure exits 0 with one line", async () => {
    vi.mocked(readMountedFigmaToken).mockImplementationOnce(() => { throw new Error("no mount"); });
    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr.join("")).toBe("Figma: configuration failed; this leg runs without Figma.\n");
  });
  it("sends one initialize POST with the bearer and a timeout signal", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await run();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://mcp.figma.com/mcp");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).method).toBe("initialize");
    expect(init.signal).toBeDefined();
  });
  it("codex: the Figma block is optional", () => {
    expect(renderFigmaMcp("codex")).toContain("required = false");
    expect(renderFigmaMcp("codex")).not.toContain("required = true");
  });
});
