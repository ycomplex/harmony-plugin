// B-1075 drift guard: the Claude adapter is a DESCRIPTION of the launch container/provision.sh and
// the launch scripts perform today (B-1077 makes it the launch). Both sides are read from disk, so a
// change to either — a new flag, a renamed env var, a moved session dir — fails this file until the
// other side matches. Each check is a pure function of the script text, with a positive control
// proving it catches a mutation.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeCodeAdapter as A, CLAUDE_MODEL_FLAG, CLAUDE_OUTPUT_FORMAT_FLAGS } from './claude-code.js';
import { HARMONY_MCP_CONNECTION } from './contract.js';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');

const PROVISION = read('container/provision.sh');
const CLOUD_LAUNCH = read('container/cloud-worker-launch.sh');
const DOCKER_HOST_LAUNCH = read('container/docker-host-worker-launch.sh');

const SH = { pluginDir: '"$PLUGIN_DIR"', prompt: '"$PROMPT"', resume: '"$RESUME_SESSION_ID"', model: '"$CURRENT_MODEL"' };
const EXTRA = '"${EXTRA_HEADLESS_FLAGS[@]}"';

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** Every headless invocation line, binary + argv tokens up to the stdout redirect. */
function headlessInvocations(provision: string): { binary: string; args: string[] }[] {
  return [...provision.matchAll(/^\s*_b772_run (\S+) (.*?)\s+>/gm)].map((m) => ({ binary: m[1], args: words(m[2]) }));
}

function headlessProblems(provision: string): string[] {
  const p: string[] = [];
  if (!provision.includes(`command -v ${A.launch.binary} `)) p.push(`no 'command -v ${A.launch.binary}' probe`);
  if (!provision.includes('EXTRA_HEADLESS_FLAGS_BASE=(${CLAUDE_HEADLESS_FLAGS:-})')) p.push('CLAUDE_HEADLESS_FLAGS passthrough moved');
  const outFmt = /EXTRA_HEADLESS_FLAGS_BASE\+=\(([^)]*)\)/.exec(provision);
  if (!outFmt || JSON.stringify(words(outFmt[1])) !== JSON.stringify(CLAUDE_OUTPUT_FORMAT_FLAGS)) p.push('output-format flags differ');
  if (!provision.includes(`"$b916_flag" = "${CLAUDE_OUTPUT_FORMAT_FLAGS[0]}"`)) p.push('output-format override guard differs');
  const model = /EXTRA_HEADLESS_FLAGS\+=\(([^)]*)\)/.exec(provision);
  if (!model || JSON.stringify(words(model[1])) !== JSON.stringify([CLAUDE_MODEL_FLAG, SH.model])) p.push('model flag differs');

  // Expand "${EXTRA_HEADLESS_FLAGS[@]}" the way the script builds it (no upstream flags) and compare
  // each invocation against the adapter's argv for the same symbolic inputs.
  const expanded = [...(outFmt ? words(outFmt[1]) : []), ...(model ? words(model[1]) : [])];
  const calls = headlessInvocations(provision);
  if (calls.length < 2) p.push(`expected the resume + cold invocations, found ${calls.length}`);
  if (!calls.some((c) => c.args.includes(A.session.resumeFlag))) p.push('no resume invocation');
  for (const c of calls) {
    if (c.binary !== A.launch.binary) p.push(`invocation binary '${c.binary}' ≠ '${A.launch.binary}'`);
    const shellArgv = c.args.flatMap((t) => (t === EXTRA ? expanded : [t]));
    const resumeIdx = c.args.indexOf(A.session.resumeFlag);
    const adapterArgv = A.headless.buildArgv({
      pluginDir: SH.pluginDir,
      prompt: SH.prompt,
      resumeSessionId: resumeIdx >= 0 ? c.args[resumeIdx + 1] : undefined,
      model: SH.model,
    });
    if (JSON.stringify(shellArgv) !== JSON.stringify(adapterArgv)) {
      p.push(`argv drift:\n  shell:   ${shellArgv.join(' ')}\n  adapter: ${adapterArgv.join(' ')}`);
    }
  }
  return p;
}

function authBlock(provision: string): string {
  const start = provision.indexOf(`command -v ${A.launch.binary} `);
  const end = provision.indexOf('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', start);
  return start >= 0 && end > start ? provision.slice(start, end) : '';
}

function authProblems(provision: string): string[] {
  const p: string[] = [];
  const block = authBlock(provision);
  if (!block) return ['auth block not found'];
  const shellVars = [...new Set([...block.matchAll(/\$\{([A-Z_]+):-\}/g)].map((m) => m[1]))].sort();
  const adapterVars = Object.values(A.auth.credentialEnv).sort();
  if (JSON.stringify(shellVars) !== JSON.stringify(adapterVars)) p.push(`auth env vars: shell ${shellVars} ≠ adapter ${adapterVars}`);
  for (const v of adapterVars) {
    // an empty value is treated as unset on both sides
    if (!block.includes(`[ -z "\${${v}:-}" ] && unset ${v}`)) p.push(`${v}: empty-value unset missing`);
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
  const shell = [...new Set([...body.matchAll(/printf '([A-Z_]+):/g)].map((m) => m[1]))].sort();
  const adapter = [...A.env.allowlist].sort();
  if (JSON.stringify(shell) !== JSON.stringify(adapter)) p.push(`env allowlist: shell [${shell}] ≠ adapter [${adapter}]`);
  if (!dockerHost.includes('--env-file \\"$REMOTE_RUN/run.env\\"')) p.push('docker-host no longer passes the minted run.env');
  return p;
}

describe('Claude adapter ⇄ container scripts (drift)', () => {
  it('headless invocation: binary, flags and their order match provision.sh', () => {
    expect(headlessProblems(PROVISION)).toEqual([]);
  });
  it('auth: credential env vars match provision.sh', () => {
    expect(authProblems(PROVISION)).toEqual([]);
  });
  it('the refused API-key var is the one provision.sh detects', () => {
    expect(authBlock(PROVISION)).toContain(`if [ -n "\${${A.auth.credentialEnv['api-key']}:-}" ]`);
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
  it.each<[string, string, string]>([
    ['prompt flag renamed', '-p "$PROMPT"', '--print "$PROMPT"'],
    ['binary renamed', '_b772_run claude ', '_b772_run claude-next '],
    ['model flag renamed', '(--model "$CURRENT_MODEL")', '(--model-id "$CURRENT_MODEL")'],
    ['output format changed', '+=(--output-format json)', '+=(--output-format stream-json)'],
  ])('headless: %s', (_label, from, to) => {
    expect(PROVISION.includes(from)).toBe(true);
    expect(headlessProblems(PROVISION.split(from).join(to))).not.toEqual([]);
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
