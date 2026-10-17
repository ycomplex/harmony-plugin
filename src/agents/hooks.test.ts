// B-1150: hooks/hooks.json is the Claude rendering of the ONE canonical hook definition (hooks.ts); the
// Codex rendering is the same hooks with the absolute plugin root in place of ${CLAUDE_PLUGIN_ROOT}.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARMONY_HOOKS, renderClaudeHooks, renderCodexHooks, type HooksFile } from './hooks.js';

const HOOKS_JSON = readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8');

describe('the canonical hook definition', () => {
  it('hooks/hooks.json is exactly its Claude rendering', () => {
    expect(JSON.parse(HOOKS_JSON)).toEqual(JSON.parse(renderClaudeHooks()));
    expect(HOOKS_JSON).toBe(renderClaudeHooks());
  });

  it('positive control: a changed canonical command no longer matches hooks.json', () => {
    const mutated: HooksFile = JSON.parse(JSON.stringify(HARMONY_HOOKS)) as HooksFile;
    mutated.hooks.Stop[0].hooks[0].command += ' --changed';
    expect(JSON.parse(renderClaudeHooks(mutated))).not.toEqual(JSON.parse(HOOKS_JSON));
  });

  it('carries the SessionStart, Stop and PreToolUse hooks', () => {
    expect(Object.keys(HARMONY_HOOKS.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
  });
});

describe('the Codex rendering', () => {
  const codex = JSON.parse(renderCodexHooks('/workspace/workspace/plugin').content) as HooksFile;

  it('resolves every plugin root to the absolute path and leaves no Claude variable or placeholder', () => {
    const text = JSON.stringify(codex);
    expect(text).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(text).not.toContain('{pluginRoot}');
    // B-1149: each script command is rendered guarded (a vanished script is skipped, exit 0).
    expect(codex.hooks.Stop[0].hooks[0].command).toBe(
      'if [ -f "/workspace/workspace/plugin/hooks/stop-gate.sh" ]; then sh "/workspace/workspace/plugin/hooks/stop-gate.sh"; else exit 0; fi',
    );
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toBe(
      'if [ -f "/workspace/workspace/plugin/hooks/pretooluse-gate.sh" ]; then sh "/workspace/workspace/plugin/hooks/pretooluse-gate.sh"; else exit 0; fi',
    );
  });

  it('is the same hooks as hooks.json, modulo the root and the B-1149 script guard', () => {
    const unguarded = JSON.stringify(codex).replace(/if \[ -f \\"([^"\\]+)\\" \]; then (sh \\"\1\\"); else exit 0; fi/g, '$2');
    expect(JSON.parse(unguarded.split('/workspace/workspace/plugin').join('${CLAUDE_PLUGIN_ROOT}'))).toEqual(JSON.parse(HOOKS_JSON));
  });

  it('refuses a relative or shell-unsafe root', () => {
    expect(() => renderCodexHooks('plugin')).toThrow();
    expect(() => renderCodexHooks('/a"b')).toThrow();
    expect(() => renderCodexHooks('/a$b')).toThrow();
  });
});
