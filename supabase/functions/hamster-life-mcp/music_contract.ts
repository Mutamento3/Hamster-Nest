export const MUSIC_PORTS = ['chuanchuan', 'claude', 'gpt', 'gemini', 'codex_cli', 'claude_code_cli'] as const
export function musicPosition(row: { state: string; position_ms: number; position_at: string; duration_ms: number | null }, now = Date.now()) {
  const elapsed = row.state === 'playing' ? Math.max(0, now - Date.parse(row.position_at)) : 0
  return Math.min(row.duration_ms ?? 86400000, Math.max(0, row.position_ms + (Number.isFinite(elapsed) ? elapsed : 0)))
}
export function musicSearchResult(value: unknown, songId: number) {
  if (!Array.isArray(value)) return null
  const row = value.find(v => v && typeof v === 'object' && Number(v.song_id) === songId)
  if (!row || row.visible === false || typeof row.title !== 'string' || !row.title.trim()) return null
  return {
    song_id: songId, title: row.title.slice(0, 200),
    artists: typeof row.artists === 'string' ? row.artists.slice(0, 300) : null,
    album: typeof row.album === 'string' ? row.album.slice(0, 200) : null,
    cover_url: typeof row.cover_url === 'string' && /^https:\/\//.test(row.cover_url) ? row.cover_url.slice(0, 1000) : null,
    duration_ms: Number.isInteger(row.duration_ms) && row.duration_ms >= 0 && row.duration_ms <= 86400000 ? row.duration_ms : null,
    encrypted_id: typeof row.encrypted_id === 'string' && /^[a-f\d]{32}$/i.test(row.encrypted_id) ? row.encrypted_id : null,
  }
}
