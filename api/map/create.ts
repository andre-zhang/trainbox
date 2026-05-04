import type { VercelRequest, VercelResponse } from '@vercel/node'
import { mapApiHandler } from '../../mapApi/handler'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const body = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : ''
  const out = await mapApiHandler({
    method: req.method || 'GET',
    pathname: '/api/map/create',
    body,
  })
  res.status(out.status)
  const headers = out.headers ?? {}
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v)
  }
  res.send(out.body)
}
