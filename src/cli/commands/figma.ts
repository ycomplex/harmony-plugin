import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  assertFigmaReady,
  type FigmaMetadata,
  readMountedFigmaToken,
  renderFigmaMcp,
} from "../../agents/design-tools/figma.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getAuthenticatedContext } from "../auth.js";
import {
  emptyBudget,
  type LegBudget,
  recordThrottle,
  reserveCall,
  resumeBudget,
} from "../../tools/figma-leg-budget.js";
import { parseFigmaRedirect } from "../../agents/design-tools/oauth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Keep tokens, redirect codes and PKCE secrets out of terminal echo/history and disk. */
async function secretPrompt(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Use an interactive terminal for credential entry");
  }
  process.stderr.write(prompt);
  const output = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

async function authorizeFigma(): Promise<Record<string, unknown>> {
  const state = randomUUID();
  let info: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = "";
  const provider: OAuthClientProvider = {
    redirectUrl: "http://localhost:1457/callback",
    clientMetadata: {
      client_name: "Harmony workspace Figma",
      redirect_uris: ["http://localhost:1457/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "mcp:connect",
    },
    state: () => state,
    clientInformation: () => info,
    saveClientInformation: (value) => {
      info = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    redirectToAuthorization: (url) => {
      process.stderr.write(
        `Approve Figma in your browser, then copy the final redirect URL (a localhost error is expected):\n${url.href}\n`,
      );
    },
  };
  const serverUrl = "https://mcp.figma.com/mcp";
  await auth(provider, { serverUrl, scope: "mcp:connect" });
  if (!tokens) {
    const code = parseFigmaRedirect(
      await secretPrompt("Paste the final redirect URL (hidden): "),
      state,
    );
    await auth(provider, {
      serverUrl,
      scope: "mcp:connect",
      authorizationCode: code,
    });
  }
  const saved = tokens as OAuthTokens | undefined;
  if (!saved?.refresh_token || !saved.expires_in || !info) {
    throw new Error("Figma did not issue a complete expiring OAuth grant");
  }
  return {
    ...saved,
    ...info,
    expires_at: Date.now() + saved.expires_in * 1000,
    token_endpoint: "https://api.figma.com/v1/oauth/token",
  };
}

export function registerFigmaCommands(program: Command): void {
  const figma = program
    .command("figma")
    .description(
      "Workspace Figma connection (credentials are never retrievable)",
    );
  figma
    .command("budget")
    .option("--reserve", "Reserve one actual MCP attempt")
    .option("--throttled", "Record a 429")
    .option("--retry-after <value>", "Retry-After header")
    .option("--resume-at <iso>", "Operator-supplied resume time")
    .option("--close", "Close this logical leg after its design work completes")
    .action(
      (opts: {
        reserve?: boolean;
        throttled?: boolean;
        retryAfter?: string;
        resumeAt?: string;
        close?: boolean;
      }) => {
        const conduction = process.env.HARMONY_CONDUCTION_ID,
          leg = process.env.HARMONY_LEG;
        if (
          !conduction ||
          !/^[a-zA-Z0-9-]+$/.test(conduction) ||
          !leg ||
          !/^\d+$/.test(leg)
        ) {
          throw new Error(
            "Per-leg budget requires a conduction id and leg number",
          );
        }
        // All launchers persist .claude/projects per conduction. A throttle answer starts a new
        // physical worker leg; its active pointer must still select the original logical call budget.
        const dir = join(
          homedir(),
          ".claude",
          "projects",
          ".figma-budgets",
          conduction,
        );
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const active = join(dir, "active"),
          lock = join(dir, "lock");
        mkdirSync(lock, { mode: 0o700 }); // No lock stealing: ambiguity fails closed.
        try {
          const sourceLeg = existsSync(active)
            ? readFileSync(active, "utf8")
            : leg;
          if (!/^\d+$/.test(sourceLeg)) {
            throw new Error("Invalid persisted Figma budget identity");
          }
          const file = join(dir, `${sourceLeg}.json`);
          if (opts.close) {
            rmSync(active, { force: true });
            console.log("Figma logical leg budget closed; counters retained.");
            return;
          }
          writeFileSync(active, sourceLeg, { mode: 0o600 });
          let state: LegBudget = existsSync(file)
            ? JSON.parse(readFileSync(file, "utf8"))
            : emptyBudget();
          const now = Date.now();
          let outcome: Record<string, unknown> = {};
          if (opts.throttled) {
            state = recordThrottle(state, now, opts.retryAfter);
          }
          if (opts.resumeAt) {
            state = resumeBudget(state, Date.parse(opts.resumeAt), now);
          }
          if (opts.reserve) {
            const result = reserveCall(state, now);
            state = result.state;
            outcome = { allowed: result.allowed, reason: result.reason };
          }
          writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
          renameSync(file + ".tmp", file);
          console.log(
            JSON.stringify({ ...outcome, ...state, source_leg: sourceLeg }),
          );
        } finally {
          rmSync(lock, { recursive: true });
        }
      },
    );
  figma.command("context").action(async () => {
    try {
      const ctx = await getAuthenticatedContext();
      const { data, error } = await ctx.client.rpc("figma_launch_context", {
        p_project_id: ctx.projectId,
      });
      if (error) {
        if (error.code === "PGRST202" || error.code === "42883") {
          process.stdout.write('{"state":"disconnected"}\n');
          return;
        }
        throw error;
      }
      process.stdout.write(JSON.stringify(data) + "\n");
    } catch {
      process.stderr.write(
        "Figma context unavailable; refusing configured Figma work.\n",
      );
      process.exitCode = 1;
    }
  });
  figma
    .command("install-worker")
    .requiredOption("--adapter <adapter>", "claude-code or codex")
    .requiredOption("--plugin-dir <path>", "Plugin checkout")
    .action(async (opts: { adapter: string; pluginDir: string }) => {
      try {
        // Older launchers cannot name Figma mounts. Connections are enabled only after
        // Conductor Update; tolerate the legacy no-context path until that ordered rollout.
        if (!process.env.HARMONY_FIGMA_CONTEXT_B64) return;
        const frozen: FigmaMetadata = JSON.parse(
          Buffer.from(
            process.env.HARMONY_FIGMA_CONTEXT_B64 ?? "",
            "base64",
          ).toString() || '{"state":"disconnected"}',
        );
        if (frozen.state === "disconnected" || frozen.state === "reconnect") return;
        let meta: FigmaMetadata;
        try {
          const ctx = await getAuthenticatedContext();
          const { data, error } = await ctx.client.rpc("figma_launch_context", {
            p_project_id: ctx.projectId,
          });
          if (error) throw error;
          meta = data ?? { state: "disconnected" };
        } catch {
          process.stderr.write(
            "Figma preflight unavailable; continuing without Figma.\n",
          );
          return;
        }
        if (
          meta.state === "disconnected" || meta.state === "reconnect" ||
          (Number.isFinite(Date.parse(meta.access_expires_at ?? "")) &&
            Date.parse(meta.access_expires_at ?? "") <= Date.now())
        ) {
          process.stderr.write(
            "Figma unavailable; Figma-dependent work requires reconnect.\n",
          );
          return;
        }
        assertFigmaReady(meta, Date.now());
        if (
          (meta.generation !== frozen.generation ||
            meta.access_version !== frozen.access_version ||
            meta.pat_version !== frozen.pat_version)
        ) {
          throw new Error(
            "Figma connection changed since launch; rerun the leg",
          );
        }
        const token = readMountedFigmaToken();
        if (opts.adapter === "codex") {
          const path = join(
            process.env.CODEX_HOME ?? join(homedir(), ".codex"),
            "config.toml",
          );
          writeFileSync(
            path,
            readFileSync(path, "utf8") + renderFigmaMcp("codex"),
            { mode: 0o600 },
          );
          chmodSync(path, 0o600);
        } else if (opts.adapter === "claude-code") {
          const path = join(opts.pluginDir, ".mcp.json");
          const config = JSON.parse(readFileSync(path, "utf8"));
          config.figma = JSON.parse(renderFigmaMcp("claude-code", token));
          writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
          chmodSync(path, 0o600);
        } else throw new Error("Unknown Figma runtime adapter");
        process.stdout.write("Figma access-token-only runtime configured.\n");
      } catch {
        process.stderr.write(
          "Figma preflight/configuration failed. Reconnect or relaunch; no fallback.\n",
        );
        process.exitCode = 1;
      }
    });
  figma
    .command("connect")
    .description(
      "Authorize Figma in your browser and supply a REST PAT in a hidden prompt",
    )
    .action(async () => {
      try {
        const ctx = await getAuthenticatedContext();
        const { data: project, error: projectError } = await ctx.client
          .from("projects")
          .select("workspace_id")
          .eq("id", ctx.projectId)
          .single();
        if (projectError || !project) {
          throw new Error("Project workspace unavailable");
        }
        const { data: membership } = await ctx.client
          .from("workspace_members")
          .select("role")
          .eq("workspace_id", project.workspace_id)
          .eq("user_id", ctx.userId)
          .single();
        if (membership?.role !== "owner") {
          throw new Error("Workspace owner required");
        }
        const { data: current, error: contextError } = await ctx.client.rpc(
          "figma_launch_context",
          { p_project_id: ctx.projectId },
        );
        if (contextError) throw new Error("Connection schema unavailable");
        if (current?.connections_enabled !== true) {
          throw new Error("Figma connections are not enabled");
        }
        let grant: Record<string, unknown>;
        try {
          grant = await authorizeFigma();
        } catch {
          throw new Error(
            "Figma OAuth authorization failed; retry harmony figma connect.",
          );
        }
        const identityClient = new Client({
          name: "harmony-figma-connect",
          version: "1",
        });
        try {
          await identityClient.connect(
            new StreamableHTTPClientTransport(
              new URL("https://mcp.figma.com/mcp"),
              {
                requestInit: {
                  headers: { Authorization: `Bearer ${grant.access_token}` },
                },
              },
            ),
          );
          const who = await identityClient.callTool({
            name: "whoami",
            arguments: {},
          });
          let identity = who.structuredContent as
            | { handle?: string; plans?: unknown }
            | undefined;
          if (!identity) {
            for (
              const content of who.content as Array<{
                type: string;
                text?: string;
              }>
            ) {
              if (content.type === "text" && content.text) {
                try {
                  identity = JSON.parse(content.text);
                  break;
                } catch {
                  /* next block */
                }
              }
            }
          }
          if (
            who.isError ||
            !identity?.handle ||
            !Array.isArray(identity.plans)
          ) {
            throw new Error();
          }
          const plans = identity.plans.map(
            (p: { name?: string; seat?: string; tier?: string }) => ({
              name: p.name,
              seat: p.seat,
              tier: p.tier,
            }),
          );
          process.stderr.write(
            `Verified Figma identity/plans: ${
              JSON.stringify({ handle: identity.handle, plans })
            }\n`,
          );
        } catch {
          throw new Error(
            "Figma whoami could not verify the candidate identity/plans",
          );
        } finally {
          await identityClient.close();
        }
        const pat = await secretPrompt("REST personal access token (hidden): ");
        const fileKey = await secretPrompt("Library file key: ");
        const planName = await secretPrompt(
          "Exact library-owning plan name shown by Figma: ",
        );
        if (
          (await secretPrompt(
            "Confirm this plan owns the library file (yes): ",
          )) !== "yes"
        ) {
          throw new Error("Library plan not confirmed");
        }
        const input = {
          workspace_id: project.workspace_id,
          generation: current?.generation ?? 0,
          grant,
          pat,
          library_file_key: fileKey,
          plan_name: planName,
          confirm_library_plan: true,
          component_map: current?.component_map ?? {},
        };
        const invoke = async (body: Record<string, unknown>) => {
          const { data, error } = await ctx.client.functions.invoke(
            "figma-connect",
            { body },
          );
          if (error || data?.error) {
            let message = data?.error;
            if (
              !message && error && "context" in error &&
              error.context instanceof Response
            ) {
              try {
                message = (await error.context.json()).error;
              } catch { /* use safe fallback */ }
            }
            if (typeof message === "string") throw new Error(message);
            throw new Error(
              "Figma validation/publication failed; previous connection remains active. Check identity/library/seat. Operator: provision workspace grant, PAT and access slots with gcloud secrets create and the conditioned secretVersionAdder binding.",
            );
          }
          return data;
        };
        const candidate = await invoke({
          ...input,
          validate_only: true,
          confirm_low_budget: true,
        });
        process.stderr.write(
          `Figma edits are made as @${candidate.metadata.handle}\nLibrary: ${fileKey}; seat: ${candidate.metadata.seat}; tier: ${candidate.metadata.tier}\n`,
        );
        if (candidate.lowBudget) {
          process.stderr.write(
            "Warning: View/Collab or Starter has about 20 MCP calls/month.\n",
          );
        }
        if (
          (await secretPrompt("Save this workspace connection (yes): ")) !==
            "yes"
        ) {
          throw new Error("Connection not saved");
        }
        await invoke({ ...input, confirm_low_budget: candidate.lowBudget });
        process.stdout.write(
          "Figma connected. Saved credentials cannot be retrieved.\n",
        );
      } catch (error) {
        process.stderr.write(
          (error instanceof Error ? error.message : "Figma connect failed") +
            "\n",
        );
        process.exitCode = 1;
      }
    });
}
