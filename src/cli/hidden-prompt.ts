// B-1501: the one hidden prompt the CLI asks for a token with (`harmony login --token-stdin` and
// `harmony download install|token set` at a terminal). Echo is off: what is typed or pasted is never
// written back to the terminal. The prompt goes to stderr, so stdout stays clean for --json.
import readline from 'node:readline/promises';

/** Ask for a token at a terminal without echoing it. The prompt goes to stderr. */
export async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  let muted = false;
  anyRl._writeToOutput = (s: string) => {
    if (!muted || s.includes('\n')) anyRl.output.write(muted ? '\n' : s);
  };
  try {
    const p = rl.question(question);
    muted = true;
    return await p;
  } finally {
    rl.close();
  }
}

export const TOKEN_PROMPT = 'Harmony API token (from Project Settings → Connect AI; it is not shown): ';
