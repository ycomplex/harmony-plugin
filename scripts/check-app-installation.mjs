// Read-only setup diagnostic. No launch-time environment or credential fallback.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildJwt, mintInstallationToken } from './mint-installation-token.mjs';

export const EXPECTED_PERMISSIONS = Object.freeze({ actions: 'read', checks: 'read', contents: 'write', metadata: 'read', pull_requests: 'write', statuses: 'read', workflows: 'write' });
export const OPTIONAL_PERMISSIONS = Object.freeze({ deployments: 'read' });
const API = 'https://api.github.com';
const identifier = /^[1-9][0-9]{0,15}$/;
const name = /^[A-Za-z0-9_.-]{1,100}$/;
const repoName = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => Number.isSafeInteger(v) && v > 0;
const safeId = (v) => typeof v === 'string' && identifier.test(v) && Number.isSafeInteger(Number(v));
const fail = (code) => { throw new Error(code); };

export async function checkInstallation(opts, deps = {}) {
  const result = { app_id: null, installation_id: null, permissions: {}, permission_differences: { missing: [], extra: [], wrong_level: [] }, events: [], repository_selection: null, repositories: [], expected_permissions: false, expected_events: false, app_identity_matches: false, repositories_complete: false, ok: false };
  let stage = 'input';
  let httpStatus;
  // Public output never contains raw exceptions, HTTP bodies, headers, paths or credentials.
  try {
    if (!safeId(opts.appId) || !safeId(opts.installationId) || typeof opts.privateKeyPath !== 'string' || !opts.privateKeyPath || opts.privateKeyPath.includes('\0')) fail('invalid-input');
    result.app_id = opts.appId;
    result.installation_id = opts.installationId;
    const request = async (url, init) => {
      const expected = [ `${API}/app/installations/${opts.installationId}`, `${API}/app/installations/${opts.installationId}/access_tokens` ];
      // Also guards the imported mint helper's legacy GITHUB_API_URL override.
      if (!expected.includes(url) && !new RegExp(`^https://api\\.github\\.com/installation/repositories\\?per_page=100&page=[1-9][0-9]*$`).test(url)) fail('unsafe-origin');
      const response = await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { httpStatus = Number.isInteger(response.status) ? response.status : undefined; fail('request-failed'); }
      return response;
    };
    stage = 'key';
    const privateKey = (deps.readKey ?? ((p) => readFileSync(p, 'utf8')))(opts.privateKeyPath);
    const jwt = buildJwt({ appId: opts.appId, privateKey, nowSeconds: deps.nowSeconds });
    const headers = (credential) => ({ Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    stage = 'installation';
    const installation = await (await request(`${API}/app/installations/${opts.installationId}`, { headers: headers(jwt) })).json();
    if (!object(installation) || !id(installation.id) || !id(installation.app_id)) fail('invalid-response');
    result.app_identity_matches = String(installation.id) === opts.installationId && String(installation.app_id) === opts.appId;
    if (!result.app_identity_matches) fail('identity-mismatch');
    if (installation.suspended_at !== null) fail('suspended-or-unknown');
    if (!object(installation.permissions) || Object.keys(installation.permissions).length > 100 || !Object.entries(installation.permissions).every(([k, v]) => name.test(k) && ['read', 'write', 'admin'].includes(v))) fail('invalid-permissions');
    if (!Array.isArray(installation.events) || installation.events.length > 100 || !installation.events.every((v) => typeof v === 'string' && name.test(v))) fail('invalid-events');
    if (!['all', 'selected'].includes(installation.repository_selection)) fail('invalid-selection');
    result.permissions = Object.fromEntries(Object.entries(installation.permissions).sort(([a], [b]) => a.localeCompare(b)));
    result.events = [...installation.events].sort();
    result.repository_selection = installation.repository_selection;
    result.permission_differences = {
      missing: Object.keys(EXPECTED_PERMISSIONS).filter((k) => !(k in result.permissions)),
      extra: Object.keys(result.permissions).filter((k) => !Object.hasOwn(EXPECTED_PERMISSIONS, k) && !Object.hasOwn(OPTIONAL_PERMISSIONS, k)),
      wrong_level: Object.entries({ ...EXPECTED_PERMISSIONS, ...OPTIONAL_PERMISSIONS }).filter(([k, level]) => k in result.permissions && result.permissions[k] !== level).map(([k, level]) => ({ name: k, expected: level, actual: result.permissions[k] })),
    };
    result.expected_permissions = Object.values(result.permission_differences).every((v) => v.length === 0);
    result.expected_events = result.events.length === 0;
    stage = 'mint';
    const { token } = await mintInstallationToken({ jwt, installationId: opts.installationId, fetchImpl: request });
    if (typeof token !== 'string' || !token || token.length > 10_000) fail('invalid-token-response');
    stage = 'repositories';
    let total;
    const ids = new Set();
    const names = new Set();
    for (let page = 1; page <= 1000; page++) {
      const body = await (await request(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: headers(token) })).json();
      if (!object(body) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || body.total_count > 100_000 || !Array.isArray(body.repositories) || body.repositories.length > 100) fail('invalid-page');
      if (total !== undefined && total !== body.total_count) fail('inconsistent-total');
      total = body.total_count;
      for (const repo of body.repositories) {
        if (!object(repo) || !id(repo.id) || typeof repo.full_name !== 'string' || !repoName.test(repo.full_name) || ids.has(repo.id) || names.has(repo.full_name.toLowerCase())) fail('invalid-or-repeated-repository');
        ids.add(repo.id); names.add(repo.full_name.toLowerCase()); result.repositories.push(repo.full_name);
      }
      if (ids.size > total) fail('inconsistent-total');
      if (body.repositories.length < 100) {
        if (ids.size !== total) fail('incomplete-repositories');
        result.repositories_complete = true;
        break;
      }
    }
    if (!result.repositories_complete) fail('page-limit');
    result.repositories.sort();
    result.ok = result.expected_permissions && result.expected_events && result.app_identity_matches && result.repositories_complete;
    if (!result.ok) result.error = { stage: 'expectations', code: 'unexpected-grants-or-events' };
  } catch (err) {
    // Only codes authored in this module are allowed through. The mint helper may throw raw API text.
    const codes = new Set(['invalid-input', 'unsafe-origin', 'request-failed', 'invalid-response', 'identity-mismatch', 'suspended-or-unknown', 'invalid-permissions', 'invalid-events', 'invalid-selection', 'invalid-token-response', 'invalid-page', 'inconsistent-total', 'invalid-or-repeated-repository', 'incomplete-repositories', 'page-limit']);
    result.error = { stage, code: codes.has(err?.message) ? err.message : 'check-failed', ...(httpStatus ? { http_status: httpStatus } : {}) };
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = { '--app-id': 'appId', '--installation-id': 'installationId', '--private-key-path': 'privateKeyPath' };
  const opts = {};
  let valid = argv.length === 6;
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || opts[key] !== undefined) { valid = false; break; }
    opts[key] = argv[i + 1];
  }
  const result = await checkInstallation(valid ? opts : {});
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('App check failed\n'); process.exitCode = 1; });
