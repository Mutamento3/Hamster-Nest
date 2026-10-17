import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { healthSyncHandler } from '../supabase/functions/health-sync/handler.ts'
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const migration=readFileSync(new URL('../supabase/migrations/20261017123650_health_steps_consent.sql',import.meta.url),'utf8');
const snapshot=(time=Date.now()-10000,steps=100)=>{
 const day=new Date(time+8*3600000).toISOString().slice(0,10),start=Date.parse(day+'T00:00:00+08:00');
 return {version:1,owner,source:'healthkit',timezone:'Asia/Shanghai',sampleId:crypto.randomUUID(),collectedAt:new Date(time).toISOString(),days:Array.from({length:7},(_,i)=>{const at=start-i*86400000;return {date:new Date(at+8*3600000).toISOString().slice(0,10),startAt:new Date(at).toISOString(),endAt:new Date(at+86400000).toISOString(),steps,availability:steps===null?'unavailable':'available'}})};
};
async function setup(){
 const db=new PGlite();await db.exec(`create schema auth; create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;insert into auth.users values('${owner}'),('${other}');`);await db.exec(migration);
 const call=async(action,revision=null,mode=null,snap=null,user=owner)=>(await db.query('select public.health_steps_gateway($1,$2,$3,$4,$5) v',[user,action,revision,mode,snap])).rows[0].v;
 return {db,call};
}
test('health consent defaults off; cloud-only and AI share exactly one typed snapshot; unavailable is not zero',async()=>{
 const {db,call}=await setup();try{
 assert.equal((await call('read')).mode,'local');assert.equal((await call('ai_read')).snapshot,null);
 await assert.rejects(call('upload',0,null,snapshot()),/consent changed/);
 const c=await call('consent',0,'cloud');const s=snapshot(Date.now()-10000,0);s.days[1].steps=null;s.days[1].availability='unavailable';
 const uploaded=await call('upload',c.consentVersion,null,s);assert.equal(uploaded.snapshot.days[0].steps,0);assert.equal(uploaded.snapshot.days[1].steps,null);
 assert.equal((await call('ai_read')).snapshot,null);await call('consent',1,'ai');
 assert.deepEqual((await call('ai_read')).snapshot,(await call('read')).snapshot);
 assert.equal((await call('read',null,null,null,other)).snapshot,null);
 }finally{await db.close()}
});
test('idempotent capture, backwards correction, deletion, late replay and revoke generation',async()=>{
 const {db,call}=await setup();try{
 await call('consent',0,'ai');const s=snapshot();const a=await call('upload',1,null,s);assert.equal((await call('upload',1,null,s)).snapshot.dataVersion,a.snapshot.dataVersion);
 await assert.rejects(call('upload',1,null,{...s,days:s.days.map(d=>({...d,steps:90}))}),/sample conflict/);
 const correction=snapshot(Date.parse(s.collectedAt)+1000,5);assert.equal((await call('upload',1,null,correction)).snapshot.days[0].steps,5);
 assert.equal((await call('upload',1,null,s)).snapshot.days[0].steps,5);
 const deletion=snapshot(Date.parse(s.collectedAt)+2000,null);assert.equal((await call('upload',1,null,deletion)).snapshot.days[0].steps,null);
 await call('consent',1,'paused');assert.equal((await call('ai_read')).snapshot,null);await assert.rejects(call('upload',1,null,s),/consent changed/);
 await call('consent',2,'local');assert.equal((await call('read')).snapshot,null);assert.equal((await db.query('select count(*) n from health_daily_steps')).rows[0].n,0);
 await call('consent',3,'ai');await assert.rejects(call('upload',1,null,s),/consent changed/);await assert.rejects(call('consent',1,'cloud'),/consent changed/);
 }finally{await db.close()}
});
test('invalid/foreign/day-window/fractional data rejects whole batch; client SQL roles cannot bypass consent',async()=>{
 const {db,call}=await setup();try{
 await call('consent',0,'cloud');
 for(const modify of [s=>({...s,owner:other}),s=>({...s,timezone:'UTC'}),s=>({...s,days:s.days.slice(0,6)}),s=>({...s,days:s.days.map(d=>({...d,steps:1.2}))}),s=>({...s,days:s.days.map(d=>({...d,steps:null}))}),s=>({...s,days:s.days.map(d=>({...d,startAt:d.endAt}))}),s=>({...s,days:[s.days[0],...s.days.slice(0,6)]})])await assert.rejects(call('upload',1,null,modify(snapshot())));
 assert.equal((await call('read')).snapshot,null);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from public.health_daily_steps'),/permission denied/);await assert.rejects(call('read'),/permission denied/);await db.exec('reset role');
 }finally{await db.close()}
});
test('HTTP identity and action are verified before invoking service-only RPC; MCP-only action is blocked',async()=>{
 let calls=0;const handler=healthSyncHandler({owner,allowedOrigin:o=>o==='https://app.test',verify:async()=>({ok:true,userId:owner}),client:{rpc:async()=>{calls++;return {data:{ok:true},error:null}}}});
 const req=(body,headers={})=>new Request('https://test',{method:'POST',headers:{authorization:'Bearer test',apikey:'public',...headers},body:JSON.stringify(body)});
 assert.equal((await handler(req({owner,action:'ai_read'}))).status,400);assert.equal((await handler(req({owner:other,action:'read'}))).status,400);assert.equal((await handler(req({owner,action:'read'},{origin:'https://evil.test'}))).status,403);assert.equal(calls,0);
 assert.equal((await handler(req({owner,action:'read'}))).status,200);assert.equal(calls,1);
});
