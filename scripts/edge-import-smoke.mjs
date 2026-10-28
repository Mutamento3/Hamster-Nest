// Load actual Edge entrypoints without a server or access to production services.
// Run with Deno and conversation-dispatch/deno.json for its existing import alias.
const fixtures = {
  HAMSTER_OWNER_USER_ID: '11111111-1111-4111-8111-111111111111',
  AAB_USER_ID: '22222222-2222-4222-8222-222222222222',
  SUPABASE_URL: 'https://edge-smoke.invalid',
  SUPABASE_ANON_KEY: 'local-smoke-anon',
  SUPABASE_SECRET_KEYS: JSON.stringify({ edge_functions_20260715: 'sb_secret_local_smoke' }),
}
for (const [name, value] of Object.entries(fixtures)) Deno.env.set(name, value)

let handler
Object.defineProperty(Deno, 'serve', { value: (callback) => { handler = callback } })
globalThis.fetch = () => { throw new Error('Unauthenticated smoke must not use the network') }

for (const name of [
  'conversation-dispatch', 'conversation-task-cancel', 'runtime-control',
  'tts-generate', 'device-sync', 'health-sync', 'hamster-reading-mcp',
]) {
  handler = undefined
  await import(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url).href)
  if (typeof handler !== 'function') throw new Error(`${name}: no handler registered`)
  const response = await handler(new Request(`https://edge-smoke.invalid/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))
  if (response.status !== 401) throw new Error(`${name}: expected 401, got ${response.status}`)
  console.log(`${name}: imported successfully; unauthenticated request rejected`)
}
