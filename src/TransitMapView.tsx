import { useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react'
import type { CSSProperties, MutableRefObject, SyntheticEvent } from 'react'
import {
  MapContainer,
  TileLayer,
  useMapEvents,
  CircleMarker,
  Popup,
  Polyline,
  useMap,
  Marker,
  Tooltip,
  ScaleControl,
} from 'react-leaflet'
import L from 'leaflet'
import type { LatLng, FocusTarget, StationLabelOverride, TransitMode, ModeLabelStyle, ModeMarkerStyle } from './types'
import type { Station, Line } from './types'
import {
  getLineMode,
  DEFAULT_MODE_LABEL_STYLE,
  DEFAULT_MODE_MARKER_STYLE,
  TRANSIT_MODES,
  defaultModeVisibility,
} from './types'
import {
  closestPointOnPolyline,
  cubicStationSegmentMidpoint,
  PIECEWISE_INTER_LEG_TANGENT_K,
  piecewiseQuadraticPathForLine,
  quadraticCurveMidpoint,
  smoothCurveThroughPoints,
} from './utils/curve'
import { demoTourCaptionTopPx, padClientRectForDemo } from './demoTourLayout'
import { buildSmoothedLinePositions, mapGeometryCacheKey } from './mapGeometryPreload'

const CARTODB_TILES = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png'
const CARTODB_SIMPLIFIED_TILES = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>'

/** Popup content lives on the map pane; without this, control clicks can reach the map as a "click" and add a station. */
function stopLeafletMapPointerLeak(e: SyntheticEvent) {
  e.stopPropagation()
  if ('nativeEvent' in e && e.nativeEvent) L.DomEvent.stopPropagation(e.nativeEvent)
}

const STATION_RADIUS_BASE_M = 70
const STATION_ZOOM_REF = 12
const STATION_ZOOM_SCALE = 0.4

/** Skip O(n²) label nudge solver above this label count. */
const LABEL_OVERLAP_SOLVE_MAX = 220
/** Skip expensive overlap severity scan when labels would hide anyway. */
const LABEL_OVERLAP_SEVERITY_SKIP = 550
/** Reference zoom for one-time label layout at map open (pan/zoom does not re-run layout). */
const LABEL_LAYOUT_REFERENCE_ZOOM = 13
const LABEL_LAYOUT_REFERENCE_DOT_PX = 12

/** Small geodesic distance (m) for deduping edit handles that would stack on the map. */
function approxDistanceM(a: LatLng, b: LatLng): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const x = dLng * Math.cos((lat1 + lat2) * 0.5)
  return Math.hypot(R * dLat, R * x)
}

const LINE_WEIGHT_BASE = 3
const LINE_ZOOM_SCALE = 0.3

/** Tooltip / offset placement (screen px + rotation). */
type MapLabelPlacement = {
  offset: [number, number]
  rotationDeg: number
  direction: 'left' | 'right' | 'top' | 'bottom' | 'center'
}

/** Leaflet anchors the tooltip on the side toward the marker — align text toward that edge so names sit beside the dot, not centered in a wide box. */
function labelTextAlignForDirection(
  dir: 'left' | 'right' | 'top' | 'bottom' | 'center',
): 'left' | 'right' | 'center' {
  if (dir === 'right') return 'left'
  if (dir === 'left') return 'right'
  return 'center'
}

function stationLabelSpanStyle(
  hasOverride: boolean,
  labelPlacement: MapLabelPlacement,
  effLabelFont: number,
  effFontFamily: string | undefined,
): CSSProperties {
  const rotated = Math.abs(labelPlacement.rotationDeg) > 2
  const dir = labelPlacement.direction
  const pad: Pick<CSSProperties, 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom'> = {}
  if (!hasOverride && !rotated) {
    if (dir === 'right') pad.paddingLeft = 2
    else if (dir === 'left') pad.paddingRight = 2
    else if (dir === 'center' && labelPlacement.offset[1] < 0) pad.paddingBottom = 1
    else if (dir === 'center' && labelPlacement.offset[1] > 0) pad.paddingTop = 1
  }
  return {
    fontSize: effLabelFont,
    fontFamily: effFontFamily,
    transform: hasOverride
      ? `translate(${labelPlacement.offset[0]}px, ${labelPlacement.offset[1]}px) rotate(${labelPlacement.rotationDeg}deg)`
      : `rotate(${labelPlacement.rotationDeg}deg)`,
    transformOrigin: 'center center',
    display: 'block',
    width: rotated ? undefined : 'max-content',
    maxWidth: rotated ? undefined : 'min(280px, calc(100vw - 40px))',
    whiteSpace: rotated ? 'nowrap' : 'normal',
    lineHeight: 1.25,
    wordBreak: 'normal',
    overflowWrap: rotated ? 'normal' : 'break-word',
    textAlign:
      hasOverride || rotated ? 'center' : labelTextAlignForDirection(labelPlacement.direction),
    ...pad,
  }
}

/** Rough box for collision checks — word wrap at same cap as .stationNameLabel (see App.css). */
function estimateStationLabelSizePx(name: string, fontPx: number): { w: number; h: number } {
  const maxLinePx = 280
  const charW = fontPx * 0.52
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { w: 44, h: fontPx * 1.35 }
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w
    const testW = test.length * charW + 16
    if (testW <= maxLinePx || !cur) {
      cur = test
    } else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  const longestLineChars = Math.max(...lines.map((ln) => ln.length))
  const w = Math.min(maxLinePx, Math.max(44, longestLineChars * charW + 16))
  const lineCount = lines.length
  const h = Math.max(fontPx * 1.35, lineCount * fontPx * 1.22 + 4)
  return { w, h }
}

function scaleLabelPlacement(placement: MapLabelPlacement, scale: number): MapLabelPlacement {
  if (Math.abs(scale - 1) < 0.04) return placement
  return {
    ...placement,
    offset: [placement.offset[0] * scale, placement.offset[1] * scale],
  }
}

/** Push labels apart in screen space when anchor offsets would stack on dense maps. */
function resolveOverlappingMapLabels(
  items: {
    id: string
    position: LatLng
    name: string
    fontPx: number
    base: MapLabelPlacement
    manual: boolean
  }[],
  pixelsPerDegLat: number,
  pixelsPerDegLng: number,
): Map<string, MapLabelPlacement> {
  const result = new Map<string, MapLabelPlacement>()
  for (const it of items) {
    result.set(it.id, { ...it.base })
  }
  if (items.length > LABEL_OVERLAP_SOLVE_MAX) {
    return result
  }
  const movableIds = items.filter((x) => !x.manual).map((x) => x.id)
  const byId = new Map(items.map((x) => [x.id, x]))
  const LABEL_PAD = 10

  for (let round = 0; round < 4; round++) {
    let changed = false
    for (let i = 0; i < movableIds.length; i++) {
      for (let j = i + 1; j < movableIds.length; j++) {
        const ida = movableIds[i]
        const idb = movableIds[j]
        const itemA = byId.get(ida)!
        const itemB = byId.get(idb)!
        const pa = result.get(ida)!
        const pb = result.get(idb)!
        const dxM = (itemA.position.lng - itemB.position.lng) * pixelsPerDegLng
        const dyM = (itemA.position.lat - itemB.position.lat) * pixelsPerDegLat
        const lax = dxM + pa.offset[0] - pb.offset[0]
        const lay = dyM + pa.offset[1] - pb.offset[1]
        const labelSep = Math.hypot(lax, lay)
        const sa = estimateStationLabelSizePx(itemA.name, itemA.fontPx)
        const sb = estimateStationLabelSizePx(itemB.name, itemB.fontPx)
        const need = (sa.w + sb.w) / 2 + LABEL_PAD
        if (labelSep >= need) continue

        const moveId = ida > idb ? ida : idb
        const stayId = moveId === ida ? idb : ida
        const moveItem = byId.get(moveId)!
        const stayItem = byId.get(stayId)!
        const pMove = result.get(moveId)!
        const dxS = (moveItem.position.lng - stayItem.position.lng) * pixelsPerDegLng
        const dyS = (moveItem.position.lat - stayItem.position.lat) * pixelsPerDegLat
        const len = Math.hypot(dxS, dyS) || 1
        const nx = -dyS / len
        const ny = dxS / len
        const deficit = need - labelSep
        const kick = Math.min(9, Math.max(3, deficit * 0.22 + 3))
        const next: MapLabelPlacement = {
          offset: [pMove.offset[0] + nx * kick, pMove.offset[1] + ny * kick],
          rotationDeg: pMove.rotationDeg,
          direction: 'center',
        }
        result.set(moveId, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return result
}

/** Keep tooltip anchor near the station: limit collision nudges and total offset length (px). */
function clampStationLabelOffset(
  baseOffset: [number, number],
  offset: [number, number],
  maxNudgeFromBase: number,
  maxRadiusFromMarker: number,
): [number, number] {
  const ex = offset[0] - baseOffset[0]
  const ey = offset[1] - baseOffset[1]
  const nudgeLen = Math.hypot(ex, ey)
  let ox = offset[0]
  let oy = offset[1]
  if (nudgeLen > maxNudgeFromBase && nudgeLen > 0) {
    const s = maxNudgeFromBase / nudgeLen
    ox = baseOffset[0] + ex * s
    oy = baseOffset[1] + ey * s
  }
  const r = Math.hypot(ox, oy)
  if (r > maxRadiusFromMarker && r > 0) {
    const s = maxRadiusFromMarker / r
    ox *= s
    oy *= s
  }
  return [ox, oy]
}

/** AABB for a rotated label (conservative). */
function effectiveLabelBoxSizePx(name: string, fontPx: number, rotationDeg: number): { w: number; h: number } {
  const { w, h } = estimateStationLabelSizePx(name, fontPx)
  const r = Math.abs(rotationDeg)
  if (r < 2) return { w, h }
  const rad = (r * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  return { w: w * c + h * s + 10, h: w * s + h * c + 10 }
}

function axisAlignedLabelBoxesOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  pad: number,
): boolean {
  const aL = ax - aw / 2 - pad
  const aR = ax + aw / 2 + pad
  const aT = ay - ah / 2 - pad
  const aB = ay + ah / 2 + pad
  const bL = bx - bw / 2 - pad
  const bR = bx + bw / 2 + pad
  const bT = by - bh / 2 - pad
  const bB = by + bh / 2 + pad
  return !(aR < bL || aL > bR || aB < bT || aT > bB)
}

/** From this zoom upward, show names even when some pairs still overlap (city / neighborhood view). */
const ZOOM_STATION_LABELS_IGNORE_OVERLAP = 13

/**
 * Hide all names only when overlap is widespread — not for a few grazing pairs.
 * Uses slightly shrunk boxes + small padding so edge touches don’t count as clashes.
 */
function stationLabelOverlapTooSevere(
  items: { id: string; position: LatLng; name: string; fontPx: number }[],
  placements: Map<string, MapLabelPlacement>,
  map: L.Map,
  zoom: number,
): boolean {
  if (zoom >= ZOOM_STATION_LABELS_IGNORE_OVERLAP) return false
  const n = items.length
  if (n < 2) return false
  if (n > LABEL_OVERLAP_SEVERITY_SKIP) return true
  const totalPairs = (n * (n - 1)) / 2
  const BOX_SHRINK = 0.86
  const pad = 3
  const rects: { cx: number; cy: number; w: number; h: number }[] = []
  for (const it of items) {
    const pl = placements.get(it.id)
    if (!pl) continue
    const p = map.latLngToLayerPoint(L.latLng(it.position.lat, it.position.lng))
    const cx = p.x + pl.offset[0]
    const cy = p.y + pl.offset[1]
    const { w, h } = effectiveLabelBoxSizePx(it.name, it.fontPx, pl.rotationDeg)
    rects.push({ cx, cy, w: w * BOX_SHRINK, h: h * BOX_SHRINK })
  }
  let overlapPairs = 0
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      if (axisAlignedLabelBoxesOverlap(a.cx, a.cy, a.w, a.h, b.cx, b.cy, b.w, b.h, pad)) {
        overlapPairs += 1
      }
    }
  }
  const fraction = overlapPairs / totalPairs
  /** Widespread overlap: enough bad pairs in absolute terms and as a share of all pairs. */
  const FRACTION_HIDE = 0.34
  const minBadPairs = Math.max(4, Math.min(100, Math.ceil(totalPairs * 0.06)))
  return overlapPairs >= minBadPairs && fraction > FRACTION_HIDE
}

interface MapClickHandlerProps {
  mode: 'pan' | 'station' | 'line' | 'edit-line'
  onAddStation?: (pos: LatLng) => void
  addingStationAfter?: { lineId: string; afterStationId: string } | null
  onAddStationBetween?: (lineId: string, afterStationId: string, pos: LatLng) => void
}

function MapClickHandler({ mode, onAddStation, addingStationAfter, onAddStationBetween }: MapClickHandlerProps) {
  useMapEvents({
    click(e) {
      if (addingStationAfter && onAddStationBetween) {
        onAddStationBetween(addingStationAfter.lineId, addingStationAfter.afterStationId, {
          lat: e.latlng.lat,
          lng: e.latlng.lng,
        })
        return
      }
      if (mode === 'station' && onAddStation) {
        onAddStation({ lat: e.latlng.lat, lng: e.latlng.lng })
      }
    },
  })
  return null
}

function TourStationVectorDomTag({
  stationId,
  lat,
  lng,
  kind,
  demoTourActive,
}: {
  stationId: string
  lat: number
  lng: number
  kind: 'circle' | 'marker'
  demoTourActive: boolean
}) {
  const map = useMap()
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const apply = () => {
      if (cancelled) return
      attempts += 1
      if (attempts > 180) return
      const target = L.latLng(lat, lng)
      const eps = 1e-7
      let el: HTMLElement | undefined
      map.eachLayer((layer) => {
        if (el) return
        if (kind === 'circle' && (layer instanceof L.Circle || layer instanceof L.CircleMarker)) {
          const ll = layer.getLatLng()
          if (!ll) return
          if (Math.abs(ll.lat - target.lat) < eps && Math.abs(ll.lng - target.lng) < eps) {
            el = layer.getElement() as HTMLElement | undefined
          }
        }
        if (kind === 'marker' && layer instanceof L.Marker) {
          const ll = layer.getLatLng()
          if (Math.abs(ll.lat - target.lat) < eps && Math.abs(ll.lng - target.lng) < eps) {
            el = layer.getElement() as HTMLElement | undefined
          }
        }
      })
      if (!el) {
        requestAnimationFrame(apply)
        return
      }
      if (demoTourActive) el.setAttribute('data-tour-map-station-id', stationId)
      else el.removeAttribute('data-tour-map-station-id')
    }
    apply()
    return () => {
      cancelled = true
    }
  }, [demoTourActive, kind, lat, lng, map, stationId])
  return null
}

export function TransitLayer({
  stations,
  lines,
  lineMode,
  editLineMode,
  selectedLineId,
  systemMapSelectedLineId,
  demoTourActive = false,
  showStationNamesOnMap = false,
  stationLabelOverrides = {},
  stationLabelFontFamily,
  stationLabelFontSizePxOverride,
  onAddStationToLine,
  onRemoveStationFromLine,
  onStationMove,
  onLineSegmentClick,
  onLineMidpointDrop,
  hiddenLineIds,
  modeVisibility: modeVisibilityProp,
  labelStylesByMode: labelStylesByModeProp,
  markerStylesByMode: markerStylesByModeProp,
  onStationRename,
  onToggleExpressStation,
  onDeleteStation,
  precomputedLinePositions,
}: {
  stations: Station[]
  lines: Line[]
  /** Smoothed paths built once at map open — avoids recomputing curves on pan/zoom. */
  precomputedLinePositions: LatLng[][]
  lineMode: boolean
  editLineMode: boolean
  selectedLineId: string | null
  systemMapSelectedLineId?: string | null
  demoTourActive?: boolean
  onAddStationToLine: (id: string) => void
  onRemoveStationFromLine: (lineId: string, stationId: string) => void
  onStationMove?: (stationId: string, position: LatLng) => void
  onLineSegmentClick?: (lineId: string, position: LatLng, lineIndex?: number) => void
  onLineMidpointDrop?: (
    lineId: string,
    afterStationId: string,
    position: LatLng,
    fromStart?: boolean,
    dragStart?: LatLng | null,
  ) => void
  showStationNamesOnMap?: boolean
  stationLabelOverrides?: Record<string, StationLabelOverride>
  stationLabelFontFamily?: string
  stationLabelFontSizePxOverride?: number | null
  hiddenLineIds?: string[]
  modeVisibility?: Record<TransitMode, boolean>
  labelStylesByMode?: Record<TransitMode, ModeLabelStyle>
  markerStylesByMode?: Record<TransitMode, ModeMarkerStyle>
  onStationRename?: (stationId: string, name: string) => void
  onToggleExpressStation?: (lineId: string, stationId: string) => void
  onDeleteStation?: (stationId: string) => void
}) {
  const modeVisibility = modeVisibilityProp ?? defaultModeVisibility()
  const lineShownOnMap = (line: Line) => {
    if (hiddenLineIds?.includes(line.id)) return false
    return modeVisibility[getLineMode(line)] !== false
  }

  const labelStyles = useMemo((): Record<TransitMode, ModeLabelStyle> => {
    const o = {} as Record<TransitMode, ModeLabelStyle>
    for (const m of TRANSIT_MODES) {
      o[m] = { ...DEFAULT_MODE_LABEL_STYLE, ...labelStylesByModeProp?.[m] }
    }
    return o
  }, [labelStylesByModeProp])

  const markerStyles = useMemo((): Record<TransitMode, ModeMarkerStyle> => {
    const o = {} as Record<TransitMode, ModeMarkerStyle>
    for (const m of TRANSIT_MODES) {
      o[m] = { ...DEFAULT_MODE_MARKER_STYLE, ...markerStylesByModeProp?.[m] }
    }
    return o
  }, [markerStylesByModeProp])

  const map = useMap()
  const panesCreatedRef = useRef(false)
  /** Last drag-start position for the midpoint handle being dragged (infill vs bend uses movement in parent). */
  const midpointDragStartLlRef = useRef<LatLng | null>(null)
  useEffect(() => {
    if (panesCreatedRef.current) return
    panesCreatedRef.current = true
    const linesPane = map.createPane('linesPane')
    linesPane.style.zIndex = '300'
    const stationsPane = map.createPane('stationsPane')
    stationsPane.style.zIndex = '400'
    const handlesPane = map.createPane('handlesPane')
    handlesPane.style.zIndex = '500'
    const editStationsPane = map.createPane('editStationsPane')
    editStationsPane.style.zIndex = '600'
    const midpointHandlesPane = map.createPane('midpointHandlesPane')
    midpointHandlesPane.style.zIndex = '650'
  }, [map])

  const [zoom, setZoom] = useState(() => map.getZoom())
  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  })

  const stationRadiusM = useMemo(
    () => STATION_RADIUS_BASE_M / Math.pow(2, (zoom - STATION_ZOOM_REF) * STATION_ZOOM_SCALE),
    [zoom],
  )

  const [stationIconSizePx, setStationIconSizePx] = useState(20)
  const [dotRadiusPx, setDotRadiusPx] = useState(12)
  const [pixelsPerDeg, setPixelsPerDeg] = useState({ lat: 90000, lng: 60000 })
  /** Pan does not touch React state — only zoom updates metrics (labels use a frozen layout). */
  useEffect(() => {
    const updateMetrics = () => {
      const bounds = map.getBounds()
      const heightDeg = bounds.getNorth() - bounds.getSouth()
      const heightM = heightDeg * 111320
      const size = map.getSize()
      if (size.y > 0 && heightM > 0) {
        const metersPerPx = heightM / size.y
        const radiusPx = stationRadiusM / metersPerPx
        setDotRadiusPx(radiusPx)
        setStationIconSizePx(Math.max(8, Math.min(24, Math.round(radiusPx))))
      }
      const c = map.getCenter()
      const p0 = map.latLngToLayerPoint(L.latLng(c.lat, c.lng))
      const dLat = 0.003
      const dLng = 0.003
      const pLat = map.latLngToLayerPoint(L.latLng(c.lat + dLat, c.lng))
      const pLng = map.latLngToLayerPoint(L.latLng(c.lat, c.lng + dLng))
      setPixelsPerDeg({
        lat: Math.max(1, Math.abs(pLat.y - p0.y) / dLat),
        lng: Math.max(1, Math.abs(pLng.x - p0.x) / dLng),
      })
    }
    const onZoomEnd = () => {
      setZoom(map.getZoom())
      updateMetrics()
    }
    updateMetrics()
    map.on('zoomend', onZoomEnd)
    return () => {
      map.off('zoomend', onZoomEnd)
    }
  }, [map, stationRadiusM])

  const lineWeightScale = useMemo(
    () => Math.pow(2, (zoom - STATION_ZOOM_REF) * LINE_ZOOM_SCALE),
    [zoom],
  )

  const stationCount = stations.length
  /** Wide “whole system” views stay clean; dense metros need zoom 13+ before names appear. */
  const minZoomForLabels = Math.max(
    7,
    stationCount <= 15
      ? 8
      : stationCount <= 40
        ? 9
        : stationCount <= 80
          ? 11
          : stationCount <= 150
            ? 13
            : 14,
  )
  const showLabels = showStationNamesOnMap && zoom >= minZoomForLabels
  const labelFontSizePx = useMemo(() => {
    if (stationLabelFontSizePxOverride != null) return stationLabelFontSizePxOverride
    const zoomFactor = Math.max(0, Math.min(3, zoom - 11))
    const fromZoom = 8 + zoomFactor
    const densityReduction =
      stationCount <= 15 ? 0 : stationCount <= 40 ? 1 : stationCount <= 80 ? 2 : stationCount <= 200 ? 3 : 4
    return Math.max(7, Math.min(12, Math.round(fromZoom - densityReduction)))
  }, [zoom, stationCount, stationLabelFontSizePxOverride])
  /** ~1–2 average character widths from dot rim to label anchor (plus dot radius). */
  const labelGapFromDotPx = Math.max(4, Math.min(11, Math.round(labelFontSizePx * 0.62)))
  const baseLabelDistancePx = Math.min(20, Math.max(5, Math.round(dotRadiusPx + labelGapFromDotPx)))
  const overrideLabelDistancePx = dotRadiusPx + labelFontSizePx / 2 + 4
  const placementMetricsRef = useRef({
    baseLabelDistancePx,
    pixelsPerDeg,
  })
  placementMetricsRef.current = { baseLabelDistancePx, pixelsPerDeg }

  const stationsById = useMemo(() => {
    const m = new Map<string, Station>()
    stations.forEach((s) => m.set(s.id, s))
    return m
  }, [stations])

  const linesByStationId = useMemo(() => {
    const m = new Map<string, Line[]>()
    for (const line of lines) {
      const seen = new Set<string>()
      for (const sid of line.stationIds) {
        if (seen.has(sid)) continue
        seen.add(sid)
        let list = m.get(sid)
        if (!list) {
          list = []
          m.set(sid, list)
        }
        list.push(line)
      }
    }
    return m
  }, [lines])

  const stationIndexOnLine = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const line of lines) {
      let lineMap = m.get(line.id)
      if (!lineMap) {
        lineMap = new Map()
        m.set(line.id, lineMap)
      }
      for (let i = 0; i < line.stationIds.length; i++) {
        const sid = line.stationIds[i]
        if (!lineMap.has(sid)) lineMap.set(sid, i)
      }
    }
    return m
  }, [lines])

  const idxOnLine = (lineId: string, stationId: string) =>
    stationIndexOnLine.get(lineId)?.get(stationId) ?? -1

  const stationDominantMode = (stationId: string): TransitMode => {
    const at = linesByStationId.get(stationId) ?? []
    const visible = at.filter(lineShownOnMap)
    const use = visible.length > 0 ? visible : at.length > 0 ? at : []
    if (use.length === 0) return 'metro'
    for (const mode of TRANSIT_MODES) {
      if (use.some((l) => getLineMode(l) === mode)) return mode
    }
    return 'metro'
  }

  const editIconsByMode = useMemo(() => {
    const m = {} as Record<TransitMode, L.DivIcon>
    for (const mode of TRANSIT_MODES) {
      const ms = markerStyles[mode]
      const scale = ms.scale ?? 1
      const sz = Math.max(6, Math.round(stationIconSizePx * scale))
      const fill = ms.fill ?? '#ffffff'
      const stroke = ms.stroke ?? '#1a1a1a'
      m[mode] = L.divIcon({
        className: 'station-drag-icon',
        html: `<div style="width:${sz * 2}px;height:${sz * 2}px;border-radius:50%;background:${fill};border:2px solid ${stroke};box-sizing:border-box;"></div>`,
        iconSize: [sz * 2, sz * 2],
        iconAnchor: [sz, sz],
      })
    }
    return m
  }, [stationIconSizePx, markerStyles])

  const selectedLine = selectedLineId ? lines.find((l) => l.id === selectedLineId) : null
  const selectedLineStationIds = useMemo(
    () => (selectedLine ? new Set(selectedLine.stationIds) : new Set<string>()),
    [selectedLine],
  )

  const linePositions =
    precomputedLinePositions.length === lines.length
      ? precomputedLinePositions
      : buildSmoothedLinePositions(lines, stationsById)

  const expressStationIds = useMemo(() => {
    const s = new Map<string, Set<string>>()
    for (const line of lines) {
      if (!line.expressEnabled || !line.expressStationIds) continue
      for (const sid of line.expressStationIds) {
        let set = s.get(sid)
        if (!set) {
          set = new Set<string>()
          s.set(sid, set)
        }
        set.add(line.id)
      }
    }
    return s
  }, [lines])

  function getLabelPlacement(station: Station, stationIndex: number): {
    offset: [number, number]
    rotationDeg: number
    direction: 'left' | 'right' | 'top' | 'bottom' | 'center'
  } {
    const { baseLabelDistancePx: baseDist, pixelsPerDeg: ppg } = placementMetricsRef.current
    const override = stationLabelOverrides[station.id]
    if (override) {
      const [ox, oy] = override.offset
      const len = Math.sqrt(ox * ox + oy * oy) || 1
      const scale = overrideLabelDistancePx
      const nx = (ox / len) * scale
      const ny = (oy / len) * scale
      const direction: 'left' | 'right' | 'top' | 'bottom' | 'center' =
        Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'right' : 'left') : 'center'
      return { offset: [nx, ny], rotationDeg: override.rotationDeg, direction }
    }

    const pos = station.position
    const linesThrough = linesByStationId.get(station.id) ?? []
    let lineAngle: number
    if (linesThrough.length > 0) {
      let sumCos = 0
      let sumSin = 0
      for (const line of linesThrough) {
        const idx = idxOnLine(line.id, station.id)
        const prevId = line.stationIds[idx - 1]
        const nextId = line.stationIds[idx + 1]
        const prevPos = prevId ? stationsById.get(prevId)?.position : null
        const nextPos = nextId ? stationsById.get(nextId)?.position : null
        let angle: number
        if (prevPos && nextPos) {
          angle = Math.atan2(nextPos.lat - prevPos.lat, nextPos.lng - prevPos.lng)
        } else if (nextPos) {
          angle = Math.atan2(nextPos.lat - pos.lat, nextPos.lng - pos.lng)
        } else if (prevPos) {
          angle = Math.atan2(pos.lat - prevPos.lat, pos.lng - prevPos.lng)
        } else {
          continue
        }
        sumCos += Math.cos(angle)
        sumSin += Math.sin(angle)
      }
      lineAngle = Math.atan2(sumSin, sumCos)
    } else {
      const dir = stationIndex % 4
      const placements: { offset: [number, number]; direction: 'left' | 'right' | 'top' | 'bottom' | 'center' }[] = [
        { offset: [0, -baseDist], direction: 'center' },
        { offset: [baseDist, 0], direction: 'right' },
        { offset: [0, baseDist], direction: 'center' },
        { offset: [-baseDist, 0], direction: 'left' },
      ]
      const p = placements[dir]
      return { offset: p.offset, rotationDeg: 0, direction: p.direction }
    }

    let perpCosSum = 0
    let perpSinSum = 0
    const fullSegments: { segAngle: number; perpSide: number }[] = []
    for (const line of linesThrough) {
      const idx = idxOnLine(line.id, station.id)
      const prevId = line.stationIds[idx - 1]
      const nextId = line.stationIds[idx + 1]
      const prevPos = prevId ? stationsById.get(prevId)?.position : null
      const nextPos = nextId ? stationsById.get(nextId)?.position : null
      if (!prevPos || !nextPos) continue
      const inAngle = Math.atan2(pos.lat - prevPos.lat, pos.lng - prevPos.lng)
      const outAngle = Math.atan2(nextPos.lat - pos.lat, nextPos.lng - pos.lng)
      const v1x = pos.lng - prevPos.lng
      const v1y = pos.lat - prevPos.lat
      const v2x = nextPos.lng - pos.lng
      const v2y = nextPos.lat - pos.lat
      const cross = v1x * v2y - v1y * v2x
      const angleDiff = Math.abs(((outAngle - inAngle) * 180) / Math.PI)
      const isSharpBend = angleDiff > 30 && angleDiff < 330
      const tangentAngle = isSharpBend
        ? Math.atan2(Math.sin(inAngle) + Math.sin(outAngle), Math.cos(inAngle) + Math.cos(outAngle))
        : Math.atan2(nextPos.lat - prevPos.lat, nextPos.lng - prevPos.lng)
      const perpSide = cross > 0 ? -1 : 1
      const perp = tangentAngle + perpSide * (Math.PI / 2)
      const segAngle = Math.atan2(nextPos.lat - prevPos.lat, nextPos.lng - prevPos.lng)
      perpCosSum += Math.cos(perp)
      perpSinSum += Math.sin(perp)
      fullSegments.push({ segAngle, perpSide })
    }
    const perpAngle = fullSegments.length > 0 ? Math.atan2(perpSinSum, perpCosSum) : lineAngle + Math.PI / 2
    let perpDeg = (perpAngle * 180) / Math.PI
    while (perpDeg >= 360) perpDeg -= 360
    while (perpDeg < 0) perpDeg += 360

    const lineIdx = linesThrough[0] ? idxOnLine(linesThrough[0].id, station.id) : 0
    const flipForAlternate = lineIdx % 2 === 1
    if (flipForAlternate && fullSegments.length > 0) {
      perpDeg = (perpDeg + 180) % 360
    }

    const DENSE_DEG = 0.003
    let hasCloseNeighbor = false
    for (const line of linesThrough) {
      const idx = idxOnLine(line.id, station.id)
      const prevId = line.stationIds[idx - 1]
      const nextId = line.stationIds[idx + 1]
      const prevPos = prevId ? stationsById.get(prevId)?.position : null
      const nextPos = nextId ? stationsById.get(nextId)?.position : null
      if (prevPos) {
        const d = Math.hypot(pos.lat - prevPos.lat, pos.lng - prevPos.lng)
        if (d < DENSE_DEG) hasCloseNeighbor = true
      }
      if (nextPos) {
        const d = Math.hypot(pos.lat - nextPos.lat, pos.lng - nextPos.lng)
        if (d < DENSE_DEG) hasCloseNeighbor = true
      }
    }
    /** Nearly E–W track: horizontal glyphs sit on the corridor; diagonal reads clearer. */
    const HORIZONTAL_LINE_COS = 0.9
    const lineMostlyHorizontal =
      (fullSegments.length > 0 &&
        fullSegments.every((s) => Math.abs(Math.cos(s.segAngle)) >= HORIZONTAL_LINE_COS)) ||
      (fullSegments.length === 0 &&
        linesThrough.length > 0 &&
        Math.abs(Math.cos(lineAngle)) >= HORIZONTAL_LINE_COS)

    const useDiagonalPlacement = hasCloseNeighbor || lineMostlyHorizontal

    let offsetX: number
    let offsetY: number
    let rotationDeg: number
    let direction: 'left' | 'right' | 'top' | 'bottom' | 'center' = 'center'

    /** Diagonal when neighbors are tight or the corridor is ~horizontal; otherwise prefer axis-aligned (rotation 0). */
    if (useDiagonalPlacement) {
      let perpForDiag = perpDeg
      perpForDiag = (perpForDiag + (lineIdx % 4) * 22.5) % 360
      const snapDiag = Math.round(perpForDiag / 45) * 45
      const diagDeg = snapDiag % 90 === 0 ? (snapDiag + 45) % 360 : snapDiag
      rotationDeg = diagDeg
      if (rotationDeg > 90 && rotationDeg < 270) rotationDeg -= 180

      // Place anchor off the corridor (perpendicular in screen px), not along the text angle — otherwise the label sits on the dot.
      const ppl = ppg.lng
      const ppa = ppg.lat
      const tang = fullSegments.length > 0 ? fullSegments[0].segAngle : lineAngle
      const side = fullSegments.length > 0 ? fullSegments[0].perpSide : lineIdx % 2 === 0 ? 1 : -1
      const dLng = Math.cos(tang) * 1e-5
      const dLat = Math.sin(tang) * 1e-5
      let tx = dLng * ppl
      let ty = dLat * ppa
      const tlen = Math.hypot(tx, ty) || 1
      tx /= tlen
      ty /= tlen
      let nx = -ty
      let ny = tx
      if (side < 0) {
        nx = ty
        ny = -tx
      }
      const distancePx = Math.min(26, Math.max(10, Math.round(baseDist * 1.08)))
      offsetX = Math.round(nx * distancePx)
      offsetY = Math.round(ny * distancePx)
    } else {
      const angleToSegment = (deg: number, segAngle: number) => {
        const segDeg = (segAngle * 180) / Math.PI
        const d = Math.abs((((deg - segDeg) % 360) + 360) % 360)
        return d > 180 ? 360 - d : d
      }
      const minAngleToAnyLine = (deg: number) =>
        fullSegments.length > 0 ? Math.min(...fullSegments.map((s) => angleToSegment(deg, s.segAngle))) : 90
      const axes = [
        { deg: 0, snap: perpDeg >= 315 || perpDeg < 45, key: 'right' as const },
        { deg: 90, snap: perpDeg >= 45 && perpDeg < 135, key: 'top' as const },
        { deg: 180, snap: perpDeg >= 135 && perpDeg < 225, key: 'left' as const },
        { deg: 270, snap: perpDeg >= 225 && perpDeg < 315, key: 'bottom' as const },
      ]
      const axisDistToPerp = (deg: number) => Math.abs(((deg - perpDeg + 540) % 360) - 180)
      const isSideAxis = (key: 'left' | 'right' | 'top' | 'bottom') => key === 'left' || key === 'right'
      let chosen = axes.find((a) => a.snap) ?? axes[0]
      if (minAngleToAnyLine(chosen.deg) < 55) {
        const perpAxes = axes.filter((a) => minAngleToAnyLine(a.deg) >= 55)
        if (perpAxes.length > 0) {
          chosen = perpAxes.reduce((best, a) => {
            const dBest = axisDistToPerp(best.deg)
            const dA = axisDistToPerp(a.deg)
            if (dA + 10 < dBest) return a
            if (dBest + 10 < dA) return best
            if (isSideAxis(a.key) && !isSideAxis(best.key)) return a
            if (!isSideAxis(a.key) && isSideAxis(best.key)) return best
            return dA < dBest ? a : best
          }, perpAxes[0])
        }
      }
      /** N–S lines (e.g. outer Red): keep names beside the line (left/right), not above/below the corridor. */
      if (fullSegments.length > 0) {
        const segAngle = fullSegments[0].segAngle
        const mostlyNorthSouth = Math.abs(Math.cos(segAngle)) < 0.55
        if (mostlyNorthSouth && (chosen.key === 'top' || chosen.key === 'bottom')) {
          const sideAxes = axes.filter((a) => isSideAxis(a.key))
          chosen = sideAxes.reduce((best, a) => {
            const dBest = axisDistToPerp(best.deg)
            const dA = axisDistToPerp(a.deg)
            if (dA + 8 < dBest) return a
            if (dBest + 8 < dA) return best
            if (minAngleToAnyLine(a.deg) > minAngleToAnyLine(best.deg) + 4) return a
            if (minAngleToAnyLine(best.deg) > minAngleToAnyLine(a.deg) + 4) return best
            return isSideAxis(a.key) && !isSideAxis(best.key) ? a : best
          }, sideAxes[0])
        }
      }
      const snapRight = chosen?.key === 'right'
      const snapTop = chosen?.key === 'top'
      const snapLeft = chosen?.key === 'left'

      if (snapRight) {
        offsetX = baseDist
        offsetY = 0
        direction = 'right'
      } else if (snapLeft) {
        offsetX = -baseDist
        offsetY = 0
        direction = 'left'
      } else if (snapTop) {
        offsetX = 0
        offsetY = -baseDist
        direction = 'center'
      } else {
        offsetX = 0
        offsetY = baseDist
        direction = 'center'
      }
      rotationDeg = 0
    }

    return { offset: [offsetX, offsetY], rotationDeg, direction }
  }

  const labelLayoutInputKey = useMemo(
    () =>
      [
        stations.length,
        lines.length,
        showStationNamesOnMap,
        stationLabelFontSizePxOverride ?? '',
        JSON.stringify(stationLabelOverrides),
        JSON.stringify(modeVisibility),
        (hiddenLineIds ?? []).join(','),
        stations.map((s) => `${s.id}:${s.name}:${s.position.lat.toFixed(5)},${s.position.lng.toFixed(5)}`).join('|'),
        lines.map((l) => `${l.id}:${l.stationIds.join(',')}`).join(';'),
      ].join('#'),
    [
      stations,
      lines,
      showStationNamesOnMap,
      stationLabelOverrides,
      modeVisibility,
      hiddenLineIds,
      stationLabelFontSizePxOverride,
    ],
  )

  const [frozenLabelLayout, setFrozenLabelLayout] = useState<{
    renderNames: boolean
    byId: Map<string, MapLabelPlacement>
  }>(() => ({ renderNames: false, byId: new Map() }))

  useEffect(() => {
    const empty = new Map<string, MapLabelPlacement>()
    if (!showStationNamesOnMap) {
      setFrozenLabelLayout({ renderNames: false, byId: empty })
      return
    }
    const refGap = Math.max(4, Math.min(11, Math.round(10 * 0.62)))
    const refBaseDist = Math.min(20, Math.max(5, Math.round(LABEL_LAYOUT_REFERENCE_DOT_PX + refGap)))
    const refPixelsPerDeg = { lat: 92000, lng: 75000 }
    const refLabelFont =
      stationLabelFontSizePxOverride ??
      Math.max(
        7,
        Math.min(
          12,
          Math.round(
            8 +
              Math.max(0, Math.min(3, LABEL_LAYOUT_REFERENCE_ZOOM - 11)) -
              (stationCount <= 15 ? 0 : stationCount <= 40 ? 1 : stationCount <= 80 ? 2 : stationCount <= 200 ? 3 : 4),
          ),
        ),
      )

    placementMetricsRef.current = { baseLabelDistancePx: refBaseDist, pixelsPerDeg: refPixelsPerDeg }

    const items = stations
      .map((station, stationIndex) => ({ station, stationIndex }))
      .filter(({ station }) => {
        const ls = linesByStationId.get(station.id) ?? []
        if (ls.length === 0) return true
        return ls.some((line) => lineShownOnMap(line))
      })
      .map(({ station, stationIndex }) => {
        const base = getLabelPlacement(station, stationIndex)
        const manual = !!stationLabelOverrides[station.id]
        const dm = stationDominantMode(station.id)
        const fontPx = labelStyles[dm].fontSizePx > 0 ? labelStyles[dm].fontSizePx : refLabelFont
        return {
          id: station.id,
          position: station.position,
          name: station.name || 'Unnamed',
          fontPx,
          base,
          manual,
        }
      })

    const resolved = resolveOverlappingMapLabels(items, refPixelsPerDeg.lat, refPixelsPerDeg.lng)
    const maxLabelNudgePx = 10
    const maxLabelRadiusPx = Math.min(26, Math.max(16, Math.round(refBaseDist + 8)))
    for (const it of items) {
      if (it.manual) continue
      const cur = resolved.get(it.id)
      if (!cur) continue
      const off = clampStationLabelOffset(it.base.offset, cur.offset, maxLabelNudgePx, maxLabelRadiusPx)
      resolved.set(it.id, { ...cur, offset: off })
    }
    const overlap = stationLabelOverlapTooSevere(
      items.map(({ id, position, name, fontPx }) => ({ id, position, name, fontPx })),
      resolved,
      map,
      LABEL_LAYOUT_REFERENCE_ZOOM,
    )
    placementMetricsRef.current = { baseLabelDistancePx, pixelsPerDeg }
    setFrozenLabelLayout(
      overlap ? { renderNames: false, byId: empty } : { renderNames: true, byId: resolved },
    )
  }, [
    labelLayoutInputKey,
    showStationNamesOnMap,
    stations,
    linesByStationId,
    stationLabelOverrides,
    labelStyles,
    stationCount,
    stationLabelFontSizePxOverride,
    map,
  ])

  const labelOffsetScale = baseLabelDistancePx / LABEL_LAYOUT_REFERENCE_DOT_PX
  const stationLabelLayout = useMemo(() => {
    if (!showLabels) return { renderNames: false, byId: new Map<string, MapLabelPlacement>() }
    if (!frozenLabelLayout.renderNames) return frozenLabelLayout
    if (Math.abs(labelOffsetScale - 1) < 0.04) return frozenLabelLayout
    const scaled = new Map<string, MapLabelPlacement>()
    for (const [id, pl] of frozenLabelLayout.byId) {
      scaled.set(id, scaleLabelPlacement(pl, labelOffsetScale))
    }
    return { renderNames: true, byId: scaled }
  }, [showLabels, frozenLabelLayout, labelOffsetScale])

  const lineMidpointIconNormal = useMemo(
    () =>
      L.divIcon({
        className: 'line-midpoint-dot',
        html:
          '<div data-tour-midpoint-handle="1" class="lineMidpointDotInner" style="width:14px;height:14px;border-radius:50%;background:#2563eb;border:2px solid #ffffff;box-sizing:border-box;"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    [],
  )
  const lineMidpointIconExtendEnd = useMemo(
    () =>
      L.divIcon({
        className: 'line-midpoint-dot',
        html:
          '<div data-tour-midpoint-handle="1" data-tour-extend-end="1" class="lineMidpointDotInner" style="width:14px;height:14px;border-radius:50%;background:#2563eb;border:2px solid #ffffff;box-sizing:border-box;"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    [],
  )

  const selectedLineMidpoints = useMemo(() => {
    if (!editLineMode || !selectedLineId || !selectedLine) return []
    const line = selectedLine
    const n = line.stationIds.length
    if (n < 2) return []
    const lineIndex = lines.findIndex((l) => l.id === line.id)
    let curvePts = lineIndex >= 0 ? linePositions[lineIndex] : undefined
    if (!curvePts || curvePts.length < 2) {
      const fallback = line.stationIds
        .map((id) => stationsById.get(id)?.position)
        .filter((p): p is LatLng => p != null)
      if (fallback.length < 2) return []
      curvePts = fallback
    }
    const curve = curvePts
    const midpoints: { position: LatLng; afterStationId: string; segmentIndex: number; fromStart?: boolean }[] = []
    for (let s = 0; s < n - 1; s++) {
      const afterId = line.stationIds[s]
      const nextId = line.stationIds[s + 1]
      const posA = stationsById.get(afterId)?.position
      const posB = stationsById.get(nextId)?.position
      const wp = line.waypoints?.find((w) => w.afterStationId === afterId)
      let position: LatLng
      if (wp && posA && posB) {
        /* Stored value is Bézier control; nominal handle at t = 0.5, snapped to rendered polyline. */
        const nominal = quadraticCurveMidpoint(posA, wp.position, posB)
        position = closestPointOnPolyline(curve, nominal)
      } else if (posA && posB) {
        const pPrev = s > 0 ? stationsById.get(line.stationIds[s - 1])?.position ?? null : null
        const pNext = s + 2 < n ? stationsById.get(line.stationIds[s + 2])?.position ?? null : null
        const kTangent =
          (line.waypoints?.length ?? 0) > 0 ? PIECEWISE_INTER_LEG_TANGENT_K : 0.25
        const nominal = cubicStationSegmentMidpoint(pPrev, posA, posB, pNext, kTangent)
        position = closestPointOnPolyline(curve, nominal)
      } else {
        position = curve[Math.floor(curve.length / 2)] ?? curve[0]
      }
      midpoints.push({ position, afterStationId: afterId, segmentIndex: s })
    }
    const lastId = line.stationIds[n - 1]
    const lastPos = stationsById.get(lastId)?.position
    if (lastPos) {
      const wpAfterLast = line.waypoints?.find((w) => w.afterStationId === lastId)
      const wpStale =
        wpAfterLast &&
        (Math.pow(wpAfterLast.position.lat - lastPos.lat, 2) +
          Math.pow(wpAfterLast.position.lng - lastPos.lng, 2) >
          0.000009)
      let handlePos = wpAfterLast && !wpStale ? wpAfterLast.position : lastPos
      if ((!wpAfterLast || wpStale) && n >= 2) {
        const prevId = line.stationIds[n - 2]
        const prevPos = stationsById.get(prevId)?.position
        if (prevPos) {
          const dx = handlePos.lng - prevPos.lng
          const dy = handlePos.lat - prevPos.lat
          const len = Math.sqrt(dx * dx + dy * dy) || 1
          const off = 0.00012
          handlePos = {
            lat: handlePos.lat + (off * dy) / len,
            lng: handlePos.lng + (off * dx) / len,
          }
        }
      }
      midpoints.push({ position: handlePos, afterStationId: lastId, segmentIndex: n - 1 })
    }
    const firstId = line.stationIds[0]
    const firstPos = stationsById.get(firstId)?.position
    const lastIdSame = line.stationIds[n - 1]
    if (firstPos && firstId !== lastIdSame) {
      const secondId = line.stationIds[1]
      const secondPos = stationsById.get(secondId)?.position
      let handlePos = firstPos
      if (secondPos) {
        const dx = secondPos.lng - firstPos.lng
        const dy = secondPos.lat - firstPos.lat
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const off = 0.00012
        handlePos = {
          lat: firstPos.lat - (off * dy) / len,
          lng: firstPos.lng - (off * dx) / len,
        }
      }
      midpoints.push({ position: handlePos, afterStationId: firstId, segmentIndex: -1, fromStart: true })
    }

    /* Last-segment bend handle + end-extend handle often land on top of each other → double blue dots.
       Drop the interior bend dot when it is too close to a terminus extend handle (same at line start). */
    const MIN_SEP_BEND_FROM_EXTEND_M = 22
    const extendEndMp = midpoints.find(
      (m) => !m.fromStart && m.afterStationId === lastId && m.segmentIndex === n - 1,
    )
    const extendStartMp = midpoints.find((m) => m.fromStart && m.afterStationId === firstId)
    const thinned = midpoints.filter((m) => {
      if (!m.fromStart && m.segmentIndex === n - 2 && extendEndMp) {
        if (approxDistanceM(m.position, extendEndMp.position) < MIN_SEP_BEND_FROM_EXTEND_M) return false
      }
      if (!m.fromStart && m.segmentIndex === 0 && extendStartMp) {
        if (approxDistanceM(m.position, extendStartMp.position) < MIN_SEP_BEND_FROM_EXTEND_M) return false
      }
      return true
    })

    const DUP_STACK_M = 2.5
    const handleRank = (x: (typeof midpoints)[0]) => {
      if (x.fromStart) return 3
      if (x.afterStationId === lastId && x.segmentIndex === n - 1) return 2
      return 1
    }
    const out: typeof midpoints = []
    for (const m of thinned) {
      const j = out.findIndex((o) => approxDistanceM(o.position, m.position) < DUP_STACK_M)
      if (j === -1) out.push(m)
      else if (handleRank(m) > handleRank(out[j]!)) out[j] = m
    }
    return out
  }, [editLineMode, selectedLineId, selectedLine, linePositions, lines, stationsById])

  return (
    <>
      {lines.map((line, i) => {
        if (!lineShownOnMap(line)) return null
        const positions = linePositions[i]
        if (!positions || positions.length < 2) return null
        const latLngs = positions.map((p) => [p.lat, p.lng] as [number, number])
        const isSelectedForEdit = editLineMode && selectedLineId === line.id
        const weight = (line.weight ?? LINE_WEIGHT_BASE) * lineWeightScale
        const isGreyedOut = systemMapSelectedLineId != null && systemMapSelectedLineId !== line.id
        const baseOpacity = line.planned ? 0.5 : 1
        const opacity = isSelectedForEdit ? 0.9 : isGreyedOut ? 0.35 : baseOpacity
        const dashArray = line.dashArray ?? '0'
        return (
          <Polyline
            key={`line-${i}-${line.id}`}
            positions={latLngs}
            pathOptions={{
              color: isGreyedOut ? '#9ca3af' : line.color,
              weight,
              opacity,
              dashArray: dashArray !== '0' ? dashArray : undefined,
              lineCap: 'round',
              lineJoin: 'round',
              pane: 'linesPane',
              zIndexOffset: -100,
            } as L.PathOptions}
            eventHandlers={
              isSelectedForEdit && onLineSegmentClick
                ? {
                    click: (e: L.LeafletMouseEvent) => {
                      onLineSegmentClick(line.id, { lat: e.latlng.lat, lng: e.latlng.lng }, i)
                    },
                  }
                : undefined
            }
          />
        )
      })}
      {editLineMode &&
        selectedLineId &&
        selectedLine &&
        onLineMidpointDrop &&
        selectedLineMidpoints.map((mp) => {
          const lastSid = selectedLine.stationIds[selectedLine.stationIds.length - 1]
          const isExtendEnd = mp.afterStationId === lastSid && !mp.fromStart
          return (
          <Marker
            key={`mid-${selectedLine.id}-${mp.segmentIndex}-${mp.afterStationId}-${mp.fromStart ? '1' : '0'}`}
            position={[mp.position.lat, mp.position.lng]}
            icon={isExtendEnd ? lineMidpointIconExtendEnd : lineMidpointIconNormal}
            pane="midpointHandlesPane"
            zIndexOffset={100}
            draggable
            eventHandlers={{
              dragstart: (e: L.LeafletEvent) => {
                const ll = (e.target as L.Marker).getLatLng()
                midpointDragStartLlRef.current = { lat: ll.lat, lng: ll.lng }
              },
              dragend: (e) => {
                const ll = (e.target as L.Marker).getLatLng()
                const start = midpointDragStartLlRef.current
                onLineMidpointDrop(
                  selectedLine.id,
                  mp.afterStationId,
                  { lat: ll.lat, lng: ll.lng },
                  mp.fromStart,
                  start,
                )
              },
            }}
          />
          )
        })}
      {stations
        .map((station, stationIndex) => ({ station, stationIndex }))
        .filter(({ station }) => {
          const ls = linesByStationId.get(station.id) ?? []
          if (ls.length === 0) return true
          return ls.some((line) => lineShownOnMap(line))
        })
        .map(({ station, stationIndex }) => {
        const selectedLineLocal = selectedLineId ? lines.find((l) => l.id === selectedLineId) : null
        const isDraggableStation = editLineMode && selectedLineId && selectedLineStationIds.has(station.id)
        const isTerminusOnSelectedLine =
          !!selectedLineLocal &&
          (selectedLineLocal.stationIds[0] === station.id ||
            selectedLineLocal.stationIds[selectedLineLocal.stationIds.length - 1] === station.id)
        const labelPlacement =
          stationLabelLayout.renderNames && stationLabelLayout.byId.has(station.id)
            ? stationLabelLayout.byId.get(station.id)!
            : getLabelPlacement(station, stationIndex)
        const hasOverride = !!stationLabelOverrides[station.id]
        const dm = stationDominantMode(station.id)
        const ms = markerStyles[dm]
        const effLabelFont =
          labelStyles[dm].fontSizePx > 0 ? labelStyles[dm].fontSizePx : labelFontSizePx
        const effFontFamily =
          labelStyles[dm].fontFamily || stationLabelFontFamily || '"Open Sans", system-ui, sans-serif'

        if (isDraggableStation && onStationMove) {
          return (
            <Marker
              key={station.id}
              position={[station.position.lat, station.position.lng]}
              icon={editIconsByMode[dm]}
              pane="editStationsPane"
              draggable
              zIndexOffset={100}
              eventHandlers={{
                dragend: (e) => {
                  const ll = (e.target as L.Marker).getLatLng()
                  onStationMove(station.id, ll)
                },
              }}
            >
              <TourStationVectorDomTag
                stationId={station.id}
                lat={station.position.lat}
                lng={station.position.lng}
                kind="marker"
                demoTourActive={demoTourActive}
              />
              <Popup>
                <div
                  className="stationPopup"
                  onMouseDown={stopLeafletMapPointerLeak}
                  onClick={stopLeafletMapPointerLeak}
                >
                  <input
                    type="text"
                    className="stationPopupNameInput"
                    defaultValue={station.name}
                    onBlur={(e) => onStationRename && onStationRename(station.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && onStationRename) {
                        onStationRename(station.id, (e.target as HTMLInputElement).value)
                        ;(e.target as HTMLInputElement).blur()
                      }
                      if (e.key === 'Escape') {
                        ;(e.target as HTMLInputElement).value = station.name || ''
                        ;(e.target as HTMLInputElement).blur()
                      }
                    }}
                  />
                  {linesByStationId.get(station.id)?.length ? (
                    <div className="stationPopupLines">
                      {(linesByStationId.get(station.id) ?? []).map((line) => {
                        const isExpress =
                          !!line.expressEnabled && !!line.expressStationIds?.includes(station.id)
                        return (
                          <div key={line.id} className="stationPopupLineRow">
                            <span
                              className="stationPopupLineSwatch"
                              style={{ backgroundColor: line.color }}
                            />
                            <span className="stationPopupLineName">{line.name}</span>
                            {line.expressEnabled && onToggleExpressStation && (
                              <button
                                type="button"
                                className={`stationExpressBtn ${
                                  isExpress ? 'stationExpressBtnOn' : ''
                                }`}
                                onClick={() => onToggleExpressStation(line.id, station.id)}
                                title={
                                  isExpress
                                    ? 'Mark as local stop for this line'
                                    : 'Mark as express stop for this line'
                                }
                              >
                                Ex
                              </button>
                            )}
                            <button
                              type="button"
                              className="stationPopupRemoveFromLine"
                              onClick={() => onRemoveStationFromLine(line.id, station.id)}
                              title="Remove from this line"
                            >
                              –
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                  {editLineMode && selectedLineId && isTerminusOnSelectedLine && (
                    <button
                      type="button"
                      className="stationPopupRemoveFromLine"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                    >
                      Extend line from here (then drag)
                    </button>
                  )}
                  {onDeleteStation && (
                    <button
                      type="button"
                      className="stationPopupDeleteEverywhere"
                      onClick={() => onDeleteStation(station.id)}
                      title="Delete station everywhere"
                    >
                      Delete station everywhere
                    </button>
                  )}
                </div>
              </Popup>
              {stationLabelLayout.renderNames && (
                <Tooltip
                  permanent
                  direction={hasOverride ? 'center' : labelPlacement.direction}
                  offset={hasOverride ? [0, 0] : labelPlacement.offset}
                  className="stationNameLabel"
                  opacity={0.95}
                >
                  <span
                    data-tour-map-station-id={
                      demoTourActive && showStationNamesOnMap ? station.id : undefined
                    }
                    style={stationLabelSpanStyle(hasOverride, labelPlacement, effLabelFont, effFontFamily)}
                  >
                    {station.name || 'Unnamed'}
                  </span>
                </Tooltip>
              )}
            </Marker>
          )
        }

        const isExpressStation = expressStationIds.has(station.id)
        const mScale = ms.scale ?? 1
        const visualRadiusPx = Math.max(4, (isExpressStation ? dotRadiusPx * 1.4 : dotRadiusPx) * mScale)
        const hitRadiusPx = visualRadiusPx * 1.8

        return (
          <>
            <CircleMarker
              key={`${station.id}-hit`}
              center={[station.position.lat, station.position.lng]}
              radius={hitRadiusPx}
              pathOptions={{
                color: 'transparent',
                fillColor: 'transparent',
                weight: 10,
                fillOpacity: 0,
                pane: 'stationsPane',
              } as L.PathOptions}
              eventHandlers={{
                click: (e: L.LeafletMouseEvent) => {
                  if (lineMode && selectedLineId && onAddStationToLine) {
                    L.DomEvent.stopPropagation(e.originalEvent)
                    onAddStationToLine(station.id)
                  }
                },
              }}
            />
            <CircleMarker
              key={station.id}
              center={[station.position.lat, station.position.lng]}
              radius={visualRadiusPx}
              pathOptions={{
                fillColor: isExpressStation ? '#111827' : ms.fill ?? '#ffffff',
                color: ms.stroke ?? '#1a1a1a',
                weight: 2,
                fillOpacity: 1,
                pane: 'stationsPane',
              } as L.PathOptions}
              eventHandlers={{
                click: (e: L.LeafletMouseEvent) => {
                  if (lineMode && selectedLineId && onAddStationToLine) {
                    L.DomEvent.stopPropagation(e.originalEvent)
                    onAddStationToLine(station.id)
                  }
                },
              }}
            >
              <TourStationVectorDomTag
                stationId={station.id}
                lat={station.position.lat}
                lng={station.position.lng}
                kind="circle"
                demoTourActive={demoTourActive}
              />
              <Popup>
                <div
                  className="stationPopup"
                  onMouseDown={stopLeafletMapPointerLeak}
                  onClick={stopLeafletMapPointerLeak}
                >
                  <input
                    type="text"
                    className="stationPopupNameInput"
                    defaultValue={station.name}
                    onBlur={(e) => onStationRename && onStationRename(station.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && onStationRename) {
                        onStationRename(station.id, (e.target as HTMLInputElement).value)
                        ;(e.target as HTMLInputElement).blur()
                      }
                      if (e.key === 'Escape') {
                        ;(e.target as HTMLInputElement).value = station.name || ''
                        ;(e.target as HTMLInputElement).blur()
                      }
                    }}
                  />
                  {linesByStationId.get(station.id)?.length ? (
                    <div className="stationPopupLines">
                      {(linesByStationId.get(station.id) ?? []).map((line) => {
                        const isExpress =
                          !!line.expressEnabled && !!line.expressStationIds?.includes(station.id)
                        return (
                          <div key={line.id} className="stationPopupLineRow">
                            <span
                              className="stationPopupLineSwatch"
                              style={{ backgroundColor: line.color }}
                            />
                            <span className="stationPopupLineName">{line.name}</span>
                            {line.expressEnabled && onToggleExpressStation && (
                              <button
                                type="button"
                                className={`stationExpressBtn ${
                                  isExpress ? 'stationExpressBtnOn' : ''
                                }`}
                                onClick={() => onToggleExpressStation(line.id, station.id)}
                                title={
                                  isExpress
                                    ? 'Mark as local stop for this line'
                                    : 'Mark as express stop for this line'
                                }
                              >
                                Ex
                              </button>
                            )}
                            <button
                              type="button"
                              className="stationPopupRemoveFromLine"
                              onClick={() => onRemoveStationFromLine(line.id, station.id)}
                              title="Remove from this line"
                            >
                              –
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                  {editLineMode && selectedLineId && isTerminusOnSelectedLine && (
                    <button
                      type="button"
                      className="stationPopupRemoveFromLine"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                    >
                      Extend line from here (then drag)
                    </button>
                  )}
                  {onDeleteStation && (
                    <button
                      type="button"
                      className="stationPopupDeleteEverywhere"
                      onClick={() => onDeleteStation(station.id)}
                      title="Delete station everywhere"
                    >
                      Delete station everywhere
                    </button>
                  )}
                </div>
              </Popup>
              {stationLabelLayout.renderNames && (
                <Tooltip
                  permanent
                  direction={hasOverride ? 'center' : labelPlacement.direction}
                  offset={hasOverride ? [0, 0] : labelPlacement.offset}
                  className="stationNameLabel"
                  opacity={0.95}
                >
                  <span
                    data-tour-map-station-id={
                      demoTourActive && showStationNamesOnMap ? station.id : undefined
                    }
                    style={stationLabelSpanStyle(hasOverride, labelPlacement, effLabelFont, effFontFamily)}
                  >
                    {station.name || 'Unnamed'}
                  </span>
                </Tooltip>
              )}
            </CircleMarker>
          </>
        )
      })}
    </>
  )
}

interface TransitMapViewProps {
  center: LatLng
  zoom: number
  mode: 'pan' | 'station' | 'line' | 'edit-line'
  stations: Station[]
  lines: Line[]
  selectedLineId: string | null
  demoTourActive?: boolean
  demoTourClearBelowCaptionRef?: MutableRefObject<((el: HTMLElement) => void) | null>
  focusTarget: FocusTarget | null
  onFocusComplete: () => void
  onAddStation: (pos: LatLng) => void
  onAddStationToLine: (stationId: string) => void
  onRemoveStationFromLine: (lineId: string, stationId: string) => void
  onStationMove: (stationId: string, position: LatLng) => void
  onLineSegmentClick: (lineId: string, position: LatLng, lineIndex?: number) => void
  onLineMidpointDrop: (
    lineId: string,
    afterStationId: string,
    position: LatLng,
    fromStart?: boolean,
    dragStart?: LatLng | null,
  ) => void
  addingStationAfter: { lineId: string; afterStationId: string } | null
  onAddStationBetween: (lineId: string, afterStationId: string, pos: LatLng) => void
  systemMapView?: boolean
  systemMapSelectedLineId?: string | null
  showStationNamesOnMap?: boolean
  stationLabelOverrides?: Record<string, StationLabelOverride>
  stationLabelFontFamily?: string
  stationLabelFontSizePxOverride?: number | null
  simplifiedBasemap?: boolean
  hiddenLineIds?: string[]
  modeVisibility?: Record<TransitMode, boolean>
  labelStylesByMode?: Record<TransitMode, ModeLabelStyle>
  markerStylesByMode?: Record<TransitMode, ModeMarkerStyle>
  onStationRename?: (stationId: string, name: string) => void
  onToggleExpressStation?: (lineId: string, stationId: string) => void
  onDeleteStation?: (stationId: string) => void
}

function FlyToController({
  focusTarget,
  onFocusComplete,
  lines,
  stations,
}: {
  focusTarget: FocusTarget | null
  onFocusComplete: () => void
  lines: Line[]
  stations: Station[]
}) {
  const map = useMap()
  const lastFlownRef = useRef<string | null>(null)
  const stationsById = useMemo(() => {
    const m = new Map<string, Station>()
    stations.forEach((s) => m.set(s.id, s))
    return m
  }, [stations])

  useEffect(() => {
    if (!focusTarget) {
      lastFlownRef.current = null
      return
    }

    if (focusTarget.type === 'fit-all') {
      const nonce = focusTarget.nonce ?? 0
      const key = `fit-all:${nonce}:${stations.length}`
      if (lastFlownRef.current === key) return
      lastFlownRef.current = key
      const positions = stations.map((s) => s.position).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      if (positions.length === 0) {
        lastFlownRef.current = null
        onFocusComplete()
        return
      }
      const bounds = L.latLngBounds(positions.map((p) => [p.lat, p.lng] as [number, number]))
      let cancelled = false
      const rafId = requestAnimationFrame(() => {
        if (cancelled) return
        map.flyToBounds(bounds, { padding: [52, 52], maxZoom: 15, duration: 0.55 })
        const onMoveEnd = () => {
          lastFlownRef.current = null
          onFocusComplete()
          map.off('moveend', onMoveEnd)
        }
        map.once('moveend', onMoveEnd)
      })
      return () => {
        cancelled = true
        cancelAnimationFrame(rafId)
      }
    }

    if (focusTarget.type === 'line') {
      const key = `line:${focusTarget.lineId}`
      if (lastFlownRef.current === key) return
      lastFlownRef.current = key
      const line = lines.find((l) => l.id === focusTarget.lineId)
      if (!line || line.stationIds.length < 2) {
        lastFlownRef.current = null
        onFocusComplete()
        return
      }
      const positions: LatLng[] = []
      for (let i = 0; i < line.stationIds.length; i++) {
        const id = line.stationIds[i]
        const pos = stationsById.get(id)?.position
        if (pos) positions.push(pos)
        const wp = line.waypoints?.find((w) => w.afterStationId === id)
        if (wp) positions.push(wp.position)
      }
      if (positions.length < 2) {
        lastFlownRef.current = null
        onFocusComplete()
        return
      }
      const hasWaypoints = (line.waypoints?.length ?? 0) > 0
      const curve = hasWaypoints
        ? piecewiseQuadraticPathForLine(line, stationsById, 12)
        : smoothCurveThroughPoints(positions)
      const bounds = L.latLngBounds(curve.map((p) => [p.lat, p.lng] as [number, number]))
      let cancelled = false
      const rafId = requestAnimationFrame(() => {
        if (cancelled) return
        map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 16, duration: 0.5 })
        const onMoveEnd = () => {
          lastFlownRef.current = null
          onFocusComplete()
          map.off('moveend', onMoveEnd)
        }
        map.once('moveend', onMoveEnd)
      })
      return () => {
        cancelled = true
        cancelAnimationFrame(rafId)
      }
    }

    if (focusTarget.type !== 'point') return
    const pt = focusTarget
    const key = `${pt.lat.toFixed(5)},${pt.lng.toFixed(5)},${pt.zoom ?? 0}`
    if (lastFlownRef.current === key) return
    lastFlownRef.current = key
    let cancelled = false
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return
      map.flyTo([pt.lat, pt.lng], pt.zoom ?? map.getZoom(), { duration: 0.5 })
      const onMoveEnd = () => {
        lastFlownRef.current = null
        onFocusComplete()
        map.off('moveend', onMoveEnd)
      }
      map.once('moveend', onMoveEnd)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [focusTarget, map, onFocusComplete, lines, stations, stationsById])
  return null
}

/** Pan map so a DOM target sits above the demo caption — small steps to avoid huge jumps. */
function DemoTourClearCaptionPan({
  registerRef,
}: {
  registerRef?: MutableRefObject<((el: HTMLElement) => void) | null>
}) {
  const map = useMap()
  useEffect(() => {
    if (!registerRef) return
    const bottomPad = 16
    const maxStep = 130
    registerRef.current = (el: HTMLElement) => {
      const captionTop = demoTourCaptionTopPx()
      const targetBottom = captionTop - bottomPad
      const headerEl = document.querySelector('.appHeader')
      const topSafe = (headerEl?.getBoundingClientRect().bottom ?? 52) + 8
      const pr = padClientRectForDemo(el)
      let dy = 0
      if (pr.bottom > targetBottom) {
        dy += Math.min(Math.ceil(pr.bottom - targetBottom), maxStep)
      }
      if (pr.top < topSafe) {
        dy -= Math.min(Math.ceil(topSafe - pr.top), maxStep)
      }
      if (dy === 0) return
      map.panBy(L.point(0, dy), { animate: true, duration: 0.28, easeLinearity: 0.22 })
    }
    return () => {
      registerRef.current = null
    }
  }, [map, registerRef])
  return null
}

/** Demo tour / flex layouts can leave the map thinking it is shorter than the pane; vectors then clip at the bottom. */
function MapInvalidateOnDemoAndResize({ demoTourActive }: { demoTourActive: boolean }) {
  const map = useMap()
  useEffect(() => {
    const fix = () => {
      map.invalidateSize({ animate: false })
      map.eachLayer((layer) => {
        if (layer instanceof L.Path) {
          layer.redraw()
        }
      })
    }
    fix()
    const a = requestAnimationFrame(fix)
    const t1 = window.setTimeout(fix, 120)
    const t2 = window.setTimeout(fix, 450)
    return () => {
      cancelAnimationFrame(a)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [demoTourActive, map])

  useEffect(() => {
    const el = map.getContainer()
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastW = -1
    let lastH = -1
    let debounce: ReturnType<typeof setTimeout> | null = null
    const run = () => {
      const r = el.getBoundingClientRect()
      if (Math.abs(r.width - lastW) < 0.5 && Math.abs(r.height - lastH) < 0.5) return
      lastW = r.width
      lastH = r.height
      requestAnimationFrame(() => {
        map.invalidateSize({ animate: false })
      })
    }
    const ro = new ResizeObserver(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(run, 120)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (debounce) clearTimeout(debounce)
    }
  }, [map])

  return null
}

export default function TransitMapView({
  center,
  zoom,
  mode,
  stations,
  lines,
  selectedLineId,
  demoTourActive = false,
  demoTourClearBelowCaptionRef,
  focusTarget,
  onFocusComplete,
  onAddStation,
  onAddStationToLine,
  onRemoveStationFromLine,
  onStationMove,
  onLineSegmentClick,
  onLineMidpointDrop,
  addingStationAfter,
  onAddStationBetween,
  systemMapView = false,
  systemMapSelectedLineId = null,
  showStationNamesOnMap = false,
  stationLabelOverrides = {},
  stationLabelFontFamily,
  stationLabelFontSizePxOverride,
  simplifiedBasemap = false,
  hiddenLineIds = [],
  modeVisibility,
  labelStylesByMode,
  markerStylesByMode,
  onStationRename,
  onToggleExpressStation,
  onDeleteStation,
}: TransitMapViewProps) {
  const initialViewRef = useRef<{ center: [number, number]; zoom: number } | null>(null)
  if (initialViewRef.current === null) {
    initialViewRef.current = { center: [center.lat, center.lng], zoom }
  }
  const initialCenter = initialViewRef.current.center
  const initialZoom = initialViewRef.current.zoom

  const geometryKey = useMemo(() => mapGeometryCacheKey(stations, lines), [stations, lines])
  const [precomputedLinePositions, setPrecomputedLinePositions] = useState<LatLng[][]>(() => [])
  const isHeavyMap = stations.length >= 80 || lines.length >= 40
  const [mapLayersReady, setMapLayersReady] = useState(() => !isHeavyMap)
  /** After first render, never hide layers again — avoids white flash when editing. */
  const mapEverReadyRef = useRef(!isHeavyMap)

  useLayoutEffect(() => {
    const applyPositions = (byId: Map<string, Station>) => {
      setPrecomputedLinePositions(buildSmoothedLinePositions(lines, byId))
      setMapLayersReady(true)
      mapEverReadyRef.current = true
    }

    if (lines.length === 0) {
      setPrecomputedLinePositions([])
      setMapLayersReady(true)
      mapEverReadyRef.current = true
      return
    }

    const byId = new Map(stations.map((s) => [s.id, s]))
    const heavy = stations.length >= 80 || lines.length >= 40

    if (!heavy || mapEverReadyRef.current) {
      applyPositions(byId)
      return
    }

    setMapLayersReady(false)
    let cancelled = false
    const finish = () => {
      if (cancelled) return
      applyPositions(byId)
    }
    if (typeof requestIdleCallback !== 'undefined') {
      const id = requestIdleCallback(finish, { timeout: 12000 })
      return () => {
        cancelled = true
        cancelIdleCallback(id)
      }
    }
    const t = window.setTimeout(finish, 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [geometryKey, stations, lines])

  const showWarmupOverlay = !mapLayersReady && !mapEverReadyRef.current && isHeavyMap
  const showTransitLayer = mapLayersReady || mapEverReadyRef.current

  return (
    <div className="transitMapRoot">
    <MapContainer center={initialCenter} zoom={initialZoom} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
      <ScaleControl position="bottomleft" metric imperial />
      <TileLayer
        url={simplifiedBasemap ? CARTODB_SIMPLIFIED_TILES : CARTODB_TILES}
        attribution={ATTRIBUTION}
      />
      <FlyToController
        focusTarget={focusTarget}
        onFocusComplete={onFocusComplete}
        lines={lines}
        stations={stations}
      />
      <DemoTourClearCaptionPan registerRef={demoTourClearBelowCaptionRef} />
      <MapInvalidateOnDemoAndResize demoTourActive={demoTourActive} />
      <MapClickHandler
        mode={mode}
        onAddStation={onAddStation}
        addingStationAfter={addingStationAfter}
        onAddStationBetween={onAddStationBetween}
      />
      {showTransitLayer ? (
      <TransitLayer
        stations={stations}
        lines={lines}
        precomputedLinePositions={precomputedLinePositions}
        lineMode={!systemMapView && mode === 'line'}
        editLineMode={!systemMapView && mode === 'edit-line'}
        selectedLineId={systemMapView ? null : selectedLineId}
        systemMapSelectedLineId={systemMapView ? systemMapSelectedLineId : null}
        demoTourActive={demoTourActive}
        showStationNamesOnMap={showStationNamesOnMap}
        stationLabelOverrides={stationLabelOverrides}
        stationLabelFontFamily={stationLabelFontFamily}
        stationLabelFontSizePxOverride={stationLabelFontSizePxOverride}
        onAddStationToLine={onAddStationToLine}
        onRemoveStationFromLine={onRemoveStationFromLine}
        onStationMove={onStationMove}
        onLineSegmentClick={onLineSegmentClick}
        onLineMidpointDrop={onLineMidpointDrop}
        hiddenLineIds={hiddenLineIds}
        modeVisibility={modeVisibility}
        labelStylesByMode={labelStylesByMode}
        markerStylesByMode={markerStylesByMode}
        onStationRename={onStationRename}
        onToggleExpressStation={onToggleExpressStation}
        onDeleteStation={onDeleteStation}
      />
      ) : null}
    </MapContainer>
    {showWarmupOverlay ? (
      <div className="mapWarmupOverlay" aria-live="polite" role="status">
        <p className="mapWarmupOverlayText">Preparing map…</p>
      </div>
    ) : null}
    </div>
  )
}

