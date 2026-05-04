import 'dotenv/config'
import { createServer } from 'node:http'
import { mapApiHandler } from '../api/lib/mapApiHandler'

const PORT = Number(process.env.MAP_API_PORT || process.env.PORT || 8787)

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

createServer(async (req, res) => {
  const host = req.headers.host || 'localhost'
  const url = new URL(req.url || '/', `http://${host}`)
  if (!url.pathname.startsWith('/api/map')) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
    res.end('Not found')
    return
  }

  const method = (req.method || 'GET').toUpperCase()
  let body = ''
  if (method === 'PUT' || method === 'POST') {
    body = await readBody(req)
  }

  try {
    const out = await mapApiHandler({ method, pathname: url.pathname, body })
    res.statusCode = out.status
    const headers = out.headers ?? {}
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v)
    }
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
    }
    res.end(out.body)
  } catch (e) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'error' }))
  }
}).listen(PORT, () => {
  console.log(`[trainbox map api] http://127.0.0.1:${PORT}`)
})
