// B-1479: `harmony download switch [--undo] [--dry-run] [--base <url>]` — the commander wiring for
// src/tools/download-switch.ts, which holds all the logic. B-1501 adds `download install`,
// `download token use <project>`, `download token set` and `download status`. Like `harmony config`, this reads local files
// and runs `claude`; it is not wired through runCommand and needs no logged-in project to start.

import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  DEFAULT_BASE,
  runDownloadInstall,
  runDownloadStatus,
  runDownloadSwitch,
  runDownloadTokenSet,
  runDownloadTokenUse,
  type ClaudeRunner,
  type FetchLike,
  type SwitchDeps,
} from '../../tools/download-switch.js';
import { saveTokenNoActivate } from './auth.js';

/** Runs `claude` (or HARMONY_CLAUDE_BIN) with stdin closed, capturing its output. */
export const spawnClaude: ClaudeRunner = (args, opts) =>
  new Promise((resolve) => {
    const bin = process.env.HARMONY_CLAUDE_BIN || 'claude';
    const child = spawn(bin, args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

async function askOnce(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Read all of stdin (the installer pipes the token in). */
export async function readAllStdin(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  let data = '';
  for await (const chunk of input) data += String(chunk);
  return data;
}

/** Ask for a token at a terminal without echoing it. The prompt goes to stderr. */
export async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  let muted = false;
  anyRl._writeToOutput = (s: string) => {
    if (!muted || s.includes('\n')) anyRl.output.write(muted ? '\n' : s);
  };
  try {
    const p = rl.question(question);
    muted = true;
    return await p;
  } finally {
    rl.close();
  }
}

function tokenReader(fromStdin: boolean): () => Promise<string> {
  return () =>
    fromStdin || !process.stdin.isTTY
      ? readAllStdin()
      : promptHidden('Harmony API token (from Project Settings → Connect AI; it is not shown): ');
}

function realDeps(over: Partial<SwitchDeps> = {}): SwitchDeps {
  return {
    env: process.env,
    homedir: os.homedir(),
    cwd: process.cwd(),
    tmpdir: os.tmpdir(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    ask: askOnce,
    runClaude: spawnClaude,
    saveToken: saveTokenNoActivate,
    fetch: globalThis.fetch as unknown as FetchLike,
    now: () => new Date(),
    pid: process.pid,
    ...over,
  };
}

export function registerDownloadCommands(program: Command): void {
  const download = program.command('download').description("Harmony's gated plugin download");

  download
    .command('switch')
    .description(
      "Install the plugin from Harmony's download (harmony-plugin@harmony) and disable today's copy (harmony-plugin@ycomplex). " +
        'Exit 0 done, 1 refused or failed, 2 you need to act first.',
    )
    .option('--undo', "Go back: remove the harmony marketplace and enable today's copy again", false)
    .option('--dry-run', 'Print what it would do; change nothing and run no claude command', false)
    .option('--base <url>', 'The download address', DEFAULT_BASE)
    .action(async (opts: { undo?: boolean; dryRun?: boolean; base?: string }) => {
      process.exitCode = await runDownloadSwitch(opts, realDeps());
    });

  download
    .command('install')
    .description(
      "First install from Harmony's download on a new machine: read your token (stdin, or a hidden prompt), check it, " +
        'save it in ~/.harmony/config.json, pin it for the download, then install harmony-plugin@harmony. Exit 0 done, 1 refused or failed, 2 you need to act first.',
    )
    .option('--base <url>', 'The download address', DEFAULT_BASE)
    .option('--dry-run', 'Print what it would do; read no token, change nothing and run no claude command', false)
    .option('--token-stdin', 'Read the token from stdin (the default when stdin is not a terminal)', false)
    .action(async (opts: { base?: string; dryRun?: boolean; tokenStdin?: boolean }) => {
      process.exitCode = await runDownloadInstall(opts, realDeps({ readToken: tokenReader(Boolean(opts.tokenStdin)) }));
    });

  download
    .command('status')
    .description('Which project the download is pinned to and which source its helper will use (names only)')
    .action(() => {
      process.exitCode = runDownloadStatus(realDeps());
    });

  const token = download.command('token').description('Choose the one token the plugin download uses');
  token
    .command('use')
    .description('Pin a project already stored in ~/.harmony/config.json for the download, after the download accepts its token')
    .argument('<project>', 'The stored project (see `harmony project list`)')
    .option('--base <url>', 'The download address', DEFAULT_BASE)
    .action(async (project: string, opts: { base?: string }) => {
      process.exitCode = await runDownloadTokenUse(project, opts, realDeps());
    });
  token
    .command('set')
    .description('Read a new token (stdin, or a hidden prompt), check it, save it without changing the active project, and pin it for the download')
    .option('--base <url>', 'The download address', DEFAULT_BASE)
    .option('--token-stdin', 'Read the token from stdin (the default when stdin is not a terminal)', false)
    .action(async (opts: { base?: string; tokenStdin?: boolean }) => {
      process.exitCode = await runDownloadTokenSet(opts, realDeps({ readToken: tokenReader(Boolean(opts.tokenStdin)) }));
    });
}
