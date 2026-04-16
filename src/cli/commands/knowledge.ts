import { Command } from 'commander';
import {
  queryKnowledge,
  getKnowledgeEntry,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  supersedeKnowledgeEntry,
} from '../../tools/knowledge.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatDate } from '../formatter.js';

export function registerKnowledgeCommands(program: Command): void {
  const knowledge = program.command('knowledge').description('Manage workspace knowledge base');

  knowledge
    .command('list')
    .description('List knowledge entries with optional filters')
    .option('--type <type>', 'Filter by type (e.g. architecture, business, convention, specification)')
    .option('--status <status>', 'Filter by status')
    .option(
      '--tag <tag>',
      'Filter by tag (repeat for multiple)',
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--search <text>', 'Search term matched against title and content')
    .option('--all', 'Include superseded entries', false)
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          queryKnowledge(ctx.client, ctx.projectId, {
            type: opts.type,
            status: opts.status,
            tags: opts.tag && opts.tag.length > 0 ? opts.tag : undefined,
            search: opts.search,
            include_superseded: opts.all,
          }),
        (data) =>
          formatTable(data, [
            {
              key: 'id',
              header: 'ID',
              transform: (v: string) => v.slice(0, 8),
            },
            { key: 'title', header: 'Title', width: 40 },
            { key: 'type', header: 'Type', width: 14 },
            { key: 'status', header: 'Status', width: 12 },
            {
              key: 'tags',
              header: 'Tags',
              width: 20,
              transform: (v: string[]) => (v ?? []).join(', '),
            },
            {
              key: 'updated_at',
              header: 'Updated',
              transform: (v: string) => formatDate(v),
            },
          ]),
      );
    });

  knowledge
    .command('get')
    .description('Get full details of a knowledge entry')
    .argument('<id-or-title>', 'Entry UUID or title')
    .action(async (idOrTitle) => {
      const isUuid = /^[0-9a-f-]{36}$/i.test(idOrTitle);
      await runCommand(
        program.opts(),
        async (ctx) =>
          getKnowledgeEntry(ctx.client, ctx.projectId, {
            ...(isUuid ? { entry_id: idOrTitle } : { title: idOrTitle }),
          }),
        (entry) =>
          formatDetail([
            { label: 'ID', value: entry.id },
            { label: 'Title', value: entry.title },
            { label: 'Type', value: entry.type },
            { label: 'Status', value: entry.status },
            { label: 'Tags', value: entry.tags?.length ? entry.tags.join(', ') : '(none)' },
            { label: 'Project', value: entry.project_id ?? '(workspace-wide)' },
            { label: 'Updated', value: formatDate(entry.updated_at) },
            { label: 'Content', value: entry.content },
          ]),
      );
    });

  knowledge
    .command('create')
    .description('Create a new knowledge entry')
    .requiredOption('--title <title>', 'Entry title')
    .requiredOption('--content <content>', 'Markdown content of the entry')
    .requiredOption('--type <type>', 'Entry type: architecture, business, convention, or specification')
    .option('--status <status>', 'Status override (default: draft)')
    .option('--tags <tags>', 'Comma-separated list of tags')
    .option('--source-task <id>', 'Task ID that triggered this knowledge entry')
    .action(async (opts) => {
      const tags = opts.tags
        ? opts.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          createKnowledgeEntry(ctx.client, ctx.projectId, ctx.userId, {
            title: opts.title,
            content: opts.content,
            type: opts.type,
            status: opts.status,
            tags,
            source_task_id: opts.sourceTask,
          }),
        (entry) => `Created knowledge entry: "${entry.title}" (${entry.id})`,
      );
    });

  knowledge
    .command('update')
    .description('Update an existing knowledge entry')
    .argument('<id>', 'Entry UUID')
    .option('--title <title>', 'New title')
    .option('--content <content>', 'New markdown content')
    .option('--type <type>', 'New entry type')
    .option('--status <status>', 'New status')
    .option('--tags <tags>', 'Comma-separated list of tags (replaces existing tags)')
    .action(async (id, opts) => {
      const tags = opts.tags
        ? opts.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          updateKnowledgeEntry(ctx.client, ctx.projectId, {
            entry_id: id,
            new_title: opts.title,
            content: opts.content,
            type: opts.type,
            status: opts.status,
            tags,
          }),
        (entry) => `Updated knowledge entry: "${entry.title}" (${entry.id})`,
      );
    });

  knowledge
    .command('supersede')
    .description('Supersede an existing knowledge entry with a new replacement')
    .argument('<id>', 'UUID of the entry to supersede')
    .requiredOption('--title <title>', 'Title for the replacement entry')
    .requiredOption('--content <content>', 'Content for the replacement entry')
    .option('--type <type>', 'Type for the replacement (defaults to type of superseded entry)')
    .option('--tags <tags>', 'Comma-separated tags for the replacement')
    .action(async (id, opts) => {
      const tags = opts.tags
        ? opts.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          supersedeKnowledgeEntry(ctx.client, ctx.projectId, ctx.userId, {
            entry_id: id,
            new_title: opts.title,
            new_content: opts.content,
            type: opts.type,
            tags,
          }),
        ({ superseded, replacement }) =>
          `Superseded "${superseded.title}" → created "${replacement.title}" (${replacement.id})`,
      );
    });
}
