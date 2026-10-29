import { describe, it, expect, vi } from 'vitest';
import { adoptCheck, type AdoptCheckDeps } from './design.js';
import { FigmaRestError } from '../../tools/figma-reconcile.js';

const TOKEN = 'secret-token-123';
const frameNode = { id: '1:2', name: 'Home', type: 'FRAME', children: [{ id: '1:3', name: 'Btn', type: 'INSTANCE', componentId: 'c1' }] };
function deps(over: Partial<AdoptCheckDeps> = {}): AdoptCheckDeps {
  return {
    token: TOKEN,
    readTexts: async () => ['Design: https://www.figma.com/design/AAA/n?node-id=1-2', 'dup https://www.figma.com/design/AAA/n?node-id=1-2'],
    readLibraryFileKey: async () => 'LIB',
    readNodes: async () => ({ nodes: { '1:2': { document: frameNode, components: { c1: { key: 'k1', name: 'Btn', remote: true } } } } }),
    lookupComponentFile: async () => ({ fileKey: 'LIB' }),
    sleep: async () => {},
    ...over,
  };
}

describe('design adopt-check', () => {
  it('no links', async () => {
    const r = await adoptCheck('B-1', {}, deps({ readTexts: async () => ['nothing'] }));
    expect(r).toMatchObject({ command: 'adopt-check', status: 'no-links', links: [] });
  });
  it('no token', async () => {
    const r = await adoptCheck('B-1', {}, deps({ token: undefined }));
    expect(r.status).toBe('no-token');
  });
  it('not connected', async () => {
    const r = await adoptCheck('B-1', {}, deps({ readLibraryFileKey: async () => null }));
    expect(r.status).toBe('not-connected');
  });
  it('adopted frame, one JSON-able line, no token in output', async () => {
    const r = await adoptCheck('B-1', {}, deps());
    expect(r).toMatchObject({ status: 'ok', lookups_used: 1, lookup_cap: 40 });
    expect((r.frames as Array<{ verdict: string; id: string }>)[0]).toMatchObject({ id: '1:2', verdict: 'adopted', instances: 1, lookups: 1 });
    expect((r.links as unknown[]).length).toBe(1);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('links-only reports readability and does no lookups', async () => {
    const lookup = vi.fn(async () => ({ fileKey: 'LIB' }));
    const r = await adoptCheck('B-1', { linksOnly: true }, deps({ lookupComponentFile: lookup }));
    expect((r.links as Array<{ readable: boolean }>)[0].readable).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('links-only: unreadable on 403 and on a link with no node id', async () => {
    const r = await adoptCheck('B-1', { linksOnly: true }, deps({
      readTexts: async () => ['https://www.figma.com/design/AAA/n?node-id=1-2 https://www.figma.com/design/BBB/n'],
      readNodes: async () => { throw new FigmaRestError('unauthorized', 'no', 403); },
    }));
    expect((r.links as Array<{ readable: boolean }>).map((l) => l.readable)).toEqual([false, false]);
  });
});
