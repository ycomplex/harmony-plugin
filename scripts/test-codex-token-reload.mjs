// B-1306: no inherited login, config or secrets; all credentials below are synthetic.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = spawnSync('codex', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.match(version.stdout, /\b0\.166\.0\b/, 'proof requires Codex 0.166.0');
async function scenario(withUser) {
  const home = mkdtempSync(join(tmpdir(), 'b1306-fixture-'));
  const jwt = generation => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
    exp: 4102444800,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account',
      ...(withUser ? { chatgpt_user_id: 'fixture-user' } : {}), chatgpt_plan_type: 'plus' }, generation,
  })).toString('base64url')}.fixture`;
  const tokens = [jwt(1), jwt(2)];
  const save = n => {
    writeFileSync(join(home, 'next.json'), JSON.stringify({ auth_mode: 'chatgptAuthTokens',
      OPENAI_API_KEY: null, tokens: { id_token: tokens[n], access_token: tokens[n],
        refresh_token: '', account_id: 'fixture-account' }, last_refresh: '2026-11-02T00:00:00Z' }), { mode: 0o600 });
    renameSync(join(home, 'next.json'), join(home, 'auth.json'));
  };
  save(0);
  const requests = [], unexpected = [];
  const allowed = new Set(['/v1/models', '/backend-api/ps/plugins/suggested/codex',
    '/backend-api/ps/plugins/installed', '/backend-api/plugins/featured', '/backend-api/ps/plugins/list',
    '/backend-api/wham/accounts/check', '/backend-api/wham/settings/user',
    '/backend-api/codex/analytics-events/events']);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path === '/v1/responses') {
        requests.push(tokens.indexOf((req.headers.authorization ?? '').replace('Bearer ', '')));
        if (requests.length === 1) {
          save(1);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'fixture expired', type: 'authentication_error', code: 'invalid_api_key' } }));
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture', object: 'response',
            status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
        }
      } else {
        if (!allowed.has(path)) unexpected.push(path);
        res.writeHead(allowed.has(path) ? 200 : 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
      }
    });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(join(home, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\nchatgpt_base_url = "${url}/backend-api"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n[features]\napps = false\nresponses_websockets_v2 = false\n`);
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '--json', '-C', home, 'Reply OK.'], {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    assert.deepEqual(unexpected, [], 'unexpected endpoint (including OAuth)');
    assert.deepEqual(requests, withUser ? [0, 1] : [0]);
    assert.equal(code, withUser ? 0 : 1);
    assert.match(output, withUser ? /"type":"turn.completed"/ : /application network policy is unavailable/);
    console.log(`PASS ${withUser ? 'same-process token replacement and 401 reload' : 'missing-user identity negative control'}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}
await scenario(true);
await scenario(false);
