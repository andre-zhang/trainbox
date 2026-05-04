import type { LatLng, Line } from '../types'

/**
 * Sample a cubic Bezier curve (P0, cp1, cp2, P1) at N points in lat/lng space.
 */
function sampleCubicBezier(
  p0: LatLng,
  cp1: LatLng,
  cp2: LatLng,
  p1: LatLng,
  steps: number
): LatLng[] {
  const points: LatLng[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const lat = u * u * u * p0.lat + 3 * u * u * t * cp1.lat + 3 * u * t * t * cp2.lat + t * t * t * p1.lat
    const lng = u * u * u * p0.lng + 3 * u * u * t * cp1.lng + 3 * u * t * t * cp2.lng + t * t * t * p1.lng
    points.push({ lat, lng })
  }
  return points
}

/**
 * Compute smooth curve through an ordered list of lat/lng points using cubic Bezier segments.
 * Uses tangent vectors from adjacent points (Catmull-Rom style) for natural-looking transit lines.
 */
export function smoothCurveThroughPoints(positions: LatLng[], stepsPerSegment = 12): LatLng[] {
  if (positions.length < 2) return [...positions]
  if (positions.length === 2) return [...positions]

  const result: LatLng[] = [{ ...positions[0] }]

  for (let i = 0; i < positions.length - 1; i++) {
    const p0 = positions[i]
    const p1 = positions[i + 1]
    const pPrev = positions[i - 1]
    const pNext = positions[i + 2]

    // Tangent at p0: direction from previous to next (or from p0 to p1 if first)
    const k = 0.25
    let tan0: LatLng
    if (i === 0) {
      tan0 = { lat: (p1.lat - p0.lat) * k, lng: (p1.lng - p0.lng) * k }
    } else {
      tan0 = { lat: (p1.lat - pPrev.lat) * k, lng: (p1.lng - pPrev.lng) * k }
    }
    let tan1: LatLng
    if (i + 2 >= positions.length) {
      tan1 = { lat: (p1.lat - p0.lat) * k, lng: (p1.lng - p0.lng) * k }
    } else {
      tan1 = { lat: (pNext.lat - p0.lat) * k, lng: (pNext.lng - p0.lng) * k }
    }

    const cp1: LatLng = { lat: p0.lat + tan0.lat, lng: p0.lng + tan0.lng }
    const cp2: LatLng = { lat: p1.lat - tan1.lat, lng: p1.lng - tan1.lng }

    const segment = sampleCubicBezier(p0, cp1, cp2, p1, stepsPerSegment)
    // Skip first point of segment (already added as end of previous)
    for (let j = 1; j < segment.length; j++) {
      result.push(segment[j])
    }
  }

  return result
}

/** Quadratic Bézier P0 → P2 with control P1 (one bend between endpoints). */
export function sampleQuadraticBezier(p0: LatLng, p1: LatLng, p2: LatLng, steps: number): LatLng[] {
  const points: LatLng[] = []
  const n = Math.max(2, steps)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    points.push({
      lat: u * u * p0.lat + 2 * u * t * p1.lat + t * t * p2.lat,
      lng: u * u * p0.lng + 2 * u * t * p1.lng + t * t * p2.lng,
    })
  }
  return points
}

function sampleLineSegment(a: LatLng, b: LatLng, steps: number): LatLng[] {
  const points: LatLng[] = []
  const n = Math.max(1, steps)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    points.push({
      lat: a.lat + t * (b.lat - a.lat),
      lng: a.lng + t * (b.lng - a.lng),
    })
  }
  return points
}

/**
 * Build the displayed line path when the line has midpoint waypoints.
 * Each station→station leg uses at most one bend: quadratic through the optional handle,
 * or a straight chord if there is no handle. Avoids running Catmull-style smoothing over
 * [station, waypoint, station], which creates an S / zigzag between the same two stops.
 */
export function piecewiseQuadraticPathForLine(
  line: Line,
  stationPositionById: ReadonlyMap<string, { position: LatLng }>,
  stepsPerSegment: number,
): LatLng[] {
  const ids = line.stationIds
  if (ids.length < 2) return []
  const wpByAfter = new Map<string, LatLng>()
  for (const w of line.waypoints ?? []) {
    wpByAfter.set(w.afterStationId, w.position)
  }
  const result: LatLng[] = []
  const steps = Math.max(2, stepsPerSegment)
  for (let i = 0; i < ids.length - 1; i++) {
    const posA = stationPositionById.get(ids[i])?.position
    const posB = stationPositionById.get(ids[i + 1])?.position
    if (!posA || !posB) continue
    const wp = wpByAfter.get(ids[i])
    const seg = wp ? sampleQuadraticBezier(posA, wp, posB, steps) : sampleLineSegment(posA, posB, Math.min(steps, 10))
    if (result.length === 0) {
      result.push(...seg)
    } else {
      result.push(...seg.slice(1))
    }
  }
  return result
}
