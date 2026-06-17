import type { LatLng, Line, Station } from './types'
import { getLineMode } from './types'
import { piecewiseQuadraticPathForLine, smoothCurveThroughPoints } from './utils/curve'

/** Stable key for when smoothed line paths must be rebuilt. */
export function mapGeometryCacheKey(stations: Station[], lines: Line[]): string {
  const stationPart = stations
    .map((s) => `${s.id}:${s.position.lat.toFixed(5)},${s.position.lng.toFixed(5)}`)
    .join('|')
  const linePart = lines
    .map((l) => {
      const wp = (l.waypoints ?? [])
        .map((w) => `${w.afterStationId}@${w.position.lat.toFixed(5)},${w.position.lng.toFixed(5)}`)
        .join('+')
      return `${l.id}:${l.stationIds.join(',')}:${wp}`
    })
    .join(';')
  return `${stations.length}#${lines.length}#${stationPart}#${linePart}`
}

/**
 * Bezier sample density per segment. Precomputed once — pan/zoom does not re-run this,
 * so we can afford full quality unless the map is enormous.
 */
function curveStepsForLine(
  pointCount: number,
  mapStationCount: number,
  hasWaypoints: boolean,
  isRail: boolean,
): number {
  if (hasWaypoints) return 12
  if (isRail) return 12
  let steps = pointCount > 140 ? 10 : pointCount > 70 ? 11 : 12
  if (mapStationCount > 1800) steps = Math.min(steps, 10)
  if (mapStationCount > 2800) steps = Math.min(steps, 9)
  return steps
}

/**
 * Precompute smoothed polylines once per map geometry (not per pan/zoom).
 * Used on initial open so panning does not re-run curve sampling.
 */
export function buildSmoothedLinePositions(
  lines: Line[],
  stationsById: Map<string, Station>,
): LatLng[][] {
  const mapStationCount = stationsById.size
  return lines.map((line) => {
    const positions: LatLng[] = []
    for (let i = 0; i < line.stationIds.length; i++) {
      const id = line.stationIds[i]
      const pos = stationsById.get(id)?.position
      if (pos) positions.push(pos)
      if (i < line.stationIds.length - 1) {
        const wp = line.waypoints?.find((w) => w.afterStationId === id)
        if (wp) positions.push(wp.position)
      }
    }
    const n = positions.length
    if (n < 2) return positions
    const mode = getLineMode(line)
    const isRail = mode === 'regional_rail' || mode === 'national_rail'
    const hasWaypoints = (line.waypoints?.length ?? 0) > 0
    const steps = curveStepsForLine(n, mapStationCount, hasWaypoints, isRail)
    if (hasWaypoints) {
      return piecewiseQuadraticPathForLine(line, stationsById, steps)
    }
    return smoothCurveThroughPoints(positions, steps)
  })
}
