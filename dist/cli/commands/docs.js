import { listProjectDocuments, getProjectDocument, createProjectDocument, updateProjectDocument, } from '../../tools/documents.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatDate } from '../formatter.js';
export function registerDocCommands(program) {
    const docs = program.command('docs').description('Manage project documents');
    docs.command('list')
        .description('List all project documents')
        .action(async () => {
        await runCommand(program.opts(), async (ctx) => listProjectDocuments(ctx.client, ctx.projectId), (data) => formatTable(data, [
            { key: 'id', header: 'ID', width: 38 },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'updated_at', header: 'Updated', transform: (v) => formatDate(v) },
        ]));
    });
    docs.command('get')
        .description('Get full content of a document by ID or title')
        .argument('<id-or-title>', 'Document UUID or exact title')
        .action(async (idOrTitle) => {
        // Try as UUID first (simple heuristic: UUIDs are 36 chars with dashes)
        const isUuid = /^[0-9a-f-]{36}$/i.test(idOrTitle);
        await runCommand(program.opts(), async (ctx) => getProjectDocument(ctx.client, ctx.projectId, isUuid
            ? { document_id: idOrTitle }
            : { title: idOrTitle }), (doc) => formatDetail([
            { label: 'ID', value: doc.id },
            { label: 'Title', value: doc.title },
            { label: 'Updated', value: formatDate(doc.updated_at) },
            { label: 'Content', value: doc.content },
        ]));
    });
    docs.command('create')
        .description('Create a new project document')
        .requiredOption('--title <title>', 'Document title (must be unique)')
        .requiredOption('--content <content>', 'Markdown content')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => createProjectDocument(ctx.client, ctx.projectId, ctx.userId, {
            title: opts.title,
            content: opts.content,
        }), (doc) => `Created document: "${doc.title}" (${doc.id})`);
    });
    docs.command('update')
        .description('Update a project document by ID or current title')
        .argument('<id>', 'Document UUID')
        .option('--title <title>', 'New title')
        .option('--content <content>', 'New markdown content')
        .action(async (id, opts) => {
        await runCommand(program.opts(), async (ctx) => updateProjectDocument(ctx.client, ctx.projectId, {
            document_id: id,
            new_title: opts.title,
            content: opts.content,
        }), (doc) => `Updated document: "${doc.title}" (${doc.id})`);
    });
}
//# sourceMappingURL=docs.js.map