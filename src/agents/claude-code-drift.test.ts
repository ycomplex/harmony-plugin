// B-1075 drift guard, rewritten by B-1077. Since B-1077 the Claude adapter IS the launch:
// container/provision.sh no longer hand-assembles the runtime command — every launch site runs the
// argv `harmony agent argv` (src/cli/commands/agent.ts) prints from the adapter registry, and the
// credential verdict comes from the adapter's auth seam via `harmony agent check-credentials`. So the
// headless/auth checks below no longer compare two copies of the command; they assert provision.sh
// launches THROUGH the adapter and keeps no copy of its own. The session/skills/env/mcp checks still
// compare the adapter's description against the scripts that implement those seams. Each check is a
// pure function of the script text, with a positive control proving it catches a mutation.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeCodeAdapter as A, CLAUDE_OUTPUT_FORMAT_FLAGS, CLAUDE_PROMPT_FLAG } from './claude-code.js';
import { HARMONY_MCP_CONNECTION } from './contract.js';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');

const PROVISION = read('container/provision.sh');
const CLOUD_LAUNCH = read('container/cloud-worker-launch.sh');
const DOCKER_HOST_LAUNCH = read('container/docker-host-worker-launch.sh');

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** Script lines with comments dropped (a whole-line `#` comment is prose, not code). */
function codeLines(script: string): string[] {
  return script.split('\n').filter((l) => !/^\s*#/.test(l));
}

/** Every `_b772_run ...` invocation line (the launch sites), first token after `_b772_run`. */
function launchSites(provision: string): string[] {
  return codeLines(provision)
    .map((l) => /^\s*_b772_run (\S+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

/** The `_agent_argv() { ... }` function body. */
function agentArgvFn(provision: string): string {
  const m = /^\s*_agent_argv\(\) \{\n([\s\S]*?)\n\s*\}\n/m.exec(provision);
  return m ? m[1] : '';
}

function headlessProblems(provision: string): string[] {
  const p: string[] = [];
  const code = codeLines(provision).join('\n');
  const sites = launchSites(provision);
  if (sites.length < 3) p.push(`expected the resume, resume-fallback and cold launch sites, found ${sites.length}`);
  for (const s of sites) {
    if (s !== '"${AGENT_ARGV[@]}"') p.push(`launch site runs '${s}', not the adapter-built "\${AGENT_ARGV[@]}"`);
  }
  // Each launch site is preceded by its own argv build; the resume site passes the resume id.
  const builds = [...code.matchAll(/^\s*_agent_argv( .*)?$/gm)].map((m) => words(m[1] ?? ''));
  if (builds.length !== sites.length) p.push(`${builds.length} _agent_argv builds for ${sites.length} launch sites`);
  if (!builds.some((b) => b[0] === '"$RESUME_SESSION_ID"')) p.push('no _agent_argv build carries the resume id');
  // The build itself is `harmony agent argv`, fed the plugin dir, prompt, model and upstream flags.
  const fn = agentArgvFn(provision);
  if (!fn) p.push('_agent_argv() not found');
  for (const needle of [
    'node "$PLUGIN_DIR/dist/bin/harmony.js" agent argv',
    `--plugin-dir "$PLUGIN_DIR" --prompt "$PROMPT"`,
    `resume_args=(--resume "$1")`,
    `model_args=(--model "$CURRENT_MODEL")`,
    '-- "${EXTRA_HEADLESS_FLAGS_BASE[@]}"',
    "read -r -d ''",
  ]) {
    if (!fn.includes(needle)) p.push(`_agent_argv() lacks ${needle}`);
  }
  if (!code.includes('EXTRA_HEADLESS_FLAGS_BASE=(${CLAUDE_HEADLESS_FLAGS:-})')) p.push('CLAUDE_HEADLESS_FLAGS passthrough moved');
  // No hand-assembled launch anywhere: the binary is never invoked as a command, and the flags the
  // adapter owns are never spelled out in code.
  const bin = A.launch.binary;
  const handBuilt = new RegExp(`^\\s*(?:exec\\s+|_b772_run\\s+)?${bin}\\s`, 'm');
  if (handBuilt.test(code)) p.push(`a hand-assembled '${bin} ...' invocation is back`);
  // (`--model "$CURRENT_MODEL"` legitimately appears as the `harmony agent argv` / `leg-cost
  // record` OPTION, so the model flag is pinned by the executed tests instead.)
  for (const flag of [CLAUDE_OUTPUT_FORMAT_FLAGS[0], `${CLAUDE_PROMPT_FLAG} "$PROMPT"`]) {
    if (code.includes(flag)) p.push(`provision.sh spells out adapter-owned flag '${flag}'`);
  }
  if (/EXTRA_HEADLESS_FLAGS_BASE\+=/.test(code)) p.push('provision.sh appends to the flag base itself (the adapter owns the output format)');
  // The presence probe asks the adapter for its binary instead of naming it.
  if (!code.includes('node "$PLUGIN_DIR/dist/bin/harmony.js" agent binary')) p.push("no 'harmony agent binary' lookup");
  if (!code.includes('command -v "$AGENT_BINARY"')) p.push('presence probe does not use $AGENT_BINARY');
  return p;
}

function authBlock(provision: string): string {
  const start = provision.indexOf('agent binary)');
  const end = provision.indexOf('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', start);
  return start >= 0 && end > start ? provision.slice(start, end) : '';
}

function authProblems(provision: string): string[] {
  const p: string[] = [];
  const block = authBlock(provision);
  if (!block) return ['auth block not found'];
  const code = codeLines(block).join('\n');
  // The verdict is the adapter's: provision.sh refuses on a non-zero check, it never decides itself.
  if (!/if ! AGENT_CREDENTIAL="\$\(node "\$PLUGIN_DIR\/dist\/bin\/harmony\.js" agent check-credentials\)"; then\n[\s\S]*?exit 1\n\s*fi/.test(code)) {
    p.push("credential check is not a refusing 'harmony agent check-credentials' call");
  }
  if (/Warning: ANTHROPIC_API_KEY/.test(code)) p.push('the old warn-and-continue API-key branch is back');
  const shellVars = [...new Set([...code.matchAll(/\$\{([A-Z_]+):-\}/g)].map((m) => m[1]))].sort();
  const adapterVars = Object.values(A.auth.credentialEnv).sort();
  if (JSON.stringify(shellVars) !== JSON.stringify(adapterVars)) p.push(`auth env vars: shell ${shellVars} ≠ adapter ${adapterVars}`);
  for (const v of adapterVars) {
    // an empty value is treated as unset on both sides
    if (!code.includes(`[ -z "\${${v}:-}" ] && unset ${v}`)) p.push(`${v}: empty-value unset missing`);
  }
  return p;
}

function sessionProblems(provision: string, dockerHost: string): string[] {
  const p: string[] = [];
  const glob = `"${A.session.root}"/*/"$RESUME_SESSION_ID${A.session.extension}"`;
  if (!provision.includes(glob)) p.push(`session lookup ${glob} not found`);
  const mount = `:${A.session.root.replace('$HOME', '/home/worker')}`;
  if (!dockerHost.includes(mount)) p.push(`docker-host session mount ${mount} not found`);
  return p;
}

function skillsProblems(provision: string): string[] {
  return A.skills.agentFiles.flatMap((f) => {
    const p: string[] = [];
    if (!provision.includes(`cp "$PLUGIN_DIR/${f.source}" "${f.target}"`)) p.push(`agent file copy ${f.source} → ${f.target} not found`);
    if (!existsSync(root(f.source))) p.push(`${f.source} does not exist`);
    return p;
  });
}

function envFileBody(cloudLaunch: string): string {
  const m = /^write_exec_env_file\(\) \{\n([\s\S]*?)\n\}\n/m.exec(cloudLaunch);
  // comment lines are prose (one quotes a printf example), not forwarded vars
  return m ? m[1].split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') : '';
}

function envProblems(cloudLaunch: string, dockerHost: string): string[] {
  const p: string[] = [];
  const body = envFileBody(cloudLaunch);
  if (!body) return ['write_exec_env_file() not found'];
  // B-1076: the Codex login-cache PATH variable is forwarded only for a Codex run (codex-drift.test.ts
  // pins its gate) — never part of a Claude leg's env.
  const shell = [...new Set([...body.matchAll(/printf '([A-Z_]+):/g)].map((m) => m[1]))].filter((n) => n !== 'HARMONY_CODEX_AUTH_FILE').sort();
  const adapter = [...A.env.allowlist].sort();
  if (JSON.stringify(shell) !== JSON.stringify(adapter)) p.push(`env allowlist: shell [${shell}] ≠ adapter [${adapter}]`);
  if (!dockerHost.includes('--env-file \\"$REMOTE_RUN/run.env\\"')) p.push('docker-host no longer passes the minted run.env');
  return p;
}

describe('provision.sh launches THROUGH the adapter (B-1077) + adapter ⇄ scripts drift', () => {
  it('headless: every launch site runs the adapter-built argv, and provision.sh hand-assembles no launch of its own', () => {
    expect(headlessProblems(PROVISION)).toEqual([]);
  });
  it('auth: the credential verdict is the adapter check (refusing), over the same env vars the adapter names', () => {
    expect(authProblems(PROVISION)).toEqual([]);
  });
  it('the refused API-key var is the adapter api-key var, and provision.sh no longer warns-and-continues on it', () => {
    expect(A.auth.credentialEnv['api-key']).toBe('ANTHROPIC_API_KEY');
    expect(authBlock(PROVISION)).toContain('agent check-credentials');
    expect(authBlock(PROVISION)).not.toContain('OVERRIDES subscription auth');
  });
  it('session: storage path matches provision.sh and the docker-host mount', () => {
    expect(sessionProblems(PROVISION, DOCKER_HOST_LAUNCH)).toEqual([]);
  });
  it('skills: agent-file delivery matches provision.sh', () => {
    expect(skillsProblems(PROVISION)).toEqual([]);
  });
  it('env: allowlist matches cloud-worker-launch.sh write_exec_env_file()', () => {
    expect(envProblems(CLOUD_LAUNCH, DOCKER_HOST_LAUNCH)).toEqual([]);
  });
  it('mcp: the canonical connection renders to the committed .mcp.json', () => {
    const rendered = A.mcp.render(HARMONY_MCP_CONNECTION);
    expect(rendered.fileName).toBe('.mcp.json');
    expect(JSON.parse(rendered.content)).toEqual(JSON.parse(read('.mcp.json')));
  });
});

describe('drift checks catch a mutation (positive controls)', () => {
  const HAND_BUILT_COLD = '_b772_run claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" "${EXTRA_HEADLESS_FLAGS_BASE[@]}" >"$COLD_STDOUT_FILE"';
  it.each<[string, string, string]>([
    ['a launch site hand-assembles the command again', '_b772_run "${AGENT_ARGV[@]}" >"$COLD_STDOUT_FILE"', HAND_BUILT_COLD],
    ['a launch site runs some other array', '_b772_run "${AGENT_ARGV[@]}" >"$FALLBACK_STDOUT_FILE"', '_b772_run "${MY_ARGV[@]}" >"$FALLBACK_STDOUT_FILE"'],
    ['the resume build drops its session id', '_agent_argv "$RESUME_SESSION_ID"', '_agent_argv ""'],
    ['a launch site loses its argv build', '        _agent_argv ""\n        COLD_STDOUT_FILE', '        COLD_STDOUT_FILE'],
    ['the argv build stops passing the model', 'model_args=(--model "$CURRENT_MODEL")', 'model_args=()'],
    ['the argv build stops passing upstream flags', '-- "${EXTRA_HEADLESS_FLAGS_BASE[@]}"', '--'],
    ['provision.sh adds the output format itself again', 'EXTRA_HEADLESS_FLAGS_BASE=(${CLAUDE_HEADLESS_FLAGS:-})\n', 'EXTRA_HEADLESS_FLAGS_BASE=(${CLAUDE_HEADLESS_FLAGS:-})\n    EXTRA_HEADLESS_FLAGS_BASE+=(--output-format json)\n'],
    ['the presence probe hardcodes the binary', 'command -v "$AGENT_BINARY"', 'command -v claude'],
  ])('headless: %s', (_label, from, to) => {
    expect(PROVISION.includes(from)).toBe(true);
    expect(headlessProblems(PROVISION.split(from).join(to))).not.toEqual([]);
  });
  it('auth: the old warn-and-continue branch comes back', () => {
    const from = 'if ! AGENT_CREDENTIAL=';
    expect(PROVISION.includes(from)).toBe(true);
    const mutated = PROVISION.replace(
      from,
      'if [ -n "${ANTHROPIC_API_KEY:-}" ]; then\n      echo "Warning: ANTHROPIC_API_KEY is set" >&2\n    fi\n    ' + from,
    );
    expect(authProblems(mutated)).not.toEqual([]);
  });
  it('auth: the credential check stops refusing', () => {
    const mutated = PROVISION.replace('agent check-credentials)"; then', 'agent check-credentials || true)"; then');
    expect(mutated).not.toBe(PROVISION);
    expect(authProblems(mutated)).not.toEqual([]);
  });
  it('auth: a new credential var', () => {
    const mutated = PROVISION.replace('[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && unset', '[ -z "${CLAUDE_API_TOKEN:-}" ] && unset');
    expect(authProblems(mutated)).not.toEqual([]);
  });
  it('session: a moved session dir', () => {
    expect(sessionProblems(PROVISION.split('.claude/projects').join('.claude/sessions'), DOCKER_HOST_LAUNCH)).not.toEqual([]);
  });
  it('skills: a moved agent file', () => {
    expect(skillsProblems(PROVISION.replace('container/agents/harmony-build.md', 'agents/harmony-build.md'))).not.toEqual([]);
  });
  it('env: a newly forwarded var', () => {
    const mutated = CLOUD_LAUNCH.replace(`printf 'TICKET: "%s"\\n' "$TICKET"`, `printf 'TICKET: "%s"\\n' "$TICKET"\n      printf 'NEW_VAR: "%s"\\n' "$X"`);
    expect(mutated).not.toBe(CLOUD_LAUNCH);
    expect(envProblems(mutated, DOCKER_HOST_LAUNCH)).not.toEqual([]);
  });
});
