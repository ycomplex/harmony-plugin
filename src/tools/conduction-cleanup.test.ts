import { describe, it, expect, vi } from 'vitest';
import { createConductionCleanup, type CleanupClaim } from './conduction-cleanup.js';

describe('feature-detected cleanup adapter', () => {
  it('skips only missing helpers; auth/network errors propagate', async () => {
    const rpc=vi.fn().mockResolvedValueOnce({error:{code:'PGRST202',message:'list_conduction_cleanup absent'}})
      .mockResolvedValueOnce({error:new Error('network')});
    const api=createConductionCleanup({rpc} as never,'project','holder',300000);
    expect(await api.list()).toBeNull();
    await expect(api.list()).rejects.toThrow('network');
  });
  it('carries the exact token and worker identity into guarded finalization', async () => {
    const row={id:'run',updated_at:'2026-11-02T12:00:00Z',worker_ref:'exact-job',leg_started_at:'2026-11-02T11:00:00Z',cleanup_token:'token'} as CleanupClaim;
    const rpc=vi.fn().mockResolvedValueOnce({data:[row]}).mockResolvedValueOnce({data:true});
    const api=createConductionCleanup({rpc} as never,'project','holder',300000);
    const claimed=await api.claim(row);
    expect(claimed).toEqual(row);
    expect(await api.finish(claimed!)).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith('finish_conduction_cleanup',{
      p_id:'run',p_token:'token',p_holder:'holder',p_worker_ref:'exact-job',p_leg_started_at:'2026-11-02T11:00:00Z',p_error:null,
    });
  });
});
