-- Small, server-written display snapshots on the existing canonical reply.
-- No new table, transcript, push event or model-context source.
create or replace function public.conversation_cli_tool_progress(
  p_user_id uuid, p_task_id uuid, p_started_at timestamptz, p_progress jsonb
) returns boolean
language plpgsql security invoker set search_path = ''
as $function$
declare
  v_task public.agent_tasks%rowtype;
  v_reply public.messages%rowtype;
  v_call jsonb;
  v_calls jsonb := '[]'::jsonb;
  v_old jsonb;
  v_sequence integer;
begin
  if p_user_id is null or p_task_id is null or p_started_at is null
    or jsonb_typeof(p_progress) is distinct from 'object'
    or octet_length(p_progress::text) > 32768
    or jsonb_typeof(p_progress->'calls') is distinct from 'array'
    or jsonb_typeof(p_progress->'finished') is distinct from 'boolean'
    or jsonb_typeof(p_progress->'truncated') is distinct from 'boolean'
    or coalesce(p_progress->>'sequence','') !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'invalid tool progress';
  end if;
  if jsonb_array_length(p_progress->'calls') > 64 then raise exception 'too many tool calls'; end if;
  v_sequence := (p_progress->>'sequence')::integer;

  -- The attempt's exact start timestamp fences retries and old workers.
  select * into v_task from public.agent_tasks
    where id=p_task_id and user_id=p_user_id and source='conversation_dispatch'
      and status='running' and started_at=p_started_at
      and executor in ('codex_cli','claude_code_cli');
  if not found then return false; end if;
  select * into v_reply from public.messages
    where id=(v_task.payload_json->>'reply_id')::uuid and user_id=p_user_id
      and session_id=(v_task.payload_json->>'session_id')::uuid
      and reply_to_id=(v_task.payload_json->>'user_message_id')::uuid
      and sender_key=v_task.payload_json->>'responder_sender_key'
      and ((v_task.executor='codex_cli' and sender_key in ('codex_cli','syzygy_cli'))
        or (v_task.executor='claude_code_cli' and sender_key='claude_cli'))
      and role='assistant' and meta->>'delivery_state'='generating'
      and meta->>'agent_task_id'=p_task_id::text
      and meta->>'command_id'=v_task.payload_json->>'command_id' for update;
  if not found then return false; end if;
  -- Match dispatch's message-before-task lock order and recheck the attempt.
  perform 1 from public.agent_tasks where id=p_task_id and user_id=p_user_id
    and status='running' and started_at=p_started_at for share;
  if not found then return false; end if;
  v_old := v_reply.meta->'tool_progress';
  if v_old->>'task_id'=p_task_id::text and (v_old->>'started_at')::timestamptz=p_started_at then
    if coalesce((v_old->>'sequence')::integer,0)>=v_sequence or v_old->>'finished'='true' then return false; end if;
  end if;

  for v_call in select value from jsonb_array_elements(p_progress->'calls') loop
    if jsonb_typeof(v_call) is distinct from 'object'
      or coalesce(v_call->>'id','') !~ '^[0-9a-f]{24}$'
      or coalesce(v_call->>'name','') !~ '^[a-zA-Z][a-zA-Z0-9_.:-]{0,159}$'
      or coalesce(v_call->>'status','') not in ('running','done','error','unknown')
      or length(coalesce(v_call->>'started_at','')) not between 20 and 35
      or (v_call->>'status'<>'running' and length(coalesce(v_call->>'ended_at','')) not between 20 and 35)
      or (p_progress->>'finished'='true' and v_call->>'status'='running') then
      raise exception 'invalid tool call';
    end if;
    -- Rebuild the allowlist, rather than persisting any caller-supplied payload.
    v_calls := v_calls || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id',v_call->>'id','name',v_call->>'name','status',v_call->>'status',
      'started_at',(v_call->>'started_at')::timestamptz,
      'ended_at',case when v_call->>'status'<>'running' then (v_call->>'ended_at')::timestamptz end
    )));
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(v_calls))<>jsonb_array_length(v_calls) then
    raise exception 'duplicate tool call';
  end if;
  update public.messages set meta=jsonb_set(coalesce(meta,'{}'::jsonb),'{tool_progress}',
    jsonb_build_object('version',1,'task_id',p_task_id,'started_at',p_started_at,
      'delivery_attempt',coalesce(v_reply.meta->>'delivery_attempt','1'),
      'sequence',v_sequence,'updated_at',clock_timestamp(),
      'finished',p_progress->'finished','truncated',p_progress->'truncated','calls',v_calls))
    where id=v_reply.id and user_id=p_user_id;
  return true;
end
$function$;
revoke all on function public.conversation_cli_tool_progress(uuid,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.conversation_cli_tool_progress(uuid,uuid,timestamptz,jsonb) to service_role;
comment on function public.conversation_cli_tool_progress(uuid,uuid,timestamptz,jsonb)
  is 'CLI chat display only; owner/task/attempt fenced, bounded tool identity and lifecycle, no arguments or results.';
