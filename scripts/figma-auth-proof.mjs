#!/usr/bin/env node
// B-1201: prepare access-token-only native-runtime proof configs. Never load an OAuth grant.
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareProof(tokenFile, outputDirectory) {
  const info = await stat(tokenFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Token file must be a private regular file (mode 0600).');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  // Refuse JSON grants, headers and multiline files, including accidental carried OAuth credentials.
  if (!token || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Error('Expected one access token, never an OAuth grant or bearer header.');
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dirInfo = await stat(directory);
  if ((dirInfo.mode & 0o077) !== 0) throw new Error('Proof directory must be private (mode 0700).');
  // Exclusive creation prevents overwriting or following a pre-existing symlink.
  await writeFile(resolve(directory, 'claude-mcp.json'), JSON.stringify({ mcpServers: {
    figma: { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { Authorization: `Bearer ${token}` } },
  } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(directory, 'codex.config.toml'), [
    '[mcp_servers.figma]',
    'url = "https://mcp.figma.com/mcp"',
    'bearer_token_env_var = "FIGMA_MCP_ACCESS_TOKEN"',
    'required = true',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  return { directory, claudeConfig: resolve(directory, 'claude-mcp.json'), codexConfig: resolve(directory, 'codex.config.toml') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tokenFile, directory] = process.argv.slice(2);
  try {
    if (!tokenFile || !directory) throw new Error('Usage: node scripts/figma-auth-proof.mjs <current-access-token-file> <private-output-directory>');
    const result = await prepareProof(tokenFile, directory);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    // Fixed validation/filesystem errors only: never echo file contents or token-bearing configs.
    process.stderr.write(`figma-auth-proof: ${error instanceof Error ? error.message : 'preparation failed'}\n`);
    process.exitCode = 1;
  }
}
