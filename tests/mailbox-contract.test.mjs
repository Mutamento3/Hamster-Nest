import assert from 'node:assert/strict'
import test from 'node:test'

const {
  MAX_MAIL_TEXT_LENGTH,
  buildMailboxRow,
  htmlToText,
  isAllowedSender,
  mailPreview,
  parseAllowedSenders,
} = await import('../supabase/functions/_shared/mailbox.ts')

test('allowlist is case-insensitive and fails closed when empty', () => {
  const allowed = parseAllowedSenders(' Owner@Example.com, second@example.org;\nnot-an-address ')
  assert.deepEqual([...allowed].sort(), ['owner@example.com', 'second@example.org'])
  assert.equal(isAllowedSender('OWNER@example.com ', allowed), true)
  assert.equal(isAllowedSender('stranger@example.com', allowed), false)
  assert.equal(isAllowedSender('', allowed), false)

  const empty = parseAllowedSenders(undefined)
  assert.equal(empty.size, 0)
  assert.equal(isAllowedSender('owner@example.com', empty), false)
})

test('HTML bodies become readable text without scripts or styles', () => {
  const text = htmlToText(
    '<html><head><title>t</title><style>p{color:red}</style></head><body>' +
      '<p>你好&nbsp;<b>主人</b></p><script>alert(1)</script>' +
      '<ul><li>一</li><li>二</li></ul><p>A&amp;B &#x4E32;&#20018; &hellip;</p></body></html>',
  )
  assert.equal(text, '你好 主人\n\n- 一\n- 二\n\nA&B 串串 &hellip;')
})

test('plain text wins over HTML and the row keeps only attachment metadata', () => {
  const row = buildMailboxRow({
    from: { address: 'Owner@Example.com', name: ' 串串 ' },
    subject: '  转发：一篇文章  ',
    messageId: '<abc@x>',
    date: 'Sun, 11 Oct 2026 17:00:00 +0800',
    text: '第一行\r\n\r\n\r\n第二行   ',
    html: '<p>不该用到</p>',
    attachments: [{ filename: 'a.jpg', mimeType: 'image/jpeg', content: new Uint8Array(42) }],
  }, { from: ' Owner@Example.com ', to: 'Syzygy@SyzygyCC.com', rawSize: 2048 })

  assert.deepEqual(row, {
    message_id: '<abc@x>',
    envelope_from: 'owner@example.com',
    envelope_to: 'syzygy@syzygycc.com',
    from_address: 'owner@example.com',
    from_name: '串串',
    subject: '转发：一篇文章',
    sent_at: '2026-10-11T09:00:00.000Z',
    text_body: '第一行\n\n第二行',
    attachments: [{ filename: 'a.jpg', mime_type: 'image/jpeg', size: 42 }],
    raw_size: 2048,
  })
})

test('HTML-only mail, missing headers and oversized bodies are handled', () => {
  const row = buildMailboxRow({
    html: `<p>${'长'.repeat(MAX_MAIL_TEXT_LENGTH + 10)}</p>`,
    date: 'not a date',
  }, { from: 'owner@example.com', to: 'syzygy@syzygycc.com', rawSize: 10 })

  assert.equal(row.message_id, null)
  assert.equal(row.from_address, null)
  assert.equal(row.subject, null)
  assert.equal(row.sent_at, null)
  assert.deepEqual(row.attachments, [])
  assert.ok(row.text_body.startsWith('长'.repeat(MAX_MAIL_TEXT_LENGTH)))
  assert.ok(row.text_body.endsWith('（正文过长，已截断）'))
})

test('previews flatten whitespace and stop at 120 characters', () => {
  assert.equal(mailPreview('  一\n\n二   三 '), '一 二 三')
  const long = mailPreview('字'.repeat(200))
  assert.equal(long, `${'字'.repeat(120)}…`)
})
