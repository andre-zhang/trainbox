/**
 * OSM / Overpass import for Trainbox — multi-mode, merge, post-process.
 */

import type { LatLng, Line, Station, StationLabelOverride, TransitMode } from './types'
import { getLineMode } from './types'

export const SAVE_VERSION = 4

const OVERPASS_ENDPOINTS_PUBLIC = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/** Same-origin in Vite dev (proxied) avoids CORS / flaky browser cross-origin POST. */
function overpassEndpoints(): string[] {
  if (import.meta.env.DEV) {
    return ['/overpass/api/interpreter', ...OVERPASS_ENDPOINTS_PUBLIC]
  }
  return [...OVERPASS_ENDPOINTS_PUBLIC]
}

export type ImportModeFlags = {
  metro: boolean
  lightRail: boolean
  bus: boolean
  /** OSM route=train with regional-style tagging (commuter, regional, …) */
  regionalRail: boolean
  /** OSM route=train long-distance / high-speed / untagged intercity-style */
  nationalRail: boolean
}

export const DEFAULT_IMPORT_MODES: ImportModeFlags = {
  metro: true,
  lightRail: false,
  bus: false,
  regionalRail: false,
  nationalRail: false,
}

/** Distinct palette so imports aren’t one color */
export const IMPORT_LINE_COLORS = [
  '#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0d9488', '#ea580c',
  '#4f46e5', '#16a34a', '#ca8a04', '#9333ea', '#e11d48', '#0284c7', '#65a30d', '#c026d3',
  '#0f766e', '#b45309', '#6366f1', '#dc2626', '#2563eb',
]

function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)))
}

function clampBbox(south: number, west: number, north: number, east: number): { south: number; west: number; north: number; east: number } {
  const maxLat = 0.55
  const maxLng = 0.72
  const clat = (south + north) / 2
  const clng = (west + east) / 2
  let h = north - south
  let w = east - west
  if (h > maxLat) {
    h = maxLat
    south = clat - h / 2
    north = clat + h / 2
  }
  if (w > maxLng) {
    w = maxLng
    west = clng - w / 2
    east = clng + w / 2
  }
  return { south, west, north, east }
}

/** Shown when OSM has no usable name; reverse geocode replaces this after import if enabled */
export const UNNAMED_STOP_PLACEHOLDER = 'Unnamed stop'

/** True when OSM uses a useless generic label — treat like missing name */
function isGenericStopPlaceholder(s: string): boolean {
  const t = s.trim()
  if (!t) return true
  return /^(stop|bus\s*stop|halt|fermata|arrêt|arret|unnamed)$/i.test(t)
}

/**
 * Names that should be replaced by reverse geocode after import (no stop numbers / refs as final labels).
 */
export function isPlaceholderStopName(name: string): boolean {
  const n = (name || '').trim()
  if (!n || n === '·') return true
  if (n === UNNAMED_STOP_PLACEHOLDER) return true
  if (/^stop$/i.test(n)) return true
  if (/^ref\s+/i.test(n)) return true
  if (/^node\s+\d+$/i.test(n)) return true
  if (/^stop\s+\d+$/i.test(n)) return true
  if (/^station\s+\d+$/i.test(n)) return true
  return false
}

/** Merge any two imported stops within this distance (m), regardless of name. */
export const IMPORT_STATION_MERGE_RADIUS_M = 165

/**
 * If normalized names match (and aren’t placeholders), merge up to this distance (m).
 * Larger than {@link IMPORT_STATION_MERGE_RADIUS_M} so same-named duplicates across blocks merge.
 */
export const IMPORT_STATION_MERGE_SAME_NAME_RADIUS_M = 280

function importStationNamesCompatibleForMerge(nameA: string, nameB: string): boolean {
  if (isPlaceholderStopName(nameA) || isPlaceholderStopName(nameB)) return false
  const na = (nameA || '').trim().toLowerCase()
  const nb = (nameB || '').trim().toLowerCase()
  return na.length > 0 && na === nb
}

/** Used when merging imported stops together and when snapping import onto an existing map. */
export function postImportStationsShouldMerge(a: Station, b: Station): boolean {
  const d = haversineM(a.position, b.position)
  if (d <= IMPORT_STATION_MERGE_RADIUS_M) return true
  if (d <= IMPORT_STATION_MERGE_SAME_NAME_RADIUS_M && importStationNamesCompatibleForMerge(a.name, b.name)) return true
  return false
}

function degreesLatForMeters(m: number): number {
  return m / 111320
}

function degreesLngForMetersAtLat(m: number, lat: number): number {
  const denom = 111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return m / denom
}

function stationCellKey(s: Station, latStep: number, lngStepAtLat0: number): string {
  const yi = Math.floor(s.position.lat / latStep)
  const xi = Math.floor(s.position.lng / lngStepAtLat0)
  return `${yi}|${xi}`
}

function neighborCellKeys(s: Station, latStep: number, lngStepAtLat0: number): string[] {
  const yi = Math.floor(s.position.lat / latStep)
  const xi = Math.floor(s.position.lng / lngStepAtLat0)
  const out: string[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      out.push(`${yi + dy}|${xi + dx}`)
    }
  }
  return out
}

/**
 * Strip junk including TTC-only style names. Uses OSM tags only (not GTFS files).
 * If mappers copied GTFS into OSM, we read e.g. gtfs:stop_name / gtfs:stop_code from the node.
 */
export function cleanStationNameForOsm(name: string | undefined, tags: Record<string, string>): string {
  const raw = (name ?? '').trim()
  const badOperators = /^(ttc|mta|stm|bart|cta)$/i
  const isNumericOnly = (s: string) => /^[\d\s\-#]+$/.test(s) && /\d/.test(s) && !/[a-z]/i.test(s)

  if (raw && badOperators.test(raw)) {
    const alt = tags['name:en'] || tags['official_name'] || tags.ref || tags.local_ref
    if (alt && !badOperators.test(alt.trim())) return alt.trim()
  }

  if (raw && !isGenericStopPlaceholder(raw) && !isNumericOnly(raw) && raw.length < 80) return raw

  const candidates = [
    tags['name:en'],
    tags['official_name'],
    tags['alt_name']?.split(';')[0],
    tags['naptan:CommonName'],
    tags['gtfs:stop_name'],
    tags['gtfs:stop_code'],
    tags.local_ref,
    tags.ref,
    tags.uic_ref,
    tags['ref:IFOPT'],
  ]
  for (const c of candidates) {
    const p = (c ?? '').trim()
    if (!p || badOperators.test(p) || isGenericStopPlaceholder(p)) continue
    if (isNumericOnly(p)) continue
    return p
  }

  if (tags.ref) {
    const r = tags.ref.trim()
    if (r && !isGenericStopPlaceholder(r) && !isNumericOnly(r)) return r
  }
  if (tags.local_ref) {
    const r = tags.local_ref.trim()
    if (r && !isGenericStopPlaceholder(r) && !isNumericOnly(r)) return r
  }

  if (raw && !isNumericOnly(raw) && !isGenericStopPlaceholder(raw)) return raw
  return UNNAMED_STOP_PLACEHOLDER
}

/** OSM route=* value — train handled separately via {@link classifyOsmTrainRoute} */
function parseOsmRouteKind(route: string): 'train' | TransitMode | null {
  const r = route.toLowerCase()
  if (r === 'train') return 'train'
  if (['subway', 'metro', 'rapid_transit', 'heavy_rail'].includes(r)) return 'metro'
  if (['tram', 'light_rail', 'tram_train', 'monorail'].includes(r)) return 'light_rail'
  if (['bus', 'trolleybus'].includes(r)) return 'bus'
  return null
}

/**
 * Split OSM route=train into regional vs national using `service=*` and light heuristics.
 * Freight-only routes are skipped.
 */
export function classifyOsmTrainRoute(tags: Record<string, string>): 'regional_rail' | 'national_rail' | null {
  const s = (tags.service || '').toLowerCase().trim()
  if (s === 'freight') return null

  const regional = new Set(['commuter', 'regional', 'suburban', 'feeder'])
  const national = new Set([
    'long_distance',
    'high_speed',
    'cross_country',
    'international',
    'night_train',
    'car_shuttle_train',
    'vehicle_transport_train',
    'tourist',
  ])

  if (regional.has(s)) return 'regional_rail'
  if (national.has(s)) return 'national_rail'

  const blob = `${tags.network || ''} ${tags.operator || ''} ${tags.name || ''}`.toLowerCase()
  if (
    /\b(commuter|s-bahn|sbahn|\brer\b|go transit|metrolinx|caltrain|sounder|marc train|septa regional)\b/i.test(
      blob,
    )
  )
    return 'regional_rail'

  // Untagged or unknown service: treat as national/intercity (e.g. many VIA relations)
  return 'national_rail'
}

function routeMatchesFlags(route: string, tags: Record<string, string>, flags: ImportModeFlags): boolean {
  const k = parseOsmRouteKind(route)
  if (k == null) return false
  if (k === 'train') {
    const rail = classifyOsmTrainRoute(tags)
    if (rail == null) return false
    if (rail === 'regional_rail') return flags.regionalRail
    return flags.nationalRail
  }
  if (k === 'metro') return flags.metro
  if (k === 'light_rail') return flags.lightRail
  if (k === 'bus') return flags.bus
  return false
}

function osmRouteToLineMode(route: string, tags: Record<string, string>): TransitMode | null {
  const k = parseOsmRouteKind(route)
  if (k == null) return null
  if (k === 'train') return classifyOsmTrainRoute(tags)
  return k
}

type OverpassElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  tags?: Record<string, string>
  members?: { type: string; ref: number; role: string }[]
}

async function fetchOverpass(query: string, signal?: AbortSignal): Promise<{ elements?: OverpassElement[] }> {
  let lastErr: Error | null = null
  for (const base of overpassEndpoints()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 110000)
      const onParentAbort = () => ctrl.abort()
      if (signal) signal.addEventListener('abort', onParentAbort)
      try {
        const res = await fetch(base, {
          method: 'POST',
          body: query,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'application/json' },
          signal: ctrl.signal,
        })
        clearTimeout(t)
        if (signal) signal.removeEventListener('abort', onParentAbort)
        if (!res.ok) {
          if ([502, 503, 504, 429].includes(res.status)) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
            continue
          }
          throw new Error(`Overpass error (${res.status})`)
        }
        return (await res.json()) as { elements?: OverpassElement[] }
      } catch (e) {
        clearTimeout(t)
        if (signal) signal.removeEventListener('abort', onParentAbort)
        lastErr = e instanceof Error ? e : new Error(String(e))
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }
  throw lastErr ?? new Error('Overpass failed')
}

function buildOverpassQuery(south: number, west: number, north: number, east: number, flags: ImportModeFlags): string {
  const parts: string[] = []
  /** Urban rapid transit — route=train split at import into regional vs national */
  if (flags.metro) parts.push('subway', 'metro', 'rapid_transit', 'heavy_rail')
  if (flags.regionalRail || flags.nationalRail) parts.push('train')
  if (flags.lightRail) parts.push('tram', 'light_rail', 'tram_train', 'monorail')
  if (flags.bus) parts.push('bus', 'trolleybus')
  const routePattern = parts.join('|')
  if (!routePattern) return ''
  /** `out skel` omits node tags — every stop would import as “Unnamed”. `out body` loads names/refs/GTFS tags on members. */
  return `[out:json][timeout:180];
(
  relation["type"="route"]["route"~"${routePattern}"](${south},${west},${north},${east});
);
out body;
>;
out body qt;`
}

function lineColorFromTags(tags: Record<string, string>, idx: number): string {
  const c = (tags.colour || tags.color || '').trim()
  if (/^#[0-9a-fA-F]{6}$/i.test(c) || /^#[0-9a-fA-F]{3}$/i.test(c)) return c
  return IMPORT_LINE_COLORS[idx % IMPORT_LINE_COLORS.length]
}

/** Canonical geometry key: order-independent stop sequence (rounded coords) */
export function canonicalGeomKey(mode: TransitMode, stationPositions: Map<string, LatLng>, stationIds: string[]): string {
  const pts = stationIds
    .map((id) => stationPositions.get(id))
    .filter((p): p is LatLng => p != null)
    .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
  const forward = pts.join('|')
  const rev = [...pts].reverse().join('|')
  return mode + ':' + (forward < rev ? forward : rev)
}

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    const p = this.parent.get(x)
    if (p == null) {
      this.parent.set(x, x)
      return x
    }
    if (p !== x) {
      const root = this.find(p)
      this.parent.set(x, root)
      return root
    }
    return p
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

function normalizeRouteName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeRouteName(a)
  const nb = normalizeRouteName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = new Set(na.split(/\s+/).filter(Boolean))
  const tb = new Set(nb.split(/\s+/).filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const u = ta.size + tb.size - inter
  return u > 0 ? inter / u : 0
}

function stopOverlapFraction(
  aIds: string[],
  bIds: string[],
  posA: Map<string, LatLng>,
  posB: Map<string, LatLng>,
  nearM = 250,
): number {
  let matches = 0
  for (const ida of aIds) {
    const pa = posA.get(ida)
    if (!pa) continue
    for (const idb of bIds) {
      const pb = posB.get(idb)
      if (pb && haversineM(pa, pb) <= nearM) {
        matches++
        break
      }
    }
  }
  const denom = Math.max(aIds.length, bIds.length, 1)
  return matches / denom
}

/** Same corridor in either direction (OSM often has inbound + outbound relations). Same station-id space. */
function routePathSimilarity(
  aIds: string[],
  bIds: string[],
  pos: Map<string, LatLng>,
  nearM = 250,
): number {
  const fwd = stopOverlapFraction(aIds, bIds, pos, pos, nearM)
  const rev = stopOverlapFraction(aIds, [...bIds].reverse(), pos, pos, nearM)
  return Math.max(fwd, rev)
}

/** Compare import vs existing map where station ids differ (match by proximity). */
function routePathSimilarityCrossMap(
  aIds: string[],
  bIds: string[],
  posA: Map<string, LatLng>,
  posB: Map<string, LatLng>,
  nearM = 250,
): number {
  const fwd = stopOverlapFraction(aIds, bIds, posA, posB, nearM)
  const rev = stopOverlapFraction(aIds, [...bIds].reverse(), posA, posB, nearM)
  return Math.max(fwd, rev)
}

type LineBounds = { minLat: number; minLng: number; maxLat: number; maxLng: number }

function computeLineBounds(ids: string[], pos: Map<string, LatLng>): LineBounds | null {
  let minLat = Infinity
  let minLng = Infinity
  let maxLat = -Infinity
  let maxLng = -Infinity
  let seen = 0
  for (const id of ids) {
    const p = pos.get(id)
    if (!p) continue
    seen++
    if (p.lat < minLat) minLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng > maxLng) maxLng = p.lng
  }
  if (seen === 0) return null
  return { minLat, minLng, maxLat, maxLng }
}

function boundsOverlapWithinMeters(a: LineBounds | null, b: LineBounds | null, meters: number): boolean {
  if (!a || !b) return true
  const latPad = degreesLatForMeters(meters)
  const midLat = (a.minLat + a.maxLat + b.minLat + b.maxLat) / 4
  const lngPad = degreesLngForMetersAtLat(meters, midLat)
  if (a.maxLat + latPad < b.minLat) return false
  if (b.maxLat + latPad < a.minLat) return false
  if (a.maxLng + lngPad < b.minLng) return false
  if (b.maxLng + lngPad < a.minLng) return false
  return true
}

/** Treat regional + national rail as one bucket for duplicate-path merge (same corridor, split tagging). */
function modesCompatibleForDedupe(a: TransitMode, b: TransitMode): boolean {
  if (a === b) return true
  if (a === 'regional_rail' || a === 'national_rail') {
    return b === 'regional_rail' || b === 'national_rail'
  }
  return false
}

/**
 * Drop duplicate / opposite-direction variants of the same route.
 * Keeps the longest variant first (usually the most complete stop list).
 * Uses a looser distance match than conflict detection so parallel OSM nodes still line up.
 */
function dedupeImportLinesByPathSimilarity(
  lines: Line[],
  stationPositions: Map<string, LatLng>,
  warnings: string[],
  similarityThreshold: number,
  nearMForDedupe: number,
): Line[] {
  const sorted = [...lines].sort((a, b) => {
    const d = b.stationIds.length - a.stationIds.length
    if (d !== 0) return d
    return a.name.localeCompare(b.name)
  })
  const kept: Line[] = []
  for (const line of sorted) {
    const mode = getLineMode(line)
    let dupOf: Line | null = null
    for (const k of kept) {
      if (!modesCompatibleForDedupe(mode, getLineMode(k))) continue
      if (
        routePathSimilarity(line.stationIds, k.stationIds, stationPositions, nearMForDedupe) >=
        similarityThreshold
      ) {
        dupOf = k
        break
      }
    }
    if (dupOf) {
      warnings.push(
        `Merged “${line.name}” with “${dupOf.name}” (same route path, including opposite direction or near-duplicate).`,
      )
      continue
    }
    kept.push(line)
  }
  return kept
}

const DEDUPE_SIMILARITY = 0.82
const DEDUPE_NEAR_METERS = 340

function dedupeImportLinesUntilStable(
  lines: Line[],
  stationPositions: Map<string, LatLng>,
  warnings: string[],
): Line[] {
  let cur = lines
  for (let pass = 0; pass < 8; pass++) {
    const next = dedupeImportLinesByPathSimilarity(
      cur,
      stationPositions,
      warnings,
      DEDUPE_SIMILARITY,
      DEDUPE_NEAR_METERS,
    )
    if (next.length === cur.length) break
    cur = next
  }
  return cur
}

export type ImportLineConflict = {
  importedIndex: number
  importedName: string
  existingLineId: string
  existingName: string
  score: number
  reason: 'duplicate_geometry' | 'similar_route'
}

type ConflictContext = {
  existingLines: Line[]
  existingPos: Map<string, LatLng>
  importedPos: Map<string, LatLng>
  existingByKey: Map<string, Line>
  existingBounds: Map<string, LineBounds | null>
  importedBounds: Map<string, LineBounds | null>
}

function findConflictForImportedLine(il: Line, importedIndex: number, ctx: ConflictContext): ImportLineConflict | null {
  const mode = getLineMode(il)
  const key = canonicalGeomKey(mode, ctx.importedPos, il.stationIds)
  const dup = ctx.existingByKey.get(key)
  if (dup) {
    return {
      importedIndex,
      importedName: il.name,
      existingLineId: dup.id,
      existingName: dup.name,
      score: 1,
      reason: 'duplicate_geometry',
    }
  }
  for (const el of ctx.existingLines) {
    if (!modesCompatibleForDedupe(mode, getLineMode(el))) continue
    if (!boundsOverlapWithinMeters(ctx.importedBounds.get(il.id) ?? null, ctx.existingBounds.get(el.id) ?? null, 700)) continue
    if (routePathSimilarityCrossMap(il.stationIds, el.stationIds, ctx.importedPos, ctx.existingPos, 320) >= 0.86) {
      return {
        importedIndex,
        importedName: il.name,
        existingLineId: el.id,
        existingName: el.name,
        score: 0.95,
        reason: 'duplicate_geometry',
      }
    }
  }
  for (const el of ctx.existingLines) {
    if (getLineMode(el) !== mode) continue
    if (!boundsOverlapWithinMeters(ctx.importedBounds.get(il.id) ?? null, ctx.existingBounds.get(el.id) ?? null, 1000)) continue
    const sim = nameSimilarity(il.name, el.name)
    const overlap = stopOverlapFraction(il.stationIds, el.stationIds, ctx.importedPos, ctx.existingPos, 250)
    if (sim >= 0.6 && overlap >= 0.4) {
      return {
        importedIndex,
        importedName: il.name,
        existingLineId: el.id,
        existingName: el.name,
        score: sim * 0.5 + overlap * 0.5,
        reason: 'similar_route',
      }
    }
  }
  return null
}

/** Compare a pending import to the current map; used before merge. */
export function findImportLineConflicts(
  existingStations: Station[],
  existingLines: Line[],
  importedStations: Station[],
  importedLines: Line[],
): ImportLineConflict[] {
  const existingPos = new Map(existingStations.map((s) => [s.id, s.position] as const))
  const importedPos = new Map(importedStations.map((s) => [s.id, s.position] as const))
  const existingBounds = new Map<string, LineBounds | null>(
    existingLines.map((el) => [el.id, computeLineBounds(el.stationIds, existingPos)] as const),
  )
  const importedBounds = new Map<string, LineBounds | null>(
    importedLines.map((il) => [il.id, computeLineBounds(il.stationIds, importedPos)] as const),
  )

  const existingByKey = new Map<string, Line>()
  for (const el of existingLines) {
    existingByKey.set(canonicalGeomKey(getLineMode(el), existingPos, el.stationIds), el)
  }
  const ctx: ConflictContext = { existingLines, existingPos, importedPos, existingByKey, existingBounds, importedBounds }
  const conflicts: ImportLineConflict[] = []
  importedLines.forEach((il, importedIndex) => {
    const c = findConflictForImportedLine(il, importedIndex, ctx)
    if (c) conflicts.push(c)
  })
  return conflicts
}

export async function findImportLineConflictsChunked(
  existingStations: Station[],
  existingLines: Line[],
  importedStations: Station[],
  importedLines: Line[],
  chunkSize = 14,
): Promise<ImportLineConflict[]> {
  const existingPos = new Map(existingStations.map((s) => [s.id, s.position] as const))
  const importedPos = new Map(importedStations.map((s) => [s.id, s.position] as const))
  const existingBounds = new Map<string, LineBounds | null>(
    existingLines.map((el) => [el.id, computeLineBounds(el.stationIds, existingPos)] as const),
  )
  const importedBounds = new Map<string, LineBounds | null>(
    importedLines.map((il) => [il.id, computeLineBounds(il.stationIds, importedPos)] as const),
  )
  const existingByKey = new Map<string, Line>()
  for (const el of existingLines) {
    existingByKey.set(canonicalGeomKey(getLineMode(el), existingPos, el.stationIds), el)
  }
  const ctx: ConflictContext = { existingLines, existingPos, importedPos, existingByKey, existingBounds, importedBounds }
  const conflicts: ImportLineConflict[] = []
  for (let i = 0; i < importedLines.length; i++) {
    const c = findConflictForImportedLine(importedLines[i], i, ctx)
    if (c) conflicts.push(c)
    if (i > 0 && i % chunkSize === 0) await new Promise((r) => setTimeout(r, 0))
  }
  return conflicts
}

/** Drop conflicting imported lines unless the user chose “import anyway” for that index. */
export function filterImportResult(
  result: { stations: Station[]; lines: Line[] },
  conflicts: ImportLineConflict[],
  importAnywayIndices: Set<number>,
): { stations: Station[]; lines: Line[] } {
  const conflicted = new Set(conflicts.map((c) => c.importedIndex))
  const keptLines: Line[] = []
  result.lines.forEach((line, i) => {
    if (!conflicted.has(i)) {
      keptLines.push(line)
      return
    }
    if (importAnywayIndices.has(i)) keptLines.push(line)
  })
  const usedIds = new Set<string>()
  keptLines.forEach((l) => l.stationIds.forEach((id) => usedIds.add(id)))
  const keptStations = result.stations.filter((s) => usedIds.has(s.id))
  return { stations: keptStations, lines: keptLines }
}

export function postProcessImportedNetwork(
  stations: Station[],
  lines: Line[],
): { stations: Station[]; lines: Line[]; warnings: string[] } {
  const warnings: string[] = []
  let st = [...stations]
  let ln = [...lines]

  /** Drop junk station names */
  st = st.map((s) => {
    const n = (s.name || '').trim()
    const numOnly = /^[\d\s\-#]+$/.test(n) && n.length >= 3 && /^\d/.test(n.replace(/\D/g, '') || '')
    const stopNum = /^stop\s+\d{3,}$/i.test(n)
    if (!n || numOnly || stopNum || /^#?[0-9a-f]{8,}$/i.test(n)) {
      return { ...s, name: '·' }
    }
    return s
  })

  /** Merge nearby stops (union–find); grid index avoids O(n^2) all-pairs scans. */
  const uf = new UnionFind()
  for (const s of st) uf.find(s.id)
  const maxMergeM = IMPORT_STATION_MERGE_SAME_NAME_RADIUS_M
  const latStep = degreesLatForMeters(maxMergeM)
  const lngStep = degreesLngForMetersAtLat(maxMergeM, st.length ? st[0].position.lat : 0)
  const grid = new Map<string, Station[]>()
  for (const s of st) {
    const k = stationCellKey(s, latStep, lngStep)
    const bucket = grid.get(k)
    if (bucket) bucket.push(s)
    else grid.set(k, [s])
  }
  for (const s of st) {
    for (const key of neighborCellKeys(s, latStep, lngStep)) {
      const bucket = grid.get(key)
      if (!bucket) continue
      for (const other of bucket) {
        if (other.id <= s.id) continue
        if (postImportStationsShouldMerge(s, other)) uf.union(s.id, other.id)
      }
    }
  }
  const rootToCanonical = new Map<string, string>()
  for (const s of st) {
    const r = uf.find(s.id)
    const prev = rootToCanonical.get(r)
    if (!prev || s.id < prev) rootToCanonical.set(r, s.id)
  }
  const mergeMap = new Map<string, string>()
  for (const s of st) {
    const r = uf.find(s.id)
    const canon = rootToCanonical.get(r)!
    if (s.id !== canon) mergeMap.set(s.id, canon)
  }
  const remapId = (id: string) => {
    let x = id
    while (mergeMap.has(x)) x = mergeMap.get(x)!
    return x
  }

  ln = ln.map((line) => ({
    ...line,
    stationIds: line.stationIds.map(remapId).filter((id, idx, arr) => idx === 0 || id !== arr[idx - 1]),
  }))

  /** Drop merged-away duplicate stations */
  st = st.filter((s) => !mergeMap.has(s.id))

  /** Remove lines with < 2 stops */
  ln = ln.filter((l) => {
    const ok = l.stationIds.length >= 2
    if (!ok) warnings.push(`Dropped line “${l.name}”: too few stops after cleanup.`)
    return ok
  })

  /** Dedupe opposite direction + near-identical path (multi-pass; regional/national rail share one bucket) */
  const sp = new Map(st.map((s) => [s.id, s.position] as const))
  ln = dedupeImportLinesUntilStable(ln, sp, warnings)

  /** Remove orphan stations not on any line */
  const onLine = new Set<string>()
  ln.forEach((l) => l.stationIds.forEach((id) => onLine.add(id)))
  const beforeOrphans = st.length
  st = st.filter((s) => onLine.has(s.id))
  if (st.length < beforeOrphans) warnings.push(`Removed ${beforeOrphans - st.length} orphan stop(s) after cleanup.`)

  /** Fix “·” placeholder — use neutral label; reverse geocode can replace after import */
  st = st.map((s) => (s.name === '·' ? { ...s, name: UNNAMED_STOP_PLACEHOLDER } : s))

  return { stations: st, lines: ln, warnings }
}

export type OsmImportResult = {
  version: number
  stations: Station[]
  lines: Line[]
  stationLabelOverrides: Record<string, StationLabelOverride>
  center: LatLng
  warnings: string[]
}

export async function fetchOsmTransitMap(
  place: { south: number; west: number; north: number; east: number; center: LatLng },
  flags: ImportModeFlags,
  options?: { signal?: AbortSignal; lineColorOffset?: number },
): Promise<OsmImportResult> {
  const warnings: string[] = []
  if (!flags.metro && !flags.lightRail && !flags.bus && !flags.regionalRail && !flags.nationalRail) {
    throw new Error(
      'Select at least one mode to import (metro, light rail, bus, regional rail, or national rail).',
    )
  }

  let { south, west, north, east } = place
  ;({ south, west, north, east } = clampBbox(south, west, north, east))

  const q = buildOverpassQuery(south, west, north, east, flags)
  if (!q) throw new Error('No route types selected.')

  const json = await fetchOverpass(q, options?.signal)
  const elements = json.elements ?? []
  const nodeById = new Map<number, { lat: number; lng: number; tags: Record<string, string> }>()
  for (const el of elements) {
    if (el.type !== 'node' || el.lat == null || el.lon == null) continue
    nodeById.set(el.id, { lat: el.lat, lng: el.lon, tags: el.tags ?? {} })
  }

  const stations: Station[] = []
  const stationIdForOsmNode = new Map<number, string>()
  const lineColorOffset = options?.lineColorOffset ?? 0

  function ensureStation(osmId: number): string | null {
    const existing = stationIdForOsmNode.get(osmId)
    if (existing) return existing
    const n = nodeById.get(osmId)
    if (!n) return null
    const id = `station-${osmId}`
    stationIdForOsmNode.set(osmId, id)
    const name = cleanStationNameForOsm(n.tags.name, n.tags)
    stations.push({ id, name, position: { lat: n.lat, lng: n.lng } })
    return id
  }

  const lines: Line[] = []
  let colorIdx = lineColorOffset

  for (const el of elements) {
    if (el.type !== 'relation' || !el.tags || el.tags.type !== 'route') continue
    const route = el.tags.route ?? ''
    const tags = el.tags
    if (!routeMatchesFlags(route, tags, flags)) continue
    const mode = osmRouteToLineMode(route, tags)
    if (!mode) continue
    if (!el.members?.length) continue

    const ordered: string[] = []
    for (const m of el.members) {
      if (m.type !== 'node') continue
      const sid = ensureStation(m.ref)
      if (!sid) continue
      if (ordered.length === 0 || ordered[ordered.length - 1] !== sid) ordered.push(sid)
    }
    if (ordered.length < 2) continue

    const name = (el.tags.name ?? el.tags.ref ?? `Line ${el.id}`).trim() || `Line ${el.id}`
    const color = lineColorFromTags(el.tags, colorIdx++)
    lines.push({
      id: `line-${el.id}`,
      name,
      color,
      weight: 3,
      stationIds: ordered,
      mode,
    })
  }

  const processed = postProcessImportedNetwork(stations, lines)

  if (processed.lines.length === 0) {
    warnings.push('No routes imported. Try enabling more modes or a different area.')
  }

  return {
    version: SAVE_VERSION,
    stations: processed.stations,
    lines: processed.lines,
    stationLabelOverrides: {},
    center: place.center,
    warnings: [...warnings, ...processed.warnings],
  }
}

export function mergeImportIntoMap(
  existingStations: Station[],
  existingLines: Line[],
  imported: { stations: Station[]; lines: Line[] },
  genStationId: () => string,
  genLineId: (used: Set<string>) => string,
): { stations: Station[]; lines: Line[] } {
  const usedLineIds = new Set(existingLines.map((l) => l.id))
  const idRemap = new Map<string, string>()

  const stations = [...existingStations]
  const maxMergeM = IMPORT_STATION_MERGE_SAME_NAME_RADIUS_M
  const latStep = degreesLatForMeters(maxMergeM)
  const lngStep = degreesLngForMetersAtLat(
    maxMergeM,
    stations.length > 0 ? stations[0].position.lat : imported.stations.length > 0 ? imported.stations[0].position.lat : 0,
  )
  const spatial = new Map<string, Station[]>()
  const addToSpatial = (s: Station) => {
    const k = stationCellKey(s, latStep, lngStep)
    const b = spatial.get(k)
    if (b) b.push(s)
    else spatial.set(k, [s])
  }
  for (const s of stations) addToSpatial(s)

  for (const s of imported.stations) {
    let match: Station | undefined
    for (const key of neighborCellKeys(s, latStep, lngStep)) {
      const bucket = spatial.get(key)
      if (!bucket) continue
      for (const ex of bucket) {
        if (postImportStationsShouldMerge(ex, s)) {
          match = ex
          break
        }
      }
      if (match) break
    }
    if (match) {
      idRemap.set(s.id, match.id)
    } else {
      const newId = genStationId()
      idRemap.set(s.id, newId)
      const created = { ...s, id: newId }
      stations.push(created)
      addToSpatial(created)
    }
  }

  const lines: Line[] = [...existingLines]
  for (const L of imported.lines) {
    const newIds = L.stationIds.map((id) => idRemap.get(id) ?? id)
    const newLineId = genLineId(usedLineIds)
    usedLineIds.add(newLineId)
    lines.push({
      ...L,
      id: newLineId,
      stationIds: newIds,
    })
  }

  return { stations, lines }
}
