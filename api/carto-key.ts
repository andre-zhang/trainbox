/** CARTO basemap key, read at request time so it doesn't depend on build-time env inlining. It is public by design (sent on every tile URL). */
export default {
  fetch() {
    const key = (process.env.CARTO_API_KEY || process.env.VITE_CARTO_API_KEY || '').trim()
    return Response.json({ key }, { headers: { 'Cache-Control': 'no-store' } })
  },
}
