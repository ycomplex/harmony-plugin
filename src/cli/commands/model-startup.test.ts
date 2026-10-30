// Exercise the actual provision.sh startup block with the real CLI and an injected catalog.
// Old conductors supply either spelling verbatim; no conductor normalization is assumed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'b1185-startup-'));
const root = resolve(import.meta.dirname, '../../..');
const provision = readFileSync(join(root, 'container/provision.sh'), 'utf8');
const start = provision.indexOf('    CODEX_CURRENT_MODEL=""');
const end = provision.indexOf('    RESUME_SESSION_ID=""', start);
const block = provision.slice(start, end);

beforeAll(async () => {
  mkdirSync(join(dir, 'dist/bin'), { recursive: true });
  await build({
    stdin: { contents: `import {Command} from 'commander'; import {registerModelCommands} from './src/cli/commands/model.js'; const p=new Command(); registerModelCommands(p); await p.parseAsync(process.argv);`, resolveDir: root, sourcefile: 'startup-fixture.ts' },
    outfile: join(dir, 'dist/bin/harmony.js'), bundle: true, platform: 'node', format: 'esm',
    banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
    plugins: [{ name: 'catalog-fixture', setup(b) {
      b.onLoad({ filter: /src\/cli\/auth\.ts$/ }, () => ({ loader: 'ts', contents: `export async function getAuthenticatedContext(){return {client:{from(){const r=()=>Promise.resolve(process.env.CATALOG_DOWN ? {data:null,error:{message:'offline'}} : {data:[{alias:'codex:gpt-6.1-sol',model_id:'gpt-6.1-sol',agent:'codex',active:true}],error:null});const q={select(){return q},eq(){return r()},then(a,b){return r().then(a,b)}};return q}}}}` }));
    } }],
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('B-1185 old conductor / new worker startup', () => {
  it.each(['codex:gpt-6.1-sol', 'gpt-6.1-sol'])('passes the canonical id to the runtime for old HARMONY_MODEL=%s', (model) => {
    expect(start).toBeGreaterThan(0);
    const result = spawnSync('bash', ['-c', `${block}\nprintf '%s' "$CODEX_CURRENT_MODEL"`], {
      env: { ...process.env, PLUGIN_DIR: dir, AGENT_ID: 'codex', HARMONY_MODEL: model, CATALOG_DOWN: '' }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('gpt-6.1-sol');
  });
  it.each(['gpt-6.1-sol', 'gpt-6-luna'])('passes %s through during a live catalog outage', (model) => {
    const result = spawnSync('bash', ['-c', `${block}\nprintf '%s' "$CODEX_CURRENT_MODEL"`], {
      env: { ...process.env, PLUGIN_DIR: dir, AGENT_ID: 'codex', HARMONY_MODEL: model, CATALOG_DOWN: '1' }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(model);
  });
});
