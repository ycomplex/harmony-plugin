// B-1224: execute the REAL query handler against local PostgREST before/after the ranking migration.
// Usage: node scripts/test-bookkeeping-local.mjs <web-worktree> <bundled-knowledge-module>
// Bundle for this test with esbuild src/tools/knowledge.ts --bundle --platform=node --format=esm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const [webRoot, bundle] = process.argv.slice(2);
assert(webRoot && bundle, 'Pass the local web worktree and bundled knowledge module');
const status = JSON.parse(execFileSync('npx', ['-y', 'supabase@2.105.0', 'status', '-o', 'json'], { cwd: webRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
assert(new URL(status.API_URL).hostname === '127.0.0.1', 'This fixture is LOCAL ONLY');
const containers = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n');
const container = containers.find(name => name.startsWith('supabase_db_'));
assert(container, 'Start local Supabase first');
const sql = (input) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const original = sql("select pg_get_functiondef('public.knowledge_search_rrf(uuid,uuid,text,text,text[],integer,integer)'::regprocedure);");
assert(original.includes('harmony:bookkeeping'), 'Apply the new migration before this probe');
const legacy = original.replace("coalesce(d.tags @> ARRAY['harmony:bookkeeping']::text[], false) ASC, ", '');
assert.notEqual(legacy, original);
const fixture = readFileSync(resolve(webRoot, 'supabase/tests/b1224_bookkeeping.test.sql'), 'utf8')
  .split('-- Derive the pre-change baseline')[0].replace(/^begin;$/m, '');
const { queryKnowledge } = await import(pathToFileURL(resolve(bundle)));
const client = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Deterministic embedding exercises real SQL's vector AND lexical arms without an external AI call.
client.functions.invoke = async () => ({ data: { embedding: [1, ...Array(1535).fill(0)] }, error: null });
const project = '00000000-0000-0000-0000-000001224020';
const id = n => `00000000-0000-0000-0000-00000122410${n}`;
try {
  sql('begin;\n' + fixture + '\ncommit;');
  for (const [name, definition] of [['legacy', legacy], ['migrated', original]]) {
    sql(definition);
    const query = args => queryKnowledge(client, project, args);
    assert.deepEqual((await query({ search: 'quasar', limit: 1 })).map(r => r.id), [id(2)]);
    assert.deepEqual((await query({ search: 'quasar', limit: 4 })).map(r => r.id), [id(2), id(4), id(1), id(3)]);
    assert.deepEqual((await query({ search: 'quasar', limit: 4, include_bookkeeping: false })).map(r => r.id), [id(2), id(4)]);
    assert.deepEqual((await query({ offset: 1, limit: 2 })).map(r => r.id), [id(4), id(1)]);
    assert.deepEqual((await query({ offset: 3, limit: 2 })).map(r => r.id), [id(3)]);
    assert.deepEqual((await query({ offset: 1, limit: 2, include_bookkeeping: false })).map(r => r.id), [id(4)]);
    console.log(`PASS: ${name} REST — hybrid limit=1, class order, exclusion and offset boundaries`);
  }
} finally {
  sql(original);
  sql("delete from public.workspaces where id='00000000-0000-0000-0000-000001224010'; delete from auth.users where id='00000000-0000-0000-0000-000001224001';");
}
