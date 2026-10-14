import {
  type Client,
  object,
  readDeviceSnapshot,
  storeSamples,
} from '../_shared/device-sync.ts'
export function deviceSyncHandler(
  deps: {
    verify: (
      req: Request,
    ) => Promise<
      { ok: true; userId: string } | {
        ok: false
        status: number
        error: string
      }
    >
    owner: string
    client: Client
    allowedOrigin: (origin: string) => boolean
  },
) {
  return async (req: Request) => {
    const origin = req.headers.get('origin')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    }
    if (origin && !deps.allowedOrigin(origin)) {
      return new Response(null, { status: 403, headers })
    }
    if (origin) {
      Object.assign(headers, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers':
          'authorization,apikey,content-type,x-client-info',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
      })
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers })
    if (req.method !== 'POST') {
      return reply({ error: 'method not allowed' }, 405)
    }
    if (!req.headers.get('authorization') || !req.headers.get('apikey')) {
      return reply({ error: 'unauthorized' }, 401)
    }
    const auth = await deps.verify(req)
    if (!auth.ok) return reply({ error: auth.error }, auth.status)
    if (auth.userId !== deps.owner) return reply({ error: 'forbidden' }, 403)
    try {
      const raw = await req.text()
      if (raw.length > 128_000) return reply({ error: 'batch too large' }, 413)
      const body: unknown = JSON.parse(raw)
      if (!object(body) || body.owner !== auth.userId) {
        return reply({ error: 'invalid owner' }, 400)
      }
      const db = deps.client
      if (body.action === 'read') {
        return reply(await readDeviceSnapshot(db, auth.userId))
      }
      if (body.action === 'upload') {
        return reply(await storeSamples(db, auth.userId, body.samples))
      }
      return reply({ error: 'invalid action' }, 400)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const status = message === 'sample conflict'
        ? 409
        : /^(invalid|duplicate)/.test(message) || error instanceof SyntaxError
        ? 400
        : 503
      return reply(
        { error: status === 503 ? 'sync unavailable' : message },
        status,
      )
    }
  }
}
