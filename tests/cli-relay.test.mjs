import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const owner = '11111111-1111-4111-8111-111111111111'
const task = '22222222-2222-4222-8222-222222222222'
const roles = { codex_cli_syzygy: { enabled: true }, claude_code_cli_syzygy: { enabled: true } }
const schema = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql as 'select null::uuid';
create table auth.users(id uuid primary key);
create table public.agent_tasks(id uuid primary key default gen_random_uuid(),user_id uuid, executor text, status text,result_summary text, payload_json jsonb default '{}',completed_at timestamptz,error text);
create table public.syzygy_commands(id uuid primary key default gen_random_uuid(),user_id uuid,command_type text,status text,idempotency_key text,payload jsonb,completed_at timestamptz,error_message text);
create unique index command_key on public.syzygy_commands(user_id,idempotency_key) where idempotency_key is not null;
create table public.prompt_templates(user_id uuid,name text,active boolean,content text);
create table public.sessions(id uuid primary key,user_id uuid,conversation_kind text,conversation_profile_key text,handler text,session_key text,is_archived boolean default false);
create table public.messages(id uuid primary key default gen_random_uuid(),content text,client_id uuid,client_created_at timestamptz,meta jsonb,user_id uuid,role text,created_at timestamptz,session_id uuid default '55555555-5555-4555-8555-555555555555',sender_key text default 'chuanchuan',target_sender_keys text[] default '{}');
insert into sessions(id,user_id,conversation_kind,conversation_profile_key,handler) values('55555555-5555-4555-8555-555555555555','${owner}','direct','codex_cli','cli');
create table public.diary_entries(id uuid primary key default gen_random_uuid(),user_id uuid,author text,entry_date date default '2026-09-29',activity_type text,visibility text default 'private',metadata jsonb default '{}',title text,content text);
create table public.agent_events(id bigserial primary key,user_id uuid,actor text,event_type text,entity_type text,entity_id uuid,title text,payload jsonb,importance text);
create table public.test_clock(value timestamptz);
insert into test_clock values('2026-09-29T14:00:00+08:00');
create function public.test_now() returns timestamptz language sql stable as 'select value from public.test_clock';
insert into auth.users values('${owner}');
insert into agent_tasks(id,user_id,status,payload_json) values('${task}','${owner}','running','{"target_role":"codex_cli_syzygy"}');
`

async function fixture() {
  const db = new PGlite()
  await db.exec(schema)
  // Substitute only the clock so boundary cases are deterministic on every CI date.
  const sql = readFileSync(new URL('../supabase/migrations/20260929075337_cli_free_activity.sql', import.meta.url), 'utf8')
    .replaceAll('now()', 'public.test_now()')
  await db.exec(sql)
  await db.exec(readFileSync(new URL('../supabase/migrations/20261005114642_cli_activity_dispatch_boundaries.sql', import.meta.url), 'utf8').replaceAll('now()', 'public.test_now()'))
  await db.exec(readFileSync(new URL('../supabase/migrations/20261028073454_cli_relay_activity.sql', import.meta.url), 'utf8').replaceAll('now()', 'public.test_now()'))
  await db.exec(readFileSync(new URL('../supabase/migrations/20261028090941_cli_relay_chat_schedule.sql', import.meta.url), 'utf8').replaceAll('now()', 'public.test_now()'))
  await db.exec(`insert into sessions(id,user_id,conversation_kind,conversation_profile_key,handler,session_key) values('66666666-6666-4666-8666-666666666666','${owner}','direct','claude_cli','cli','syzygy_claude_cli')`)
  const query = async (sql, args = []) => (await db.query(sql, args)).rows
  const rpc = async (name, args) => (await query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args))[0].result
  const plan = () => rpc('cli_wake_plan_day', [owner, '2026-09-29'])
  const tick = (enabled = roles, paused = false) => rpc('cli_wake_dispatch', [owner, JSON.stringify(enabled), paused])
  await rpc('cli_activity_set_mode', [owner, 'relay'])
  return { db, query, rpc, plan, tick }
}

const claude = 'claude_code_cli_syzygy'
const chatTask = '88888888-8888-4888-8888-888888888888'
async function privateChat(f) {
  await f.query("insert into agent_tasks(id,user_id,executor,status,payload_json) values($1,$2,'claude_code_cli','running',$3)",
    [chatTask,owner,JSON.stringify({target_role:claude,source:'conversation_dispatch',task_type:'conversation_message',session_id:'66666666-6666-4666-8666-666666666666'})])
}

test('private chat replaces one planned relay in place; retries and ticks do not duplicate it',async()=>{
 const f=await fixture();try{
  await f.tick();await privateChat(f)
  const [old]=await f.query("select * from cli_wake_schedule where kind='relay'")
  const schedule=()=>f.rpc('cli_set_self_alarm',[owner,chatTask,'2026-09-29T18:40:00+08:00','晚点见'])
  const first=await schedule();assert.equal(first.ok,true);assert.equal(first.wake_id,old.id)
  assert.equal((await schedule()).wake_id,first.wake_id);await f.tick()
  const rows=await f.query("select * from cli_wake_schedule where kind='relay'")
  assert.equal(rows.length,1);assert.equal(rows[0].decision_source,'model');assert.equal(rows[0].created_by_task_id,chatTask)
  assert.equal(Date.parse(rows[0].wake_at),Date.parse('2026-09-29T18:40:00+08:00'))
 }finally{await f.db.close()}
})
test('private chat retires an already queued command and the replacement gets a fresh dispatch identity',async()=>{
 const f=await fixture();try{
  await f.tick();await f.db.exec("update cli_wake_schedule set wake_at=public.test_now() where kind='relay'; update cli_wake_schedule set status='skipped' where kind='random'");await f.tick();await privateChat(f)
  const [old]=await f.query("select * from cli_wake_schedule where kind='relay'")
  assert.equal(old.status,'queued')
  const next=await f.rpc('cli_set_self_alarm',[owner,chatTask,'2026-09-29T18:40:00+08:00','改约'])
  assert.equal(next.ok,true);assert.notEqual(next.wake_id,old.id)
  assert.equal((await f.query('select status from syzygy_commands where id=$1',[old.command_id]))[0].status,'failed')
  assert.equal(await f.rpc('cli_wake_dispatch',[owner,JSON.stringify(roles),false,old.id,old.command_id,chatTask]),null)
  await f.db.exec("update test_clock set value='2026-09-29T18:40:00+08:00'");await f.tick()
  const [queued]=await f.query('select * from cli_wake_schedule where id=$1',[next.wake_id])
  assert.equal(queued.status,'queued');assert.notEqual(queued.command_id,old.command_id)
  assert.equal((await f.query('select status from syzygy_commands where id=$1',[queued.command_id]))[0].status,'pending')
 }finally{await f.db.close()}
})
test('private chat can reserve before the first tick, and can close a day before any round exists',async()=>{
 const f=await fixture();try{
  await privateChat(f)
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,chatTask,'2026-09-29T18:40:00+08:00',''])).ok,true)
  await f.db.exec('delete from cli_wake_schedule')
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,chatTask,null,'今天休息'])).day_closed,true)
  const reopen=await f.rpc('cli_set_self_alarm',[owner,chatTask,'2026-09-29T18:40:00+08:00',''])
  assert.equal(reopen.ok,false);assert.equal(reopen.reason,'day_closed');await f.tick()
  assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay' and status='planned'"))[0].n,0)
  await f.db.exec("update test_clock set value='2026-09-30T09:00:00+08:00'");await f.tick()
  assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay' and status='planned'"))[0].n,1)
 }finally{await f.db.close()}
})
test('private-chat close_day cancels the next queued wake and preserves the running activity boundary',async()=>{
 const f=await fixture();try{
  const current=await start(f);await privateChat(f)
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,chatTask,'2026-09-29T18:40:00+08:00',''])).reason,'relay_running')
  await finish(f,current);await f.db.exec("update test_clock set value='2026-09-29T16:00:00+08:00'");await f.tick()
  await f.db.exec("update cli_wake_schedule set wake_at=public.test_now() where kind='relay' and status='planned'");await f.tick()
  const [queued]=await f.query("select * from cli_wake_schedule where kind='relay' and status='queued'")
  assert.ok(queued)
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,chatTask,null,'收工'])).ok,true)
  assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay' and status in ('planned','queued','running')"))[0].n,0)
  assert.equal((await f.query('select status from syzygy_commands where id=$1',[queued.command_id]))[0].status,'failed')
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,chatTask,'2026-09-29T18:40:00+08:00',''])).reason,'day_closed')
 }finally{await f.db.close()}
})
test('only a live Claude singleton private-chat task gains scheduling permission',async()=>{
 const f=await fixture();try{
  await privateChat(f)
  const call=(who=owner)=>f.rpc('cli_relay_set_next',[who,chatTask,'2026-09-29T18:40:00+08:00',''])
  await assert.rejects(call('33333333-3333-4333-8333-333333333333'),/current running/)
  for(const change of ["status='completed'","completed_at=public.test_now()","executor='codex_cli'","payload_json=payload_json||'{\"task_type\":\"morning_share\"}'","payload_json=payload_json||'{\"target_role\":\"codex_cli_syzygy\"}'","payload_json=payload_json||'{\"session_id\":\"55555555-5555-4555-8555-555555555555\"}'"]){
   await f.db.exec('begin');try{await f.query(`update agent_tasks set ${change} where id=$1`,[chatTask]);await assert.rejects(call(),/current running/)}finally{await f.db.exec('rollback')}
  }
  for(const change of ["conversation_kind='group'","handler='router'","is_archived=true","session_key='other'","user_id='33333333-3333-4333-8333-333333333333'"]){
   await f.db.exec('begin');try{await f.db.exec(`update sessions set ${change} where session_key='syzygy_claude_cli'`);await assert.rejects(call(),/current running/)}finally{await f.db.exec('rollback')}
  }
  assert.equal((await f.query('select count(*)::int n from cli_wake_schedule'))[0].n,0)
 }finally{await f.db.close()}
})
test('private-chat schedules still obey the clock, fixed jobs, Codex spacing, cap and mode',async()=>{
 const f=await fixture();try{
  await privateChat(f)
  const call=at=>f.rpc('cli_relay_set_next',[owner,chatTask,at,''])
  for(const at of ['2026-09-29T14:09:59+08:00','2026-09-29T21:00:01+08:00','2026-09-30T18:40:00+08:00'])assert.equal((await call(at)).reason,'time_conflict')
  await f.query('insert into prompt_templates values($1,$2,true,$3)',[owner,'machine_job_fixed',JSON.stringify({targetRole:claude,hour:18,minute:0,daysOfWeek:null})])
  assert.equal((await call('2026-09-29T18:40:00+08:00')).reason,'time_conflict');await f.db.exec('delete from prompt_templates')
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at) values($1,'codex_cli_syzygy','2026-09-29','random','2026-09-29T18:20:00+08:00')",[owner])
  assert.equal((await call('2026-09-29T18:40:00+08:00')).reason,'time_conflict');await f.db.exec('delete from cli_wake_schedule')
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at,started_at,completed_at,status) select $1,$2,'2026-09-29','relay',public.test_now()-interval '2 hours',public.test_now()-interval '2 hours',public.test_now()-interval '1 hour','completed' from generate_series(1,30)",[owner,claude])
  assert.equal((await call('2026-09-29T18:40:00+08:00')).reason,'daily_cap');await f.db.exec('delete from cli_wake_schedule')
  await f.rpc('cli_activity_set_mode',[owner,'daily']);assert.equal((await call('2026-09-29T18:40:00+08:00')).reason,'relay_disabled')
 }finally{await f.db.close()}
})

async function start(f) {
  await f.query('update agent_tasks set payload_json=$1 where id=$2', [JSON.stringify({target_role: claude}),task])
  await f.tick()
  await f.db.exec("update cli_wake_schedule set wake_at=public.test_now() where kind='relay'; update cli_wake_schedule set status='skipped' where kind='random'")
  await f.tick()
  const [w] = await f.query("select * from cli_wake_schedule where kind='relay'")
  return f.rpc('cli_wake_dispatch', [owner, JSON.stringify(roles), false, w.id, w.command_id, task])
}
async function finish(f,w) {
  await f.query("update agent_tasks set result_summary='看了一眼，没打扰' where id=$1",[task])
  return f.rpc('cli_wake_finish',[owner,w.id,task,'completed',null])
}
test('relay tick is durable; Codex daily remains; role toggle cancels pending commands',async()=>{
 const f=await fixture();try{
  await f.tick(); await f.tick()
  const rows=await f.query('select * from cli_wake_schedule')
  assert.equal(rows.length,2)
  assert.equal(rows.find(w=>w.role===claude).kind,'relay')
  const w=rows.find(w=>w.kind==='relay')
  assert.ok(Date.parse(w.wake_at)>Date.parse('2026-09-29T14:00:00+08:00'))
  await f.db.exec("update cli_wake_schedule set status='skipped' where kind='random'; update cli_wake_schedule set wake_at=public.test_now() where kind='relay'")
  await f.tick()
  await f.rpc('cli_activity_set_mode',[owner,'daily'])
  assert.equal((await f.query("select status from cli_wake_schedule where kind='relay'"))[0].status,'cancelled')
  assert.equal((await f.query('select status from syzygy_commands'))[0].status,'failed')
  await f.tick()
  assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay'"))[0].n,1)
 }finally{await f.db.close()}
})
test('running round stores next decision; only tick continues and closure lasts until tomorrow',async()=>{
 const f=await fixture();try{
  const w=await start(f)
  assert.equal(w.kind,'relay'); assert.equal(Date.parse(w.deadline)-Date.parse(w.started_at),1800000)
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,task,'2026-09-29T15:00:00+08:00','接力条'])).ok,true)
  await f.tick(); assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay'"))[0].n,1)
  await finish(f,w);await f.tick()
  const [next]=await f.query("select * from cli_wake_schedule where kind='relay' and status='planned'")
  assert.equal(next.decision_source,'model');assert.equal(next.note,'接力条')
  await f.db.exec("update cli_wake_schedule set close_day=true where kind='relay' and status='completed'; update cli_wake_schedule set status='cancelled' where status='planned'")
  await f.tick(); assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where status='planned' and kind='relay'"))[0].n,0)
  await f.db.exec("update test_clock set value='2026-09-30T09:00:00+08:00'")
  await f.tick(); assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where status='planned' and kind='relay'"))[0].n,1)
 }finally{await f.db.close()}
})
test('close_day is irreversible within a round; role and task ownership are enforced',async()=>{
 const f=await fixture();try{
  const w=await start(f)
  await assert.rejects(f.rpc('cli_relay_set_next',['33333333-3333-4333-8333-333333333333',task,null,'']),/running relay/)
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,task,null,'今天收工'])).day_closed,true)
  assert.equal((await f.rpc('cli_set_self_alarm',[owner,task,'2026-09-29T16:00:00+08:00','再开'])).day_closed,true)
  await finish(f,w);await f.tick()
  assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay'"))[0].n,1)
 }finally{await f.db.close()}
})
test('chatting skips relay without daily postponement; offline and paused do not create plans',async()=>{
 const f=await fixture();try{
  await f.tick({},false); assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay'"))[0].n,0)
  await f.tick(roles,true); assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay'"))[0].n,0)
  await f.tick();await f.db.exec("update cli_wake_schedule set wake_at=public.test_now() where kind='relay'")
  await f.query("insert into messages(user_id,role,created_at,session_id) values($1,'user',public.test_now(),'66666666-6666-4666-8666-666666666666')",[owner])
  await f.tick()
  const [w]=await f.query("select * from cli_wake_schedule where kind='relay' and status='skipped'")
  assert.equal(w.skip_reason,'chatting');assert.equal(w.delayed,false)
  assert.equal((await f.query('select count(*)::int n from syzygy_commands'))[0].n,0)
  assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay' and status='planned'"))[0].n,1)
 }finally{await f.db.close()}
})
test('missed starts are not replayed; 21:00 cutoff, Sunday fixed task and daily cap',async()=>{
 const f=await fixture();try{
  await f.tick();await f.db.exec("update cli_wake_schedule set wake_at=public.test_now()-interval '3 minutes' where kind='relay'")
  await f.tick();assert.equal((await f.query("select skip_reason from cli_wake_schedule where kind='relay' and status='skipped'"))[0].skip_reason,'missed_window')
  await f.db.exec("update cli_wake_schedule set status='cancelled' where status='planned'; update test_clock set value='2026-09-29T21:01:00+08:00'")
  await f.tick();assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay' and status='planned'"))[0].n,0)
  await f.db.exec("update test_clock set value='2026-10-04T09:00:00+08:00'")
  await f.query('insert into prompt_templates values($1,$2,true,$3)',[owner,'machine_job_week',JSON.stringify({targetRole:claude,hour:10,minute:0,daysOfWeek:[0]})])
  await f.tick();const [w]=await f.query("select * from cli_wake_schedule where kind='relay' and status='planned'")
  assert.ok(Date.parse(w.wake_at)>=Date.parse('2026-10-04T11:00:00+08:00'))
  await f.db.exec("delete from cli_wake_schedule; update test_clock set value='2026-10-05T14:00:00+08:00'")
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at,started_at,completed_at,status) select $1,$2,'2026-10-05','relay',public.test_now()-interval '2 hours',public.test_now()-interval '2 hours',public.test_now()-interval '1 hour','completed' from generate_series(1,30)",[owner,claude])
  await f.tick();assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay' and status='planned'"))[0].n,0)
 }finally{await f.db.close()}
})
test('share is canonical and replay-safe; daily diary appends without replacement or extra notification',async()=>{
 const f=await fixture();try{
  const w=await start(f)
  const share=()=>f.rpc('cli_relay_share',[owner,task,w.id,'做了一件小事'])
  const first=await share();assert.equal((await share()).message_id,first.message_id)
  const [message]=await f.query('select * from messages where id=$1',[first.message_id]);
  assert.equal(message.sender_key,'claude_cli');assert.equal(message.meta.delivery_state,'completed');assert.equal(message.meta.wake_id,w.id);
  assert.equal((await f.query("select count(*)::int n from messages where role='assistant'"))[0].n,1)
  assert.equal((await f.query("select count(*)::int n from agent_events where event_type='cli_relay_shared'"))[0].n,1)
  const page=await f.rpc('cli_relay_append_diary',[owner,task,'第一段','今天'])
  assert.equal((await f.rpc('cli_relay_append_diary',[owner,task,'重试不覆盖','今天'])).replayed,true)
  await finish(f,w)
  const task2='77777777-7777-4777-8777-777777777777'
  await f.query("insert into agent_tasks(id,user_id,status,payload_json) values($1,$2,'running',$3)",[task2,owner,JSON.stringify({target_role:claude})])
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at,status,task_id,started_at) values($1,$2,'2026-09-29','relay',public.test_now(),'running',$3,public.test_now())",[owner,claude,task2])
  assert.equal((await f.rpc('cli_relay_append_diary',[owner,task2,'第二段','不改标题'])).id,page.id)
  const [diary]=await f.query('select * from diary_entries')
  assert.equal(diary.metadata.task_id,task);assert.equal(diary.metadata.segments.length,2)
  assert.equal(diary.content,'第一段\n\n---\n\n第二段')
  assert.equal((await f.query("select count(*)::int n from agent_events where event_type='cli_diary_created'"))[0].n,1)
  assert.equal((await f.query("select summary_missing from cli_wake_schedule where id=$1",[w.id]))[0].summary_missing,false)
  for(const name of ['cli_relay_share(uuid,uuid,uuid,text)','cli_relay_append_diary(uuid,uuid,text,text,boolean)','cli_activity_set_mode(uuid,text)']){
   assert.equal((await f.query("select has_function_privilege('authenticated',$1,'execute') allowed",['public.'+name]))[0].allowed,false)
  }
 }finally{await f.db.close()}
})

test('mode rollback leaves a running round alone, then prevents continuation',async()=>{
 const f=await fixture();try{
  const w=await start(f);await f.rpc('cli_activity_set_mode',[owner,'daily']);
  assert.equal((await f.query('select status from cli_wake_schedule where id=$1',[w.id]))[0].status,'running');
  await finish(f,w);await f.tick();assert.equal((await f.query("select count(*)::int n from cli_wake_schedule where kind='relay'"))[0].n,1);
 }finally{await f.db.close()}
});
test('restart recovers the crashed round and tick creates future work without replay',async()=>{
 const f=await fixture();try{
  const w=await start(f);assert.equal(await f.rpc('cli_wake_recover',[owner,'2026-09-29T14:01:00+08:00']),1);
  await f.tick();const rows=await f.query("select * from cli_wake_schedule where kind='relay'");
  assert.equal(rows.length,2);assert.equal(rows.find(r=>r.id===w.id).status,'failed');
  assert.ok(Date.parse(rows.find(r=>r.id!==w.id).wake_at)>Date.parse(w.started_at));
  assert.equal((await f.query('select count(*)::int n from syzygy_commands'))[0].n,1);
 }finally{await f.db.close()}
});
test('21:00 last start ends at 21:30; next-day/late override and too-close slots are rejected',async()=>{
 const f=await fixture();try{
  await f.db.exec("update test_clock set value='2026-09-29T20:50:00+08:00'");
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at) values($1,$2,'2026-09-29','relay',public.test_now())",[owner,claude]);
  const w=await start(f);
  assert.equal((await f.rpc('cli_relay_set_next',[owner,task,'2026-09-30T09:30:00+08:00',''])).ok,false);
  assert.equal((await f.rpc('cli_relay_set_next',[owner,task,'2026-09-29T21:00:01+08:00',''])).ok,false);
  await finish(f,w);
  assert.equal(await f.rpc('cli_wake_slot_available',[owner,claude,'2026-09-29T20:59:59+08:00','relay']),false);
  assert.equal(await f.rpc('cli_wake_slot_available',[owner,claude,'2026-09-29T21:00:00+08:00','relay']),true);
  await f.db.exec("update agent_tasks set status='running'; update test_clock set value='2026-09-29T21:00:00+08:00'");
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at) values($1,$2,'2026-09-29','relay',public.test_now())",[owner,claude]);
  await f.tick();const [next]=await f.query("select * from cli_wake_schedule where kind='relay' and status='queued'");
  const final=await f.rpc('cli_wake_dispatch',[owner,JSON.stringify(roles),false,next.id,next.command_id,task]);
  assert.equal(Date.parse(final.deadline),Date.parse('2026-09-29T21:30:00+08:00'));
 }finally{await f.db.close()}
});
test('shared diary requires explicit public append; later diary clears earlier missing flags',async()=>{
 const f=await fixture();try{
  const w=await start(f);assert.equal((await finish(f,w)).diary_missing,true);
  await f.query("update cli_wake_schedule set status='running' where id=$1",[w.id]);
  await f.rpc('cli_relay_append_diary',[owner,task,'第一段','']);
  assert.equal((await f.query('select diary_missing from cli_wake_schedule where id=$1',[w.id]))[0].diary_missing,false);
  await assert.rejects(f.db.exec("update diary_entries set metadata=metadata-'segments'"),/append_relay_diary/);
  await finish(f,w);await f.db.exec("update diary_entries set visibility='shared'");
  const second='77777777-7777-4777-8777-777777777777';
  await f.query("insert into agent_tasks(id,user_id,status,payload_json) values($1,$2,'running',$3)",[second,owner,JSON.stringify({target_role:claude})]);
  await f.query("insert into cli_wake_schedule(user_id,role,local_date,kind,wake_at,status,task_id,started_at) values($1,$2,'2026-09-29','relay',public.test_now(),'running',$3,public.test_now())",[owner,claude,second]);
  await assert.rejects(f.rpc('cli_relay_append_diary',[owner,second,'不该偷偷公开','']),/allow_shared/);
  await f.rpc('cli_relay_append_diary',[owner,second,'明确公开','',true]);
  assert.equal((await f.query('select content from diary_entries'))[0].content,'第一段\n\n---\n\n明确公开');
 }finally{await f.db.close()}
});
test('owner-only status reads and service-only mutations',async()=>{
 const f=await fixture();try{
  await f.db.exec("create or replace function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated;");
  await f.tick();
  await f.db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false)`);
  assert.equal((await f.query('select mode from cli_activity_settings'))[0].mode,'relay');
  await assert.rejects(f.rpc('cli_activity_set_mode',[owner,'daily']),/permission denied/);
  await f.db.exec("select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false)");
  assert.equal((await f.query('select * from cli_activity_settings')).length,0);assert.equal((await f.query('select * from cli_wake_schedule')).length,0);
 }finally{await f.db.close()}
});
