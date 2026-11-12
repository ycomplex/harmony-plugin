// B-1410 — `harmony criteria carry|drop`: exit 0 settled, 1 refused, 2 unavailable; human output
// prints the refusal sentence or the unavailable message plainly; --json prints the result.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCriteriaCommands } from './criteria.js';
import { SETTLE_UNAVAILABLE_MESSAGE } from '../../tools/settle-criteria.js';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock('../../tools/resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_c: unknown, _p: string, input: string) => `uuid-of-${input}`),
}));

let rpcResult: { data: unknown; error: unknown };
let rpc: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  rpc = vi.fn(async () => rpcResult);
  mocks.auth.mockResolvedValue({ client: { rpc, from: vi.fn() }, projectId: 'p', userId: 'u' });
});

async function run(argv: string[], globalJson = false) {
  const program = new Command().option('--json');
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerCriteriaCommands(program);
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  let code: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error(`exit:${code}`);
  }) as any);
  try {
    await program.parseAsync([...(globalJson ? ['--json'] : []), ...argv], { from: 'user' });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('exit:')) throw e;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const carried = {
  settlement_id: 's', action: 'carried', source_task_id: 'a', destination_task_id: 'uuid-of-B-12',
  destination_minted: false, destination_criterion_id: 'c', already_settled: false,
};

describe('harmony criteria', () => {
  it('carry --to exits 0 and names the destination', async () => {
    rpcResult = { data: carried, error: null };
    const r = await run(['criteria', 'carry', 'crit-1', '--to', 'B-12']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Carried the criterion to B-12');
    expect(rpc).toHaveBeenCalledWith('settle_acceptance_criterion', expect.objectContaining({
      p_criterion_id: 'crit-1', p_action: 'carry', p_destination_task_id: 'uuid-of-B-12',
    }));
  });

  it('carry --new maps title, milestone and reason to the mint', async () => {
    rpcResult = { data: { ...carried, destination_minted: true }, error: null };
    const r = await run(['criteria', 'carry', 'crit-1', '--new', '--title', 'Follow-on', '--milestone', 'source', '--reason', 'needed']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('new ticket');
    expect(rpc).toHaveBeenCalledWith('settle_acceptance_criterion', expect.objectContaining({
      p_mint_title: 'Follow-on', p_mint_milestone: 'source', p_landing_reason: 'needed',
    }));
  });

  it('drop exits 1 on a refusal and prints the sentence plainly', async () => {
    rpcResult = { data: null, error: { code: 'P0001', message: 'settle refused: last-criterion: The last remaining criterion cannot be dropped.' } };
    const r = await run(['criteria', 'drop', 'crit-1', '--reason', 'gone']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('The last remaining criterion cannot be dropped.');
  });

  it('exits 2 when the function is unavailable and prints the message', async () => {
    rpcResult = { data: null, error: { code: '42883', message: 'function does not exist' } };
    const r = await run(['criteria', 'drop', 'crit-1', '--reason', 'gone']);
    expect(r.code).toBe(2);
    expect(r.err).toContain(SETTLE_UNAVAILABLE_MESSAGE);
  });

  it('--json prints the structured result, after the subcommand or globally, with the same exit codes', async () => {
    rpcResult = { data: null, error: { code: '42883', message: 'function does not exist' } };
    const local = await run(['criteria', 'drop', 'crit-1', '--reason', 'gone', '--json']);
    expect(local.code).toBe(2);
    expect(JSON.parse(local.out)).toEqual({ status: 'unavailable', message: SETTLE_UNAVAILABLE_MESSAGE });

    rpcResult = { data: carried, error: null };
    const global = await run(['criteria', 'carry', 'crit-1', '--to', 'B-12'], true);
    expect(global.code).toBe(0);
    expect(JSON.parse(global.out)).toMatchObject({ status: 'settled', action: 'carried' });
  });

  it('carry needs exactly one of --to or --new', async () => {
    const r = await run(['criteria', 'carry', 'crit-1']);
    expect(r.code).toBe(1);
    expect(rpc).not.toHaveBeenCalled();
  });
});
