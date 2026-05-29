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

/** Trailing street-type tokens (St, Ave, Rd, …) stripped for display names. */
const STREET_SUFFIX_RE =
  /\s+(Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Way|Court|Ct\.?|Place|Pl\.?|Crescent|Cres\.?|Circle|Cir\.?|Terrace|Ter\.?|Trail|Trl\.?|Highway|Hwy\.?|Parkway|Pkwy\.?|Square|Sq\.?|Gate|Route|Rte\.?|Close|Crescent)$/i

function stripStreetSuffix(name: string): string {
  let s = name.replace(/\s+/g, ' ').trim()
  while (STREET_SUFFIX_RE.test(s)) {
    s = s.replace(STREET_SUFFIX_RE, '').trim()
  }
  return s
}

function communityFromAddress(address: Record<string, string>): string {
  return (address.neighbourhood || address.suburb || address.quarter || address.city_district || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Unique street labels from Nominatim address fields, suffix stripped. */
function streetPartsFromAddress(address: Record<string, string>): string[] {
  const raw = [
    address.road,
    address.street,
    address.pedestrian,
    address.residential,
    address.living_street,
    address.footway,
    address.path,
    address.cycleway,
  ].filter(Boolean) as string[]
  const out: string[] = []
  for (const part of raw) {
    const cleaned = stripStreetSuffix(part)
    if (!cleaned) continue
    if (out.some((x) => x.toLowerCase() === cleaned.toLowerCase())) continue
    out.push(cleaned)
  }
  return out
}

/**
 * Name candidates in preference order:
 * 1) primary street only (no Rd/Ave/St suffix)
 * 2) street1 / street2 when two distinct streets are present
 * 3) community / street
 * 4) community alone if no street
 * 5) fallback
 */
function buildStationNameCandidates(community: string, streets: string[]): string[] {
  const candidates: string[] = []
  if (streets.length >= 1) candidates.push(streets[0])
  if (streets.length >= 2) candidates.push(`${streets[0]} / ${streets[1]}`)
  if (community && streets.length >= 1) candidates.push(`${community} / ${streets[0]}`)
  if (community && streets.length === 0) candidates.push(community)
  candidates.push('Unnamed stop')
  return [...new Set(candidates)]
}

function firstUnusedStationName(candidates: string[], usedNames: Set<string>): string | null {
  for (const base of candidates) {
    if (!usedNames.has(base.toLowerCase())) return base
  }
  return null
}

/** ~15–25 m offsets to pick up a nearby cross street when the primary name is taken. */
const SIDE_STREET_OFFSETS: { lat: number; lng: number }[] = [
  { lat: 0.00018, lng: 0 },
  { lat: -0.00018, lng: 0 },
  { lat: 0, lng: 0.00018 },
  { lat: 0, lng: -0.00018 },
  { lat: 0.00013, lng: 0.00013 },
  { lat: -0.00013, lng: -0.00013 },
]

type ReverseAddressInfo = { community: string; streets: string[] }

async function fetchReverseAddress(
  position: LatLng,
  signal?: AbortSignal,
): Promise<ReverseAddressInfo | null> {
  const url = `${NOMINATIM}/reverse?${new URLSearchParams({
    lat: String(position.lat),
    lon: String(position.lng),
    format: 'json',
    addressdetails: '1',
  })}`
  const res = await fetch(url, { signal, headers: NOMINATIM_HEADERS })
  if (!res.ok) return null
  const d = (await res.json()) as { error?: string; address?: Record<string, string> }
  if (d.error) return null
  const address = d.address ?? {}
  return {
    community: communityFromAddress(address),
    streets: streetPartsFromAddress(address),
  }
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
 * Auto name from reverse geocode. Prefers a single street name (suffix stripped), then
 * street / street, then community / street. When every candidate is taken, probes nearby
 * points for an alternate cross street — never appends " (2)" style suffixes.
 */
export async function reverseGeocodeStationName(
  position: LatLng,
  usedNames: Set<string>,
  signal?: AbortSignal,
): Promise<string> {
  const primary = await fetchReverseAddress(position, signal)
  if (!primary) return 'Unnamed stop'

  const primaryName = firstUnusedStationName(
    buildStationNameCandidates(primary.community, primary.streets),
    usedNames,
  )
  if (primaryName) return primaryName

  const triedStreets = new Set(primary.streets.map((s) => s.toLowerCase()))
  for (const off of SIDE_STREET_OFFSETS) {
    const alt = await fetchReverseAddress(
      { lat: position.lat + off.lat, lng: position.lng + off.lng },
      signal,
    )
    if (!alt) continue
    for (const street of alt.streets) {
      if (triedStreets.has(street.toLowerCase())) continue
      triedStreets.add(street.toLowerCase())
      const community = alt.community || primary.community
      const fromSideStreet = firstUnusedStationName(
        buildStationNameCandidates(community, [street, ...primary.streets]),
        usedNames,
      )
      if (fromSideStreet) return fromSideStreet
    }
  }

  return firstUnusedStationName(['Unnamed stop'], usedNames) ?? 'Unnamed stop'
}
