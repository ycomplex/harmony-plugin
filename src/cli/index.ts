import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');
import { registerTaskCommands } from './commands/tasks.js';
import { registerQueryCommand } from './commands/query.js';
import { registerCommentCommands } from './commands/comments.js';
import { registerProjectCommands } from './commands/project.js';
import { registerMemberCommands } from './commands/members.js';
import { registerActivityCommand } from './commands/activity.js';
import { registerEpicCommands } from './commands/epics.js';
import { registerLabelCommands } from './commands/labels.js';
import { registerMilestoneCommands } from './commands/milestones.js';
import { registerCycleCommands } from './commands/cycles.js';
import { registerSubtaskCommands } from './commands/subtasks.js';
import { registerAcceptanceCriteriaCommands } from './commands/acceptance-criteria.js';
import { registerTestCaseCommands } from './commands/test-cases.js';
import { registerBulkCommands } from './commands/bulk.js';
import { registerKnowledgeCommands } from './commands/knowledge.js';

const program = new Command();

program
  .name('harmony')
  .description('Harmony project management CLI')
  .version(version)
  .option('--json', 'Output results as JSON', false);

registerAuthCommands(program);
registerTaskCommands(program);
registerQueryCommand(program);
registerCommentCommands(program);
registerProjectCommands(program);
registerMemberCommands(program);
registerActivityCommand(program);
registerEpicCommands(program);
registerLabelCommands(program);
registerMilestoneCommands(program);
registerCycleCommands(program);
registerSubtaskCommands(program);
registerAcceptanceCriteriaCommands(program);
registerTestCaseCommands(program);
registerBulkCommands(program);
registerKnowledgeCommands(program);

program.parse();
