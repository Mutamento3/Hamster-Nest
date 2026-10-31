import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../supabase/migrations/20261031080950_direct_cli_chat_commit.sql',import.meta.url),'utf8');
const durable=readFileSync(new URL('../supabase/migrations/20260728131144_v4_1_conversation_cli_durable_tasks.sql',import.meta.url),'utf8');
const routine=name=>{
  const start=durable.indexOf(`create or replace function ${name}(`);
  const end=durable.indexOf('$function$;',start)+11;
  assert.ok(start>=0 && end>start);return durable.slice(start,end);
};
const owner=randomUUID(),session=randomUUID();
async function fixture(){
  const db=new PGlite();
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema private;
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table sessions(id uuid primary key,user_id uuid,handler text,conversation_kind text,is_archived boolean default false,routing_config jsonb);
    create table messages(id uuid primary key default gen_random_uuid(),user_id uuid,session_id uuid,role text,content text default '',
      meta jsonb default '{}',client_id uuid,client_created_at timestamptz,created_at timestamptz default now(),sender_key text,target_sender_keys text[],reply_to_id uuid);
    create unique index client_key on messages(client_id) where client_id is not null;
    create unique index reply_key on messages(session_id,reply_to_id,sender_key) where role='assistant' and reply_to_id is not null;
    create table syzygy_commands(id uuid primary key,user_id uuid,command_type text,payload jsonb,status text,idempotency_key text,
      claimed_at timestamptz,claimed_by text,completed_at timestamptz,error_message text,result jsonb,attempts int default 0,lease_expires_at timestamptz,
      unique(user_id,idempotency_key));
    create table agent_tasks(id uuid primary key,user_id uuid,source text,executor text,command text,status text,payload_json jsonb,
      correlation_id uuid,result_summary text,result_detail text,error text,started_at timestamptz,completed_at timestamptz);
    create table agent_events(id bigserial primary key,user_id uuid,actor text,event_type text,entity_type text,entity_id uuid,title text,payload jsonb,importance text);
    create unique index event_key on agent_events(user_id,event_type,entity_id) where event_type='conversation_reply_completed' and entity_id is not null;
  `);
  await db.exec(routine('private.conversation_dispatch_prepare_core'));
  await db.exec(routine('public.conversation_dispatch_prepare_durable'));
  await db.exec(routine('public.conversation_dispatch_complete_reply'));
  await db.exec(migration);
  await db.query(`insert into sessions values ($1,$2,'cli','direct',false,$3)`,[session,owner,JSON.stringify({participants:['chuanchuan','claude_cli'],default_responder:'claude_cli',target_role:'claude_code_cli_syzygy'})]);
  return db;
}
const commit=(db,id,overrides={})=>db.query('select conversation_direct_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as receipt',[
  overrides.owner || owner,overrides.session || session,id,overrides.content || 'question',overrides.sender || 'claude_cli',overrides.reply ?? 'answer',
  '2026-10-31T07:00:00Z','2026-10-31T07:00:12Z',overrides.status || 'completed',{},
]);
test('minimal registration exposes a running task to tools, tags cloud delivery, then reuses that task at completion',async()=>{
  const db=await fixture();try{
    const id=randomUUID();
    const prepared=await db.query('select conversation_direct_prepare($1,$2,$3,$4,$5,$6) as r',[
      owner,session,id,'question','claude_cli','2026-10-31T07:00:00Z']);
    const task=prepared.rows[0].r.taskId;
    assert.equal((await db.query('select status from agent_tasks where id=$1',[task])).rows[0].status,'running');
    assert.equal((await db.query('select payload from syzygy_commands')).rows[0].payload.delivery_transport,'mini_direct_v1');
    await commit(db,id);
    assert.equal((await db.query('select id from agent_tasks')).rows[0].id,task);
    assert.equal(Number((await db.query('select count(*) from agent_tasks')).rows[0].count),1);
  }finally{await db.close();}
});
test('cloud cancellation is not overwritten by a late generated body',async()=>{
  const db=await fixture();try{
    const id=randomUUID();
    await db.query('select conversation_direct_prepare($1,$2,$3,$4,$5,$6)',[
      owner,session,id,'question','claude_cli','2026-10-31T07:00:00Z']);
    await db.exec("update agent_tasks set status='cancelled'; update messages set meta=meta||'{\"delivery_state\":\"cancelled\"}'::jsonb where role='assistant'");
    assert.equal((await commit(db,id)).rows[0].receipt.discarded,true);
    assert.equal((await db.query("select content from messages where role='assistant'")).rows[0].content,'');
  }finally{await db.close();}
});
test('real durable preparation + direct import commit one terminal command/task/reply/event; lost ACK is idempotent',async()=>{
  const db=await fixture();try{
    const id=randomUUID(),first=await commit(db,id),again=await commit(db,id);
    assert.deepEqual(first.rows,again.rows);
    for(const [table,count] of [['messages',2],['syzygy_commands',1],['agent_tasks',1],['agent_events',1]])
      assert.equal(Number((await db.query(`select count(*) from ${table}`)).rows[0].count),count);
    assert.equal((await db.query('select status from syzygy_commands')).rows[0].status,'done');
    assert.equal((await db.query('select status from agent_tasks')).rows[0].status,'completed');
    await assert.rejects(commit(db,id,{reply:'different'}),/terminal receipt mismatch/);
    await assert.rejects(commit(db,id,{content:'different'}),/another request/);
  }finally{await db.close();}
});
test('failed partial reply is terminal, no completed event, and cannot import to group/other owner',async()=>{
  const db=await fixture();try{
    const id=randomUUID();await commit(db,id,{status:'failed',reply:'partial'});
    await commit(db,id,{status:'failed',reply:'partial'});
    assert.equal((await db.query('select status from syzygy_commands')).rows[0].status,'failed');
    assert.equal(Number((await db.query('select count(*) from agent_events')).rows[0].count),0);
    await assert.rejects(commit(db,randomUUID(),{owner:randomUUID()}),/invalid private session/);
    await db.query("update sessions set conversation_kind='group'");
    await assert.rejects(commit(db,randomUUID()),/invalid private session/);
  }finally{await db.close();}
});
test('old cloud requests are never overwritten or re-executed; RPC is service-only',async()=>{
  const db=await fixture();try{
    const id=randomUUID();
    await db.query('select conversation_dispatch_prepare_durable($1,$2,$3,$4)',[owner,session,id,'question']);
    await assert.rejects(commit(db,id),/another request/);
    assert.equal((await db.query('select status from syzygy_commands')).rows[0].status,'pending');
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(commit(db,randomUUID()),/permission denied/);
      await db.exec('reset role');
    }
  }finally{await db.close();}
});
