// B-916 + B-720 cross-file drift guard: container/provision.sh's headless branch must keep CAPTURING
// every claude invocation's cost AND its OUTPUT, and must keep re-echoing its `.result` verbatim.
//
// B-720's replacement capture is guarded here too, on the same extracted block and the same fake
// accessor: the WORKER now records its own output (`harmony leg-output record --source worker`),
// because the daemon's capture is the LAUNCH COMMAND's stdout — the worker's own only on the docker
// profile. If that call ever falls out of provision.sh, the board silently goes back to showing
// launcher chatter under the "Worker output" heading, which is the exact failure B-720 was reopened
// to fix. See the second describe block at the bottom of this file.
//
// Two properties are pinned here, and they pull against each other — which is exactly why they need
// an executed test rather than prose:
//
//  1. `--output-format json` turns the whole of an invocation's stdout into ONE JSON line. Without
//     the re-echo, B-720's captured operator tail (`conductions.last_worker_output`) silently
//     becomes a machine blob — a regression nothing else in this repo would notice.
//  2. EVERY invocation of a leg must be recorded — 1..8 of them: the B-718 resume attempt, its cold
//     fallback, and every B-772 model-switch iteration. The resume-fallback path is the one most
//     likely to be missed by a naive wiring, so it gets its own test.
//
// The block EXECUTED below is extracted VERBATIM from provision.sh's real headless branch, never
// hand-retyped — the same discipline (and the same extraction shape) as
// src/daemon/profile-contract.test.ts's own B-718/B-772 executed describe block. It lives HERE, not
// there, deliberately: B-916's accepted design forbids this feature from touching src/daemon/ at
// all (the agent-neutrality seam — see src/tools/leg-cost-record.ts's header), so its guard sits
// beside the shared core it guards instead.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const provisionPath = fileURLToPath(new URL('../../container/provision.sh', import.meta.url));
const provisionScript = readFileSync(provisionPath, 'utf8');

/** Extract the headless branch's invocation block verbatim: from the B-718 header comment through
 *  the closing `exit "$LEG_EXIT"`, EXCLUDING the case-arm's own trailing `;;` (the harness supplies
 *  its own script framing rather than a `case` statement). */
function extractInvocationBlock(): string {
  const startMarker =
    '# --- B-718: same-conduction resume discovery + best-effort --resume wiring (AC5). -----------';
  const endMarker = 'exit "$LEG_EXIT"';
  const start = provisionScript.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const endAt = provisionScript.indexOf(endMarker, start);
  expect(endAt).toBeGreaterThan(start);
  return provisionScript.slice(start, endAt + endMarker.length);
}

/** The observed `claude -p --output-format json` envelope shape (CLI 2.1.252): one JSON line, a
 *  NESTED usage, the 1h/5m cache-creation split, and `is_error` as the real error signal. */
function resultEnvelope(result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: 'sess-1',
    num_turns: 3,
    duration_ms: 1234,
    duration_api_ms: 567,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_1h_input_tokens: 15, ephemeral_5m_input_tokens: 25 },
      output_tokens_details: { thinking_tokens: 5 },
    },
  });
}

interface Harness {
  /** stdout + stderr, merged (the block writes to both). */
  combined: string;
  status: number | null;
  /** One line per `node $PLUGIN_DIR/dist/bin/harmony.js ...` call, in call order: the argv JSON. */
  accessorCalls: string[][];
  /** One line per fake-claude invocation, in call order, interleaved with accessorCalls via `order`. */
  order: string[];
}

/** Build a fake PLUGIN_DIR whose `dist/bin/harmony.js` LOGS every call instead of doing anything —
 *  the same trick provision.sh's own model-switch tests use to observe the accessor boundary,
 *  except pointed at a stub so no real board/login is ever touched. */
function fakePluginDir(dir: string, logFile: string, opts: { recordExitCode?: number } = {}): string {
  const pluginDir = join(dir, 'plugin');
  mkdirSync(join(pluginDir, 'dist', 'bin'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'dist', 'bin', 'harmony.js'),
    [
      "const { appendFileSync, existsSync, writeFileSync, unlinkSync, readFileSync } = require('node:fs');",
      'const argv = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(logFile)}, 'HARMONY ' + JSON.stringify(argv) + '\\n');`,
      "const handoff = process.env.HOME + '/handoff';",
      "if (argv[0] === 'model' && argv[1] === 'read-handoff') {",
      '  if (!existsSync(handoff)) process.exit(1);',
      "  process.stdout.write(readFileSync(handoff, 'utf8').trim() + '\\n');",
      '  process.exit(0);',
      '}',
      "if (argv[0] === 'model' && argv[1] === 'clear-handoff') { if (existsSync(handoff)) unlinkSync(handoff); process.exit(0); }",
      "if (argv[0] === 'model' && argv[1] === 'check-alias') process.exit(0);",
      "if (argv[0] === 'model' && argv[1] === 'context-budget') { process.stdout.write('999999999\\n'); process.exit(0); }",
      "if (argv[0] === 'leg-cost' && argv[1] === 'resolve-gate') { process.stdout.write('build\\n'); process.exit(0); }",
      `if (argv[0] === 'leg-cost' && argv[1] === 'record') process.exit(${opts.recordExitCode ?? 0});`,
      // B-720: the worker's own output recorder. Logged like every other accessor call so the
      // contract tests below can see WHEN it ran and WITH WHAT.
      `if (argv[0] === 'leg-output' && argv[1] === 'record') process.exit(${opts.recordExitCode ?? 0});`,
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  return pluginDir;
}

/** A fake `claude` that logs its own invocation (with argv) and emits a result envelope. */
function fakeClaude(
  dir: string,
  logFile: string,
  body: string[],
): string {
  const claudeDir = join(dir, 'bin');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'claude'),
    ['#!/usr/bin/env bash', `printf 'CLAUDE %s\\n' "$*" >> ${JSON.stringify(logFile)}`, ...body, ''].join('\n'),
    { mode: 0o755 },
  );
  return claudeDir;
}

function runBlock(opts: {
  claudeBody: string[];
  env?: NodeJS.ProcessEnv;
  /** Write a resumable session file so the B-718 resume path is taken. */
  session?: string;
  recordExitCode?: number;
  handoff?: string;
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'b916-provision-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const logFile = join(dir, 'calls.log');
  writeFileSync(logFile, '');

  const pluginDir = fakePluginDir(dir, logFile, { recordExitCode: opts.recordExitCode });
  const claudeDir = fakeClaude(dir, logFile, opts.claudeBody);

  if (opts.session) {
    const slug = join(home, '.claude', 'projects', '-workspace-workspace');
    mkdirSync(slug, { recursive: true });
    writeFileSync(join(slug, `${opts.session}.jsonl`), '{}\n');
  }
  if (opts.handoff) writeFileSync(join(home, 'handoff'), opts.handoff);

  const scriptFile = join(dir, 'harness.sh');
  writeFileSync(
    scriptFile,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'exec 2>&1', // merge stderr so a passing run still lets the test read the logged lines
      `PLUGIN_DIR="${pluginDir}"`,
      'PROMPT="do the leg"',
      extractInvocationBlock(),
      '',
    ].join('\n'),
    { mode: 0o700 },
  );

  const env: NodeJS.ProcessEnv = {
    HARMONY_CONDUCTION_ID: 'cond-1',
    ...opts.env,
    HOME: home,
    PATH: `${claudeDir}:${process.env.PATH}`,
  };

  let combined: string;
  let status: number | null = 0;
  try {
    combined = execFileSync('bash', [scriptFile], { env }).toString();
  } catch (err) {
    const e = err as { status: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
    status = e.status;
    combined = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
  }

  const order = existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    : [];
  const accessorCalls = order
    .filter((line) => line.startsWith('HARMONY '))
    .map((line) => JSON.parse(line.slice('HARMONY '.length)) as string[]);

  return { combined, status, accessorCalls, order };
}

const recordCalls = (h: Harness) =>
  h.accessorCalls.filter((argv) => argv[0] === 'leg-cost' && argv[1] === 'record');

/** `--file <path> --gate <g> --leg-key <k> --invocation-index <n> [--model <m>]` -> a flag map. */
function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  return out;
}

describe('provision.sh: B-916 per-invocation cost capture', () => {
  it('keeps the block-extraction marker UNIQUE — both contract tests slice to the FIRST one', () => {
    // B-916 nearly broke this: the mid-loop "preserve set -e" exits were first written as
    // `exit "$LEG_EXIT"`, which silently truncated BOTH this file's and
    // src/daemon/profile-contract.test.ts's extraction to a half-open `while` loop. Every
    // extracted-block test then failed with a bash syntax error rather than a meaningful one, so
    // pin the invariant directly: the marker occurs exactly once, as the block's final line.
    const occurrences = provisionScript.split('exit "$LEG_EXIT"').length - 1;
    expect(occurrences).toBe(1);
    expect(extractInvocationBlock().trimEnd().endsWith('exit "$LEG_EXIT"')).toBe(true);
  });

  it('adds --output-format json to the flag base, so EVERY invocation is measured the same way', () => {
    const h = runBlock({ claudeBody: [`echo '${resultEnvelope('all done')}'`, 'exit 0'] });
    const claudeLine = h.order.find((l) => l.startsWith('CLAUDE '))!;
    expect(claudeLine).toContain('--output-format json');
  });

  it('re-echoes `.result` VERBATIM to stdout and does NOT leak the JSON envelope — B-720\'s operator tail reads exactly as it did before', () => {
    const tail = 'I am parking because the migration is not on prod yet.';
    const h = runBlock({ claudeBody: [`echo '${resultEnvelope(tail)}'`, 'exit 0'] });
    expect(h.combined).toContain(tail);
    // The machine envelope's own markers must not reach the operator tail.
    expect(h.combined).not.toContain('"total_cost_usd"');
    expect(h.combined).not.toContain('cache_creation');
  });

  it('passes NON-envelope stdout through byte-for-byte (an older CLI, a wrapper, a crash before the line) — this feature can never swallow what claude wrote', () => {
    const h = runBlock({ claudeBody: ['echo "PLAIN OUTPUT not json at all"', 'exit 0'] });
    expect(h.combined).toContain('PLAIN OUTPUT not json at all');
  });

  it('stamps the gate BEFORE the invocation it describes, and records it after', () => {
    const h = runBlock({ claudeBody: [`echo '${resultEnvelope('done')}'`, 'exit 0'] });
    const kinds = h.order.map((l) =>
      l.startsWith('CLAUDE ') ? 'claude' : (JSON.parse(l.slice('HARMONY '.length)) as string[]).join(' '),
    );
    const resolveAt = kinds.indexOf('leg-cost resolve-gate');
    const claudeAt = kinds.indexOf('claude');
    const recordAt = kinds.findIndex((k) => k.startsWith('leg-cost record'));
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(resolveAt).toBeLessThan(claudeAt); // BEFORE — a write-time read would name the NEXT gate
    expect(claudeAt).toBeLessThan(recordAt);
    expect(flags(recordCalls(h)[0]).gate).toBe('build');
  });

  it('records the single cold-start invocation with the leg key, index 0 and the launched model', () => {
    const h = runBlock({
      claudeBody: [`echo '${resultEnvelope('done')}'`, 'exit 0'],
      env: { HARMONY_MODEL: 'claude-opus-5' },
    });
    const calls = recordCalls(h);
    expect(calls).toHaveLength(1);
    const f = flags(calls[0]);
    expect(f['invocation-index']).toBe('0');
    expect(f['leg-key']).toBeTruthy();
    expect(f.model).toBe('claude-opus-5');
  });

  it('records BOTH halves of the B-718 resume-fallback path — the failed resume attempt AND its cold fallback — under ONE leg key', () => {
    const h = runBlock({
      session: 'sess-old',
      env: {
        HARMONY_RUN_CONFIG_JSON: Buffer.from(
          JSON.stringify({ session_resume: { enabled: true } }),
        ).toString('base64'),
      },
      claudeBody: [
        'if printf \'%s\\n\' "$@" | grep -q -- --resume; then',
        '  echo "attach failed" >&2',
        '  exit 3',
        'fi',
        `echo '${resultEnvelope('cold fallback did the work')}'`,
        'exit 0',
      ],
    });

    expect(h.combined).toContain('failed to attach (exit 3');
    expect(h.combined).toContain('cold fallback did the work');

    const calls = recordCalls(h);
    expect(calls).toHaveLength(2); // the resume ATTEMPT is an invocation too — it burned wall-clock
    const [attempt, fallback] = calls.map(flags);
    expect(attempt['invocation-index']).toBe('0');
    expect(fallback['invocation-index']).toBe('1');
    expect(attempt['leg-key']).toBe(fallback['leg-key']); // ONE leg, two invocations
  });

  it('records EVERY B-772 model-switch iteration, all under the same leg key', () => {
    // The fake claude requests a switch on its FIRST invocation only, so the loop settles at two.
    const h = runBlock({
      env: { HARMONY_MODEL: 'claude-sonnet-5' },
      claudeBody: [
        'COUNTER="$HOME/.count"',
        'COUNT=0',
        '[ -f "$COUNTER" ] && COUNT="$(cat "$COUNTER")"',
        'COUNT=$((COUNT + 1))',
        'echo "$COUNT" > "$COUNTER"',
        'if [ "$COUNT" -eq 1 ]; then printf claude-opus-5 > "$HOME/handoff"; fi',
        `echo '${resultEnvelope('turn done')}'`,
        'exit 0',
      ],
    });

    const calls = recordCalls(h).map(flags);
    expect(calls).toHaveLength(2);
    expect(calls.map((f) => f['invocation-index'])).toEqual(['0', '1']);
    expect(calls[0]['leg-key']).toBe(calls[1]['leg-key']);
    // Each invocation records the model IT actually launched with, not the leg's first choice.
    expect(calls[0].model).toBe('claude-sonnet-5');
    expect(calls[1].model).toBe('claude-opus-5');
  });

  it('records the FAILING invocation too, and still exits with its code — a capture must never change what the daemon sees', () => {
    const h = runBlock({ claudeBody: ['echo "boom" >&2', 'exit 42'] });
    expect(h.status).toBe(42);
    expect(recordCalls(h)).toHaveLength(1);
  });

  it('NEVER fails the leg when the cost accessor itself fails — a diagnostic nicety cannot break the run it describes', () => {
    const h = runBlock({
      claudeBody: [`echo '${resultEnvelope('done')}'`, 'exit 0'],
      recordExitCode: 9,
    });
    expect(h.status).toBe(0);
    expect(h.combined).toContain('done');
  });
});


const outputCalls = (h: Harness) =>
  h.accessorCalls.filter((argv) => argv[0] === 'leg-output' && argv[1] === 'record');

describe('provision.sh: B-720 worker-side output capture', () => {
  it('records EVERY invocation\'s output as a WORKER row, under the same leg key as its cost row', () => {
    const h = runBlock({ claudeBody: [`echo '${resultEnvelope('done')}'`, 'exit 0'] });

    const calls = outputCalls(h).map(flags);
    expect(calls).toHaveLength(1);
    // `--source worker` is the WHOLE fix: the web selects worker output by this label alone, so a
    // row written under any other source would put these bytes under the wrong heading.
    expect(calls[0].source).toBe('worker');
    expect(calls[0].gate).toBe('build');
    // ONE leg key across both features, so a leg's output row and its B-916 cost rows join.
    expect(calls[0]['leg-key']).toBe(flags(recordCalls(h)[0])['leg-key']);
    // The capture file is the invocation's own stdout capture — the one the re-echo also reads.
    expect(calls[0].file).toBeTruthy();
  });

  it('records BOTH halves of the B-718 resume-fallback path, and carries the attempt\'s STDERR too', () => {
    const h = runBlock({
      session: 'sess-old',
      env: {
        HARMONY_RUN_CONFIG_JSON: Buffer.from(
          JSON.stringify({ session_resume: { enabled: true } }),
        ).toString('base64'),
      },
      claudeBody: [
        'if printf \'%s\\n\' "$@" | grep -q -- --resume; then',
        '  echo "attach failed" >&2',
        '  exit 3',
        'fi',
        `echo '${resultEnvelope('cold fallback did the work')}'`,
        'exit 0',
      ],
    });

    const calls = outputCalls(h).map(flags);
    expect(calls).toHaveLength(2);
    expect(calls.map((f) => f.source)).toEqual(['worker', 'worker']);
    expect(calls[0]['leg-key']).toBe(calls[1]['leg-key']);
    // The resume attempt is the ONE branch that captured stderr to its own file — an attach
    // failure's stderr is the most useful text the leg will produce, so the row must carry it.
    expect(calls[0]['stderr-file']).toBeTruthy();
    // The cold fallback writes stderr straight through (no file exists to hand over).
    expect(calls[1]['stderr-file']).toBeUndefined();
  });

  it('records the FAILING invocation too, and still exits with its code', () => {
    const h = runBlock({ claudeBody: ['echo "boom" >&2', 'exit 42'] });
    expect(h.status).toBe(42);
    expect(outputCalls(h)).toHaveLength(1);
  });

  it('NEVER fails the leg when the output accessor itself fails — and never writes to STDOUT', () => {
    const tail = 'I am parking because the migration is not on prod yet.';
    const h = runBlock({ claudeBody: [`echo '${resultEnvelope(tail)}'`, 'exit 0'], recordExitCode: 9 });
    expect(h.status).toBe(0);
    // The operator tail is still exactly the agent's prose — the accessor contributed nothing to
    // the stdout it exists to capture (its diagnostics are stderr-only, and it is >/dev/null'd
    // besides).
    expect(h.combined).toContain(tail);
    expect(h.combined).not.toContain('leg-output');
  });
});
