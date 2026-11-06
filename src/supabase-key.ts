/** Normalize aliases only within the source that owns the Supabase pair. */
export function resolvePublicKey(anonKey: string | undefined, publishableKey: string | undefined,
  names: readonly [string, string]): string | undefined {
  if (anonKey && publishableKey && anonKey !== publishableKey) {
    throw new Error(`Conflicting Supabase public key aliases: ${names[0]} and ${names[1]}. Supply one or identical values.`);
  }
  return anonKey || publishableKey || undefined;
}
