/** B-1036: resolve one of the plugin's three connection variables, falling back to its
 *  `EVAL_`-prefixed twin when the ordinary name is unset.
 *
 *  Why the twin exists: `claude plugin eval` runs the plugin's real MCP server inside a sandbox
 *  that withholds the executor's environment — only a small allowlist and `EVAL_*` variables reach
 *  the child session (code.claude.com/docs/en/plugin-evals, "Nothing personal or project-level
 *  loads"). Proven live 2026-09-22: without this, the server exits at spawn with "HARMONY_API_TOKEN
 *  environment variable is required" on every case. The ordinary name always wins when both are
 *  set, so no installed plugin changes behaviour; a session with neither set is unchanged too (the
 *  callers keep their own "required" handling). */
export type HarmonyConnectionVar =
  | 'HARMONY_API_TOKEN'
  | 'HARMONY_SUPABASE_URL'
  | 'HARMONY_SUPABASE_ANON_KEY';

export function harmonyEnv(
  name: HarmonyConnectionVar,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[name] ?? env[`EVAL_${name}`];
}
