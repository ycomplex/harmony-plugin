import { describe, expect, it, vi } from 'vitest';
import { BOOKKEEPING_TAG, bookkeepingPage, bookkeepingTags, isBookkeeping } from './knowledge-bookkeeping.js';

describe('explicit bookkeeping metadata', () => {
  it('preserves writer tags and deduplicates the marker', () => {
    expect(bookkeepingTags(['process', BOOKKEEPING_TAG])).toEqual(['process', BOOKKEEPING_TAG]);
    expect(isBookkeeping({ tags: bookkeepingTags() })).toBe(true);
    expect(isBookkeeping({})).toBe(false);
    expect(isBookkeeping({ tags: null })).toBe(false);
    expect(isBookkeeping({ tags: ['HARMONY:BOOKKEEPING', 'recorded plan'] })).toBe(false);
  });
});

describe('bookkeeping pagination over ranked, filtered server partitions', () => {
  // Input order is the relevance order. The procedural row deliberately outranks the substantive
  // rows, and a title that looks procedural is still substantive without the explicit marker.
  const ranked = [
    { id: 'p1', tags: [BOOKKEEPING_TAG], score: 0.9 },
    { id: 's1', tags: null, score: 0.8, title: 'no new decision needed (recorded)' },
    { id: 'p2', tags: [BOOKKEEPING_TAG], score: 0.7 },
    { id: 's2', score: 0.6 },
  ];
  const server = () => vi.fn(async ({ bookkeeping, offset, limit, count }) => {
    const partition = ranked.filter(row => isBookkeeping(row) === bookkeeping);
    return { data: partition.slice(offset, offset + limit), error: null, count: count ? partition.length : null };
  });

  it('finds substantive knowledge before the final limit, preserving each class order and scores', async () => {
    expect(await bookkeepingPage(server(), { limit: 1 })).toEqual([ranked[1]]);
    expect(await bookkeepingPage(server(), { limit: 4 })).toEqual([ranked[1], ranked[3], ranked[0], ranked[2]]);
  });

  it('excludes bookkeeping before pagination and never asks for that partition', async () => {
    const fetch = server();
    expect(await bookkeepingPage(fetch, { limit: 1, offset: 1, include_bookkeeping: false })).toEqual([ranked[3]]);
    expect(fetch.mock.calls.every(([request]) => !request.bookkeeping)).toBe(true);
  });

  it('handles pages crossing or starting beyond the class boundary', async () => {
    expect(await bookkeepingPage(server(), { offset: 1, limit: 2 })).toEqual([ranked[3], ranked[0]]);
    expect(await bookkeepingPage(server(), { offset: 3, limit: 2 })).toEqual([ranked[2]]);
    expect(await bookkeepingPage(server(), { offset: 20, limit: 2 })).toEqual([]);
  });

  it('chunks a requested page below the REST row cap without scanning earlier pages', async () => {
    const rows = Array.from({ length: 1100 }, (_, id) => ({ id }));
    const fetch = vi.fn(async ({ offset, limit }) => ({ data: rows.slice(offset, offset + limit), error: null }));
    expect(await bookkeepingPage(fetch, { limit: 1001, include_bookkeeping: false })).toHaveLength(1001);
    expect(fetch.mock.calls.map(([r]) => [r.offset, r.limit])).toEqual([[0, 500], [500, 500], [1000, 1]]);
  });

  it('uses the explicit 416 row count when a page starts beyond substantive results', async () => {
    const fetch = vi.fn(async ({ bookkeeping, offset }) => bookkeeping
      ? { data: [{ id: 'p2', offset }], error: null, count: null }
      : { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable', details: 'An offset of 3 was requested, but there are only 2 rows.' }, count: null });
    expect(await bookkeepingPage(fetch, { offset: 3, limit: 1 })).toEqual([{ id: 'p2', offset: 1 }]);
  });

  it('surfaces a server error instead of returning a falsely complete page', async () => {
    await expect(bookkeepingPage(async () => ({ data: null, error: { message: 'timeout' } }), {})).rejects.toThrow('timeout');
    expect(await bookkeepingPage(server(), { limit: 0 })).toEqual([]);
  });
});
