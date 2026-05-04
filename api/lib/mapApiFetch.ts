import { mapApiHandler } from './mapApiHandler'

/** Shared Web Handler for `/api/map/*` routes. */
export async function mapApiFetch(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const pathname = url.pathname
  const method = request.method.toUpperCase()

  let rawBody = ''
  if (method === 'POST' || method === 'PUT') {
    try {
      rawBody = await request.text()
    } catch (e) {
      console.error('[map-api] body read', e)
      return Response.json({ error: 'Invalid body' }, { status: 400 })
    }
  }

  try {
    const out = await mapApiHandler({
      method,
      pathname,
      body: rawBody,
    })
    const headers = new Headers()
    for (const [k, v] of Object.entries(out.headers ?? {})) {
      headers.set(k, v)
    }
    return new Response(out.body, { status: out.status, headers })
  } catch (e: unknown) {
    console.error('[map-api]', pathname, e)
    const msg = e instanceof Error ? e.message : 'Server error'
    return Response.json({ error: msg }, { status: 500 })
  }
}
