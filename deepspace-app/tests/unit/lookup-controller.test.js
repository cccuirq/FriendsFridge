import {it,expect} from 'vitest';
import {createLookupController,expiryDelay,QUOTE_TTL} from '../../public/legacy/js/pages/recipes/lookup-controller.js';
const path='/api/recipes/shopping/quote',body={servings:2,budget_cents:100};
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)}};
it('replays a lost POST with the same receipt across reloads',async()=>{
 const s=storage(),ids=[];
 const first=createLookupController({storage:s,owner:()=> 'a',uuid:()=> 'original',api:async(p,m,b)=>{ids.push(b.request_id);throw new Error('offline')}});
 await expect(first.run(path,body)).rejects.toMatchObject({canResume:true});
 const second=createLookupController({storage:s,owner:()=> 'a',uuid:()=> 'wrong',api:async(p,m,b)=>{ids.push(b.request_id);return {status:'complete'}}});
 await second.run(path,body);expect(ids).toEqual(['original','original']);expect(second.hasPending(path,body)).toBe(false);
});
it('resumes a pending job with GET and never starts another actor',async()=>{
 const s=storage(),calls=[];let active=false;
 const controller=createLookupController({storage:s,owner:()=> 'a',uuid:()=> 'one',wait:async()=>{},api:async(p,m)=>{calls.push([p,m]);return m==='POST'?{status:'pending',job_id:'job'}:{status:'complete'}}});
 expect(await controller.run(path,body,()=>active)).toBeNull();active=true;
 await controller.run(path,body);expect(calls).toEqual([[path,'POST'],['/api/recipes/shopping/jobs/job',undefined]]);
});
it('separates owners and clears terminal receipts but preserves transient failures',async()=>{
 let owner='a';const controller=createLookupController({storage:storage(),owner:()=>owner,api:async()=>{throw Object.assign(new Error('failed'),{code:'LOOKUP_FAILED',status:503})}});
 await expect(controller.run(path,body)).rejects.toMatchObject({canResume:false});expect(controller.hasPending(path,body)).toBe(false);
 owner='b';expect(controller.hasPending(path,body)).toBe(false);
});
it('expires quotes at their original checked time',()=>{
 expect(expiryDelay('2026-11-21T00:00:00Z',Date.parse('2026-11-21T00:00:00Z'))).toBe(QUOTE_TTL);
 expect(expiryDelay('2026-11-21T00:00:00Z',Date.parse('2026-11-21T01:00:00Z'))).toBe(0);
});

it('does not crash on corrupted local receipts',async()=>{
 const controller=createLookupController({storage:{getItem:()=> 'null',setItem:()=>{}},owner:()=> 'a',api:async()=>({status:'complete'})});
 expect(controller.hasPending(path,body)).toBe(false);await expect(controller.run(path,body)).resolves.toMatchObject({status:'complete'});
});
it('keeps a late job receipt under its original owner',async()=>{
 const s=storage();let owner='a';
 const controller=createLookupController({storage:s,owner:()=>owner,wait:async()=>{},api:async()=>{owner='b';return {status:'pending',job_id:'a-job'}}});
 await controller.run(path,body,()=>false);expect(controller.hasPending(path,body)).toBe(false);
 owner='a';expect(controller.hasPending(path,body)).toBe(true);
});
