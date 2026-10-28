import test from 'node:test'
import assert from 'node:assert/strict'
import { musicPosition, musicSearchResult } from '../supabase/functions/hamster-life-mcp/music_contract.ts'
test('now-playing extrapolation is bounded and paused observations stay fixed', () => {
  const row = { state: 'playing', position_ms: 5000, position_at: '2026-10-28T00:00:00Z', duration_ms: 10000 }
  assert.equal(musicPosition(row, Date.parse(row.position_at) + 2000), 7000)
  assert.equal(musicPosition(row, Date.parse(row.position_at) + 999999), 10000)
  assert.equal(musicPosition({ ...row, state: 'paused' }, Date.now()), 5000)
})
test('picks cannot be invented from unavailable or unrelated search results', () => {
  const rows = [{ song_id: 12, title: 'Song', artists: 'Artist', cover_url: 'file:///secret' }]
  assert.equal(musicSearchResult(rows, 99), null)
  assert.equal(musicSearchResult([{ ...rows[0], visible: false }], 12), null)
  assert.equal(musicSearchResult(rows, 12).cover_url, null)
  assert.equal(musicSearchResult(rows, 12).title, 'Song')
})
