import { describe, it, expect } from 'vitest';
import { defaultFigmaConnectionReader, resolveFigmaRoute, preflightFigma, reconnectInstruction, figmaBehavioursEnabled } from './figma-connection.js';

describe('figma connection preflight (B-1203)', () => {
  it('default reader always resolves unconnected (B-1201 will replace it)', async () => {
    expect(await defaultFigmaConnectionReader.read()).toEqual({ state: 'unconnected' });
    const { route } = await preflightFigma();
    expect(route).toBe('html');
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
