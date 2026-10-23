import { describe, it, expect, vi } from 'vitest';
import { listEpics, assertActiveEpic } from './epics.js';
import { createTask, updateTask, bulkCreateTasks } from './tasks.js';
import { bulkUpdateTasks } from './bulk-update.js';
vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: vi.fn().mockResolvedValue('task'), resolveTaskIds: vi.fn() }));
const retired = { id: 'epic', name: 'Old work', retired_at: '2026-10-21T00:00:00Z' };
function client(responses: unknown[]) {
  let calls = 0;
  const chain: any = { then: (resolve: (x: unknown) => unknown) => Promise.resolve(responses[calls++]).then(resolve) };
  for (const method of ['select','eq','in','order','limit','single','maybeSingle','update','insert']) chain[method] = vi.fn(() => chain);
  return { from: vi.fn(() => chain), rpc: vi.fn(), chain } as any;
}
describe('epic retirement compatibility and write protection', () => {
  it.each(['42703','PGRST204'])('retries only the missing epics retired_at projection (%s)', async code => {
    const db = client([{error:{code,message:'column epics.retired_at does not exist'}}, {data:[{id:'epic',name:'Legacy'}],error:null}]);
    expect(await listEpics(db,'project')).toEqual([{id:'epic',name:'Legacy',retired_at:null}]);
    expect(db.from).toHaveBeenCalledTimes(2);
  });
  it.each([
    {code:'42501',message:'permission denied epics retired_at'},
    {code:'42703',message:'column tasks.retired_at does not exist'},
    {code:'42703',message:'column epics.other does not exist'},
    {code:'network',message:'connection lost'},
  ])('propagates other errors', async error => {
    const db=client([{error}]);
    await expect(listEpics(db,'project')).rejects.toEqual(error);
    expect(db.from).toHaveBeenCalledTimes(1);
  });
  it('propagates the fallback failure', async () => {
    const error={code:'42501',message:'denied'};
    await expect(listEpics(client([{error:{code:'42703',message:'column epics.retired_at does not exist'}},{error}]),'project')).rejects.toEqual(error);
  });
  it('names the retired epic', async () => {
    await expect(assertActiveEpic(client([{data:[retired],error:null}]),'project','epic')).rejects.toThrow('Old work" is retired');
  });
  it('refuses create before inserting', async () => {
    const db=client([{data:[retired],error:null}]);
    await expect(createTask(db,'project','user',{title:'New',epic_id:'epic'})).rejects.toThrow(/Old work.*retired/);
    expect(db.chain.insert).not.toHaveBeenCalled();
  });
  it('refuses an inherited retired epic', async () => {
    const db=client([{data:{project_id:'project',epic_id:'epic'},error:null},{data:[retired],error:null}]);
    await expect(createTask(db,'project','user',{title:'Child',parent_task_id:'parent'})).rejects.toThrow(/Old work.*retired/);
    expect(db.chain.insert).not.toHaveBeenCalled();
  });
  it('refuses changed epic on update', async () => {
    const db=client([{data:{epic_id:null},error:null},{data:[retired],error:null}]);
    await expect(updateTask(db,'project',{task_id:'task',epic_id:'epic'})).rejects.toThrow(/Old work.*retired/);
    expect(db.chain.update).not.toHaveBeenCalled();
  });
  it('permits unchanged historical association and clearing', async () => {
    const db=client([{data:{epic_id:'epic'},error:null},{data:{id:'task'},error:null}]);
    await updateTask(db,'project',{task_id:'task',epic_id:'epic'});
    expect(db.chain.update).toHaveBeenCalledWith({epic_id:'epic'});
    const clear=client([{data:{id:'task'},error:null}]);
    await updateTask(clear,'project',{task_id:'task',epic_id:null});
    expect(clear.chain.update).toHaveBeenCalledWith({epic_id:null});
  });
  it('refuses bulk update into retired epic', async () => {
    const db=client([{data:[{epic_id:null}],error:null},{data:[retired],error:null}]);
    await expect(bulkUpdateTasks(db,'project',{task_ids:['task'],epic_id:'epic'})).rejects.toThrow(/Old work.*retired/);
    expect(db.chain.update).not.toHaveBeenCalled();
  });
  it('refuses bulk create before insert', async () => {
    const db=client([{data:[],error:null},{data:[retired],error:null}]);
    await expect(bulkCreateTasks(db,'project','user',{tasks:[{title:'New',epic_id:'epic'}]})).rejects.toThrow(/Old work.*retired/);
    expect(db.chain.insert).not.toHaveBeenCalled();
  });
});
