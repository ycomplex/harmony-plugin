import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { runCommand } from '../run-command.js';
import { loadPublisherDeclaration, runSourcePublisher } from '../source-publishers.js';
import { publishSourceInventory, readSourceInventory, comparePublishedCoverage } from '../../tools/knowledge-sources.js';
const render=(data:unknown)=>JSON.stringify(data,null,2);
export function registerSourceCommands(knowledge:Command,program:Command) {
 knowledge.command('source-inventory').requiredOption('--repository <repository>').requiredOption('--surface <surface>').action(async opts=> {
  await runCommand(program.opts(),ctx=>readSourceInventory(ctx.client,ctx.projectId,opts),render);
 });
 knowledge.command('source-publish <file>').description('Publish a complete extracted JSON inventory; no legacy fallback').action(async file=> {
  await runCommand(program.opts(),ctx=>publishSourceInventory(ctx.client,ctx.projectId,JSON.parse(readFileSync(file,'utf8'))),render);
 });
 knowledge.command('publish-values').description('Run a declared trusted publisher and publish its complete deployment inventory')
  .requiredOption('--surface <surface>').requiredOption('--run-id <id>').requiredOption('--run-url <url>')
  .option('--root <directory>','Repository checkout',process.cwd()).option('--declaration <file>','Publisher declaration','.harmony/source-publishers.json')
  .option('--output <file>','Also save extracted inventory for auditing').action(async opts=> {
   await runCommand(program.opts(),async ctx=> {
    const root=resolve(opts.root), declaration=loadPublisherDeclaration(root,opts.declaration);
    const snapshot=await readSourceInventory(ctx.client,ctx.projectId,{repository:declaration.repository,surface:opts.surface});
    const inventory=runSourcePublisher(root,declaration,opts.surface,snapshot.revision,opts.runId,opts.runUrl,snapshot.source_sha);
    if(opts.output) writeFileSync(opts.output,JSON.stringify(inventory,null,2)+'\n');
    return publishSourceInventory(ctx.client,ctx.projectId,inventory);
   },render);
  });
 knowledge.command('compare-coverage <current>').description('Exact option mentions, missing options and coverage lost since --previous')
  .requiredOption('--repository <repository>').requiredOption('--surface <surface>').option('--previous <file>').action(async(current,opts)=> {
   await runCommand(program.opts(),ctx=>comparePublishedCoverage(ctx.client,ctx.projectId,{repository:opts.repository,surface:opts.surface,current:readFileSync(current,'utf8'),previous:opts.previous?readFileSync(opts.previous,'utf8'):undefined}),render);
  });
}
