/** B-1025: resolve the Supabase URL + anon key PAIR for ONE CLI call.
 *
 *  Why this module exists. `src/auth.ts` and `src/supabase.ts` used to capture
 *  `HARMONY_SUPABASE_URL` / `HARMONY_SUPABASE_ANON_KEY` at MODULE IMPORT, before any CLI command ran.
 *  `harmony login --supabase-url …` and the active project's stored `supabaseUrl` therefore never
 *  reached the token exchange — the flag and the stored project were dead code, and a second
 *  project's URL was silently exchanged against production's (the founder's 2026-09-14 401).
 *
 *  The rule (the Accepted product + technical decisions, B-1025):
 *
 *    - Precedence is flags -> registered project -> environment -> built-in defaults.
 *    - The FIRST source that names a URL OWNS the pair. It must also name the anon key; a URL
 *      with no key beside it is refused BY NAME before any network call, because a URL paired
 *      with another project's key fails as an opaque 401 that reads like a bad token.
 *    - A source that names only a key does NOT claim the URL — it is skipped when a later source
 *      names one, so a stray key can never be sent to a different project's server.
 *
 *  Two deliberate accommodations of the strict "first source naming a URL owns the pair" rule:
 *
 *    1. When NO source names a URL, the built-in default URL stands and an explicitly supplied
 *       key is honoured (`harmony login --supabase-anon-key <key>` must use the key it was given
 *       — acceptance criterion c2da57c6).
 *
 *    2. When a source names the built-in default URL but no key, the pair is the default pair
 *       (the default URL and the default key are inseparable: a CLI built with a new default URL
 *       is built with its matching default key). This is the prod-target worker container's
 *       route: `container/provision.sh` exports `HARMONY_SUPABASE_URL=<prod URL>` for
 *       `HARMONY_TARGET=prod` and relies on the baked default key. Refusing it would break every
 *       CLI call inside every prod-target worker container — and it is NOT the cross-pairing the
 *       refusal exists to prevent (the default URL and default key are the SAME pair, from the
 *       SAME baked-in source, never from two different projects).
 *
 *  Both accommodations preserve the rule's intent: a URL is never paired with a key from a
 *  DIFFERENT project. A refusal still fires for every half-pair where the URL came from one
 *  source and the missing key is its OWN partner from elsewhere — the staging-channel URL
 *  without its key, for example.
 */
import { harmonyEnv } from '../env.js';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from '../auth.js';

/** Which source supplied the pair. `default` means the built-in pair was used. */
export type SupabaseTargetSource = 'flags' | 'project' | 'env' | 'default';

/** The `--supabase-url` / `--supabase-anon-key` login flags. */
export interface SupabaseTargetFlags {
  url?: string;
  anonKey?: string;
}

/** The stored project's `supabaseUrl` / `supabaseAnonKey` (ProjectConfig in ~/.harmony/config.json). */
export interface SupabaseTargetProject {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface ResolvedSupabaseTarget {
  url: string;
  anonKey: string;
  source: SupabaseTargetSource;
}

/** How each source is NAMED in the refusal message — the human needs to know which one to fix. */
const SOURCE_LABEL: Record<SupabaseTargetSource, string> = {
  flags: 'the --supabase-url flag',
  project: "the active project's stored Supabase settings",
  env: 'HARMONY_SUPABASE_URL',
  default: 'the built-in default',
};

/** The remedy, per source. Each names the SAME source the URL came from — a pair is one source. */
const SOURCE_REMEDY: Record<SupabaseTargetSource, string> = {
  flags:
    'Pass --supabase-anon-key <key> alongside --supabase-url — the URL and its key travel together.',
  project:
    'This project was registered without an anon key (projects saved by an older CLI carry a URL but no key). ' +
    'Re-run `harmony login --supabase-url <url> --supabase-anon-key <key> --token <token> --name <name>` to register the key.',
  env:
    'Set HARMONY_SUPABASE_ANON_KEY in the environment — it must sit beside HARMONY_SUPABASE_URL.',
  default: 'Supply the anon key with the URL.',
};

/**
 * A URL with no anon key beside it. Thrown BEFORE any token exchange, so the founder sees the
 * missing half by name instead of an opaque 401 that reads like a bad credential.
 */
export class MissingAnonKeyError extends Error {
  readonly source: SupabaseTargetSource;
  readonly url: string;

  constructor(source: SupabaseTargetSource, url: string) {
    super(
      `Missing Supabase anon key for ${url} (from ${SOURCE_LABEL[source]}). ${SOURCE_REMEDY[source]}`,
    );
    this.name = 'MissingAnonKeyError';
    this.source = source;
    this.url = url;
  }
}

/**
 * Resolve the Supabase pair for one call. Pure: it reads only what it is handed.
 */
export function resolveSupabaseTarget(input: {
  flags?: SupabaseTargetFlags;
  project?: SupabaseTargetProject;
  env?: NodeJS.ProcessEnv;
}): ResolvedSupabaseTarget {
  const env = input.env ?? process.env;

  const sources: Array<{ source: SupabaseTargetSource; url?: string; anonKey?: string }> = [
    { source: 'flags', url: input.flags?.url, anonKey: input.flags?.anonKey },
    {
      source: 'project',
      url: input.project?.supabaseUrl,
      anonKey: input.project?.supabaseAnonKey,
    },
    {
      source: 'env',
      url: harmonyEnv('HARMONY_SUPABASE_URL', env),
      anonKey: harmonyEnv('HARMONY_SUPABASE_ANON_KEY', env),
    },
  ];

  // The first source that names a URL owns the pair — it must name the key too, UNLESS its URL
  // is the built-in default (the default URL and the default key are the same baked-in pair, so
  // naming one names the other — see the file-level comment).
  const owner = sources.find((candidate) => candidate.url);
  if (owner) {
    const url = owner.url as string;
    if (owner.anonKey) {
      return { url, anonKey: owner.anonKey, source: owner.source };
    }
    if (url === DEFAULT_SUPABASE_URL) {
      return {
        url,
        anonKey: DEFAULT_SUPABASE_ANON_KEY,
        source: owner.source,
      };
    }
    throw new MissingAnonKeyError(owner.source, url);
  }

  // No source named a URL: the built-in default stands, and an explicitly supplied key is
  // honoured rather than silently ignored (acceptance criterion c2da57c6).
  const keyOwner = sources.find((candidate) => candidate.anonKey);
  return {
    url: DEFAULT_SUPABASE_URL,
    anonKey: keyOwner?.anonKey ?? DEFAULT_SUPABASE_ANON_KEY,
    source: 'default',
  };
}
