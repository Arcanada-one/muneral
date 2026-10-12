import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TasksService} from '../dist/tasks/tasks.service.js';
const row={id:randomUUID(),projectId:randomUUID(),status:'todo',priority:'high',createdAt:new Date(),updatedAt:new Date()};
const cases=[{id:'INVALID_PRIVATE_VALUE'},{projectId:'INVALID_PRIVATE_VALUE'},{status:'INVALID_PRIVATE_VALUE'},{priority:'INVALID_PRIVATE_VALUE'},{description:'INVALID_PRIVATE_VALUE'},{createdAt:new Date(NaN)},{updatedAt:'INVALID_PRIVATE_VALUE'}];
let passed=0;
async function check(rows,total,dto,refused){let audits=0;const tx={task:{findMany:async()=>rows,count:async()=>total},activityLog:{create:async()=>{audits++;return{id:randomUUID(),createdAt:new Date()};}}};const service=new TasksService({$transaction:async fn=>fn(tx)},null,null,null,null);let result,error;try{result=await service.digestForWorkspace(randomUUID(),randomUUID(),{decision:'SYNTHETIC',until:'2099-01-01T00:00:00Z'},dto);}catch(e){error=e;}if(refused){assert(error);assert(!String(error).includes('INVALID_PRIVATE_VALUE'));assert.equal(audits,0);}else{assert(!error);assert.equal(audits,1);assert.equal(Object.keys(result.items[0]).length,7);assert.equal(result.items[0].title,'[Title withheld: emergency metadata-only digest]');}passed++;}
await check([row],1,{},false);
for(const mutation of cases)await check([{...row,...mutation}],1,{},true);
for(const count of [-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,0])await check([row],count,{},true);
for(const dto of [{limit:0},{limit:201},{limit:1.5},{offset:-1},{offset:Number.MAX_SAFE_INTEGER+1}])await check([row],1,dto,true);
console.log(JSON.stringify({passed,synthetic_adapter_only:true,no_invalid_values_reflected:true,no_success_audit_on_refusal:true}));
