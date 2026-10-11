// mail-ingest：Syzygy 信箱（syzygy@syzygycc.com）的收信入口。
//
// 唯一调用方是 Cloudflare Email Worker（源码见 cloudflare/mail-worker/worker.js）：它把收到的
// 原始 MIME 原样 POST 过来，带上共享密钥 x-mail-ingest-secret 与信封地址
// x-mail-envelope-from / x-mail-envelope-to。这里解析、核对白名单、落库 mailbox_messages。
//
// 需要的 Function secrets（缺任何一个都 fail closed）：
//   MAIL_INGEST_SECRET     与 Worker 的同名 secret 一致
//   MAIL_ALLOWED_SENDERS   允许寄信的信封地址，逗号分隔；名单外返回 403，Worker 据此退信
//
// 响应约定（Worker 依此决定退信还是让 Cloudflare 重试）：
//   200 收下（含重复投递）· 401 密钥不对 · 403 发件人不在白名单 · 413 太大 · 400 解析失败 · 500 落库失败

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import PostalMime from 'npm:postal-mime@2.7.6'
import { verifySharedSecret } from '../_shared/auth.ts'
import { getOwnerUserId } from '../_shared/owner.ts'
import { getSupabaseAdminKey } from '../_shared/supabase_secret.ts'
import {
  MAX_MAIL_RAW_BYTES,
  buildMailboxRow,
  isAllowedSender,
  parseAllowedSenders,
  type ParsedMail,
} from '../_shared/mailbox.ts'

const USER_ID = getOwnerUserId()

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' })

  if (!verifySharedSecret(req, 'x-mail-ingest-secret', 'MAIL_INGEST_SECRET')) {
    return json(401, { error: 'unauthorized' })
  }

  const envelopeFrom = req.headers.get('x-mail-envelope-from')?.trim() ?? ''
  const envelopeTo = req.headers.get('x-mail-envelope-to')?.trim() ?? ''
  if (!envelopeFrom || !envelopeTo) return json(400, { error: 'missing envelope' })

  const allowed = parseAllowedSenders(Deno.env.get('MAIL_ALLOWED_SENDERS'))
  if (!isAllowedSender(envelopeFrom, allowed)) {
    console.warn('mail-ingest rejected sender outside the allowlist')
    return json(403, { error: 'sender not allowed' })
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_MAIL_RAW_BYTES) return json(413, { error: 'message too large' })
  const raw = new Uint8Array(await req.arrayBuffer())
  if (raw.byteLength === 0) return json(400, { error: 'empty message' })
  if (raw.byteLength > MAX_MAIL_RAW_BYTES) return json(413, { error: 'message too large' })

  let parsed: ParsedMail
  try {
    parsed = await PostalMime.parse(raw) as ParsedMail
  } catch (err) {
    console.error('mail-ingest parse failed', err instanceof Error ? err.message : String(err))
    return json(400, { error: 'unparseable message' })
  }

  const row = buildMailboxRow(parsed, { from: envelopeFrom, to: envelopeTo, rawSize: raw.byteLength })
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, getSupabaseAdminKey())

  // Cloudflare 可能重投同一封信：有 Message-ID 时按 (user_id, message_id) 去重。
  if (row.message_id) {
    const { data: existing, error: lookupError } = await supabase
      .from('mailbox_messages')
      .select('id')
      .eq('user_id', USER_ID)
      .eq('message_id', row.message_id)
      .maybeSingle()
    if (lookupError) {
      console.error('mailbox lookup failed', lookupError.message)
      return json(500, { error: 'lookup failed' })
    }
    if (existing) return json(200, { ok: true, id: existing.id, duplicate: true })
  }

  const { data, error } = await supabase
    .from('mailbox_messages')
    .insert({ user_id: USER_ID, ...row })
    .select('id')
    .single()
  if (error) {
    // 并发重投撞上唯一索引，也算收下了。
    if (error.code === '23505') return json(200, { ok: true, duplicate: true })
    console.error('mailbox insert failed', error.message)
    return json(500, { error: 'insert failed' })
  }

  return json(200, { ok: true, id: data.id })
})
