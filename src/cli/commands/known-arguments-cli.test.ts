// B-1400: the CLI surface. The CLI calls the same handlers as the MCP server, so the unknown-argument
// check runs here too. These drive the REAL createTask / manageAcceptanceCriteria handlers through
// commander with a mock Supabase client and prove the keys the CLI passes (unset flags arrive as
// `undefined`) never trip the check, and that commander itself rejects an unknown flag.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerTaskCommands } from './tasks.js';
import { registerAcceptanceCriteriaCommands } from './acceptance-criteria.js';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock('../../tools/resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('task-uuid'),
  resolveTaskIds: vi.fn(),
}));

type Call = { table: string; method: string; args: unknown[] };

// A chainable mock client: every builder method records itself and returns the builder; awaiting
// the builder resolves to a list, `.single()` to one row.
function makeClient() {
  const calls: Call[] = [];
  const row = { id: 'row-1', task_number: 7, title: 'X', project_id: 'p' };
  const client = {
    from: vi.fn((table: string) => {
      const builder: any = new Proxy({}, {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve({ data: [row], error: null });
          }
          if (prop === 'single') {
            return (...args: unknown[]) => {
              calls.push({ table, method: 'single', args });
              return Promise.resolve({ data: row, error: null });
            };
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: prop, args });
            return builder;
          };
        },
      });
      return builder;
    }),
  };
  return { client, calls };
}

function makeProgram() {
  const program = new Command().option('--json');
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerTaskCommands(program);
  registerAcceptanceCriteriaCommands(program);
  return program;
}

let current: ReturnType<typeof makeClient>;
beforeEach(() => {
  vi.clearAllMocks();
  current = makeClient();
  mocks.auth.mockResolvedValue({ client: current.client, projectId: 'p', userId: 'u' });
});

async function run(argv: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}): ${err.mock.calls.map((c) => c.join(' ')).join(' | ')}`);
  }) as any);
  try {
    await makeProgram().parseAsync(['--json', ...argv], { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    exit.mockRestore();
  }
}

const methods = (table: string) => current.calls.filter((c) => c.table === table).map((c) => c.method);

describe('CLI passes only schema keys to the guarded handlers (B-1400)', () => {
  it('tasks create --title X reaches the client insert', async () => {
    await run(['tasks', 'create', '--title', 'X']);
    const insert = current.calls.find((c) => c.table === 'tasks' && c.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ title: 'X', project_id: 'p', created_by: 'u' });
  });

  it('tasks create with every flag set reaches the client insert', async () => {
    await run([
      'tasks', 'create', '--title', 'X', '--status', 'To Do', '--priority', 'high', '--description', 'd',
      '--due', '2026-12-01', '--cycle', 'c', '--milestone', 'm',
    ]);
    expect(methods('tasks')).toContain('insert');
  });

  it('ac add <id> --desc a reaches the client insert', async () => {
    await run(['ac', 'add', 'B-1', '--desc', 'a']);
    const insert = current.calls.find((c) => c.table === 'acceptance_criteria' && c.method === 'insert');
    expect(insert?.args[0]).toEqual([expect.objectContaining({ content: 'a', task_id: 'task-uuid', checked: false })]);
  });

  it('ac update <id> --id <uuid> --met reaches the client update', async () => {
    await run(['ac', 'update', 'B-1', '--id', '11111111-1111-1111-1111-111111111111', '--met']);
    const update = current.calls.find((c) => c.table === 'acceptance_criteria' && c.method === 'update');
    expect(update?.args[0]).toEqual({ checked: true });
  });

  it('ac delete <id> --id <uuid> reaches the client delete', async () => {
    await run(['ac', 'delete', 'B-1', '--id', '11111111-1111-1111-1111-111111111111']);
    expect(methods('acceptance_criteria')).toContain('delete');
    const inCall = current.calls.find((c) => c.table === 'acceptance_criteria' && c.method === 'in');
    expect(inCall?.args).toEqual(['id', ['11111111-1111-1111-1111-111111111111']]);
  });

  it('commander rejects an unknown flag on tasks create before any handler runs', async () => {
    await expect(run(['tasks', 'create', '--title', 'X', '--acceptance-criteria', 'y'])).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(current.client.from).not.toHaveBeenCalled();
  });
});
