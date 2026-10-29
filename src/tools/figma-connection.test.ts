import { describe, it, expect, vi } from 'vitest';
import * as figmaMod from '../agents/design-tools/figma.js';
import { defaultFigmaConnectionReader, resolveFigmaRoute, preflightFigma, reconnectInstruction, figmaBehavioursEnabled } from './figma-connection.js';

describe('figma connection preflight (B-1203)', () => {
  it('connected exposes library and working keys, not a fileKey (B-1325)', async () => {
    const ctx = { state: 'connected', connections_enabled: true, library_file_key: 'LIB', working_file_key: 'WORK', generation: 3, access_expires_at: '2999-01-01T00:00:00Z', access_version: 'a', pat_version: 'p' };
    vi.stubEnv('HARMONY_FIGMA_CONTEXT_B64', Buffer.from(JSON.stringify(ctx)).toString('base64'));
    vi.spyOn(figmaMod, 'readMountedFigmaToken').mockReturnValue('tok');
    try {
      const c = await defaultFigmaConnectionReader.read();
      expect(c).toEqual({ state: 'connected', libraryFileKey: 'LIB', workingFileKey: 'WORK', componentMapId: '3' });
      expect(c).not.toHaveProperty('fileKey');
      vi.stubEnv('HARMONY_FIGMA_CONTEXT_B64', Buffer.from(JSON.stringify({ ...ctx, working_file_key: undefined })).toString('base64'));
      expect(await defaultFigmaConnectionReader.read()).toMatchObject({ workingFileKey: null });
    } finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); }
  });
  it('default reader always resolves unconnected (B-1201 will replace it)', async () => {
    vi.stubEnv('HARMONY_FIGMA_CONTEXT_B64', '');
    expect(await defaultFigmaConnectionReader.read()).toEqual({ state: 'unconnected' });
    const { route } = await preflightFigma();
    expect(route).toBe('html');
    vi.unstubAllEnvs();
  });
  it('routes the three outcomes', () => {
    expect(resolveFigmaRoute({ state: 'unconnected' })).toBe('html');
    expect(resolveFigmaRoute({ state: 'connected' })).toBe('figma');
    expect(resolveFigmaRoute({ state: 'failing', reason: 'token expired' })).toBe('stop');
  });
  it('failing never falls back to html, and names the reconnect', () => {
    expect(resolveFigmaRoute({ state: 'failing', reason: 'x' })).not.toBe('html');
    expect(reconnectInstruction({ state: 'failing', reason: 'token expired' })).toMatch(/harmony figma connect/);
  });
  it('figma-gated behaviours are enabled only on the figma route', () => {
    expect(figmaBehavioursEnabled('figma')).toBe(true);
    expect(figmaBehavioursEnabled('html')).toBe(false);
    expect(figmaBehavioursEnabled('stop')).toBe(false);
  });
});
