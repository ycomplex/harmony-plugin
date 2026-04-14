import chalk from 'chalk';
import { getAuthenticatedContext } from './auth.js';
export async function runCommand(opts, handler, formatter) {
    try {
        const ctx = await getAuthenticatedContext();
        const data = await handler(ctx);
        if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
        }
        else {
            console.log(formatter(data));
        }
    }
    catch (err) {
        if (opts.json) {
            console.error(JSON.stringify({ error: err.message }));
        }
        else {
            console.error(chalk.red(`Error: ${err.message}`));
        }
        process.exit(1);
    }
}
//# sourceMappingURL=run-command.js.map