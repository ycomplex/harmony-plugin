// B-1171: the output collector the lifecycle cores share (conductor-lifecycle.ts, conductor-kube.ts).

import type { CliResult } from './conductor-config.js';

/** Collects output; `onLine` streams it as it happens (a restart takes minutes). */
export class Out {
  readonly lines: string[] = [];
  readonly errLines: string[] = [];
  constructor(private readonly onLine?: (line: string) => void) {}
  line(s = ''): void {
    this.lines.push(s);
    this.onLine?.(s);
  }
  err(s: string): void {
    this.errLines.push(s);
  }
  result(exitCode: number, data: Record<string, unknown>): CliResult {
    return { exitCode, lines: this.lines, errLines: this.errLines, data: { ok: exitCode === 0, exit_code: exitCode, ...data } };
  }
}

export const EXIT = { ok: 0, failure: 1, usage: 2, inFlight: 3, notAdopted: 4 } as const;
