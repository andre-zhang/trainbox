import type { LatLng } from '../types'

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
