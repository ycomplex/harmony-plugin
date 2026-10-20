#!/usr/bin/env node
// B-1173: thin I/O shell around src/daemon/conductor-boot.ts (the decisions and the tests live there).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { execFileSecretExec } from '../config/conductor-secrets.js';
import { runConductorBoot } from '../daemon/conductor-boot.js';

const code = await runConductorBoot(process.argv.slice(2), {
  env: process.env,
  exec: execFileSecretExec,
  readFile: (p) => readFileSync(p, 'utf8'),
  out: (l) => void process.stdout.write(`${l}\n`),
  err: (l) => void process.stderr.write(`${l}\n`),
  run: (command, args, env) =>
    new Promise<number>((resolve) => {
      const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, stdio: 'inherit' });
      for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => child.kill(sig));
      child.on('error', (e) => {
        process.stderr.write(`conductor-boot: could not run ${command}: ${e.message}\n`);
        resolve(127);
      });
      child.on('exit', (c, signal) => resolve(c ?? (signal ? 143 : 1)));
    }),
});
process.exit(code);
