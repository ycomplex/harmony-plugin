// B-1009: the operator's surface over the notify dispatcher — `harmony notify register-secret` and
// `harmony notify deliveries`. Both are thin wrappers over SECURITY DEFINER RPCs created by the web
// half's migration (`20260911153220_b1009_notify_dispatcher.sql`); neither talks to a declared
// `notify` endpoint, and nothing here dispatches anything.
//
// SUBSCRIPTIONS ARE NOT MANAGED HERE, DELIBERATELY (AC1). The subscription set comes from the repo's
// `.harmony/project.yml` `notify:` block and is carried across by `harmony gates run`
// (src/config/notify-sync.ts). Declaring is the only step an operator takes; there is no
// `notify subscribe` command to drift from the declaration, and no hand-editing of the database.
//
// THE SECRET IS WRITE-ONLY, ON BOTH SIDES OF THE WIRE. `notify_register_secret` returns ONLY
// `{subscription_id, registered_at}` — it never reads a stored secret back and never echoes the one
// supplied — and this command prints only `secret registered at <time>`. The secret is never logged,
// never echoed, never included in an error message, and never written to a file. `--secret-stdin`
// exists so it need not appear in a shell history or a process listing at all.
//
// `deliveries` is AC4: every attempt and its outcome — status, attempt count, response code, backoff,
// dead-letter stamp — readable without touching the database directly. The RPC returns no secret and
// no payload, so there is nothing sensitive to redact here.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedContext } from '../auth.js';
import { formatTable } from '../formatter.js';

/** One row of `notify_list_deliveries`, exactly as the RPC's RETURNS TABLE declares it. */
export interface NotifyDeliveryRow {
  delivery_id: string;
  subscription_id: string;
  endpoint_url: string;
  project_id: string;
  task_id: string;
  event_id: string;
  tx_id: number;
  transition: string;
  status: string;
  attempt_count: number;
  last_response_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  dead_lettered_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Everything these commands touch outside themselves — injected so the decision tree is testable
 *  without a login or a network, mirroring gates.ts's own pure-core-plus-thin-shell split. */
export interface NotifyCommandDeps {
  /** Calls one RPC. Production resolves the authenticated context lazily and converts PostgREST's
   *  `{ data, error }` pair into a throw. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** `p_dead_lettered`: `null` = every delivery, `true` = only dead-lettered, `false` = only live. */
export type DeadLetterFilter = boolean | null;

function errorMessage(err: unknown): string {
  const message = (err as { message?: string })?.message;
  return message && message.trim() ? message.trim() : String(err);
}

/** AC-relevant: the ONLY thing printed on success is the timestamp line. Returns the exit code. */
export async function runRegisterSecret(
  deps: NotifyCommandDeps,
  args: { endpoint: string; secret: string },
): Promise<number> {
  const endpoint = args.endpoint.trim();
  const secret = args.secret.trim();

  if (!endpoint) {
    deps.error('harmony notify register-secret: --endpoint is required.');
    return 1;
  }
  // Checked here as well as in the RPC so the failure never costs a round trip — and so the message
  // names the length rule without ever naming the value.
  if (secret.length < 16) {
    deps.error('harmony notify register-secret: the secret must be at least 16 characters.');
    return 1;
  }

  let result: unknown;
  try {
    result = await deps.rpc('notify_register_secret', {
      p_endpoint_url: endpoint,
      p_secret: secret,
    });
  } catch (err: unknown) {
    // The secret is never part of this message: only the RPC's own text, which by construction
    // names the project/endpoint/length rule and never the value.
    deps.error(`harmony notify register-secret: FAILED — ${errorMessage(err)}`);
    return 1;
  }

  const registeredAt = (result as { registered_at?: string } | null)?.registered_at;
  if (!registeredAt) {
    deps.error('harmony notify register-secret: the board accepted the call but returned no timestamp.');
    return 1;
  }

  deps.log(`secret registered at ${registeredAt}`);
  return 0;
}

/** AC4's read. Returns the exit code; rows go to stdout as a table (or JSON with --json). */
export async function runListDeliveries(
  deps: NotifyCommandDeps,
  args: { deadLettered: DeadLetterFilter; limit: number; json: boolean },
): Promise<number> {
  let result: unknown;
  try {
    result = await deps.rpc('notify_list_deliveries', {
      p_dead_lettered: args.deadLettered,
      p_limit: args.limit,
    });
  } catch (err: unknown) {
    deps.error(`harmony notify deliveries: FAILED — ${errorMessage(err)}`);
    return 1;
  }

  const rows = (Array.isArray(result) ? result : []) as NotifyDeliveryRow[];

  if (args.json) {
    deps.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    deps.log(
      args.deadLettered === true
        ? 'No dead-lettered deliveries.'
        : args.deadLettered === false
          ? 'No live deliveries.'
          : 'No deliveries.',
    );
    return 0;
  }

  deps.log(
    formatTable(rows, [
      { key: 'created_at', header: 'Created' },
      { key: 'transition', header: 'Transition' },
      { key: 'endpoint_url', header: 'Endpoint' },
      { key: 'status', header: 'Status' },
      { key: 'attempt_count', header: 'Attempts' },
      { key: 'last_response_code', header: 'Code', transform: (v) => (v === null || v === undefined ? '-' : String(v)) },
      {
        key: 'next_attempt_at',
        header: 'Next attempt',
        transform: (v, row: NotifyDeliveryRow) => (row.dead_lettered_at ? 'dead-lettered' : (v ?? '-')),
      },
      { key: 'last_error', header: 'Last error', transform: (v) => (v ? String(v) : '') },
    ]),
  );
  deps.log(`${rows.length} delivery attempt(s).`);
  return 0;
}

/** Production RPC caller: authenticates lazily, passes the active project, throws on error. */
function productionDeps(): NotifyCommandDeps {
  return {
    rpc: async (fn, args) => {
      const ctx = await getAuthenticatedContext();
      const { data, error: rpcError } = await ctx.client.rpc(fn, { p_project_id: ctx.projectId, ...args });
      if (rpcError) {
        throw Object.assign(new Error(rpcError.message), { code: (rpcError as { code?: string }).code });
      }
      return data;
    },
    log: (line) => console.log(line),
    error: (line) => console.error(chalk.red(line)),
  };
}

/** Reads the secret from stdin, whole. Used so a secret need never appear in a shell history or in
 *  `ps` output — the value is returned and passed straight to the RPC, never stored or printed. */
function readSecretFromStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function registerNotifyCommands(program: Command): void {
  const notify = program
    .command('notify')
    .description(
      "B-1009 notify dispatcher operator surface — register an endpoint's signing secret and read " +
        'every delivery attempt. Subscriptions themselves are NOT managed here: they come from the ' +
        "repo's .harmony/project.yml `notify:` block, synced by `harmony gates run`.",
    );

  notify
    .command('register-secret')
    .description(
      'Register (or rotate) the HMAC signing secret for one declared endpoint. Prints only the ' +
        'registration timestamp — the secret is never echoed, logged or read back. Until a secret ' +
        'is registered, that endpoint\'s deliveries park in `awaiting_secret` and are never sent ' +
        'unsigned.',
    )
    .requiredOption('--endpoint <url>', 'The declared endpoint URL, exactly as it appears in .harmony/project.yml')
    .option('--secret <secret>', 'The signing secret (min 16 chars). Prefer --secret-stdin.')
    .option('--secret-stdin', 'Read the secret from stdin instead, keeping it out of shell history and `ps`', false)
    .action(async (opts: { endpoint: string; secret?: string; secretStdin?: boolean }) => {
      const deps = productionDeps();
      if (opts.secretStdin && opts.secret) {
        deps.error('harmony notify register-secret: pass either --secret or --secret-stdin, not both.');
        process.exit(1);
      }
      const secret = opts.secretStdin ? readSecretFromStdin() : (opts.secret ?? '');
      if (!secret.trim()) {
        deps.error('harmony notify register-secret: no secret supplied (use --secret <secret> or --secret-stdin).');
        process.exit(1);
      }
      const code = await runRegisterSecret(deps, { endpoint: opts.endpoint, secret });
      process.exit(code);
    });

  notify
    .command('deliveries')
    .description(
      'List notify delivery attempts for the active project — status, attempt count, response code, ' +
        'backoff and dead-letter stamp (AC4). No secret and no payload is ever returned.',
    )
    .option('--dead-lettered', 'Only deliveries that have been dead-lettered', false)
    .option('--live', 'Only deliveries that have NOT been dead-lettered', false)
    .option('--limit <n>', 'Maximum rows (1-500, default 50)', '50')
    .action(async (opts: { deadLettered?: boolean; live?: boolean; limit?: string }) => {
      const deps = productionDeps();
      if (opts.deadLettered && opts.live) {
        deps.error('harmony notify deliveries: --dead-lettered and --live are mutually exclusive.');
        process.exit(1);
      }
      const deadLettered: DeadLetterFilter = opts.deadLettered ? true : opts.live ? false : null;
      const parsedLimit = Number.parseInt(opts.limit ?? '50', 10);
      const code = await runListDeliveries(deps, {
        deadLettered,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
        json: Boolean(program.opts().json),
      });
      process.exit(code);
    });
}
