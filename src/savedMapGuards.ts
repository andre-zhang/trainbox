import type { Line, Station, StationLabelOverride } from './types'

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
