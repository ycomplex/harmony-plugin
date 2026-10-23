import { describe, it, expect } from 'vitest';
import { sortEpics } from './epic-order.js';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./epic-order.golden.json', import.meta.url), 'utf8')) as { id: string; name: string; retired_at?: string | null }[];
describe('epic order contract', () => {
  it('sorts active first, case-folded lexically, with id ties and accents retained', () => {
    const original = [...fixture];
    expect(sortEpics(fixture).map(e => e.id)).toEqual(['1', '2', '3', '4', '8', '9']);
    expect(fixture).toEqual(original);
  });
});
