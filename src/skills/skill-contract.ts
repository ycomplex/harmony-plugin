import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ParsedSkill {
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

const SKILLS_ROOT = join(process.cwd(), 'skills');

/** Read + parse skills/<name>/SKILL.md. Frontmatter is single-line `key: value` pairs. */
export function readSkill(name: string): ParsedSkill {
  const raw = readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${name}/SKILL.md has no frontmatter`);
  const frontmatter: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  return { frontmatter, body: m[2], raw };
}

/** Read a shared reference doc skills/harmony-shared/<name>.md (plain markdown, no frontmatter). */
export function readSharedDoc(name: string): string {
  return readFileSync(join(SKILLS_ROOT, 'harmony-shared', `${name}.md`), 'utf8');
}

/** Every distinct mcp__harmony__<tool> referenced in a body. */
export function referencedHarmonyTools(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(/mcp__harmony__([a-z_]+)/g)) set.add(m[1]);
  return [...set];
}
