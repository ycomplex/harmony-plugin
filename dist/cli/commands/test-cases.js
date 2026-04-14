import { listTestCases, manageTestCases } from '../../tools/test-cases.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
export function registerTestCaseCommands(program) {
    const tests = program.command('tests').description('Manage test cases');
    tests.command('list')
        .description('List test cases for a task')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .action(async (taskId) => {
        await runCommand(program.opts(), async (ctx) => listTestCases(ctx.client, ctx.projectId, { task_id: taskId }), (data) => formatTable(data, [
            { key: 'id', header: 'ID', width: 38 },
            { key: 'name', header: 'Name', width: 50 },
            { key: 'type', header: 'Type' },
            { key: 'position', header: 'Pos' },
        ]));
    });
    tests.command('add')
        .description('Add test cases to a task')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .requiredOption('--title <titles...>', 'Test case name(s) to add')
        .option('--type <type>', 'Test type (e.g. manual, automated)')
        .action(async (taskId, opts) => {
        const titles = Array.isArray(opts.title) ? opts.title : [opts.title];
        await runCommand(program.opts(), async (ctx) => manageTestCases(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            add: titles.map((name) => ({ name, type: opts.type })),
        }), (result) => `Added ${result.added.length} test case(s)`);
    });
    tests.command('update')
        .description('Update a test case')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .requiredOption('--id <id>', 'Test case UUID')
        .option('--title <title>', 'New name')
        .option('--type <type>', 'New type')
        .action(async (taskId, opts) => {
        await runCommand(program.opts(), async (ctx) => manageTestCases(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            update: [{ id: opts.id, name: opts.title, type: opts.type }],
        }), (result) => `Updated ${result.updated.length} test case(s)`);
    });
    tests.command('delete')
        .description('Delete test cases from a task')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .requiredOption('--id <ids...>', 'Test case UUID(s) to delete')
        .action(async (taskId, opts) => {
        const ids = Array.isArray(opts.id) ? opts.id : [opts.id];
        await runCommand(program.opts(), async (ctx) => manageTestCases(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            delete: ids,
        }), (result) => `Deleted ${result.deleted.length} test case(s)`);
    });
}
//# sourceMappingURL=test-cases.js.map