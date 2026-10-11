-- Run as an administrative connection. All synthetic data is rolled back.
begin;
insert into public.mailbox_messages (id,user_id,envelope_from,envelope_to,message_id,text_body)
values ('d983f686-91dd-4b0a-a242-920b99673fae',
        (select id from auth.users order by created_at limit 1),
        'test@example.invalid','mailbox@example.invalid','<rls-test@example.invalid>','synthetic');
select set_config('request.jwt.claim.sub',(select user_id::text from public.mailbox_messages where id='d983f686-91dd-4b0a-a242-920b99673fae'),true);
set local role authenticated;
do $$
declare affected integer; denied boolean := false;
begin
  if (select count(*) from public.mailbox_messages where id='d983f686-91dd-4b0a-a242-920b99673fae') <> 1 then raise exception 'owner cannot read'; end if;
  update public.mailbox_messages set status='read',read_at=now() where id='d983f686-91dd-4b0a-a242-920b99673fae';
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'owner cannot mark read'; end if;
  begin
    update public.mailbox_messages set text_body='forbidden' where id='d983f686-91dd-4b0a-a242-920b99673fae';
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'owner can overwrite body'; end if;
  if has_table_privilege('authenticated','public.mailbox_messages','INSERT') or has_table_privilege('authenticated','public.mailbox_messages','TRUNCATE') then raise exception 'unexpected write grants'; end if;
  if has_table_privilege('anon','public.mailbox_messages','SELECT') then raise exception 'anonymous read grant'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$
declare affected integer;
begin
  if exists(select 1 from public.mailbox_messages where id='d983f686-91dd-4b0a-a242-920b99673fae') then raise exception 'cross-account read'; end if;
  update public.mailbox_messages set status='archived' where id='d983f686-91dd-4b0a-a242-920b99673fae';
  get diagnostics affected=row_count;
  if affected<>0 then raise exception 'cross-account update'; end if;
  delete from public.mailbox_messages where id='d983f686-91dd-4b0a-a242-920b99673fae';
  get diagnostics affected=row_count;
  if affected<>0 then raise exception 'cross-account delete'; end if;
end $$;
rollback;
select 'mailbox access assertions passed; synthetic data rolled back' as result;
