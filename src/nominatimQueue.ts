/** Public Nominatim: max ~1 reverse request per second. */
export const NOMINATIM_REVERSE_MIN_INTERVAL_MS = 1100

let chain: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

/** Serialize Nominatim calls (~1/s) across all stations and side-street probes. */
export function enqueueNominatimRequest<T>(fn: () => Promise<T>): Promise<T> {
  const job = chain.then(async () => {
    const gap = Math.max(0, NOMINATIM_REVERSE_MIN_INTERVAL_MS - (Date.now() - lastRequestAt))
    if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    lastRequestAt = Date.now()
    return fn()
  })
  chain = job.then(
    () => undefined,
    () => undefined,
  )
  return job
}
