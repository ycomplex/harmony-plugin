// B-718: unit coverage for the local-docker-profile host-side cross-conduction resume-discovery
// script's pure parts (real filesystem — mkdtempSync scratch trees, mirroring
// mint-installation-token.test.ts's own convention for this sibling script).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSessionResumeEnabledFromFile,
  currentConductionHasSession,
  findNewestSiblingSessionId,
  composeResumeFlagsLine,
} from '../scripts/resume-discovery.mjs';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'b718-resume-discovery-'));
}

describe('isSessionResumeEnabledFromFile', () => {
  it('returns false when the run-config file does not exist', () => {
    expect(isSessionResumeEnabledFromFile(join(scratchDir(), 'nope.json'))).toBe(false);
  });

  it('returns true when the file has session_resume.enabled: true', () => {
    const dir = scratchDir();
    const file = join(dir, 'run-config.json');
    writeFileSync(file, JSON.stringify({ session_resume: { enabled: true } }));
    expect(isSessionResumeEnabledFromFile(file)).toBe(true);
  });

  it('returns false when session_resume.enabled is false', () => {
    const dir = scratchDir();
    const file = join(dir, 'run-config.json');
    writeFileSync(file, JSON.stringify({ session_resume: { enabled: false } }));
    expect(isSessionResumeEnabledFromFile(file)).toBe(false);
  });

  it('returns false (never throws) on malformed JSON — best-effort degrade', () => {
    const dir = scratchDir();
    const file = join(dir, 'run-config.json');
    writeFileSync(file, '{ not valid json');
    expect(isSessionResumeEnabledFromFile(file)).toBe(false);
  });

  it('returns false when the run-config has no session_resume key at all', () => {
    const dir = scratchDir();
    const file = join(dir, 'run-config.json');
    writeFileSync(file, JSON.stringify({}));
    expect(isSessionResumeEnabledFromFile(file)).toBe(false);
  });
});

describe('currentConductionHasSession', () => {
  it('returns false when the projects dir does not exist yet (brand-new conduction)', () => {
    const dir = scratchDir();
    expect(currentConductionHasSession(join(dir, 'projects'))).toBe(false);
  });

  it('returns false when the projects dir exists but is empty', () => {
    const dir = scratchDir();
    const projects = join(dir, 'projects');
    mkdirSync(projects, { recursive: true });
    expect(currentConductionHasSession(projects)).toBe(false);
  });

  it('returns true when a leg session .jsonl already sits under a project-slug subdir', () => {
    const dir = scratchDir();
    const slugDir = join(dir, 'projects', '-workspace-workspace');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'sess-1.jsonl'), '{}\n');
    expect(currentConductionHasSession(join(dir, 'projects'))).toBe(true);
  });
});

describe('findNewestSiblingSessionId', () => {
  it('returns null when the ticket directory does not exist', () => {
    const dir = scratchDir();
    expect(findNewestSiblingSessionId(dir, 'B-999', 'cond-current')).toBeNull();
  });

  it('returns null when the only sibling directory IS the excluded (current) conduction', () => {
    const dir = scratchDir();
    const slugDir = join(dir, 'B-718', 'cond-current', 'projects', '-workspace-workspace');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'sess-a.jsonl'), '{}\n');
    expect(findNewestSiblingSessionId(dir, 'B-718', 'cond-current')).toBeNull();
  });

  it('finds a sibling conduction session, excluding the current one', () => {
    const dir = scratchDir();
    const currentSlug = join(dir, 'B-718', 'cond-current', 'projects', '-workspace-workspace');
    mkdirSync(currentSlug, { recursive: true });
    const siblingSlug = join(dir, 'B-718', 'cond-old', 'projects', '-workspace-workspace');
    mkdirSync(siblingSlug, { recursive: true });
    writeFileSync(join(siblingSlug, 'sess-old.jsonl'), '{}\n');

    expect(findNewestSiblingSessionId(dir, 'B-718', 'cond-current')).toBe('sess-old');
  });

  it('picks the NEWEST session across multiple sibling conductions, by mtime', () => {
    const dir = scratchDir();
    const oldSlug = join(dir, 'B-718', 'cond-a', 'projects', '-workspace-workspace');
    const newSlug = join(dir, 'B-718', 'cond-b', 'projects', '-workspace-workspace');
    mkdirSync(oldSlug, { recursive: true });
    mkdirSync(newSlug, { recursive: true });
    const oldFile = join(oldSlug, 'sess-old.jsonl');
    const newFile = join(newSlug, 'sess-new.jsonl');
    writeFileSync(oldFile, '{}\n');
    writeFileSync(newFile, '{}\n');
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(oldFile, older, older);
    utimesSync(newFile, newer, newer);

    expect(findNewestSiblingSessionId(dir, 'B-718', 'cond-current')).toBe('sess-new');
  });

  it('never throws on an unreadable/racing sibling directory — degrades to skipping it', () => {
    const dir = scratchDir();
    // A ticket dir that exists but whose only entry is a FILE, not a directory (readdir on it as
    // if it were a projects dir would throw ENOTDIR) — the real-world analog is a sibling
    // conduction reaped mid-scan.
    mkdirSync(join(dir, 'B-718'), { recursive: true });
    writeFileSync(join(dir, 'B-718', 'not-a-directory'), 'x');
    expect(() => findNewestSiblingSessionId(dir, 'B-718', 'cond-current')).not.toThrow();
    expect(findNewestSiblingSessionId(dir, 'B-718', 'cond-current')).toBeNull();
  });
});

describe('composeResumeFlagsLine', () => {
  it('renders the CLAUDE_HEADLESS_FLAGS line for a discovered session id', () => {
    expect(composeResumeFlagsLine('sess-123')).toBe('CLAUDE_HEADLESS_FLAGS=--resume sess-123\n');
  });

  it('renders an empty string when no session id was found (the omit-entirely cold-start case)', () => {
    expect(composeResumeFlagsLine(null)).toBe('');
    expect(composeResumeFlagsLine(undefined)).toBe('');
  });
});

describe('end-to-end: main() appends the resume flag line to a real env-file', () => {
  it('appends CLAUDE_HEADLESS_FLAGS when enabled + a sibling session exists + the current conduction has none yet', async () => {
    const { main } = await import('../scripts/resume-discovery.mjs');
    const root = scratchDir();
    const runConfigFile = join(root, 'run-config.json');
    writeFileSync(runConfigFile, JSON.stringify({ session_resume: { enabled: true } }));
    const siblingSlug = join(root, 'B-718', 'cond-old', 'projects', '-workspace-workspace');
    mkdirSync(siblingSlug, { recursive: true });
    writeFileSync(join(siblingSlug, 'sess-old.jsonl'), '{}\n');
    const envFile = join(root, 'run.env');
    writeFileSync(envFile, 'GIT_TOKEN=dummy\n');

    await main([
      '--conductions-root',
      root,
      '--ticket',
      'B-718',
      '--conduction-id',
      'cond-new',
      '--run-config-file',
      runConfigFile,
      '--env-file',
      envFile,
    ]);

    const written = readFileSync(envFile, 'utf8');
    expect(written).toContain('GIT_TOKEN=dummy');
    expect(written).toContain('CLAUDE_HEADLESS_FLAGS=--resume sess-old');
  });

  it('is a no-op (env-file untouched) when session_resume is disabled', async () => {
    const { main } = await import('../scripts/resume-discovery.mjs');
    const root = scratchDir();
    const runConfigFile = join(root, 'run-config.json');
    writeFileSync(runConfigFile, JSON.stringify({ session_resume: { enabled: false } }));
    const siblingSlug = join(root, 'B-718', 'cond-old', 'projects', '-workspace-workspace');
    mkdirSync(siblingSlug, { recursive: true });
    writeFileSync(join(siblingSlug, 'sess-old.jsonl'), '{}\n');
    const envFile = join(root, 'run.env');
    writeFileSync(envFile, 'GIT_TOKEN=dummy\n');

    await main([
      '--conductions-root',
      root,
      '--ticket',
      'B-718',
      '--conduction-id',
      'cond-new',
      '--run-config-file',
      runConfigFile,
      '--env-file',
      envFile,
    ]);

    expect(readFileSync(envFile, 'utf8')).toBe('GIT_TOKEN=dummy\n');
  });

  it('is a no-op when no sibling session exists (first-ever conduction for this ticket)', async () => {
    const { main } = await import('../scripts/resume-discovery.mjs');
    const root = scratchDir();
    const runConfigFile = join(root, 'run-config.json');
    writeFileSync(runConfigFile, JSON.stringify({ session_resume: { enabled: true } }));
    const envFile = join(root, 'run.env');
    writeFileSync(envFile, 'GIT_TOKEN=dummy\n');

    await main([
      '--conductions-root',
      root,
      '--ticket',
      'B-718',
      '--conduction-id',
      'cond-new',
      '--run-config-file',
      runConfigFile,
      '--env-file',
      envFile,
    ]);

    expect(readFileSync(envFile, 'utf8')).toBe('GIT_TOKEN=dummy\n');
  });

  it('throws on missing required args (a template wiring bug must fail loud, unlike the discovery logic itself)', async () => {
    const { main } = await import('../scripts/resume-discovery.mjs');
    await expect(main(['--conductions-root', '/tmp'])).rejects.toThrow(/Usage: resume-discovery\.mjs/);
  });
});
