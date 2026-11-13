// B-1478 step 6: container/provision.sh runs from a released plugin directory, skips the B-1451 checkout steps
// there, shows the plugin source in its banner, and comments once on the ticket after a clone fallback.
// Same harness as the parity proof (src/test/worker-script-harness.ts): bash, PATH stubs, recorder scripts.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnv, commands, installScript, makeHarness, plantPluginDir, runScript, type Harness, type ScriptResult } from '../test/worker-script-harness.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const PROVISION = join(REPO, 'container/provision.sh');
const TOKEN = 'hmy_fixture_token_b1478';
const PROMPT = '/harmony-plugin:harmony-conduct B-42 --one-shot';

function has(cmd: string): boolean {
  try {
    execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const CAPABLE = has('bash') && has('jq');

interface Opts {
  env?: Record<string, string | undefined>;
  args?: string[];
  /** where the plugin lives: the default clone path, a release dir (not a repo) or a checkout named by HARMONY_PLUGIN_DIR */
  plugin?: 'clone' | 'release' | 'named-checkout';
}

function run(opts: Opts = {}): ScriptResult & { h: Harness; dir: string } {
  const h = makeHarness();
  let dir = h.pluginDir;
  const env: Record<string, string | undefined> = { GIT_TOKEN: 'ghs_fixture', HARMONY_API_TOKEN: TOKEN, HARMONY_PLUGIN_POSTURE: 'prod', ...opts.env };
  if (opts.plugin === 'release' || opts.plugin === 'named-checkout') {
    dir = join(h.home, 'harmony-plugin');
    plantPluginDir(h, dir, { gitRepo: opts.plugin === 'named-checkout' });
    env.HARMONY_PLUGIN_DIR = dir;
  } else {
    plantPluginDir(h);
  }
  const script = installScript(h, PROVISION, 'provision.sh');
  const r = runScript(h, script, opts.args ?? ['headless', PROMPT], baseEnv(h, env));
  return { ...r, h, dir };
}

const commentCalls = (trace: string[]) => commands(trace).filter((c) => /^node \S+ tasks comment /.test(c));

describe.skipIf(!CAPABLE)('B-1478 provision.sh: a released plugin directory', () => {
  it('runs everything from HARMONY_PLUGIN_DIR and skips the B-1451 detach / branch delete / dirty check', () => {
    const r = run({ plugin: 'release', env: { HARMONY_PLUGIN_SOURCE_RESULT: 'release' } });
    try {
      expect(r.status, r.stderr).toBe(0);
      const cmds = commands(r.trace);
      // the release dir is not a repository: only the top-level probe touches git there
      const gitOnPlugin = cmds.filter((c) => c.startsWith('git -C <ROOT>/home/harmony-plugin'));
      expect(gitOnPlugin).toEqual(['git -C <ROOT>/home/harmony-plugin rev-parse --show-toplevel']);
      expect(cmds.some((c) => c.includes('dirty-check.sh'))).toBe(false);
      expect(r.stderr).toContain('B-1451: plugin dir');
      expect(r.stderr).toContain('is not a git checkout (plugin_source=release, read-only)');
      // every plugin-relative call resolves under the release dir, none under the clone path
      expect(cmds.some((c) => c.startsWith('SCRIPT:<ROOT>/home/harmony-plugin/scripts/setup-channel-env.sh'))).toBe(true);
      expect(cmds.some((c) => c.startsWith('node <ROOT>/home/harmony-plugin/dist/bin/harmony.js agent argv'))).toBe(true);
      expect(cmds.some((c) => c.includes('<ROOT>/workspace/workspace/plugin/'))).toBe(false);
      expect(cmds.some((c) => c.startsWith('claude -p stub-prompt'))).toBe(true);
      expect(r.stdout).toMatch(/Environment confirmed: target=prod plugin_ref=prod plugin_version=9\.9\.9 plugin_source=release workdir=/);
      expect(commentCalls(r.trace)).toEqual([]);
    } finally {
      r.h.cleanup();
    }
  });

  it('a HARMONY_PLUGIN_DIR that IS its own checkout still gets the B-1451 steps', () => {
    const r = run({ plugin: 'named-checkout' });
    try {
      expect(r.status, r.stderr).toBe(0);
      const cmds = commands(r.trace);
      expect(cmds).toContain('git -C <ROOT>/home/harmony-plugin checkout -q --detach');
      expect(cmds.some((c) => c.includes('dirty-check.sh <ROOT>/home/harmony-plugin'))).toBe(true);
    } finally {
      r.h.cleanup();
    }
  });

  it('no setting: the banner says plugin_source=clone and no comment is posted', () => {
    const r = run();
    try {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(' plugin_source=clone workdir=');
      expect(commentCalls(r.trace)).toEqual([]);
    } finally {
      r.h.cleanup();
    }
  });
});

describe.skipIf(!CAPABLE)('B-1478 provision.sh: a clone fallback is reported once on the ticket', () => {
  const FALLBACK = 'clone-fallback(release.json: token refused (HTTP 401))';

  it('headless with TICKET: one comment naming the reason, through the plugin CLI, then the leg runs', () => {
    const r = run({ env: { HARMONY_PLUGIN_SOURCE_RESULT: FALLBACK, TICKET: 'B-42' } });
    try {
      expect(r.status, r.stderr).toBe(0);
      const calls = commentCalls(r.trace);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^node <ROOT>\/workspace\/workspace\/plugin\/dist\/bin\/harmony\.js tasks comment B-42 /);
      expect(calls[0]).toContain('release.json: token refused (HTTP 401)');
      expect(calls[0]).toContain('PLUGIN-SOURCE-FALLBACK');
      expect(calls[0]).not.toContain(TOKEN);
      expect(r.stdout).toContain(`plugin_source=${FALLBACK} workdir=`);
      // the comment comes before the agent, and the agent still runs
      const cmds = commands(r.trace);
      expect(cmds.findIndex((c) => c.includes('tasks comment'))).toBeLessThan(cmds.findIndex((c) => c.startsWith('claude ')));
      expect(cmds.some((c) => c.startsWith('claude -p'))).toBe(true);
    } finally {
      r.h.cleanup();
    }
  });

  it('headless without TICKET: the ticket is read from the conduct prompt', () => {
    const r = run({ env: { HARMONY_PLUGIN_SOURCE_RESULT: FALLBACK } });
    try {
      expect(r.status).toBe(0);
      expect(commentCalls(r.trace).map((c) => c.split(' ')[4])).toEqual(['B-42']);
    } finally {
      r.h.cleanup();
    }
  });

  it('headless with no ticket anywhere: nothing is posted', () => {
    const r = run({ env: { HARMONY_PLUGIN_SOURCE_RESULT: FALLBACK }, args: ['headless', 'do something'] });
    try {
      expect(r.status).toBe(0);
      expect(commentCalls(r.trace)).toEqual([]);
    } finally {
      r.h.cleanup();
    }
  });

  it('a failed post only warns: the leg continues', () => {
    const r = run({ env: { HARMONY_PLUGIN_SOURCE_RESULT: FALLBACK, TICKET: 'B-42', HARNESS_COMMENT_EXIT: '1' } });
    try {
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('B-1478: could not post the plugin-source fallback comment on B-42; continuing.');
      expect(commands(r.trace).some((c) => c.startsWith('claude -p'))).toBe(true);
    } finally {
      r.h.cleanup();
    }
  });

  it('shell mode never posts', () => {
    const r = run({ env: { HARMONY_PLUGIN_SOURCE_RESULT: FALLBACK, TICKET: 'B-42' }, args: ['shell'] });
    try {
      expect(r.status).toBe(0);
      expect(commentCalls(r.trace)).toEqual([]);
    } finally {
      r.h.cleanup();
    }
  });

  it('release and clone results never post', () => {
    for (const result of ['release', 'clone']) {
      const r = run({ env: { HARMONY_PLUGIN_SOURCE_RESULT: result, TICKET: 'B-42' } });
      try {
        expect(r.status).toBe(0);
        expect(commentCalls(r.trace)).toEqual([]);
      } finally {
        r.h.cleanup();
      }
    }
  });
});
