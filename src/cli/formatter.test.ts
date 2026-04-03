import { describe, it, expect } from 'vitest';
import { formatTable, formatDetail, formatOutput } from './formatter.js';

describe('formatOutput', () => {
  it('returns JSON string when json=true', () => {
    const data = { id: '1', title: 'Test' };
    const result = formatOutput(data, { json: true });
    expect(result).toBe(JSON.stringify(data, null, 2));
  });
});

describe('formatTable', () => {
  it('formats an array of objects as a table string', () => {
    const data = [
      { id: '1', title: 'Task A', status: 'To Do' },
      { id: '2', title: 'Task B', status: 'Done' },
    ];
    const result = formatTable(data, [
      { key: 'id', header: 'ID' },
      { key: 'title', header: 'Title' },
      { key: 'status', header: 'Status' },
    ]);
    expect(result).toContain('Task A');
    expect(result).toContain('Task B');
    expect(result).toContain('To Do');
    expect(result).toContain('Done');
    expect(result).toContain('ID');
    expect(result).toContain('Title');
  });

  it('returns "No results." for empty array', () => {
    const result = formatTable([], [{ key: 'id', header: 'ID' }]);
    expect(result).toBe('No results.');
  });
});

describe('formatDetail', () => {
  it('formats key-value pairs vertically', () => {
    const result = formatDetail([
      { label: 'Title', value: 'My Task' },
      { label: 'Status', value: 'In Progress' },
    ]);
    expect(result).toContain('Title');
    expect(result).toContain('My Task');
    expect(result).toContain('Status');
    expect(result).toContain('In Progress');
  });

  it('handles null/undefined values as empty string', () => {
    const result = formatDetail([
      { label: 'Due', value: null },
    ]);
    expect(result).toContain('Due');
  });
});
