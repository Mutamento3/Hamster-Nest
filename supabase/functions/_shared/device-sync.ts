// Versioned device facts. This module is shared by the App endpoint and MCP reads.
export type SyncKind = 'battery' | 'location' | 'weather' | 'home_event'
export type SyncSample = {
  version: 1
  id: string
  owner: string
  kind: SyncKind
  observedAt: string
  deviceName: string | null
  value: Record<string, unknown>
}
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(v)
const number = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.length <= max
const iso = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) &&
  Number.isFinite(Date.parse(v))
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
const coords = (v: Record<string, unknown>) =>
  number(v.latitude, -90, 90) && number(v.longitude, -180, 180)
const appleURL = (v: unknown) => {
  if (!text(v, 1000)) return false
  try {
    const u = new URL(v as string)
    return u.protocol === 'https:' &&
      (u.hostname === 'apple.com' || u.hostname.endsWith('.apple.com'))
  } catch {
    return false
  }
}
export function parseSample(
  raw: unknown,
  owner: string,
  now = Date.now(),
): SyncSample {
  if (
    !object(raw) ||
    !keys(raw, [
      'version',
      'id',
      'owner',
      'kind',
      'observedAt',
      'deviceName',
      'value',
    ]) || raw.version !== 1 || !uuid(raw.id) || raw.owner !== owner ||
    !iso(raw.observedAt) ||
    Date.parse(raw.observedAt as string) > now + 300_000 ||
    !(raw.deviceName === null || text(raw.deviceName, 100)) ||
    !object(raw.value)
  ) throw new Error('invalid sample')
  const v = raw.value
  let valid = false
  if (raw.kind === 'battery') {
    valid = keys(v, ['level', 'charging']) &&
      (v.level === null || number(v.level, 0, 100)) &&
      (v.charging === null || typeof v.charging === 'boolean') &&
      (v.level !== null || v.charging !== null)
  }
  if (raw.kind === 'location') {
    valid =
      keys(v, ['latitude', 'longitude', 'accuracy', 'coordinateSystem']) &&
      coords(v) && v.coordinateSystem === 'WGS84' &&
      (v.accuracy === null || number(v.accuracy, 0, 1_000_000))
  }
  if (raw.kind === 'home_event') {
    valid = keys(v, ['regionId', 'direction']) && v.regionId === 'home' &&
      ['enter', 'exit'].includes(v.direction as string)
  }
  if (raw.kind === 'weather') {
    valid = keys(v, [
      'status',
      'provider',
      'fetchedAt',
      'observedAt',
      'expiresAt',
      'temperature',
      'feelsLike',
      'condition',
      'symbol',
      'isDaylight',
      'humidity',
      'windKph',
      'high',
      'low',
      'rainChance',
      'attribution',
      'latitude',
      'longitude',
      'place',
    ]) && v.status === 'ready' && v.provider === 'apple-weather' &&
      coords(v) && ['fetchedAt', 'observedAt', 'expiresAt'].every((k) =>
        iso(v[k])
      ) && v.observedAt === raw.observedAt &&
      number(v.temperature, -150, 150) && number(v.feelsLike, -150, 150) &&
      number(v.humidity, 0, 1) && number(v.windKph, 0, 1000) &&
      ['high', 'low'].every((k) => v[k] === null || number(v[k], -150, 150)) &&
      (v.rainChance === null || number(v.rainChance, 0, 1)) &&
      text(v.condition, 100) && text(v.symbol, 100) && text(v.place, 200) &&
      typeof v.isDaylight === 'boolean' && object(v.attribution) &&
      keys(v.attribution, ['lightMark', 'darkMark', 'legalURL', 'legalText']) &&
      ['lightMark', 'darkMark', 'legalURL'].every((k) =>
        appleURL((v.attribution as Record<string, unknown>)[k])
      ) && text(v.attribution.legalText, 2000)
  }
  if (!valid) throw new Error('invalid sample value')
  return raw as SyncSample
}
export function sampleRow(s: SyncSample, receivedAt: string) {
  const v = s.value
  return {
    id: s.id,
    user_id: s.owner,
    source_app: 'expo_app',
    device_name: s.deviceName,
    created_at: s.observedAt,
    battery_level: s.kind === 'battery' ? v.level : null,
    is_charging: s.kind === 'battery' ? v.charging : null,
    latitude: s.kind === 'location' ? v.latitude : null,
    longitude: s.kind === 'location' ? v.longitude : null,
    weather: s.kind === 'weather'
      ? `${v.place} · ${v.temperature}°C · ${v.condition}`
      : null,
    raw_data: {
      syncVersion: 1,
      sample: s,
      receivedAt,
      ...(s.kind === 'home_event'
        ? {
          trigger: v.direction === 'enter' ? 'geofence_enter' : 'geofence_exit',
        }
        : {}),
    },
  }
}
export const sameSample = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!object(a) || !object(b)) return false
  const names = Object.keys(a).sort()
  return names.join('|') === Object.keys(b).sort().join('|') &&
    names.every((k) => sameSample(a[k], b[k]))
}
// A small structural client boundary keeps the module executable in Node tests too.
export type Result = {
  data: Record<string, unknown>[] | null
  error: { code?: string; message?: string } | null
}
export interface Query extends PromiseLike<Result> {
  select(columns: string): Query
  eq(column: string, value: unknown): Query
  not(column: string, op: string, value: unknown): Query
  in(column: string, values: unknown[]): Query
  order(column: string, options: { ascending: boolean }): Query
  limit(n: number): Query
  insert(row: unknown): Query
}
export type Client = { from(table: string): Query }
export async function storeSamples(
  db: Client,
  owner: string,
  raw: unknown,
  now = Date.now(),
) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 24) {
    throw new Error('invalid batch')
  }
  // Validate the entire batch before the first write. Partial network failures remain replayable.
  const samples = raw.map((v) => parseSample(v, owner, now))
  if (new Set(samples.map((s) => s.id)).size !== samples.length) {
    throw new Error('duplicate batch IDs')
  }
  const accepted: string[] = []
  for (const sample of samples) {
    const result = await db.from('device_status').insert(
      sampleRow(sample, new Date(now).toISOString()),
    )
    if (result.error) {
      if (result.error.code !== '23505') throw new Error('upload unavailable')
      const existing = await db.from('device_status').select('raw_data').eq(
        'user_id',
        owner,
      ).eq('id', sample.id).limit(1)
      const data = existing.data?.[0]?.raw_data
      if (existing.error || !object(data) || !sameSample(data.sample, sample)) {
        throw new Error('sample conflict')
      }
    }
    accepted.push(sample.id)
  }
  return { version: 1, owner, accepted }
}
const COLUMNS =
  'id,user_id,created_at,source_app,device_name,battery_level,is_charging,latitude,longitude,weather,steps,step_count,raw_data'
export async function readDeviceSnapshot(
  db: Client,
  owner: string,
  now = Date.now(),
) {
  const base = () =>
    db.from('device_status').select(COLUMNS).eq('user_id', owner)
  const latest = async (q: Query) => {
    const r = await q.order('created_at', { ascending: false }).order('id', {
      ascending: false,
    }).limit(1)
    if (r.error) throw new Error('device read unavailable')
    return r.data?.[0] ?? null
  }
  const [battery, charging, location, weather, steps, oldSteps, event] =
    await Promise.all([
      latest(base().not('battery_level', 'is', null)),
      latest(base().not('is_charging', 'is', null)),
      latest(base().not('latitude', 'is', null).not('longitude', 'is', null)),
      latest(base().not('weather', 'is', null)),
      latest(base().not('steps', 'is', null)),
      latest(base().not('step_count', 'is', null)),
      latest(
        base().eq('source_app', 'expo_app').in('raw_data->>trigger', [
          'geofence_enter',
          'geofence_exit',
        ]),
      ),
    ])
  const field = (row: Record<string, unknown> | null, value: unknown) => {
    if (!row) return null
    const raw = object(row.raw_data) ? row.raw_data : {}
    return {
      id: row.id,
      observedAt: row.created_at,
      receivedAt: raw.receivedAt ?? row.created_at,
      timeBasis: raw.syncVersion === 1 ? 'observed' : 'received',
      source: row.source_app ?? 'shortcut',
      deviceName: row.device_name,
      value,
    }
  }
  const weatherRaw =
    weather && object(weather.raw_data) && object(weather.raw_data.sample)
      ? weather.raw_data.sample
      : null
  const locationRaw =
    location && object(location.raw_data) && object(location.raw_data.sample)
      ? location.raw_data.sample
      : null
  const stepRow = steps && oldSteps
    ? (String(steps.created_at) >= String(oldSteps.created_at)
      ? steps
      : oldSteps)
    : steps ?? oldSteps
  return {
    version: 1,
    owner,
    fetchedAt: new Date(now).toISOString(),
    fields: {
      battery: field(battery, battery?.battery_level),
      charging: field(charging, charging?.is_charging),
      location: field(
        location,
        locationRaw?.value ??
          {
            latitude: location?.latitude,
            longitude: location?.longitude,
            coordinateSystem: 'unknown',
            accuracy: null,
          },
      ),
      weather: field(
        weather,
        weatherRaw?.kind === 'weather'
          ? weatherRaw.value
          : { text: weather?.weather },
      ),
      steps: field(stepRow, stepRow?.steps ?? stepRow?.step_count),
      home_event: field(
        event,
        object(event?.raw_data) && event.raw_data.trigger === 'geofence_enter'
          ? 'enter'
          : 'exit',
      ),
    },
  }
}
