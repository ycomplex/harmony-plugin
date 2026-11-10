// B-1400: the MCP surface. handleToolCall passes `request.params.arguments` through unvalidated, so
// these prove an unknown argument comes back as an `Error:` tool result naming the key verbatim,
// with no client call — not a silent success and not a rewritten "Not found" / access message.
import { describe, it, expect, vi } from 'vitest';
import { handleToolCall } from './index.js';

function makeClient() {
  return { from: vi.fn(), rpc: vi.fn() } as any;
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n');
}

describe('MCP handleToolCall refuses unknown arguments (B-1400)', () => {
  it('create_task with acceptance_criteria is an error naming the key, with the hint', async () => {
    const client = makeClient();
    const result: any = await handleToolCall('create_task', { title: 'x', acceptance_criteria: ['a'] }, client, 'p', 'u');

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith('Error: ')).toBe(true);
    expect(text).toContain('acceptance_criteria');
    expect(text).toContain('create_task does not accept: acceptance_criteria.');
    expect(text).toContain('manage_acceptance_criteria with add: [{ content }]');
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('manage_acceptance_criteria with items is an error naming the key', async () => {
    const client = makeClient();
    const result: any = await handleToolCall('manage_acceptance_criteria', { task_id: 'B-1', items: [] }, client, 'p', 'u');

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith('Error: ')).toBe(true);
    expect(text).toContain('items');
    expect(text).toContain('manage_acceptance_criteria does not accept: items.');
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
