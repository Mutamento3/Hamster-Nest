import { z } from 'npm:zod@^4.1.13'
import type { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js'
import { supabase, USER_ID, jsonResult } from '../_shared/mcp_common.ts'
import { MUSIC_PORTS, musicPosition, musicSearchResult } from './music_contract.ts'

const fail = () => ({ isError: true, content: [{ type: 'text' as const, text: '音乐操作未确认，请按请求ID或歌曲ID重新读取；不要重复盲写。' }] })
const port = z.enum(MUSIC_PORTS).describe('真实端口署名；官端GPT用gpt、官端Claude用claude')
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export function registerMusicTools(server: McpServer) {
  server.registerTool('music_search', {
    description: '搜网易云歌曲，交给Mini执行。返回请求ID；pending时用music_search_result读取，未完成不能猜歌曲ID。五分钟内复用相同搜索。',
    inputSchema: { query: z.string().trim().min(1).max(100), requested_by: port },
  }, async ({ query, requested_by }) => {
    try {
      const { data: cached, error } = await supabase.from('music_search_requests').select('*').eq('user_id', USER_ID).eq('query', query).in('status', ['pending', 'done']).gte('created_at', new Date(Date.now() - 300000).toISOString()).order('created_at', { ascending: false }).limit(5)
      if (error) return fail()
      const reusable = cached?.find(r => r.status === 'done' || Date.now() - Date.parse(r.created_at) < 120000)
      if (reusable) return jsonResult(reusable)
      const result = await supabase.from('music_search_requests').insert({ user_id: USER_ID, query, requested_by }).select('*').single()
      return result.error ? fail() : jsonResult(result.data)
    } catch { return fail() }
  })
  server.registerTool('music_search_result', {
    description: '读取一次搜歌结果。pending表示Mini尚未完成，failed可重新搜索；仅使用结果里的真实歌曲ID。',
    inputSchema: { request_id: z.string().uuid() },
  }, async ({ request_id }) => {
    const r = await supabase.from('music_search_requests').select('*').eq('user_id', USER_ID).eq('id', request_id).maybeSingle()
    return r.error ? fail() : jsonResult(r.data ?? { status: 'missing' })
  })
  server.registerTool('music_pick_song', {
    description: '从已完成搜索中给串串点一首歌，写下理由。自动同步网易云歌单；相同歌曲原样返回，保留原署名和理由。不会自动开始播放。',
    inputSchema: { request_id: z.string().uuid(), song_id: id, picked_by: port, note: z.string().trim().min(1).max(2000) },
  }, async ({ request_id, song_id, picked_by, note }) => {
    const search = await supabase.from('music_search_requests').select('results').eq('user_id', USER_ID).eq('id', request_id).eq('status', 'done').maybeSingle()
    const song = musicSearchResult(search.data?.results, song_id)
    if (search.error || !song) return { isError: true, content: [{ type: 'text' as const, text: '这首歌不在可用搜索结果中，请先搜歌。' }] }
    const write = await supabase.from('music_song_picks').upsert({ ...song, user_id: USER_ID, picked_by, note }, { onConflict: 'user_id,song_id', ignoreDuplicates: true })
    const r = await supabase.from('music_song_picks').select('*').eq('user_id', USER_ID).eq('song_id', song_id).maybeSingle()
    if (r.error || !r.data) return fail()
    return jsonResult({ pick: r.data, write_confirmed: !write.error, url: `https://music.163.com/#/song?id=${song_id}` })
  })
  server.registerTool('music_list_picks', {
    description: '读取音乐歌单与点歌理由。分页返回，不含音频地址。',
    inputSchema: { include_hidden: z.boolean().optional(), offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(50).optional() },
  }, async ({ include_hidden, offset = 0, limit = 30 }) => {
    let q = supabase.from('music_song_picks').select('*').eq('user_id', USER_ID).order('created_at', { ascending: false }).order('id').range(offset, offset + limit)
    if (!include_hidden) q = q.eq('status', 'active')
    const r = await q
    return r.error ? fail() : jsonResult({ picks: r.data?.slice(0, limit), has_more: (r.data?.length ?? 0) > limit })
  })
  server.registerTool('music_update_pick_note', {
    description: '明确修改一首点歌的理由；先读歌单取得updated_at，冲突时重新读取，不覆盖其他端的新内容。',
    inputSchema: { pick_id: z.string().uuid(), expected_updated_at: z.string().datetime({ offset: true }), note: z.string().trim().max(2000) },
  }, async ({ pick_id, expected_updated_at, note }) => {
    const r = await supabase.from('music_song_picks').update({ note }).eq('user_id', USER_ID).eq('id', pick_id).eq('updated_at', expected_updated_at).select('*').maybeSingle()
    return r.error ? fail() : jsonResult(r.data ?? { status: 'conflict', message: '记录已变化，请重新读歌单。' })
  })
  server.registerTool('music_now_playing', {
    description: '读取App最近上报的播放状态与点歌理由。position_ms_estimate是推算值；observed_at可能过时，不代表用户仍在线或正在听。',
    inputSchema: {},
  }, async () => {
    const r = await supabase.from('music_now_playing').select('*').eq('user_id', USER_ID).maybeSingle()
    if (r.error) return fail()
    if (!r.data) return jsonResult({ status: 'not_reported' })
    const pick = r.data.pick_id ? await supabase.from('music_song_picks').select('note,picked_by').eq('user_id', USER_ID).eq('id', r.data.pick_id).maybeSingle() : null
    return jsonResult({ ...r.data, ...pick?.data, position_ms_estimate: musicPosition(r.data), observed_at: r.data.updated_at, live_presence_confirmed: false })
  })
}
