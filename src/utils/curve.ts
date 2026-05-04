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

/** Point on quadratic Bézier P0 → P2 with control P1 at parameter t ∈ [0, 1]. */
export function quadraticBezierPointAtT(p0: LatLng, control: LatLng, p2: LatLng, t: number): LatLng {
  const u = 1 - t
  return {
    lat: u * u * p0.lat + 2 * u * t * control.lat + t * t * p2.lat,
    lng: u * u * p0.lng + 2 * u * t * control.lng + t * t * p2.lng,
  }
}

/** Midpoint of the quadratic at t = 0.5: Q(0.5) = 0.25·P0 + 0.5·control + 0.25·P2. */
export function quadraticCurveMidpoint(p0: LatLng, control: LatLng, p2: LatLng): LatLng {
  return quadraticBezierPointAtT(p0, control, p2, 0.5)
}

/**
 * Invert Q(0.5): given a point on the curve at t=0.5 (the bend you see), recover Bézier control.
 * Stored waypoint `position` is this control; UI shows {@link quadraticCurveMidpoint}.
 */
export function quadraticControlFromCurveMidpoint(p0: LatLng, mid: LatLng, p2: LatLng): LatLng {
  return {
    lat: 2 * mid.lat - 0.5 * p0.lat - 0.5 * p2.lat,
    lng: 2 * mid.lng - 0.5 * p0.lng - 0.5 * p2.lng,
  }
}

/** Point on cubic Bézier at t (same basis as {@link sampleCubicBezier}). */
export function cubicBezierPointAtT(p0: LatLng, cp1: LatLng, cp2: LatLng, p1: LatLng, t: number): LatLng {
  const u = 1 - t
  return {
    lat: u * u * u * p0.lat + 3 * u * u * t * cp1.lat + 3 * u * t * t * cp2.lat + t * t * t * p1.lat,
    lng: u * u * u * p0.lng + 3 * u * u * t * cp1.lng + 3 * u * t * t * cp2.lng + t * t * t * p1.lng,
  }
}

function cubicControlPoints(
  pPrev: LatLng | null,
  p0: LatLng,
  p1: LatLng,
  pNext: LatLng | null,
  k: number,
): { cp1: LatLng; cp2: LatLng } {
  let tan0: LatLng
  if (!pPrev) {
    tan0 = { lat: (p1.lat - p0.lat) * k, lng: (p1.lng - p0.lng) * k }
  } else {
    tan0 = { lat: (p1.lat - pPrev.lat) * k, lng: (p1.lng - pPrev.lng) * k }
  }
  let tan1: LatLng
  if (!pNext) {
    tan1 = { lat: (p1.lat - p0.lat) * k, lng: (p1.lng - p0.lng) * k }
  } else {
    tan1 = { lat: (pNext.lat - p0.lat) * k, lng: (pNext.lng - p0.lng) * k }
  }
  return {
    cp1: { lat: p0.lat + tan0.lat, lng: p0.lng + tan0.lng },
    cp2: { lat: p1.lat - tan1.lat, lng: p1.lng - tan1.lng },
  }
}

/** Midpoint (t = 0.5) of the same cubic used in {@link smoothSingleStationSegment}. */
export function cubicStationSegmentMidpoint(
  pPrev: LatLng | null,
  p0: LatLng,
  p1: LatLng,
  pNext: LatLng | null,
  k = 0.25,
): LatLng {
  const { cp1, cp2 } = cubicControlPoints(pPrev, p0, p1, pNext, k)
  return cubicBezierPointAtT(p0, cp1, cp2, p1, 0.5)
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

/**
 * One Catmull-style cubic segment from p0 → p1 (same tangent construction as
 * {@link smoothCurveThroughPoints}), using neighbour stations for continuity at joints.
 */
export function smoothSingleStationSegment(
  pPrev: LatLng | null,
  p0: LatLng,
  p1: LatLng,
  pNext: LatLng | null,
  steps: number,
  k = 0.25,
): LatLng[] {
  const { cp1, cp2 } = cubicControlPoints(pPrev, p0, p1, pNext, k)
  return sampleCubicBezier(p0, cp1, cp2, p1, Math.max(2, steps))
}

/** Closest point on segment AB to q (planar lat/lng, fine for short segments). */
function closestPointOnSegment(a: LatLng, b: LatLng, q: LatLng): LatLng {
  const dx = b.lng - a.lng
  const dy = b.lat - a.lat
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return { ...a }
  let t = ((q.lng - a.lng) * dx + (q.lat - a.lat) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { lat: a.lat + t * dy, lng: a.lng + t * dx }
}

/** Closest point on a polyline (vertex chain) to q. */
export function closestPointOnPolyline(path: LatLng[], q: LatLng): LatLng {
  if (path.length === 0) return { ...q }
  if (path.length === 1) return { ...path[0] }
  let best = path[0]
  let bestD = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const c = closestPointOnSegment(path[i], path[i + 1], q)
    const d = (c.lat - q.lat) * (c.lat - q.lat) + (c.lng - q.lng) * (c.lng - q.lng)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/** Tangent scale for station–station cubics inside {@link piecewiseQuadraticPathForLine} (must match handle placement). */
export const PIECEWISE_INTER_LEG_TANGENT_K = 0.18

/**
 * Build the displayed line path when the line has midpoint waypoints.
 * - Legs **with** a handle: quadratic A → handle → B (one deliberate bend; avoids Catmull S on A–W–B).
 * - Legs **without** a handle: Catmull-style cubic between stations (slightly damped tangents vs
 *   the global smoother to reduce overshoot at sharp corners).
 *
 * Do **not** run a second global smooth on the joined samples — that reintroduces S-shaped wiggles
 * and pulls the path away from where midpoint handles are defined.
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
  const n = ids.length
  for (let i = 0; i < n - 1; i++) {
    const posA = stationPositionById.get(ids[i])?.position
    const posB = stationPositionById.get(ids[i + 1])?.position
    if (!posA || !posB) continue
    const wp = wpByAfter.get(ids[i])
    let seg: LatLng[]
    if (wp) {
      seg = sampleQuadraticBezier(posA, wp, posB, steps)
    } else {
      const pPrev = i > 0 ? stationPositionById.get(ids[i - 1])?.position ?? null : null
      const pNext = i + 2 < n ? stationPositionById.get(ids[i + 2])?.position ?? null : null
      seg = smoothSingleStationSegment(pPrev, posA, posB, pNext, steps, PIECEWISE_INTER_LEG_TANGENT_K)
    }
    if (result.length === 0) {
      result.push(...seg)
    } else {
      result.push(...seg.slice(1))
    }
  }
  return result
}
