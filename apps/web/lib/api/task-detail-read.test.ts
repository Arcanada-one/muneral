import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { taskDetailReadPort } from './task-detail-read';
import apiClient from './client';

vi.mock('./client', () => ({default: {get: vi.fn()}}));
const get=vi.mocked(apiClient.get);
const ws='11111111-1111-4111-8111-111111111111';
const project='22222222-2222-4222-8222-222222222222';
const id='33333333-3333-4333-8333-333333333333';
const selection={workspaceSlug:'own',projectSlug:'project',taskId:id};
const timestamp='2026-10-08T00:00:00Z';
const workspace={id:ws,slug:'own',name:'Own',createdAt:timestamp};
const proj={id:project,workspaceId:ws,slug:'project',name:'Project',createdAt:timestamp};
const task={id,projectId:project,title:'Permitted',description:'Private',status:'todo',priority:'medium',actorType:'human',createdAt:timestamp,updatedAt:timestamp};
let query:QueryClient;
beforeEach(()=>{get.mockReset();query=new QueryClient();});
afterEach(()=>query.clear());
const seed=()=>get.mockResolvedValueOnce({data:[workspace]}).mockResolvedValueOnce({data:[proj]}).mockResolvedValueOnce({data:task});
const httpError=(status:number)=>new AxiosError('synthetic','ERR_BAD_RESPONSE',undefined,undefined,
  {status,data:{},statusText:'synthetic',headers:{},config:{} as never});
describe('I05 existing HTTP/Query owner adapter',()=>{
  it('performs only authorized GETs, validates tuple, and keeps projection in Query',async()=>{
    seed();const port=taskDetailReadPort(query);const signal=new AbortController().signal;
    const result=await port.load(selection,signal);
    expect(result.id).toBe(id);expect(result.projectId).toBe(project);expect(port.peek(selection)).toEqual(result);
    expect(get.mock.calls.map(c=>c[0])).toEqual(['/workspaces','/projects/workspace/'+ws,'/tasks/'+id]);
    for(const call of get.mock.calls)expect(call[1]).toMatchObject({signal,skipAuthRefresh:true});
    port.clear();expect(port.peek(selection)).toBeUndefined();
  });
  it('denies unknown workspace before a task read',async()=>{
    get.mockResolvedValueOnce({data:[workspace]});
    await expect(taskDetailReadPort(query).load({...selection,workspaceSlug:'foreign'},new AbortController().signal)).rejects.toMatchObject({outcome:'denied'});
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('denies forged project workspace binding before a task read',async()=>{
    get.mockResolvedValueOnce({data:[workspace]}).mockResolvedValueOnce({data:[{...proj,workspaceId:id}]});
    await expect(taskDetailReadPort(query).load(selection,new AbortController().signal)).rejects.toMatchObject({outcome:'denied'});
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('denies a task from another project despite its valid shape and matching ID',async()=>{
    get.mockResolvedValueOnce({data:[workspace]}).mockResolvedValueOnce({data:[proj]}).mockResolvedValueOnce({data:{...task,projectId:ws}});
    await expect(taskDetailReadPort(query).load(selection,new AbortController().signal)).rejects.toMatchObject({outcome:'denied'});
    expect(taskDetailReadPort(query).peek(selection)).toBeUndefined();
  });
  it('denies duplicate slugs rather than choosing a default',async()=>{
    get.mockResolvedValueOnce({data:[workspace,workspace]});
    await expect(taskDetailReadPort(query).load(selection,new AbortController().signal)).rejects.toMatchObject({outcome:'denied'});
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('malformed task response is unavailable, never a partial task',async()=>{
    get.mockResolvedValueOnce({data:[workspace]}).mockResolvedValueOnce({data:[proj]}).mockResolvedValueOnce({data:{...task,id:13}});
    await expect(taskDetailReadPort(query).load(selection,new AbortController().signal)).rejects.toMatchObject({outcome:'unavailable',transient:false});
  });
  it.each([[401,'denied',false],[403,'denied',false],[404,'missing',false],[503,'unavailable',true]] as const)
    ('maps HTTP %i without Query retries',async(status,outcome,transient)=>{
      get.mockRejectedValueOnce(httpError(status));
      await expect(taskDetailReadPort(query).load(selection,new AbortController().signal)).rejects.toMatchObject({outcome,transient});
      expect(get).toHaveBeenCalledTimes(1);
    });
});
