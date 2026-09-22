// B-1037 — unit coverage for the clarify-replay eval's derived-inventory diff
// (evals/clarify-replay/scripts/check-mock-inventory.mjs), run as its own CI step ahead of the
// mocked eval run. Exercises the pure diff logic plus the directory-entry filter with temp-dir /
// in-memory fixtures — no live board, no eval sandbox.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  manifestTools,
  mockToolNamesFromEntries,
  diffMockInventory,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs helper module, deliberately dependency-free and untyped
} from '../evals/clarify-replay/scripts/check-mock-inventory.mjs';

const SCRIPT = fileURLToPath(new URL('../evals/clarify-replay/scripts/check-mock-inventory.mjs', import.meta.url));

describe('manifestTools', () => {
  it('flattens reads + writes into one array', () => {
    expect(manifestTools({ reads: ['a', 'b'], writes: ['c'] })).toEqual(['a', 'b', 'c']);
  });

  it('degrades to an empty array on a manifest missing either key', () => {
    expect(manifestTools({})).toEqual([]);
    expect(manifestTools({ reads: ['a'] })).toEqual(['a']);
  });
});

describe('mockToolNamesFromEntries', () => {
  it('keeps only .md entries, stripping the extension', () => {
    expect(mockToolNamesFromEntries(['get_task.md', 'compose_brief.md'])).toEqual(['get_task', 'compose_brief']);
  });

  it('excludes _server.md, _tools.json, fixtures, .replay', () => {
    expect(
      mockToolNamesFromEntries(['get_task.md', '_server.md', '_tools.json', 'fixtures', '.replay']),
    ).toEqual(['get_task']);
  });
});

describe('diffMockInventory', () => {
  it('passes when every manifest tool has a matching mock', () => {
    const result = diffMockInventory(['get_task', 'compose_brief'], ['get_task', 'compose_brief', 'extra_tool']);
    expect(result).toEqual({ missing: [], ok: true });
  });

  it('names every manifest tool missing a mock file, loudly', () => {
    const result = diffMockInventory(['get_task', 'compose_brief', 'record_decision'], ['get_task']);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['compose_brief', 'record_decision']);
  });

  it('does not fail on an extra mock with no manifest entry', () => {
    const result = diffMockInventory(['get_task'], ['get_task', 'some_future_tool']);
    expect(result).toEqual({ missing: [], ok: true });
  });
});

describe('CLI entry point (subprocess, temp-dir fixtures)', () => {
  let dir: string;

  function write(dir_: string) {
    const manifestPath = join(dir_, 'reference-tool-calls.json');
    const mocksDir = join(dir_, 'mocks');
    mkdirSync(mocksDir, { recursive: true });
    return { manifestPath, mocksDir };
  }

  it('exits 0 and prints OK when the mock directory covers the manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'mock-inventory-pass-'));
    const { manifestPath, mocksDir } = write(dir);
    writeFileSync(manifestPath, JSON.stringify({ reads: ['get_task'], writes: ['compose_brief'] }));
    writeFileSync(join(mocksDir, 'get_task.md'), '---\n---\nok');
    writeFileSync(join(mocksDir, 'compose_brief.md'), '---\n---\nok');
    writeFileSync(join(mocksDir, '_server.md'), '---\ntools: []\n---\nok');
    writeFileSync(join(mocksDir, '_tools.json'), '{}');
    mkdirSync(join(mocksDir, 'fixtures'));

    const out = execFileSync('node', [SCRIPT, '--manifest', manifestPath, '--mocks-dir', mocksDir], {
      encoding: 'utf8',
    });
    expect(out).toContain('OK');
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits non-zero and NAMES the missing tool when a mock is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'mock-inventory-fail-'));
    const { manifestPath, mocksDir } = write(dir);
    writeFileSync(manifestPath, JSON.stringify({ reads: ['get_task'], writes: ['compose_brief'] }));
    writeFileSync(join(mocksDir, 'get_task.md'), '---\n---\nok');
    // compose_brief.md deliberately absent.

    let threw = false;
    try {
      execFileSync('node', [SCRIPT, '--manifest', manifestPath, '--mocks-dir', mocksDir], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) {
      threw = true;
      const stderr = String(err.stderr);
      expect(stderr).toContain('compose_brief');
      expect(err.status).not.toBe(0);
    }
    expect(threw).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
