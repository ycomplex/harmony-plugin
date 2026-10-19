// B-1164: the launchd schedule for the ticket-disk sweep. plutil is not available on every host, so the
// plist's XML is read with a small structural parser (key/value pairs of the top-level dict).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const xml = readFileSync(fileURLToPath(new URL('../../container/gke/launchd/com.ycomplex.harmony-sweep.plist', import.meta.url)), 'utf8');
const body = xml.replace(/<!--[\s\S]*?-->/g, '');

/** The string / integer / array-of-strings value following <key>name</key>. */
function value(key: string): string | number | string[] | null {
  const m = new RegExp(`<key>${key}</key>\\s*(<string>([^<]*)</string>|<integer>(\\d+)</integer>|<array>([\\s\\S]*?)</array>|<(true|false)/>)`).exec(body);
  if (!m) return null;
  if (m[2] !== undefined) return m[2];
  if (m[3] !== undefined) return Number(m[3]);
  if (m[4] !== undefined) return [...m[4].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]);
  return m[5];
}

describe('container/gke/launchd/com.ycomplex.harmony-sweep.plist', () => {
  it('is a well-formed plist document with a dict', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('<plist version="1.0">');
    expect(body).toContain('</plist>');
    for (const tag of ['dict', 'array']) {
      expect((body.match(new RegExp(`<${tag}>`, 'g')) ?? []).length).toBe((body.match(new RegExp(`</${tag}>`, 'g')) ?? []).length);
    }
  });

  it('runs the sweep for the harmony-legs namespace every 6 hours', () => {
    expect(value('Label')).toBe('com.ycomplex.harmony-sweep');
    expect(value('StartInterval')).toBe(21600);
    expect(value('ProgramArguments')).toEqual(['bash', 'container/gke/sweep-ticket-disks.sh', '--namespace', 'harmony-legs']);
  });

  it('documents its placeholders and keeps credentials out', () => {
    expect(xml).toContain('REPLACE-ME');
    expect(xml).toMatch(/<!--[\s\S]*Placeholders:[\s\S]*-->/);
    expect(body).not.toMatch(/TOKEN|SECRET/);
    expect(value('WorkingDirectory')).toBe('/REPLACE-ME/path/to/harmony-plugin');
    expect(String(value('StandardOutPath'))).toContain('REPLACE-ME');
  });
});
