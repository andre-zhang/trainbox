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
 * Precompute smoothed polylines once per map geometry (not per pan/zoom).
 * Used on initial open so panning does not re-run curve sampling.
 */
export function buildSmoothedLinePositions(
  lines: Line[],
  stationsById: Map<string, Station>,
): LatLng[][] {
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
    if (!isRail && stationsById.size > 1600 && n > 24) return positions
    let steps = n > 140 ? 7 : n > 70 ? 9 : 12
    if (stationsById.size > 500) steps = Math.min(steps, 6)
    if (stationsById.size > 1000) steps = Math.min(steps, 5)
    const hasWaypoints = (line.waypoints?.length ?? 0) > 0
    if (hasWaypoints) {
      return piecewiseQuadraticPathForLine(line, stationsById, steps)
    }
    return smoothCurveThroughPoints(positions, steps)
  })
}
