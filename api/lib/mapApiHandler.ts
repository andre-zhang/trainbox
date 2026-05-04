import { neon } from '@neondatabase/serverless'

const MAP_ID_RE = /^[0-9]{4}$/

const EMPTY_MAP_VERSION = 4
const EMPTY_MIN_READER = 2

function emptyPayloadString(): string {
  return JSON.stringify({
    version: EMPTY_MAP_VERSION,
    minReaderVersion: EMPTY_MIN_READER,
    stations: [],
    lines: [],
    stationLabelOverrides: {},
  })
}

let schemaReady: Promise<void> | null = null

function getSql() {
  const url = process.env.DATABASE_URL
  if (!url || typeof url !== 'string') {
    throw new Error('DATABASE_URL is not set')
  }
  return neon(url)
}

function ensureSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS transit_maps (
          id VARCHAR(4) PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `
      await sql`
        CREATE INDEX IF NOT EXISTS transit_maps_updated_at_idx ON transit_maps (updated_at DESC)
      `
    })()
  }
  return schemaReady
}

function randomFourDigitId(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

async function allocateMapId(sql: ReturnType<typeof getSql>): Promise<string> {
  const empty = emptyPayloadString()
  for (let attempt = 0; attempt < 80; attempt++) {
    const id = randomFourDigitId()
    try {
      await sql`
        INSERT INTO transit_maps (id, payload)
        VALUES (${id}, ${empty}::jsonb)
      `
      return id
    } catch (e: unknown) {
      const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: string }).code) : ''
      if (code === '23505') continue
      throw e
    }
  }
  throw new Error('Could not allocate a free map id')
}

function isPayloadShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  if (typeof o.version !== 'number' || !Array.isArray(o.stations) || !Array.isArray(o.lines)) return false
  if (o.stationLabelOverrides != null && typeof o.stationLabelOverrides !== 'object') return false
  return true
}

export type MapApiInput = {
  method: string
  pathname: string
  /** Raw body for PUT (JSON string). */
  body: string
}

export type MapApiResult = {
  status: number
  headers?: Record<string, string>
  body: string
}

/**
 * Handles `/api/map/create` (POST) and `/api/map/:id` (GET, PUT).
 */
export async function mapApiHandler(input: MapApiInput): Promise<MapApiResult> {
  const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' }

  try {
    const sql = getSql()
    await ensureSchema(sql)

    if (input.pathname === '/api/map/create') {
      if (input.method !== 'POST') {
        return { status: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) }
      }
      const id = await allocateMapId(sql)
      return { status: 201, headers: jsonHeaders, body: JSON.stringify({ id }) }
    }

    const prefix = '/api/map/'
    if (!input.pathname.startsWith(prefix)) {
      return { status: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Not found' }) }
    }

    const mapId = input.pathname.slice(prefix.length).split('/')[0] ?? ''
    if (!MAP_ID_RE.test(mapId)) {
      return { status: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid map id' }) }
    }

    if (input.method === 'GET') {
      const rows = await sql`SELECT payload FROM transit_maps WHERE id = ${mapId}`
      const row = rows[0] as { payload: unknown } | undefined
      if (!row) {
        return { status: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Map not found' }) }
      }
      const payload = row.payload
      return {
        status: 200,
        headers: jsonHeaders,
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }
    }

    if (input.method === 'PUT') {
      let parsed: unknown
      try {
        parsed = JSON.parse(input.body || '{}')
      } catch {
        return { status: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) }
      }
      if (!isPayloadShape(parsed)) {
        return { status: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid map payload' }) }
      }
      const bodyStr = JSON.stringify(parsed)
      const updated = await sql`
        UPDATE transit_maps
        SET payload = ${bodyStr}::jsonb, updated_at = NOW()
        WHERE id = ${mapId}
        RETURNING id
      `
      const ok = updated.length > 0
      if (!ok) {
        return { status: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Map not found' }) }
      }
      return { status: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) }
    }

    return { status: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Server error'
    return { status: 500, headers: jsonHeaders, body: JSON.stringify({ error: msg }) }
  }
}
