import type { VercelRequest, VercelResponse } from '@vercel/node'
import { mapApiHandler } from '../lib/mapApiHandler'

/** Path only — works whether Vercel sets `req.url` to a path or a full URL. */
function requestPathname(req: VercelRequest): string {
  const raw = req.url || ''
  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return new URL(raw).pathname
    }
  } catch {
    // fall through
  }
  const path = raw.split('?')[0] ?? ''
  return path.startsWith('/') ? path : `/${path}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const pathname = requestPathname(req)
  const rawBody =
    typeof req.body === 'string' ? req.body : req.body != null ? JSON.stringify(req.body) : ''
  try {
    const out = await mapApiHandler({
      method: (req.method || 'GET').toUpperCase(),
      pathname,
      body: rawBody,
    })
    res.status(out.status)
    const headers = out.headers ?? {}
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v)
    }
    res.send(out.body)
  } catch (e: unknown) {
    console.error('[map-api]', pathname, e)
    const msg = e instanceof Error ? e.message : 'Server error'
    res.status(500).setHeader('Content-Type', 'application/json; charset=utf-8')
    res.send(JSON.stringify({ error: msg }))
  }
}
