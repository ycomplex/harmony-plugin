// B-1170 (round A): a project's conductor is configured by ONE file in its repo.
//
//   .harmony/conductor.json   — the PROJECT file, read from `main` of a GitHub repo through the contents
//                               API with the daemon's existing App installation token (see
//                               ./conductor-project-source.ts) and kept as a last-good local SNAPSHOT.
//   ~/.harmony/conductor-host.json — the HOST file: what is true of THIS machine only (plugin checkout,
//                               GitHub App identity, gcloud account, Secret Manager secret NAMES) plus
//                               any project key the host wants to override.
//
// Both are strict zod schemas (zod is the single source of shape): an unknown key is an ERROR that names
// the key and lists the allowed ones, never a silent ignore. Every validation problem is a
// `ConductorConfigError` issue with a file, a key, a problem and a concrete fix, so the doctor can print
// all of them and an operator never has to guess.
//
// PRECEDENCE, lowest to highest:   legacy files  <  project  <  host  <  env
//   legacy — ~/.harmony/deployment.json and the HARMONY_GKE_* / HARMONY_CLOUD_RUN_* / CLOUDSDK_* /
//            HARMONY_APP_* / HARMONY_PLUGIN_DIR process-env knobs the old setup used. Every use emits a
//            DEPRECATION WARNING naming the old file/variable and its replacement key.
//   env    — HARMONY_CONDUCTOR_<LEAF_PATH_UPPER_SNAKE> (e.g. HARMONY_CONDUCTOR_GKE_NAMESPACE). These are
//            TEST OVERRIDES ONLY: they exist so tests and one-off dry runs can pin a value without
//            writing a file. They are NOT a supported way to run a deployment — a deployment's config is
//            the two files. (HARMONY_CONDUCTOR_PROJECT_FILE / _HOST_FILE / _SNAPSHOT_FILE /
//            _CONFIG_REPO are path/repo overrides in the same spirit.)
//
// The merged result is projected into the EXISTING `DeploymentConfig` shape (projectToDeploymentConfig)
// so every current caller — `harmony config get`, loadDaemonConfig, the launch scripts — keeps working
// without knowing the new files exist. `loadDeploymentConfig` (./deployment-config.ts) calls
// `loadConductorConfigSync` first and falls back to today's behaviour byte-for-byte when it returns null.
//
// IMPORT DIRECTION. This module imports only TYPES from ./deployment-config.ts (which imports this
// module); the legacy loader is injected (`loadLegacy`) by that wrapper, so there is no import cycle.
//
// NO I/O BY SURPRISE: every filesystem dependency (existsSync/readFileSync), the env and the warn sink
// are injectable, so the whole module is testable offline against temp dirs.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { DeploymentConfig, LaunchProfileConfig } from './deployment-config.js';
import { WORKER_IMAGE_DEFAULT } from './worker-image-default.js';

// ---------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------

/** Repo-relative path of the project file. */
export const CONDUCTOR_PROJECT_PATH = '.harmony/conductor.json';

export interface ConductorPaths {
  home: string;
  hostFile: string;
  snapshotFile: string;
  /** HARMONY_CONDUCTOR_PROJECT_FILE — an explicit project file (test override), else undefined. */
  projectFile: string | undefined;
}

/** HARMONY_HOME (else ~/.harmony) holds the host file and the snapshot; the HARMONY_CONDUCTOR_*_FILE
 *  env vars override each individually. */
export function resolveConductorPaths(env: NodeJS.ProcessEnv = process.env): ConductorPaths {
  const home = env.HARMONY_HOME || join(homedir(), '.harmony');
  return {
    home,
    hostFile: env.HARMONY_CONDUCTOR_HOST_FILE || join(home, 'conductor-host.json'),
    snapshotFile: env.HARMONY_CONDUCTOR_SNAPSHOT_FILE || join(home, 'conductor-snapshot.json'),
    projectFile: env.HARMONY_CONDUCTOR_PROJECT_FILE || undefined,
  };
}

// ---------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------

const ChannelSchema = z.enum(['staging', 'prod']);
const ProfileNameSchema = z.enum(['cloud', 'gke']);

const ImagesSchema = z
  .object({
    /** Bare name (resolved against the deployment's registry) or a ref containing '/' (used verbatim). */
    worker: z.string().min(1).optional(),
    codex: z.string().min(1).optional(),
  })
  .strict();

const GcpSchema = z
  .object({ project: z.string().min(1).optional(), region: z.string().min(1).optional() })
  .strict();

const CloudRunSchema = z.object({ job: z.string().min(1).optional() }).strict();

const GkeSchema = z
  .object({
    cluster: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    context: z.string().min(1).optional(),
    registry: z.string().min(1).optional(),
    base_secret: z.string().min(1).optional(),
    codex_secret: z.string().min(1).optional(),
    cpu: z.string().min(1).optional(),
    memory: z.string().min(1).optional(),
    ticket_disk: z.string().min(1).optional(),
    storage_class: z.string().min(1).optional(),
    deadline_s: z.number().int().optional(),
    job_ttl_s: z.number().int().optional(),
    poll_s: z.number().int().optional(),
  })
  .strict();

const ConcurrencySchema = z.object({ max_workers: z.number().int().min(0).optional() }).strict();

const ModelPolicySchema = z
  .object({ default: z.string().min(1).optional(), per_gate: z.record(z.string().min(1)).optional() })
  .strict();

/** Every key a project file may carry (besides `version`), all optional here — the project schema
 *  re-requires `channel` and `profile`; the host schema keeps them optional (it only OVERRIDES). */
const projectShape = {
  channel: ChannelSchema.optional(),
  profile: ProfileNameSchema.optional(),
  images: ImagesSchema.optional(),
  gcp: GcpSchema.optional(),
  cloud_run: CloudRunSchema.optional(),
  gke: GkeSchema.optional(),
  concurrency: ConcurrencySchema.optional(),
  model_policy: ModelPolicySchema.optional(),
  /** Absent means "ship when gcp.project is named"; `false` switches shipping off. */
  log_shipping: z.boolean().optional(),
  agents: z.array(z.string().min(1)).min(1).optional(),
};

/** `.harmony/conductor.json` — strict. */
export const ProjectFileSchema = z
  .object({
    version: z.literal(1),
    ...projectShape,
    channel: ChannelSchema,
    profile: ProfileNameSchema,
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/** A Secret Manager secret NAME — never a value. Values that look like credentials are refused so a
 *  pasted token cannot end up in a file on disk. */
export function looksLikeSecretValue(v: string): boolean {
  return /^(ghp_|gho_|ghs_|github_pat_|sk-|eyJ)/.test(v) || v.includes('-----BEGIN') || /^\S{40,}$/.test(v);
}

const SecretNameSchema = z
  .string()
  .min(1)
  .refine((v) => !looksLikeSecretValue(v), {
    message:
      'looks like a secret VALUE, not a Secret Manager secret NAME (the secrets block holds names only)',
  });

const HostGithubAppSchema = z
  .object({
    app_id: z.string().min(1),
    installation_id: z.string().min(1),
    private_key_path: z.string().min(1),
  })
  .strict();

const hostOnlyShape = {
  /** 'owner/name' of the repo whose `main` holds `.harmony/conductor.json`. */
  config_repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must look like "owner/name"')
    .optional(),
  config_ref: z.string().min(1).optional(),
  plugin_dir: z.string().min(1).optional(),
  github_app: HostGithubAppSchema.optional(),
  gcloud: z.object({ account: z.string().min(1).optional() }).strict().optional(),
  /** logical name -> Secret Manager secret NAME. Names only. */
  secrets: z.record(SecretNameSchema).optional(),
};

/** `~/.harmony/conductor-host.json` — strict; host-only keys plus any project key as an override. */
export const HostFileSchema = z
  .object({ version: z.literal(1), ...projectShape, ...hostOnlyShape })
  .strict();
export type HostFile = z.infer<typeof HostFileSchema>;

/** The merged shape (type + legacy-layer shape). Not strict: layers were validated individually. */
export const ConductorConfigSchema = z.object({
  ...projectShape,
  ...hostOnlyShape,
  github_app: HostGithubAppSchema.partial().optional(),
});
export type ConductorConfig = z.infer<typeof ConductorConfigSchema>;

/** The local last-good copy of the project file. `content` is the file's raw text. */
export const SnapshotSchema = z.object({
  version: z.literal(1),
  source: z.object({ repo: z.string(), ref: z.string(), path: z.string() }),
  etag: z.string().nullable(),
  sha: z.string().nullable(),
  fetched_at: z.string(),
  content: z.string(),
});
export type ConductorSnapshot = z.infer<typeof SnapshotSchema>;

export function parseSnapshotText(text: string): ConductorSnapshot | null {
  try {
    const r = SnapshotSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Errors: <file basename> › <key>: <problem>. Fix: <fix>
// ---------------------------------------------------------------------------------------------------

export interface ConductorConfigIssue {
  file: string;
  key: string;
  problem: string;
  fix: string;
}

export function formatConfigIssue(i: ConductorConfigIssue): string {
  return `${i.file} › ${i.key}: ${i.problem.replace(/\.+$/, '')}. Fix: ${i.fix}`;
}

/** ALL issues, one formatted line each (the doctor prints every one, not just the first). */
export function formatConfigIssues(issues: ConductorConfigIssue[]): string[] {
  return issues.map(formatConfigIssue);
}

export class ConductorConfigError extends Error {
  readonly file: string;
  readonly key: string;
  readonly problem: string;
  readonly fix: string;
  readonly issues: ConductorConfigIssue[];
  constructor(input: ConductorConfigIssue | ConductorConfigIssue[]) {
    const issues = Array.isArray(input) ? input : [input];
    super(formatConfigIssues(issues).join('\n'));
    this.name = 'ConductorConfigError';
    this.issues = issues;
    const first = issues[0] ?? { file: '(unknown)', key: '(file)', problem: 'unknown error', fix: 'see the log' };
    this.file = first.file;
    this.key = first.key;
    this.problem = first.problem;
    this.fix = first.fix;
  }
}

function unwrapSchema(s: z.ZodTypeAny): z.ZodTypeAny {
  let cur = s;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    else if (cur instanceof z.ZodDefault) cur = cur.removeDefault();
    else if (cur instanceof z.ZodEffects) cur = cur.innerType();
    else return cur;
  }
}

/** The object schema reached by walking `path` from `root` (undefined when it is not an object). */
function objectSchemaAt(root: z.ZodTypeAny, path: (string | number)[]): z.ZodObject<z.ZodRawShape> | undefined {
  let cur = unwrapSchema(root);
  for (const seg of path) {
    if (cur instanceof z.ZodObject) cur = unwrapSchema((cur.shape as z.ZodRawShape)[String(seg)]);
    else if (cur instanceof z.ZodRecord) cur = unwrapSchema(cur.valueSchema);
    else if (cur instanceof z.ZodArray) cur = unwrapSchema(cur.element);
    else return undefined;
    if (!cur) return undefined;
  }
  return cur instanceof z.ZodObject ? (cur as z.ZodObject<z.ZodRawShape>) : undefined;
}

const EXAMPLE_BY_TYPE: Record<string, string> = {
  string: '"value"',
  number: '2',
  integer: '2',
  boolean: 'true',
  array: '["a"]',
  object: '{ }',
};

function keyOf(path: (string | number)[]): string {
  return path.length === 0 ? '(file)' : path.join('.');
}

/** Map zod issues onto file/key/problem/fix. `root` is the schema that produced them (for allowed-key
 *  lists). */
export function zodIssuesToConfigIssues(
  file: string,
  issues: z.ZodIssue[],
  root: z.ZodTypeAny,
): ConductorConfigIssue[] {
  const out: ConductorConfigIssue[] = [];
  for (const issue of issues) {
    switch (issue.code) {
      case 'unrecognized_keys': {
        const allowed = Object.keys(objectSchemaAt(root, issue.path)?.shape ?? {});
        for (const k of issue.keys) {
          out.push({
            file,
            key: keyOf([...issue.path, k]),
            problem: 'unknown key',
            fix: `remove it, or use one of the allowed keys${issue.path.length ? ` under ${keyOf(issue.path)}` : ''}: ${allowed.join(', ')}`,
          });
        }
        break;
      }
      case 'invalid_enum_value':
        out.push({
          file,
          key: keyOf(issue.path),
          problem: `${JSON.stringify(issue.received)} is not an allowed value`,
          fix: `set it to one of: ${issue.options.map((o) => JSON.stringify(o)).join(', ')}`,
        });
        break;
      case 'invalid_type': {
        const example = EXAMPLE_BY_TYPE[issue.expected] ?? '"value"';
        const key = keyOf(issue.path);
        const leaf = String(issue.path[issue.path.length - 1] ?? '');
        out.push(
          issue.received === 'undefined'
            ? {
                file,
                key,
                problem: `required ${issue.expected} is missing`,
                fix: `add ${leaf ? `"${leaf}": ` : ''}${example}`,
              }
            : {
                file,
                key,
                problem: `expected ${issue.expected}, got ${issue.received}`,
                fix: `set it to a ${issue.expected}, e.g. ${example}`,
              },
        );
        break;
      }
      case 'invalid_literal':
        out.push({
          file,
          key: keyOf(issue.path),
          problem:
            issue.received === undefined
              ? `required value ${JSON.stringify(issue.expected)} is missing`
              : `must be ${JSON.stringify(issue.expected)} (got ${JSON.stringify(issue.received)})`,
          fix: `set it to ${JSON.stringify(issue.expected)}`,
        });
        break;
      case 'custom':
        out.push({ file, key: keyOf(issue.path), problem: issue.message, fix: customFix(issue.message) });
        break;
      default:
        out.push({
          file,
          key: keyOf(issue.path),
          problem: issue.message,
          fix: 'correct the value to match the schema',
        });
    }
  }
  return out;
}

function customFix(message: string): string {
  return message.includes('secret VALUE')
    ? 'store the value in Secret Manager and put only the secret NAME here'
    : 'correct the value to match the schema';
}

function lineColOf(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  return { line, col: pos - (before.lastIndexOf('\n') + 1) + 1 };
}

/** JSON.parse with an issue (file, '(file)', line/col when derivable) instead of a throw. */
export function parseJsonText(
  file: string,
  text: string,
): { ok: true; value: unknown } | { ok: false; issue: ConductorConfigIssue } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let where = '';
    if (!/line \d+ column \d+/.test(msg)) {
      const m = /position (\d+)/.exec(msg);
      if (m) {
        const { line, col } = lineColOf(text, Number(m[1]));
        where = ` (line ${line}, column ${col})`;
      } else {
        // Newer V8 quotes a snippet instead of a position: locate it to give the reader a line.
        const snip = /\.\.\."?([\s\S]*?)"? is not valid JSON/.exec(msg)?.[1] ?? /"([\s\S]*?)" is not valid JSON/.exec(msg)?.[1];
        const at = snip ? text.indexOf(snip) : -1;
        if (at >= 0) {
          const { line, col } = lineColOf(text, at + Math.max(0, snip!.length - 1));
          where = ` (near line ${line}, column ${col})`;
        }
      }
    }
    return {
      ok: false,
      issue: { file, key: '(file)', problem: `invalid JSON: ${msg}${where}`, fix: 'correct the JSON' },
    };
  }
}

function validateText<S extends z.ZodTypeAny>(
  file: string,
  text: string,
  schema: S,
): { ok: true; value: z.infer<S> } | { ok: false; issues: ConductorConfigIssue[] } {
  const parsed = parseJsonText(file, text);
  if (!parsed.ok) return { ok: false, issues: [parsed.issue] };
  const r = schema.safeParse(parsed.value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: zodIssuesToConfigIssues(file, r.error.issues, schema) };
}

/** Validate a project-file TEXT. Shared with the async refresh (conductor-project-source.ts). */
export function validateProjectFileText(
  file: string,
  text: string,
): { ok: true; value: ProjectFile } | { ok: false; issues: ConductorConfigIssue[] } {
  return validateText(file, text, ProjectFileSchema);
}

// ---------------------------------------------------------------------------------------------------
// Built-in launch templates (copied from container/daemon-profile.cloud.example.json and
// container/gke/daemon-profile.gke.example.json — conductor-config.test.ts asserts they cannot drift)
// ---------------------------------------------------------------------------------------------------

export type BuiltinProfileName = z.infer<typeof ProfileNameSchema>;

export const BUILTIN_PROFILES: Record<BuiltinProfileName, LaunchProfileConfig> = {
  cloud: {
    launch:
      'bash "$HARMONY_PLUGIN_DIR/container/cloud-worker-launch.sh" {conduction_id} {ticket} \'{run_config_json}\' \'{model}\'',
    reap: 'bash "$HARMONY_PLUGIN_DIR/container/cloud-worker-reap.sh" {conduction_id} {ticket}',
    probe: 'bash "$HARMONY_PLUGIN_DIR/container/cloud-worker-probe.sh" {conduction_id} {ticket}',
    maxConcurrentWorkers: 2,
    agents: ['claude-code', 'codex'],
    required_tools: { launch: ['node', 'gcloud'], reap: ['gcloud'], probe: ['gcloud'] },
    requires_app_mint: true,
    schema_version: 1,
  },
  gke: {
    launch:
      'bash "$HARMONY_PLUGIN_DIR/container/gke/gke-worker-launch.sh" {conduction_id} {ticket} \'{run_config_json}\' \'{model}\'',
    reap: 'bash "$HARMONY_PLUGIN_DIR/container/gke/gke-worker-reap.sh" {conduction_id} {ticket}',
    probe: 'bash "$HARMONY_PLUGIN_DIR/container/gke/gke-worker-probe.sh" {conduction_id} {ticket}',
    maxConcurrentWorkers: 2,
    agents: ['claude-code', 'codex'],
    required_tools: {
      launch: ['node', 'kubectl', 'gke-gcloud-auth-plugin'],
      reap: ['kubectl', 'gke-gcloud-auth-plugin'],
      probe: ['kubectl', 'gke-gcloud-auth-plugin'],
    },
    requires_app_mint: true,
    schema_version: 1,
  },
};

// ---------------------------------------------------------------------------------------------------
// Layers: merge, env, legacy
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isPlain = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function mergeInto(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? mergeInto(out[k] as Obj, v) : v;
  }
  return out;
}

/** Deep-merge layers, LATER layers winning; arrays are replaced, not concatenated; `version` dropped. */
export function mergeLayers(...layers: (Obj | undefined)[]): ConductorConfig {
  let out: Obj = {};
  for (const l of layers) if (l) out = mergeInto(out, l);
  delete out.version;
  return out as ConductorConfig;
}

function setPath(o: Obj, path: string[], value: unknown): void {
  let cur = o;
  for (const seg of path.slice(0, -1)) {
    if (!isPlain(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Obj;
  }
  cur[path[path.length - 1]] = value;
}

function getPath(o: unknown, path: string[]): unknown {
  let cur: unknown = o;
  for (const seg of path) {
    if (!isPlain(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

type LeafType = 'string' | 'int' | 'boolean';
/** Every scalar leaf the env layer can set. `agents` (array) and `model_policy.per_gate` (record) are
 *  deliberately NOT env-settable. */
const ENV_LEAVES: { path: string[]; type: LeafType }[] = [
  ...(['channel', 'profile', 'plugin_dir', 'config_repo', 'config_ref'] as const).map((k) => ({ path: [k], type: 'string' as const })),
  { path: ['images', 'worker'], type: 'string' },
  { path: ['images', 'codex'], type: 'string' },
  { path: ['gcp', 'project'], type: 'string' },
  { path: ['gcp', 'region'], type: 'string' },
  { path: ['cloud_run', 'job'], type: 'string' },
  ...(['cluster', 'location', 'namespace', 'context', 'registry', 'base_secret', 'codex_secret', 'cpu', 'memory', 'ticket_disk', 'storage_class'] as const).map(
    (k) => ({ path: ['gke', k], type: 'string' as const }),
  ),
  ...(['deadline_s', 'job_ttl_s', 'poll_s'] as const).map((k) => ({ path: ['gke', k], type: 'int' as const })),
  { path: ['concurrency', 'max_workers'], type: 'int' },
  { path: ['model_policy', 'default'], type: 'string' },
  { path: ['log_shipping'], type: 'boolean' },
  { path: ['gcloud', 'account'], type: 'string' },
  { path: ['github_app', 'app_id'], type: 'string' },
  { path: ['github_app', 'installation_id'], type: 'string' },
  { path: ['github_app', 'private_key_path'], type: 'string' },
];

export function conductorEnvVarName(path: string[]): string {
  return `HARMONY_CONDUCTOR_${path.join('_').toUpperCase()}`;
}

/** The env layer (TEST OVERRIDES ONLY — see the header). Type errors become issues naming the VARIABLE. */
export function envLayer(env: NodeJS.ProcessEnv): { layer: Obj; vars: string[]; issues: ConductorConfigIssue[] } {
  const layer: Obj = {};
  const vars: string[] = [];
  const issues: ConductorConfigIssue[] = [];
  for (const leaf of ENV_LEAVES) {
    const name = conductorEnvVarName(leaf.path);
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    vars.push(name);
    if (leaf.type === 'string') setPath(layer, leaf.path, raw);
    else if (leaf.type === 'int') {
      if (!/^-?\d+$/.test(raw.trim())) {
        issues.push({ file: 'env', key: name, problem: `expected an integer, got ${JSON.stringify(raw)}`, fix: `set ${name} to a whole number, e.g. 2` });
        continue;
      }
      setPath(layer, leaf.path, Number(raw.trim()));
    } else {
      const v = raw.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(v)) setPath(layer, leaf.path, true);
      else if (['false', '0', 'no'].includes(v)) setPath(layer, leaf.path, false);
      else issues.push({ file: 'env', key: name, problem: `expected a boolean, got ${JSON.stringify(raw)}`, fix: `set ${name} to true or false` });
    }
  }
  // Enum / range checks on the assembled layer (channel, profile, max_workers >= 0 ...).
  const r = HostFileSchema.omit({ version: true }).safeParse(layer);
  if (!r.success) {
    for (const i of zodIssuesToConfigIssues('env', r.error.issues, HostFileSchema)) {
      const leaf = ENV_LEAVES.find((l) => l.path.join('.') === i.key);
      issues.push(leaf ? { ...i, key: conductorEnvVarName(leaf.path), fix: i.fix.replace(/^set it/, `set ${conductorEnvVarName(leaf.path)}`) } : i);
    }
  }
  return { layer, vars, issues };
}

/** Legacy process-env knob -> new key (leaf path). */
export const LEGACY_ENV_KNOBS: { name: string; path: string[]; type: LeafType }[] = [
  ...(
    [
      ['NAMESPACE', 'namespace'],
      ['CONTEXT', 'context'],
      ['BASE_SECRET', 'base_secret'],
      ['CODEX_SECRET', 'codex_secret'],
      ['REGISTRY', 'registry'],
      ['CPU', 'cpu'],
      ['MEMORY', 'memory'],
      ['TICKET_DISK', 'ticket_disk'],
      ['STORAGE_CLASS', 'storage_class'],
    ] as const
  ).map(([v, k]) => ({ name: `HARMONY_GKE_${v}`, path: ['gke', k], type: 'string' as const })),
  ...(
    [
      ['DEADLINE_S', 'deadline_s'],
      ['POLL_S', 'poll_s'],
      ['JOB_TTL_S', 'job_ttl_s'],
    ] as const
  ).map(([v, k]) => ({ name: `HARMONY_GKE_${v}`, path: ['gke', k], type: 'int' as const })),
  { name: 'HARMONY_GKE_IMAGE', path: ['images', 'worker'], type: 'string' },
  { name: 'HARMONY_CLOUD_RUN_REGION', path: ['gcp', 'region'], type: 'string' },
  { name: 'HARMONY_CLOUD_RUN_JOB', path: ['cloud_run', 'job'], type: 'string' },
  { name: 'CLOUDSDK_CORE_PROJECT', path: ['gcp', 'project'], type: 'string' },
  { name: 'CLOUDSDK_CORE_ACCOUNT', path: ['gcloud', 'account'], type: 'string' },
  { name: 'HARMONY_PLUGIN_DIR', path: ['plugin_dir'], type: 'string' },
  { name: 'HARMONY_APP_ID', path: ['github_app', 'app_id'], type: 'string' },
  { name: 'HARMONY_APP_INSTALLATION_ID', path: ['github_app', 'installation_id'], type: 'string' },
  { name: 'HARMONY_APP_PRIVATE_KEY_PATH', path: ['github_app', 'private_key_path'], type: 'string' },
];

const deprecation = (old: string, newKey: string, file: string): string =>
  `deprecated: ${old} is read as a legacy fallback; set ${newKey} in ${file} instead`;

export interface LegacyLayerInput {
  deployment: DeploymentConfig | null;
  env: NodeJS.ProcessEnv;
  /** The active profile (cloud|gke) — selects which deployment.json profile entry maps. */
  profileName?: string;
  /** Env keys that are OUR OWN applyLaunchEnv output, not operator-supplied legacy knobs. */
  ignoreEnvKeys?: ReadonlySet<string>;
}

export interface LegacyLayer {
  layer: Obj;
  warnings: string[];
  /** deployment.json existed, or at least one legacy env knob was set. */
  used: boolean;
  /** True when deployment.json is present. */
  hasDeployment: boolean;
  envKnobs: string[];
}

/** The old setup, read as a new-schema layer (LOWEST precedence). Pure; every mapped item adds one
 *  deprecation warning naming the old location and its replacement. */
export function legacyToConductor(input: LegacyLayerInput): LegacyLayer {
  const { deployment, env } = input;
  const layer: Obj = {};
  const warnings: string[] = [];
  const envKnobs: string[] = [];
  const DJ = 'deployment.json';

  if (deployment) {
    if (deployment.worker_image && deployment.worker_image !== WORKER_IMAGE_DEFAULT) {
      setPath(layer, ['images', 'worker'], deployment.worker_image);
      warnings.push(deprecation(`${DJ} › worker_image`, 'images.worker', '.harmony/conductor.json'));
    }
    const prof = input.profileName ? deployment.profiles?.[input.profileName] : undefined;
    if (prof) {
      if (prof.gcloud_project) {
        setPath(layer, ['gcp', 'project'], prof.gcloud_project);
        warnings.push(deprecation(`${DJ} › profiles.${input.profileName}.gcloud_project`, 'gcp.project', '.harmony/conductor.json'));
      }
      if (prof.maxConcurrentWorkers !== undefined) {
        setPath(layer, ['concurrency', 'max_workers'], prof.maxConcurrentWorkers);
        warnings.push(deprecation(`${DJ} › profiles.${input.profileName}.maxConcurrentWorkers`, 'concurrency.max_workers', '.harmony/conductor.json'));
      }
      if (prof.agents) {
        setPath(layer, ['agents'], prof.agents);
        warnings.push(deprecation(`${DJ} › profiles.${input.profileName}.agents`, 'agents', '.harmony/conductor.json'));
      }
    }
    if (deployment.launcher?.plugin_dir) {
      setPath(layer, ['plugin_dir'], deployment.launcher.plugin_dir);
      warnings.push(deprecation(`${DJ} › launcher.plugin_dir`, 'plugin_dir', '~/.harmony/conductor-host.json'));
    }
    if (deployment.launcher?.github_app) {
      setPath(layer, ['github_app'], { ...deployment.launcher.github_app });
      warnings.push(deprecation(`${DJ} › launcher.github_app`, 'github_app', '~/.harmony/conductor-host.json'));
    }
    const posture = deployment.env?.HARMONY_PLUGIN_POSTURE;
    if (posture) {
      const channel = posture === 'prod' ? 'prod' : posture === 'ack:staging' || posture === 'staging' ? 'staging' : undefined;
      if (channel) {
        setPath(layer, ['channel'], channel);
        warnings.push(deprecation(`${DJ} › env.HARMONY_PLUGIN_POSTURE`, 'channel', '.harmony/conductor.json'));
      } else {
        warnings.push(`${DJ} › env.HARMONY_PLUGIN_POSTURE=${JSON.stringify(posture)} has no conductor.json channel equivalent (only "prod" and "staging"); it is ignored for channel`);
      }
    }
  }

  for (const knob of LEGACY_ENV_KNOBS) {
    if (input.ignoreEnvKeys?.has(knob.name)) continue;
    const raw = env[knob.name];
    if (raw === undefined || raw === '') continue;
    const home = knob.name.startsWith('HARMONY_APP_') || knob.name === 'HARMONY_PLUGIN_DIR' || knob.name === 'CLOUDSDK_CORE_ACCOUNT'
      ? '~/.harmony/conductor-host.json'
      : '.harmony/conductor.json';
    if (knob.type === 'int') {
      if (!/^\d+$/.test(raw.trim())) {
        warnings.push(`env ${knob.name}=${JSON.stringify(raw)} is not an integer; ignored (set ${knob.path.join('.')} in ${home})`);
        continue;
      }
      setPath(layer, knob.path, Number(raw.trim()));
    } else {
      setPath(layer, knob.path, raw);
    }
    envKnobs.push(knob.name);
    warnings.push(deprecation(`env ${knob.name}`, knob.path.join('.'), home));
  }

  return { layer, warnings, used: deployment !== null || envKnobs.length > 0, hasDeployment: deployment !== null, envKnobs };
}

// ---------------------------------------------------------------------------------------------------
// Semantic validation (after merge)
// ---------------------------------------------------------------------------------------------------

const PROJECT_FILE_LABEL = 'conductor.json';
const HOST_FILE_LABEL = 'conductor-host.json';

export function validateMerged(merged: ConductorConfig, env: NodeJS.ProcessEnv = {}): ConductorConfigIssue[] {
  const issues: ConductorConfigIssue[] = [];
  const need = (file: string, key: string, problem: string, fix: string) => issues.push({ file, key, problem, fix });
  if (!merged.channel) {
    need(PROJECT_FILE_LABEL, 'channel', 'required key is missing', 'add "channel": "staging" (or "prod") to .harmony/conductor.json');
  }
  if (!merged.profile) {
    need(PROJECT_FILE_LABEL, 'profile', 'required key is missing', 'add "profile": "cloud" (or "gke") to .harmony/conductor.json');
    return issues; // every other requirement depends on the profile
  }
  if (!merged.gcp?.project) {
    need(PROJECT_FILE_LABEL, 'gcp.project', `the ${merged.profile} profile requires a GCP project`, 'add "gcp": { "project": "<gcp-project-id>" } to .harmony/conductor.json');
  }
  if (merged.profile === 'gke') {
    if (!merged.gke?.cluster) {
      need(PROJECT_FILE_LABEL, 'gke.cluster', 'the gke profile requires a cluster name', 'add "gke": { "cluster": "<cluster-name>" } to .harmony/conductor.json');
    }
    if (!merged.gke?.location) {
      need(PROJECT_FILE_LABEL, 'gke.location', 'the gke profile requires a cluster location', 'add "gke": { "location": "<zone-or-region>" } to .harmony/conductor.json');
    }
  }
  if (BUILTIN_PROFILES[merged.profile].requires_app_mint) {
    if (!merged.plugin_dir) {
      need(HOST_FILE_LABEL, 'plugin_dir', `the ${merged.profile} profile launches workers from this machine's plugin checkout`, 'add "plugin_dir": "/path/to/harmony-plugin" to ~/.harmony/conductor-host.json');
    }
    const app = merged.github_app;
    for (const k of ['app_id', 'installation_id'] as const) {
      if (!app?.[k]) {
        need(HOST_FILE_LABEL, `github_app.${k}`, `the ${merged.profile} profile mints a worker token from the harmony-daemon GitHub App`, `add "github_app": { "${k}": "<value>" } to ~/.harmony/conductor-host.json`);
      }
    }
    if (!app?.private_key_path && !env.HARMONY_APP_PRIVATE_KEY) {
      need(HOST_FILE_LABEL, 'github_app.private_key_path', 'the GitHub App private key location is missing', 'add "github_app": { "private_key_path": "/path/to/key.pem" } to ~/.harmony/conductor-host.json');
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------
// Projection onto the existing shapes
// ---------------------------------------------------------------------------------------------------

function sameTemplate(a: LaunchProfileConfig, b: LaunchProfileConfig): boolean {
  return (
    a.launch === b.launch &&
    a.reap === b.reap &&
    a.probe === b.probe &&
    JSON.stringify(a.required_tools ?? null) === JSON.stringify(b.required_tools ?? null) &&
    (a.requires_app_mint ?? false) === (b.requires_app_mint ?? false)
  );
}

/** The merged config as a `DeploymentConfig`. Starts from the legacy config (so env, repos,
 *  launcher.supabase, supabase_refs and other profiles pass through untouched) and overlays what the
 *  new files own. */
export function projectToDeploymentConfig(
  merged: ConductorConfig,
  legacy: DeploymentConfig | null = null,
  warnings: string[] = [],
): DeploymentConfig {
  const out: DeploymentConfig = {
    ...(legacy ?? {}),
    worker_image: merged.images?.worker ?? legacy?.worker_image ?? WORKER_IMAGE_DEFAULT,
  };
  const name = merged.profile;
  if (name) {
    const builtin = BUILTIN_PROFILES[name];
    const existing = legacy?.profiles?.[name];
    if (existing && !sameTemplate(existing, builtin)) {
      warnings.push(`custom launch template in deployment.json profiles.${name} is ignored once conductor.json names profile ${name}`);
    }
    const entry: LaunchProfileConfig = {
      ...builtin,
      maxConcurrentWorkers: merged.concurrency?.max_workers ?? builtin.maxConcurrentWorkers,
      agents: merged.agents ?? builtin.agents,
    };
    if (name === 'cloud' && merged.gcp?.project) entry.gcloud_project = merged.gcp.project;
    out.profiles = { ...(legacy?.profiles ?? {}), [name]: entry };
  }
  if (merged.plugin_dir || merged.github_app) {
    const launcher = { ...(legacy?.launcher ?? {}) };
    if (merged.plugin_dir) launcher.plugin_dir = merged.plugin_dir;
    if (merged.github_app) launcher.github_app = merged.github_app as NonNullable<typeof launcher.github_app>;
    out.launcher = launcher;
  }
  if (merged.channel) {
    out.env = { ...(legacy?.env ?? {}), HARMONY_PLUGIN_POSTURE: merged.channel === 'prod' ? 'prod' : 'ack:staging' };
  }
  return out;
}

/** The child-process env the launch scripts read. Only keys with a value; HARMONY_WORKER_IMAGE_REGISTRY
 *  is deliberately never set. */
export function launchEnvFromMerged(merged: ConductorConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') out[k] = String(v);
  };
  const g = merged.gke;
  put('HARMONY_GKE_NAMESPACE', g?.namespace);
  put(
    'HARMONY_GKE_CONTEXT',
    g?.context ?? (merged.gcp?.project && g?.location && g?.cluster ? `gke_${merged.gcp.project}_${g.location}_${g.cluster}` : undefined),
  );
  put('HARMONY_GKE_BASE_SECRET', g?.base_secret);
  put('HARMONY_GKE_CODEX_SECRET', g?.codex_secret);
  put('HARMONY_GKE_REGISTRY', g?.registry);
  put('HARMONY_GKE_CPU', g?.cpu);
  put('HARMONY_GKE_MEMORY', g?.memory);
  put('HARMONY_GKE_TICKET_DISK', g?.ticket_disk);
  put('HARMONY_GKE_STORAGE_CLASS', g?.storage_class);
  put('HARMONY_GKE_DEADLINE_S', g?.deadline_s);
  put('HARMONY_GKE_POLL_S', g?.poll_s);
  put('HARMONY_GKE_JOB_TTL_S', g?.job_ttl_s);
  put('HARMONY_GKE_IMAGE', merged.images?.worker);
  put('HARMONY_CLOUD_RUN_REGION', merged.gcp?.region);
  put('HARMONY_CLOUD_RUN_JOB', merged.cloud_run?.job);
  put('CLOUDSDK_CORE_PROJECT', merged.gcp?.project);
  put('CLOUDSDK_CORE_ACCOUNT', merged.gcloud?.account);
  // The launch/reap/probe templates run `bash "$HARMONY_PLUGIN_DIR/container/..."` and the mint script reads
  // the App identity from HARMONY_APP_*: the host file must reach them or a files-only host cannot launch.
  put('HARMONY_PLUGIN_DIR', merged.plugin_dir);
  put('HARMONY_APP_ID', merged.github_app?.app_id);
  put('HARMONY_APP_INSTALLATION_ID', merged.github_app?.installation_id);
  put('HARMONY_APP_PRIVATE_KEY_PATH', merged.github_app?.private_key_path);
  return out;
}

/** Set launch env on `target`: a key is written ONLY when the target has no non-empty value for it
 *  (an explicit operator env wins) OR we set it earlier (`applied`), so a refresh can update it.
 *  Records what it set in `applied`; returns the keys it set or changed. */
export function applyLaunchEnv(
  target: NodeJS.ProcessEnv,
  values: Record<string, string>,
  applied: Set<string>,
): string[] {
  const changed: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const cur = target[k];
    const ours = applied.has(k);
    if (cur !== undefined && cur !== '' && !ours) continue;
    if (ours && cur === v) continue;
    target[k] = v;
    applied.add(k);
    changed.push(k);
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------------
// Hot vs restart-only keys
// ---------------------------------------------------------------------------------------------------

/** Keys a running daemon cannot pick up without a restart. */
export const RESTART_ONLY_KEYS = [
  'channel', 'profile', 'gcp.project', 'gcp.region', 'gke.cluster', 'gke.location', 'gke.namespace',
  'gke.context', 'cloud_run.job', 'images.worker', 'images.codex',
] as const;
/** Keys a running daemon applies on refresh. */
export const HOT_KEYS = ['concurrency.max_workers', 'model_policy', 'log_shipping'] as const;

export function diffRestartRequired(prev: ConductorConfig, next: ConductorConfig): string[] {
  return RESTART_ONLY_KEYS.filter(
    (k) => JSON.stringify(getPath(prev, k.split('.'))) !== JSON.stringify(getPath(next, k.split('.'))),
  );
}

// ---------------------------------------------------------------------------------------------------
// Repo resolution (used by the async refresh and the CLI)
// ---------------------------------------------------------------------------------------------------

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The "config_repo missing" issue — the caller reports it; there is NO default repo name. */
export function missingConfigRepoIssue(): ConductorConfigIssue {
  return {
    file: HOST_FILE_LABEL,
    key: 'config_repo',
    problem: 'missing: no repo is named to read .harmony/conductor.json from',
    fix: 'add config_repo: "owner/name" to ~/.harmony/conductor-host.json',
  };
}

/** HARMONY_CONDUCTOR_CONFIG_REPO > host config_repo > null. `legacyDeploymentConfig` is accepted for
 *  signature stability but deployment.json has no repo key, so it never contributes. */
export function resolveConfigRepo(input: {
  hostFile?: Pick<HostFile, 'config_repo' | 'config_ref'> | null;
  legacyDeploymentConfig?: DeploymentConfig | null;
  env?: NodeJS.ProcessEnv;
}): { repo: string; ref: string } | null {
  const env = input.env ?? process.env;
  const repo = env.HARMONY_CONDUCTOR_CONFIG_REPO || input.hostFile?.config_repo;
  if (!repo) return null;
  if (!REPO_RE.test(repo)) {
    throw new ConductorConfigError({
      file: env.HARMONY_CONDUCTOR_CONFIG_REPO ? 'env' : HOST_FILE_LABEL,
      key: env.HARMONY_CONDUCTOR_CONFIG_REPO ? 'HARMONY_CONDUCTOR_CONFIG_REPO' : 'config_repo',
      problem: `${JSON.stringify(repo)} is not an "owner/name" repo`,
      fix: 'set it to "owner/name", e.g. "ycomplex/harmony-workspace"',
    });
  }
  return { repo, ref: input.hostFile?.config_ref || env.HARMONY_CONDUCTOR_CONFIG_REF || 'main' };
}

// ---------------------------------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------------------------------

const emitted = new Set<string>();
/** Test hook: forget which warnings were already emitted in this process. */
export function resetConductorWarningDedupe(): void {
  emitted.clear();
}

export interface ConductorLoadOptions {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
  /** Warning sink; each distinct message is passed at most once per process. Default: stderr. */
  warn?: (message: string) => void;
  /** The legacy deployment.json loader (injected by deployment-config.ts — no import cycle). Called at
   *  most once, and only when a new-file input exists. */
  loadLegacy?: () => DeploymentConfig | null;
  /** Env keys that are OUR applyLaunchEnv output (not operator legacy knobs) — ignored by the legacy layer. */
  appliedEnvKeys?: ReadonlySet<string>;
}

export interface ConductorEvaluation {
  merged: ConductorConfig;
  /** null when `issues` is non-empty. */
  deploymentConfig: DeploymentConfig | null;
  sources: string[];
  warnings: string[];
  issues: ConductorConfigIssue[];
  /** Round B (additive): the individual layers that went into `merged`, so the doctor can report a key
   *  set to DIFFERENT values in two layers. `project` is the validated project file (or snapshot);
   *  `legacy` is the already-mapped legacy layer (deployment.json + legacy env knobs, mixed). A layer
   *  that did not contribute is `undefined` (or `{}` for env/legacy). */
  layers: {
    project: Record<string, unknown> | undefined;
    host: Record<string, unknown> | undefined;
    env: Record<string, unknown>;
    legacy: Record<string, unknown>;
  };
}

export interface ConductorLoadResult extends ConductorEvaluation {
  deploymentConfig: DeploymentConfig;
}

/** Evaluate every layer and COLLECT all issues (the doctor's entry point). Returns null when no new-file
 *  input exists at all. Never throws for config problems; a malformed legacy deployment.json still
 *  throws exactly as it always did. */
export function evaluateConductorConfig(opts: ConductorLoadOptions = {}): ConductorEvaluation | null {
  const env = opts.env ?? process.env;
  const exists = opts.existsSync ?? fsExistsSync;
  const read = opts.readFileSync ?? ((p: string) => fsReadFileSync(p, 'utf8'));
  const paths = resolveConductorPaths(env);

  const issues: ConductorConfigIssue[] = [];
  const warnings: string[] = [];
  const sources: string[] = [];

  const readText = (path: string, label: string): string | null => {
    try {
      return read(path);
    } catch (err) {
      issues.push({ file: label, key: '(file)', problem: `could not be read: ${err instanceof Error ? err.message : String(err)}`, fix: `check that ${path} exists and is readable` });
      return null;
    }
  };

  const hasExplicitProject = !!paths.projectFile;
  const hasSnapshot = !hasExplicitProject && exists(paths.snapshotFile);
  const hasHost = exists(paths.hostFile);
  if (!hasExplicitProject && !hasSnapshot && !hasHost) return null;

  // --- project layer
  let projectLayer: Obj | undefined;
  let projectFailed = false;
  if (paths.projectFile) {
    const label = basename(paths.projectFile);
    if (!exists(paths.projectFile)) {
      projectFailed = true;
      issues.push({ file: label, key: '(file)', problem: `not found at ${paths.projectFile}`, fix: 'create it, or unset HARMONY_CONDUCTOR_PROJECT_FILE' });
    } else {
      const text = readText(paths.projectFile, label);
      if (text !== null) {
        const v = validateProjectFileText(label, text);
        if (v.ok) {
          projectLayer = v.value as Obj;
          sources.push(`project: ${paths.projectFile}`);
        } else {
          projectFailed = true;
          issues.push(...v.issues);
        }
      } else projectFailed = true;
    }
  } else if (hasSnapshot) {
    const text = readText(paths.snapshotFile, 'conductor-snapshot.json');
    if (text !== null) {
      const snap = parseSnapshotText(text);
      if (!snap) {
        warnings.push(`snapshot ${paths.snapshotFile} is unreadable or malformed; ignoring it (run \`harmony conductor config sync\` to rewrite it)`);
      } else {
        const v = validateProjectFileText(PROJECT_FILE_LABEL, snap.content);
        if (v.ok) {
          projectLayer = v.value as Obj;
          sources.push(`snapshot: ${paths.snapshotFile} (${snap.source.repo}@${snap.source.ref}, fetched ${snap.fetched_at})`);
        } else {
          projectFailed = true;
          issues.push(...v.issues);
        }
      }
    } else projectFailed = true;
  }

  // --- host layer
  let hostLayer: Obj | undefined;
  if (hasHost) {
    const text = readText(paths.hostFile, HOST_FILE_LABEL);
    if (text !== null) {
      const v = validateText(HOST_FILE_LABEL, text, HostFileSchema);
      if (v.ok) {
        hostLayer = v.value as Obj;
        sources.push(`host: ${paths.hostFile}`);
      } else issues.push(...v.issues);
    }
  }

  // --- env layer
  const envL = envLayer(env);
  issues.push(...envL.issues);
  if (envL.vars.length) sources.push(`env: ${envL.vars.join(', ')} (test overrides)`);

  // --- legacy layer (loaded once; a malformed deployment.json throws as it always did)
  const deployment = opts.loadLegacy ? opts.loadLegacy() : null;
  const nonLegacy = mergeLayers(projectLayer, hostLayer, envL.layer);
  let profileName: string | undefined = nonLegacy.profile;
  if (!profileName && deployment?.profiles) {
    const builtin = Object.keys(deployment.profiles).filter((n) => n in BUILTIN_PROFILES);
    if (builtin.length === 1) profileName = builtin[0];
  }
  const legacy = legacyToConductor({ deployment, env, profileName, ignoreEnvKeys: opts.appliedEnvKeys });
  if (legacy.used) {
    const parts = [legacy.hasDeployment ? 'deployment.json' : '', legacy.envKnobs.length ? `env ${legacy.envKnobs.join(', ')}` : ''].filter(Boolean);
    sources.push(`legacy (deprecated): ${parts.join('; ')}`);
  }

  // --- first-boot rule: no usable project layer (an INVALID one is already an issue, not an absence)
  if (!projectLayer && !projectFailed) {
    if (legacy.used) {
      warnings.push('no project file reachable yet; running on legacy files');
      if (profileName && !nonLegacy.profile) {
        legacy.layer.profile = profileName;
        warnings.push(`profile ${JSON.stringify(profileName)} inferred from deployment.json (set "profile" in .harmony/conductor.json)`);
      }
    } else {
      issues.push({
        file: PROJECT_FILE_LABEL,
        key: '(file)',
        problem: 'no project file is available (no snapshot, HARMONY_CONDUCTOR_PROJECT_FILE unset) and no legacy files exist to fall back on',
        fix: 'run `harmony conductor config sync` or set HARMONY_CONDUCTOR_PROJECT_FILE',
      });
    }
  }

  warnings.push(...legacy.warnings);
  const merged = mergeLayers(legacy.layer, projectLayer, hostLayer, envL.layer);

  // Requirement errors only make sense on a merge of layers that each validated.
  if (issues.length === 0) issues.push(...validateMerged(merged, env));

  const uniqueWarnings = [...new Set(warnings)];
  let deploymentConfig: DeploymentConfig | null = null;
  if (issues.length === 0) {
    deploymentConfig = projectToDeploymentConfig(merged, deployment, uniqueWarnings);
  }
  const warnFn = opts.warn ?? ((m: string) => console.error(`[conductor-config] ${m}`));
  for (const w of uniqueWarnings) {
    if (emitted.has(w)) continue;
    emitted.add(w);
    warnFn(w);
  }
  return {
    merged,
    deploymentConfig,
    sources,
    warnings: [...new Set(uniqueWarnings)],
    issues,
    layers: { project: projectLayer, host: hostLayer, env: envL.layer, legacy: legacy.layer },
  };
}

/** The runtime entry: null when no new-file input exists (callers fall back to today's behaviour);
 *  THROWS a ConductorConfigError listing every issue (one per line) when a new-file input exists but is
 *  invalid. */
export function loadConductorConfigSync(opts: ConductorLoadOptions = {}): ConductorLoadResult | null {
  const ev = evaluateConductorConfig(opts);
  if (!ev) return null;
  if (ev.issues.length > 0 || !ev.deploymentConfig) throw new ConductorConfigError(ev.issues);
  return ev as ConductorLoadResult;
}
