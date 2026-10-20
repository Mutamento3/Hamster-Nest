// council_read 的摘要视图：纯函数，供 Edge Function 与 Node 单测（tests/council-read.test.mjs）共用。
//
// 议事厅的提案正文动辄几千字，列表一次全倒出来会撑爆模型的单次读取（2026-10-20 读 20 条提案约 5.4 万字符）。
// 所以列表默认只给摘要：标题、状态、分类、执行方和一行预览；正文按 id 再读，同 Feed / 信箱的两步读法。

export const COUNCIL_PREVIEW_LENGTH = 120

export const councilPreview = (message: string | null | undefined): string => {
  const flat = (message ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > COUNCIL_PREVIEW_LENGTH ? `${flat.slice(0, COUNCIL_PREVIEW_LENGTH)}…` : flat
}

export type CouncilRow = {
  id: string
  parent_id: string | null
  speaker: string
  topic: string | null
  message: string | null
  entry_type: string
  proposal_status: string | null
  vote: string | null
  category: string | null
  executor: string | null
  created_at: string
  updated_at: string
  [key: string]: unknown
}

export const summarizeCouncilRow = (row: CouncilRow) => ({
  id: row.id,
  parent_id: row.parent_id,
  speaker: row.speaker,
  topic: row.topic,
  entry_type: row.entry_type,
  proposal_status: row.proposal_status,
  vote: row.vote,
  category: row.category,
  executor: row.executor,
  created_at: row.created_at,
  updated_at: row.updated_at,
  message_preview: councilPreview(row.message),
  message_length: (row.message ?? '').length,
})
