// B-1478 step 1: the no-setting parity proof.
//
// container/entrypoint.sh and container/provision.sh as they were before B-1478 are frozen as fixtures
// (fixtures/entrypoint.pre-b1478.sh and fixtures/provision.pre-b1478.sh, both the scripts at b32176c). Each scenario
// below runs the frozen script and the live one through the SAME harness (src/test/worker-script-harness.ts: PATH
// stubs for git, node, gh and claude, recorders for every script they exec) and compares the full normalized trace:
// every command, its argv, and the leg-relevant environment it saw. With plugin_source absent (no
// HARMONY_PLUGIN_SOURCE, no HARMONY_PLUGIN_RELEASE_URL) the two must be identical.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b64, baseEnv, commands, installScript, makeHarness, plantPluginDir, runScript, type Harness, type ScriptResult,
} from '../test/worker-script-harness.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const LIVE_ENTRY = join(REPO, 'container/entrypoint.sh');
const LIVE_PROVISION = join(REPO, 'container/provision.sh');
const FROZEN_ENTRY = fileURLToPath(new URL('./fixtures/entrypoint.pre-b1478.sh', import.meta.url));
const FROZEN_PROVISION = fileURLToPath(new URL('./fixtures/provision.pre-b1478.sh', import.meta.url));

function has(cmd: string): boolean {
  try {
    execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const CAPABLE = has('bash') && has('jq') && has('base64');

type Scenario = (h: Harness) => { env: Record<string, string>; args: string[]; prepare?: () => void };

function runBoth(source: { frozen: string; live: string }, name: string, scenario: Scenario, plant: boolean): { frozen: ScriptResult; live: ScriptResult } {
  const go = (file: string): ScriptResult => {
    const h = makeHarness();
    try {
      if (plant) plantPluginDir(h);
      const s = scenario(h);
      s.prepare?.();
      const script = installScript(h, file, name);
      return runScript(h, script, s.args, baseEnv(h, s.env));
    } finally {
      h.cleanup();
    }
  };
  return { frozen: go(source.frozen), live: go(source.live) };
}

const ENTRY = { frozen: FROZEN_ENTRY, live: LIVE_ENTRY };
const PROVISION = { frozen: FROZEN_PROVISION, live: LIVE_PROVISION };

const entryScenarios: Record<string, Scenario> = {
  'three-slot clone (no repos[]), posture unset': () => ({
    env: { GIT_TOKEN: 'ghs_fixture' },
    args: ['headless', '/harmony-plugin:harmony-conduct B-1 --one-shot'],
  }),
  'repos[] with a meta repo, the plugin entry and two others, posture ack:staging': (h) => ({
    env: {
      GIT_TOKEN: 'ghs_fixture',
      HARMONY_PLUGIN_POSTURE: 'ack:staging',
      HARMONY_REPOS_JSON: b64(JSON.stringify([
        { url: 'https://example.invalid/acme/meta.git', path: h.workspace, meta_repo_role: true, ref: 'trunk' },
        { url: 'https://example.invalid/acme/plugin.git', path: h.pluginDir, is_plugin: true, ref: 'ignored' },
        { url: 'https://example.invalid/acme/app.git', path: join(h.workspace, 'app'), ref: 'feature' },
        { url: 'https://example.invalid/acme/lib.git', path: join(h.workspace, 'lib') },
      ])),
    },
    args: ['headless', '/harmony-plugin:harmony-conduct B-2 --one-shot'],
  }),
  'cloud transcript mount (cross-conduction discovery path), posture prod': (h) => ({
    env: {
      GIT_TOKEN: 'ghs_fixture',
      HARMONY_PLUGIN_POSTURE: 'prod',
      HARMONY_TRANSCRIPT_MOUNT_ROOT: join(h.root, 'mnt'),
      CONDUCTION_ID: 'cond-1',
      TICKET: 'B-3',
      HARMONY_RUN_CONFIG_JSON: b64('{"session_resume":{"enabled":true}}'),
    },
    args: ['headless', '/harmony-plugin:harmony-conduct B-3 --one-shot'],
    prepare: () => mkdirSync(join(h.root, 'mnt/B-3/cond-0/projects/slug'), { recursive: true }),
  }),
};

const provisionScenarios: Record<string, Scenario> = {
  'headless claude-code leg in a conduction': () => ({
    env: {
      GIT_TOKEN: 'ghs_fixture',
      HARMONY_API_TOKEN: 'hmy_fixture',
      HARMONY_PLUGIN_POSTURE: 'prod',
      HARMONY_CONDUCTION_ID: 'cond-9',
      TICKET: 'B-9',
      HARMONY_MODEL: 'opus',
    },
    args: ['headless', '/harmony-plugin:harmony-conduct B-9 --one-shot'],
  }),
  'headless leg with repos[] on staging (acked)': (h) => ({
    env: {
      GIT_TOKEN: 'ghs_fixture',
      HARMONY_API_TOKEN: 'hmy_fixture',
      HARMONY_PLUGIN_POSTURE: 'ack:staging',
      HARMONY_REPOS_JSON: b64(JSON.stringify([
        { url: 'u', path: h.workspace, meta_repo_role: true },
        { url: 'u', path: h.pluginDir, is_plugin: true },
        { url: 'u', path: join(h.workspace, 'app') },
      ])),
    },
    args: ['headless', '/harmony-plugin:harmony-conduct B-8 --one-shot'],
    prepare: () => mkdirSync(join(h.workspace, 'app'), { recursive: true }),
  }),
  'dogfood shell': () => ({
    env: { GIT_TOKEN: 'ghs_fixture', HARMONY_API_TOKEN: 'hmy_fixture' },
    args: ['shell'],
  }),
};

describe.skipIf(!CAPABLE)('B-1478: no plugin_source setting = the pre-B-1478 scripts, trace for trace', () => {
  for (const [label, scenario] of Object.entries(entryScenarios)) {
    it(`entrypoint.sh: ${label}`, () => {
      const { frozen, live } = runBoth(ENTRY, 'entrypoint.sh', scenario, false);
      expect(frozen.status, frozen.stderr).toBe(0);
      // Not vacuous: the frozen run cloned and handed off to the plugin's provision.sh.
      expect(commands(frozen.trace).some((c) => c.startsWith('git clone'))).toBe(true);
      expect(commands(frozen.trace).some((c) => /^SCRIPT:<ROOT>\/workspace\/workspace\/plugin\/container\/provision\.sh/.test(c))).toBe(true);
      expect(live.status, live.stderr).toBe(frozen.status);
      expect(live.trace).toEqual(frozen.trace);
      expect(live.stderr).not.toMatch(/PLUGIN-SOURCE-FALLBACK/);
    });
  }
  for (const [label, scenario] of Object.entries(provisionScenarios)) {
    it(`provision.sh: ${label}`, () => {
      const { frozen, live } = runBoth(PROVISION, 'provision.sh', scenario, true);
      expect(frozen.status, frozen.stderr).toBe(0);
      expect(commands(frozen.trace).length).toBeGreaterThan(5);
      expect(live.status, live.stderr).toBe(frozen.status);
      expect(live.trace).toEqual(frozen.trace);
    });
  }
  it('provision.sh headless: the frozen run reached the agent and the B-1451 git steps', () => {
    const { frozen } = runBoth(PROVISION, 'provision.sh', provisionScenarios['headless claude-code leg in a conduction'], true);
    const cmds = commands(frozen.trace);
    expect(cmds.some((c) => c.startsWith('claude -p stub-prompt'))).toBe(true);
    expect(cmds.some((c) => c.includes('checkout -q --detach'))).toBe(true);
    expect(cmds.some((c) => c.includes('dirty-check.sh'))).toBe(true);
  });
});
