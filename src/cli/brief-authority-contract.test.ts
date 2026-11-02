import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// Load the actual full CLI registry without parsing process.argv or contacting a board.
vi.spyOn(Command.prototype, 'parse').mockImplementation(function (this: Command) { return this; });
await import('./index.js');

function commandPaths(command: Command, prefix = ''): string[] {
  return command.commands.flatMap((child) => {
    const path = `${prefix} ${child.name()}`.trim();
    return [path, ...commandPaths(child, path)];
  });
}
describe('B-1364 CLI authority contract', () => {
  it('registers brief history only, with no brief resolve or reshape command', () => {
    const program = vi.mocked(Command.prototype.parse).mock.instances[0];
    const paths = commandPaths(program);
    expect(paths.filter((path) => path.startsWith('briefs'))).toEqual(['briefs', 'briefs list']);
    // Any future resolution/reshape command must call the guarded shared handler with ctx.userId.
    expect(paths.filter((path) => /(^| )(resolve|reshape|resolve_brief|reshape_brief)$/.test(path))).toEqual(['figma working-file resolve', 'agent resolve']);
  });
});
