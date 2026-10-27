import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type MintPorts = {
  run(args: string[], interactive?: boolean, signal?: AbortSignal): Promise<void>;
  temp(): string;
  chmod(path: string): void;
  remove(path: string): void;
  report(line: string): void;
};
const defaults: MintPorts = {
  run: (args, interactive = false, signal) => new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: interactive ? "inherit" : "ignore", signal });
    child.once("error", () => reject(new Error("Figma sign-in pod command failed.")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Figma sign-in pod command failed.")));
  }),
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
  const dir = ports.temp(); // mkdtemp creates mode 0700, outside the repository.
  const pod = "harmony-figma-" + randomUUID();
  const base = ["--request-timeout=70s", "-n", "harmony-legs"];
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let podMayExist = false;
  let cleanupFailed = false;
  try {
    podMayExist = true; // Even an ambiguous create must be cleaned up.
    await ports.run([...base, "run", pod, "--restart=Never", "--image=node:22-bookworm-slim", "--command", "--", "sleep", "3600"], false, abort.signal);
    await ports.run([...base, "wait", "--for=condition=Ready", "pod/" + pod, "--timeout=120s"], false, abort.signal);
    const exec = [...base, "exec", pod, "--"];
    await ports.run([...exec, "npm", "install", "--global", "@anthropic-ai/claude-code@" + version], false, abort.signal);
    await ports.run([...exec, "claude", "mcp", "add", "--scope", "user", "--transport", "http", "figma", "https://mcp.figma.com/mcp"], false, abort.signal);
    ports.report("Open the Figma sign-in link printed by Claude Code and approve the account you want Harmony to use.");
    await ports.run([...base, "exec", "-it", pod, "--", "claude", "mcp", "login", "figma", "--no-browser"], true, abort.signal);
    const file = join(dir, "credentials.json");
    await ports.run([...base, "cp", pod + ":/root/.claude/.credentials.json", file], false, abort.signal);
    ports.chmod(file);
    await ports.run([...base, "delete", "pod", pod, "--ignore-not-found=true", "--wait=true", "--timeout=60s"], false);
    podMayExist = false;
    if (abort.signal.aborted) throw new Error("Setup cancelled.");
    ports.report("Fresh Figma sign-in ready. The sign-in pod has been deleted.");
    ports.report("Importing the private sign-in for this workspace…");
    return await consume(file, abort.signal);
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    if (podMayExist) {
      try { await ports.run([...base, "delete", "pod", pod, "--ignore-not-found=true", "--wait=true", "--timeout=60s"]); }
      catch { cleanupFailed = true; }
    }
    try { ports.remove(dir); } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      ports.report("Temporary sign-in cleanup could not be completed.");
      ports.report(`Remove pod ${pod} in harmony-legs and private directory ${dir} before reconnecting. Do not use this sign-in in Claude Code again.`);
      // eslint-disable-next-line no-unsafe-finally -- A cleanup failure must never return success; the warning above preserves the recovery location.
      throw new Error("Temporary sign-in cleanup could not be completed.");
    }
    ports.report("Temporary sign-in files removed.");
  }
}
