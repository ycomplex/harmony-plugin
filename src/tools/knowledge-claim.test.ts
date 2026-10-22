import { describe, it, expect } from 'vitest';
import { claimFields, encodeClaim, stripClaim, editedClaimContent, isSingleSentenceShaped, matchedPassage, proposeClaim } from './knowledge-claim.js';
describe('portable knowledge claims', () => {
  it('round trips without duplicate envelopes or lost dated sections', () => {
    const body = '## 2026-10-22\nKeep this section.';
    const encoded = encodeClaim(body, 'Versions 0.16.3 work, e.g. on staging.');
    expect(claimFields({ content: encoded })).toEqual({ claim: 'Versions 0.16.3 work, e.g. on staging.', claim_source: 'authored' });
    expect(encodeClaim(encoded, 'The team keeps its history.')).toBe(encodeClaim(body, 'The team keeps its history.'));
    expect(stripClaim(encoded)).toBe(body);
  });
  it('keeps omitted claims derived until explicitly confirmed', () => {
    const row = { title: 'The team keeps its history.', content: encodeClaim('Body', 'The team keeps its history.', 'derived') };
    expect(claimFields({ content: editedClaimContent(row, { content: 'New body' }) }).claim_source).toBe('derived');
    expect(claimFields({ content: editedClaimContent(row, { claim: 'The team keeps its history.' }) }).claim_source).toBe('authored');
    expect(claimFields({ content: editedClaimContent({ ...row, content: 'Legacy' }, {}) }).claim_source).toBe('derived');
  });
  it('uses the existing sentence-shaped contract', () => {
    for (const value of ['v0.16.3 works.', 'Use it, e.g. for teams.', 'Use it, i.e. here.']) expect(isSingleSentenceShaped(value)).toBe(true);
    for (const value of ['', 'One. Two.', 'word '.repeat(51)]) expect(isSingleSentenceShaped(value)).toBe(false);
  });
  it('returns plain bounded matched passages and honest semantic-only absence', () => {
    expect(matchedPassage('**Use** [saved filters](https://example.test) for teams.', 'filters')).toBe('Use saved filters for teams.');
    expect(matchedPassage('x '.repeat(400) + 'filters', 'filters')!.length).toBeLessThanOrEqual(242);
    expect(matchedPassage('Only ranking found this entry.', 'board')).toBeNull();
  });
  it('proposes substantive first sentences and skips existing claims and empty boilerplate', () => {
    expect(proposeClaim('_Derived from the ratified brief._\n\n**Decision:** Teams can save their view.\n\nWhy: Useful.')).toBe('Teams can save their view.');
    expect(proposeClaim(encodeClaim('Body', 'Teams save views.'))).toBeNull();
    expect(proposeClaim('')).toBeNull();
  });
});
