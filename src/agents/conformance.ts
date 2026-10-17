// B-1075: the agent-adapter conformance suite — one check per seam, pure, no I/O.
//
// runConformance(adapter) returns one result per seam, in seam order. Every adapter (Claude Code
// now, Codex in B-1076) must pass all ten. A seam whose functions throw is reported as a failure of
// that seam, never as a crash of the suite.

import {
  CAPABILITIES,
  HARMONY_MCP_CONNECTION,
  PLUGIN_ROOT_PLACEHOLDER,
  SEAMS,
  SEAM_NUMBER,
  type AgentAdapter,
  type SeamId,
} from './contract.js';
import { forbiddenClasses, forbiddenTool, type CapabilityClass } from './capabilities.js';
import { CREDENTIAL_VOCABULARY, deriveCostRegime, isCredentialMode } from './credentials.js';

export interface SeamResult {
  seam: SeamId;
  number: number;
  pass: boolean;
  problems: string[];
}

type Check = (a: AgentAdapter, problems: string[]) => void;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const BINARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CHECKS: Record<SeamId, Check> = {
  launch(a, p) {
    if (!BINARY_NAME.test(a.launch.binary ?? '')) p.push(`binary '${a.launch.binary}' is not a bare executable name`);
    if (!a.launch.probeArgv?.length) p.push('probeArgv is empty');
    else if (!a.launch.probeArgv.includes(a.launch.binary)) p.push('probeArgv does not name the binary');
  },

  auth(a, p) {
    const { acceptedCredentials, credentialEnv, primaryCredential, resolveCredential } = a.auth;
    const vocab = CREDENTIAL_VOCABULARY[a.family] ?? [];
    if (!acceptedCredentials?.length) p.push('no accepted credentials');
    for (const c of acceptedCredentials ?? []) {
      if (!isCredentialMode(c)) p.push(`'${c}' is not a credential mode`);
      else if (!vocab.includes(c)) p.push(`'${c}' is not in the ${a.family} vocabulary`);
      const name = credentialEnv?.[c];
      if (!name || !ENV_NAME.test(name)) p.push(`credential '${c}' has no valid env var`);
    }
    if (!acceptedCredentials?.includes(primaryCredential)) p.push(`primary credential '${primaryCredential}' is not accepted`);
    if (resolveCredential({}).ok) p.push('an empty environment resolved to a credential');
    const all: Record<string, string> = {};
    for (const c of acceptedCredentials ?? []) {
      const name = credentialEnv?.[c];
      if (!name) continue;
      all[name] = 'x';
      const r = resolveCredential({ [name]: 'x' });
      if (!r.ok || r.credential !== c) p.push(`${name} alone did not resolve to '${c}'`);
      if (resolveCredential({ [name]: '' }).ok) p.push(`an empty ${name} counted as set`);
    }
    if (Object.keys(all).length > 1 && resolveCredential(all).ok) {
      p.push('several credentials at once resolved silently (B-934: no fallback between regimes)');
    }
  },

  headless(a, p) {
    const base = { pluginDir: '/plugin', prompt: 'PROMPT TEXT' };
    const argv = a.headless.buildArgv(base);
    if (argv.filter((x) => x === base.prompt).length !== 1) p.push('the prompt is not exactly one argv element');
    if (!argv.includes(base.pluginDir)) p.push('the plugin dir is not passed');
    if (argv.some((x) => typeof x !== 'string' || x === '')) p.push('argv carries an empty or non-string element');
    if (JSON.stringify(a.headless.buildArgv(base)) !== JSON.stringify(argv)) p.push('buildArgv is not deterministic');
    const resumed = a.headless.buildArgv({ ...base, resumeSessionId: 'sess-1' });
    const ri = resumed.indexOf(a.session.resumeFlag);
    if (ri < 0 || resumed[ri + 1] !== 'sess-1') p.push('resumeSessionId is not passed after the resume flag');
    if (argv.includes(a.session.resumeFlag)) p.push('a cold start carries the resume flag');
    if (!a.headless.buildArgv({ ...base, model: 'model-x' }).includes('model-x')) p.push('model is not passed');
    if (a.headless.buildArgv({ ...base, model: '' }).length !== argv.length) p.push('an empty model changed the argv');
    if (!a.headless.buildArgv({ ...base, extraFlags: ['--extra'] }).includes('--extra')) p.push('extraFlags are dropped');
    if (a.headless.exit?.successCode !== 0) p.push('successCode is not 0');
    if (a.headless.exit?.nonZeroIsFailure !== true) p.push('a non-zero exit must fail the leg');
  },

  session(a, p) {
    const s = a.session;
    if (!s.root || !s.extension?.startsWith('.')) p.push('root / extension not declared');
    if (!s.resumeFlag) p.push('no resume flag');
    const glob = s.sessionGlob('abc-123');
    if (!glob.startsWith(s.root) || !glob.endsWith(`abc-123${s.extension}`)) p.push(`sessionGlob '${glob}' is not under root with the id`);
    const concrete = glob.replace('$HOME', '/home/worker').replace('*', 'slug');
    if (s.sessionIdFromPath(concrete) !== 'abc-123') p.push(`sessionIdFromPath did not round-trip '${concrete}'`);
    if (s.sessionIdFromPath('/tmp/unrelated.txt') !== null) p.push('sessionIdFromPath accepted a non-transcript path');
  },

  instructions(a, p) {
    const f = a.instructions.fileName;
    if (!f || f.includes('/')) p.push(`fileName '${f}' is not a bare file name`);
    const r = a.instructions.render('MARKER-BODY');
    if (r.fileName !== f) p.push('render names a different file');
    if (!r.content.includes('MARKER-BODY')) p.push('render dropped the body');
  },

  skills(a, p) {
    if (!a.skills.mechanism) p.push('no delivery mechanism');
    if (!a.skills.skillsRoot) p.push('no skills root');
    for (const f of a.skills.agentFiles ?? []) {
      if (!f.source || !f.target) p.push('an agent file lacks source or target');
    }
  },

  mcp(a, p) {
    const r = a.mcp.render(HARMONY_MCP_CONNECTION);
    if (!r.fileName) p.push('no file name');
    if (r.content.includes(PLUGIN_ROOT_PLACEHOLDER)) p.push('the plugin-root placeholder was left unresolved');
    for (const needle of [HARMONY_MCP_CONNECTION.name, HARMONY_MCP_CONNECTION.command, 'dist/index.js']) {
      if (!r.content.includes(needle)) p.push(`rendering lost '${needle}'`);
    }
  },

  env(a, p) {
    const { allowlist, standingSecrets } = a.env;
    if (!allowlist?.length) p.push('empty allowlist');
    if (new Set(allowlist).size !== allowlist.length) p.push('duplicate allowlist entries');
    for (const n of [...(allowlist ?? []), ...(standingSecrets ?? [])]) {
      if (!ENV_NAME.test(n)) p.push(`'${n}' is not an env var name`);
    }
    for (const c of a.auth.acceptedCredentials ?? []) {
      const n = a.auth.credentialEnv?.[c];
      if (n && allowlist.includes(n)) p.push(`runtime credential ${n} is in the per-leg allowlist`);
    }
  },

  capabilities(a, p) {
    for (const c of CAPABILITIES) {
      if (typeof a.capabilities?.[c] !== 'boolean') p.push(`capability '${c}' is not declared`);
    }
    if (a.capabilities?.mcp !== true) p.push('mcp is required (the harmony MCP server is how a leg reads the board)');
    // B-1150: the per-skill half. Every forbid: class is either enforced (it shows up in the rendered
    // frontmatter) or declared unenforced with a prose rule — never silently dropped.
    const sample: CapabilityClass[] = ['harmony-mcp', 'read', 'web', 'edit', 'write', 'shell', 'shell:gh', 'forbid:harmony-mcp:record_decision', 'forbid:NotebookEdit'];
    const proj = a.skillCapabilities?.project('conformance-skill', sample);
    if (!proj) {
      p.push('no skillCapabilities projection');
      return;
    }
    const rendered = Object.values(proj.frontmatter).join(' ');
    for (const f of forbiddenClasses(sample)) {
      const t = forbiddenTool(f);
      const enforced = rendered.includes(t.name);
      const declared = proj.unenforcedForbids.includes(f);
      if (!enforced && !declared) p.push(`'${f}' is neither enforced nor declared unenforced`);
    }
    if (proj.proseRules.length !== proj.unenforcedForbids.length) p.push('each unenforced forbid needs exactly one prose rule');
    if (Object.keys(proj.frontmatter).length === 0 && proj.envelope === null) p.push('no frontmatter and no envelope: the skill is bounded by nothing declared');
    let threw = false;
    try {
      a.skillCapabilities.project('conformance-skill', ['harmony-mcp', 'bogus' as CapabilityClass]);
    } catch {
      threw = true;
    }
    if (!threw) p.push('an unknown capability class was accepted');
  },

  telemetry(a, p) {
    if (a.telemetry.parse('not a result', { model: null, credential: a.auth.primaryCredential }) !== null) {
      p.push('a non-result output parsed as a result');
    }
    for (const credential of a.auth.acceptedCredentials ?? []) {
      const rec = a.telemetry.parse(a.telemetry.sampleOutput, { model: 'model-x', credential });
      if (!rec) {
        p.push('the sample output did not parse');
        break;
      }
      if (rec.runtime !== a.id) p.push(`runtime '${rec.runtime}' is not the adapter id`);
      if (rec.model !== 'model-x') p.push('model not reported');
      if (rec.credential !== credential) p.push('credential not reported');
      if (rec.costRegime !== deriveCostRegime(credential)) p.push(`cost regime for '${credential}' is not the derived one`);
    }
  },
};

export function runConformance(adapter: AgentAdapter): SeamResult[] {
  return SEAMS.map((seam) => {
    const problems: string[] = [];
    try {
      CHECKS[seam](adapter, problems);
    } catch (err) {
      problems.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { seam, number: SEAM_NUMBER[seam], pass: problems.length === 0, problems };
  });
}
