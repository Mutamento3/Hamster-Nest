import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const migration = await readFile(new URL('../supabase/migrations/20261013122829_archive_app.sql', import.meta.url),'utf8')
const owner='11111111-1111-4111-8111-111111111111', stranger='22222222-2222-4222-8222-222222222222'
const cat='33333333-3333-4333-8333-333333333333', id='44444444-4444-4444-8444-444444444444'
async function setup(){
 const db=new PGlite(); await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
 create table public.archive_categories(id uuid primary key,user_id uuid not null,parent_id uuid references public.archive_categories on delete cascade,scope text not null,name text not null,sort_order integer default 0,created_at timestamptz default now(),updated_at timestamptz default now());
 create table public.archives(id uuid primary key,user_id uuid not null,category_id uuid not null references public.archive_categories on delete cascade,title text not null,content text not null,keywords text[] default '{}',aliases text[] default '{}',importance text default 'normal',source text default 'manual',is_deleted boolean default false,created_at timestamptz default now(),updated_at timestamptz default now());
 alter table public.archives enable row level security; alter table public.archive_categories enable row level security;
 create policy own on public.archives to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid())); create policy own on public.archive_categories to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid())); grant all on public.archives,public.archive_categories to authenticated;`);
 await db.exec(migration); await db.exec(await readFile(new URL('../supabase/migrations/20261013123758_archive_app_receipts.sql',import.meta.url),'utf8'));  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false)`); return db;
}
const change=async(db,op)=>(await db.query('select public.archive_apply_change($1::jsonb) as result',[JSON.stringify(op)])).rows[0].result.row
const category=(extra={})=>({kind:'category',action:'save',scope:'chuanchuan',id:cat,base:null,fields:{name:'目录',parent_id:null,sort_order:10},...extra})
const entry=(extra={})=>({kind:'entry',action:'save',scope:'chuanchuan',id,base:null,fields:{category_id:cat,title:'档案',content:'正文 needle %_，',keywords:['索引'],aliases:['别名'],importance:'normal',source:'manual'},...extra})
test('archive writes replay same UUID, preserve source, reject conflicts and deleted revival',async()=>{
 const db=await setup(); try{
 await change(db,category()); const op=entry(),first=await change(db,op); assert.deepEqual(await change(db,op),first); const receipt=(await db.query('select public.archive_apply_change($1::jsonb) as result',[JSON.stringify(op)])).rows[0].result; assert.equal(receipt.counts[0].entry_count,1);
 const updated=await change(db,{...op,base:first,fields:{...op.fields,title:'新版'}}); assert.equal(updated.title,'新版');
 await assert.rejects(change(db,{...op,base:first,fields:{...op.fields,title:'陈旧覆盖'}}),/version conflict/);
 assert.equal(await change(db,{...op,action:'delete',base:updated}),null); assert.equal(await change(db,{...op,action:'delete',base:updated}),null);
 await assert.rejects(change(db,op),/removed/);
 }finally{await db.close()}
})
test('archive scopes, caller RLS, literal body/alias search and keyset pages',async()=>{
 const db=await setup();try{
 await change(db,category());await change(db,entry());
 for(const search of ['needle','%_','别名','索引']){const r=await db.query('select * from public.archive_search_entries($1,null,$2)',['chuanchuan',search]);assert.equal(r.rows.length,1);assert.equal('content' in r.rows[0],false)}
 assert.equal((await db.query("select * from public.archive_search_entries('syzygy')")).rows.length,0);
 await db.exec(`insert into archives(id,user_id,category_id,title,content,updated_at) select ('aaaaaaaa-aaaa-4aaa-8aaa-'||lpad(n::text,12,'0'))::uuid,'${owner}','${cat}','item','body','2026-01-01' from generate_series(1,66)n`);
 const first=(await db.query("select * from public.archive_search_entries('chuanchuan')")).rows;assert.equal(first.length,31);
 const last=first.at(-1); const next=(await db.query("select * from public.archive_search_entries('chuanchuan',null,'',$1,$2)",[last.updated_at,last.id])).rows; assert.equal(next.length,31);assert.equal(next.some(r=>first.some(f=>f.id===r.id)),false);
 assert.equal(Number((await db.query("select entry_count from public.archive_category_index('chuanchuan')")).rows[0].entry_count),67);
 await db.exec(`select set_config('request.jwt.claim.sub','${stranger}',false)`);
 assert.equal((await db.query("select * from public.archive_search_entries('chuanchuan')")).rows.length,0);await assert.rejects(change(db,entry()),/category unavailable/);
 await assert.rejects(change(db,category({id:'55555555-5555-4555-8555-555555555555',fields:{name:'forged',parent_id:cat}})),/parent unavailable/);
 assert.equal((await db.query("select has_function_privilege('anon','public.archive_apply_change(jsonb)','execute') as allowed")).rows[0].allowed,false);
 }finally{await db.close()}
})
test('archive category rename and cascading delete preserve other scope',async()=>{
 const db=await setup();try{
 const parent=await change(db,category());const child=await change(db,category({id:'55555555-5555-4555-8555-555555555555',fields:{name:'child',parent_id:cat,sort_order:10}}));await change(db,entry({fields:{...entry().fields,category_id:child.id}}));
 await change(db,category({id:'66666666-6666-4666-8666-666666666666',scope:'syzygy'}));
 const renamed=await change(db,category({base:parent,fields:{...category().fields,name:'新目录'}}));await assert.rejects(change(db,category({base:parent,action:'delete'})),/version conflict/);
 await change(db,category({base:renamed,action:'delete'}));assert.equal((await db.query('select * from archives')).rows.length,0);assert.equal((await db.query('select * from archive_categories')).rows.length,1);
 }finally{await db.close()}
})
