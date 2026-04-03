import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerTaskCommands } from './commands/tasks.js';
import { registerQueryCommand } from './commands/query.js';
import { registerCommentCommands } from './commands/comments.js';
import { registerProjectCommands } from './commands/project.js';
import { registerMemberCommands } from './commands/members.js';
import { registerActivityCommand } from './commands/activity.js';

const program = new Command();

program
  .name('harmony')
  .description('Harmony project management CLI')
  .version('0.2.0')
  .option('--json', 'Output results as JSON', false);

registerAuthCommands(program);
registerTaskCommands(program);
registerQueryCommand(program);
registerCommentCommands(program);
registerProjectCommands(program);
registerMemberCommands(program);
registerActivityCommand(program);

program.parse();
