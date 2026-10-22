export interface VerificationStamp { plugin_version?: string | null; web_sha?: string | null; at: string }
export type RolloutState = 'designed' | 'partly-live' | 'live' | 'retired';
export interface KnowledgeTruthState {
  verified_against?: VerificationStamp | null;
  rollout_state?: RolloutState | null;
  open_steps?: string[] | null;
}
const FIELDS = ['verified_against', 'rollout_state', 'open_steps'] as const;
export function truthStatePatch(args: KnowledgeTruthState): KnowledgeTruthState {
  return Object.fromEntries(FIELDS.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
}
export function missingTruthColumns(error: { code?: string; message?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '') && FIELDS.some(k => error.message?.includes(k));
}
/** Retry only recognized new-column errors; transport/auth/unrelated schema failures remain errors. */
export async function truthCompatibleRead<T extends { data: unknown; error: { code?: string; message?: string } | null }>(
  read: (extraColumns: string) => PromiseLike<T>,
): Promise<T> {
  const result = await read(', verified_against, rollout_state, open_steps');
  if (!missingTruthColumns(result.error)) return result;
  const legacy = await read('');
  const missing = { verified_against: null, rollout_state: null, open_steps: null };
  const normalize = (row: unknown) => ({ ...(row as object), ...missing });
  return { ...legacy, data: Array.isArray(legacy.data) ? legacy.data.map(normalize) : legacy.data ? normalize(legacy.data) : legacy.data };
}
