import chalk from 'chalk';
import { getAuthenticatedContext, AuthenticatedContext } from './auth.js';

export async function runCommand<T>(
  opts: { json: boolean },
  handler: (ctx: AuthenticatedContext) => Promise<T>,
  formatter: (data: T) => string,
): Promise<void> {
  try {
    const ctx = await getAuthenticatedContext();
    const data = await handler(ctx);
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatter(data));
    }
  } catch (err: any) {
    if (opts.json) {
      console.error(JSON.stringify({ error: err.message }));
    } else {
      console.error(chalk.red(`Error: ${err.message}`));
    }
    process.exit(1);
  }
}
