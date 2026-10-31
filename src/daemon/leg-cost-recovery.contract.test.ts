// B-1353: execute the retained Codex request-slice journal from provision.sh verbatim. The tests
// prove that recovery reuses the original invocation identity and byte boundary, and that an
// unavailable boundary remains retained instead of being guessed or charged to a later leg.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const provision = readFileSync(fileURLToPath(new URL('../../container/provision.sh', import.meta.url)), 'utf8');
const start = provision.indexOf('    B1353_REQUEST_FILE=""');
const end = provision.indexOf('    # --- B-772 round 2:', start);
const helpers = provision.slice(start, end);

function run(setup: (dir: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'b1353-cost-recovery-'));
  const setupScript = setup(dir);
  const script = join(dir, 'test.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    `PLUGIN_DIR=${JSON.stringify(join(dir, 'plugin'))}`,
    `CODEX_SESSIONS_DIR=${JSON.stringify(join(dir, 'sessions'))}`,
    'AGENT_ID=codex', 'HARMONY_CONDUCTION_ID=current-conduction',
    'LEG_KEY=current-leg', 'INVOCATION_INDEX=3', 'LEG_GATE=build', 'CURRENT_MODEL=gpt-6-luna',
    helpers, setupScript,
  ].join('\n'), { mode: 0o700 });
  return { dir, result: spawnSync('bash', [script], { encoding: 'utf8' }) };
}

describe('provision.sh B-1353 retained Codex usage', () => {
  it('persists a resume boundary, then recovers it under its original leg and conduction', () => {
    const { dir, result } = run((root) => {
      const sessions = join(root, 'sessions');
      const rolloutDir = join(sessions, '2026', '10', '31');
      mkdirSync(rolloutDir, { recursive: true });
      const rollout = join(rolloutDir, 'rollout-test-thread-1.jsonl');
      writeFileSync(rollout, 'prior');
      const nodeDir = join(root, 'bin'); mkdirSync(nodeDir);
      const log = join(root, 'calls.log');
      const shim = join(nodeDir, 'node');
      writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n[ "${'${FAKE_ACK:-1}'}" = 1 ] || exit 0\nfor ((i=1;i<=$#;i++)); do if [ "${'${!i}'}" = --ack-file ]; then j=$((i+1)); printf recorded > "${'${!j}'}"; fi; done\n`, { mode: 0o700 });
      return [
        `PATH=${JSON.stringify(nodeDir)}:$PATH`,
        `_b1353_begin_request_slice thread-1`,
        `pending="$B1353_PENDING_DIR/current-leg-3.json"`,
        `jq -e --arg file ${JSON.stringify(rollout)} '.usage_file == $file and .offset == 5 and .id == "current-leg:3"' "$pending" >/dev/null`,
        `printf '\\nappended request evidence' >> ${JSON.stringify(rollout)}`,
        'HARMONY_CONDUCTION_ID=later-conduction',
        'export FAKE_ACK=0; _b1353_recover_pending',
        `test -e "$pending"`,
        'export FAKE_ACK=1; _b1353_recover_pending',
        `test ! -e "$pending"`,
        `grep -F -- '--conduction-id current-conduction' ${JSON.stringify(log)} >/dev/null`,
        `grep -F -- '--leg-key current-leg' ${JSON.stringify(log)} >/dev/null`,
        `grep -F -- '--request-usage-offset 5' ${JSON.stringify(log)} >/dev/null`,
        `grep -F -- '--is-error' ${JSON.stringify(log)} >/dev/null`,
        `test "$(wc -l < ${JSON.stringify(log)})" -eq 2`,
        `test "$(grep -c -- '--invocation-id current-leg:3' ${JSON.stringify(log)})" -eq 2`,
      ].join('\n');
    });
    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(existsSync(join(dir, 'sessions', '.harmony-pending-costs', 'current-leg-3.json'))).toBe(false);
  });

  it('keeps a pending entry when the request transcript is unavailable', () => {
    const { result } = run((root) => {
      const sessions = join(root, 'sessions');
      const pendingDir = join(sessions, '.harmony-pending-costs'); mkdirSync(pendingDir, { recursive: true });
      const pending = join(pendingDir, 'prior-leg-2.json');
      writeFileSync(pending, JSON.stringify({ conduction_id: 'old-conduction', leg_key: 'prior-leg', gate: 'design', model: 'gpt-6-luna', id: 'prior-leg:2', usage_file: join(sessions, 'missing.jsonl'), offset: 4, index: 2 }));
      return `_b1353_recover_pending\ntest -e ${JSON.stringify(pending)}`;
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('records cold-start and model-switch boundaries without inheriting another leg model', () => {
    const { result } = run(() => {
      return [
        'B1353_REQUEST_FILE=""; B1353_REQUEST_OFFSET=0; CURRENT_MODEL=gpt-6-astra; LEG_GATE=design',
        '_b1353_begin_request_slice ""',
        `pending="$B1353_PENDING_DIR/current-leg-3.json"`,
        `jq -e '.usage_file == "" and .offset == 0 and .model == "gpt-6-astra" and .gate == "design"' "$pending" >/dev/null`,
      ].join('\n');
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
