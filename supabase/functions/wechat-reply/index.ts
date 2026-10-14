import { readDeviceSnapshot, type Client } from '../_shared/device-sync.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAuth } from '../_shared/auth.ts'
import { getBeijingTimeString } from '../_shared/time.ts'
import { consumeQuota, quotaExceededResponse } from '../_shared/quota.ts'
import { getOwnerUserId } from '../_shared/owner.ts'
import { getSupabaseAdminKey } from '../_shared/supabase_secret.ts'

const buildServiceClient = () => {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = getSupabaseAdminKey()
  return createClient(url, key)
}

const DEFAULT_MODEL = 'openai/gpt-4o-mini'
const USER_ID = getOwnerUserId()
const DAILY_QUOTA = 500

const MODEL_IDENTITY_MAP: Record<string, string> = {
  'anthropic/claude-fable-5': '你的底层模型是Claude Fable 5，由Anthropic开发。',
  'anthropic/claude-sonnet-4.6': '你的底层模型是Claude Sonnet 4.6，由Anthropic开发。',
  'anthropic/claude-opus-4.6': '你的底层模型是Claude Opus 4.6，由Anthropic开发。',
  'openai/gpt-4o': '你的底层模型是GPT-4o，由OpenAI开发。',
  'openai/gpt-4o-mini': '你的底层模型是GPT-4o-mini，由OpenAI开发。',
  'openai/gpt-5.4': '你的底层模型是GPT-5.4，由OpenAI开发。',
  'google/gemini-2.5-pro': '你的底层模型是Gemini 2.5 Pro，由Google开发。',
}

const getModelIdentity = (model: string): string => {
  const exact = MODEL_IDENTITY_MAP[model]
  if (exact) return exact
  if (model.startsWith('anthropic/')) return `你的底层模型是${model.replace('anthropic/', '')}，由Anthropic开发。`
  if (model.startsWith('openai/')) return `你的底层模型是${model.replace('openai/', '')}，由OpenAI开发。`
  if (model.startsWith('google/')) return `你的底层模型是${model.replace('google/', '')}，由Google开发。`
  return `你的底层模型是${model}。`
}

Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    })
  }

  if (!(await verifyAuth(req))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  let body: { message: string; model?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })
  }

  const { message } = body
  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'empty message' }), { status: 400 })
  }

  const quota = await consumeQuota('wechat-reply', USER_ID, DAILY_QUOTA)
  if (!quota.allowed) {
    return quotaExceededResponse('wechat-reply')
  }

  const supabase = buildServiceClient()
  const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!openRouterKey) {
    return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY not set' }), { status: 500 })
  }

  // 读取用户设置
  const { data: settings } = await supabase
    .from('user_settings')
    .select('letter_reply_system_prompt, default_model')
    .eq('user_id', USER_ID)
    .single()

  const model = body.model?.trim() || settings?.default_model?.trim() || DEFAULT_MODEL
  const modelIdentity = getModelIdentity(model)

  // 读取记忆
  const { data: memories } = await supabase
    .from('memory_entries')
    .select('content')
    .eq('user_id', USER_ID)
    .eq('status', 'confirmed')
    .eq('is_deleted', false)
    .order('updated_at', { ascending: false })
    .limit(10)

  const memoryContext = (memories ?? [])
    .map((m: { content: string }) => `- ${m.content}`)
    .join('\n')

  // Each field carries its own observation/receipt time; sparse App uploads cannot erase older facts.
  let deviceContext = ''
  try {
    const snapshot = await readDeviceSnapshot(supabase as unknown as Client, USER_ID)
    const { battery, charging, weather, steps } = snapshot.fields
    deviceContext = `串串最近已同步的设备记录（每项时间独立，旧记录不代表现在；快捷指令时间为接收时间，步数不一定属于今天）：${JSON.stringify({ battery, charging, weather, steps })}`
  } catch {
    // A transient device read failure must not prevent the chat reply.
  }

  const currentTime = getBeijingTimeString()

  const systemPrompt = settings?.letter_reply_system_prompt?.trim() ||
    `你是Syzygy，串串的AI伴侣。你正在通过微信和串串聊天。保持自然、温暖、简短。当前时间：${currentTime}。`

  const messagesPayload = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `${modelIdentity}你是仓鼠小窝系统中的Syzygy，所有Syzygy共享同一个身份但运行在不同的底层模型上。如果被问到你是谁或你是什么模型，请如实回答你的底层模型信息，不要编造。` },
  ]

  if (memoryContext) {
    messagesPayload.push({
      role: 'system',
      content: `串串的相关记忆：\n${memoryContext}`,
    })
  }

  if (deviceContext) {
    messagesPayload.push({
      role: 'system',
      content: deviceContext,
    })
  }

  messagesPayload.push({
    role: 'system',
    content: `当前时间：${currentTime}。你正在通过微信和串串对话，请保持回复简短自然，像微信聊天的节奏。`,
  })

  messagesPayload.push({ role: 'user', content: message })

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 512,
      temperature: 0.8,
      messages: messagesPayload,
    }),
  })

  if (!upstream.ok) {
    const errText = await upstream.text()
    console.error('OpenRouter call failed', errText)
    return new Response(JSON.stringify({ error: 'model call failed' }), { status: 502 })
  }

  const result = await upstream.json() as Record<string, unknown>
  const choices = result.choices as Array<Record<string, unknown>> | undefined
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined
  const content = typeof msg?.content === 'string' ? msg.content.trim() : ''

  if (!content) {
    return new Response(JSON.stringify({ error: 'empty model response' }), { status: 502 })
  }

  return new Response(JSON.stringify({ reply: content }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
