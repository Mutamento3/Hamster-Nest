-- Return authoritative counts even when retrying an already committed write.
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
 if ident is null or coalesce(kind,'') not in ('entry','category') or coalesce(action,'') not in ('save','delete') or coalesce(scope_value,'') not in ('chuanchuan','syzygy') then raise exception 'invalid operation'; end if;
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
   if current_value is null or (kind='entry' and entry.is_deleted=true) then return jsonb_build_object('kind',kind,'row',null,'counts',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'entry_count',(select count(*) from public.archives a where a.category_id=c.id and a.user_id=who and a.is_deleted=false))),'[]'::jsonb) from public.archive_categories c where c.user_id=who and c.scope=scope_value)); end if;
   if not current_value @> base then raise exception 'version conflict' using errcode='40001'; end if;
   if kind='category' then
     delete from public.archive_categories where id=ident and user_id=who;
   else
     update public.archives set is_deleted=true,updated_at=clock_timestamp() where id=ident and user_id=who;
   end if;
   return jsonb_build_object('kind',kind,'row',null,'counts',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'entry_count',(select count(*) from public.archives a where a.category_id=c.id and a.user_id=who and a.is_deleted=false))),'[]'::jsonb) from public.archive_categories c where c.user_id=who and c.scope=scope_value));
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
   desired := jsonb_build_object('name',btrim(fields->>'name'),'parent_id',parent,'scope',scope_value,'sort_order',case when cat.id is not null then cat.sort_order else coalesce((fields->>'sort_order')::integer,0) end);
 else
   if coalesce(btrim(fields->>'title'),'')='' or jsonb_typeof(fields->'content') is distinct from 'string'
     or jsonb_typeof(fields->'keywords') is distinct from 'array' or jsonb_typeof(fields->'aliases') is distinct from 'array'
     or coalesce(fields->>'importance','') not in ('low','normal','high','critical') then raise exception 'invalid entry'; end if;
   if exists(select 1 from jsonb_array_elements((fields->'keywords')||(fields->'aliases')) v where jsonb_typeof(v)<>'string') then raise exception 'invalid tags'; end if;
   select * into target from public.archive_categories where id=(fields->>'category_id')::uuid and user_id=who and scope=scope_value for key share;
   if target.id is null then raise exception 'category unavailable'; end if;
   desired := jsonb_build_object('category_id',target.id,'title',btrim(fields->>'title'),'content',fields->>'content','keywords',fields->'keywords','aliases',fields->'aliases','importance',fields->>'importance','source',case when entry.id is not null then entry.source else coalesce(nullif(fields->>'source',''),'manual') end,'is_deleted',false);
   if entry.id is not null and entry.is_deleted=true then raise exception 'entry removed' using errcode='40001'; end if;
 end if;
 if current_value is not null and current_value @> desired then return jsonb_build_object('kind',kind,'row',current_value,'counts',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'entry_count',(select count(*) from public.archives a where a.category_id=c.id and a.user_id=who and a.is_deleted=false))),'[]'::jsonb) from public.archive_categories c where c.user_id=who and c.scope=scope_value)); end if;
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
 return jsonb_build_object('kind',kind,'row',current_value,'counts',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'entry_count',(select count(*) from public.archives a where a.category_id=c.id and a.user_id=who and a.is_deleted=false))),'[]'::jsonb) from public.archive_categories c where c.user_id=who and c.scope=scope_value));
end;
$$;
