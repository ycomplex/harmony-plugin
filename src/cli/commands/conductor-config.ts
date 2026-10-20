// B-1170 (round B): `harmony conductor config <migrate|doctor|sync>` — the operator's three tools for the
// two-file conductor config (docs/conductor-config.md; the model lives in src/config/conductor-config.ts).
//
//   sync     fetch `.harmony/conductor.json` from config_repo's main into the local last-good snapshot, now.
//   migrate  propose the two files from TODAY's setup (deployment.json + the env knobs). DRY-RUN BY DEFAULT.
//            With --write it creates the NEW files only — it never modifies, renames or deletes a legacy
//            file: proving the new files suffice (by renaming the old ones away) is the operator's act.
//   doctor   explain the config: every source considered, EVERY issue (not just the first), every key set
//            to different values in two layers, every legacy source still in use. Exit 1 on any issue.
//
// Like `harmony config get` (config.ts) none of these go through runCommand/getAuthenticatedContext: they
// read local files (and, for sync, one GitHub API call), and must work with no project logged in.
//
// PURE CORE + THIN WRAPPER (the gates.ts / doctor.ts convention): runSync / runMigrate / runDoctor take
// every side effect as a dependency and RETURN what to print and which code to exit with, so the whole
// behaviour is testable against temp dirs with an injected fetch. Only `registerConductorCommands`
// touches console/process.

import { chmodSync, existsSync as fsExistsSync, mkdirSync, readFileSync as fsReadFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  ConductorConfigError,
  conductorEnvVarName,
  evaluateConductorConfig,
  formatConfigIssue,
  HOT_KEYS,
  HostFileSchema,
  LEGACY_ENV_KNOBS,
  legacyToConductor,
  missingConfigRepoIssue,
  parseJsonText,
  resolveConductorPaths,
  resolveConfigRepo,
  RESTART_ONLY_KEYS,
  zodIssuesToConfigIssues,
  type ConductorConfigIssue,
  type HostFile,
} from '../../config/conductor-config.js';
import { buildMigration } from '../../config/conductor-migrate.js';
import { readSnapshot, refreshProjectFile, type RefreshOutcome } from '../../config/conductor-project-source.js';
import { loadLegacyDeploymentConfig, resolveDeploymentConfigPath } from '../../config/deployment-config.js';
import { createGithubTokenProvider } from '../../config/github-app-token.js';
import { formatOutput } from '../formatter.js';

export interface ConductorCliDeps {
  env: NodeJS.ProcessEnv;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function defaultCliDeps(): ConductorCliDeps {
  return {
    env: process.env,
    existsSync: fsExistsSync,
    readFileSync: (p) => fsReadFileSync(p, 'utf8'),
  };
}

/** What a command wants printed and how it wants to exit. `data` is the --json payload. */
export interface CliResult {
  exitCode: number;
  lines: string[];
  errLines: string[];
  data: Record<string, unknown>;
}

const fail = (message: string, extra: Record<string, unknown> = {}): CliResult => ({
  exitCode: 1,
  lines: [],
  errLines: [message],
  data: { ok: false, error: message, ...extra },
});

/** The host file, parsed if it exists. A malformed one comes back as `issues`, never a throw. */
function readHostFile(
  deps: ConductorCliDeps,
  path: string,
): { host: HostFile | null; issues: ConductorConfigIssue[] } {
  if (!deps.existsSync(path)) return { host: null, issues: [] };
  let text: string;
  try {
    text = deps.readFileSync(path);
  } catch (err) {
    return {
      host: null,
      issues: [{ file: 'conductor-host.json', key: '(file)', problem: `could not be read: ${err instanceof Error ? err.message : String(err)}`, fix: `check that ${path} is readable` }],
    };
  }
  const parsed = parseJsonText('conductor-host.json', text);
  if (!parsed.ok) return { host: null, issues: [parsed.issue] };
  const r = HostFileSchema.safeParse(parsed.value);
  return r.success
    ? { host: r.data, issues: [] }
    : { host: null, issues: zodIssuesToConfigIssues('conductor-host.json', r.error.issues, HostFileSchema) };
}

// ---------------------------------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------------------------------

export async function runSync(deps: ConductorCliDeps): Promise<CliResult> {
  const paths = resolveConductorPaths(deps.env);
  const { host, issues } = readHostFile(deps, paths.hostFile);
  if (issues.length) {
    return fail(issues.map(formatConfigIssue).join('\n'), { issues });
  }
  let target: { repo: string; ref: string } | null;
  try {
    target = resolveConfigRepo({ hostFile: host, env: deps.env });
  } catch (err) {
    if (err instanceof ConductorConfigError) return fail(err.message, { issues: err.issues });
    throw err;
  }
  if (!target) {
    const issue = missingConfigRepoIssue();
    return fail(formatConfigIssue(issue), { issues: [issue] });
  }
  const tokenProvider = createGithubTokenProvider({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    appOverride: host?.github_app,
  });
  if (!tokenProvider) {
    return fail(
      'no GitHub credential: cannot read the project file. Fix: add github_app { app_id, installation_id, private_key_path } to ' +
        `${paths.hostFile}, or export GH_TOKEN for a one-off sync`,
    );
  }
  const r = await refreshProjectFile({
    repo: target.repo,
    ref: target.ref,
    snapshotPath: paths.snapshotFile,
    tokenProvider,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  const snap = readSnapshot(paths.snapshotFile);
  const where = `${target.repo}@${target.ref}`;
  const lines: string[] = [];
  const outcomeLine: Record<RefreshOutcome, string> = {
    updated: `updated: snapshot ${paths.snapshotFile} now holds ${where} (sha ${snap?.sha ?? 'unknown'})`,
    unchanged: `unchanged: ${where} matches the snapshot ${paths.snapshotFile}`,
    'kept-last-good': `kept-last-good: ${where} is invalid, the previous snapshot stays in force`,
    unreachable: `unreachable: could not read ${where}`,
  };
  lines.push(outcomeLine[r.outcome]);
  for (const w of r.warnings) lines.push(`warning: ${w}`);

  const usable = snap !== null;
  const degraded = r.outcome === 'kept-last-good' || r.outcome === 'unreachable';
  let exitCode = 0;
  const errLines: string[] = [];
  if (degraded && usable) {
    lines.push(`WARNING: the project file was NOT refreshed; the conductor keeps running on the last-good snapshot (fetched ${snap.fetched_at}).`);
  } else if (degraded) {
    exitCode = 1;
    errLines.push(`no snapshot exists and ${where} could not be read, so there is no project configuration yet`);
  }
  return {
    exitCode,
    lines,
    errLines,
    data: { ok: exitCode === 0, outcome: r.outcome, repo: target.repo, ref: target.ref, snapshot: paths.snapshotFile, snapshot_sha: snap?.sha ?? null, warnings: r.warnings },
  };
}

// ---------------------------------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------------------------------

export interface MigrateOptions {
  profile?: string;
  config?: string;
  write?: boolean;
  outProject?: string;
  outHost?: string;
  force?: boolean;
}

const pretty = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export function runMigrate(deps: ConductorCliDeps, opts: MigrateOptions): CliResult {
  const legacyPath = resolveDeploymentConfigPath({ configPath: opts.config, env: deps.env });
  let migration;
  try {
    const legacy = loadLegacyDeploymentConfig({
      configPath: opts.config,
      env: deps.env,
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync,
    });
    migration = buildMigration({ legacyDeployment: legacy, env: deps.env, profileName: opts.profile });
  } catch (err) {
    if (err instanceof ConductorConfigError) return fail(`${err.message}`, { issues: err.issues });
    return fail(err instanceof Error ? err.message : String(err));
  }

  const paths = resolveConductorPaths(deps.env);
  const outHost = opts.outHost ? resolve(opts.outHost) : paths.hostFile;
  const outProject = opts.outProject ? resolve(opts.outProject) : undefined;
  const projectText = pretty(migration.projectFile);
  const hostText = pretty(migration.hostFile);
  const written: string[] = [];

  if (opts.write) {
    if (!outProject) {
      return fail('--write needs --out-project <path> (there is no implicit default: the project file belongs in config_repo, not in the current directory)');
    }
    const targets = [outProject, outHost];
    if (outProject === outHost) return fail('--out-project and --out-host name the same file');
    for (const t of targets) {
      if (t === resolve(legacyPath)) {
        return fail(`refusing to write ${t}: it is the legacy deployment config, which migrate never modifies`);
      }
    }
    const existing = targets.filter((t) => deps.existsSync(t));
    if (existing.length && !opts.force) {
      return fail(`refusing to overwrite ${existing.join(', ')} (pass --force to replace it; nothing was written)`);
    }
    mkdirSync(dirname(outProject), { recursive: true });
    writeFileSync(outProject, projectText, { mode: 0o644 });
    written.push(outProject);
    mkdirSync(dirname(outHost), { recursive: true });
    writeFileSync(outHost, hostText, { mode: 0o600 });
    chmodSync(outHost, 0o600); // the mode above only applies when the file is created
    written.push(outHost);
  }

  const lines: string[] = [];
  lines.push(opts.write ? 'conductor config migrate: WROTE the new files' : 'conductor config migrate: DRY RUN, nothing written (add --write --out-project <path> to create the files)');
  lines.push('', `# PROJECT file (commit as .harmony/conductor.json in config_repo)${written.includes(outProject ?? '') ? ` -> ${outProject}` : ''}`, projectText.trimEnd());
  lines.push('', `# HOST file (${outHost})${opts.write ? ' [mode 0600]' : ''}`, hostText.trimEnd());
  lines.push('', `DROPPED (${migration.dropped.length}) — not carried into the new files:`);
  if (migration.dropped.length === 0) lines.push('  (none)');
  for (const d of migration.dropped) lines.push(`  - ${d.item}: ${d.reason}`);
  lines.push('', `WARNINGS (${migration.warnings.length}):`);
  if (migration.warnings.length === 0) lines.push('  (none)');
  for (const w of migration.warnings) lines.push(`  - ${w}`);
  lines.push('', `Old files left untouched (${legacyPath} and any daemon.env); to prove the new files suffice, rename them away yourself.`);
  lines.push(
    '',
    'Next steps:',
    `  1. ${migration.hostFile.config_repo ? 'Check' : 'Add'} "config_repo": "owner/name" in the host file (the repo whose main holds .harmony/conductor.json).`,
    '  2. Commit the project file to config_repo as .harmony/conductor.json on main, through a normal PR.',
    `  3. Put the host file in place at ${paths.hostFile} (mode 0600).`,
    '  4. Run `harmony conductor config sync`, then `harmony conductor config doctor`, and fix whatever it lists.',
  );
  return {
    exitCode: 0,
    lines,
    errLines: [],
    data: {
      ok: true,
      mode: opts.write ? 'write' : 'dry-run',
      project_file: migration.projectFile,
      host_file: migration.hostFile,
      dropped: migration.dropped,
      warnings: migration.warnings,
      written,
      legacy_untouched: true,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isPlain = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf values of a layer keyed by dotted path (arrays and scalars are leaves). */
export function flattenLayer(o: Obj | undefined, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o ?? {})) {
    if (k === 'version' || v === undefined) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v)) for (const [kk, vv] of flattenLayer(v, key)) out.set(kk, vv);
    else out.set(key, v);
  }
  return out;
}

export interface ConflictSide {
  layer: string;
  value: unknown;
}
export interface Conflict {
  key: string;
  values: ConflictSide[];
  winner: string;
  note?: string;
}

export const LEGACY_ENV_NOTE = 'environment wins at launch (deprecated) — unset it or remove it from daemon.env';

export interface DoctorLayers {
  project?: Obj;
  host?: Obj;
  env: Obj;
  /** deployment.json mapped to the new schema (deployment only, no env knobs). */
  legacyDeployment: Obj;
  /** legacy env knobs: name -> {key, value}. */
  legacyEnv: { name: string; key: string; value: unknown }[];
  /** layer labels for messages */
  labels: { project: string; host: string };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Every key set to DIFFERENT values in two layers, with which one wins. Pure. */
export function findConflicts(l: DoctorLayers): Conflict[] {
  const project = flattenLayer(l.project);
  const host = flattenLayer(l.host);
  const env = flattenLayer(l.env);
  const dep = flattenLayer(l.legacyDeployment);
  const keys = new Set<string>([...project.keys(), ...host.keys(), ...env.keys(), ...dep.keys(), ...l.legacyEnv.map((k) => k.key)]);
  const out: Conflict[] = [];
  for (const key of [...keys].sort()) {
    const envName = conductorEnvVarName(key.split('.'));
    // new-file layers, lowest to highest
    const newSides: ConflictSide[] = [];
    if (project.has(key)) newSides.push({ layer: l.labels.project, value: project.get(key) });
    if (host.has(key)) newSides.push({ layer: l.labels.host, value: host.get(key) });
    if (env.has(key)) newSides.push({ layer: `env ${envName} (test override)`, value: env.get(key) });
    const distinct = newSides.filter((s, i) => newSides.findIndex((o) => same(o.value, s.value)) === i);
    if (distinct.length > 1) {
      out.push({ key, values: newSides, winner: newSides[newSides.length - 1].layer });
    }
    const effective = newSides.length ? newSides[newSides.length - 1] : undefined;
    // deployment.json (lowest) against the new files
    if (effective && dep.has(key) && !same(dep.get(key), effective.value)) {
      out.push({
        key,
        values: [{ layer: 'deployment.json (deprecated)', value: dep.get(key) }, ...newSides],
        winner: effective.layer,
      });
    }
    // a legacy env knob against the new files: the knob is in the process env, so it wins at launch
    for (const knob of l.legacyEnv.filter((k) => k.key === key)) {
      if (effective && !same(knob.value, effective.value)) {
        out.push({
          key,
          values: [...newSides, { layer: `env ${knob.name} (deprecated)`, value: knob.value }],
          winner: `env ${knob.name}`,
          note: LEGACY_ENV_NOTE,
        });
      }
    }
  }
  return out;
}

const getPathValue = (o: Obj, path: string[]): unknown => path.reduce<unknown>((cur, seg) => (isPlain(cur) ? cur[seg] : undefined), o);

export function runDoctor(deps: ConductorCliDeps, opts: { config?: string } = {}): CliResult {
  const env = deps.env;
  const paths = resolveConductorPaths(env);
  const legacyPath = resolveDeploymentConfigPath({ configPath: opts.config, env });
  const loadLegacy = () =>
    loadLegacyDeploymentConfig({ configPath: opts.config, env, existsSync: deps.existsSync, readFileSync: deps.readFileSync });

  // (a) SOURCES
  const snap = readSnapshot(paths.snapshotFile);
  const knobsSet = LEGACY_ENV_KNOBS.filter((k) => env[k.name] !== undefined && env[k.name] !== '').map((k) => k.name);
  const sources = [
    { source: 'project override file (HARMONY_CONDUCTOR_PROJECT_FILE)', path: paths.projectFile ?? null, found: paths.projectFile ? deps.existsSync(paths.projectFile) : false },
    {
      source: 'project snapshot (last-good copy of config_repo main)',
      path: paths.snapshotFile,
      found: snap !== null,
      detail: snap ? `${snap.source.repo}@${snap.source.ref}, fetched ${snap.fetched_at}, sha ${snap.sha ?? 'unknown'}` : deps.existsSync(paths.snapshotFile) ? 'present but unreadable or malformed' : undefined,
    },
    { source: 'host file', path: paths.hostFile, found: deps.existsSync(paths.hostFile) },
    { source: 'legacy deployment.json (deprecated)', path: legacyPath, found: deps.existsSync(legacyPath) },
    { source: 'legacy env knobs in THIS shell (deprecated)', path: null, found: knobsSet.length > 0, detail: knobsSet.join(', ') || undefined },
  ];

  let issues: ConductorConfigIssue[] = [];
  let warnings: string[] = [];
  let conflicts: Conflict[] = [];
  let legacyInUse: string[] = [];
  let evaluated = false;
  let dep = null as ReturnType<typeof loadLegacy>;
  try {
    dep = loadLegacy();
    const ev = evaluateConductorConfig({ env, existsSync: deps.existsSync, readFileSync: deps.readFileSync, warn: () => {}, loadLegacy: () => dep });
    if (ev) {
      evaluated = true;
      issues = ev.issues;
      warnings = ev.warnings.filter((w) => !w.startsWith('deprecated:'));
      const profileName = ev.merged.profile ?? Object.keys(dep?.profiles ?? {}).find((n) => n === 'cloud' || n === 'gke');
      const depOnly = legacyToConductor({ deployment: dep, env: {}, profileName });
      const envOnly = legacyToConductor({ deployment: null, env, profileName });
      legacyInUse = [...depOnly.warnings, ...envOnly.warnings].filter((w) => w.startsWith('deprecated:'));
      conflicts = findConflicts({
        project: ev.layers.project,
        host: ev.layers.host,
        env: ev.layers.env,
        legacyDeployment: depOnly.layer,
        legacyEnv: LEGACY_ENV_KNOBS.filter((k) => envOnly.envKnobs.includes(k.name)).map((k) => ({ name: k.name, key: k.path.join('.'), value: getPathValue(envOnly.layer, k.path) })),
        labels: { project: snap && !paths.projectFile ? 'project (snapshot)' : 'project (conductor.json)', host: 'host (conductor-host.json)' },
      });
    } else {
      const depOnly = legacyToConductor({ deployment: dep, env: {}, profileName: Object.keys(dep?.profiles ?? {}).find((n) => n === 'cloud' || n === 'gke') });
      const envOnly = legacyToConductor({ deployment: null, env });
      legacyInUse = [...depOnly.warnings, ...envOnly.warnings].filter((w) => w.startsWith('deprecated:'));
    }
  } catch (err) {
    // A malformed legacy deployment.json throws, exactly as it does for the daemon: that is an issue.
    issues = [{ file: 'deployment.json', key: '(file)', problem: err instanceof Error ? err.message : String(err), fix: `correct or remove ${legacyPath}` }];
  }

  const hot = [...HOT_KEYS];
  const restart = [...RESTART_ONLY_KEYS];

  const lines: string[] = [];
  lines.push('SOURCES');
  for (const s of sources) {
    lines.push(`  ${s.found ? '[found ]' : '[absent]'} ${s.source}${s.path ? `: ${s.path}` : ''}${s.detail ? ` (${s.detail})` : ''}`);
  }
  if (!evaluated && issues.length === 0) {
    lines.push('', 'No project file, snapshot or host file exists: nothing to validate. The conductor runs on the legacy files exactly as before.');
  }
  lines.push('', `ISSUES (${issues.length})`);
  if (issues.length === 0) lines.push('  (none)');
  for (const i of issues) lines.push(`  ${formatConfigIssue(i)}`);
  lines.push('', `CONFLICTS (${conflicts.length})`);
  if (conflicts.length === 0) lines.push('  (none)');
  for (const c of conflicts) {
    lines.push(`  ${c.key}: ${c.values.map((v) => `${v.layer}=${show(v.value)}`).join(' vs ')} -> ${c.winner} wins${c.note ? `. ${c.note}` : ''}`);
  }
  lines.push('', `LEGACY IN USE (${legacyInUse.length})`);
  if (legacyInUse.length === 0) lines.push('  (none)');
  for (const w of legacyInUse) lines.push(`  ${w.replace(/^deprecated: /, '')}`);
  lines.push('  (only THIS shell\'s environment is checked; to check the daemon\'s, run `set -a; . <daemon.env>; set +a` first)');
  if (warnings.length) {
    lines.push('', `WARNINGS (${warnings.length})`);
    for (const w of warnings) lines.push(`  ${w}`);
  }
  lines.push('', `HOT (applied within 5 minutes of a project-file change): ${hot.join(', ')} | RESTART NEEDED: ${restart.join(', ')}`);
  lines.push('', issues.length ? `RESULT: ${issues.length} issue${issues.length === 1 ? '' : 's'} to fix (exit 1)` : 'RESULT: ok');

  return {
    exitCode: issues.length ? 1 : 0,
    lines,
    errLines: [],
    data: {
      ok: issues.length === 0,
      sources,
      issues: issues.map((i) => ({ ...i, text: formatConfigIssue(i) })),
      conflicts,
      legacy_in_use: legacyInUse,
      warnings,
      hot_keys: hot,
      restart_keys: restart,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------------------------------

function emit(program: Command, result: CliResult): void {
  const json = Boolean(program.opts().json);
  if (json) {
    console.log(formatOutput(result.data, { json: true }));
  } else {
    for (const l of result.lines) console.log(l);
    for (const l of result.errLines) console.error(`harmony conductor config: ${l}`);
  }
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

export function registerConductorCommands(program: Command, makeDeps: () => ConductorCliDeps = defaultCliDeps): void {
  const conductor = program.command('conductor').description('Conductor operations');
  const config = conductor.command('config').description('The two-file conductor config (.harmony/conductor.json + ~/.harmony/conductor-host.json)');

  config
    .command('sync')
    .description('Fetch .harmony/conductor.json from config_repo main into the last-good snapshot now (needs the harmony-daemon App installation to include config_repo)')
    .action(async () => emit(program, await runSync(makeDeps())));

  config
    .command('migrate')
    .description('Propose the project + host files from the current deployment.json and env knobs. Dry run unless --write; never modifies the old files')
    .option('--profile <name>', 'Which deployment.json profile to migrate (cloud|gke)')
    .option('--config <path>', 'Explicit deployment.json path (overrides HARMONY_DEPLOYMENT_CONFIG)')
    .option('--write', 'Write the new files (requires --out-project)', false)
    .option('--out-project <path>', 'Where to write the project file (no default)')
    .option('--out-host <path>', 'Where to write the host file (default: the resolved host-file path)')
    .option('--force', 'Overwrite an existing output file', false)
    .action((opts: { profile?: string; config?: string; write?: boolean; outProject?: string; outHost?: string; force?: boolean }) =>
      emit(program, runMigrate(makeDeps(), opts)),
    );

  config
    .command('doctor')
    .description('Explain the conductor config: sources, every issue, conflicts between layers, legacy sources in use. Exits 1 on any issue')
    .option('--config <path>', 'Explicit deployment.json path (overrides HARMONY_DEPLOYMENT_CONFIG)')
    .action((opts: { config?: string }) => emit(program, runDoctor(makeDeps(), opts)));
}
