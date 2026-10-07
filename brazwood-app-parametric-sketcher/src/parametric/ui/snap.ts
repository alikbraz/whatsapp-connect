// src/parametric/ui/snap.ts
// Snapping for the parametric canvas (owner brief §5 "הצמדות"): existing
// points, intersections, midpoints, any point along a line (with a
// horizontal/vertical alignment to the draft's anchor), and the grid.
// Pure: meters in, meters out; pixel tolerances are converted by the caller.
import type { Pt, SketchDoc } from '../model'
import { closestOnSegment, dist, lineIntersection, mid } from '../geom'

export type SnapKind = 'point' | 'intersection' | 'midpoint' | 'on-line' | 'axis' | 'grid' | 'free'

export interface Snap {
  point: Pt
  kind: SnapKind
  /** Existing point id when kind === 'point'. */
  pointId?: string
  /** Line id when kind === 'on-line' / 'midpoint'. */
  lineId?: string
  /** Inferred axis relation vs the anchor (while drawing). */
  axis?: 'horizontal' | 'vertical'
}

export interface SnapOptions {
  /** Snap radius in meters (pixels / pxPerM). */
  radiusM: number
  gridM: number | null
  /** Point ids to ignore (the dragged ones). */
  exclude?: ReadonlySet<string>
  /** The draft line's first point, for axis inference. */
  anchor?: Pt
  /** Hidden lines (by id) are not snapped to. */
  hiddenLines?: ReadonlySet<string>
}

export function snapPoint(doc: SketchDoc, positions: ReadonlyMap<string, Pt>, target: Pt, o: SnapOptions): Snap {
  const r = o.radiusM
  const segs = doc.lines
    .filter((l) => !o.hiddenLines?.has(l.id))
    .map((l) => ({ id: l.id, a: positions.get(l.a), b: positions.get(l.b) }))
    .filter((s): s is { id: string; a: Pt; b: Pt } => !!s.a && !!s.b)

  // 1. existing points
  let best: { d: number; snap: Snap } | null = null
  for (const p of doc.points) {
    if (o.exclude?.has(p.id)) continue
    const q = positions.get(p.id) ?? p
    const d = dist(q, target)
    if (d <= r && (!best || d < best.d)) best = { d, snap: { point: { x: q.x, y: q.y }, kind: 'point', pointId: p.id } }
  }
  if (best) return best.snap

  // 2. intersections
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const x = lineIntersection(segs[i]!.a, segs[i]!.b, segs[j]!.a, segs[j]!.b)
      if (!x) continue
      // only inside both segments (with tolerance)
      const onI = dist(closestOnSegment(x, segs[i]!.a, segs[i]!.b), x) < 1e-6
      const onJ = dist(closestOnSegment(x, segs[j]!.a, segs[j]!.b), x) < 1e-6
      if (!onI || !onJ) continue
      const d = dist(x, target)
      if (d <= r && (!best || d < best.d)) best = { d, snap: { point: x, kind: 'intersection' } }
    }
  }
  if (best) return best.snap

  // 3. midpoints
  for (const s of segs) {
    const m = mid(s.a, s.b)
    const d = dist(m, target)
    if (d <= r && (!best || d < best.d)) best = { d, snap: { point: m, kind: 'midpoint', lineId: s.id } }
  }
  if (best) return best.snap

  // 4. axis alignment with the anchor (horizontal / vertical)
  let axisSnap: Snap | null = null
  if (o.anchor) {
    const dx = Math.abs(target.x - o.anchor.x)
    const dy = Math.abs(target.y - o.anchor.y)
    if (dy <= r && dx > dy) axisSnap = { point: { x: target.x, y: o.anchor.y }, kind: 'axis', axis: 'horizontal' }
    else if (dx <= r && dy >= dx) axisSnap = { point: { x: o.anchor.x, y: target.y }, kind: 'axis', axis: 'vertical' }
  }

  // 5. on a line (closest point) — combined with the axis when both apply
  for (const s of segs) {
    const c = closestOnSegment(target, s.a, s.b)
    const d = dist(c, target)
    if (d <= r && (!best || d < best.d)) {
      let point = c
      if (axisSnap) {
        // intersect the axis line with the segment's line for an exact corner
        const axisB = axisSnap.axis === 'horizontal' ? { x: o.anchor!.x + 1, y: o.anchor!.y } : { x: o.anchor!.x, y: o.anchor!.y + 1 }
        const x = lineIntersection(o.anchor!, axisB, s.a, s.b)
        if (x && dist(x, target) <= r * 1.5) point = x
      }
      best = { d, snap: { point, kind: 'on-line', lineId: s.id, ...(axisSnap && point !== c ? { axis: axisSnap.axis } : {}) } }
    }
  }
  if (best) return best.snap
  if (axisSnap) {
    if (o.gridM) {
      const g = o.gridM
      const p = axisSnap.point
      axisSnap.point = axisSnap.axis === 'horizontal' ? { x: Math.round(p.x / g) * g, y: p.y } : { x: p.x, y: Math.round(p.y / g) * g }
    }
    return axisSnap
  }

  // 6. grid
  if (o.gridM) {
    const g = o.gridM
    return { point: { x: Math.round(target.x / g) * g, y: Math.round(target.y / g) * g }, kind: 'grid' }
  }
  return { point: target, kind: 'free' }
}
