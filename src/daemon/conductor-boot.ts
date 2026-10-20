// B-1173: the boot helper baked into the conductor image (dist/bin/conductor-boot.js). Two verbs, both credential-free
// at the CLI surface:
//
//   exec -- <command> [args...]   resolve the remote conductor's secrets (HARMONY_API_TOKEN, HARMONY_APP_PRIVATE_KEY)
//                                 from Secret Manager into the CHILD's environment, then run the command with stdio
//                                 inherited and exit with its code. This is how a pod's CronJob (the ticket-disk
//                                 sweep) gets the API token without an env file. The conductor Deployment itself does
//                                 not need it: the daemon resolves its own secrets at boot.
//   check-host <file>             validate a host file against the strict host schema and print its secret NAMES only.
//                                 The image smoke runs it on conductor.host.example.json. No network, no gcloud.
//
// Everything with a side effect is injected, so the unit test needs no gcloud and no child process.

import { HostFileSchema } from '../config/conductor-config.js';
import { resolveConductorSecrets, type SecretExec } from '../config/conductor-secrets.js';

type Env = Record<string, string | undefined>;

export interface BootDeps {
  env: Env;
  exec: SecretExec;
  readFile(path: string): string;
  /** Runs the command with `env`, stdio inherited; resolves to its exit code. */
  run(command: string, args: string[], env: Env): Promise<number>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = 'usage: conductor-boot exec -- <command> [args...] | conductor-boot check-host <host-file>';

export async function runConductorBoot(argv: string[], deps: BootDeps): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === 'check-host') {
    const path = rest[0];
    if (!path) {
      deps.err(USAGE);
      return 2;
    }
    let json: unknown;
    try {
      json = JSON.parse(deps.readFile(path));
    } catch {
      deps.err(`conductor-boot: ${path} could not be read as JSON`);
      return 1;
    }
    const parsed = HostFileSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      deps.err(`conductor-boot: ${path} is not a valid host file: ${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'unknown problem'}`);
      return 1;
    }
    const names = Object.entries(parsed.data.secrets ?? {}).map(([k, v]) => `${k}=${v}`);
    deps.out(`host file ok: secrets (names only) ${names.length > 0 ? names.join(', ') : 'none'}`);
    return 0;
  }
  if (verb === 'exec') {
    const cmd = rest[0] === '--' ? rest.slice(1) : rest;
    if (cmd.length === 0) {
      deps.err(USAGE);
      return 2;
    }
    const childEnv: Env = { ...deps.env };
    try {
      const r = await resolveConductorSecrets({ env: deps.env, target: childEnv, exec: deps.exec, readFile: deps.readFile });
      if (r.resolved.length > 0) deps.out(`conductor-boot: resolved ${r.resolved.join(', ')} from Secret Manager (values not shown)`);
    } catch (e) {
      deps.err(`conductor-boot: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    return deps.run(cmd[0] as string, cmd.slice(1), childEnv);
  }
  deps.err(USAGE);
  return 2;
}
