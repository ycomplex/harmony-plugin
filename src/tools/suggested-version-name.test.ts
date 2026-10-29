import { describe, it, expect } from 'vitest';
import { suggestedVersionName } from './suggested-version-name.js';

describe('suggestedVersionName (strings shared with harmony-web)', () => {
  it('pins the shared strings', () => {
    expect(suggestedVersionName('B-1312', 2)).toBe('Before · B-1312 · round 2');
    expect(suggestedVersionName('B-1203', 1)).toBe('Before · B-1203 · round 1');
  });
  it('uses U+00B7 middle dots, not bullets or periods', () => {
    expect(suggestedVersionName('B-1', 1).split('·')).toHaveLength(3);
  });
});
