import { z } from 'zod';
export const options=z.object({timeout:z.number().default(30)});
export const errors={unsupported:'Source inventory schema unavailable'};
// Operator explanation: A stale inventory revision refuses publication; regenerate from a fresh snapshot.
export const recipe='Regenerate values after source checkout and before publishing the inventory.';
