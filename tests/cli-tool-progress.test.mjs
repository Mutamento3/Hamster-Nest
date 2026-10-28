import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
const owner='11111111-1111-4111-8111-111111111111', task='22222222-2222-4222-8222-222222222222',
  reply='33333333-3333-4333-8333-333333333333', session='44444444-4444-4444-8444-444444444444',
  user='55555555-5555-4555-8555-555555555555', command='66666666-6666-4666-8666-666666666666',
  started='2026-10-28T09:00:00.000Z'
const snapshot=(sequence=1)=>({sequence,finished:false,truncated:false,calls:[{id:'a'.repeat(24),name:'mcp__hamster-mcp__read_todos',status:'running',started_at:started}]})
async function fixture(sender='claude_cli') {
 const db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table agent_tasks(id uuid primary key,user_id uuid,source text,status text,executor text,started_at timestamptz,payload_json jsonb);
 create table messages(id uuid primary key,user_id uuid,session_id uuid,reply_to_id uuid,sender_key text,role text,content text default '',meta jsonb);
 create table agent_events(id bigserial primary key,user_id uuid,actor text,event_type text,entity_type text,entity_id uuid,title text,payload jsonb,importance text);
 create unique index reply_event on agent_events(user_id,event_type,entity_id) where event_type='conversation_reply_completed' and entity_id is not null;
 grant select,update on agent_tasks,messages to service_role;
 alter table messages enable row level security;
 create policy owner_read on messages for select to authenticated using(user_id='${owner}');grant select on messages to authenticated;
 `)
 await db.query('insert into agent_tasks values($1,$2,$3,$4,$5,$6,$7)',[task,owner,'conversation_dispatch','running',sender==='claude_cli'?'claude_code_cli':'codex_cli',started,JSON.stringify({session_id:session,reply_id:reply,user_message_id:user,command_id:command,responder_sender_key:sender})])
 await db.query('insert into messages(id,user_id,session_id,reply_to_id,sender_key,role,meta) values($1,$2,$3,$4,$5,$6,$7)',[reply,owner,session,user,sender,'assistant',JSON.stringify({delivery_state:'generating',agent_task_id:task,command_id:command,lounge:true,retained:'yes'})])
 await db.exec(readFileSync(new URL('../supabase/migrations/20261028093732_cli_tool_progress.sql',import.meta.url),'utf8'))
 const original=readFileSync(new URL('../supabase/migrations/20260728131144_v4_1_conversation_cli_durable_tasks.sql',import.meta.url),'utf8')
 await db.exec(original.slice(original.indexOf('create or replace function public.conversation_dispatch_complete_reply('),original.indexOf('revoke all on function public.conversation_dispatch_complete_reply(')))
 const rpc=async(value=snapshot(),who=owner,start=started)=>(await db.query('select conversation_cli_tool_progress($1,$2,$3,$4) ok',[who,task,start,JSON.stringify(value)])).rows[0].ok
 const read=async()=>(await db.query('select * from messages where id=$1',[reply])).rows[0]
 return {db,rpc,read}
}
test('atomic allowlisted snapshot preserves metadata and completion keeps the tool history',async()=>{
 const f=await fixture();try{
  const input=snapshot();input.calls[0].arguments={secret:'NEVER_STORE'};input.calls[0].result='NEVER_STORE'
  assert.equal(await f.rpc(input),true)
  let row=await f.read();assert.equal(row.content,'');assert.equal(row.meta.retained,'yes');assert.ok(!JSON.stringify(row).includes('NEVER_STORE'))
  assert.equal((await f.db.query('select count(*)::int n from agent_events')).rows[0].n,0)
  const final=snapshot(2);final.finished=true;final.calls[0].status='done';final.calls[0].ended_at=started;await f.rpc(final)
  await f.db.exec("update agent_tasks set status='completed'")
  await f.db.query('select conversation_dispatch_complete_reply($1,$2,$3,$4)',[owner,task,'完成',started])
  row=await f.read();assert.equal(row.meta.tool_progress.calls[0].status,'done');assert.equal(row.meta.delivery_state,'completed');assert.equal(row.content,'完成')
  assert.equal(await f.rpc(snapshot(3)),false)
 }finally{await f.db.close()}
})
test('wrong owner, sender, task identity, command and attempt cannot update a reply',async()=>{
 const f=await fixture();try{
  assert.equal(await f.rpc(snapshot(),user),false)
  assert.equal(await f.rpc(snapshot(),owner,'2026-10-28T08:59:00Z'),false)
  for(const change of ["sender_key='codex_cli'",`meta=meta||'{"agent_task_id":"${user}"}'`,`meta=meta||'{"command_id":"${user}"}'`,"meta=meta||'{\"delivery_state\":\"failed\"}'"]){
   await f.db.exec('begin');try{await f.db.exec(`update messages set ${change}`);assert.equal(await f.rpc(),false)}finally{await f.db.exec('rollback')}
  }
  assert.equal((await f.read()).meta.tool_progress,undefined)
 }finally{await f.db.close()}
})
test('out of order and duplicate snapshots cannot regress; retry replaces previous attempt',async()=>{
 const f=await fixture();try{
  assert.equal(await f.rpc(snapshot(3)),true);assert.equal(await f.rpc(snapshot(2)),false);assert.equal(await f.rpc(snapshot(3)),false)
  const final=snapshot(4);final.finished=true;final.calls[0].status='unknown';final.calls[0].ended_at=started;assert.equal(await f.rpc(final),true)
  assert.equal(await f.rpc(snapshot(5)),false)
  const next='2026-10-28T09:10:00Z';await f.db.query('update agent_tasks set started_at=$1',[next]);await f.db.exec("update messages set meta=meta||'{\"delivery_attempt\":2}'")
  assert.equal(await f.rpc(snapshot(6)),false);assert.equal(await f.rpc({sequence:1,finished:false,truncated:false,calls:[]},owner,next),true)
  assert.equal((await f.read()).meta.tool_progress.delivery_attempt,'2');assert.deepEqual((await f.read()).meta.tool_progress.calls,[])
 }finally{await f.db.close()}
})
test('bounded validation rejects malformed snapshots and clients cannot invoke writer',async()=>{
 const f=await fixture();try{
  for(const value of [null,{}, {...snapshot(),sequence:0},{...snapshot(),calls:Array(65).fill(snapshot().calls[0])},{...snapshot(),finished:true},{...snapshot(),calls:[{...snapshot().calls[0],name:'bad name'}]}])await assert.rejects(f.rpc(value))
  await f.db.exec('set role authenticated');await assert.rejects(f.rpc(),/permission denied/);await f.db.exec('reset role')
  await f.db.exec('set role anon');await assert.rejects(f.rpc(),/permission denied/);await f.db.exec('reset role')
  await f.db.exec('set role service_role');assert.equal(await f.rpc(),true)
 }finally{await f.db.close()}
})
test('both canonical Codex identities work with the same group/direct contract',async()=>{
 for(const sender of ['codex_cli','syzygy_cli']){const f=await fixture(sender);try{assert.equal(await f.rpc(),true)}finally{await f.db.close()}}
})
