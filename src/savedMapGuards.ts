import type { Line, Station, StationLabelOverride } from './types'
import { isTransitMode } from './types'

const DEFAULT_LINE_WEIGHT = 3
const DEFAULT_LINE_COLOR = '#666666'

function readFiniteNumber(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function coerceLatLng(p: unknown): { lat: number; lng: number } | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  const lat = readFiniteNumber(o.lat)
  const lng = readFiniteNumber(o.lng)
  if (lat == null || lng == null) return null
  return { lat, lng }
}

export interface SavedMap {
  version: number
  stations: Station[]
  lines: Line[]
  stationLabelOverrides?: Record<string, StationLabelOverride>
}

export function isValidSavedMap(data: unknown): data is SavedMap {
  if (!data || typeof data !== 'object') return false
  const d = data as SavedMap
  if (typeof d.version !== 'number' || d.version < 1) return false
  if (!Array.isArray(d.stations) || !Array.isArray(d.lines)) return false
  const station = (s: unknown) =>
    s != null &&
    typeof s === 'object' &&
    typeof (s as Station).id === 'string' &&
    typeof (s as Station).name === 'string' &&
    typeof (s as Station).position === 'object' &&
    typeof (s as Station).position?.lat === 'number' &&
    typeof (s as Station).position?.lng === 'number'
  const line = (l: unknown) =>
    l != null &&
    typeof l === 'object' &&
    typeof (l as Line).id === 'string' &&
    typeof (l as Line).name === 'string' &&
    typeof (l as Line).color === 'string' &&
    Array.isArray((l as Line).stationIds)
  if (d.version >= 2 && d.stationLabelOverrides != null) {
    if (typeof d.stationLabelOverrides !== 'object') return false
    for (const [k, v] of Object.entries(d.stationLabelOverrides)) {
      if (typeof k !== 'string' || !v || typeof v !== 'object') return false
      const o = v as { offset?: unknown; rotationDeg?: unknown }
      if (!Array.isArray(o.offset) || o.offset.length !== 2 || typeof o.rotationDeg !== 'number') return false
    }
  }
  return (d.stations as unknown[]).every(station) && (d.lines as unknown[]).every(line)
}

export function tryRecoverSavedMap(data: unknown): SavedMap | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const version = typeof d.version === 'number' ? d.version : 1
  if (version < 1) return null
  const stations: Station[] = []
  if (Array.isArray(d.stations)) {
    for (const s of d.stations as unknown[]) {
      if (
        s != null &&
        typeof s === 'object' &&
        typeof (s as Station).id === 'string' &&
        typeof (s as Station).name === 'string' &&
        typeof (s as Station).position === 'object' &&
        typeof (s as Station).position?.lat === 'number' &&
        typeof (s as Station).position?.lng === 'number'
      )
        stations.push(s as Station)
    }
  }
  const lines: Line[] = []
  if (Array.isArray(d.lines)) {
    for (const l of d.lines as unknown[]) {
      if (
        l != null &&
        typeof l === 'object' &&
        typeof (l as Line).id === 'string' &&
        typeof (l as Line).name === 'string' &&
        typeof (l as Line).color === 'string' &&
        Array.isArray((l as Line).stationIds)
      )
        lines.push(l as Line)
    }
  }
  const stationLabelOverrides: Record<string, StationLabelOverride> = {}
  if (d.stationLabelOverrides != null && typeof d.stationLabelOverrides === 'object') {
    for (const [k, v] of Object.entries(d.stationLabelOverrides as Record<string, unknown>)) {
      if (typeof k !== 'string' || !v || typeof v !== 'object') continue
      const o = v as { offset?: unknown; rotationDeg?: unknown }
      if (!Array.isArray(o.offset) || o.offset.length !== 2 || typeof o.rotationDeg !== 'number') continue
      stationLabelOverrides[k] = { offset: o.offset as [number, number], rotationDeg: o.rotationDeg }
    }
  }
  return { version, stations, lines, stationLabelOverrides }
}

/**
 * Upgrade older / looser save files (string lat/lng, missing line.weight, bad label overrides, etc.).
 */
export function coerceLegacySavedMap(data: unknown): SavedMap | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const versionRaw = d.version
  const version =
    typeof versionRaw === 'number' && Number.isFinite(versionRaw) && versionRaw >= 1
      ? versionRaw
      : readFiniteNumber(versionRaw) ?? 1

  const stations: Station[] = []
  if (Array.isArray(d.stations)) {
    for (const s of d.stations as unknown[]) {
      if (!s || typeof s !== 'object') continue
      const o = s as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.name !== 'string') continue
      const pos = coerceLatLng(o.position)
      if (!pos) continue
      stations.push({ id: o.id, name: o.name, position: pos })
    }
  }

  const lines: Line[] = []
  if (Array.isArray(d.lines)) {
    for (const l of d.lines as unknown[]) {
      if (!l || typeof l !== 'object') continue
      const o = l as Record<string, unknown>
      if (typeof o.id !== 'string') continue
      const name = typeof o.name === 'string' ? o.name : 'Line'
      const color = typeof o.color === 'string' ? o.color : DEFAULT_LINE_COLOR
      const w = readFiniteNumber(o.weight)
      const weight = w != null && w > 0 ? w : DEFAULT_LINE_WEIGHT
      const stationIds = Array.isArray(o.stationIds) ? o.stationIds.filter((id): id is string => typeof id === 'string') : []
      const line: Line = {
        id: o.id,
        name,
        color,
        weight,
        stationIds,
      }
      if (typeof o.mode === 'string' && isTransitMode(o.mode)) line.mode = o.mode
      if (Array.isArray(o.waypoints)) line.waypoints = o.waypoints as Line['waypoints']
      if (typeof o.dashArray === 'string') line.dashArray = o.dashArray
      if (typeof o.planned === 'boolean') line.planned = o.planned
      if (typeof o.expressEnabled === 'boolean') line.expressEnabled = o.expressEnabled
      if (Array.isArray(o.expressStationIds)) {
        line.expressStationIds = o.expressStationIds.filter((id): id is string => typeof id === 'string')
      }
      lines.push(line)
    }
  }

  const stationLabelOverrides: Record<string, StationLabelOverride> = {}
  if (d.stationLabelOverrides != null && typeof d.stationLabelOverrides === 'object') {
    for (const [k, v] of Object.entries(d.stationLabelOverrides as Record<string, unknown>)) {
      if (typeof k !== 'string' || !v || typeof v !== 'object') continue
      const o = v as { offset?: unknown; rotationDeg?: unknown }
      if (!Array.isArray(o.offset) || o.offset.length !== 2) continue
      const rot = readFiniteNumber(o.rotationDeg)
      if (rot == null) continue
      const ox = readFiniteNumber(o.offset[0])
      const oy = readFiniteNumber(o.offset[1])
      if (ox == null || oy == null) continue
      stationLabelOverrides[k] = { offset: [ox, oy], rotationDeg: rot }
    }
  }

  const out: SavedMap = { version, stations, lines, stationLabelOverrides }
  if (!isValidSavedMap(out)) return null
  return out
}
