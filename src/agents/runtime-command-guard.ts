// B-1075: detect source that assembles an agent-runtime command (claude / codex) itself.
//
// The daemon must never build a runtime argv: the launch belongs to the worker (provision.sh
// today, the adapter registry from B-1077). src/agents/daemon-runtime-guard.test.ts runs this over
// src/daemon. Comments are stripped first, so prose that mentions `claude -p` is not a finding.

const RUNTIMES = '(?:claude|codex)';

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // spawn('claude', …) / execFile("codex", …) / exec(`claude -p …`)
  { name: 'process call on a runtime binary', re: new RegExp(`\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\\s*\\(\\s*['"\`]${RUNTIMES}\\b`) },
  // ['claude', '-p', …]
  { name: 'argv array starting with a runtime binary', re: new RegExp(`\\[\\s*['"\`]${RUNTIMES}['"\`]\\s*,`) },
  // 'claude -p …' / `codex exec …` / "claude --plugin-dir …"
  { name: 'runtime command string', re: new RegExp(`['"\`]${RUNTIMES}\\s+(?:-p|--print|--plugin-dir|--resume|--model|exec)\\b`) },
];

/** Remove block and line comments (a URL's `://` is kept). Good enough for a guard, not a parser. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')) // keep line numbers
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

export interface RuntimeCommandFinding {
  line: number;
  pattern: string;
  text: string;
}

export function findRuntimeCommandAssembly(source: string): RuntimeCommandFinding[] {
  const findings: RuntimeCommandFinding[] = [];
  stripComments(source)
    .split('\n')
    .forEach((text, i) => {
      for (const { name, re } of PATTERNS) {
        if (re.test(text)) findings.push({ line: i + 1, pattern: name, text: text.trim() });
      }
    });
  return findings;
}
