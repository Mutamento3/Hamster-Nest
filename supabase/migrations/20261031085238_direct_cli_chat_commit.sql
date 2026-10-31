-- Reserve only the existing canonical execution identity. The direct owner,
-- not the cloud listener, invokes the model; body persistence remains deferred.
create or replace function public.conversation_direct_prepare(
  p_user_id uuid,p_session_id uuid,p_client_id uuid,p_content text,p_sender text,p_accepted_at timestamptz
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d jsonb; old public.messages%rowtype;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then
    raise exception 'direct_prepare: service role required' using errcode='42501';
  end if;
  if p_sender is null or p_sender not in ('codex_cli','claude_cli') or p_accepted_at is null then
    raise exception 'direct_prepare: invalid request' using errcode='22023';
  end if;
  perform 1 from public.sessions where id=p_session_id and user_id=p_user_id
    and conversation_kind='direct' and handler='cli' and routing_config->>'default_responder'=p_sender;
  if not found then raise exception 'direct_prepare: invalid private session' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,0));
  select * into old from public.messages where client_id=p_client_id;
  if found and (old.user_id is distinct from p_user_id or old.session_id is distinct from p_session_id
    or old.content is distinct from p_content or old.meta->>'direct_transport' is distinct from 'v1') then
    raise exception 'direct_prepare: client id belongs to another request' using errcode='23505';
  end if;
  d:=public.conversation_dispatch_prepare_durable(p_user_id,p_session_id,p_client_id,p_content,p_accepted_at,array[p_sender],false);
  update public.messages set created_at=p_accepted_at,
    meta=coalesce(meta,'{}'::jsonb)||jsonb_build_object('direct_transport','v1') where id=(d#>>'{user_message,id}')::uuid;
  update public.syzygy_commands set payload=payload||jsonb_build_object('delivery_transport','mini_direct_v1','direct_client_id',p_client_id)
    where id=(d#>>'{command,id}')::uuid;
  update public.agent_tasks set status='running',started_at=coalesce(started_at,p_accepted_at),
    payload_json=payload_json||jsonb_build_object('delivery_transport','mini_direct_v1','direct_client_id',p_client_id)
    where id=(d#>>'{task,id}')::uuid and status='pending';
  return jsonb_build_object('userMessageId',d#>>'{user_message,id}','replyId',d#>>'{reply,id}',
    'taskId',d#>>'{task,id}','commandId',d#>>'{command,id}');
end $$;
revoke all on function public.conversation_direct_prepare(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.conversation_direct_prepare(uuid,uuid,uuid,text,text,timestamptz) to service_role;

-- Import the locally durable reply; direct-tagged cloud commands never invoke a model.
create or replace function public.conversation_direct_commit(
  p_user_id uuid, p_session_id uuid, p_client_id uuid, p_content text,
  p_sender text, p_reply text, p_accepted_at timestamptz,
  p_completed_at timestamptz, p_status text default 'completed',
  p_audit jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_dispatch jsonb;
  v_task uuid;
  v_command uuid;
  v_user uuid;
  v_reply uuid;
  v_existing public.messages%rowtype;
  v_task_status text;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then
    raise exception 'direct_commit: service role required' using errcode='42501';
  end if;
  if p_sender is null or p_status is null or p_audit is null
    or p_sender not in ('codex_cli','claude_cli') or p_status not in ('completed','failed')
    or p_accepted_at is null or p_completed_at < p_accepted_at
    or p_completed_at is null or char_length(coalesce(p_reply,'')) > 12000
    or (p_status='completed' and btrim(coalesce(p_reply,''))='')
    or jsonb_typeof(p_audit) <> 'object' or octet_length(p_audit::text)>262144 then
    raise exception 'direct_commit: invalid receipt' using errcode='22023';
  end if;
  perform 1 from public.sessions where id=p_session_id and user_id=p_user_id
    and conversation_kind='direct' and handler='cli'
    and routing_config->>'default_responder'=p_sender;
  if not found then raise exception 'direct_commit: invalid private session' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,0));
  select * into v_existing from public.messages where client_id=p_client_id;
  if found then
    if v_existing.user_id is distinct from p_user_id or v_existing.session_id is distinct from p_session_id
      or v_existing.content is distinct from p_content or v_existing.meta->>'direct_transport' is distinct from 'v1' then
      raise exception 'direct_commit: client id belongs to another request' using errcode='23505';
    end if;
    select * into v_existing from public.messages where user_id=p_user_id
      and reply_to_id=v_existing.id and sender_key=p_sender and role='assistant';
    if not found then raise exception 'direct_commit: reply missing'; end if;
    if v_existing.meta->>'delivery_state'='cancelled' then
      return jsonb_build_object('userMessageId',v_existing.reply_to_id,'replyId',v_existing.id,'discarded',true);
    end if;
    if v_existing.meta->>'delivery_state' in ('completed','failed') then
      if v_existing.content is distinct from coalesce(p_reply,'') or v_existing.meta->>'delivery_state' is distinct from p_status then
        raise exception 'direct_commit: terminal receipt mismatch' using errcode='23505';
      end if;
      return jsonb_build_object('userMessageId',v_existing.reply_to_id,'replyId',v_existing.id);
    end if;
  end if;
  v_dispatch := public.conversation_direct_prepare(p_user_id,p_session_id,p_client_id,p_content,p_sender,p_accepted_at);
  v_task := (v_dispatch->>'taskId')::uuid;
  v_command := (v_dispatch->>'commandId')::uuid;
  v_user := (v_dispatch->>'userMessageId')::uuid;
  v_reply := (v_dispatch->>'replyId')::uuid;
  -- Match cancellation's command -> task lock order; never overwrite a concurrent terminal task.
  perform 1 from public.syzygy_commands where id=v_command for update;
  select status into v_task_status from public.agent_tasks where id=v_task for update;
  if v_task_status='cancelled' then
    return jsonb_build_object('userMessageId',v_user,'replyId',v_reply,'discarded',true);
  end if;
  update public.messages set created_at=p_accepted_at,
    meta=coalesce(meta,'{}'::jsonb)||jsonb_build_object('direct_transport','v1') where id=v_user;
  update public.agent_tasks set status=p_status,started_at=p_accepted_at,completed_at=p_completed_at,
    result_detail=coalesce(p_reply,''),result_summary=case when p_status='completed' then 'Direct CLI reply completed' else 'Direct CLI turn interrupted; no automatic rerun' end,
    payload_json=payload_json||jsonb_build_object('direct_transport','v1','direct_audit',p_audit,
      'execution_timing',p_audit->'execution_timing','cli_usage',p_audit->'cli_usage',
      'canonical_context',p_audit->'canonical_context','prompt_reply_style',p_audit->'prompt_reply_style',
      'machine_documents',p_audit->'machine_documents')
    where id=v_task and user_id=p_user_id;
  if p_status='completed' then
    perform public.conversation_dispatch_complete_reply(p_user_id,v_task,p_reply,p_completed_at);
  else
    update public.messages set content=coalesce(p_reply,''),meta=meta||jsonb_build_object(
      'delivery_state','failed','delivery_error_code','DIRECT_TURN_INTERRUPTED',
      'delivery_error','本轮未完成，保留已收到的内容；不会自动重新生成。','failed_at',p_completed_at)
      where id=v_reply and user_id=p_user_id;
  end if;
  update public.messages set created_at=p_completed_at,meta=meta||jsonb_build_object('direct_client_id',p_client_id)
    where id=v_reply and user_id=p_user_id;
  if jsonb_typeof(p_audit->'tool_progress')='object' then
    update public.messages set meta=meta||jsonb_build_object('tool_progress',
      (p_audit->'tool_progress')||jsonb_build_object('version',1,'task_id',v_task,'delivery_attempt',1,
        'updated_at',p_completed_at,'started_at',p_accepted_at))
      where id=v_reply and user_id=p_user_id;
  end if;
  update public.syzygy_commands set status=case when p_status='completed' then 'done' else 'failed' end,
    completed_at=p_completed_at where id=v_command and user_id=p_user_id;
  return jsonb_build_object('userMessageId',v_user,'replyId',v_reply);
end $$;
revoke all on function public.conversation_direct_commit(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.conversation_direct_commit(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,text,jsonb) to service_role;
