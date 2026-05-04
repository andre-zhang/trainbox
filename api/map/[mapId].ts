import type { VercelRequest, VercelResponse } from '@vercel/node'
import { mapApiHandler } from '../../mapApi/handler'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const mapId = typeof req.query.mapId === 'string' ? req.query.mapId : req.query.mapId?.[0]
  if (!mapId) {
    res.status(400).json({ error: 'Missing map id' })
    return
  }
  const rawBody =
    typeof req.body === 'string' ? req.body : req.body != null ? JSON.stringify(req.body) : ''
  const out = await mapApiHandler({
    method: req.method || 'GET',
    pathname: `/api/map/${mapId}`,
    body: rawBody,
  })
  res.status(out.status)
  const headers = out.headers ?? {}
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v)
  }
  res.send(out.body)
}
