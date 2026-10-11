// Syzygy 信箱（syzygy@syzygycc.com）的纯函数契约：无外部依赖，供 mail-ingest、hamster-lounge-mcp
// 与 Node 单测（tests/mailbox-contract.test.mjs）共用。
//
// 链路：Cloudflare Email Routing → Email Worker（原样转发 MIME）→ mail-ingest → mailbox_messages。
// 只收不发；白名单只认 SMTP 信封发件人；附件只记清单，不存内容。

export const MAILBOX_STATUSES = ['unread', 'read', 'archived'] as const
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number]

// Worker 侧先挡一道，这里再挡一道：超过它的信直接退。
export const MAX_MAIL_RAW_BYTES = 10 * 1024 * 1024
export const MAX_MAIL_TEXT_LENGTH = 100_000
export const MAX_MAIL_SUBJECT_LENGTH = 500
export const MAIL_PREVIEW_LENGTH = 120

export const MAILBOX_LIST_COLUMNS = 'id, received_at, from_address, from_name, subject, status, attachments, text_body'
export const MAILBOX_COLUMNS = 'id, received_at, message_id, envelope_from, envelope_to, from_address, from_name, subject, sent_at, text_body, attachments, raw_size, status, read_at, metadata, created_at, updated_at'

// MAIL_ALLOWED_SENDERS：逗号 / 空白分隔的邮箱地址，不区分大小写。
export const parseAllowedSenders = (value: string | undefined | null): Set<string> =>
  new Set(
    (value ?? '')
      .split(/[\s,;]+/)
      .map((address) => address.trim().toLowerCase())
      .filter((address) => address.includes('@')),
  )

// 名单为空时一律拒收（fail closed）。
export const isAllowedSender = (envelopeFrom: string | undefined | null, allowed: Set<string>): boolean => {
  const address = (envelopeFrom ?? '').trim().toLowerCase()
  return address.length > 0 && allowed.has(address)
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
}

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower]
    const codePoint = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : lower.startsWith('#') ? Number.parseInt(lower.slice(1), 10) : Number.NaN
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
    return String.fromCodePoint(codePoint)
  })

// 只为让模型读得懂：去掉脚本 / 样式，块级标签换行，其余标签剥掉。不追求排版还原。
export const htmlToText = (html: string): string =>
  normalizeText(
    decodeEntities(
      html
        .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|section|article|blockquote|h[1-6]|tr|table|ul|ol)\s*>/gi, '\n\n')
        .replace(/<[^>]+>/g, ''),
    ),
  )

export const normalizeText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength)}\n\n…（正文过长，已截断）` : text

export const mailPreview = (textBody: string): string => {
  const flat = textBody.replace(/\s+/g, ' ').trim()
  return flat.length > MAIL_PREVIEW_LENGTH ? `${flat.slice(0, MAIL_PREVIEW_LENGTH)}…` : flat
}

// postal-mime 解析结果里我们用到的部分。
export type ParsedMail = {
  from?: { address?: string; name?: string } | null
  subject?: string | null
  messageId?: string | null
  date?: string | null
  text?: string | null
  html?: string | null
  attachments?: { filename?: string | null; mimeType?: string | null; content?: ArrayBuffer | Uint8Array | string | null }[] | null
}

export type MailEnvelope = {
  from: string
  to: string
  rawSize: number
}

export type MailboxInsertRow = {
  message_id: string | null
  envelope_from: string
  envelope_to: string
  from_address: string | null
  from_name: string | null
  subject: string | null
  sent_at: string | null
  text_body: string
  attachments: { filename: string | null; mime_type: string | null; size: number | null }[]
  raw_size: number
}

const nonBlank = (value: string | null | undefined, maxLength?: number): string | null => {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  return maxLength ? trimmed.slice(0, maxLength) : trimmed
}

const contentSize = (content: ArrayBuffer | Uint8Array | string | null | undefined): number | null => {
  if (content == null) return null
  if (typeof content === 'string') return content.length
  return content.byteLength
}

export const buildMailboxRow = (parsed: ParsedMail, envelope: MailEnvelope): MailboxInsertRow => {
  const plain = normalizeText(parsed.text ?? '')
  const body = plain || (parsed.html ? htmlToText(parsed.html) : '')
  const sentAt = parsed.date ? new Date(parsed.date) : null
  return {
    message_id: nonBlank(parsed.messageId, 998),
    envelope_from: envelope.from.trim().toLowerCase(),
    envelope_to: envelope.to.trim().toLowerCase(),
    from_address: nonBlank(parsed.from?.address)?.toLowerCase() ?? null,
    from_name: nonBlank(parsed.from?.name, 200),
    subject: nonBlank(parsed.subject, MAX_MAIL_SUBJECT_LENGTH),
    sent_at: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt.toISOString() : null,
    text_body: truncate(body, MAX_MAIL_TEXT_LENGTH),
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: nonBlank(attachment.filename, 300),
      mime_type: nonBlank(attachment.mimeType, 200),
      size: contentSize(attachment.content),
    })),
    raw_size: envelope.rawSize,
  }
}
