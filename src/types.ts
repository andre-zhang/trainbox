/** Shared map / diagram types for Trainbox (transit diagram tool) */

export type LatLng = { lat: number; lng: number }

export type FocusTarget =
  | { type: 'point'; lat: number; lng: number; zoom?: number }
  | { type: 'line'; lineId: string }
  /** Fit map to all station positions (e.g. when opening system map). */
  | { type: 'fit-all'; nonce?: number }

export type StationLabelOverride = {
  offset: [number, number]
  rotationDeg: number
}

/** Fixed display / import order — metro → light rail → bus → regional rail → national rail */
export const TRANSIT_MODES = [
  'metro',
  'light_rail',
  'bus',
  'regional_rail',
  'national_rail',
] as const

export type TransitMode = (typeof TRANSIT_MODES)[number]

export function isTransitMode(v: string | undefined | null): v is TransitMode {
  return v != null && (TRANSIT_MODES as readonly string[]).includes(v)
}

export function getLineMode(line: Line): TransitMode {
  return isTransitMode(line.mode) ? line.mode : 'metro'
}

export function defaultModeVisibility(): Record<TransitMode, boolean> {
  return Object.fromEntries(TRANSIT_MODES.map((m) => [m, true])) as Record<TransitMode, boolean>
}

export function defaultModeGroupCollapsed(): Record<TransitMode, boolean> {
  return Object.fromEntries(TRANSIT_MODES.map((m) => [m, false])) as Record<TransitMode, boolean>
}

export function emptyLinesByMode(): Record<TransitMode, Line[]> {
  const o = {} as Record<TransitMode, Line[]>
  for (const m of TRANSIT_MODES) o[m] = []
  return o
}

/** Optional midpoint between two stations on a line (for curved geometry) */
export type LineWaypoint = {
  afterStationId: string
  position: LatLng
}

export type Station = {
  id: string
  name: string
  position: LatLng
}

export type Line = {
  id: string
  name: string
  color: string
  weight: number
  stationIds: string[]
  /** Diagram mode — defaults to metro when missing or unknown (older saves) */
  mode?: TransitMode
  waypoints?: LineWaypoint[]
  dashArray?: string
  planned?: boolean
  expressEnabled?: boolean
  expressStationIds?: string[]
}

export type ModeLabelStyle = {
  fontFamily: string
  fontSizePx: number
}

export type ModeMarkerStyle = {
  scale: number
  fill: string
  stroke: string
}

export const DEFAULT_MODE_LABEL_STYLE: ModeLabelStyle = {
  fontFamily: '"Open Sans", system-ui, sans-serif',
  fontSizePx: 0,
}

export const DEFAULT_MODE_MARKER_STYLE: ModeMarkerStyle = {
  scale: 1,
  fill: '#ffffff',
  stroke: '#1a1a1a',
}
