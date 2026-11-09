/**
 * `harmony await ci|pr|branch|promote` (B-1423): thin commander shell over src/tools/await.ts.
 * Needs no Harmony board auth — probes only through the `gh` CLI — so it does NOT use runCommand.
 * Exit codes: 0 met, 1 can no longer be met, 2 fatal, 3 max wait passed still pending.
 */
import { Command, CommanderError } from 'commander';
import {
  AWAIT_EXIT, awaitBranch, awaitCi, awaitPr, awaitPromote, defaultAwaitDeps, type AwaitDeps,
} from '../../tools/await.js';

function withCommon(cmd: Command): Command {
  return cmd
    .option('--interval <seconds>', 'Seconds between probes', '30')
    .option('--max-wait <seconds>', 'Give up (exit 3) after this many seconds still pending', '1800');
}

async function run(program: Command, body: (deps: AwaitDeps) => Promise<number>): Promise<void> {
  const deps = defaultAwaitDeps(Boolean(program.opts().json));
  try {
    process.exitCode = await body(deps);
  } catch (e) {
    process.stderr.write(`await: fatal — ${(e as Error).message}\n`);
    process.exitCode = AWAIT_EXIT.fatal;
  }
}

export function registerAwaitCommands(program: Command): void {
  const awaitCmd = program.command('await')
    .description('Block until a GitHub condition holds (probed through gh). Exit 0 met, 1 can no longer be met, 2 fatal, 3 max wait passed');
  // Commander's own argument errors would exit 1, which here means "can no longer be met": map them to 2.
  awaitCmd.exitOverride((err: CommanderError) => {
    process.exit(err.exitCode === 0 ? 0 : AWAIT_EXIT.fatal);
  });

  withCommon(awaitCmd.command('ci')
    .description('Wait until every check run on a commit (or a PR head) is complete and none failed')
    .option('--repo <owner/name>', 'GitHub repository')
    .option('--sha <sha>', 'Commit sha')
    .option('--pr <n>', 'Pull request number (waits on its head)'))
    .action(async (opts) => run(program, deps => awaitCi(opts, deps)));

  withCommon(awaitCmd.command('pr')
    .description('Wait until a PR is merged (default) or mergeable')
    .argument('<n>', 'Pull request number')
    .option('--repo <owner/name>', 'GitHub repository')
    .option('--until <state>', 'merged | mergeable', 'merged'))
    .action(async (n: string, opts) => run(program, deps => awaitPr(n, opts, deps)));

  withCommon(awaitCmd.command('branch')
    .description('Wait until a branch names a commit (the sha is its head or an ancestor of it)')
    .argument('<branch>', 'Branch name')
    .option('--repo <owner/name>', 'GitHub repository')
    .option('--names <sha>', 'Commit the branch must contain'))
    .action(async (branch: string, opts) => run(program, deps => awaitBranch(branch, opts, deps)));

  withCommon(awaitCmd.command('promote')
    .description('Wait until web prod names the web target and plugin prod names the plugin target')
    .option('--web-repo <owner/name>', 'Web repository', 'ycomplex/harmony-web')
    .option('--plugin-repo <owner/name>', 'Plugin repository', 'ycomplex/harmony-plugin')
    .option('--web-sha <sha>', 'Web target (default: current head of web main)')
    .option('--plugin-sha <sha>', 'Plugin target (default: current head of plugin staging)'))
    .action(async (opts) => run(program, deps => awaitPromote(opts, deps)));
}
