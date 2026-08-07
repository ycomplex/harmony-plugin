// B-800: `harmony config get <json-path>` — the thin shell read path over the deployment config.
//
// Shell consumers (provision.sh, cloud-worker-reap.sh/probe.sh) never re-implement the deployment
// config's parsing; they call this subcommand, which is backed by the SAME zod loader as every
// TypeScript consumer (src/config/deployment-config.ts) — one place that knows the file's shape.
//
// Deliberately NOT wired through runCommand/getAuthenticatedContext (src/cli/run-command.ts): this
// reads a local file, not the Harmony API, and must work with no project logged in (a fresh
// container has no ~/.harmony/config.json yet when provision.sh first runs).

import { Command } from 'commander';
import {
  loadDeploymentConfig,
  resolveConfigPath,
  resolveDeploymentConfigPath,
} from '../../config/deployment-config.js';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Read the per-deployment config (~/.harmony/deployment.json)');

  config
    .command('get')
    .description(
      'Print the value at <json-path> (e.g. launcher.supabase.url) from the deployment config. ' +
        'Prints nothing and exits non-zero if the config is absent or the path is unset — shell ' +
        'callers should treat that as "not configured, fall back to your own default".',
    )
    .argument('<json-path>', 'Dot-path into the deployment config, e.g. launcher.supabase_refs.prod')
    .option('--config <path>', 'Explicit path to the deployment config (overrides HARMONY_DEPLOYMENT_CONFIG)')
    .action((jsonPath: string, opts: { config?: string }) => {
      const resolvedPath = resolveDeploymentConfigPath({ configPath: opts.config });
      let deploymentConfig;
      try {
        deploymentConfig = loadDeploymentConfig({ configPath: opts.config });
      } catch (err: any) {
        console.error(`harmony config get: ${err.message}`);
        process.exit(1);
        return;
      }

      if (deploymentConfig === null) {
        console.error(`harmony config get: no deployment config found at ${resolvedPath}`);
        process.exit(1);
        return;
      }

      const value = resolveConfigPath(deploymentConfig, jsonPath);
      if (value === undefined) {
        console.error(`harmony config get: '${jsonPath}' is not set in ${resolvedPath}`);
        process.exit(1);
        return;
      }

      if (typeof value === 'string') {
        console.log(value);
      } else {
        console.log(JSON.stringify(value));
      }
    });
}
