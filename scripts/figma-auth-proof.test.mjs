import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareProof } from './figma-auth-proof.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'figma-proof-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('configs use static Claude header and Codex bearer env, never a refresh credential', () => fixture(async dir => {
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'fixture-access-token\n', { mode: 0o600 });
  const result = await prepareProof(tokenFile, join(dir, 'configs'));
  const claude = JSON.parse(await readFile(result.claudeConfig, 'utf8'));
  assert.equal(claude.mcpServers.figma.headers.Authorization, 'Bearer fixture-access-token');
  const codex = await readFile(result.codexConfig, 'utf8');
  assert.match(codex, /bearer_token_env_var = "FIGMA_MCP_ACCESS_TOKEN"/);
  assert.ok(!codex.includes('fixture-access-token'));
  assert.equal((await stat(result.claudeConfig)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes('fixture-access-token'));
  await assert.rejects(prepareProof(tokenFile, result.directory), /EEXIST/);
}));

test('refuses a full OAuth grant instead of extracting its access token', () => fixture(async dir => {
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, JSON.stringify({ access_token: 'fixture', refresh_token: 'never-read' }), { mode: 0o600 });
  await assert.rejects(prepareProof(tokenFile, join(dir, 'configs')), /never an OAuth grant/);
}));

test('refuses readable token input and output directories', () => fixture(async dir => {
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'fixture', { mode: 0o644 });
  await assert.rejects(prepareProof(tokenFile, join(dir, 'configs')), /mode 0600/);
  await chmod(tokenFile, 0o600);
  await chmod(dir, 0o755);
  await assert.rejects(prepareProof(tokenFile, dir), /mode 0700/);
}));
