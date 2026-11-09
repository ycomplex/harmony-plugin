/**
 * Child-process fixture for watch-pipe.test.ts (B-1429). Bundled by that test with esbuild and run
 * under plain node, so the REAL registered `harmony watch` command runs with the REAL stdout
 * plumbing (its error listener, process guards and `exitAfterDrain`) against a real pipe. Only the
 * board is fake: no token, no network.
 *
 *   node fixture.mjs <home> <tickets> <...watch args>
 *
 * With `--follow`, a ticket flips between paused and running on every poll, so events keep coming
 * until the reader goes away.
 */
import { Command } from 'commander';
import { FakeBoard, FakeClock, paused, ticket } from '../../watch/test-fakes.js';
import { registerWatchCommands } from './watch.js';

const [home, countArg, ...watchArgs] = process.argv.slice(2);
const count = Number(countArg);
const clock = new FakeClock();
const board = new FakeBoard(clock);
for (let n = 1; n <= count; n++) board.put(paused(n));
if (watchArgs.includes('--follow')) {
  let flip = false;
  clock.onTick(() => {
    flip = !flip;
    board.update('task-1', flip ? ticket(1) : paused(1));
  });
}

const program = new Command().option('--json');
registerWatchCommands(program, {
  home,
  makeAuth: () => ({
    getAccessToken: async () => 'tok',
    getSupabaseUrl: () => 'http://127.0.0.1:1',
    getSupabaseAnonKey: () => 'anon',
    getProjectId: () => 'p1',
    forceRefresh: async () => {},
  }),
  makeClient: () => ({}) as never,
  makeReader: () => board,
  startHints: () => null,
  resolveTarget: async () => 'custom',
  activeProjectName: () => null,
  now: clock.now,
  // Fake time, but a real turn of the event loop per sleep, so stdout's error can be delivered.
  sleep: async (ms, signal) => {
    await clock.sleep(ms, signal);
    await new Promise((r) => setTimeout(r, 1));
  },
  pollMs: 1_000,
});
await program.parseAsync(watchArgs, { from: 'user' });
