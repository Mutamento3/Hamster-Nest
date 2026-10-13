-- App read models: caller RLS, literal search, bounded keyset pages, no eager bodies.
create or replace function public.archive_category_index(p_scope text, p_after uuid default null)
returns table (id uuid,user_id uuid,parent_id uuid,scope text,name text,sort_order integer,created_at timestamptz,updated_at timestamptz,entry_count bigint)
language sql stable security invoker set search_path = '' as $$
 select c.id,c.user_id,c.parent_id,c.scope,c.name,c.sort_order,c.created_at,c.updated_at,
   (select count(*) from public.archives a where a.category_id=c.id and a.user_id=(select auth.uid()) and a.is_deleted=false)
 from public.archive_categories c where c.user_id=(select auth.uid()) and c.scope=p_scope
   and (p_after is null or c.id>p_after) order by c.id limit 300;
$$;
create or replace function public.archive_search_entries(p_scope text,p_category uuid default null,p_search text default '',p_before_time timestamptz default null,p_before_id uuid default null)
returns table(id uuid,user_id uuid,category_id uuid,title text,excerpt text,keywords text[],aliases text[],importance text,source text,created_at timestamptz,updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
 select a.id,a.user_id,a.category_id,a.title,left(a.content,160),a.keywords,a.aliases,a.importance,a.source,a.created_at,a.updated_at
 from public.archives a join public.archive_categories c on c.id=a.category_id and c.user_id=a.user_id
 where a.user_id=(select auth.uid()) and c.scope=p_scope and a.is_deleted=false
 and (p_category is null or a.category_id=p_category)
 and (coalesce(btrim(p_search),'')='' or strpos(lower(a.title||E'\n'||a.content||E'\n'||coalesce(array_to_string(a.keywords,E'\n'),'')||E'\n'||coalesce(array_to_string(a.aliases,E'\n'),'')),lower(btrim(p_search)))>0)
 and (p_before_id is null or (coalesce(a.updated_at,'1970-01-01'::timestamptz),a.id)<(coalesce(p_before_time,'1970-01-01'::timestamptz),p_before_id))
 order by coalesce(a.updated_at,'1970-01-01'::timestamptz) desc,a.id desc limit 31;
$$;
-- Compare the complete original row under lock; UUID plus desired fields makes replay safe.
create or replace function public.archive_apply_change(p_operation jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 who uuid := auth.uid(); ident uuid := (p_operation->>'id')::uuid;
 kind text := p_operation->>'kind'; action text := p_operation->>'action';
 scope_value text := p_operation->>'scope'; fields jsonb := p_operation->'fields'; base jsonb := p_operation->'base';
 cat public.archive_categories; entry public.archives; target public.archive_categories;
 current_value jsonb; desired jsonb; parent uuid;
begin
 if who is null then raise exception 'authentication required' using errcode='42501'; end if;
 if ident is null or kind not in ('entry','category') or action not in ('save','delete') or scope_value not in ('chuanchuan','syzygy') then raise exception 'invalid operation'; end if;
 if kind='category' then
   select * into cat from public.archive_categories where id=ident and user_id=who for update;
   current_value := case when cat.id is null then null else to_jsonb(cat) end;
   if cat.id is not null and cat.scope<>scope_value then raise exception 'scope conflict'; end if;
 else
   select * into entry from public.archives where id=ident and user_id=who for update;
   current_value := case when entry.id is null then null else to_jsonb(entry) end;
   if entry.id is not null and not exists(select 1 from public.archive_categories where id=entry.category_id and user_id=who and scope=scope_value) then raise exception 'scope conflict'; end if;
 end if;
 if action='delete' then
   if base is null or base='null'::jsonb or base->>'id' is distinct from ident::text or base->>'user_id' is distinct from who::text then raise exception 'original version required'; end if;
   if current_value is null or (kind='entry' and entry.is_deleted=true) then return jsonb_build_object('kind',kind,'row',null); end if;
   if not current_value @> base then raise exception 'version conflict' using errcode='40001'; end if;
   if kind='category' then
     delete from public.archive_categories where id=ident and user_id=who;
   else
     update public.archives set is_deleted=true,updated_at=clock_timestamp() where id=ident and user_id=who;
   end if;
   return jsonb_build_object('kind',kind,'row',null);
 end if;
 if jsonb_typeof(fields) is distinct from 'object' then raise exception 'fields required'; end if;
 if kind='category' then
   if coalesce(btrim(fields->>'name'),'')='' then raise exception 'name required'; end if;
   parent := (fields->>'parent_id')::uuid;
   if parent=ident then raise exception 'invalid parent'; end if;
   if parent is not null then
     select * into target from public.archive_categories where id=parent and user_id=who and scope=scope_value for key share;
     if target.id is null then raise exception 'parent unavailable'; end if;
   end if;
   if cat.id is not null and cat.parent_id is distinct from parent then raise exception 'category move unsupported'; end if;
   desired := jsonb_build_object('name',btrim(fields->>'name'),'parent_id',parent,'scope',scope_value,'sort_order',coalesce((fields->>'sort_order')::integer,0));
 else
   if coalesce(btrim(fields->>'title'),'')='' or jsonb_typeof(fields->'content') is distinct from 'string'
     or jsonb_typeof(fields->'keywords') is distinct from 'array' or jsonb_typeof(fields->'aliases') is distinct from 'array'
     or coalesce(fields->>'importance','') not in ('low','normal','high','critical') then raise exception 'invalid entry'; end if;
   if exists(select 1 from jsonb_array_elements((fields->'keywords')||(fields->'aliases')) v where jsonb_typeof(v)<>'string') then raise exception 'invalid tags'; end if;
   select * into target from public.archive_categories where id=(fields->>'category_id')::uuid and user_id=who and scope=scope_value for key share;
   if target.id is null then raise exception 'category unavailable'; end if;
   desired := jsonb_build_object('category_id',target.id,'title',btrim(fields->>'title'),'content',fields->>'content','keywords',fields->'keywords','aliases',fields->'aliases','importance',fields->>'importance','source',coalesce(nullif(fields->>'source',''),'manual'),'is_deleted',false);
   if entry.id is not null and entry.is_deleted=true then raise exception 'entry removed' using errcode='40001'; end if;
 end if;
 if current_value is not null and current_value @> desired then return jsonb_build_object('kind',kind,'row',current_value); end if;
 if current_value is null then
   if base is not null and base<>'null'::jsonb then raise exception 'record removed' using errcode='40001'; end if;
   if kind='category' then
     insert into public.archive_categories(id,user_id,scope,parent_id,name,sort_order) values(ident,who,scope_value,parent,desired->>'name',(desired->>'sort_order')::integer) returning to_jsonb(archive_categories.*) into current_value;
   else
     insert into public.archives(id,user_id,category_id,title,content,keywords,aliases,importance,source) values(ident,who,target.id,desired->>'title',desired->>'content',array(select jsonb_array_elements_text(desired->'keywords')),array(select jsonb_array_elements_text(desired->'aliases')),desired->>'importance',desired->>'source') returning to_jsonb(archives.*) into current_value;
   end if;
 else
   if base is null or base='null'::jsonb or not current_value @> base then raise exception 'version conflict' using errcode='40001'; end if;
   if kind='category' then
     update public.archive_categories set name=desired->>'name',updated_at=clock_timestamp() where id=ident and user_id=who returning to_jsonb(archive_categories.*) into current_value;
   else
     update public.archives set category_id=target.id,title=desired->>'title',content=desired->>'content',keywords=array(select jsonb_array_elements_text(desired->'keywords')),aliases=array(select jsonb_array_elements_text(desired->'aliases')),importance=desired->>'importance',updated_at=clock_timestamp() where id=ident and user_id=who returning to_jsonb(archives.*) into current_value;
   end if;
 end if;
 return jsonb_build_object('kind',kind,'row',current_value);
end;
$$;
revoke all on function public.archive_category_index(text,uuid),public.archive_search_entries(text,uuid,text,timestamptz,uuid),public.archive_apply_change(jsonb) from public,anon;
grant execute on function public.archive_category_index(text,uuid),public.archive_search_entries(text,uuid,text,timestamptz,uuid),public.archive_apply_change(jsonb) to authenticated,service_role;
create index if not exists archives_app_owner_updated_id on public.archives(user_id,(coalesce(updated_at,'1970-01-01'::timestamptz)) desc,id desc) where is_deleted=false;
