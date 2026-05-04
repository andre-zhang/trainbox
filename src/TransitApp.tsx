import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import TransitMapView from './TransitMapView'
import type { LatLng, FocusTarget, StationLabelOverride, TransitMode, ModeLabelStyle, ModeMarkerStyle } from './types'
import type { Station, Line } from './types'
import {
  getLineMode,
  DEFAULT_MODE_LABEL_STYLE,
  DEFAULT_MODE_MARKER_STYLE,
  TRANSIT_MODES,
  defaultModeVisibility,
  defaultModeGroupCollapsed,
  emptyLinesByMode,
  isTransitMode,
} from './types'
import {
  fetchOsmTransitMap,
  mergeImportIntoMap,
  findImportLineConflictsChunked,
  filterImportResult,
  isPlaceholderStopName,
  UNNAMED_STOP_PLACEHOLDER,
  DEFAULT_IMPORT_MODES,
  SAVE_VERSION as IMPORT_SAVE_VERSION,
  type ImportModeFlags,
  type OsmImportResult,
  type ImportLineConflict,
} from './transitOsmImport'
import {
  searchNominatimPlaces,
  reverseGeocodeStationName,
  NOMINATIM_REVERSE_MIN_INTERVAL_MS,
  type NominatimPlace,
} from './transitGeocode'
import { demoTourCaptionTopPx, padClientRectForDemo } from './demoTourLayout'
import { isValidSavedMap, tryRecoverSavedMap, type SavedMap } from './savedMapGuards'
import { IconUndo, IconRedo, IconPan, IconStation, IconLine, IconEditLine } from './transitUiIcons'
import './App.css'

const DEFAULT_CENTER: LatLng = { lat: 43.6532, lng: -79.3832 }
const DEFAULT_ZOOM = 12

/** Treat map clicks within this distance of a stop as “on” that stop (transfer / reuse). */
const STATION_CLICK_REUSE_RADIUS_M = 85

/** Max viewport scroll / map pan per step so the tour does not jump the whole UI. */
const DEMO_TOUR_MAX_SCROLL_STEP_PX = 130
const DEMO_TOUR_MAX_ENSURE_PASSES = 3
const DEMO_TOUR_SIDEBAR_CENTER_PASSES = 8
const DEMO_TOUR_MAP_PAN_PASSES = 4
/** Visual padding around the focused control for the dimming “hole”. */
const DEMO_TOUR_FOCUS_VISUAL_PAD = 8

const DEMO_TOUR_CURSOR_VB = 48
const DEMO_TOUR_CURSOR_SVG_PX = 68
const DEMO_TOUR_CURSOR_SCALE = 1.25
const DEMO_TOUR_CURSOR_TIP_VB = { x: 10, y: 8 }

function demoTourCursorTransform(x: number, y: number): string {
  const tipX = (DEMO_TOUR_CURSOR_TIP_VB.x / DEMO_TOUR_CURSOR_VB) * DEMO_TOUR_CURSOR_SVG_PX * DEMO_TOUR_CURSOR_SCALE
  const tipY = (DEMO_TOUR_CURSOR_TIP_VB.y / DEMO_TOUR_CURSOR_VB) * DEMO_TOUR_CURSOR_SVG_PX * DEMO_TOUR_CURSOR_SCALE
  return `translate(${x - tipX}px, ${y - tipY}px) scale(${DEMO_TOUR_CURSOR_SCALE})`
}

function demoTourFocusRectFromEl(el: HTMLElement, pad: number) {
  const r = el.getBoundingClientRect()
  return {
    x: Math.max(0, r.left - pad),
    y: Math.max(0, r.top - pad),
    width: Math.min(window.innerWidth, r.width + pad * 2),
    height: Math.min(window.innerHeight, r.height + pad * 2),
  }
}

function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

function nearestStationWithin(stations: Station[], pos: LatLng, radiusM: number): Station | null {
  let best: Station | null = null
  let bestD = Infinity
  for (const s of stations) {
    const d = distanceMeters(pos, s.position)
    if (d <= radiusM && d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

const LINE_COLORS = [
  '#e60049',
  '#0bb4ff',
  '#50e991',
  '#e6d800',
  '#9b19f5',
  '#ffa300',
  '#dc0ab4',
  '#b3d4ff',
  '#00bfa0',
  '#1a1a1a',
]

const LINE_WEIGHTS = [1, 2, 3, 4, 5, 6, 8]
const DEFAULT_LINE_WEIGHT = 3

/** Stable name so demo tour can attach refs to this line’s sidebar card. */
const DEMO_TOUR_LINE_NAME = 'Vancouver Demo Line'

function escapeAttrSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

let stationIdCounter = 0
let lineIdCounter = 0

function generateStationId() {
  return `station-${++stationIdCounter}`
}
function generateLineId(existingIds?: Set<string> | string[]) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds ?? [])
  let id: string
  do {
    id = `line-${++lineIdCounter}`
  } while (existing.has(id))
  return id
}

const UNDO_HISTORY_MAX = 50
const UNDO_HISTORY_MAX_LARGE_MAP = 20
const LARGE_MAP_STATION_THRESHOLD = 250

const SAVE_VERSION = IMPORT_SAVE_VERSION
const MIN_READER_VERSION = 2
const MAX_LOAD_FILE_BYTES = 5 * 1024 * 1024
const DRAFT_STORAGE_KEY = 'transit-map-draft'
const RECENT_STORAGE_KEY = 'transit-map-recent'
const RECENT_MAX_ITEMS = 3
const RECENT_MAX_BYTES_PER_ITEM = 1024 * 1024

function cloneForHistory<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function historySignature(s: Station[], l: Line[]): string {
  const sHead = s.slice(0, 3).map((x) => `${x.id}:${x.name}`).join('|')
  const sTail = s.slice(-3).map((x) => `${x.id}:${x.name}`).join('|')
  const lHead = l
    .slice(0, 3)
    .map((x) => `${x.id}:${x.stationIds.length}:${x.name}`)
    .join('|')
  const lTail = l
    .slice(-3)
    .map((x) => `${x.id}:${x.stationIds.length}:${x.name}`)
    .join('|')
  return `${s.length}::${l.length}::${sHead}::${sTail}::${lHead}::${lTail}`
}

function modeDefaultLabel(m: TransitMode): string {
  if (m === 'metro') return 'Metro'
  if (m === 'light_rail') return 'Light Rail'
  if (m === 'bus') return 'Bus'
  if (m === 'regional_rail') return 'Regional Rail'
  return 'National Rail'
}
const SIDEBAR_W_KEY = 'trainbox-sidebar-width'
const MODE_VISUALS_KEY = 'trainbox-mode-visuals'
const VISUALS_PANEL_WIDTH_KEY = 'trainbox-visuals-panel-width'
const VISUALS_PANEL_WIDTH_MIN = 440
const VISUALS_PANEL_WIDTH_MAX = 1240
const VISUALS_PANEL_WIDTH_FALLBACK = 860

const VISUALS_PANEL_HEIGHT_KEY = 'trainbox-visuals-panel-height'
const VISUALS_PANEL_HEIGHT_MIN = 200
const VISUALS_PANEL_HEIGHT_MAX = 860
const VISUALS_PANEL_HEIGHT_FALLBACK = 520

function readStoredVisualsPanelWidth(): number {
  if (typeof window === 'undefined') return VISUALS_PANEL_WIDTH_FALLBACK
  try {
    const raw = localStorage.getItem(VISUALS_PANEL_WIDTH_KEY)
    if (raw) {
      const w = parseInt(raw, 10)
      if (Number.isFinite(w)) {
        const vw = window.innerWidth
        const maxAllowed = Math.min(VISUALS_PANEL_WIDTH_MAX, Math.max(VISUALS_PANEL_WIDTH_MIN, vw - 12))
        return Math.min(maxAllowed, Math.max(VISUALS_PANEL_WIDTH_MIN, w))
      }
    }
  } catch {
    /* ignore */
  }
  return Math.min(VISUALS_PANEL_WIDTH_FALLBACK, Math.max(VISUALS_PANEL_WIDTH_MIN, window.innerWidth - 12))
}

function readStoredVisualsPanelHeight(): number {
  if (typeof window === 'undefined') return VISUALS_PANEL_HEIGHT_FALLBACK
  try {
    const raw = localStorage.getItem(VISUALS_PANEL_HEIGHT_KEY)
    if (raw) {
      const h = parseInt(raw, 10)
      if (Number.isFinite(h)) {
        const vh = window.innerHeight
        const maxAllowed = Math.min(VISUALS_PANEL_HEIGHT_MAX, Math.max(VISUALS_PANEL_HEIGHT_MIN, vh - 100))
        return Math.min(maxAllowed, Math.max(VISUALS_PANEL_HEIGHT_MIN, h))
      }
    }
  } catch {
    /* ignore */
  }
  return Math.min(VISUALS_PANEL_HEIGHT_FALLBACK, Math.max(VISUALS_PANEL_HEIGHT_MIN, window.innerHeight - 100))
}

function modeGroupTitle(m: TransitMode): string {
  if (m === 'metro') return 'Metro'
  if (m === 'light_rail') return 'Light rail'
  if (m === 'bus') return 'Bus'
  if (m === 'regional_rail') return 'Regional rail'
  return 'National rail'
}

function loadSidebarWidth(): number {
  try {
    const n = localStorage.getItem(SIDEBAR_W_KEY)
    if (n) return Math.max(220, Math.min(520, parseInt(n, 10)))
  } catch {
    /* ignore */
  }
  return 280
}

function loadModeVisuals(): {
  label: Record<TransitMode, ModeLabelStyle>
  marker: Record<TransitMode, ModeMarkerStyle>
} {
  const defaults = (): {
    label: Record<TransitMode, ModeLabelStyle>
    marker: Record<TransitMode, ModeMarkerStyle>
  } => {
    const label = {} as Record<TransitMode, ModeLabelStyle>
    const marker = {} as Record<TransitMode, ModeMarkerStyle>
    for (const m of TRANSIT_MODES) {
      label[m] = { ...DEFAULT_MODE_LABEL_STYLE }
      marker[m] = { ...DEFAULT_MODE_MARKER_STYLE }
    }
    return { label, marker }
  }
  try {
    const raw = localStorage.getItem(MODE_VISUALS_KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as { label?: Record<string, unknown>; marker?: Record<string, unknown> }
    const d = defaults()
    for (const m of TRANSIT_MODES) {
      const la = parsed.label?.[m]
      if (la && typeof la === 'object') {
        d.label[m] = { ...d.label[m], ...(la as ModeLabelStyle) }
      }
      const ma = parsed.marker?.[m]
      if (ma && typeof ma === 'object') {
        d.marker[m] = { ...d.marker[m], ...(ma as ModeMarkerStyle) }
      }
    }
    return d
  } catch {
    return defaults()
  }
}

type HistorySnapshot = { stations: Station[]; lines: Line[]; stationLabelOverrides: Record<string, StationLabelOverride> }

function syncIdCountersFromData(stations: Station[], lines: Line[]) {
  const stationNums = stations.map((s) => {
    const m = s.id.match(/^station-(\d+)$/)
    return m ? parseInt(m[1], 10) : 0
  })
  const lineNums = lines.map((l) => {
    const m = l.id.match(/^line-(\d+)$/)
    return m ? parseInt(m[1], 10) : 0
  })
  stationIdCounter = Math.max(0, ...stationNums)
  lineIdCounter = Math.max(0, ...lineNums)
}

export type TransitAppProps = {
  /** When set, map is persisted to Neon via `/api/map/:id` and autosaved. */
  cloudMapId?: string | null
  /** If provided, initial map state (e.g. loaded from cloud or JSON import). */
  initialSavedMap?: SavedMap | null
  onNavigateHome?: () => void
}

export default function TransitApp({
  cloudMapId = null,
  initialSavedMap = null,
  onNavigateHome,
}: TransitAppProps = {}) {
  const [stations, setStations] = useState<Station[]>(() => {
    if (initialSavedMap && isValidSavedMap(initialSavedMap)) {
      syncIdCountersFromData(initialSavedMap.stations, initialSavedMap.lines)
      return initialSavedMap.stations
    }
    return []
  })
  const [lines, setLines] = useState<Line[]>(() =>
    initialSavedMap && isValidSavedMap(initialSavedMap) ? initialSavedMap.lines : [],
  )
  const draftStorageKey = cloudMapId ? `${DRAFT_STORAGE_KEY}-cloud-${cloudMapId}` : DRAFT_STORAGE_KEY
  const [mode, setMode] = useState<'pan' | 'station' | 'line' | 'edit-line'>('pan')
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [newLineName, setNewLineName] = useState('')
  const [newLineColor, setNewLineColor] = useState(LINE_COLORS[0])
  const [newLineWeight, setNewLineWeight] = useState(DEFAULT_LINE_WEIGHT)
  /** Default map centre: first station in the list (creation / import order), not Toronto. */
  const mapCenter = useMemo(
    () => (stations.length > 0 ? stations[0].position : DEFAULT_CENTER),
    [stations],
  )
  const mapMountKey = stations.length > 0 ? stations[0].id : 'empty-map'
  const [zoom] = useState(DEFAULT_ZOOM)
  const [editingStationId, setEditingStationId] = useState<string | null>(null)
  const [focusLocation, setFocusLocation] = useState<FocusTarget | null>(null)
  const fitAllNonceRef = useRef(0)
  const [systemMapView, setSystemMapView] = useState(false)
  const [systemMapSelectedLineId, setSystemMapSelectedLineId] = useState<string | null>(null)
  const [systemMapExpandedLineIds, setSystemMapExpandedLineIds] = useState<string[]>([])
  const [showStationNamesOnMap, setShowStationNamesOnMap] = useState(false)
  const [stationLabelOverrides, setStationLabelOverrides] = useState<Record<string, StationLabelOverride>>(() =>
    initialSavedMap && isValidSavedMap(initialSavedMap)
      ? (initialSavedMap.stationLabelOverrides ?? {})
      : {},
  )
  const [stationLabelFontFamily, setStationLabelFontFamily] = useState<string>('Open Sans')
  const [stationLabelFontSizePxOverride, setStationLabelFontSizePxOverride] = useState<number | null>(null)
  const [addingStationAfter, setAddingStationAfter] = useState<{ lineId: string; afterStationId: string } | null>(null)
  const [simplifiedBasemap, setSimplifiedBasemap] = useState(false)
  const [systemMapStationSearch, setSystemMapStationSearch] = useState('')
  const [systemMapNightTheme, setSystemMapNightTheme] = useState(false)
  const [systemMapFullscreen, setSystemMapFullscreen] = useState(false)
  const [hiddenLineIds, setHiddenLineIds] = useState<string[]>([])
  const [cloudSyncLabel, setCloudSyncLabel] = useState<string | null>(null)
  const [showDraftBanner, setShowDraftBanner] = useState(false)
  const [autoAddNewStationsToSelectedLine, setAutoAddNewStationsToSelectedLine] = useState(false)
  const [addInfillAtMidpoint, setAddInfillAtMidpoint] = useState(false)
  const [editViewCollapsedLineIds, setEditViewCollapsedLineIds] = useState<string[]>([])
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [visualsMenuOpen, setVisualsMenuOpen] = useState(false)
  const [functionalMenuOpen, setFunctionalMenuOpen] = useState(false)
  const [importCityQuery, setImportCityQuery] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [importStatusText, setImportStatusText] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchPlaces, setSearchPlaces] = useState<NominatimPlace[]>([])
  const [selectedPlace, setSelectedPlace] = useState<NominatimPlace | null>(null)
  const [importModes, setImportModes] = useState<ImportModeFlags>({ ...DEFAULT_IMPORT_MODES, lightRail: true })
  const [modeVisibility, setModeVisibility] = useState<Record<TransitMode, boolean>>(defaultModeVisibility)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [labelStylesByMode, setLabelStylesByMode] = useState<Record<TransitMode, ModeLabelStyle>>(() => loadModeVisuals().label)
  const [markerStylesByMode, setMarkerStylesByMode] = useState<Record<TransitMode, ModeMarkerStyle>>(
    () => loadModeVisuals().marker,
  )
  const [editModeGroupCollapsed, setEditModeGroupCollapsed] = useState<Record<TransitMode, boolean>>(
    defaultModeGroupCollapsed,
  )
  const [systemMapModeGroupCollapsed, setSystemMapModeGroupCollapsed] = useState<Record<TransitMode, boolean>>(
    defaultModeGroupCollapsed,
  )
  const [importConflictOpen, setImportConflictOpen] = useState(false)
  const [pendingImportPayload, setPendingImportPayload] = useState<{
    result: OsmImportResult
    conflicts: ImportLineConflict[]
  } | null>(null)
  const [importAnywayIndices, setImportAnywayIndices] = useState<Set<number>>(new Set())
  const [importSuccessToast, setImportSuccessToast] = useState<{
    summary: string
    warnings: string[]
  } | null>(null)
  const [appNotice, setAppNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const importToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const appNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [newLineMode, setNewLineMode] = useState<TransitMode>('metro')
  const [autoStationNames, setAutoStationNames] = useState(true)
  /** Hide the sidebar “Validation warnings” panel until issues are fixed or warnings clear */
  const [validationWarningsDismissed, setValidationWarningsDismissed] = useState(false)
  const [visualsPanelWidthPx, setVisualsPanelWidthPx] = useState(readStoredVisualsPanelWidth)
  const [visualsPanelBodyHeightPx, setVisualsPanelBodyHeightPx] = useState(readStoredVisualsPanelHeight)
  const fileMenuRef = useRef<HTMLDivElement>(null)
  const visualsMenuRef = useRef<HTMLDivElement>(null)
  const visualsPanelRef = useRef<HTMLDivElement>(null)
  const functionalMenuRef = useRef<HTMLDivElement>(null)
  const [recentFiles, setRecentFiles] = useState<{ name: string; content: string }[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as { name: string; content: string }[]) : []
    } catch {
      return []
    }
  })

  const stationsRef = useRef(stations)
  const linesRef = useRef(lines)
  /** Latest lines for async demo tour (import completion). */
  const linesSnapshotRef = useRef(lines)
  const stationLabelOverridesRef = useRef(stationLabelOverrides)
  const selectedLineIdRef = useRef(selectedLineId)
  stationsRef.current = stations
  linesRef.current = lines
  linesSnapshotRef.current = lines
  stationLabelOverridesRef.current = stationLabelOverrides
  selectedLineIdRef.current = selectedLineId

  const pastRef = useRef<HistorySnapshot[]>([])
  const draftCheckedRef = useRef(false)
  const futureRef = useRef<HistorySnapshot[]>([])
  const enrichNamingAbortRef = useRef<AbortController | null>(null)
  /** Shared with import enrichment — Nominatim allows ~1 reverse req/s. */
  const nominatimReverseLastStartRef = useRef(0)

  const pushHistory = useCallback((s: Station[], l: Line[], o: Record<string, StationLabelOverride>) => {
    const max = s.length > LARGE_MAP_STATION_THRESHOLD ? UNDO_HISTORY_MAX_LARGE_MAP : UNDO_HISTORY_MAX
    const prev = pastRef.current[pastRef.current.length - 1]
    if (prev && historySignature(prev.stations, prev.lines) === historySignature(s, l)) return
    pastRef.current = [
      ...pastRef.current.slice(-(max - 1)),
      { stations: cloneForHistory(s), lines: cloneForHistory(l), stationLabelOverrides: { ...o } },
    ]
    futureRef.current = []
  }, [])

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return
    const prev = pastRef.current[pastRef.current.length - 1]
    futureRef.current = [
      { stations: [...stations], lines: [...lines], stationLabelOverrides: { ...stationLabelOverrides } },
      ...futureRef.current,
    ]
    pastRef.current = pastRef.current.slice(0, -1)
    setStations(prev.stations)
    setLines(prev.lines)
    setStationLabelOverrides(prev.stationLabelOverrides)
    setSelectedLineId((id) => (id != null && prev.lines.some((l) => l.id === id) ? id : null))
    setEditingStationId((id) => (id != null && prev.stations.some((s) => s.id === id) ? id : null))
    setAddingStationAfter((a) => {
      if (!a) return null
      return prev.lines.some((l) => l.id === a.lineId) && prev.stations.some((s) => s.id === a.afterStationId) ? a : null
    })
  }, [stations, lines, stationLabelOverrides])

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return
    const next = futureRef.current[0]
    pastRef.current = [
      ...pastRef.current,
      { stations: [...stations], lines: [...lines], stationLabelOverrides: { ...stationLabelOverrides } },
    ]
    futureRef.current = futureRef.current.slice(1)
    setStations(next.stations)
    setLines(next.lines)
    setStationLabelOverrides(next.stationLabelOverrides)
    setSelectedLineId((id) => (id != null && next.lines.some((l) => l.id === id) ? id : null))
    setEditingStationId((id) => (id != null && next.stations.some((s) => s.id === id) ? id : null))
    setAddingStationAfter((a) => {
      if (!a) return null
      return next.lines.some((l) => l.id === a.lineId) && next.stations.some((s) => s.id === a.afterStationId) ? a : null
    })
  }, [stations, lines, stationLabelOverrides])

  const canUndo = pastRef.current.length > 0
  const canRedo = futureRef.current.length > 0

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setAppNotice({ kind, text })
  }, [])

  const queueReverseNameForStation = useCallback((stationId: string, position: LatLng) => {
    if (!autoStationNames) return
    const run = async () => {
      try {
        const gap = Math.max(
          0,
          NOMINATIM_REVERSE_MIN_INTERVAL_MS - (Date.now() - nominatimReverseLastStartRef.current),
        )
        if (gap > 0) await new Promise((r) => setTimeout(r, gap))
        nominatimReverseLastStartRef.current = Date.now()
        const usedNames = new Set(
          stationsRef.current.map((s) => (s.name || '').trim().toLowerCase()).filter(Boolean),
        )
        const name = await reverseGeocodeStationName(position, usedNames)
        setStations((prev) => {
          const st = prev.find((s) => s.id === stationId)
          if (!st || !isPlaceholderStopName(st.name)) return prev
          return prev.map((s) => (s.id === stationId ? { ...s, name } : s))
        })
      } catch {
        /* network / parse errors — leave placeholder */
      }
    }
    void run()
  }, [autoStationNames])

  const addStation = useCallback(
    (position: LatLng) => {
      if (autoAddNewStationsToSelectedLine && selectedLineId) {
        const hit = nearestStationWithin(stations, position, STATION_CLICK_REUSE_RADIUS_M)
        if (hit) {
          const onLine = lines.find((l) => l.id === selectedLineId)?.stationIds.includes(hit.id)
          if (!onLine) {
            pushHistory(stations, lines, stationLabelOverrides)
            setLines((prev) =>
              prev.map((line) =>
                line.id === selectedLineId && !line.stationIds.includes(hit.id)
                  ? { ...line, stationIds: [...line.stationIds, hit.id] }
                  : line,
              ),
            )
          }
          return
        }
      }
      pushHistory(stations, lines, stationLabelOverrides)
      const newId = generateStationId()
      setStations((prev) => [...prev, { id: newId, name: UNNAMED_STOP_PLACEHOLDER, position }])
      queueReverseNameForStation(newId, position)
      if (autoAddNewStationsToSelectedLine && selectedLineId) {
        setLines((prev) =>
          prev.map((line) =>
            line.id === selectedLineId && !line.stationIds.includes(newId)
              ? { ...line, stationIds: [...line.stationIds, newId] }
              : line,
          ),
        )
      }
    },
    [
      stations,
      lines,
      stationLabelOverrides,
      autoAddNewStationsToSelectedLine,
      selectedLineId,
      pushHistory,
      queueReverseNameForStation,
    ],
  )

  const insertAfter = useCallback((ids: string[], afterId: string, newId: string): string[] => {
    const i = ids.indexOf(afterId)
    if (i === -1) return [...ids, newId]
    return [...ids.slice(0, i + 1), newId, ...ids.slice(i + 1)]
  }, [])

  const addStationBetween = useCallback(
    (lineId: string, afterStationId: string, position: LatLng) => {
      pushHistory(stations, lines, stationLabelOverrides)
      const newId = generateStationId()
      const newStation: Station = {
        id: newId,
        name: autoStationNames ? UNNAMED_STOP_PLACEHOLDER : `Station ${stations.length + 1}`,
        position,
      }
      setStations((prev) => [...prev, newStation])
      if (autoStationNames) queueReverseNameForStation(newId, position)
      setLines((prev) =>
        prev.map((line) => {
          if (line.id !== lineId) return line
          const newStationIds = insertAfter(line.stationIds, afterStationId, newId)
          const newWaypoints = line.waypoints?.filter((w) => w.afterStationId !== afterStationId) ?? []
          return {
            ...line,
            stationIds: newStationIds,
            waypoints: newWaypoints.length > 0 ? newWaypoints : undefined,
          }
        }),
      )
      setAddingStationAfter(null)
      setMode('edit-line')
      setSelectedLineId(lineId)
    },
    [stations, lines, stationLabelOverrides, insertAfter, pushHistory, autoStationNames, queueReverseNameForStation],
  )

  const addLine = useCallback(() => {
    pushHistory(stations, lines, stationLabelOverrides)
    const sameModeCount = lines.filter((l) => getLineMode(l) === newLineMode).length
    const name = newLineName.trim() || `${modeDefaultLabel(newLineMode)} ${sameModeCount + 1}`
    const color = newLineColor
    const weight = newLineWeight
    const existingIds = new Set(lines.map((l) => l.id))
    const line: Line = { id: generateLineId(existingIds), name, color, weight, stationIds: [], mode: newLineMode }
    setLines((prev) => [...prev, line])
    setSelectedLineId(line.id)
    setMode('line')
    setNewLineName('')
    setNewLineColor(LINE_COLORS[lines.length % LINE_COLORS.length])
    setNewLineWeight(DEFAULT_LINE_WEIGHT)
  }, [stations, lines, stationLabelOverrides, newLineName, newLineColor, newLineWeight, newLineMode, pushHistory])

  /** Demo tour: add two Vancouver-area stops to the currently selected line (no map clicks). */
  const demoSeedStopsOnSelectedLine = useCallback(() => {
    const lineId = selectedLineIdRef.current
    if (!lineId) return null
    pushHistory(stationsRef.current, linesRef.current, stationLabelOverridesRef.current)
    const id1 = generateStationId()
    const id2 = generateStationId()
    const p1: LatLng = { lat: 49.2828, lng: -123.1245 }
    const p2: LatLng = { lat: 49.2828, lng: -123.1125 }
    setStations((prev) => [
      ...prev,
      { id: id1, name: 'Tour Waterfront', position: p1 },
      { id: id2, name: 'Tour Granville', position: p2 },
    ])
    setLines((prev) =>
      prev.map((l) => (l.id === lineId ? { ...l, stationIds: [...l.stationIds, id1, id2] } : l)),
    )
    setFocusLocation({
      type: 'point',
      lat: (p1.lat + p2.lat) / 2,
      lng: (p1.lng + p2.lng) / 2,
      zoom: 13,
    })
    return id1
  }, [pushHistory])

  const demoAddLooseStation = useCallback((pos: LatLng, name: string) => {
    pushHistory(stationsRef.current, linesRef.current, stationLabelOverridesRef.current)
    const id = generateStationId()
    setStations((prev) => [...prev, { id, name, position: pos }])
    return id
  }, [pushHistory])

  const appendStopToSelectedLineDemo = useCallback((stationId: string) => {
    const lineId = selectedLineIdRef.current
    if (!lineId) return
    pushHistory(stationsRef.current, linesRef.current, stationLabelOverridesRef.current)
    setLines((prev) =>
      prev.map((line) =>
        line.id === lineId ? { ...line, stationIds: [...line.stationIds, stationId] } : line,
      ),
    )
  }, [pushHistory])

  /** Guided demo: add a curve handle on the first segment of a line (no map drag). */
  const addMidpointWaypointForTour = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId)
      if (!line || line.stationIds.length < 2) return
      const a = line.stationIds[0]
      const b = line.stationIds[1]
      const sa = stations.find((s) => s.id === a)
      const sb = stations.find((s) => s.id === b)
      if (!sa || !sb) return
      const mid: LatLng = {
        lat: (sa.position.lat + sb.position.lat) / 2 + 0.0018,
        lng: (sa.position.lng + sb.position.lng) / 2 + 0.0018,
      }
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) =>
        prev.map((l) =>
          l.id === lineId
            ? {
                ...l,
                waypoints: [
                  ...(l.waypoints ?? []).filter((w) => w.afterStationId !== a),
                  { afterStationId: a, position: mid },
                ],
              }
            : l,
        ),
      )
      setFocusLocation({
        type: 'point',
        lat: mid.lat,
        lng: mid.lng,
        zoom: 14,
      })
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  /** Guided demo: move first-segment midpoint to simulate dragging the curve handle. */
  const tourOffsetFirstSegmentWaypoint = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId)
      if (!line || line.stationIds.length < 2) return
      const afterId = line.stationIds[0]
      const wp = (line.waypoints ?? []).find((w) => w.afterStationId === afterId)
      if (!wp) return
      pushHistory(stations, lines, stationLabelOverrides)
      const position: LatLng = {
        lat: wp.position.lat + 0.0024,
        lng: wp.position.lng - 0.0018,
      }
      setLines((prev) =>
        prev.map((l) => {
          if (l.id !== lineId) return l
          const next = (l.waypoints ?? []).map((w) =>
            w.afterStationId === afterId ? { ...w, position } : w,
          )
          return { ...l, waypoints: next }
        }),
      )
      setFocusLocation({ type: 'point', ...position, zoom: 15 })
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  /** Guided demo: unnamed stop + reverse geocode (auto name). */
  const demoAddUnnamedStationForTour = useCallback(
    (pos: LatLng) => {
      if (!autoStationNames) return null
      pushHistory(stationsRef.current, linesRef.current, stationLabelOverridesRef.current)
      const id = generateStationId()
      setStations((prev) => [...prev, { id, name: UNNAMED_STOP_PLACEHOLDER, position: pos }])
      queueReverseNameForStation(id, pos)
      return id
    },
    [pushHistory, autoStationNames, queueReverseNameForStation],
  )

  const addStationToLine = useCallback(
    (stationId: string) => {
      if (!selectedLineId) return
      const line = lines.find((l) => l.id === selectedLineId)
      if (line?.stationIds.includes(stationId)) return
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) =>
        prev.map((l) =>
          l.id === selectedLineId && !l.stationIds.includes(stationId)
            ? { ...l, stationIds: [...l.stationIds, stationId] }
            : l,
        ),
      )
    },
    [selectedLineId, stations, lines, stationLabelOverrides, pushHistory],
  )

  const removeStationFromLine = useCallback(
    (lineId: string, stationId: string, atIndex?: number) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) =>
        prev.map((line) => {
          if (line.id !== lineId) return line
          if (atIndex !== undefined) {
            return { ...line, stationIds: line.stationIds.filter((_, i) => i !== atIndex) }
          }
          const lastIdx = line.stationIds.lastIndexOf(stationId)
          if (lastIdx === -1) return line
          return { ...line, stationIds: line.stationIds.filter((_, i) => i !== lastIdx) }
        }),
      )
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const breakLoopLine = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId)
      if (!line || line.stationIds.length < 2) return
      const first = line.stationIds[0]
      const last = line.stationIds[line.stationIds.length - 1]
      if (first !== last) return
      pushHistory(stations, lines, stationLabelOverrides)
      const afterStationIdToRemove = line.stationIds[line.stationIds.length - 2]
      setLines((prev) =>
        prev.map((l) => {
          if (l.id !== lineId) return l
          const newStationIds = l.stationIds.slice(0, -1)
          const newWaypoints = l.waypoints?.filter((w) => w.afterStationId !== afterStationIdToRemove) ?? []
          return {
            ...l,
            stationIds: newStationIds,
            waypoints: newWaypoints.length > 0 ? newWaypoints : undefined,
          }
        }),
      )
    },
    [lines, stations, stationLabelOverrides, pushHistory],
  )

  const deleteLine = useCallback(
    (lineId: string) => {
      pushHistory(stations, lines, stationLabelOverrides)
      const line = lines.find((l) => l.id === lineId)
      if (!line) return
      const nextLines = lines.filter((l) => l.id !== lineId)
      const stillUsed = new Set<string>()
      nextLines.forEach((l) => l.stationIds.forEach((id) => stillUsed.add(id)))
      const toRemove = line.stationIds.filter((id) => !stillUsed.has(id))
      setLines(
        nextLines.map((l) => {
          let w = l.waypoints
          if (w && toRemove.length) {
            w = w.filter((wp) => !toRemove.includes(wp.afterStationId))
            if (w.length === 0) w = undefined
          }
          let ex = l.expressStationIds
          if (ex && toRemove.length) {
            ex = ex.filter((id) => !toRemove.includes(id))
          }
          return { ...l, waypoints: w, expressStationIds: ex }
        }),
      )
      if (toRemove.length) {
        setStations((prev) => prev.filter((s) => !toRemove.includes(s.id)))
        setStationLabelOverrides((prev) => {
          const next = { ...prev }
          for (const id of toRemove) delete next[id]
          return next
        })
      }
      if (selectedLineId === lineId) setSelectedLineId(null)
      setEditingStationId((id) => (id && toRemove.includes(id) ? null : id))
      setHiddenLineIds((prev) => prev.filter((id) => id !== lineId))
      setEditViewCollapsedLineIds((prev) => prev.filter((id) => id !== lineId))
      setSystemMapExpandedLineIds((prev) => prev.filter((id) => id !== lineId))
      if (systemMapSelectedLineId === lineId) setSystemMapSelectedLineId(null)
    },
    [selectedLineId, stations, lines, stationLabelOverrides, pushHistory, systemMapSelectedLineId],
  )

  const updateLineName = useCallback(
    (lineId: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, name: trimmed } : l)))
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const updateLineColor = useCallback(
    (lineId: string, color: string) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, color } : l)))
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const updateLineWeight = useCallback(
    (lineId: string, weight: number) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, weight } : l)))
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const updateLineMode = useCallback(
    (lineId: string, mode: TransitMode) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, mode } : l)))
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const updateLineDashArray = useCallback(
    (lineId: string, dashArray: string) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) =>
        prev.map((l) => (l.id === lineId ? { ...l, dashArray: dashArray || undefined } : l)),
      )
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const updateLinePlanned = useCallback(
    (lineId: string, planned: boolean) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, planned } : l)))
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const updateLineExpressEnabled = useCallback(
    (lineId: string, expressEnabled: boolean) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) =>
        prev.map((l) =>
          l.id === lineId
            ? {
                ...l,
                expressEnabled,
                expressStationIds: expressEnabled ? l.expressStationIds ?? [] : [],
              }
            : l,
        ),
      )
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const toggleLineExpressStation = useCallback(
    (lineId: string, stationId: string) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setLines((prev) =>
        prev.map((l) => {
          if (l.id !== lineId) return l
          if (!l.expressEnabled) return l
          const current = l.expressStationIds ?? []
          const exists = current.includes(stationId)
          const next = exists ? current.filter((id) => id !== stationId) : [...current, stationId]
          return { ...l, expressStationIds: next }
        }),
      )
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const deleteStation = useCallback(
    (stationId: string) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setStations((prev) => prev.filter((s) => s.id !== stationId))
      setLines((prev) =>
        prev.map((line) => ({
          ...line,
          stationIds: line.stationIds.filter((id) => id !== stationId),
        })),
      )
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const renameStation = useCallback(
    (stationId: string, name: string) => {
      pushHistory(stations, lines, stationLabelOverrides)
      const trimmed = name.trim()
      setStations((prev) =>
        prev.map((s) => (s.id === stationId ? { ...s, name: trimmed || s.name } : s)),
      )
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const moveStation = useCallback(
    (stationId: string, position: LatLng) => {
      pushHistory(stations, lines, stationLabelOverrides)
      const SNAP_THRESHOLD_M = 80
      const distM = (a: LatLng, b: LatLng): number => {
        const R = 6371000
        const dLat = ((b.lat - a.lat) * Math.PI) / 180
        const dLng = ((b.lng - a.lng) * Math.PI) / 180
        const x =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((a.lat * Math.PI) / 180) *
            Math.cos((b.lat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2
        return 2 * R * Math.asin(Math.sqrt(x))
      }
      setStations((prev) => {
        const others = prev.filter((s) => s.id !== stationId)
        let finalPosition = position
        let bestDist = SNAP_THRESHOLD_M
        for (const s of others) {
          const d = distM(position, s.position)
          if (d < bestDist) {
            bestDist = d
            finalPosition = s.position
          }
        }
        return prev.map((s) => (s.id === stationId ? { ...s, position: finalPosition } : s))
      })
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const distToSegmentSq = useCallback((p: LatLng, a: LatLng, b: LatLng): number => {
    const dx = b.lng - a.lng
    const dy = b.lat - a.lat
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) return (p.lng - a.lng) ** 2 + (p.lat - a.lat) ** 2
    let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    const proj = { lng: a.lng + t * dx, lat: a.lat + t * dy }
    return (p.lng - proj.lng) ** 2 + (p.lat - proj.lat) ** 2
  }, [])

  const addStationOnLineSegment = useCallback(
    (lineId: string, position: LatLng, lineIndex?: number) => {
      const targetIndex =
        lineIndex !== undefined && lineIndex >= 0 && lineIndex < lines.length
          ? lineIndex
          : lines.findIndex((l) => l.id === lineId)
      if (targetIndex < 0) return
      const line = lines[targetIndex]
      if (!line || line.id !== lineId || line.stationIds.length < 2) return
      const positions = line.stationIds
        .map((id) => stations.find((s) => s.id === id)?.position)
        .filter((p): p is LatLng => p != null)
      if (positions.length < 2) return
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < positions.length - 1; i++) {
        const d = distToSegmentSq(position, positions[i], positions[i + 1])
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      const afterStationId = line.stationIds[bestIdx]
      const insertPosition: LatLng = addInfillAtMidpoint
        ? {
            lat: (positions[bestIdx].lat + positions[bestIdx + 1].lat) / 2,
            lng: (positions[bestIdx].lng + positions[bestIdx + 1].lng) / 2,
          }
        : position
      const newId = generateStationId()
      const newStation: Station = {
        id: newId,
        name: autoStationNames ? UNNAMED_STOP_PLACEHOLDER : `Station ${stations.length + 1}`,
        position: insertPosition,
      }
      pushHistory(stations, lines, stationLabelOverrides)
      setStations((prev) => [...prev, newStation])
      if (autoStationNames) queueReverseNameForStation(newId, insertPosition)
      setLines((prev) =>
        prev.map((l, idx) => {
          if (idx !== targetIndex) return l
          const newStationIds = insertAfter(l.stationIds, afterStationId, newId)
          const newWaypoints = l.waypoints?.filter((w) => w.afterStationId !== afterStationId) ?? []
          return {
            ...l,
            stationIds: newStationIds,
            waypoints: newWaypoints.length > 0 ? newWaypoints : undefined,
          }
        }),
      )
    },
    [
      lines,
      stations,
      stationLabelOverrides,
      addInfillAtMidpoint,
      distToSegmentSq,
      insertAfter,
      pushHistory,
      autoStationNames,
      queueReverseNameForStation,
    ],
  )

  const SNAP_THRESHOLD_M = 80
  const distM = useCallback((a: LatLng, b: LatLng): number => {
    const R = 6371000
    const dLat = ((b.lat - a.lat) * Math.PI) / 180
    const dLng = ((b.lng - a.lng) * Math.PI) / 180
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) *
        Math.cos((b.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(x))
  }, [])

  const addLineMidpointDrop = useCallback(
    (lineId: string, afterStationId: string, position: LatLng, fromStart?: boolean) => {
      pushHistory(stations, lines, stationLabelOverrides)
      const line = lines.find((l) => l.id === lineId)
      if (!line) return
      const firstStationId = line.stationIds[0]
      const lastStationId = line.stationIds[line.stationIds.length - 1]
      let snapStation: Station | null = null
      let bestDist = SNAP_THRESHOLD_M
      for (const s of stations) {
        const d = distM(position, s.position)
        if (d < bestDist) {
          bestDist = d
          snapStation = s
        }
      }
      if (snapStation) {
        const isExtendFromEnd = !fromStart && afterStationId === lastStationId
        const isExtendFromStart = fromStart && afterStationId === firstStationId
        const alreadyOnLine = line.stationIds.includes(snapStation.id)

        if (isExtendFromEnd) {
          setLines((prev) =>
            prev.map((l) =>
              l.id === lineId ? { ...l, stationIds: [...l.stationIds, snapStation!.id] } : l,
            ),
          )
        } else if (isExtendFromStart) {
          setLines((prev) =>
            prev.map((l) =>
              l.id === lineId ? { ...l, stationIds: [snapStation!.id, ...l.stationIds] } : l,
            ),
          )
        } else if (alreadyOnLine) {
          setLines((prev) =>
            prev.map((l) =>
              l.id === lineId
                ? { ...l, stationIds: l.stationIds.filter((id) => id !== snapStation!.id) }
                : l,
            ),
          )
        } else {
          if (fromStart) {
            setLines((prev) =>
              prev.map((l) =>
                l.id === lineId ? { ...l, stationIds: [snapStation!.id, ...l.stationIds] } : l,
              ),
            )
          } else {
            setLines((prev) =>
              prev.map((l) =>
                l.id === lineId
                  ? { ...l, stationIds: insertAfter(l.stationIds, afterStationId, snapStation!.id) }
                  : l,
              ),
            )
          }
        }
      } else {
        const isExtendFromEnd = !fromStart && afterStationId === lastStationId
        const isExtendFromStart = fromStart && afterStationId === firstStationId
        const isExtendDrop = isExtendFromEnd || isExtendFromStart
        if (addInfillAtMidpoint || isExtendDrop) {
          const newId = generateStationId()
          const newStation: Station = {
            id: newId,
            name: autoStationNames ? UNNAMED_STOP_PLACEHOLDER : `Station ${stations.length + 1}`,
            position,
          }
          setStations((prev) => [...prev, newStation])
          if (autoStationNames) queueReverseNameForStation(newId, position)
          setLines((prev) =>
            prev.map((l) => {
              if (l.id !== lineId) return l
              if (isExtendFromStart) {
                return { ...l, stationIds: [newId, ...l.stationIds] }
              }
              const newStationIds = insertAfter(l.stationIds, afterStationId, newId)
              const newWaypoints = l.waypoints?.filter((w) => w.afterStationId !== afterStationId) ?? []
              return {
                ...l,
                stationIds: newStationIds,
                waypoints: newWaypoints.length > 0 ? newWaypoints : undefined,
              }
            }),
          )
        } else {
          setLines((prev) =>
            prev.map((l) => {
              if (l.id !== lineId) return l
              const waypoints = l.waypoints ? [...l.waypoints] : []
              const idx = waypoints.findIndex((w) => w.afterStationId === afterStationId)
              const wp = { afterStationId, position }
              if (idx >= 0) waypoints[idx] = wp
              else waypoints.push(wp)
              return { ...l, waypoints }
            }),
          )
        }
      }
    },
    [
      lines,
      stations,
      stationLabelOverrides,
      addInfillAtMidpoint,
      distM,
      insertAfter,
      pushHistory,
      autoStationNames,
      queueReverseNameForStation,
    ],
  )

  /** Guided demo: extend route from last stop (same as drag-release on the end midpoint handle). */
  const extendLineFromTerminusDemo = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId)
      if (!line || line.stationIds.length < 2) return
      const lastId = line.stationIds[line.stationIds.length - 1]
      const last = stations.find((s) => s.id === lastId)
      const prev = stations.find((s) => s.id === line.stationIds[line.stationIds.length - 2])
      if (!last || !prev) return
      const dx = last.position.lng - prev.position.lng
      const dy = last.position.lat - prev.position.lat
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const off = 0.00014
      addLineMidpointDrop(lineId, lastId, {
        lat: last.position.lat + (off * dy) / len,
        lng: last.position.lng + (off * dx) / len,
      })
    },
    [lines, stations, addLineMidpointDrop],
  )

  const selectedLine = selectedLineId ? lines.find((l) => l.id === selectedLineId) : null

  const lineCenter = useCallback(
    (line: Line): LatLng | null => {
      if (line.stationIds.length === 0) return null
      const positions = line.stationIds
        .map((id) => stations.find((s) => s.id === id)?.position)
        .filter((p): p is LatLng => p != null)
      if (positions.length === 0) return null
      const n = positions.length
      const lat = positions.reduce((a, p) => a + p.lat, 0) / n
      const lng = positions.reduce((a, p) => a + p.lng, 0) / n
      return { lat, lng }
    },
    [stations],
  )

  const focusOnStation = useCallback((station: Station) => {
    setFocusLocation({ type: 'point', ...station.position, zoom: 16 })
  }, [])

  const focusOnLine = useCallback(
    (line: Line) => {
      const centerPos = lineCenter(line)
      if (centerPos) setFocusLocation({ type: 'point', ...centerPos, zoom: 15 })
    },
    [lineCenter],
  )

  const selectLineInSystemMap = useCallback((line: Line) => {
    setSystemMapSelectedLineId(line.id)
    setFocusLocation({ type: 'line', lineId: line.id })
  }, [])

  const setStationLabelOverride = useCallback(
    (stationId: string, override: StationLabelOverride | null) => {
      pushHistory(stations, lines, stationLabelOverrides)
      setStationLabelOverrides((prev) => {
        if (override == null) {
          const next = { ...prev }
          delete next[stationId]
          return next
        }
        return { ...prev, [stationId]: override }
      })
    },
    [stations, lines, stationLabelOverrides, pushHistory],
  )

  const toggleSystemMapLineExpanded = useCallback((lineId: string) => {
    setSystemMapExpandedLineIds((prev) =>
      prev.includes(lineId) ? prev.filter((id) => id !== lineId) : [...prev, lineId],
    )
  }, [])

  const validationWarnings = useMemo(() => {
    const stationIdsSet = new Set(stations.map((s) => s.id))
    const stationIdsOnLines = new Set<string>()
    lines.forEach((l) => l.stationIds.forEach((id) => stationIdsOnLines.add(id)))
    const orphanStationIds = stations.filter((s) => !stationIdsOnLines.has(s.id)).map((s) => s.id)
    const emptyLineIds = lines.filter((l) => l.stationIds.length === 0).map((l) => l.id)
    const linesWithMissingStations = lines.filter((line) =>
      line.stationIds.some((id) => !stationIdsSet.has(id)),
    )
    const nameToIds = new Map<string, string[]>()
    stations.forEach((s) => {
      const n = (s.name || '').trim().toLowerCase()
      if (!n) return
      const list = nameToIds.get(n) ?? []
      list.push(s.id)
      nameToIds.set(n, list)
    })
    const duplicateStationNames = Array.from(nameToIds.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([name]) => name)
    return { orphanStationIds, emptyLineIds, duplicateStationNames, linesWithMissingStations }
  }, [stations, lines])

  const linesByMode = useMemo(() => {
    const m = emptyLinesByMode()
    for (const line of lines) m[getLineMode(line)].push(line)
    return m
  }, [lines])

  const linesByStationId = useMemo(() => {
    const m = new Map<string, Line[]>()
    for (const l of lines) {
      const seenOnLine = new Set<string>()
      for (const sid of l.stationIds) {
        if (seenOnLine.has(sid)) continue
        seenOnLine.add(sid)
        let arr = m.get(sid)
        if (!arr) {
          arr = []
          m.set(sid, arr)
        }
        arr.push(l)
      }
    }
    return m
  }, [lines])

  const hasValidationWarnings =
    validationWarnings.orphanStationIds.length > 0 ||
    validationWarnings.emptyLineIds.length > 0 ||
    validationWarnings.duplicateStationNames.length > 0 ||
    validationWarnings.linesWithMissingStations.length > 0

  useEffect(() => {
    if (!hasValidationWarnings) setValidationWarningsDismissed(false)
  }, [hasValidationWarnings])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const systemMapContainerRef = useRef<HTMLDivElement>(null)

  const demoImportInputRef = useRef<HTMLInputElement>(null)
  const demoImportSearchRef = useRef<HTMLButtonElement>(null)
  const demoImportMetroRef = useRef<HTMLInputElement>(null)
  const demoImportLightRailRef = useRef<HTMLInputElement>(null)
  const demoImportBtnRef = useRef<HTMLButtonElement>(null)
  const demoTourStartBtnRef = useRef<HTMLButtonElement>(null)
  const demoFirstPlaceRef = useRef<HTMLButtonElement>(null)
  const demoNewLineInputRef = useRef<HTMLInputElement>(null)
  const demoCreateLineRef = useRef<HTMLButtonElement>(null)
  const demoToolStationRef = useRef<HTMLButtonElement>(null)
  const demoToolLineRef = useRef<HTMLButtonElement>(null)
  const demoToolEditRef = useRef<HTMLButtonElement>(null)
  const demoVisualsBtnRef = useRef<HTMLButtonElement>(null)
  const demoVisualsShowNamesRef = useRef<HTMLInputElement>(null)
  const demoFunctionalBtnRef = useRef<HTMLButtonElement>(null)
  const demoFunctionalMetroVisRef = useRef<HTMLInputElement>(null)
  const demoUndoRef = useRef<HTMLButtonElement>(null)
  const demoSystemMapRef = useRef<HTMLButtonElement>(null)
  const demoBackEditRef = useRef<HTMLButtonElement>(null)
  const demoConflictContinueRef = useRef<HTMLButtonElement>(null)
  const demoBasemapRef = useRef<HTMLInputElement>(null)
  const demoInfillCheckboxRef = useRef<HTMLInputElement>(null)
  const demoLabelPresetRef = useRef<HTMLButtonElement>(null)
  const demoSystemNightRef = useRef<HTMLInputElement>(null)
  const demoNewLineModeSelectRef = useRef<HTMLSelectElement>(null)
  const demoSidebarResizeRef = useRef<HTMLDivElement>(null)
  const demoTourLineNameInputRef = useRef<HTMLInputElement>(null)
  const demoTourLineModeSelectRef = useRef<HTMLSelectElement>(null)
  const demoTourLineWeightSelectRef = useRef<HTMLSelectElement>(null)
  const demoTourLineDashSelectRef = useRef<HTMLSelectElement>(null)
  const demoTourMetroMarkerScaleRef = useRef<HTMLInputElement>(null)
  const demoMapWrapRef = useRef<HTMLElement>(null)
  const demoTourClearBelowCaptionRef = useRef<((el: HTMLElement) => void) | null>(null)
  const demoTourAutoStationNamesRef = useRef<HTMLInputElement>(null)
  const demoAutoAddToLineRef = useRef<HTMLInputElement>(null)

  type DemoTourCtx = {
    runOsmImport: () => Promise<void>
    confirmImportWithConflicts: () => void
    setImportAnywayIndices: React.Dispatch<React.SetStateAction<Set<number>>>
    importConflictOpen: boolean
    pendingImportPayload: { result: OsmImportResult; conflicts: ImportLineConflict[] } | null
    searchNominatimPlaces: typeof searchNominatimPlaces
    setSearchPlaces: React.Dispatch<React.SetStateAction<NominatimPlace[]>>
    setSelectedPlace: React.Dispatch<React.SetStateAction<NominatimPlace | null>>
    setImportModes: React.Dispatch<React.SetStateAction<ImportModeFlags>>
    setImportCityQuery: React.Dispatch<React.SetStateAction<string>>
    setFileMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
    setVisualsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
    setFunctionalMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
    pushHistory: (s: Station[], l: Line[], o: Record<string, StationLabelOverride>) => void
    setStations: React.Dispatch<React.SetStateAction<Station[]>>
    setLines: React.Dispatch<React.SetStateAction<Line[]>>
    setSelectedLineId: React.Dispatch<React.SetStateAction<string | null>>
    setEditingStationId: React.Dispatch<React.SetStateAction<string | null>>
    setStationLabelOverrides: React.Dispatch<React.SetStateAction<Record<string, StationLabelOverride>>>
    setNewLineName: React.Dispatch<React.SetStateAction<string>>
    setNewLineMode: React.Dispatch<React.SetStateAction<TransitMode>>
    setMode: React.Dispatch<React.SetStateAction<'pan' | 'station' | 'line' | 'edit-line'>>
    setShowStationNamesOnMap: React.Dispatch<React.SetStateAction<boolean>>
    setLabelStylesByMode: React.Dispatch<React.SetStateAction<Record<TransitMode, ModeLabelStyle>>>
    setModeVisibility: React.Dispatch<React.SetStateAction<Record<TransitMode, boolean>>>
    renameStation: (stationId: string, name: string) => void
    setStationLabelOverride: (stationId: string, override: StationLabelOverride | null) => void
    undo: () => void
    setSystemMapView: React.Dispatch<React.SetStateAction<boolean>>
    setFocusLocation: React.Dispatch<React.SetStateAction<FocusTarget | null>>
    demoSeedStopsOnSelectedLine: () => string | null
    setImportSuccessToast: React.Dispatch<
      React.SetStateAction<{ summary: string; warnings: string[] } | null>
    >
    notify: (text: string, kind?: 'info' | 'error') => void
    demoAddLooseStation: (pos: LatLng, name: string) => string
    appendStopToSelectedLineDemo: (stationId: string) => void
    setSimplifiedBasemap: React.Dispatch<React.SetStateAction<boolean>>
    setAddInfillAtMidpoint: React.Dispatch<React.SetStateAction<boolean>>
    setSystemMapNightTheme: React.Dispatch<React.SetStateAction<boolean>>
    updateLineMode: (lineId: string, mode: TransitMode) => void
    updateLineDashArray: (lineId: string, dashArray: string) => void
    updateLineWeight: (lineId: string, weight: number) => void
    setMarkerStylesByMode: React.Dispatch<React.SetStateAction<Record<TransitMode, ModeMarkerStyle>>>
    setSidebarWidth: React.Dispatch<React.SetStateAction<number>>
    setEditModeGroupCollapsed: React.Dispatch<React.SetStateAction<Record<TransitMode, boolean>>>
    addMidpointWaypointForTour: (lineId: string) => void
    tourOffsetFirstSegmentWaypoint: (lineId: string) => void
    /** Same outcome as dragging the extend handle past the last stop and releasing. */
    extendLineFromTerminusDemo: (lineId: string) => void
    demoAddUnnamedStationForTour: (pos: LatLng) => string | null
    deleteStation: (stationId: string) => void
    setAutoAddNewStationsToSelectedLine: React.Dispatch<React.SetStateAction<boolean>>
    expandEditLineCard: (lineId: string) => void
  }

  const demoTourCtxRef = useRef<DemoTourCtx>({} as DemoTourCtx)
  const demoTourPrimaryLineIdRef = useRef<string | null>(null)

  const [demoTourActive, setDemoTourActive] = useState(false)
  const [demoTourCaption, setDemoTourCaption] = useState('')
  const [demoTourSubtext, setDemoTourSubtext] = useState('')
  const [demoTourCursor, setDemoTourCursor] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  })
  const [demoTourHighlightRect, setDemoTourHighlightRect] = useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const [demoTourHighlightStrong, setDemoTourHighlightStrong] = useState(false)
  const [demoTourEndCardOpen, setDemoTourEndCardOpen] = useState(false)
  const [demoTourFadeOut, setDemoTourFadeOut] = useState(false)
  /** Line created in-tour (“Vancouver Demo Line”) — sidebar + demo queries target this card. */
  const [demoTourPrimaryLineId, setDemoTourPrimaryLineId] = useState<string | null>(null)
  const demoTourAbortRef = useRef(false)
  const importLoadingRef = useRef(false)

  useEffect(() => {
    importLoadingRef.current = importLoading
  }, [importLoading])

  const appMountedRef = useRef(true)
  useEffect(() => {
    appMountedRef.current = true
    return () => {
      appMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!systemMapView) {
      if (document.fullscreenElement) document.exitFullscreen?.()
      return
    }
    if (!systemMapFullscreen && document.fullscreenElement) {
      document.exitFullscreen?.()
    }
    const onFullscreenChange = () => setSystemMapFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [systemMapView, systemMapFullscreen])

  const saveMapToFile = useCallback(() => {
    const data = {
      version: SAVE_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      stations,
      lines,
      stationLabelOverrides,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transit-map-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [stations, lines, stationLabelOverrides])

  const applyLoadedMap = useCallback((data: SavedMap, sourceName?: string) => {
    setStations(data.stations)
    const seenLineIds = new Set<string>()
    const dedupedLines: Line[] = data.lines.map((l) => {
      let id = l.id
      if (seenLineIds.has(id)) {
        id = generateLineId(seenLineIds)
      }
      seenLineIds.add(id)
      const mode = isTransitMode(l.mode) ? l.mode : undefined
      return { ...l, id, mode }
    })
    syncIdCountersFromData(data.stations, dedupedLines)
    setLines(dedupedLines)
    setStationLabelOverrides(data.stationLabelOverrides ?? {})
    pastRef.current = []
    futureRef.current = []
    setSelectedLineId(null)
    setEditingStationId(null)
    setFocusLocation(null)
    setSystemMapSelectedLineId(null)
    setSystemMapExpandedLineIds([])
    setHiddenLineIds([])
    if (sourceName) {
      const content = JSON.stringify({
        version: data.version,
        stations: data.stations,
        lines: data.lines,
        stationLabelOverrides: data.stationLabelOverrides,
      })
      if (content.length <= RECENT_MAX_BYTES_PER_ITEM) {
        setRecentFiles((prev) => {
          const next = [
            { name: sourceName, content },
            ...prev.filter((r) => r.name !== sourceName),
          ].slice(0, RECENT_MAX_ITEMS)
          try {
            localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
          } catch {
            /* ignore */
          }
          return next
        })
      }
    }
  }, [])

  const loadMapFromFile = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  useEffect(() => {
    if (!fileMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) setFileMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [fileMenuOpen])

  useEffect(() => {
    if (!visualsMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (visualsMenuRef.current && !visualsMenuRef.current.contains(e.target as Node)) setVisualsMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [visualsMenuOpen])

  useEffect(() => {
    if (!functionalMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (functionalMenuRef.current && !functionalMenuRef.current.contains(e.target as Node)) setFunctionalMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [functionalMenuOpen])

  /** Auto-dismiss import success toast */
  useEffect(() => {
    if (!importSuccessToast) return
    if (importToastTimerRef.current) clearTimeout(importToastTimerRef.current)
    importToastTimerRef.current = setTimeout(() => {
      setImportSuccessToast(null)
      importToastTimerRef.current = null
    }, 9000)
    return () => {
      if (importToastTimerRef.current) {
        clearTimeout(importToastTimerRef.current)
        importToastTimerRef.current = null
      }
    }
  }, [importSuccessToast])

  useEffect(() => {
    if (!appNotice) return
    if (appNoticeTimerRef.current) clearTimeout(appNoticeTimerRef.current)
    appNoticeTimerRef.current = setTimeout(() => {
      setAppNotice(null)
      appNoticeTimerRef.current = null
    }, appNotice.kind === 'error' ? 7000 : 5000)
    return () => {
      if (appNoticeTimerRef.current) {
        clearTimeout(appNoticeTimerRef.current)
        appNoticeTimerRef.current = null
      }
    }
  }, [appNotice])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth))
    } catch {
      /* ignore */
    }
  }, [sidebarWidth])

  useEffect(() => {
    if (!visualsMenuOpen) return
    setVisualsPanelWidthPx((prev) => {
      const vw = window.innerWidth
      const maxW = Math.min(VISUALS_PANEL_WIDTH_MAX, vw - 12)
      return Math.min(maxW, Math.max(VISUALS_PANEL_WIDTH_MIN, prev))
    })
    setVisualsPanelBodyHeightPx((prev) => {
      const vh = window.innerHeight
      const maxH = Math.min(VISUALS_PANEL_HEIGHT_MAX, vh - 100)
      return Math.min(maxH, Math.max(VISUALS_PANEL_HEIGHT_MIN, prev))
    })
  }, [visualsMenuOpen])

  const persistVisualsPanelSize = useCallback(() => {
    const shell = visualsPanelRef.current
    if (!shell) return
    try {
      const w = shell.getBoundingClientRect().width
      if (w >= VISUALS_PANEL_WIDTH_MIN) {
        localStorage.setItem(VISUALS_PANEL_WIDTH_KEY, String(Math.round(w)))
      }
      const body = shell.querySelector('.visualsPanelBody')
      if (body) {
        const h = body.getBoundingClientRect().height
        if (h >= VISUALS_PANEL_HEIGHT_MIN) {
          localStorage.setItem(VISUALS_PANEL_HEIGHT_KEY, String(Math.round(h)))
        }
      }
    } catch {
      /* ignore */
    }
  }, [])

  const startVisualsPanelResizeWidth = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const el = visualsPanelRef.current
    if (!el) return
    const startW = el.getBoundingClientRect().width
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const vw = window.innerWidth
      const maxW = Math.min(VISUALS_PANEL_WIDTH_MAX, vw - 12)
      const dx = ev.clientX - startX
      const next = Math.min(maxW, Math.max(VISUALS_PANEL_WIDTH_MIN, startW + dx))
      setVisualsPanelWidthPx(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      persistVisualsPanelSize()
    }
    document.addEventListener('mousemove', onMove, { passive: false })
    document.addEventListener('mouseup', onUp)
  }, [persistVisualsPanelSize])

  const startVisualsPanelResizeHeight = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const body = visualsPanelRef.current?.querySelector('.visualsPanelBody')
    if (!body) return
    const startH = body.getBoundingClientRect().height
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const vh = window.innerHeight
      const maxH = Math.min(VISUALS_PANEL_HEIGHT_MAX, vh - 100)
      const dy = ev.clientY - startY
      const next = Math.min(maxH, Math.max(VISUALS_PANEL_HEIGHT_MIN, startH + dy))
      setVisualsPanelBodyHeightPx(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      persistVisualsPanelSize()
    }
    document.addEventListener('mousemove', onMove, { passive: false })
    document.addEventListener('mouseup', onUp)
  }, [persistVisualsPanelSize])

  const startVisualsPanelResizeCorner = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const el = visualsPanelRef.current
    if (!el) return
    const body = el.querySelector('.visualsPanelBody')
    if (!body) return
    const startW = el.getBoundingClientRect().width
    const startH = body.getBoundingClientRect().height
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const maxW = Math.min(VISUALS_PANEL_WIDTH_MAX, vw - 12)
      const maxH = Math.min(VISUALS_PANEL_HEIGHT_MAX, vh - 100)
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      setVisualsPanelWidthPx(Math.min(maxW, Math.max(VISUALS_PANEL_WIDTH_MIN, startW + dx)))
      setVisualsPanelBodyHeightPx(Math.min(maxH, Math.max(VISUALS_PANEL_HEIGHT_MIN, startH + dy)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      persistVisualsPanelSize()
    }
    document.addEventListener('mousemove', onMove, { passive: false })
    document.addEventListener('mouseup', onUp)
  }, [persistVisualsPanelSize])

  useEffect(() => {
    try {
      localStorage.setItem(
        MODE_VISUALS_KEY,
        JSON.stringify({ label: labelStylesByMode, marker: markerStylesByMode }),
      )
    } catch {
      /* ignore */
    }
  }, [labelStylesByMode, markerStylesByMode])

  const loadMapFromContent = useCallback(
    (content: string, name: string, confirmBeforeRecovery = false): boolean => {
      try {
        const data = JSON.parse(content)
        if (isValidSavedMap(data)) {
          if (data.version > SAVE_VERSION) {
            if (
              !window.confirm(
                'This file was saved with a newer version of the app. Some features may not work. Load anyway?',
              )
            )
              return false
          }
          applyLoadedMap(data, name)
          return true
        }
        const recovered = tryRecoverSavedMap(data)
        if (recovered) {
          if (confirmBeforeRecovery) {
            const tryAnyway = window.confirm(
              'File format is invalid or from a different version. Try to load what we can? Some data may be missing.',
            )
            if (!tryAnyway) return false
          }
          applyLoadedMap(recovered, name)
          notify('Loaded with recovery. Some data may be missing.')
          return true
        }
        notify('Invalid map file. Could not load.', 'error')
        return false
      } catch {
        notify('File is not valid JSON. Please choose a file saved from this tool.', 'error')
        return false
      }
    },
    [applyLoadedMap, notify],
  )

  /** After import: name placeholders via Nominatim — paced at ~1 req/s from each request start (faster than a fixed pre-delay). */
  const enrichImportedPlaceholderNames = useCallback(
    async (stationList: Station[]) => {
      if (!autoStationNames) return
      const toFix = stationList.filter((s) => isPlaceholderStopName(s.name))
      if (toFix.length === 0) return
      enrichNamingAbortRef.current?.abort()
      const ac = new AbortController()
      enrichNamingAbortRef.current = ac
      const used = new Set<string>()
      for (const s of stationList) {
        if (!isPlaceholderStopName(s.name)) {
          used.add((s.name || '').trim().toLowerCase())
        }
      }
      const idToName = new Map<string, string>()
      const applyBatch = () => {
        if (idToName.size === 0) return
        setStations((prev) =>
          prev.map((st) => (idToName.has(st.id) ? { ...st, name: idToName.get(st.id)! } : st)),
        )
      }
      const BATCH_FLUSH = 6
      for (let i = 0; i < toFix.length; i++) {
        if (ac.signal.aborted) {
          applyBatch()
          return
        }
        const s = toFix[i]
        try {
          const gap = Math.max(
            0,
            NOMINATIM_REVERSE_MIN_INTERVAL_MS - (Date.now() - nominatimReverseLastStartRef.current),
          )
          if (gap > 0) await new Promise((r) => setTimeout(r, gap))
          if (ac.signal.aborted) {
            applyBatch()
            return
          }
          nominatimReverseLastStartRef.current = Date.now()
          const name = await reverseGeocodeStationName(s.position, used, ac.signal)
          used.add(name.toLowerCase())
          idToName.set(s.id, name)
          if ((i + 1) % BATCH_FLUSH === 0 || i === toFix.length - 1) applyBatch()
        } catch {
          /* keep placeholder */
        }
      }
    },
    [autoStationNames],
  )

  const runSearchPlaces = useCallback(async () => {
    const q = importCityQuery.trim()
    if (!q) return
    setSearchLoading(true)
    try {
      const places = await searchNominatimPlaces(q, { limit: 8 })
      setSearchPlaces(places)
      setSelectedPlace(places.length === 1 ? places[0] : null)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Search failed', 'error')
    } finally {
      setSearchLoading(false)
    }
  }, [importCityQuery, notify])

  const finishImportMerge = useCallback(
    (result: OsmImportResult, toImport: { stations: Station[]; lines: Line[] }) => {
      const empty = stations.length === 0 && lines.length === 0
      if (empty) {
        applyLoadedMap(
          {
            version: result.version,
            stations: toImport.stations,
            lines: toImport.lines,
            stationLabelOverrides: result.stationLabelOverrides,
          },
          selectedPlace ? `Import: ${selectedPlace.displayName}` : undefined,
        )
        void enrichImportedPlaceholderNames(toImport.stations)
      } else {
        pushHistory(stations, lines, stationLabelOverrides)
        const merged = mergeImportIntoMap(
          stations,
          lines,
          { stations: toImport.stations, lines: toImport.lines },
          () => generateStationId(),
          (set) => generateLineId(set),
        )
        setStations(merged.stations)
        setLines(merged.lines)
        syncIdCountersFromData(merged.stations, merged.lines)
        void enrichImportedPlaceholderNames(merged.stations)
      }
      setFocusLocation({ type: 'point', ...result.center, zoom: 12 })
      setFileMenuOpen(false)
      const lineCount = toImport.lines.length
      const stopCount = toImport.stations.length
      const summary = empty
        ? `Import complete — added ${lineCount} line${lineCount === 1 ? '' : 's'} (${stopCount} stop${stopCount === 1 ? '' : 's'}).`
        : `Import complete — merged ${lineCount} line${lineCount === 1 ? '' : 's'} (${stopCount} imported stop${stopCount === 1 ? '' : 's'}) into your map.`
      setImportSuccessToast({ summary, warnings: result.warnings.slice(0, 15) })
    },
    [stations, lines, stationLabelOverrides, applyLoadedMap, pushHistory, selectedPlace, enrichImportedPlaceholderNames],
  )

  const confirmImportWithConflicts = useCallback(() => {
    if (!pendingImportPayload) return
    const { result, conflicts } = pendingImportPayload
    const filtered = filterImportResult(
      { stations: result.stations, lines: result.lines },
      conflicts,
      importAnywayIndices,
    )
    if (filtered.lines.length === 0) {
      notify('Nothing left to import after skipping conflicting lines.', 'error')
      setImportConflictOpen(false)
      setPendingImportPayload(null)
      return
    }
    finishImportMerge(result, filtered)
    setImportConflictOpen(false)
    setPendingImportPayload(null)
  }, [pendingImportPayload, importAnywayIndices, finishImportMerge, notify])

  const runOsmImport = useCallback(async () => {
    if (!selectedPlace) {
      notify('Search, then pick a place from the list before importing.', 'error')
      return
    }
    setImportLoading(true)
    setImportStatusText('Fetching routes from OSM…')
    try {
      const place = {
        south: selectedPlace.south,
        west: selectedPlace.west,
        north: selectedPlace.north,
        east: selectedPlace.east,
        center: { lat: selectedPlace.lat, lng: selectedPlace.lng },
      }
      const flags: ImportModeFlags = {
        metro: importModes.metro,
        lightRail: importModes.lightRail,
        bus: importModes.bus,
        regionalRail: importModes.regionalRail,
        nationalRail: importModes.nationalRail,
      }
      const result = await fetchOsmTransitMap(place, flags, { lineColorOffset: lines.length })
      setImportStatusText('Checking conflicts…')
      await new Promise((r) => setTimeout(r, 0))
      const conflicts = await findImportLineConflictsChunked(stations, lines, result.stations, result.lines)
      if (conflicts.length > 0) {
        setPendingImportPayload({ result, conflicts })
        setImportAnywayIndices(new Set())
        setImportConflictOpen(true)
        return
      }
      setImportStatusText('Merging import…')
      await new Promise((r) => setTimeout(r, 0))
      finishImportMerge(result, { stations: result.stations, lines: result.lines })
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Import failed', 'error')
    } finally {
      setImportLoading(false)
      setImportStatusText('')
    }
  }, [selectedPlace, importModes, stations, lines, finishImportMerge, notify])

  demoTourCtxRef.current = {
    runOsmImport,
    confirmImportWithConflicts,
    setImportAnywayIndices,
    importConflictOpen,
    pendingImportPayload,
    searchNominatimPlaces,
    setSearchPlaces,
    setSelectedPlace,
    setImportModes,
    setImportCityQuery,
    setFileMenuOpen,
    setVisualsMenuOpen,
    setFunctionalMenuOpen,
    pushHistory,
    setStations,
    setLines,
    setSelectedLineId,
    setEditingStationId,
    setStationLabelOverrides,
    setNewLineName,
    setNewLineMode,
    setMode,
    setShowStationNamesOnMap,
    setLabelStylesByMode,
    setModeVisibility,
    renameStation,
    setStationLabelOverride,
    undo,
    setSystemMapView,
    setFocusLocation,
    demoSeedStopsOnSelectedLine,
    setImportSuccessToast,
    notify,
    demoAddLooseStation,
    appendStopToSelectedLineDemo,
    setSimplifiedBasemap,
    setAddInfillAtMidpoint,
    setSystemMapNightTheme,
    updateLineMode,
    updateLineDashArray,
    updateLineWeight,
    setMarkerStylesByMode,
    setSidebarWidth,
    setEditModeGroupCollapsed,
    addMidpointWaypointForTour,
    tourOffsetFirstSegmentWaypoint,
    extendLineFromTerminusDemo,
    demoAddUnnamedStationForTour,
    deleteStation,
    setAutoAddNewStationsToSelectedLine,
    expandEditLineCard: (lineId: string) => {
      setEditViewCollapsedLineIds((prev) => prev.filter((id) => id !== lineId))
    },
  }

  const runDemoTour = useCallback(async () => {
    const P = 1.55
    const z = (ms: number) => Math.round(ms * P)
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    const setCaption = (text: string, subtext = '') => {
      setDemoTourCaption(text.replace(/—/g, '-'))
      setDemoTourSubtext(subtext.replace(/—/g, '-'))
    }
    const waitForImportIdle = async () => {
      for (let i = 0; i < 600; i++) {
        if (demoTourAbortRef.current) return
        if (!importLoadingRef.current) return
        await sleep(z(220))
      }
    }
    const pickDemoTransferStationId = () => {
      const target: LatLng = { lat: 49.2827, lng: -123.1207 } // downtown Vancouver
      const preferred = stationsRef.current
        .filter((s) => {
          const n = (s.name || '').toLowerCase()
          return n.includes('waterfront') || n.includes('granville') || n.includes('vancouver city centre')
        })
        .sort(
          (a, b) =>
            Math.hypot(a.position.lat - target.lat, a.position.lng - target.lng) -
            Math.hypot(b.position.lat - target.lat, b.position.lng - target.lng),
        )
      if (preferred[0]) return preferred[0].id
      const nearest = [...stationsRef.current].sort(
        (a, b) =>
          Math.hypot(a.position.lat - target.lat, a.position.lng - target.lng) -
          Math.hypot(b.position.lat - target.lat, b.position.lng - target.lng),
      )
      return nearest[0]?.id ?? null
    }
    const ensureElementInView = async (el: HTMLElement) => {
      const bottomPad = 16
      const captionTop = demoTourCaptionTopPx()
      const targetBottom = captionTop - bottomPad
      const headerEl = document.querySelector('.appHeader')
      const topSafe = (headerEl?.getBoundingClientRect().bottom ?? 52) + 8
      const bandH = targetBottom - topSafe
      const bandCenterY = (topSafe + targetBottom) / 2

      if (el.closest('.leaflet-container')) {
        await sleep(z(50))
        for (let pass = 0; pass < DEMO_TOUR_MAP_PAN_PASSES; pass++) {
          demoTourClearBelowCaptionRef.current?.(el)
          await sleep(z(340))
          const pr = padClientRectForDemo(el)
          if (pr.bottom <= targetBottom && pr.top >= topSafe) break
        }
        await sleep(z(120))
        return
      }

      const sidebar = el.closest('.sidebar') as HTMLElement | null
      if (sidebar) {
        for (let pass = 0; pass < DEMO_TOUR_SIDEBAR_CENTER_PASSES; pass++) {
          const pr = padClientRectForDemo(el)
          const inBand = pr.bottom <= targetBottom && pr.top >= topSafe
          const elH = pr.bottom - pr.top
          const elCenter = (pr.top + pr.bottom) / 2
          let delta = 0
          if (elH >= bandH - 6) {
            delta = pr.top - topSafe - 8
          } else {
            delta = elCenter - bandCenterY
          }
          if (inBand && Math.abs(delta) < 14) break

          let step = Math.max(
            -DEMO_TOUR_MAX_SCROLL_STEP_PX,
            Math.min(DEMO_TOUR_MAX_SCROLL_STEP_PX, delta),
          )
          if (step === 0) {
            if (!inBand && pr.bottom > targetBottom) {
              step = Math.min(pr.bottom - targetBottom, DEMO_TOUR_MAX_SCROLL_STEP_PX)
            } else if (!inBand && pr.top < topSafe) {
              step = -Math.min(topSafe - pr.top, DEMO_TOUR_MAX_SCROLL_STEP_PX)
            } else if (inBand) {
              break
            }
          }
          if (step === 0) break

          sidebar.scrollTop += step
          await sleep(z(260))
        }
        await sleep(z(100))
        return
      }

      for (let pass = 0; pass < DEMO_TOUR_MAX_ENSURE_PASSES; pass++) {
        const pr = padClientRectForDemo(el)
        const okBottom = pr.bottom <= targetBottom
        const okTop = pr.top >= topSafe
        if (okBottom && okTop) break

        let delta = 0
        if (!okBottom) delta = pr.bottom - targetBottom
        else if (!okTop) delta = pr.top - topSafe

        const capped =
          delta === 0
            ? 0
            : delta > 0
              ? Math.min(delta, DEMO_TOUR_MAX_SCROLL_STEP_PX)
              : -Math.min(-delta, DEMO_TOUR_MAX_SCROLL_STEP_PX)
        if (capped === 0) break

        let scrolled = false
        let node: HTMLElement | null = el
        while (node && node !== document.documentElement) {
          const st = getComputedStyle(node)
          if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 1) {
            node.scrollTop += capped
            scrolled = true
            break
          }
          node = node.parentElement
        }
        if (!scrolled) {
          window.scrollBy({ top: capped, behavior: 'smooth' })
        }
        await sleep(z(320))
      }
    }
    const waitForMidpointHandleEl = async () => {
      for (let i = 0; i < 45; i++) {
        if (demoTourAbortRef.current) return null
        const el = document.querySelector(
          '.leaflet-midpointHandlesPane [data-tour-midpoint-handle]',
        ) as HTMLElement | null
        if (el && el.getBoundingClientRect().width > 0) return el
        await sleep(z(80))
      }
      return null
    }
    const waitForExtendEndHandleEl = async () => {
      for (let i = 0; i < 45; i++) {
        if (demoTourAbortRef.current) return null
        const el = document.querySelector(
          '.leaflet-midpointHandlesPane [data-tour-extend-end="1"]',
        ) as HTMLElement | null
        if (el && el.getBoundingClientRect().width > 0) return el
        await sleep(z(80))
      }
      return null
    }
    const tapLeafletMidpointHandle = async (el: HTMLElement) => {
      if (demoTourAbortRef.current) return
      await ensureElementInView(el)
      setDemoTourHighlightStrong(false)
      setDemoTourHighlightRect(demoTourFocusRectFromEl(el, DEMO_TOUR_FOCUS_VISUAL_PAD))
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      setDemoTourCursor({ x: cx, y: cy, visible: true })
      await pulseTarget(el, 'hover')
      await sleep(z(180))
      await pulseTarget(el, 'click')
      const base = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 1,
          isPrimary: true,
        }),
      )
      await sleep(z(100))
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 0,
          isPrimary: true,
        }),
      )
      el.dispatchEvent(new MouseEvent('click', base))
      await sleep(z(360))
      setDemoTourHighlightRect(null)
    }
    const pulseTarget = async (el: HTMLElement, kind: 'hover' | 'click') => {
      const cls = kind === 'hover' ? 'demoTourTargetHover' : 'demoTourTargetClick'
      el.classList.add(cls)
      await sleep(z(kind === 'hover' ? 260 : 300))
      el.classList.remove(cls)
    }
    const pulseMapStationLabel = async (stationId: string, kind: 'hover' | 'click' = 'hover') => {
      for (let i = 0; i < 30; i++) {
        if (demoTourAbortRef.current) return
        const el =
          (document.querySelector(
            `.stationNameLabel [data-tour-map-station-id="${escapeAttrSelector(stationId)}"]`,
          ) as HTMLElement | null) ??
          (document.querySelector(
            `[data-tour-map-station-id="${escapeAttrSelector(stationId)}"]`,
          ) as HTMLElement | null)
        if (el) {
          await pulseTarget(el, kind)
          return
        }
        await sleep(z(90))
      }
    }
    const pointAt = async (el: HTMLElement | null, caption: string, subtext?: string) => {
      if (demoTourAbortRef.current) return
      setCaption(caption, subtext ?? '')
      if (!el) {
        setDemoTourHighlightRect(null)
        setDemoTourHighlightStrong(false)
        setDemoTourCursor((prev) => ({
          ...prev,
          visible: false,
        }))
        await sleep(z(1100))
        return
      }
      await ensureElementInView(el)
      setDemoTourHighlightStrong(false)
      setDemoTourHighlightRect(demoTourFocusRectFromEl(el, DEMO_TOUR_FOCUS_VISUAL_PAD))
      const r = el.getBoundingClientRect()
      setDemoTourCursor({
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        visible: true,
      })
      await pulseTarget(el, 'hover')
      await sleep(z(1100))
      setDemoTourHighlightRect(null)
    }
    const spotlight = async (
      el: HTMLElement | null,
      caption: string,
      subtext = '',
      durationMs = 2000,
      pad = 8,
    ) => {
      if (demoTourAbortRef.current || !el) return
      await ensureElementInView(el)
      setCaption(caption, subtext)
      setDemoTourHighlightStrong(true)
      setDemoTourHighlightRect(demoTourFocusRectFromEl(el, pad))
      setDemoTourCursor((prev) => ({ ...prev, visible: false }))
      await sleep(z(durationMs))
      setDemoTourHighlightRect(null)
      setDemoTourHighlightStrong(false)
    }
    const tap = async (el: HTMLElement | null) => {
      if (demoTourAbortRef.current || !el) return
      await ensureElementInView(el)
      setDemoTourHighlightStrong(false)
      setDemoTourHighlightRect(demoTourFocusRectFromEl(el, DEMO_TOUR_FOCUS_VISUAL_PAD))
      await pulseTarget(el, 'click')
      el.click()
      await sleep(z(520))
      setDemoTourHighlightRect(null)
    }
    const flushReact = () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setTimeout(r, 120))
        })
      })

    if (importLoading || demoTourActive) return
    demoTourAbortRef.current = false
    setDemoTourEndCardOpen(false)
    setDemoTourActive(true)
    setDemoTourPrimaryLineId(null)
    demoTourPrimaryLineIdRef.current = null
    setCaption(
      'Trainbox guided demo for Vancouver - same workflow works for cities worldwide.',
      'The tour is automated. Follow the cursor to learn each workflow quickly.',
    )
    setDemoTourCursor((prev) => ({
      ...prev,
      visible: true,
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    }))
    const ctx = () => demoTourCtxRef.current

    const prepareDemoLineSidebar = async () => {
      const id = demoTourPrimaryLineIdRef.current
      if (!id) return
      ctx().setSelectedLineId(id)
      ctx().expandEditLineCard(id)
      await flushReact()
      await sleep(z(220))
    }

    try {
      await sleep(z(1200))
      if (demoTourAbortRef.current) return

      setCaption('Starting with a clean map (your previous work is in Undo history).')
      ctx().pushHistory(stations, lines, stationLabelOverrides)
      ctx().setStations([])
      ctx().setLines([])
      ctx().setSelectedLineId(null)
      ctx().setEditingStationId(null)
      ctx().setStationLabelOverrides({})
      syncIdCountersFromData([], [])
      ctx().setSystemMapView(false)
      ctx().setSimplifiedBasemap(false)
      ctx().setSystemMapNightTheme(false)
      ctx().setAddInfillAtMidpoint(false)
      ctx().setFileMenuOpen(true)
      ctx().setVisualsMenuOpen(false)
      ctx().setFunctionalMenuOpen(false)
      await sleep(z(520))

      await pointAt(
        demoImportInputRef.current,
        'File -> Import: this demo uses Vancouver, and the same import flow works for cities worldwide.',
      )
      ctx().setImportCityQuery('Vancouver, BC')
      await sleep(z(280))
      setCaption('Searching Nominatim for the city...')
      let places: NominatimPlace[] = []
      try {
        places = await ctx().searchNominatimPlaces('Vancouver British Columbia Canada', { limit: 8 })
      } catch (e) {
        ctx().notify(e instanceof Error ? e.message : 'Search failed', 'error')
        return
      }
      if (demoTourAbortRef.current) return
      ctx().setSearchPlaces(places)
      const dn = (s: string) => s.toLowerCase()
      const pick =
        places.find((p) => /vancouver|greater vancouver|metro vancouver/.test(dn(p.displayName))) ??
        places[0]
      if (!pick) {
        ctx().notify('No place found for Vancouver — check your network.', 'error')
        return
      }
      ctx().setSelectedPlace(pick)
      ctx().setImportModes({
        metro: true,
        lightRail: true,
        bus: false,
        regionalRail: false,
        nationalRail: false,
      })
      await flushReact()
      await sleep(z(360))

      await pointAt(
        demoImportSearchRef.current,
        'Search fills this list — pick the bounding box that best matches the region you want.',
      )
      await pointAt(demoFirstPlaceRef.current, 'First result is pre-selected for the tour.')
      await pointAt(
        demoImportMetroRef.current,
        'Metro covers subways and heavy rapid transit — many SkyTrain segments use these tags.',
      )
      await pointAt(
        demoImportLightRailRef.current,
        'Light rail adds tram-style and lighter rapid lines — Canada Line and street-running segments often appear here.',
      )
      await pointAt(
        demoImportBtnRef.current,
        'Import can take a minute or two — Overpass is downloading routes and stops.',
      )
      await tap(demoImportBtnRef.current)
      await waitForImportIdle()

      if (demoTourAbortRef.current) return
      const cx = demoTourCtxRef.current
      if (cx.importConflictOpen && cx.pendingImportPayload) {
        setCaption('Similar routes found - we import all for the demo.')
        const allIdx = new Set(cx.pendingImportPayload.conflicts.map((x) => x.importedIndex))
        cx.setImportAnywayIndices(allIdx)
        await flushReact()
        demoTourCtxRef.current.confirmImportWithConflicts()
        await waitForImportIdle()
      }

      if (demoTourAbortRef.current) return
      fitAllNonceRef.current += 1
      ctx().setFocusLocation({ type: 'fit-all', nonce: fitAllNonceRef.current })
      setCaption('Import complete. Quick system overview.')
      await flushReact()
      await sleep(z(1100))

      if (demoTourAbortRef.current) return
      ctx().setFileMenuOpen(false)
      await sleep(z(420))
      ctx().setImportSuccessToast(null)
      await sleep(z(340))
      await flushReact()
      await sleep(z(120))

      ctx().setEditModeGroupCollapsed(
        Object.fromEntries(TRANSIT_MODES.map((m) => [m, false])) as Record<TransitMode, boolean>,
      )
      await flushReact()
      await sleep(z(360))

      let demoTransferStationId: string | null = null
      const impLine = linesSnapshotRef.current.find((l) => l.stationIds.length >= 2)
      if (impLine) {
        demoTransferStationId = pickDemoTransferStationId()
        ctx().setSelectedLineId(impLine.id)
        ctx().setMode('edit-line')
        await flushReact()
        await sleep(z(460))
        await pointAt(
          document.querySelector('.sidebar .lineCard') as HTMLElement | null,
          'Imported network — pick a line in the sidebar.',
        )
        await pointAt(
          document.querySelector('.stationTransferSwatches') as HTMLElement | null,
          'Coloured chips show transfers — other lines through the same stop.',
        )
      }

      await pointAt(
        demoNewLineInputRef.current,
        'Sidebar — New line: set a name and defaults before drawing on the map.',
      )
      ctx().setNewLineName(DEMO_TOUR_LINE_NAME)
      ctx().setNewLineMode('metro')
      await sleep(z(400))
      await pointAt(
        demoNewLineModeSelectRef.current,
        'Transit mode for a new line — how it is grouped, coloured on the map, and which marker style it uses.',
      )
      await sleep(z(480))
      await pointAt(
        demoCreateLineRef.current,
        'Create line — we will add Vancouver-area stops and extend the route next.',
      )
      await tap(demoCreateLineRef.current)
      await flushReact()
      await sleep(z(480))
      const primaryLineId = selectedLineIdRef.current
      demoTourPrimaryLineIdRef.current = primaryLineId
      setDemoTourPrimaryLineId(primaryLineId)
      await flushReact()
      await sleep(z(80))

      const transferPos = demoTransferStationId
        ? stationsRef.current.find((s) => s.id === demoTransferStationId)?.position
        : null
      const yaletownPos: LatLng = transferPos
        ? { lat: transferPos.lat - 0.0035, lng: transferPos.lng + 0.0048 }
        : { lat: 49.2828, lng: -123.103 }
      const extendPos: LatLng = transferPos
        ? { lat: transferPos.lat - 0.0036, lng: transferPos.lng + 0.0135 }
        : { lat: 49.2828, lng: -123.094 }

      ctx().setFocusLocation({ type: 'point', ...yaletownPos, zoom: 14 })
      await flushReact()
      await sleep(z(420))
      await pointAt(
        demoToolStationRef.current,
        'Station tool — click the map to drop a new stop (we add one for you near Yaletown).',
      )
      ctx().setMode('station')
      await flushReact()
      await sleep(z(320))
      setCaption(
        'Adding an unnamed stop - auto naming suggests a label from the map.',
        'Auto name uses reverse geocoding: the stop starts unnamed, then updates to a nearby place name.',
      )
      let addedTourStopId = ctx().demoAddUnnamedStationForTour(yaletownPos)
      if (!addedTourStopId) {
        addedTourStopId = ctx().demoAddLooseStation(yaletownPos, 'Tour Yaletown')
      } else {
        await sleep(z(3600))
        await flushReact()
        await spotlight(
          document.querySelector(
            `[data-tour-station-id="${escapeAttrSelector(addedTourStopId)}"]`,
          ) as HTMLElement | null,
          'Auto name filled the new station. This is where to review or tweak it.',
          'If needed, rename it in the sidebar or keep the suggested nearby landmark.',
          2000,
          10,
        )
        await pulseMapStationLabel(addedTourStopId, 'click')
      }
      await pointAt(
        demoToolLineRef.current,
        'Line mode — click stops in order; we append the new stop to your line.',
      )
      ctx().setMode('line')
      await flushReact()
      await sleep(z(320))
      if (demoTransferStationId) {
        const transferStation = stationsRef.current.find((s) => s.id === demoTransferStationId)
        if (transferStation) {
          ctx().setFocusLocation({ type: 'point', ...transferStation.position, zoom: 14 })
          await flushReact()
          await sleep(z(320))
        }
        await pointAt(
          demoMapWrapRef.current,
          'In Line mode, click an existing station to create a transfer. We snap this new line onto one now.',
        )
        ctx().appendStopToSelectedLineDemo(demoTransferStationId)
        await sleep(z(500))
      }
      ctx().appendStopToSelectedLineDemo(addedTourStopId)
      await sleep(z(580))

      ctx().setFunctionalMenuOpen(true)
      ctx().setFileMenuOpen(false)
      ctx().setVisualsMenuOpen(false)
      await flushReact()
      await sleep(z(380))
      await pointAt(
        demoAutoAddToLineRef.current,
        'Optional: auto-add new stations to the selected line when you drop them in Station mode.',
      )
      ctx().setAutoAddNewStationsToSelectedLine(true)
      await sleep(z(400))
      await pointAt(
        demoToolStationRef.current,
        'Extending the line — add another stop, then chain it on in Line mode.',
        'In Edit mode, you can also drag from the last station to extend; here we show the same result step by step.',
      )
      await sleep(z(280))
      ctx().setFocusLocation({ type: 'point', ...extendPos, zoom: 14 })
      await flushReact()
      await sleep(z(380))
      const extendStopId = ctx().demoAddLooseStation(
        extendPos,
        'Tour extend',
      )
      await sleep(z(400))
      await pointAt(
        demoToolLineRef.current,
        'Line mode — click the new stop to append it to the end of the route.',
      )
      ctx().setMode('line')
      await flushReact()
      await sleep(z(320))
      ctx().appendStopToSelectedLineDemo(extendStopId)
      ctx().setAutoAddNewStationsToSelectedLine(false)
      ctx().setFunctionalMenuOpen(false)
      await sleep(z(400))

      await pointAt(
        demoToolEditRef.current,
        'Edit line - drag station dots and midpoint handles to reshape the path.',
        'Station dots move stops; midpoint handles bend one segment while keeping station positions fixed.',
      )
      ctx().setMode('edit-line')
      await flushReact()
      await sleep(z(420))
      const demoLineForCurve = selectedLineIdRef.current
      if (demoLineForCurve) {
        ctx().addMidpointWaypointForTour(demoLineForCurve)
        await flushReact()
        await sleep(z(420))
        const midEl = await waitForMidpointHandleEl()
        if (midEl) {
          await pointAt(
            midEl,
            'This blue dot is a midpoint handle — drag it to bend only this segment.',
            'We click it first so you see where to grab; then we nudge it so the curve updates.',
          )
          await tapLeafletMidpointHandle(midEl)
        } else {
          await pointAt(
            demoMapWrapRef.current,
            'Midpoint handles let you fine-tune curves between stations.',
            'Drag the midpoint dot to change only that segment geometry.',
          )
        }
        ctx().tourOffsetFirstSegmentWaypoint(demoLineForCurve)
        await sleep(z(780))
        await flushReact()
        await sleep(z(120))
        const extendEndEl = await waitForExtendEndHandleEl()
        if (extendEndEl) {
          await pointAt(
            extendEndEl,
            'Extend by dragging the blue handle past the last stop — drop to add a new station along the line.',
            'We run the same map release as that drag so you see the route grow.',
          )
        } else {
          await pointAt(
            demoMapWrapRef.current,
            'Extend by dragging the blue handle past the last stop — drop to add a new station along the line.',
            'We run the same map release as that drag so you see the route grow.',
          )
        }
        ctx().extendLineFromTerminusDemo(demoLineForCurve)
        await flushReact()
        await sleep(z(720))
      }

      await pointAt(
        demoInfillCheckboxRef.current,
        'Optional: infill at midpoint adds a stop when you click a segment (or drag a midpoint handle).',
      )
      ctx().setAddInfillAtMidpoint(true)
      await sleep(z(820))
      ctx().setAddInfillAtMidpoint(false)
      await sleep(z(380))

      if (addedTourStopId) {
        await prepareDemoLineSidebar()
        const delTourId = ctx().demoAddLooseStation(
          { lat: extendPos.lat + 0.0006, lng: extendPos.lng + 0.0046 },
          'Tour remove me',
        )
        ctx().appendStopToSelectedLineDemo(delTourId)
        await flushReact()
        await sleep(z(400))
        const demoCard = document.querySelector('[data-tour-demo-line="1"]')
        const deleteBtn = demoCard?.querySelector(
          `[data-tour-station-id="${escapeAttrSelector(delTourId)}"]`,
        )
          ?.closest('li')
          ?.querySelector('.stationDeleteBtn') as HTMLElement | null
        await pointAt(
          deleteBtn,
          'Delete removes the stop everywhere — use × on the demo line’s card.',
        )
        ctx().deleteStation(delTourId)
        await sleep(z(520))
      }

      ctx().setMode('pan')
      await flushReact()
      await sleep(z(280))
      ctx().setEditModeGroupCollapsed((p) => ({ ...p, metro: false, light_rail: false }))
      await flushReact()
      await sleep(z(340))

      await pointAt(
        demoSidebarResizeRef.current,
        'Resize the sidebar — drag this edge when you want more room for line cards and station lists.',
      )
      {
        const aside = document.querySelector('.sidebar.sidebarResizable') as HTMLElement | null
        const wStart = aside ? aside.getBoundingClientRect().width : 280
        const wTarget = Math.min(520, Math.max(400, Math.round(wStart + 120)))
        const steps = 10
        for (let i = 1; i <= steps; i++) {
          const t = Math.round(wStart + ((wTarget - wStart) * i) / steps)
          ctx().setSidebarWidth(t)
          await sleep(z(48))
        }
        ctx().setSidebarWidth(wTarget)
      }
      await sleep(z(380))

      await prepareDemoLineSidebar()
      const demoLineId = demoTourPrimaryLineIdRef.current ?? selectedLineIdRef.current
      // Reframe before style explanations so route previews are not clipped by the current local zoom.
      if (demoLineId) {
        ctx().setFocusLocation({ type: 'line', lineId: demoLineId })
      } else {
        fitAllNonceRef.current += 1
        ctx().setFocusLocation({ type: 'fit-all', nonce: fitAllNonceRef.current })
      }
      await flushReact()
      await sleep(z(420))
      await pointAt(
        demoTourLineNameInputRef.current,
        'Vancouver Demo Line — rename, colour, transit mode, stroke weight, and dash style here.',
      )
      await sleep(z(560))
      if (demoLineId) {
        await pointAt(
          demoTourLineWeightSelectRef.current,
          'Stroke weight — thicker lines read better when the map is busy.',
        )
        ctx().updateLineWeight(demoLineId, 6)
        await sleep(z(520))
        await pointAt(
          demoTourLineModeSelectRef.current,
          'Change transit mode on an existing line — e.g. metro to light rail — to match the real network.',
        )
        ctx().updateLineMode(demoLineId, 'light_rail')
        await flushReact()
        await sleep(z(620))
        await pointAt(
          demoTourLineDashSelectRef.current,
          'Dashed lines read well for shuttles, branches, or planned service.',
        )
        ctx().updateLineDashArray(demoLineId, '10,10')
        await sleep(z(680))
      }

      await pointAt(demoVisualsBtnRef.current, 'Visuals — map labels, basemap, and per-mode fonts and markers.')
      ctx().setVisualsMenuOpen(true)
      ctx().setFileMenuOpen(false)
      await sleep(z(420))
      await pointAt(
        demoTourMetroMarkerScaleRef.current,
        'Marker scale — per mode, change how large station dots render on the map.',
      )
      ctx().setMarkerStylesByMode((p) => ({
        ...p,
        metro: { ...p.metro, scale: Math.min(3, (p.metro.scale ?? 1) + 0.4) },
      }))
      await sleep(z(750))
      ctx().setMarkerStylesByMode((p) => ({
        ...p,
        metro: { ...p.metro, scale: DEFAULT_MODE_MARKER_STYLE.scale },
      }))
      await sleep(z(450))
      await pointAt(
        demoVisualsShowNamesRef.current,
        'Show station names — size follows zoom (capped so labels stay readable).',
      )
      ctx().setShowStationNamesOnMap(true)
      await sleep(z(480))
      if (addedTourStopId) {
        await prepareDemoLineSidebar()
        const labelStation = stationsRef.current.find((s) => s.id === addedTourStopId)
        if (labelStation) {
          ctx().setFocusLocation({ type: 'point', ...labelStation.position, zoom: 15 })
          await flushReact()
          await sleep(z(300))
        }
        ctx().setEditingStationId(addedTourStopId)
        await flushReact()
        await sleep(z(320))
        await pointAt(
          demoLabelPresetRef.current,
          'Label placement for the selected stop — font defaults are above; position and rotation are here in Visuals.',
          'We nudge the Yaletown-area stop you added on the demo line, then rename it.',
        )
        await tap(demoLabelPresetRef.current)
        await sleep(z(360))
        ctx().setStationLabelOverride(addedTourStopId, { offset: [28, 0], rotationDeg: 45 })
        await flushReact()
        setCaption(
          'Label rotation shows on the map right away.',
          'Use presets plus rotation to avoid overlaps while keeping names readable.',
        )
        await pulseMapStationLabel(addedTourStopId, 'click')
        await sleep(z(420))
        ctx().renameStation(addedTourStopId, 'Waterfront (demo)')
        await flushReact()
        await sleep(z(380))
        ctx().setStationLabelOverride(addedTourStopId, { offset: [28, 0], rotationDeg: 0 })
        await flushReact()
        await sleep(z(360))
        ctx().setEditingStationId(null)
        await flushReact()
        await sleep(z(240))
      }
      await pointAt(
        demoBasemapRef.current,
        'Basemap — simplified tiles when checked, full street detail when off.',
      )
      ctx().setSimplifiedBasemap(true)
      await sleep(z(700))
      ctx().setSimplifiedBasemap(false)
      await sleep(z(420))
      ctx().setVisualsMenuOpen(false)
      await flushReact()
      await sleep(z(360))

      await pointAt(demoFunctionalBtnRef.current, 'Functional — auto-naming, validation, and show/hide by mode.')
      ctx().setFunctionalMenuOpen(true)
      await sleep(z(420))
      await pointAt(
        demoTourAutoStationNamesRef.current,
        'Auto name stops — reverse geocoding fills placeholders when this is on.',
      )
      await sleep(z(520))
      await pointAt(
        demoFunctionalMetroVisRef.current,
        'Toggle modes: lines hide, and stops that only serve hidden lines disappear. Multi-line transfers stay until every line through them is hidden.',
      )
      ctx().setModeVisibility((v) => ({ ...v, metro: false }))
      await sleep(z(900))
      ctx().setModeVisibility((v) => ({ ...v, metro: true }))
      await sleep(z(520))
      ctx().setFunctionalMenuOpen(false)
      await sleep(z(320))

      await pointAt(demoUndoRef.current, 'Undo / Redo — step back through recent edits.')
      ctx().undo()
      await sleep(z(520))

      await pointAt(demoSystemMapRef.current, 'System map — diagram-style read-only view.')
      await tap(demoSystemMapRef.current)
      await flushReact()
      await sleep(z(520))
      await pointAt(demoBackEditRef.current, 'Back to editing.')
      await tap(demoBackEditRef.current)
      await sleep(z(420))

      if (demoTourAbortRef.current) return
      setCaption(
        'That covers the main workflows.',
        'Undo any time, import a city from OpenStreetMap, or keep editing — take your time.',
      )
      await sleep(z(2800))
      if (demoTourAbortRef.current) return
      setDemoTourFadeOut(true)
      await sleep(z(720))
      setDemoTourActive(false)
      setDemoTourFadeOut(false)
      setDemoTourCursor((prev) => ({ ...prev, visible: false }))
      setDemoTourHighlightRect(null)
      setDemoTourHighlightStrong(false)
      setDemoTourCaption('')
      setDemoTourSubtext('')
      await sleep(z(200))
      setDemoTourEndCardOpen(true)
      return
    } catch (tourErr) {
      console.error('Guided demo tour failed', tourErr)
      try {
        ctx().notify(
          tourErr instanceof Error ? tourErr.message : 'Tour stopped due to an error.',
          'error',
        )
      } catch {
        /* ignore */
      }
    } finally {
      demoTourAbortRef.current = false
      try {
        if (appMountedRef.current) {
          setDemoTourActive(false)
          setDemoTourFadeOut(false)
          setDemoTourCursor((prev) => ({ ...prev, visible: false }))
          setDemoTourCaption('')
          setDemoTourSubtext('')
          setDemoTourHighlightRect(null)
          setDemoTourHighlightStrong(false)
          setMode('pan')
          setEditingStationId(null)
          setAddInfillAtMidpoint(false)
          setDemoTourPrimaryLineId(null)
          demoTourPrimaryLineIdRef.current = null
        }
      } catch {
        /* ignore teardown failures */
      }
    }
  }, [
    importLoading,
    demoTourActive,
    stations,
    lines,
    stationLabelOverrides,
    updateLineMode,
    updateLineDashArray,
    updateLineWeight,
    setMarkerStylesByMode,
    setSidebarWidth,
    setEditModeGroupCollapsed,
    addMidpointWaypointForTour,
    tourOffsetFirstSegmentWaypoint,
    extendLineFromTerminusDemo,
    demoAddUnnamedStationForTour,
    deleteStation,
  ])

  useEffect(() => {
    if (!demoTourActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') demoTourAbortRef.current = true
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demoTourActive])

  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = sidebarWidth
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(220, Math.min(520, startW + ev.clientX - startX))
        setSidebarWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [sidebarWidth],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      if (file.size > MAX_LOAD_FILE_BYTES) {
        notify(
          `File is too large (max ${MAX_LOAD_FILE_BYTES / 1024 / 1024} MB). Choose a smaller file or split your map.`,
          'error',
        )
        e.target.value = ''
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const raw = reader.result as string
        loadMapFromContent(raw, file.name, true)
        e.target.value = ''
      }
      reader.readAsText(file)
      e.target.value = ''
    },
    [loadMapFromContent, notify],
  )

  useEffect(() => {
    if (draftCheckedRef.current) return
    draftCheckedRef.current = true
    try {
      const raw = localStorage.getItem(draftStorageKey)
      if (!raw) return
      const data = tryRecoverSavedMap(JSON.parse(raw))
      if (data && (data.stations.length > 0 || data.lines.length > 0)) {
        setShowDraftBanner(true)
      }
    } catch {
      /* ignore */
    }
  }, [draftStorageKey])

  const restoreDraft = useCallback(() => {
    try {
      const raw = localStorage.getItem(draftStorageKey)
      if (!raw) return
      const data = tryRecoverSavedMap(JSON.parse(raw))
      if (data) {
        applyLoadedMap(data)
        setShowDraftBanner(false)
        localStorage.removeItem(draftStorageKey)
      }
    } catch {
      setShowDraftBanner(false)
      localStorage.removeItem(draftStorageKey)
    }
  }, [applyLoadedMap, draftStorageKey])

  const dismissDraft = useCallback(() => {
    setShowDraftBanner(false)
    localStorage.removeItem(draftStorageKey)
  }, [draftStorageKey])

  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (stations.length === 0 && lines.length === 0) return
    const payload = JSON.stringify({
      version: SAVE_VERSION,
      stations,
      lines,
      stationLabelOverrides,
    })
    if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
    draftSaveTimeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(draftStorageKey, payload)
      } catch {
        /* quota or disabled */
      }
      draftSaveTimeoutRef.current = null
    }, 2000)
    return () => {
      if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
    }
  }, [stations, lines, stationLabelOverrides, draftStorageKey])

  const cloudSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!cloudMapId) return
    if (cloudSaveTimerRef.current) clearTimeout(cloudSaveTimerRef.current)
    cloudSaveTimerRef.current = setTimeout(() => {
      cloudSaveTimerRef.current = null
      const data = {
        version: SAVE_VERSION,
        minReaderVersion: MIN_READER_VERSION,
        stations,
        lines,
        stationLabelOverrides,
      }
      void (async () => {
        try {
          setCloudSyncLabel('Saving…')
          const res = await fetch(`/api/map/${cloudMapId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(typeof (body as { error?: string }).error === 'string' ? (body as { error: string }).error : res.statusText)
          }
          setCloudSyncLabel('Saved')
          setTimeout(() => {
            setCloudSyncLabel((cur) => (cur === 'Saved' ? null : cur))
          }, 2200)
        } catch (e) {
          setCloudSyncLabel(e instanceof Error ? `Save failed: ${e.message}` : 'Save failed')
        }
      })()
    }, 2500)
    return () => {
      if (cloudSaveTimerRef.current) clearTimeout(cloudSaveTimerRef.current)
    }
  }, [stations, lines, stationLabelOverrides, cloudMapId])

  const toggleLineVisibility = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId)
      if (!line) return
      const m = getLineMode(line)
      if (!modeVisibility[m]) {
        setModeVisibility((v) => ({ ...v, [m]: true }))
        return
      }
      setHiddenLineIds((prev) =>
        prev.includes(lineId) ? prev.filter((id) => id !== lineId) : [...prev, lineId],
      )
    },
    [lines, modeVisibility],
  )

  const deleteAllOrphanStations = useCallback(() => {
    const onLine = new Set<string>()
    lines.forEach((l) => l.stationIds.forEach((id) => onLine.add(id)))
    const orphans = stations.filter((s) => !onLine.has(s.id)).map((s) => s.id)
    if (orphans.length === 0) return
    pushHistory(stations, lines, stationLabelOverrides)
    setStations((prev) => prev.filter((s) => onLine.has(s.id)))
    setStationLabelOverrides((prev) => {
      const next = { ...prev }
      for (const id of orphans) delete next[id]
      return next
    })
    setEditingStationId((id) => (id && orphans.includes(id) ? null : id))
  }, [stations, lines, stationLabelOverrides, pushHistory])

  const toggleEditViewLineExpanded = useCallback((lineId: string) => {
    setEditViewCollapsedLineIds((prev) =>
      prev.includes(lineId) ? prev.filter((id) => id !== lineId) : [...prev, lineId],
    )
  }, [])

  return (
    <>
    <div className="app">
      <header className="appHeader trainboxHeader">
        <div className="appHeaderBrand">
          <h1 className="appTitle">Trainbox</h1>
          {cloudMapId ? (
            <span className="appMapIdBadge" title="Cloud map id">
              {cloudMapId}
            </span>
          ) : null}
          {cloudSyncLabel ? <span className="appCloudSyncLabel">{cloudSyncLabel}</span> : null}
        </div>
        {onNavigateHome ? (
          <button type="button" className="toolBtn appHomeBtn" onClick={onNavigateHome} title="Back to home">
            Home
          </button>
        ) : null}
        <nav className="appHeaderMenubar" aria-label="Main">
          <div className="fileMenuWrap" ref={fileMenuRef}>
            <button
              type="button"
              className="toolBtn fileMenuBtn"
              onClick={() => {
                setFileMenuOpen((o) => !o)
                setVisualsMenuOpen(false)
                setFunctionalMenuOpen(false)
              }}
              aria-expanded={fileMenuOpen}
              aria-haspopup="menu"
            >
              File
            </button>
            {fileMenuOpen && (
              <div className="fileMenuDropdown fileMenuDropdownWide" role="menu">
                <button
                  type="button"
                  className="fileMenuItem"
                  role="menuitem"
                  onClick={() => {
                    loadMapFromFile()
                    setFileMenuOpen(false)
                  }}
                >
                  Open map…
                </button>
                <button
                  type="button"
                  className="fileMenuItem"
                  role="menuitem"
                  onClick={() => {
                    saveMapToFile()
                    setFileMenuOpen(false)
                  }}
                >
                  Save map
                </button>
                <button
                  ref={demoTourStartBtnRef}
                  type="button"
                  className="fileMenuItem"
                  role="menuitem"
                  disabled={importLoading || demoTourActive}
                  onClick={() => {
                    setFileMenuOpen(false)
                    void runDemoTour()
                  }}
                >
                  Guided demo (Vancouver tour)…
                </button>
                {showDraftBanner && (
                  <button
                    type="button"
                    className="fileMenuItem"
                    role="menuitem"
                    onClick={() => {
                      restoreDraft()
                      setFileMenuOpen(false)
                    }}
                  >
                    Restore draft
                  </button>
                )}
                <div className="fileMenuDivider" />
                <div className="fileMenuSubLabel">Import transit (OSM)</div>
                <p className="fileMenuImportHint">
                  May take up to ~2 minutes. Data comes from OpenStreetMap (similar to agency GTFS in many cities)—quality varies.
                </p>
                <div className="fileMenuImportRow">
                  <input
                    ref={demoImportInputRef}
                    type="text"
                    className="fileMenuImportInput"
                    placeholder="Search city or region…"
                    value={importCityQuery}
                    onChange={(e) => {
                      setImportCityQuery(e.target.value)
                      setSearchPlaces([])
                      setSelectedPlace(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void runSearchPlaces()
                    }}
                  />
                  <button
                    ref={demoImportSearchRef}
                    type="button"
                    className="toolBtn fileMenuSearchBtn"
                    disabled={searchLoading || !importCityQuery.trim()}
                    onClick={() => void runSearchPlaces()}
                  >
                    {searchLoading ? '…' : 'Search'}
                  </button>
                </div>
                {searchPlaces.length > 0 && (
                  <ul className="fileMenuPlaceList">
                    {searchPlaces.map((p, i) => (
                      <li key={`${p.lat}-${p.lng}-${i}`}>
                        <button
                          ref={i === 0 ? demoFirstPlaceRef : undefined}
                          type="button"
                          className={
                            selectedPlace?.displayName === p.displayName &&
                            selectedPlace?.lat === p.lat
                              ? 'fileMenuPlaceBtn fileMenuPlaceBtnSelected'
                              : 'fileMenuPlaceBtn'
                          }
                          onClick={() => setSelectedPlace(p)}
                        >
                          {p.displayName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="fileMenuImportModes">
                  <label
                    className="fileMenuCheck fileMenuImportCheck"
                    title="OpenStreetMap: subway, metro, rapid transit, heavy rail"
                  >
                    <input
                      ref={demoImportMetroRef}
                      type="checkbox"
                      checked={importModes.metro}
                      onChange={(e) => setImportModes((m) => ({ ...m, metro: e.target.checked }))}
                    />
                    <span className="fileMenuImportCheckLabel">Metro</span>
                  </label>
                  <label
                    className="fileMenuCheck fileMenuImportCheck"
                    title="OpenStreetMap: tram, light rail, monorail"
                  >
                    <input
                      ref={demoImportLightRailRef}
                      type="checkbox"
                      checked={importModes.lightRail}
                      onChange={(e) => setImportModes((m) => ({ ...m, lightRail: e.target.checked }))}
                    />
                    <span className="fileMenuImportCheckLabel">Light rail</span>
                  </label>
                  <label
                    className="fileMenuCheck fileMenuImportCheck"
                    title="OpenStreetMap: bus, trolleybus"
                  >
                    <input
                      type="checkbox"
                      checked={importModes.bus}
                      onChange={(e) => setImportModes((m) => ({ ...m, bus: e.target.checked }))}
                    />
                    <span className="fileMenuImportCheckLabel">Bus</span>
                  </label>
                  <label
                    className="fileMenuCheck fileMenuImportCheck"
                    title="Train routes tagged as regional or commuter in OSM (route=train)"
                  >
                    <input
                      type="checkbox"
                      checked={importModes.regionalRail}
                      onChange={(e) =>
                        setImportModes((m) => ({ ...m, regionalRail: e.target.checked }))
                      }
                    />
                    <span className="fileMenuImportCheckLabel">Regional rail</span>
                  </label>
                  <label
                    className="fileMenuCheck fileMenuImportCheck"
                    title="Long-distance and other train routes in OSM (route=train), including many untagged intercity lines"
                  >
                    <input
                      type="checkbox"
                      checked={importModes.nationalRail}
                      onChange={(e) =>
                        setImportModes((m) => ({ ...m, nationalRail: e.target.checked }))
                      }
                    />
                    <span className="fileMenuImportCheckLabel">National rail</span>
                  </label>
                </div>
                <button
                  ref={demoImportBtnRef}
                  type="button"
                  className="toolBtn fileMenuImportBtn"
                  disabled={importLoading || !selectedPlace}
                  onClick={() => void runOsmImport()}
                >
                  {importLoading ? importStatusText || 'Importing…' : 'Import transit'}
                </button>
                {recentFiles.length > 0 && (
                  <>
                    <div className="fileMenuDivider" />
                    <div className="fileMenuSubLabel">Recent</div>
                    {recentFiles.map((r) => (
                      <button
                        key={r.name}
                        type="button"
                        className="fileMenuItem fileMenuItemRecent"
                        role="menuitem"
                        title={r.name}
                        onClick={() => {
                          loadMapFromContent(r.content, r.name)
                          setFileMenuOpen(false)
                        }}
                      >
                        {r.name}
                      </button>
                    ))}
                  </>
                )}
                <div className="fileMenuDivider" />
                <p className="fileMenuAuthorTagline" title="Author">
                  made by Andre
                </p>
              </div>
            )}
          </div>

          <div className="fileMenuWrap" ref={visualsMenuRef}>
            <button
              ref={demoVisualsBtnRef}
              type="button"
              className="toolBtn fileMenuBtn"
              onClick={() => {
                setVisualsMenuOpen((o) => !o)
                setFileMenuOpen(false)
                setFunctionalMenuOpen(false)
              }}
              aria-expanded={visualsMenuOpen}
            >
              Visuals
            </button>
            {visualsMenuOpen && (
              <div
                ref={visualsPanelRef}
                className="fileMenuDropdown visualsDropdown visualsMenuWide visualsPanelShell"
                role="menu"
                style={{ width: `${visualsPanelWidthPx}px` }}
              >
                <div
                  className="visualsPanelBody"
                  style={{ height: `${visualsPanelBodyHeightPx}px` }}
                >
                <div className="visualsTopRow">
                  <div className="visualsTopRowBlock">
                    <div className="fileMenuSubLabel">Map</div>
                    <div className="visualsMapOptions">
                      <label className="fileMenuCheck">
                        <input
                          type="checkbox"
                          checked={showStationNamesOnMap}
                          onChange={(e) => setShowStationNamesOnMap(e.target.checked)}
                        />
                        Show station names on map
                      </label>
                      <label className="fileMenuCheck">
                        <input
                          ref={demoBasemapRef}
                          type="checkbox"
                          checked={simplifiedBasemap}
                          onChange={(e) => setSimplifiedBasemap(e.target.checked)}
                        />
                        Simplified basemap (lighter tiles)
                      </label>
                    </div>
                  </div>
                  <div className="visualsTopRowBlock">
                    <div className="fileMenuSubLabel">New line defaults</div>
                    <label className="fileMenuLabelRow visualsMenuDefaultLabelRow">
                      <span>Colour</span>
                      <input
                        type="color"
                        value={newLineColor}
                        onChange={(e) => setNewLineColor(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                  </div>
                </div>
                <div className="fileMenuDivider" />
                <div className="fileMenuSubLabel">Map label defaults (all stations)</div>
                {showStationNamesOnMap ? (
                  <>
                    <div className="newLineRow visualsPanelInlineRow">
                      <label className="newLineLabel" htmlFor="labelFontFamily">
                        Font
                      </label>
                      <select
                        id="labelFontFamily"
                        className="lineWeightSelect"
                        value={stationLabelFontFamily}
                        onChange={(e) => setStationLabelFontFamily(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="Open Sans">Open Sans (default)</option>
                        <option value="">Auto (map font)</option>
                        <option value="system-ui">System UI</option>
                        <option value="Arial, sans-serif">Arial</option>
                        <option value="Helvetica, sans-serif">Helvetica</option>
                        <option value="Georgia, serif">Georgia</option>
                        <option value="'Courier New', monospace">Courier New</option>
                        <option value="'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">
                          Inter / SF Pro
                        </option>
                        <option value="'Roboto', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
                          Roboto / Segoe UI
                        </option>
                        <option value="'PT Sans', system-ui, sans-serif">PT Sans</option>
                        <option value="'Fira Sans', system-ui, sans-serif">Fira Sans</option>
                      </select>
                    </div>
                    <div className="newLineRow visualsPanelInlineRow">
                      <label className="newLineLabel" htmlFor="labelFontSize">
                        Size
                      </label>
                      <input
                        id="labelFontSize"
                        type="number"
                        className="lineWeightSelect"
                        min={8}
                        max={18}
                        value={stationLabelFontSizePxOverride ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setStationLabelFontSizePxOverride(v === '' ? null : Number(v))
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="labelResetBtn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setStationLabelFontFamily('Open Sans')
                          setStationLabelFontSizePxOverride(null)
                        }}
                      >
                        Reset style
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="emptyHint" style={{ margin: '0 0 8px' }}>
                    Turn on &quot;Show station names on map&quot; to edit default label font and size.
                  </p>
                )}
                {showStationNamesOnMap &&
                  editingStationId &&
                  (() => {
                    const station = stations.find((s) => s.id === editingStationId)
                    if (!station) return null
                    const override = stationLabelOverrides[editingStationId]
                    const DIST = 28
                    const d = Math.round(DIST * 0.7)
                    const presets: { label: string; offset: [number, number] }[] = [
                      { label: '→', offset: [DIST, 0] },
                      { label: '↗', offset: [d, -d] },
                      { label: '↑', offset: [0, -DIST] },
                      { label: '↖', offset: [-d, -d] },
                      { label: '←', offset: [-DIST, 0] },
                      { label: '↙', offset: [-d, d] },
                      { label: '↓', offset: [0, DIST] },
                      { label: '↘', offset: [d, d] },
                    ]
                    const rotations = [0, 45, 90, 135, 180, 225, 270, 315]
                    return (
                      <div
                        className="visualsSelectedStationLabelBlock"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="fileMenuSubLabel" style={{ marginTop: 10 }}>
                          Selected stop: {station.name || 'Unnamed'}
                        </div>
                        <div className="labelPlacementControls">
                          <div className="labelPlacementRow">
                            <span className="labelPlacementLabel">Position</span>
                            <div className="labelPlacementPresets">
                              {presets.map((p) => (
                                <button
                                  ref={p.label === '→' ? demoLabelPresetRef : undefined}
                                  key={p.label}
                                  type="button"
                                  className={`labelPresetBtn ${
                                    override &&
                                    override.offset[0] === p.offset[0] &&
                                    override.offset[1] === p.offset[1]
                                      ? 'labelPresetBtnActive'
                                      : ''
                                  }`}
                                  onClick={() =>
                                    setStationLabelOverride(editingStationId, {
                                      offset: p.offset,
                                      rotationDeg: override?.rotationDeg ?? 0,
                                    })
                                  }
                                  title={p.label}
                                >
                                  {p.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="labelPlacementRow">
                            <span className="labelPlacementLabel">Rotation</span>
                            <select
                              className="labelRotationSelect"
                              value={override?.rotationDeg ?? 0}
                              onChange={(e) => {
                                const rot = Number(e.target.value)
                                setStationLabelOverride(editingStationId, {
                                  offset: override?.offset ?? [DIST, 0],
                                  rotationDeg: rot,
                                })
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {rotations.map((r) => (
                                <option key={r} value={r}>
                                  {r}°
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="labelResetBtn"
                            onClick={() => setStationLabelOverride(editingStationId, null)}
                          >
                            Reset to auto
                          </button>
                        </div>
                      </div>
                    )
                  })()}
                {showStationNamesOnMap && !editingStationId && (
                  <p className="emptyHint" style={{ margin: '8px 0 0', fontSize: 12 }}>
                    Select a stop on a line card (Rename or Label) to adjust that stop’s placement here.
                  </p>
                )}
                <div className="fileMenuDivider" />
                <div className="fileMenuSubLabel">Labels &amp; markers by mode</div>
                {!showStationNamesOnMap && (
                  <p className="emptyHint" style={{ margin: '0 0 8px' }}>
                    Turn on &quot;Show station names on map&quot; to edit per-mode label font and size.
                  </p>
                )}
                <div className="modeVisualsColumns">
                {TRANSIT_MODES.map((m) => (
                  <div key={m} className="modeVisualsBlock" onClick={(e) => e.stopPropagation()}>
                    <div className="fileMenuSubLabel">{modeGroupTitle(m)}</div>
                    {showStationNamesOnMap && (
                      <label className="fileMenuLabelRow">
                        <span title="Leave empty to match the map’s font">Label font</span>
                        <input
                          type="text"
                          value={labelStylesByMode[m].fontFamily}
                          onChange={(e) =>
                            setLabelStylesByMode((p) => ({ ...p, [m]: { ...p[m], fontFamily: e.target.value } }))
                          }
                          placeholder="Same as map"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </label>
                    )}
                    {showStationNamesOnMap && (
                      <label className="fileMenuLabelRow">
                        <span title="Leave at 0 for automatic size from zoom">Label size</span>
                        <input
                          type="number"
                          min={0}
                          max={48}
                          step={1}
                          value={labelStylesByMode[m].fontSizePx || ''}
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            setLabelStylesByMode((p) => ({
                              ...p,
                              [m]: { ...p[m], fontSizePx: Number.isFinite(v) ? v : 0 },
                            }))
                          }}
                          placeholder="Auto"
                          title="Use 0 for automatic size from zoom"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </label>
                    )}
                    <label className="fileMenuLabelRow">
                      <span>Marker scale</span>
                      <input
                        ref={m === 'metro' ? demoTourMetroMarkerScaleRef : undefined}
                        type="number"
                        min={0.25}
                        max={3}
                        step={0.05}
                        value={markerStylesByMode[m].scale}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          setMarkerStylesByMode((p) => ({
                            ...p,
                            [m]: {
                              ...p[m],
                              scale: Number.isFinite(v) ? Math.max(0.25, Math.min(3, v)) : 1,
                            },
                          }))
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                    <label className="fileMenuLabelRow">
                      <span>Fill</span>
                      <input
                        type="color"
                        value={markerStylesByMode[m].fill}
                        onChange={(e) =>
                          setMarkerStylesByMode((p) => ({ ...p, [m]: { ...p[m], fill: e.target.value } }))
                        }
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                    <label className="fileMenuLabelRow">
                      <span>Stroke</span>
                      <input
                        type="color"
                        value={markerStylesByMode[m].stroke}
                        onChange={(e) =>
                          setMarkerStylesByMode((p) => ({ ...p, [m]: { ...p[m], stroke: e.target.value } }))
                        }
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                  </div>
                ))}
                </div>
                </div>
                <div
                  className="visualsResizeEdgeRight"
                  onMouseDown={startVisualsPanelResizeWidth}
                  title="Drag to resize width"
                  aria-label="Resize visuals panel width"
                  role="separator"
                />
                <div
                  className="visualsResizeEdgeBottom"
                  onMouseDown={startVisualsPanelResizeHeight}
                  title="Drag to resize height"
                  aria-label="Resize visuals panel height"
                  role="separator"
                />
                <div
                  className="visualsResizeCorner"
                  onMouseDown={startVisualsPanelResizeCorner}
                  title="Drag corner to resize width and height"
                  aria-label="Resize visuals panel width and height"
                  role="presentation"
                />
              </div>
            )}
          </div>

          <div className="fileMenuWrap" ref={functionalMenuRef}>
            <button
              ref={demoFunctionalBtnRef}
              type="button"
              className="toolBtn fileMenuBtn"
              onClick={() => {
                setFunctionalMenuOpen((o) => !o)
                setFileMenuOpen(false)
                setVisualsMenuOpen(false)
              }}
              aria-expanded={functionalMenuOpen}
            >
              Functional
            </button>
            {functionalMenuOpen && (
              <div className="fileMenuDropdown visualsDropdown" role="menu">
                <label className="fileMenuCheck">
                  <input
                    ref={demoTourAutoStationNamesRef}
                    type="checkbox"
                    checked={autoStationNames}
                    onChange={(e) => setAutoStationNames(e.target.checked)}
                  />
                  Auto name stops (uses the map to fill in unnamed stops)
                </label>
                <label className="fileMenuCheck">
                  <input
                    ref={demoAutoAddToLineRef}
                    type="checkbox"
                    checked={autoAddNewStationsToSelectedLine}
                    onChange={(e) => setAutoAddNewStationsToSelectedLine(e.target.checked)}
                  />
                  Add new stations to selected line
                </label>
                <div className="fileMenuDivider" />
                <div className="fileMenuSubLabel">Show lines by mode</div>
                <label className="fileMenuCheck">
                  <input
                    ref={demoFunctionalMetroVisRef}
                    type="checkbox"
                    checked={modeVisibility.metro}
                    onChange={(e) => setModeVisibility((v) => ({ ...v, metro: e.target.checked }))}
                  />
                  Metro lines
                </label>
                <label className="fileMenuCheck">
                  <input
                    type="checkbox"
                    checked={modeVisibility.light_rail}
                    onChange={(e) => setModeVisibility((v) => ({ ...v, light_rail: e.target.checked }))}
                  />
                  Light rail lines
                </label>
                <label className="fileMenuCheck">
                  <input
                    type="checkbox"
                    checked={modeVisibility.bus}
                    onChange={(e) => setModeVisibility((v) => ({ ...v, bus: e.target.checked }))}
                  />
                  Bus lines
                </label>
                <label className="fileMenuCheck">
                  <input
                    type="checkbox"
                    checked={modeVisibility.regional_rail}
                    onChange={(e) =>
                      setModeVisibility((v) => ({ ...v, regional_rail: e.target.checked }))
                    }
                  />
                  Regional rail lines
                </label>
                <label className="fileMenuCheck">
                  <input
                    type="checkbox"
                    checked={modeVisibility.national_rail}
                    onChange={(e) =>
                      setModeVisibility((v) => ({ ...v, national_rail: e.target.checked }))
                    }
                  />
                  National rail lines
                </label>
                {hasValidationWarnings && validationWarningsDismissed && (
                  <>
                    <div className="fileMenuDivider" />
                    <button
                      type="button"
                      className="fileMenuItem"
                      role="menuitem"
                      onClick={() => {
                        setValidationWarningsDismissed(false)
                        setFunctionalMenuOpen(false)
                      }}
                    >
                      Show validation warnings
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </nav>

        <div className="appHeaderActions">
          {!systemMapView && (
            <>
              <button
                ref={demoUndoRef}
                type="button"
                className="toolBtn toolBtnWithIcon"
                onClick={undo}
                disabled={!canUndo}
                title="Undo"
              >
                <IconUndo />
                <span>Undo</span>
              </button>
              <button type="button" className="toolBtn toolBtnWithIcon" onClick={redo} disabled={!canRedo} title="Redo">
                <IconRedo />
                <span>Redo</span>
              </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-hidden
          />
          {systemMapView ? (
            <button
              ref={demoBackEditRef}
              type="button"
              className="toolBtn systemMapBackBtn"
              onClick={() => {
                setSystemMapView(false)
                setSystemMapSelectedLineId(null)
              }}
            >
              ← Back to edit
            </button>
          ) : (
            <button
              ref={demoSystemMapRef}
              type="button"
              className="toolBtn systemMapViewBtn"
              onClick={() => {
                fitAllNonceRef.current += 1
                setSystemMapView(true)
                setFocusLocation({ type: 'fit-all', nonce: fitAllNonceRef.current })
              }}
              title="View as system map (read-only)"
            >
              View system map
            </button>
          )}
        </div>
      </header>

      {showDraftBanner && (
        <div className="draftBanner" role="status">
          <span>You have an unsaved draft.</span>
          <button
            type="button"
            className="toolBtn draftBannerBtn"
            onClick={restoreDraft}
          >
            Restore
          </button>
          <button
            type="button"
            className="toolBtn draftBannerBtn draftBannerDismiss"
            onClick={dismissDraft}
          >
            Dismiss
          </button>
        </div>
      )}

      {appNotice && (
        <div className={`appNotice appNotice${appNotice.kind === 'error' ? 'Error' : 'Info'}`} role="status" aria-live="polite">
          <span>{appNotice.text}</span>
          <button
            type="button"
            className="toolBtn draftBannerBtn"
            onClick={() => {
              if (appNoticeTimerRef.current) {
                clearTimeout(appNoticeTimerRef.current)
                appNoticeTimerRef.current = null
              }
              setAppNotice(null)
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {importSuccessToast && (
        <div className="importSuccessToast" role="status" aria-live="polite">
          <div className="importSuccessToastMain">
            <p className="importSuccessToastSummary">{importSuccessToast.summary}</p>
            {importSuccessToast.warnings.length > 0 && (
              <div className="importSuccessToastNotes">
                <span className="importSuccessToastNotesLabel">Notes from cleanup</span>
                <ul>
                  {importSuccessToast.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <button
            type="button"
            className="toolBtn draftBannerBtn importSuccessToastDismiss"
            onClick={() => {
              if (importToastTimerRef.current) {
                clearTimeout(importToastTimerRef.current)
                importToastTimerRef.current = null
              }
              setImportSuccessToast(null)
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="appBody">
        {systemMapView ? (
          <div
            className={`systemMapContainer ${
              systemMapNightTheme ? 'systemMapNight' : ''
            } ${systemMapFullscreen ? 'systemMapFullscreen' : ''}`}
            ref={systemMapContainerRef}
          >
            <aside className="sidebar systemMapSidebar">
              <div className="systemMapLegend">
                <span className="systemMapLegendIcon" aria-hidden>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="6" width="20" height="12" rx="2" />
                    <line x1="6" y1="10" x2="6" y2="14" />
                    <line x1="10" y1="10" x2="10" y2="14" />
                    <line x1="14" y1="10" x2="14" y2="14" />
                    <line x1="18" y1="10" x2="18" y2="14" />
                    <circle cx="7" cy="17" r="1.5" />
                    <circle cx="17" cy="17" r="1.5" />
                  </svg>
                </span>
                <h2 className="sidebarSectionTitle systemMapLegendTitle">Lines</h2>
              </div>
              <div className="systemMapControls">
                <input
                  type="text"
                  className="systemMapSearchInput"
                  placeholder="Search stations..."
                  value={systemMapStationSearch}
                  onChange={(e) => setSystemMapStationSearch(e.target.value)}
                  aria-label="Search stations"
                />
                <label className="mapDisplayOption">
                  <input
                    ref={demoSystemNightRef}
                    type="checkbox"
                    checked={systemMapNightTheme}
                    onChange={(e) => setSystemMapNightTheme(e.target.checked)}
                  />
                  <span>Night / high-contrast</span>
                </label>
                <button
                  type="button"
                  className="toolBtn"
                  onClick={() => {
                    if (systemMapFullscreen) {
                      document.exitFullscreen?.()
                      setSystemMapFullscreen(false)
                    } else {
                      systemMapContainerRef.current?.requestFullscreen?.()
                      setSystemMapFullscreen(true)
                    }
                  }}
                  title={systemMapFullscreen ? 'Exit fullscreen' : 'Fullscreen system map'}
                >
                  {systemMapFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                </button>
              </div>
              {lines.length === 0 ? (
                <p className="emptyHint">No lines yet. Go back to edit to create a map.</p>
              ) : (
                <>
                  {TRANSIT_MODES.map((mode) => {
                    const groupLines = linesByMode[mode]
                    if (groupLines.length === 0) return null
                    const modeCollapsed = systemMapModeGroupCollapsed[mode]
                    return (
                      <div key={mode} className="modeLineGroup systemMapModeLineGroup">
                        <button
                          type="button"
                          className="modeLineGroupHeader"
                          onClick={() =>
                            setSystemMapModeGroupCollapsed((p) => ({
                              ...p,
                              [mode]: !p[mode],
                            }))
                          }
                          aria-expanded={!modeCollapsed}
                        >
                          <span className="modeLineGroupToggle" aria-hidden>
                            {modeCollapsed ? '▶' : '▼'}
                          </span>
                          {modeGroupTitle(mode)}
                          <span className="modeLineGroupCount">({groupLines.length})</span>
                        </button>
                        {!modeCollapsed && (
                          <ul className="linesList systemMapLinesList">
                            {groupLines.map((line) => {
                    const isSelected = systemMapSelectedLineId === line.id
                    const isExpanded = systemMapExpandedLineIds.includes(line.id)
                    const hasStations = line.stationIds.length > 0
                    return (
                      <li
                        key={line.id}
                        className={`lineCard systemMapLineCard ${
                          isSelected ? 'lineCardSelected' : ''
                        }`}
                      >
                        <div className="systemMapLineCardHeader">
                          {hasStations && (
                            <button
                              type="button"
                              className={`systemMapExpandBtn ${
                                isExpanded ? 'systemMapExpandBtnExpanded' : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleSystemMapLineExpanded(line.id)
                              }}
                              title={isExpanded ? 'Collapse stations' : 'Expand stations'}
                              aria-expanded={isExpanded}
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 12 12"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M3 5l3 3 3-3" />
                              </svg>
                            </button>
                          )}
                          <button
                            type="button"
                            className="lineCardFocus"
                            onClick={() => selectLineInSystemMap(line)}
                          >
                            <span
                              className="lineDot"
                              style={{ background: line.color }}
                            />
                            <span className="lineName">{line.name}</span>
                          </button>
                        </div>
                        {hasStations && isExpanded && (
                          <ul className="lineStations systemMapLineStations">
                            {line.stationIds
                              .map((sid) => stations.find((s) => s.id === sid))
                              .filter((s): s is Station => s != null)
                              .filter((station) => {
                                const q = systemMapStationSearch
                                  .trim()
                                  .toLowerCase()
                                if (!q) return true
                                return (station.name || '').toLowerCase().includes(q)
                              })
                              .map((station) => (
                                <li key={station.id}>
                                  <button
                                    type="button"
                                    className="systemMapStationLink"
                                    onClick={() => focusOnStation(station)}
                                  >
                                    {station.name || station.id}
                                  </button>
                                </li>
                              ))}
                          </ul>
                        )}
                      </li>
                    )
                            })}
                          </ul>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </aside>
            <main className="mapWrap systemMapMapWrap">
              <TransitMapView
                key={mapMountKey}
                center={mapCenter}
                zoom={zoom}
                mode="pan"
                stations={stations}
                lines={lines}
                selectedLineId={null}
                demoTourActive={demoTourActive}
                demoTourClearBelowCaptionRef={demoTourClearBelowCaptionRef}
                focusTarget={focusLocation}
                onFocusComplete={() => setFocusLocation(null)}
                systemMapSelectedLineId={systemMapSelectedLineId}
                onAddStation={() => {}}
                showStationNamesOnMap={showStationNamesOnMap}
                stationLabelOverrides={stationLabelOverrides}
                onAddStationToLine={() => {}}
                onRemoveStationFromLine={() => {}}
                onStationMove={() => {}}
                onLineSegmentClick={() => {}}
                onLineMidpointDrop={() => {}}
                addingStationAfter={null}
                onAddStationBetween={() => {}}
                systemMapView
                stationLabelFontFamily={stationLabelFontFamily}
                stationLabelFontSizePxOverride={stationLabelFontSizePxOverride}
                simplifiedBasemap={simplifiedBasemap}
                hiddenLineIds={hiddenLineIds}
                modeVisibility={modeVisibility}
                labelStylesByMode={labelStylesByMode}
                markerStylesByMode={markerStylesByMode}
                onStationRename={() => {}}
              />
            </main>
          </div>
        ) : (
          <>
            <aside className="sidebar sidebarResizable" style={{ width: sidebarWidth }}>
              <section className="sidebarSection">
                <h2 className="sidebarSectionTitle">Map tool</h2>
                <div className="toolGroup">
                  <div className="toolButtons toolButtonsIconRow">
                    <button
                      type="button"
                      className={`toolBtn toolBtnIcon ${mode === 'pan' ? 'toolBtnActive' : ''}`}
                      onClick={() => setMode('pan')}
                      title="Pan — move and zoom the map"
                      aria-label="Pan"
                    >
                      <IconPan />
                      <span className="toolBtnIconLabel">Pan</span>
                    </button>
                    <button
                      ref={demoToolStationRef}
                      type="button"
                      className={`toolBtn toolBtnIcon ${mode === 'station' ? 'toolBtnActive' : ''}`}
                      onClick={() => setMode('station')}
                      title="Add station — click on the map"
                      aria-label="Add station"
                    >
                      <IconStation />
                      <span className="toolBtnIconLabel">Station</span>
                    </button>
                    <button
                      ref={demoToolLineRef}
                      type="button"
                      className={`toolBtn toolBtnIcon ${mode === 'line' ? 'toolBtnActive' : ''}`}
                      onClick={() => {
                        if (!selectedLineId && lines.length > 0)
                          setSelectedLineId(lines[0].id)
                        setMode('line')
                      }}
                      title="Draw line — click stations in order"
                      aria-label="Draw line"
                    >
                      <IconLine />
                      <span className="toolBtnIconLabel">Line</span>
                    </button>
                    <button
                      ref={demoToolEditRef}
                      type="button"
                      className={`toolBtn toolBtnIcon ${mode === 'edit-line' ? 'toolBtnActive' : ''}`}
                      onClick={() => setMode('edit-line')}
                      title="Edit line — drag stations and curve handles"
                      aria-label="Edit line"
                    >
                      <IconEditLine />
                      <span className="toolBtnIconLabel">Edit</span>
                    </button>
                  </div>
                </div>
              </section>

              {validationWarnings.orphanStationIds.length > 0 && (
                <section className="sidebarSection">
                  <div className="orphanStationsHeaderRow">
                    <h2 className="sidebarSectionTitle">Orphan stations</h2>
                    <button type="button" className="toolBtn orphanDeleteAllBtn" onClick={deleteAllOrphanStations}>
                      Delete all
                    </button>
                  </div>
                  <p className="orphanStationsHint">Stations not on any line</p>
                  <ul className="orphanStationList">
                    {validationWarnings.orphanStationIds.map((id) => {
                      const station = stations.find((s) => s.id === id)
                      if (!station) return null
                      return (
                        <li key={station.id} className="orphanStationItem">
                          <span className="orphanStationName" title={station.id}>
                            {station.name || 'Unnamed'}
                          </span>
                          <span className="orphanStationActions">
                            <button
                              type="button"
                              className="stationGoBtn"
                              onClick={() => focusOnStation(station)}
                              title="Pan to station"
                            >
                              Go
                            </button>
                            <button
                              type="button"
                              className="stationDeleteBtn"
                              onClick={() => deleteStation(station.id)}
                              title="Delete station"
                            >
                              ×
                            </button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}

              {hasValidationWarnings && !validationWarningsDismissed && (
                <section className="sidebarSection validationSection">
                  <div className="validationSectionHeaderRow">
                    <h2 className="sidebarSectionTitle validationSectionTitle">Validation warnings</h2>
                    <button
                      type="button"
                      className="toolBtn validationDismissBtn"
                      onClick={() => setValidationWarningsDismissed(true)}
                    >
                      Dismiss
                    </button>
                  </div>
                  <ul className="validationList">
                    {validationWarnings.orphanStationIds.length > 0 && (
                      <li>
                        Orphan stations (not on any line):{' '}
                        {validationWarnings.orphanStationIds
                          .map(
                            (id) =>
                              stations.find((s) => s.id === id)?.name || id,
                          )
                          .join(', ')}
                      </li>
                    )}
                    {validationWarnings.emptyLineIds.length > 0 && (
                      <li>
                        Empty lines:{' '}
                        {validationWarnings.emptyLineIds
                          .map(
                            (id) =>
                              lines.find((l) => l.id === id)?.name || id,
                          )
                          .join(', ')}
                      </li>
                    )}
                    {validationWarnings.duplicateStationNames.length > 0 && (
                      <li>
                        Duplicate station names:{' '}
                        {validationWarnings.duplicateStationNames.join(', ')}
                      </li>
                    )}
                    {validationWarnings.linesWithMissingStations.length > 0 && (
                      <li>
                        Lines reference missing stations:{' '}
                        {validationWarnings.linesWithMissingStations
                          .map((l) => l.name || l.id)
                          .join(', ')}
                      </li>
                    )}
                  </ul>
                </section>
              )}

              <section className="sidebarSection">
                <h2 className="sidebarSectionTitle">New line</h2>
                <div className="newLineCard">
                  <div className="newLineRow">
                    <input
                      ref={demoNewLineInputRef}
                      type="text"
                      className="newLineInput"
                      placeholder="Line name"
                      value={newLineName}
                      onChange={(e) => setNewLineName(e.target.value)}
                    />
                    <input
                      type="color"
                      className="newLineColor"
                      value={newLineColor}
                      onChange={(e) => setNewLineColor(e.target.value)}
                      title="Line color"
                    />
                  </div>
                  <div className="newLineRow">
                    <label className="newLineLabel">Mode</label>
                    <select
                      ref={demoNewLineModeSelectRef}
                      className="newLineWeight"
                      value={newLineMode}
                      onChange={(e) => setNewLineMode(e.target.value as TransitMode)}
                      title="Transit mode"
                    >
                      {TRANSIT_MODES.map((m) => (
                        <option key={m} value={m}>
                          {modeGroupTitle(m)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="newLineRow">
                    <label className="newLineLabel">Thickness</label>
                    <select
                      className="newLineWeight"
                      value={newLineWeight}
                      onChange={(e) =>
                        setNewLineWeight(Number(e.target.value))
                      }
                      title="Line thickness"
                    >
                      {LINE_WEIGHTS.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    ref={demoCreateLineRef}
                    type="button"
                    className="newLineBtn"
                    onClick={addLine}
                  >
                    Create line
                  </button>
                </div>
              </section>

              <section className="sidebarSection">
                <h2 className="sidebarSectionTitle">Lines</h2>
                {mode === 'line' && selectedLine && (
                  <p className="drawLineHint">
                    Click stations on the map to add them to{' '}
                    <strong>{selectedLine.name}</strong>.
                  </p>
                )}
                {mode === 'edit-line' && selectedLine && (
                  <p className="drawLineHint">
                    Drag stations to move. Drag the{' '}
                    <strong>dots on the line</strong> to curve the line (no new
                    station) or drop on an existing station to snap the line to
                    it; drop on a station already on the line to remove it from
                    the line.
                  </p>
                )}
                {mode === 'edit-line' && selectedLine && (
                  <label className="mapDisplayOption">
                    <input
                      ref={demoInfillCheckboxRef}
                      type="checkbox"
                      checked={addInfillAtMidpoint}
                      onChange={(e) => setAddInfillAtMidpoint(e.target.checked)}
                    />
                    <span>Add infill station at segment midpoint</span>
                  </label>
                )}
                {mode === 'edit-line' && selectedLine && addInfillAtMidpoint && (
                  <p className="drawLineHint" style={{ marginTop: 4 }}>
                    Click a line segment to insert a new station at its
                    midpoint, or <strong>drag a midpoint dot</strong> and drop
                    to add an infill station there.
                  </p>
                )}
                {lines.length === 0 ? (
                  <p className="emptyHint">
                    Create a line above, then use <strong>Draw line</strong> and
                    click stations in order.
                  </p>
                ) : (
                  <>
                    {TRANSIT_MODES.map((mode) => {
                      const groupLines = linesByMode[mode]
                      if (groupLines.length === 0) return null
                      const modeCollapsed = editModeGroupCollapsed[mode]
                      return (
                        <div key={mode} className="modeLineGroup">
                          <button
                            type="button"
                            className="modeLineGroupHeader"
                            onClick={() =>
                              setEditModeGroupCollapsed((p) => ({
                                ...p,
                                [mode]: !p[mode],
                              }))
                            }
                            aria-expanded={!modeCollapsed}
                          >
                            <span className="modeLineGroupToggle" aria-hidden>
                              {modeCollapsed ? '▶' : '▼'}
                            </span>
                            {modeGroupTitle(mode)}
                            <span className="modeLineGroupCount">({groupLines.length})</span>
                          </button>
                          {!modeCollapsed && (
                            <ul className="linesList modeLineGroupList">
                              {groupLines.map((line) => {
                      const centerLine = lineCenter(line)
                      const isExpanded = !editViewCollapsedLineIds.includes(
                        line.id,
                      )
                      return (
                        <li
                          key={line.id}
                          data-tour-demo-line={
                            demoTourActive && demoTourPrimaryLineId === line.id ? '1' : undefined
                          }
                          className={`lineCard ${
                            selectedLineId === line.id
                              ? 'lineCardSelected'
                              : ''
                          } ${
                            hiddenLineIds.includes(line.id)
                              ? 'lineCardHidden'
                              : ''
                          }`}
                          style={
                            selectedLineId === line.id
                              ? { borderLeft: `3px solid ${line.color}` }
                              : undefined
                          }
                        >
                          <div className="lineCardHeader">
                            <button
                              type="button"
                              className={`editViewExpandBtn ${
                                isExpanded
                                  ? 'editViewExpandBtnExpanded'
                                  : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleEditViewLineExpanded(line.id)
                              }}
                              title={isExpanded ? 'Collapse' : 'Expand'}
                              aria-expanded={isExpanded}
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 12 12"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M3 5l3 3 3-3" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="lineCardFocus"
                              onClick={() => {
                                setSelectedLineId(line.id)
                                if (centerLine) focusOnLine(line)
                              }}
                              title="Select and pan to line"
                              disabled={!centerLine}
                            >
                              <span
                                className="lineDot"
                                style={{ background: line.color }}
                              />
                              <span className="lineName">{line.name}</span>
                            </button>
                            <span className="lineActions">
                              <button
                                type="button"
                                className="lineActionBtn lineVisibilityBtn"
                                onClick={() => toggleLineVisibility(line.id)}
                                title={
                                  hiddenLineIds.includes(line.id)
                                    ? 'Show line on map'
                                    : 'Hide line on map'
                                }
                                aria-label={
                                  hiddenLineIds.includes(line.id)
                                    ? 'Show line'
                                    : 'Hide line'
                                }
                              >
                                {hiddenLineIds.includes(line.id) ? (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    aria-hidden
                                  >
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                  </svg>
                                ) : (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    aria-hidden
                                  >
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                )}
                              </button>
                              <button
                                type="button"
                                className={`lineActionBtn ${
                                  selectedLineId === line.id
                                    ? 'lineActionBtnPrimary'
                                    : ''
                                }`}
                                onClick={() => {
                                  setSelectedLineId(line.id)
                                  setMode('edit-line')
                                }}
                                aria-pressed={selectedLineId === line.id}
                              >
                                {selectedLineId === line.id ? 'Editing' : 'Edit'}
                              </button>
                              <button
                                type="button"
                                className="lineActionBtn lineActionBtnDanger"
                                onClick={() => deleteLine(line.id)}
                              >
                                Delete
                              </button>
                            </span>
                          </div>
                          {isExpanded && (
                            <>
                              <div className="lineCardStyle">
                                <label className="lineCardNameLabel">
                                  <span className="lineCardLabelText">Name</span>
                                  <input
                                    ref={
                                      line.name === DEMO_TOUR_LINE_NAME
                                        ? demoTourLineNameInputRef
                                        : undefined
                                    }
                                    type="text"
                                    className="lineNameInput"
                                    value={line.name}
                                    onChange={(e) =>
                                      setLines((prev) =>
                                        prev.map((l) =>
                                          l.id === line.id ? { ...l, name: e.target.value } : l,
                                        ),
                                      )
                                    }
                                    onBlur={(e) =>
                                      updateLineName(line.id, e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.currentTarget.blur()
                                      }
                                    }}
                                    placeholder="Line name"
                                  />
                                </label>
                                <input
                                  type="color"
                                  className="lineColorInput"
                                  value={line.color}
                                  onChange={(e) =>
                                    updateLineColor(line.id, e.target.value)
                                  }
                                  title="Line color"
                                />
                                <select
                                  ref={
                                    line.name === DEMO_TOUR_LINE_NAME
                                      ? demoTourLineModeSelectRef
                                      : undefined
                                  }
                                  className="lineWeightSelect"
                                  value={getLineMode(line)}
                                  onChange={(e) =>
                                    updateLineMode(line.id, e.target.value as TransitMode)
                                  }
                                  title="Transit mode"
                                >
                                  {TRANSIT_MODES.map((m) => (
                                    <option key={m} value={m}>
                                      {modeGroupTitle(m)}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  ref={
                                    line.name === DEMO_TOUR_LINE_NAME
                                      ? demoTourLineWeightSelectRef
                                      : undefined
                                  }
                                  className="lineWeightSelect"
                                  value={line.weight ?? DEFAULT_LINE_WEIGHT}
                                  onChange={(e) =>
                                    updateLineWeight(
                                      line.id,
                                      Number(e.target.value),
                                    )
                                  }
                                  title="Line thickness"
                                >
                                  {LINE_WEIGHTS.map((w) => (
                                    <option key={w} value={w}>
                                      {w}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  ref={
                                    line.name === DEMO_TOUR_LINE_NAME
                                      ? demoTourLineDashSelectRef
                                      : undefined
                                  }
                                  className="lineWeightSelect"
                                  value={line.dashArray ?? '0'}
                                  onChange={(e) =>
                                    updateLineDashArray(
                                      line.id,
                                      e.target.value,
                                    )
                                  }
                                  title="Line style"
                                >
                                  <option value="0">Solid</option>
                                  <option value="10,10">Dashed</option>
                                  <option value="4,8">Dotted</option>
                                </select>
                                <label className="lineCardCheckbox">
                                  <input
                                    type="checkbox"
                                    checked={!!line.expressEnabled}
                                    onChange={(e) =>
                                      updateLineExpressEnabled(
                                        line.id,
                                        e.target.checked,
                                      )
                                    }
                                  />
                                  <span>Express service</span>
                                </label>
                                <label className="lineCardCheckbox">
                                  <input
                                    type="checkbox"
                                    checked={!!line.planned}
                                    onChange={(e) =>
                                      updateLinePlanned(
                                        line.id,
                                        e.target.checked,
                                      )
                                    }
                                  />
                                  <span>Planned / under construction</span>
                                </label>
                              </div>
                              {line.stationIds.length >= 2 &&
                                line.stationIds[0] ===
                                  line.stationIds[line.stationIds.length - 1] && (
                                  <div className="lineCardLoopBreak">
                                    <button
                                      type="button"
                                      className="lineActionBtn"
                                      onClick={() => breakLoopLine(line.id)}
                                      title="Remove the closing segment so the line no longer forms a loop"
                                    >
                                      Break loop
                                    </button>
                                  </div>
                                )}
                              {line.stationIds.length > 0 && (
                                <ul className="lineStations">
                                  {line.stationIds.map((sid, idx) => {
                                    const station = stations.find(
                                      (s) => s.id === sid,
                                    )
                                    if (!station) return null
                                    const transferLines = (linesByStationId.get(station.id) ?? [])
                                      .filter((l) => l.id !== line.id)
                                      .slice()
                                      .sort((a, b) => a.name.localeCompare(b.name))
                                    const transferSwatches =
                                      transferLines.length > 0 ? (
                                        <span
                                          className="stationTransferSwatches"
                                          title={`Also on: ${transferLines.map((l) => l.name).join(', ')}`}
                                        >
                                          {transferLines.map((l) => (
                                            <span
                                              key={l.id}
                                              className="stationTransferSwatch"
                                              style={{ backgroundColor: l.color }}
                                              title={l.name}
                                            />
                                          ))}
                                        </span>
                                      ) : null
                                    return (
                                      <li key={sid}>
                                        <span className="lineStationRow">
                                          {editingStationId ===
                                          station.id ? (
                                            <>
                                              <input
                                                type="text"
                                                className="stationNameInput lineStationNameInput"
                                                value={station.name}
                                                onChange={(e) =>
                                                  setStations((prev) =>
                                                    prev.map((s) =>
                                                      s.id === station.id
                                                        ? {
                                                            ...s,
                                                            name: e.target.value,
                                                          }
                                                        : s,
                                                    ),
                                                  )
                                                }
                                                onBlur={() =>
                                                  renameStation(
                                                    station.id,
                                                    station.name,
                                                  )
                                                }
                                                onKeyDown={(e) => {
                                                  if (e.key === 'Enter')
                                                    renameStation(
                                                      station.id,
                                                      station.name,
                                                    )
                                                  if (e.key === 'Escape')
                                                    setEditingStationId(null)
                                                }}
                                                autoFocus
                                              />
                                              {transferSwatches}
                                            </>
                                          ) : (
                                            <>
                                              <button
                                                type="button"
                                                className="stationNameBtn"
                                                data-tour-station-id={station.id}
                                                onClick={() =>
                                                  setEditingStationId(
                                                    station.id,
                                                  )
                                                }
                                                title="Rename and adjust label"
                                              >
                                                {station.name || 'Unnamed'}
                                              </button>
                                              {transferSwatches}
                                              <span className="lineStationRowActions">
                                                <button
                                                  type="button"
                                                  className="stationGoBtn"
                                                  onClick={() =>
                                                    setEditingStationId(
                                                      station.id,
                                                    )
                                                  }
                                                  title="Adjust label position/rotation"
                                                >
                                                  Label
                                                </button>
                                                {line.expressEnabled && (
                                                  <button
                                                    type="button"
                                                    className={`stationExpressBtn ${
                                                      line.expressStationIds?.includes(
                                                        sid,
                                                      )
                                                        ? 'stationExpressBtnOn'
                                                        : ''
                                                    }`}
                                                    onClick={() =>
                                                      toggleLineExpressStation(
                                                        line.id,
                                                        sid,
                                                      )
                                                    }
                                                    title={
                                                      line.expressStationIds?.includes(
                                                        sid,
                                                      )
                                                        ? 'Mark as local stop'
                                                        : 'Mark as express stop'
                                                    }
                                                  >
                                                    Ex
                                                  </button>
                                                )}
                                                <button
                                                  type="button"
                                                  className="stationGoBtn"
                                                  onClick={() =>
                                                    focusOnStation(station)
                                                  }
                                                  title="Pan to station"
                                                >
                                                  Go
                                                </button>
                                                <button
                                                  type="button"
                                                  className="stationDeleteBtn"
                                                  onClick={() =>
                                                    deleteStation(station.id)
                                                  }
                                                  title="Delete station"
                                                >
                                                  ×
                                                </button>
                                                <button
                                                  type="button"
                                                  className="lineStationRemove"
                                                  onClick={() =>
                                                    removeStationFromLine(
                                                      line.id,
                                                      sid,
                                                      idx,
                                                    )
                                                  }
                                                  title="Remove from line"
                                                >
                                                  –
                                                </button>
                                              </span>
                                            </>
                                          )}
                                          {editingStationId === station.id ? (
                                            <span className="lineStationRowActions">
                                              <button
                                                type="button"
                                                className="lineStationRemove"
                                                onClick={() =>
                                                  removeStationFromLine(
                                                    line.id,
                                                    sid,
                                                    idx,
                                                  )
                                                }
                                                title="Remove from line"
                                              >
                                                –
                                              </button>
                                            </span>
                                          ) : null}
                                        </span>
                                      </li>
                                    )
                                  })}
                                </ul>
                              )}
                            </>
                          )}
                        </li>
                      )
                              })}
                            </ul>
                          )}
                        </div>
                      )
                    })}
                  </>
                )}
              </section>
            </aside>
            <div
              ref={demoSidebarResizeRef}
              className="sidebarResizeHandle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onMouseDown={startSidebarResize}
            />

            <main
              ref={demoMapWrapRef}
              className={`mapWrap ${
                mode === 'line' && selectedLineId ? 'draw-line-mode' : ''
              } ${
                mode === 'edit-line' && selectedLineId ? 'edit-line-mode' : ''
              }`}
            >
              <TransitMapView
                key={mapMountKey}
                center={mapCenter}
                zoom={zoom}
                mode={mode}
                stations={stations}
                lines={lines}
                selectedLineId={selectedLineId}
                demoTourActive={demoTourActive}
                demoTourClearBelowCaptionRef={demoTourClearBelowCaptionRef}
                focusTarget={focusLocation}
                onFocusComplete={() => setFocusLocation(null)}
                onAddStation={addStation}
                onAddStationToLine={addStationToLine}
                onRemoveStationFromLine={removeStationFromLine}
                onStationMove={moveStation}
                onLineSegmentClick={addStationOnLineSegment}
                onLineMidpointDrop={addLineMidpointDrop}
                addingStationAfter={addingStationAfter}
                onAddStationBetween={addStationBetween}
                showStationNamesOnMap={showStationNamesOnMap}
                stationLabelOverrides={stationLabelOverrides}
                stationLabelFontFamily={stationLabelFontFamily}
                stationLabelFontSizePxOverride={stationLabelFontSizePxOverride}
                simplifiedBasemap={simplifiedBasemap}
                hiddenLineIds={hiddenLineIds}
                modeVisibility={modeVisibility}
                labelStylesByMode={labelStylesByMode}
                markerStylesByMode={markerStylesByMode}
                onStationRename={renameStation}
                onToggleExpressStation={toggleLineExpressStation}
                onDeleteStation={deleteStation}
              />
            </main>
          </>
        )}
      </div>

      {importConflictOpen && pendingImportPayload && (
        <div
          className="importConflictBackdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setImportConflictOpen(false)
              setPendingImportPayload(null)
            }
          }}
        >
          <div className="importConflictModal" role="dialog" aria-labelledby="importConflictTitle">
            <header className="importConflictModalHeader">
              <h3 id="importConflictTitle">Similar routes found</h3>
              <p className="importConflictHint">
                These imports look like lines you already have. Unchecked rows will be <strong>skipped</strong>. Tick{' '}
                <strong>Import anyway</strong> only if you want a second copy on the map.
              </p>
            </header>
            <div className="importConflictListWrap">
              <ul className="importConflictList">
                {pendingImportPayload.conflicts.map((c) => (
                  <li key={`${c.importedIndex}-${c.existingLineId}`} className="importConflictRow">
                    <div
                      className={`importConflictBadge ${
                        c.reason === 'duplicate_geometry'
                          ? 'importConflictBadgeGeom'
                          : 'importConflictBadgeSimilar'
                      }`}
                    >
                      {c.reason === 'duplicate_geometry' ? 'Same path' : 'Similar route'}
                    </div>
                    <div className="importConflictCompare">
                      <div className="importConflictCol">
                        <span className="importConflictColLabel">Import</span>
                        <span className="importConflictName">{c.importedName}</span>
                      </div>
                      <span className="importConflictVs" aria-hidden>
                        ·
                      </span>
                      <div className="importConflictCol">
                        <span className="importConflictColLabel">Already on map</span>
                        <span className="importConflictName importConflictNameExisting">{c.existingName}</span>
                      </div>
                    </div>
                    <label className="importConflictAnyway">
                      <input
                        type="checkbox"
                        checked={importAnywayIndices.has(c.importedIndex)}
                        onChange={(e) => {
                          setImportAnywayIndices((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(c.importedIndex)
                            else next.delete(c.importedIndex)
                            return next
                          })
                        }}
                      />
                      <span>Import anyway (duplicate)</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="importConflictFooter">
              <button
                type="button"
                className="toolBtn importConflictCancelBtn"
                onClick={() => {
                  setImportConflictOpen(false)
                  setPendingImportPayload(null)
                }}
              >
                Cancel
              </button>
              <button
                ref={demoConflictContinueRef}
                type="button"
                className="toolBtn importConflictPrimaryBtn"
                onClick={confirmImportWithConflicts}
              >
                Continue import
              </button>
            </footer>
          </div>
        </div>
      )}

    </div>
    {createPortal(
      <>
        {demoTourActive && (
          <div
            className={`demoTourLayer${systemMapView ? ' demoTourLayer--systemMap' : ''}${
              demoTourFadeOut ? ' demoTourLayer--fadeOut' : ''
            }`}
            aria-live="polite"
          >
            <div
              className={`demoTourBackdrop${demoTourHighlightRect ? ' demoTourBackdrop--dimOnly' : ''}`}
              aria-hidden
            />
            {demoTourHighlightRect && (
              <div
                className={`demoTourFocusHole${demoTourHighlightStrong ? ' demoTourFocusHole--strong' : ''}`}
                style={{
                  left: demoTourHighlightRect.x,
                  top: demoTourHighlightRect.y,
                  width: demoTourHighlightRect.width,
                  height: demoTourHighlightRect.height,
                }}
                aria-hidden
              />
            )}
            <div
              className="demoTourCursor"
              style={{
                transform: demoTourCursorTransform(demoTourCursor.x, demoTourCursor.y),
                opacity: demoTourCursor.visible && !demoTourHighlightStrong ? 1 : 0,
              }}
              aria-hidden
            >
              <svg
                className="demoTourCursorSvg"
                viewBox="0 0 48 48"
                width={DEMO_TOUR_CURSOR_SVG_PX}
                height={DEMO_TOUR_CURSOR_SVG_PX}
              >
                <path
                  d="M10 8 L38 32 L26 34 L20 44 Z"
                  fill="var(--accent, #0d9488)"
                  stroke="#fff"
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="demoTourCaptionWrap">
              <div className="demoTourCaptionInner">
                <p className="demoTourCaptionText">{demoTourCaption}</p>
                {demoTourSubtext && <p className="demoTourStepSubtext">{demoTourSubtext}</p>}
                <p className="demoTourHint">Press Esc to end the tour.</p>
              </div>
            </div>
          </div>
        )}

        {demoTourEndCardOpen && (
          <div className="demoTourEndCardLayer" aria-live="polite">
            <div className="demoTourEndCardPanel" role="dialog" aria-label="Demo complete">
              <p className="demoTourEndCardBrand">trainbox</p>
              <p className="demoTourEndCardTagline">Guided tour complete</p>
              <button
                type="button"
                className="toolBtn demoTourEndCardBtn"
                onClick={() => {
                  setDemoTourEndCardOpen(false)
                }}
              >
                Exit demo
              </button>
            </div>
          </div>
        )}
      </>,
      document.body,
    )}
    </>
  )
}

