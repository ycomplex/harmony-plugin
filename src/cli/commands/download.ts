// B-1479: `harmony download switch [--undo] [--dry-run] [--base <url>]` — the commander wiring for
// src/tools/download-switch.ts, which holds all the logic. Like `harmony config`, this reads local files
// and runs `claude`; it is not wired through runCommand and needs no logged-in project to start.

import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import { DEFAULT_BASE, runDownloadSwitch, type ClaudeRunner } from '../../tools/download-switch.js';
import { loginWithToken } from './auth.js';

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
      const code = await runDownloadSwitch(opts, {
        env: process.env,
        homedir: os.homedir(),
        cwd: process.cwd(),
        tmpdir: os.tmpdir(),
        isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        out: (l) => console.log(l),
        err: (l) => console.error(l),
        ask: askOnce,
        runClaude: spawnClaude,
        saveToken: loginWithToken,
        now: () => new Date(),
        pid: process.pid,
      });
      process.exitCode = code;
    });
}
