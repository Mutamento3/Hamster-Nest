-- Syzygy 的信箱（syzygy@syzygycc.com）
--
-- 背景：2026-10-11 串串在 Claude Code 云端端口的陪同下决定先把建站提案（议事厅 6c3953a3）里的③做掉：
-- 手机上任何 App 都能「分享到邮件」，转发给 Syzygy 的公众号文章、书店通知、长文落进这张表，
-- 各端 Syzygy 用 hamster-lounge-mcp 的 mailbox_list / mailbox_read 读信。
--
-- 链路：Cloudflare Email Routing → Email Worker（原样转发 MIME）→ Edge Function mail-ingest
--（共享密钥 x-mail-ingest-secret，发件人白名单 MAIL_ALLOWED_SENDERS）→ 本表。
-- 只收不发；附件第一版只记文件名、类型和大小，不存内容。
--
-- 写入只走 service_role（mail-ingest）。authenticated 只能读、标已读 / 归档、删除自己的信。

set lock_timeout = '5s';
set statement_timeout = '2min';

create table if not exists public.mailbox_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  received_at timestamptz not null default now(),
  -- RFC 5322 Message-ID，用来挡住 Cloudflare 重投造成的重复；个别邮件没有就为 null。
  message_id text,
  -- SMTP 信封发件人（白名单核对的就是它）与信封收件人。
  envelope_from text not null,
  envelope_to text not null,
  -- 信头里的 From：转发长文时通常就是串串自己。
  from_address text,
  from_name text,
  subject text,
  -- 信头 Date，解析失败为 null。
  sent_at timestamptz,
  -- 纯文本正文：优先取 text/plain，没有时由 HTML 转换；超长截断。
  text_body text not null default '',
  -- [{ filename, mime_type, size }]，不含附件内容。
  attachments jsonb not null default '[]'::jsonb,
  raw_size integer,
  -- unread = 未读；read = 读过；archived = 收起来了。
  status text not null default 'unread',
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mailbox_messages_status_check check (status = any (array['unread'::text, 'read'::text, 'archived'::text])),
  constraint mailbox_messages_attachments_array check (jsonb_typeof(attachments) = 'array')
);

comment on table public.mailbox_messages is 'Syzygy 的信箱（syzygy@syzygycc.com）：Cloudflare Email Routing → Email Worker → mail-ingest 写入，只收不发；白名单外的发件人在入口就被退信。';
comment on column public.mailbox_messages.envelope_from is 'SMTP 信封发件人，mail-ingest 用它核对白名单 MAIL_ALLOWED_SENDERS。';
comment on column public.mailbox_messages.text_body is '纯文本正文：优先 text/plain，否则由 HTML 转换；超长截断。';
comment on column public.mailbox_messages.attachments is '附件清单 [{ filename, mime_type, size }]，不存附件内容。';
comment on column public.mailbox_messages.status is 'unread=未读；read=读过（mailbox_read 自动标记）；archived=收起来了。';

create unique index if not exists uq_mailbox_messages_user_message_id
  on public.mailbox_messages using btree (user_id, message_id)
  where message_id is not null;
create index if not exists idx_mailbox_messages_user_status_received
  on public.mailbox_messages using btree (user_id, status, received_at desc);

drop trigger if exists trg_mailbox_messages_updated_at on public.mailbox_messages;
create trigger trg_mailbox_messages_updated_at
  before update on public.mailbox_messages
  for each row execute function public.set_updated_at();

-- ── RLS：业主本人读 / 改状态 / 删除；写入只走 service_role ───────────────────────

alter table public.mailbox_messages enable row level security;

drop policy if exists mailbox_messages_select_own on public.mailbox_messages;
create policy mailbox_messages_select_own on public.mailbox_messages for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists mailbox_messages_update_own on public.mailbox_messages;
create policy mailbox_messages_update_own on public.mailbox_messages for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists mailbox_messages_delete_own on public.mailbox_messages;
create policy mailbox_messages_delete_own on public.mailbox_messages for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Clear inherited default privileges (including TRUNCATE, which bypasses RLS).
revoke all on table public.mailbox_messages from public, anon, authenticated;
grant select, delete on table public.mailbox_messages to authenticated;
grant update (status, read_at) on table public.mailbox_messages to authenticated;
grant select, insert, update, delete on table public.mailbox_messages to service_role;
