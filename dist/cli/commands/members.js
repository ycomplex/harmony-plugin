import { listMembers } from '../../tools/members.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
export function registerMemberCommands(program) {
    const members = program.command('members').description('Manage workspace members');
    members.command('list')
        .description('List all workspace members')
        .action(async () => {
        await runCommand(program.opts(), async (ctx) => listMembers(ctx.client, ctx.projectId), (data) => formatTable(data, [
            { key: 'display_name', header: 'Name' },
            { key: 'email', header: 'Email' },
            { key: 'role', header: 'Role' },
            { key: 'user_id', header: 'User ID' },
        ]));
    });
}
//# sourceMappingURL=members.js.map