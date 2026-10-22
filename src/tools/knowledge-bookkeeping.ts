/** Writer-owned metadata, never inferred from an entry's title or ticket identity. */
export const BOOKKEEPING_TAG = 'harmony:bookkeeping';

export function bookkeepingTags(tags: readonly string[] = []): string[] {
  return [...new Set([...tags, BOOKKEEPING_TAG])];
}

export function isBookkeeping(entry: { tags?: readonly string[] | null }): boolean {
  return entry.tags?.includes(BOOKKEEPING_TAG) ?? false;
}

/** PostgREST's NOT contains excludes SQL NULL too; unmarked NULL tags are substantive. */
export const SUBSTANTIVE_TAG_FILTER = `tags.is.null,tags.not.cs.{${BOOKKEEPING_TAG}}`;

interface PartitionResult<T> {
  data: T[] | null;
  error: { message: string; code?: string; details?: string } | null;
  count?: number | null;
}

export interface BookkeepingPageRequest {
  bookkeeping: boolean;
  offset: number;
  limit: number;
  count: boolean;
}

/**
 * Filter each partition on the server BEFORE its range. Never sort/filter an already limited page:
 * a high-scoring procedural entry would otherwise hide a substantive hit just beyond that page.
 * The factory retains the caller's filters and ranking (including RRF scores) within each class.
 * Existing tags + SETOF RPC filtering work before the companion ordering migration is deployed.
 */
export async function bookkeepingPage<T>(
  fetchPage: (request: BookkeepingPageRequest) => PromiseLike<PartitionResult<T>>,
  { limit = 50, offset = 0, include_bookkeeping = true }: {
    limit?: number; offset?: number; include_bookkeeping?: boolean;
  },
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error('Knowledge limit and offset must be non-negative integers');
  }
  if (limit === 0) return [];

  // Stay below the usual PostgREST max-rows cap even when a caller requests a larger page.
  const partition = async (bookkeeping: boolean, start: number, size: number, count: boolean) => {
    const rows: T[] = [];
    let total: number | null | undefined;
    while (rows.length < size) {
      const chunk = Math.min(500, size - rows.length);
      const result = await fetchPage({ bookkeeping, offset: start + rows.length, limit: chunk, count });
      // PostgREST reports an offset beyond the class's end as 416 rather than an empty page.
      // Exact count (or its explicit range-error detail) still tells us where the next class starts.
      if (result.error?.code === 'PGRST103') {
        total = result.count ?? Number(result.error.details?.match(/only (\d+) rows/)?.[1]);
        if (count && !Number.isFinite(total)) throw new Error(result.error.message);
        break;
      }
      if (result.error) throw new Error(result.error.message);
      total = result.count ?? total;
      const batch = result.data ?? [];
      rows.push(...batch);
      if (batch.length < chunk) break;
    }
    return { rows, total };
  };

  const substantive = await partition(false, offset, limit, include_bookkeeping && offset > 0);
  if (!include_bookkeeping || substantive.rows.length === limit) return substantive.rows;
  // An offset can start beyond the substantive partition. Exact count locates the boundary without
  // downloading/scanning earlier pages. At offset zero the short page itself is the exact count.
  const substantiveTotal = offset === 0 ? substantive.rows.length : substantive.total;
  if (substantiveTotal == null) throw new Error('Knowledge pagination requires the substantive count');
  const procedural = await partition(true, Math.max(0, offset - substantiveTotal), limit - substantive.rows.length, false);
  return [...substantive.rows, ...procedural.rows];
}
