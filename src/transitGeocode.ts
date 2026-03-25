import type { LatLng } from './types'

/** In dev, Vite proxies to avoid browser CORS / odd fetch behaviour against nominatim.openstreetmap.org */
const NOMINATIM = import.meta.env.DEV ? '/nominatim' : 'https://nominatim.openstreetmap.org'

/** Nominatim requires a valid User-Agent identifying the application */
const NOMINATIM_HEADERS: HeadersInit = {
  Accept: 'application/json',
  'User-Agent': 'TrainboxTransitEditor/1.0 (local tool; https://www.openstreetmap.org/copyright)',
}

/** Public Nominatim: max ~1 reverse request per second. Pace from last request *start*, not a fixed pre-delay. */
export const NOMINATIM_REVERSE_MIN_INTERVAL_MS = 1000

export type NominatimPlace = {
  displayName: string
  lat: number
  lng: number
  south: number
  north: number
  west: number
  east: number
}

/** Search places; returns up to `limit` results with bounding boxes. */
export async function searchNominatimPlaces(
  query: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<NominatimPlace[]> {
  const q = query.trim()
  if (!q) return []
  const url = `${NOMINATIM}/search?${new URLSearchParams({
    q,
    format: 'json',
    limit: String(options?.limit ?? 8),
    addressdetails: '0',
  })}`
  const res = await fetch(url, { signal: options?.signal, headers: NOMINATIM_HEADERS })
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  const data = (await res.json()) as Array<{
    lat: string
    lon: string
    display_name: string
    boundingbox?: [string, string, string, string]
  }>
  return data.map((hit) => {
    const lat = parseFloat(hit.lat)
    const lng = parseFloat(hit.lon)
    let south = lat - 0.08
    let north = lat + 0.08
    let west = lng - 0.1
    let east = lng + 0.1
    if (hit.boundingbox && hit.boundingbox.length >= 4) {
      south = parseFloat(hit.boundingbox[0])
      north = parseFloat(hit.boundingbox[1])
      west = parseFloat(hit.boundingbox[2])
      east = parseFloat(hit.boundingbox[3])
    }
    return {
      displayName: hit.display_name,
      lat,
      lng,
      south,
      north,
      west,
      east,
    }
  })
}

/**
 * Best-effort auto name: neighbourhood → major road → minor road.
 * Dedupes by appending " (2)" if `usedNames` already has the string.
 */
export async function reverseGeocodeStationName(
  position: LatLng,
  usedNames: Set<string>,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${NOMINATIM}/reverse?${new URLSearchParams({
    lat: String(position.lat),
    lon: String(position.lng),
    format: 'json',
    addressdetails: '1',
  })}`
  const res = await fetch(url, { signal, headers: NOMINATIM_HEADERS })
  if (!res.ok) return 'Unnamed stop'
  const d = (await res.json()) as { error?: string; address?: Record<string, string> }
  if (d.error) return 'Unnamed stop'
  const a = d.address ?? {}
  const parts: string[] = []
  const n =
    a.neighbourhood ||
    a.suburb ||
    a.quarter ||
    a.city_district ||
    a.city ||
    a.town ||
    a.village ||
    ''
  if (n) parts.push(n)
  const road = a.road || a.pedestrian || a.path || ''
  if (road) parts.push(road)
  const minor = a.residential || a.neighbourhood || ''
  if (minor && minor !== n && !parts.includes(minor)) parts.push(minor)

  let base = parts.filter(Boolean).join(' · ') || road || n || 'Unnamed stop'
  base = base.replace(/\s+/g, ' ').trim()
  if (!base) base = 'Unnamed stop'

  let name = base
  let i = 2
  while (usedNames.has(name.toLowerCase())) {
    name = `${base} (${i})`
    i++
  }
  return name
}
