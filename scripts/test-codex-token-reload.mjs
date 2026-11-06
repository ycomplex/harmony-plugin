// B-1306 / B-1407: proof that the pinned Codex CLI authenticates with the auth.json our worker installs.
// No inherited login, config or secrets: every credential below is a synthetic, unsigned fixture.
// B-1407: the whole proof runs inside a user + network namespace with only loopback up. It re-executes
// itself there, verifies the isolation, and refuses to start `codex` at all if it cannot.
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GUARD = 'HARMONY_CODEX_PROOF_NETNS';
const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

// Brings loopback up inside the new namespace via SIOCGIFFLAGS / SIOCSIFFLAGS (IFF_UP).
const LO_UP = `import fcntl, socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
ifr = struct.pack('16sH14s', b'lo', 0, b'\\x00' * 14)
flags = struct.unpack('16sH14s', fcntl.ioctl(s.fileno(), 0x8913, ifr))[1]
fcntl.ioctl(s.fileno(), 0x8914, struct.pack('16sH14s', b'lo', flags | 1, b'\\x00' * 14))
`;

if (process.env[GUARD] !== '1') {
  const dir = mkdtempSync(join(tmpdir(), 'b1407-netns-'));
  let status = 1;
  try {
    writeFileSync(join(dir, 'lo-up.py'), LO_UP, { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? tmpdir(), [GUARD]: '1' };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    const result = spawnSync('unshare', ['-rn', 'sh', '-c', 'python3 -I "$0" && exec "$1" "$2"',
      join(dir, 'lo-up.py'), process.execPath, script], { stdio: 'inherit', env });
    if (result.error) {
      console.error(`FAIL isolation: could not run unshare (${result.error.code ?? result.error.message}); codex was not started`);
    } else if (result.status !== 0) {
      console.error(`FAIL proof exited ${result.status ?? result.signal}. If no "isolation:" line appears above, the namespace or loopback could not be set up and codex was not started.`);
    }
    status = result.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status === 0 ? 0 : (status || 1));
}

function failClosed(reason) {
  console.error(`FAIL isolation: ${reason}; refusing to start codex`);
  process.exit(3);
}
const connectFails = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.once('connect', () => { socket.destroy(); resolve(null); });
  socket.once('timeout', () => { socket.destroy(); resolve(null); });
  socket.once('error', error => resolve(error.code ?? 'error'));
});
async function verifyIsolation() {
  const interfaces = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)
    .map(line => line.split(':')[0].trim()).filter(Boolean);
  if (interfaces.length !== 1 || interfaces[0] !== 'lo') failClosed(`interfaces other than lo are visible (${interfaces.join(', ')})`);
  const refused = [];
  for (const [host, port] of [['1.1.1.1', 443], ['8.8.8.8', 53], ['2606:4700:4700::1111', 443]]) {
    const code = await connectFails(host, port);
    if (!code || !['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'].includes(code)) {
      failClosed(`a connection to ${host}:${port} did not fail as unreachable (${code ?? 'connected or timed out'})`);
    }
    refused.push(`${host}:${port} ${code}`);
  }
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const loopback = await new Promise(resolve => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  server.close();
  if (!loopback) failClosed('loopback is not usable');
  console.log(`isolation: verified (interfaces: lo only; ${refused.join('; ')}; loopback ok)`);
}
await verifyIsolation();

// From here on every `codex` invocation happens inside the verified namespace.
const version = spawnSync('codex', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
const supported = readFileSync(join(root, 'container/codex-version'), 'utf8').trim();
assert.match(supported, /^[0-9]+\.[0-9]+\.[0-9]+$/, 'supported Codex pin must be an exact version');
assert.equal(version.status, 0, 'candidate Codex CLI must run');
assert.equal(version.stdout.trim(), `codex-cli ${supported}`, 'proof requires the committed supported Codex CLI');
console.log(`codex: ${version.stdout.trim()} matches container/codex-version`);

const work = mkdtempSync(join(tmpdir(), 'b1407-proof-'));
let failed = false;
try {
  // The real worker code, bundled from source at test time.
  const { build } = await import('esbuild');
  await build({
    stdin: { contents: "export { runWorker } from './src/tools/codex-auth-runtime.ts';\nexport { accessFromGrant } from './src/tools/codex-auth.ts';\n",
      resolveDir: root, loader: 'ts', sourcefile: 'b1407-proof-entry.ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: join(work, 'runtime.mjs'), logLevel: 'silent',
  });
  const { runWorker, accessFromGrant } = await import(pathToFileURL(join(work, 'runtime.mjs')).href);

  // A throwaway test CA and a separate 127.0.0.1 leaf it signs. Codex trusts the CA via CODEX_CA_CERTIFICATE.
  const tls = join(work, 'tls');
  const openssl = (...args) => {
    const r = spawnSync('openssl', args, { cwd: work, encoding: 'utf8' });
    assert.equal(r.status, 0, `openssl ${args[0]} failed: ${r.stderr}`);
  };
  spawnSync('mkdir', ['-m', '700', tls]);
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-keyout', join(tls, 'ca.key'), '-out', join(tls, 'ca.pem'), '-subj', '/CN=B-1407 fixture CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(tls, 'leaf.key'), '-out', join(tls, 'leaf.csr'), '-subj', '/CN=127.0.0.1');
  writeFileSync(join(tls, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n' +
    'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
  openssl('x509', '-req', '-in', join(tls, 'leaf.csr'), '-CA', join(tls, 'ca.pem'), '-CAkey', join(tls, 'ca.key'),
    '-set_serial', '1407', '-days', '1', '-out', join(tls, 'leaf.pem'), '-extfile', join(tls, 'leaf.ext'));
  const cert = readFileSync(join(tls, 'leaf.pem')), key = readFileSync(join(tls, 'leaf.key'));
  const caFile = join(tls, 'ca.pem');

  const ref = 'projects/fixture/secrets/harmony-codex-access';
  const ACCOUNT = 'fixture-account';
  const DETAIL = 'We got your request, but your ChatGPT login did not make it to this service.';
  // Unsigned alg:none fixtures. The signature segment is a placeholder; nothing verifies it.
  const jwt = claims => `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${
    Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
  const grant = (generation, withUser = true) => {
    const auth = { chatgpt_account_id: ACCOUNT, ...(withUser ? { chatgpt_user_id: 'fixture-user' } : {}), chatgpt_plan_type: 'plus' };
    return {
      id_token: jwt({ exp: 4102444800, email: 'fixture@example.invalid', 'https://api.openai.com/auth': auth, generation, use: 'id' }),
      access_token: jwt({ exp: 4102444800, 'https://api.openai.com/auth': auth, generation, use: 'access' }),
      refresh_token: 'fixture-owner-refresh-never-delivered', account_id: ACCOUNT,
    };
  };
  const generations = { 1: grant(1), 2: grant(2) };
  const bearerOf = header => {
    if (!header) return 'none';
    for (const [generation, g] of Object.entries(generations)) {
      if (header === `Bearer ${g.access_token}`) return `gen${generation}`;
      if (header === `Bearer ${g.id_token}`) return `id-token-gen${generation}`;
    }
    return 'unknown';
  };
  const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
  const rewrite = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

  async function scenario(name, { prepare, onResponses, check }) {
    const home = mkdtempSync(join(work, 'home-'));
    const state = { published: null, current: 1 };
    const services = {
      now: () => Date.now(),
      google: async path => {
        assert.equal(path, `${ref}/versions/latest:access`);
        return { payload: { data: Buffer.from(JSON.stringify(state.published)).toString('base64') } };
      },
      oauth: async () => { throw new Error('a worker must never refresh the owner grant'); },
      sleep: async () => {},
    };
    const ctx = {
      home, state,
      publish: generation => { state.published = accessFromGrant(generations[generation], generation, Date.now()); state.current = generation; },
      install: () => runWorker(home, ref, true, services),
    };
    const requests = [], oauth = [];
    const send = (res, status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const server = https.createServer({ cert, key }, (req, res) => {
      req.resume();
      req.on('end', async () => {
        const path = new URL(req.url, 'https://fixture').pathname;
        if (path.startsWith('/oauth/')) { oauth.push(path); return send(res, 400, { error: 'invalid_grant' }); }
        const record = { path, bearer: bearerOf(req.headers.authorization), account: req.headers['chatgpt-account-id'] === ACCOUNT };
        requests.push(record);
        if (record.bearer !== `gen${state.current}` || !record.account) { record.status = 401; return send(res, 401, { detail: DETAIL }); }
        if (path === '/backend-api/codex/responses') {
          const index = requests.filter(r => r.path === path).length - 1;
          if (onResponses && await onResponses(ctx, index)) { record.status = 401; return send(res, 401, { detail: DETAIL }); }
          record.status = 200;
          return send(res, 200, `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture', object: 'response',
            status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`, 'text/event-stream');
        }
        record.status = 200;
        if (path === '/backend-api/wham/accounts/check') {
          return send(res, 200, { accounts: [{ id: ACCOUNT, workspace_backend_origin: 'NO_CONSTRAINT', account_routing_override: 'NO_CONSTRAINT' }],
            account_ordering: [ACCOUNT], default_account_id: ACCOUNT });
        }
        if (path === '/backend-api/codex/models') return send(res, 200, { models: [] });
        return send(res, 200, {});
      });
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `https://127.0.0.1:${server.address().port}`;
      writeFileSync(join(home, 'config.toml'), `model = "fixture"\nchatgpt_base_url = "${origin}/backend-api"\n` +
        `openai_base_url = "${origin}/backend-api/codex"\n[features]\napps = false\nresponses_websockets_v2 = false\n`);
      await prepare(ctx);
      const child = spawn('codex', ['exec', '--skip-git-repo-check', '--json', '-C', home, 'Reply OK.'], {
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_CA_CERTIFICATE: caFile,
          CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${origin}/oauth/token` }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => output += chunk);
      child.stderr.on('data', chunk => output += chunk);
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (c, s) => resolve(c ?? s)); });
      clearTimeout(timer);
      // Consecutive identical requests are collapsed into one line with a count.
      const summary = [];
      for (const line of requests.map(r => `${r.path} bearer=${r.bearer} account=${r.account ? 'yes' : 'no'} -> ${r.status}`)) {
        const last = summary.at(-1);
        if (last?.line === line) last.count++; else summary.push({ line, count: 1 });
      }
      console.log(`--- ${name}: codex exit ${code}; ${requests.length} backend request(s), ${oauth.length} OAuth hit(s)`);
      for (const { line, count } of summary) console.log(`    ${line}${count > 1 ? ` (x${count})` : ''}`);
      try {
        check({ code, output, requests, oauth, ctx });
        console.log(`PASS ${name}`);
      } catch (error) {
        failed = true;
        console.log(`FAIL ${name}: ${error.message}`);
        console.log('    codex output follows:');
        for (const line of output.trim().split('\n')) console.log(`    | ${line}`);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  }
  const responses = requests => requests.filter(r => r.path === '/backend-api/codex/responses');

  // (a) Negative control: the pre-fix install shape, i.e. runWorker's output without last_refresh.
  await scenario('negative control: without last_refresh the account id goes without a bearer and the turn gets the canary 401', {
    prepare: async ctx => {
      ctx.publish(1);
      await ctx.install();
      const { last_refresh, ...preFix } = readJson(join(ctx.home, 'auth.json'));
      assert.ok(last_refresh, 'runWorker must write last_refresh');
      rewrite(join(ctx.home, 'auth.json'), preFix);
    },
    check: ({ output, requests }) => {
      assert.ok(requests.length > 0, 'codex must reach the fake backend');
      assert.deepEqual(requests.filter(r => !r.account || r.bearer !== 'none'), [], 'every request: account id, no bearer');
      // On the default provider the turn's workspace routing discovery is the first call to 401.
      assert.ok(requests.some(r => r.path === '/backend-api/wham/accounts/check' && r.status === 401), 'routing discovery must be refused');
      assert.ok(output.includes(DETAIL), 'the 401 detail must surface in codex output');
      assert.match(output, /"type":"turn.started"/);
      assert.match(output, /"type":"turn.failed".*unauthorized \(401\)/);
      assert.doesNotMatch(output, /"type":"turn.completed"/);
    },
  });

  // (b) Positive: both headers on every route; a 401 on /responses reloads generation 2 from disk.
  await scenario('runWorker install sends both headers everywhere and a 401 reloads generation 2', {
    prepare: async ctx => {
      ctx.publish(1);
      await ctx.install();
      const auth = readJson(join(ctx.home, 'auth.json'));
      assert.ok(Number.isFinite(Date.parse(auth.last_refresh)), 'last_refresh must be a timestamp');
      assert.equal(auth.tokens.refresh_token, '');
    },
    onResponses: async (ctx, index) => {
      if (index !== 0) return false;
      // The owner publishes generation 2; the worker's periodic updater installs it.
      ctx.publish(2);
      await ctx.install();
      assert.equal(readJson(join(ctx.home, 'auth.json')).tokens.access_token, generations[2].access_token);
      return true;
    },
    check: ({ code, output, requests, oauth }) => {
      const turns = responses(requests);
      const first = requests.indexOf(turns[0]);
      assert.ok(first >= 0, 'the turn must reach /responses');
      assert.deepEqual(requests.filter(r => !r.account || !['gen1', 'gen2'].includes(r.bearer)), [], 'every request: bearer and account id');
      assert.deepEqual(requests.slice(0, first + 1).filter(r => r.bearer !== 'gen1'), [], 'generation 1 until the 401');
      for (const path of ['/backend-api/wham/accounts/check', '/backend-api/codex/models']) {
        assert.ok(requests.some(r => r.path === path), `${path} must be requested`);
      }
      assert.ok(turns.length >= 2, 'codex must retry /responses after the 401');
      assert.equal(turns[1].bearer, 'gen2', 'the retry must carry generation 2');
      assert.equal(turns[1].status, 200);
      assert.deepEqual(oauth, [], 'zero OAuth hits');
      assert.equal(code, 0);
      assert.match(output, /"type":"turn.completed"/);
    },
  });

  // (c) A month-old last_refresh must not trigger any refresh in chatgptAuthTokens mode.
  await scenario('stale last_refresh still sends the bearer and records zero OAuth hits', {
    prepare: async ctx => {
      ctx.publish(1);
      await ctx.install();
      const auth = readJson(join(ctx.home, 'auth.json'));
      rewrite(join(ctx.home, 'auth.json'), { ...auth, last_refresh: new Date(Date.now() - 30 * 86400000).toISOString() });
    },
    check: ({ code, output, requests, oauth }) => {
      assert.ok(responses(requests).length > 0, 'the turn must reach /responses');
      assert.deepEqual(requests.filter(r => !r.account || r.bearer !== 'gen1'), [], 'every request: generation 1 bearer and account id');
      assert.deepEqual(oauth, [], 'zero OAuth hits');
      assert.equal(code, 0);
      assert.match(output, /"type":"turn.completed"/);
    },
  });

  // (d) B-1306 identity control: a grant without a user id never becomes an installed auth.json.
  {
    const home = mkdtempSync(join(work, 'home-'));
    try {
      const published = { ...accessFromGrant(generations[1], 1, Date.now()) };
      const userless = grant(1, false);
      published.auth = { ...published.auth, tokens: { ...published.auth.tokens, id_token: userless.id_token, access_token: userless.access_token } };
      const services = { now: () => Date.now(), sleep: async () => {}, oauth: async () => { throw new Error('unused'); },
        google: async () => ({ payload: { data: Buffer.from(JSON.stringify(published)).toString('base64') } }) };
      await assert.rejects(runWorker(home, ref, true, services), /codex-login-identity-mismatch/);
      assert.equal(existsSync(join(home, 'auth.json')), false, 'no auth.json may be installed');
      assert.throws(() => accessFromGrant(userless, 1, Date.now()), /codex-login-identity-mismatch/);
      console.log('PASS missing-user identity negative control: runWorker refuses the grant and installs nothing');
    } catch (error) {
      failed = true;
      console.log(`FAIL missing-user identity negative control: ${error.message}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS (HTTPS default provider, all routes on the loopback fake)');
