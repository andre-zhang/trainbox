const NOMINATIM_ORIGIN = 'https://nominatim.openstreetmap.org'

const NOMINATIM_USER_AGENT =
  'TrainboxTransitEditor/1.0 (https://github.com/andre-zhang/trainbox; transit map editor)'

/** Proxy Nominatim reverse/search from the server so the browser can call same-origin `/api/nominatim/*`. */
export async function proxyNominatim(path: 'reverse' | 'search', request: Request): Promise<Response> {
  const url = new URL(request.url)
  const upstream = new URL(`${NOMINATIM_ORIGIN}/${path}`)
  upstream.search = url.search

  const res = await fetch(upstream.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': NOMINATIM_USER_AGENT,
    },
  })

  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
    },
  })
}
