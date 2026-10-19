// B-1170: the shipped example files must stay valid against the strict schemas (an unknown key in an
// example would teach operators a config the loader rejects) and must carry placeholders only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostFileSchema, looksLikeSecretValue, ProjectFileSchema } from './conductor-config.js';

const read = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, '../../container', name), 'utf8'));

describe('container/conductor.*.example.json', () => {
  it('the project example parses against ProjectFileSchema', () => {
    const r = ProjectFileSchema.safeParse(read('conductor.project.example.json'));
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it('the host example parses against HostFileSchema', () => {
    const r = HostFileSchema.safeParse(read('conductor.host.example.json'));
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it('the host example holds secret NAMES only', () => {
    const host = read('conductor.host.example.json') as { secrets: Record<string, string> };
    for (const v of Object.values(host.secrets)) expect(looksLikeSecretValue(v)).toBe(false);
  });
});
