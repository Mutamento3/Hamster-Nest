-- Read-only trial report. Replace the owner literal explicitly before running.
select local_date,
 count(*) filter(where started_at is not null) as started_rounds,
 count(*) filter(where share_message_id is not null) as shares,
 count(*) filter(where status='skipped') as skipped,
 count(*) filter(where next_wake_at is not null) as model_overrides,
 count(*) filter(where close_day) as closed,
 count(*) filter(where summary_missing) as missing_summaries,
 count(*) filter(where diary_missing) as day_diary_missing_receipts
from public.cli_wake_schedule
where user_id='94dd24be-e136-45bb-836b-6820c09c4292' and kind='relay'
 and local_date>=(now() at time zone 'Asia/Shanghai')::date-14
group by local_date order by local_date desc;

select (started_at at time zone 'Asia/Shanghai')::date as local_date,
 count(*) filter(where payload_json->'relay_receipt'->>'did_act'='false') as no_op_rounds,
 count(*) as relay_tasks
from public.agent_tasks where user_id='94dd24be-e136-45bb-836b-6820c09c4292'
 and payload_json->'free_activity'->>'source'='relay' and started_at>=now()-interval '14 days'
group by 1 order by 1 desc;

-- Observed next-user-message latency, not proof that the user read a banner.
select w.id as wake_id,m.created_at as shared_at,
 (select min(u.created_at)-m.created_at from public.messages u where u.user_id=m.user_id
  and u.session_id=m.session_id and u.role='user' and u.created_at>m.created_at) as next_reply_after
from public.cli_wake_schedule w join public.messages m on m.id=w.share_message_id
where w.user_id='94dd24be-e136-45bb-836b-6820c09c4292' and w.kind='relay'
 and w.local_date>=(now() at time zone 'Asia/Shanghai')::date-14 order by m.created_at desc;
