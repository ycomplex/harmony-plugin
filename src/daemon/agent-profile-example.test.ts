// B-1076: with a second adapter registered, the daemon's two refusals are exercised against the REAL
// example profiles in container/ (not hand-built stand-ins):
//
//   1. BOOT: a profile `agents` list that names an unregistered adapter id is refused at daemon boot,
//      on both profile routes, with a message that names the registered adapters.
//   2. FIRE TIME: a conduction requesting a non-default adapter on a launch template that lacks
//      {run_config_json} is refused before any worker launches (the worker would never see the choice
//      and would silently run the default adapter). The same conduction on a template that delivers it
//      is eligible.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDaemonConfig, type LaunchProfile } from './config.js';
import { evaluateAgentEligibility } from './agent-eligibility.js';
import { DeploymentConfigSchema } from '../config/deployment-config.js';
import { listAdapterIds } from '../agents/registry.js';

const example = (name: string): LaunchProfile & { agents?: string[] } =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../container/${name}`, import.meta.url)), 'utf8'));

const DOCKER_HOST = example('daemon-profile.docker-host.example.json');
const LOCAL_DOCKER = example('daemon-profile.example.json');
const CLOUD = example('daemon-profile.cloud.example.json');

const env = { HARMONY_API_TOKEN: 't', HARMONY_DAEMON_PROFILE: '/profile.json' };
const viaFile = (profile: object) => () => loadDaemonConfig(env, () => JSON.stringify(profile));
const viaOverride = (profile: LaunchProfile) => () => loadDaemonConfig({ HARMONY_API_TOKEN: 't' }, () => '', { profileOverride: profile });

describe('boot: the real example profiles', () => {
  it('registered adapters are claude-code and codex', () => {
    expect(listAdapterIds()).toEqual(['claude-code', 'codex']);
  });

  it('the docker-host example lists both adapters, boots on both routes, and validates against the deployment schema', () => {
    expect(DOCKER_HOST.agents).toEqual(['claude-code', 'codex']);
    expect(viaFile(DOCKER_HOST)().profile.agents).toEqual(['claude-code', 'codex']);
    expect(viaOverride(DOCKER_HOST)().profile.agents).toEqual(['claude-code', 'codex']);
    expect(DeploymentConfigSchema.parse({ profiles: { 'docker-host': DOCKER_HOST } }).profiles?.['docker-host'].agents).toEqual(['claude-code', 'codex']);
  });

  it('the local-docker and cloud examples declare no list and still boot (claude-code only)', () => {
    for (const p of [LOCAL_DOCKER, CLOUD]) {
      expect(p.agents).toBeUndefined();
      expect(viaFile(p)().profile.agents).toBeUndefined();
    }
  });

  it.each<[string, (p: LaunchProfile) => LaunchProfile]>([
    ['a misspelt id', (p) => ({ ...p, agents: ['claude-code', 'codx'] })],
    ['an adapter that was never written', (p) => ({ ...p, agents: ['opencode'] })],
    ['a registered id beside an unregistered one', (p) => ({ ...p, agents: ['codex', 'gemini', 'opencode'] })],
  ])('REFUSES to boot the docker-host example with %s — naming the registered adapters (both routes)', (_label, mutate) => {
    const bad = mutate(DOCKER_HOST);
    for (const boot of [viaFile(bad), viaOverride(bad)]) {
      expect(boot).toThrow(/unregistered agent adapter\(s\)/);
      expect(boot).toThrow(/Registered adapters: claude-code, codex\./);
    }
    const named = bad.agents!.filter((a) => !['claude-code', 'codex'].includes(a));
    for (const id of named) expect(viaFile(bad)).toThrow(`'${id}'`);
  });
});

describe('fire time: the real example launch templates', () => {
  const codexRun = { agent: { adapter: 'codex' } };

  it('the docker-host template delivers {run_config_json}: a codex run is eligible', () => {
    expect(DOCKER_HOST.launch).toContain('{run_config_json}');
    expect(
      evaluateAgentEligibility({
        runConfig: codexRun,
        profileAgents: DOCKER_HOST.agents,
        templateDeliversRunConfig: DOCKER_HOST.launch.includes('{run_config_json}'),
      }),
    ).toEqual({ eligible: true, adapter: 'codex' });
  });

  it('the same template with {run_config_json} removed: a codex run is REFUSED before any worker, naming the placeholder', () => {
    const stripped = DOCKER_HOST.launch.replace("'{run_config_json}'", "'{}'");
    expect(stripped).not.toContain('{run_config_json}');
    const r = evaluateAgentEligibility({ runConfig: codexRun, profileAgents: DOCKER_HOST.agents, templateDeliversRunConfig: stripped.includes('{run_config_json}') });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toContain('no {run_config_json} placeholder');
      expect(r.reason).toContain('Registered agent adapters: claude-code, codex.');
    }
  });

  it('the local-docker and cloud examples (no agents list) refuse a codex run as not allowed on the profile; a Claude run is untouched', () => {
    for (const p of [LOCAL_DOCKER, CLOUD]) {
      const codex = evaluateAgentEligibility({ runConfig: codexRun, profileAgents: p.agents, templateDeliversRunConfig: p.launch.includes('{run_config_json}') });
      expect(codex.eligible).toBe(false);
      if (!codex.eligible) expect(codex.reason).toContain("Agent adapter 'codex' is not allowed on this launch profile");
      expect(
        evaluateAgentEligibility({ runConfig: {}, profileAgents: p.agents, templateDeliversRunConfig: p.launch.includes('{run_config_json}') }),
      ).toEqual({ eligible: true, adapter: 'claude-code' });
    }
  });
});
