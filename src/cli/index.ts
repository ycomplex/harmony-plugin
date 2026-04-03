import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';

const program = new Command();

program
  .name('harmony')
  .description('Harmony project management CLI')
  .version('0.2.0')
  .option('--json', 'Output results as JSON', false);

registerAuthCommands(program);

program.parse();
