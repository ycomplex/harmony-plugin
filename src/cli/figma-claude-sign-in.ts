import { ConductorConfigError, loadConductorConfigSync } from "../config/conductor-config.js";
import { FigmaSetupError } from "./figma-errors.js";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** A kubectl command's exit status and stdout. stderr is never read: it may carry authentication material. */
export type CaptureResult = { code: number | null; out: string };
export type MintPorts = {
  run(args: string[], interactive?: boolean, signal?: AbortSignal): Promise<void>;
  capture(args: string[]): Promise<CaptureResult>;
  /** The Kubernetes namespace the installation's conductor runs legs in. */
  namespace(): string;
  temp(): string;
  chmod(path: string): void;
  remove(path: string): void;
  report(line: string): void;
};
const DEFAULT_NAMESPACE = "harmony-legs";
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Same source as the conductor: gke.namespace from the merged conductor config (project file, host file,
 *  HARMONY_GKE_NAMESPACE), else HARMONY_GKE_NAMESPACE, else harmony-legs. An invalid config stops the
 *  sign-in rather than quietly using the default. */
export function resolveSignInNamespace(
  env: NodeJS.ProcessEnv = process.env,
  load: typeof loadConductorConfigSync = loadConductorConfigSync,
): string {
  let ns: string | undefined;
  try {
    ns = load({ env, warn: () => {} })?.merged.gke?.namespace;
  } catch (error) {
    if (error instanceof ConductorConfigError) {
      throw new FigmaSetupError(`The conductor configuration is invalid, so the sign-in namespace cannot be resolved:\n${error.message}\nNo pod was created.`);
    }
    throw error;
  }
  ns = ns || env.HARMONY_GKE_NAMESPACE || DEFAULT_NAMESPACE;
  if (!NAMESPACE_NAME.test(ns) || ns.length > 63) {
    throw new FigmaSetupError(`"${ns}" is not a valid Kubernetes namespace name. Fix gke.namespace in the conductor configuration, then retry. No pod was created.`);
  }
  return ns;
}

const defaults: MintPorts = {
  run: (args, interactive = false, signal) => new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: interactive ? "inherit" : "ignore", signal });
    child.once("error", () => reject(new FigmaSetupError("Figma sign-in pod command failed.")));
    child.once("exit", code => code === 0 ? resolve() : reject(new FigmaSetupError("Figma sign-in pod command failed.")));
  }),
  capture: args => new Promise(resolve => {
    const child = spawn("kubectl", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString("utf8"); });
    child.once("error", () => resolve({ code: null, out: "" }));
    child.once("close", code => resolve({ code, out }));
  }),
  namespace: () => resolveSignInNamespace(),
  temp: () => mkdtempSync(join(tmpdir(), "harmony-figma-")),
  chmod: path => chmodSync(path, 0o600),
  remove: path => rmSync(path, { recursive: true, force: true }),
  report: line => process.stderr.write(line + "\n"),
};

/** A fresh pod owns sign-in, then is deleted before Harmony takes ownership. No logout/revoke. */
export async function withClaudeFigmaSignIn<T>(
  consume: (path: string, signal: AbortSignal) => Promise<T>,
  ports: MintPorts = defaults,
  version = process.env.HARMONY_FIGMA_CLAUDE_VERSION ?? "2.1.312",
): Promise<T> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Claude Code version.");
  const ns = ports.namespace();
  const base = ["--request-timeout=70s", "-n", ns];
  // kubectl prints "yes" or "no" for auth can-i. Only that answer is read; stderr is never captured or shown.
  const probe = await ports.capture(["--request-timeout=15s", "-n", ns, "auth", "can-i", "create", "pods"]);
  const answer = probe.out.trim().split(/\s+/)[0]?.toLowerCase();
  if (probe.code === null || (answer !== "yes" && answer !== "no")) {
    throw new FigmaSetupError("kubectl could not reach the harmony cluster. Run `gcloud auth login`, then retry. No pod was created.");
  }
  if (answer === "no") {
    throw new FigmaSetupError(`Your account may not create pods in ${ns} (kubectl auth can-i create pods was denied). Ask a cluster admin for permission to create pods there, then retry. No pod was created.`);
  }
  const dir = ports.temp(); // mkdtemp creates mode 0700, outside the repository.
  const pod = "harmony-figma-" + randomUUID();
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let podMayExist = false;
  let signedIn = false;
  let primary: unknown;
  let failed = false;
  let result: T;
  try {
    podMayExist = true; // Even an ambiguous create must be cleaned up.
    await ports.run([...base, "run", pod, "--restart=Never", "--image=node:22-bookworm-slim", "--command", "--", "sleep", "3600"], false, abort.signal);
    await ports.run([...base, "wait", "--for=condition=Ready", "pod/" + pod, "--timeout=120s"], false, abort.signal);
    const exec = [...base, "exec", pod, "--"];
    await ports.run([...exec, "npm", "install", "--global", "@anthropic-ai/claude-code@" + version], false, abort.signal);
    await ports.run([...exec, "claude", "mcp", "add", "--scope", "user", "--transport", "http", "figma", "https://mcp.figma.com/mcp"], false, abort.signal);
    ports.report("Open the Figma sign-in link printed by Claude Code and approve the account you want Harmony to use.");
    await ports.run([...base, "exec", "-it", pod, "--", "claude", "mcp", "login", "figma", "--no-browser"], true, abort.signal);
    signedIn = true;
    const file = join(dir, "credentials.json");
    await ports.run([...base, "cp", pod + ":/root/.claude/.credentials.json", file], false, abort.signal);
    ports.chmod(file);
    await ports.run([...base, "delete", "pod", pod, "--ignore-not-found=true", "--wait=true", "--timeout=60s"], false);
    podMayExist = false;
    if (abort.signal.aborted) throw new FigmaSetupError("Setup cancelled.");
    ports.report("Fresh Figma sign-in ready. The sign-in pod has been deleted.");
    ports.report("Importing the private sign-in for this workspace…");
    result = await consume(file, abort.signal);
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    const leftovers: string[] = [];
    if (podMayExist) {
      try { await ports.run([...base, "delete", "pod", pod, "--ignore-not-found=true", "--wait=true", "--timeout=60s"]); }
      catch { leftovers.push(`Remove pod ${pod} in ${ns} before reconnecting.`); }
    }
    try { ports.remove(dir); }
    catch { leftovers.push(`Remove private directory ${dir} before reconnecting.`); }
    if (leftovers.length) {
      const cleanup = ["Temporary sign-in cleanup could not be completed.", ...leftovers,
        ...(signedIn ? ["Do not use this sign-in in Claude Code again."] : [])].join("\n");
      // Never render an arbitrary consume error, which may contain an upstream body.
      const reason = primary instanceof FigmaSetupError ? primary.message
        : failed ? "Figma sign-in failed." : undefined;
      primary = new FigmaSetupError([...(reason ? [reason] : []), cleanup].join("\n"));
      failed = true;
    }
    if (!leftovers.length) ports.report("Temporary sign-in files removed.");
  }
  if (failed) throw primary;
  return result!;
}
