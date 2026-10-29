import { describe, it, expect, vi } from 'vitest';
import {
  parseFigmaFileKey, resolveComposeTarget, assertNotLibrary, validateWorkingFile,
  ticketPagePrefix, ticketPageName, findTicketPage, formatWorkingFileSetComment, FIGMA_KEY_RE,
} from './figma-working-file.js';

const K = 'AbCdEfGhIjKlMnOpQrStUv';
const L = 'LiBrArYkEyLiBrArYkEyLi';

describe('parseFigmaFileKey', () => {
  it('accepts bare keys and urls', () => {
    expect(parseFigmaFileKey(K)).toBe(K);
    expect(parseFigmaFileKey(`https://www.figma.com/design/${K}/Name?node-id=1-2`)).toBe(K);
    expect(parseFigmaFileKey(`https://figma.com/file/${K}/Name`)).toBe(K);
    expect(parseFigmaFileKey(`https://www.figma.com/board/${K}/B`)).toBe(K);
    expect(parseFigmaFileKey(`https://www.figma.com/make/${K}/M`)).toBe(K);
    expect(parseFigmaFileKey(`https://www.figma.com/slides/${K}/S`)).toBe(K);
  });
  it('uses the branch key for branch urls', () => {
    expect(parseFigmaFileKey(`https://www.figma.com/design/${L}/branch/${K}/Name`)).toBe(K);
  });
  it('rejects junk', () => {
    expect(parseFigmaFileKey('')).toBeNull();
    expect(parseFigmaFileKey('short')).toBeNull();
    expect(parseFigmaFileKey(`https://example.com/design/${K}/x`)).toBeNull();
    expect(parseFigmaFileKey(`https://figma.com/proto/${K}/x`)).toBeNull();
    expect(FIGMA_KEY_RE.test(`${K}!`)).toBe(false);
  });
});

describe('resolveComposeTarget / assertNotLibrary', () => {
  it('maps the three outcomes', () => {
    expect(resolveComposeTarget({ libraryFileKey: L, workingFileKey: K })).toEqual({ status: 'ready', fileKey: K });
    expect(resolveComposeTarget({ libraryFileKey: L })).toEqual({ status: 'ask', reason: 'no-working-file' });
    expect(resolveComposeTarget({ libraryFileKey: L, workingFileKey: null })).toEqual({ status: 'ask', reason: 'no-working-file' });
    expect(resolveComposeTarget({ libraryFileKey: L, workingFileKey: L })).toEqual({ status: 'refuse', reason: 'working-file-is-library' });
  });
  it('never falls back to the library', () => {
    expect(resolveComposeTarget({ libraryFileKey: L })).not.toMatchObject({ fileKey: L });
  });
  it('assertNotLibrary throws naming the rule', () => {
    expect(() => assertNotLibrary(L, L)).toThrow(/library/);
    expect(() => assertNotLibrary(K, L)).not.toThrow();
    expect(() => assertNotLibrary(K, undefined)).not.toThrow();
  });
});

describe('validateWorkingFile', () => {
  const res = (status: number, body: unknown = {}) => ({ status, json: async () => body }) as Response;
  it('ok on 200 with the file name, sending the token header and depth=1', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { name: 'Work' }));
    const r = await validateWorkingFile({ input: K, libraryFileKey: L, token: 'secret-tok', fetcher: f as never });
    expect(r).toEqual({ ok: true, fileKey: K, name: 'Work' });
    expect(f.mock.calls[0][0]).toBe(`https://api.figma.com/v1/files/${K}?depth=1`);
    expect(f.mock.calls[0][1].headers['X-Figma-Token']).toBe('secret-tok');
  });
  it('maps statuses and never leaks the token', async () => {
    for (const [status, reason] of [[404, 'not-found'], [403, 'forbidden'], [429, 'rate-limited'], [500, 'network']] as const) {
      const r = await validateWorkingFile({ input: K, token: 'secret-tok', fetcher: (async () => res(status)) as never });
      expect(r).toMatchObject({ ok: false, reason });
      expect(JSON.stringify(r)).not.toContain('secret-tok');
    }
  });
  it('network failure, bad key and library are refused; library/bad never fetch', async () => {
    const f = vi.fn();
    expect(await validateWorkingFile({ input: 'x', token: 't', fetcher: f as never })).toMatchObject({ reason: 'bad-key' });
    expect(await validateWorkingFile({ input: L, libraryFileKey: L, token: 't', fetcher: f as never })).toMatchObject({ reason: 'is-library' });
    expect(f).not.toHaveBeenCalled();
    const r = await validateWorkingFile({ input: K, token: 'secret-tok', fetcher: (async () => { throw new Error('boom secret-tok'); }) as never });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(JSON.stringify(r)).not.toContain('secret-tok');
  });
});

describe('ticket pages', () => {
  it('prefix and name', () => {
    expect(ticketPagePrefix('B-1319')).toBe('B-1319 · ');
    expect(ticketPageName('B-1319', '  Design tool ')).toBe('B-1319 · Design tool');
    const long = ticketPageName('B-1', 'Make the extremely long ticket title shorten on a word boundary please');
    expect(long.length).toBeLessThanOrEqual('B-1 · '.length + 40);
    expect(long.endsWith(' ')).toBe(false);
    expect(long).toBe('B-1 · Make the extremely long ticket title');
  });
  it('finds by prefix, first hit, else null', () => {
    const pages = [{ id: '1', name: 'Cover' }, { id: '2', name: 'B-1319 · Old' }, { id: '3', name: 'B-1319 · Dup' }, { id: '4', name: 'B-13190 · X' }];
    expect(findTicketPage(pages, 'B-1319')?.id).toBe('2');
    expect(findTicketPage(pages, 'B-9')).toBeNull();
    expect(findTicketPage(pages, 'B-1319')?.id).not.toBe('4');
  });
});

describe('formatWorkingFileSetComment', () => {
  it('is exactly one marker line', () => {
    const line = formatWorkingFileSetComment({ projectKey: 'B', fileKey: K, setBy: 'owner', exchangeId: 'ex-1', taskId: 't-1', via: 'leg' });
    expect(line).toBe(`FIGMA-WORKING-FILE-SET project=B file=${K} by=owner via=leg exchange=ex-1 task=t-1`);
    expect(line).not.toContain('\n');
  });
});
