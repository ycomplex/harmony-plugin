import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { declarationSchema, selectorSchema } from './prose-ingestion.js';

// Released plugin 0.16.33. Keep immutable: npm 0.1.1 predates sync-prose.
export const RELEASED_PROSE_CLI = 'c72d5d36b876e684ca07f4f36e90418167843653';
const optionsSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use GitHub owner/repo'),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/, 'Use a literal branch name').refine(s => !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock')),
  cliCommit: z.string().regex(/^[a-f0-9]{40}$/, 'Use a full released plugin commit SHA'),
  key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  include: z.array(z.string()).min(1), exclude: z.array(z.string()),
  kind: z.enum(['document', 'skill']), scope: z.enum(['product', 'deployment', 'unresolved']),
  domain: z.array(z.enum(['engineering', 'operations', 'data', 'product', 'customer', 'process'])),
});
export type ProseInitOptions = z.input<typeof optionsSchema>;

export function proseRefreshWorkflow(branch = 'main', cliCommit = RELEASED_PROSE_CLI): string {
  // Validate values before placing them in workflow data. No user input becomes shell code.
  optionsSchema.pick({ branch: true, cliCommit: true }).parse({ branch, cliCommit });
  return stringify({
    name: 'Refresh configured prose index',
    on: { push: { branches: [branch] }, workflow_dispatch: {} },
    permissions: { contents: 'read' },
    concurrency: { group: 'prose-index-${{ github.repository }}', 'cancel-in-progress': false },
    jobs: { refresh: { 'runs-on': 'ubuntu-latest', steps: [
      { uses: 'actions/checkout@v6', with: { 'fetch-depth': 0 } },
      { name: 'Get released Harmony CLI (0.16.33 by default)', uses: 'actions/checkout@v6', with: {
        repository: 'ycomplex/harmony-plugin', ref: cliCommit, path: '.harmony-cli', 'persist-credentials': false,
      } },
      { uses: 'actions/setup-node@v6', with: { 'node-version': '22' } },
      { name: 'Move released CLI outside the source checkout', run: 'mv "$GITHUB_WORKSPACE/.harmony-cli" "$RUNNER_TEMP/harmony-cli"' },
      { name: 'Publish immutable merged source snapshot', env: { HARMONY_API_TOKEN: '${{ secrets.HARMONY_PROSE_INDEX_TOKEN }}' }, run: [
        'if [ -z "$HARMONY_API_TOKEN" ]; then',
        '  echo "::warning::HARMONY_PROSE_INDEX_TOKEN is not set; skipping the configured prose refresh for this push"',
        '  exit 0',
        'fi',
        'node "$RUNNER_TEMP/harmony-cli/dist/bin/harmony.js" knowledge sync-prose --root "$GITHUB_WORKSPACE" --commit "$GITHUB_SHA"',
      ].join('\n') + '\n' },
    ] } },
  }, { lineWidth: 0 });
}

export function initProseSources(root: string, input: ProseInitOptions) {
  const opts = optionsSchema.parse(input);
  const selector = selectorSchema.parse({ ...opts, scope: opts.scope === 'unresolved' ? null : opts.scope });
  const declaration = declarationSchema.parse({ version: 1, repository: `https://github.com/${opts.repository}`, ref: 'HEAD', sources: [{ key: opts.key, selectors: [selector] }] });
  const files = [
    { path: '.harmony/prose-sources.json', content: JSON.stringify(declaration, null, 2) + '\n' },
    { path: '.github/workflows/prose-index.yml', content: proseRefreshWorkflow(opts.branch, opts.cliCommit) },
  ];
  const base = resolve(root);
  // Check every target before creating either one, including symlinked parent directories.
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = join(base, ...parts.slice(0, i));
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
        if (i === parts.length) throw new Error(`Already exists: ${file.path}; review it manually (init never overwrites files)`);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  if (!existsSync(base)) throw new Error(`Repository directory does not exist: ${base}`);
  const written: string[] = [];
  try {
    for (const file of files) {
      const target = join(base, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: 'wx' });
      written.push(target);
    }
  } catch (error) {
    for (const path of written) unlinkSync(path);
    throw error;
  }
  return {
    files: files.map(file => file.path), cli_commit: opts.cliCommit,
    instructions: [
      `gh secret set HARMONY_PROSE_INDEX_TOKEN --repo ${opts.repository}`,
      'Use a project-scoped Harmony API token for the project to index; never a service-role key. Enter it at the secret prompt.',
      'Review the generated files, then commit and push them to ' + opts.branch + ' to run the first refresh.',
      `gh workflow run prose-index.yml --repo ${opts.repository} --ref ${opts.branch}`,
      'Use workflow_dispatch after setting the secret if the first push skipped refresh. Inspect the Actions run, then harmony knowledge prose-sources for indexed commit and diagnostics.',
    ],
  };
}
