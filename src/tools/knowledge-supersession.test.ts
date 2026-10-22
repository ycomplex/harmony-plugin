import { describe, it, expect } from 'vitest';
import { projectSupersession } from './knowledge-supersession.js';

describe('supersession projection', () => {
  it('exposes both directions and orders a chain through a nonmatching intermediate', () => {
    const edges = [{ id: 'old', superseded_by: 'middle' }, { id: 'middle', superseded_by: 'new' }, { id: 'new' }, { id: 'other' }];
    const result = projectSupersession([{ id: 'old' }, { id: 'other' }, { id: 'new' }], edges);
    expect(result.map(e => e.id)).toEqual(['other', 'new', 'old']);
    expect(result.find(e => e.id === 'new')).toMatchObject({ superseded_by: null, supersedes: ['middle'] });
    expect(result.find(e => e.id === 'old')).toMatchObject({ superseded_by: 'middle', supersedes: [] });
  });
  it('does not leak a successor outside the scoped graph and tolerates absent fields', () => {
    expect(projectSupersession([{ id: 'a' }, { id: 'b' }], [{ id: 'a', superseded_by: 'foreign' }, { id: 'b' }]))
      .toEqual([{ id: 'a', superseded_by: null, supersedes: [] }, { id: 'b', superseded_by: null, supersedes: [] }]);
  });
  it('terminates deterministically for cycles and self-links without duplicating results', () => {
    const edges = [{ id: 'a', superseded_by: 'b' }, { id: 'b', superseded_by: 'a' }, { id: 'c', superseded_by: 'c' }];
    expect(projectSupersession(edges, edges).map(e => e.id)).toEqual(['c', 'a', 'b']);
  });
});
