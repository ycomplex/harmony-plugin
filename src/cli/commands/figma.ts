import { FigmaSetupError, redactFigmaMessage } from "../figma-errors.js";
import { Command } from "commander";
import { readClaudeFigmaGrant, INVALID_CLAUDE_GRANT } from "../figma-claude-grant.js";
import { withClaudeFigmaSignIn } from "../figma-claude-sign-in.js";
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
export async function secretPrompt(prompt: string, signal?: AbortSignal): Promise<string> {
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
    return (await rl.question("", { signal })).trim();
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
  // Inspect the actual registration response, never classify arbitrary OAuth 403s as registration.
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === "POST" && typeof init.body === "string") {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(init.body); } catch { /* not registration JSON */ }
      if (body.client_name === "Harmony workspace Figma" && response.status === 403) {
        throw new Error("Figma has not approved this client. Use the Claude Code sign-in mode:\nharmony figma connect --claude-sign-in\nFallback: harmony figma connect --claude-credentials <private-file>");
      }
    }
    return response;
  };
  await auth(provider, { serverUrl, scope: "mcp:connect", fetchFn });
  if (!tokens) {
    const code = parseFigmaRedirect(
      await secretPrompt("Paste the final redirect URL (hidden): "),
      state,
    );
    await auth(provider, {
      serverUrl,
      scope: "mcp:connect",
      authorizationCode: code,
      fetchFn,
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

export function registerFigmaCommands(program: Command, ports = {
  prompt: secretPrompt, readGrant: readClaudeFigmaGrant, mint: withClaudeFigmaSignIn,
}): void {
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
  figma.command("context").alias("health").action(async () => {
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
        if (frozen.state === "disconnected" || frozen.state === "reconnect") {
          return;
        }
        const omitFigma = (context: FigmaMetadata) => {
          const path = process.env.HARMONY_FIGMA_WORKER_CONTEXT_FILE;
          if (path) {
            writeFileSync(
              path,
              Buffer.from(JSON.stringify(context)).toString("base64"),
              { mode: 0o600 },
            );
          }
        };
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
          omitFigma({ state: "disconnected", connections_enabled: false });
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
          omitFigma(
            meta.state === "disconnected" ? { state: "disconnected" } : {
              state: "reconnect",
              connections_enabled: meta.connections_enabled,
            },
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
    .option("--claude-credentials <file>", "Import a private isolated Claude Code credentials file")
    .option("--claude-sign-in", "Make a fresh Figma sign-in in a throwaway pod")
    .action(async (opts: { claudeCredentials?: string; claudeSignIn?: boolean }) => {
      let saveAttempted = false;
      let saved = false;
      let imported = false;
      try {
        if (opts.claudeCredentials && opts.claudeSignIn) throw new Error("Choose one Claude Code sign-in mode.");
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
        const connectWithGrant = async (grant: Record<string, unknown>, signal?: AbortSignal) => {
          signal?.throwIfAborted();
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
              | { whoami?: { handle?: string; plans?: unknown }; handle?: string; plans?: unknown }
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
            identity = identity?.whoami ?? identity;
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
            throw new FigmaSetupError(
              "Figma whoami could not verify the candidate identity/plans",
            );
          } finally {
            await identityClient.close();
          }
          const pat = await ports.prompt("REST personal access token (hidden): ", signal);
          const fileKey = await ports.prompt("Library file key: ", signal);
          const planName = await ports.prompt(
            "Exact library-owning plan name shown by Figma: ", signal,
          );
          if (
            (await ports.prompt(
              "Confirm this plan owns the library file (yes): ", signal,
            )) !== "yes"
          ) {
            throw new FigmaSetupError("Library plan not confirmed");
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
              if (typeof message === "string") throw new FigmaSetupError(redactFigmaMessage(message, [pat, ...Object.values(grant).filter((v): v is string => typeof v === "string")]));
              throw new FigmaSetupError(
                "Figma validation/publication failed; previous connection remains active. Check identity/library/seat. Operator: provision workspace grant, PAT and access slots with gcloud secrets create and the conditioned secretVersionAdder binding.",
              );
            }
            return data;
          };
          signal?.throwIfAborted();
          const candidate = await invoke({
            ...input,
            validate_only: true,
            confirm_low_budget: true,
          });
          process.stderr.write(
            `Figma edits will be made as @${candidate.metadata.handle}.\nLibrary: ${fileKey}; seat: ${candidate.metadata.seat}; tier: ${candidate.metadata.tier}\n`,
          );
          if (candidate.lowBudget) {
            process.stderr.write(
              "Warning: View/Collab or Starter has about 20 MCP calls/month.\n",
            );
          }
          if (
            (await ports.prompt("Save this workspace connection? Type yes: ", signal)) !==
              "yes"
          ) {
            throw new FigmaSetupError("Setup cancelled. No connection was saved.");
          }
          signal?.throwIfAborted();
          saveAttempted = true;
          await invoke({ ...input, confirm_low_budget: candidate.lowBudget });
          saved = true;
          return candidate.metadata.handle as string;
        };
        if (opts.claudeSignIn) {
          process.stderr.write("Connect Figma with a fresh Claude Code sign-in.\nYour everyday Claude Code login will not be used.\nIt runs in a throwaway pod that is deleted afterwards.\n");
          if (await ports.prompt("Continue? Type yes: ") !== "yes") throw new FigmaSetupError("Setup cancelled. No connection was saved.");
          imported = true;
          const handle = await ports.mint(async (file, signal) => connectWithGrant(ports.readGrant(file), signal));
          process.stdout.write(`Figma connection saved. Edits are made as @${handle}.\n`);
          process.stdout.write("The workspace refresh job now owns this sign-in.\n");
        } else if (opts.claudeCredentials) {
          process.stderr.write("Use a fresh sign-in created only for this workspace.\nStop its Claude Code process before continuing.\n");
          if (await ports.prompt("This is an isolated sign-in and no other process will refresh it. Type yes: ") !== "yes") throw new FigmaSetupError("Setup cancelled. No connection was saved.");
          imported = true;
          try {
            const handle = await connectWithGrant(ports.readGrant(opts.claudeCredentials));
            process.stdout.write(`Figma connection saved. Edits are made as @${handle}.\n`);
          }
          finally { process.stderr.write("After handoff, remove the imported file and its isolated config.\nDo not use this sign-in in Claude Code again.\n"); }
          process.stdout.write("The workspace refresh job now owns this sign-in.\n");
        } else {
          let grant: Record<string, unknown>;
          try { grant = await authorizeFigma(); }
          catch (error) {
            if (error instanceof Error && error.message.startsWith("Figma has not approved this client.")) throw error;
            // eslint-disable-next-line preserve-caught-error -- OAuth errors can embed credential-bearing response bodies.
            throw new Error("Figma OAuth authorization failed; retry harmony figma connect.");
          }
          const handle = await connectWithGrant(grant);
          process.stdout.write(`Figma connection saved. Edits are made as @${handle}.\n`);
        }
      } catch (error) {
        let message = error instanceof Error ? error.message : "Figma connect failed";
        if (saveAttempted && !saved) {
          message = "Could not confirm whether the connection was saved. Do not retry this import yet.\nCheck `harmony figma health` and the workspace connection before reconnecting.";
        } else if (imported && !saved) {
          if (message === INVALID_CLAUDE_GRANT) message += "\nNo connection was saved. Your existing connection is unchanged.\nCreate a fresh isolated sign-in and try again.";
          else if (!message.startsWith("Setup cancelled") && !message.startsWith("Temporary sign-in cleanup")) message = "Figma sign-in validation failed. No connection was saved. Your existing connection is unchanged.\nCheck identity/library/seat and operator-provisioned slots; create a fresh isolated sign-in and try again." + (error instanceof FigmaSetupError ? "\nReason: " + error.message : "");
        }
        process.stderr.write(message + "\n");
        process.exitCode = 1;
      }
    });
}
