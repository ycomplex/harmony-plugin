// B-1074: container/cloudbuild.yaml's guard-latest step shipped with bare `$CURRENT_COMMIT_TIME` /
// `$NEW_COMMIT_TIME` reads in its bash heredoc. Google Cloud Build treats any `$NAME` in a step's
// `args` as a substitution reference and fails the WHOLE build before running any step if `NAME`
// isn't a declared/built-in substitution — so every build since the merge that introduced
// guard-latest failed outright, with no steps executed. The fix is Cloud Build's own escape
// convention: `$$NAME` literal-escapes to a single `$` at execution time, handing bash back the
// ordinary shell-variable read `$NAME`.
//
// This test scans the REAL, committed container/cloudbuild.yaml for that exact failure class, so a
// future step added to this file can't reintroduce it silently. It is a drift guard, not a full
// Cloud Build substitution-syntax parser — see the contract below.
//
// Contract for what counts as the bug class, a bare `$` followed immediately by a letter or
// underscore, in a step's `args`:
//   - `${_IMAGE}`                      → NOT a match (char after `$` is `{`, not a letter/underscore)
//   - `$(cat /workspace/foo.txt)`      → NOT a match (char after `$` is `(`, not a letter/underscore)
//   - `$CURRENT_COMMIT_TIME`           → IS a match (the bug class: Cloud Build rejects the build)
//   - `$$CURRENT_COMMIT_TIME`          → NOT a match (already escaped — the second `$` is a literal
//                                         `$` at execution time, not a live substitution reference)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const cloudbuildPath = fileURLToPath(new URL('../../container/cloudbuild.yaml', import.meta.url));

interface CloudBuildStep {
  id?: string;
  args?: unknown[];
}

interface CloudBuildConfig {
  steps: CloudBuildStep[];
}

/**
 * Finds every bare `$NAME` (a `$` immediately followed by a letter or underscore) in `text` that
 * is NOT part of an already-escaped `$$NAME` — i.e. a `$` that is itself immediately preceded by
 * another `$` is a literal-escaped `$`, not a live Cloud Build substitution reference, and is
 * skipped. `${...}` (Cloud Build's own named-substitution braces) and `$(...)` (shell command
 * substitution) never match in the first place, since the character immediately after `$` is `{`
 * or `(`, not a letter/underscore.
 */
function findBareSubstitutionReads(text: string): string[] {
  const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const precededByDollar = match.index > 0 && text[match.index - 1] === '$';
    if (precededByDollar) continue;
    matches.push(match[0]);
  }
  return matches;
}

describe('container/cloudbuild.yaml: no unescaped $NAME shell-variable reads (B-1074)', () => {
  const raw = readFileSync(cloudbuildPath, 'utf8');
  const config = parseYaml(raw) as CloudBuildConfig;

  it('parses as YAML with at least one step', () => {
    expect(Array.isArray(config.steps)).toBe(true);
    expect(config.steps.length).toBeGreaterThan(0);
  });

  it('the regex contract holds empirically against known-good forms', () => {
    expect(findBareSubstitutionReads("docker build -t '${_IMAGE}:latest' container/")).toEqual([]);
    expect(findBareSubstitutionReads('echo "$(cat /workspace/foo.txt)"')).toEqual([]);
    expect(findBareSubstitutionReads('echo "$$CURRENT_COMMIT_TIME"')).toEqual([]);
    expect(findBareSubstitutionReads('echo "$CURRENT_COMMIT_TIME"')).toEqual(['$CURRENT_COMMIT_TIME']);
  });

  it('every step\'s args carry no bare $NAME shell-variable read Cloud Build would reject the whole build on', () => {
    for (const step of config.steps) {
      const args = step.args ?? [];
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        const bad = findBareSubstitutionReads(arg);
        expect(
          bad,
          `step "${step.id ?? '(no id)'}" has unescaped Cloud Build substitution-shaped reference(s) ` +
            `${JSON.stringify(bad)} in args — Cloud Build treats bare $NAME as a substitution and ` +
            `fails the ENTIRE build (no steps run) if NAME isn't a declared substitution. Escape the ` +
            `shell-variable READ as $$NAME.`,
        ).toEqual([]);
      }
    }
  });
});

// B-1074 (fix-forward): guard-latest's `docker pull '${_IMAGE}:latest'` re-tags the LOCAL
// `${_IMAGE}:latest` reference to point at whatever the pull fetched (the stale, currently-published
// image), clobbering the tag the earlier `build` step had just put on the fresh image. Because that
// pull happens unconditionally before the decision is even made, by the time push-latest runs,
// `${_IMAGE}:latest` resolves to the OLD image regardless of guard-latest's "proceed" verdict — so
// every build re-publishes the stale image under `:latest`, forever, and the version tag (written by
// tag-version, which ran BEFORE guard-latest's clobbering pull) is the only tag that's ever correct.
//
// The fix: in the `proceed` branch, push-latest re-tags `${_IMAGE}:latest` FROM the already-correct
// version tag (`${_IMAGE}:$(cat /workspace/plugin_version.txt)`) immediately before the push, so the
// push is always of the fresh build regardless of what the guard-latest pull clobbered locally. This
// only works if the retag happens BEFORE the push in program order — a retag after the push is a
// no-op for that push. This test pins both the presence of the retag and its ordering.
describe('container/cloudbuild.yaml: push-latest retags :latest from the version tag before pushing (B-1074)', () => {
  const raw = readFileSync(cloudbuildPath, 'utf8');
  const config = parseYaml(raw) as CloudBuildConfig;

  function getStepScript(id: string): string {
    const step = config.steps.find((s) => s.id === id);
    expect(step, `no step with id "${id}" found in cloudbuild.yaml`).toBeTruthy();
    const args = (step?.args ?? []) as unknown[];
    const script = args.find((arg) => typeof arg === 'string' && arg.includes('docker')) as
      | string
      | undefined;
    expect(script, `step "${id}" has no string arg containing "docker"`).toBeTruthy();
    return script as string;
  }

  it('push-latest retags ${_IMAGE}:latest from the version tag, and does so BEFORE the push', () => {
    const script = getStepScript('push-latest');

    const tagLine = 'docker tag "${_IMAGE}:$(cat /workspace/plugin_version.txt)" \'${_IMAGE}:latest\'';
    const pushLine = "docker push '${_IMAGE}:latest'";

    expect(
      script.includes(tagLine),
      `push-latest's script does not contain the expected retag-from-version-tag line. Got:\n${script}`,
    ).toBe(true);
    expect(
      script.includes(pushLine),
      `push-latest's script does not contain the expected docker push line. Got:\n${script}`,
    ).toBe(true);

    const tagIndex = script.indexOf(tagLine);
    const pushIndex = script.indexOf(pushLine);
    expect(
      tagIndex,
      'the retag line must appear before the push line in push-latest\'s script (a retag after the push does nothing)',
    ).toBeLessThan(pushIndex);
  });

  it('the retag references the version tag written by tag-version (plugin_version.txt), not a hardcoded tag', () => {
    const script = getStepScript('push-latest');
    expect(script).toContain('plugin_version.txt');
  });
});
