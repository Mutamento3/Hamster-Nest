import assert from 'node:assert/strict'
import test from 'node:test'

const { COUNCIL_PREVIEW_LENGTH, councilPreview, summarizeCouncilRow } = await import(
  '../supabase/functions/hamster-lounge-mcp/council_read.ts'
)

test('council preview flattens whitespace and truncates long proposals', () => {
  assert.equal(councilPreview('**性质**：\n\n发散提案  不指派'), '**性质**： 发散提案 不指派')
  const long = '游'.repeat(COUNCIL_PREVIEW_LENGTH + 50)
  assert.equal(councilPreview(long), `${'游'.repeat(COUNCIL_PREVIEW_LENGTH)}…`)
  assert.equal(councilPreview(null), '')
})

test('council summary keeps routing fields and drops body, metadata and read receipts', () => {
  const summary = summarizeCouncilRow({
    id: 'p1',
    user_id: 'u1',
    parent_id: null,
    speaker: 'claude',
    topic: '游记板块',
    message: 'x'.repeat(5000),
    entry_type: 'proposal',
    proposal_status: 'open',
    vote: null,
    category: 'app',
    executor: null,
    metadata: { big: 'y'.repeat(5000) },
    read_by: ['gpt'],
    created_at: '2026-10-14T11:43:19Z',
    updated_at: '2026-10-14T11:43:19Z',
  })
  assert.equal(summary.topic, '游记板块')
  assert.equal(summary.message_length, 5000)
  assert.equal('message' in summary, false)
  assert.equal('metadata' in summary, false)
  assert.equal('read_by' in summary, false)
  assert.ok(JSON.stringify(summary).length < 600)
})
