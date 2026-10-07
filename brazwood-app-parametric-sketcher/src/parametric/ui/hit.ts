// src/parametric/ui/hit.ts
// Hit testing for selection on the parametric canvas. Pure. Returns the
// topmost thing under a world point: a point first, then an object body
// (wall/column/beam/opening), then a bare line. Tolerances are meters.
import type { Pt, SketchDoc, SketchObject } from '../model'
import { layerOf } from '../model'
import { bodyPolygon, columnPolygon, openingGeometry } from '../objects'
import { closestOnSegment, dist } from '../geom'

export type Hit =
  | { type: 'point'; id: string }
  | { type: 'object'; id: string; object: SketchObject }
  | { type: 'line'; id: string }

export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function hitTest(doc: SketchDoc, positions: ReadonlyMap<string, Pt>, p: Pt, tolM: number): Hit | null {
  const visibleLayer = (o: SketchObject): boolean => !o.hidden && doc.layers[layerOf(o)].visible
  const hiddenLines = new Set<string>()
  for (const o of doc.objects) {
    if (visibleLayer(o)) continue
    if ('line' in o) hiddenLines.add(o.line)
    if (o.kind === 'roofOutline') for (const l of o.lines) hiddenLines.add(l)
  }
  // Points
  let best: { d: number; hit: Hit } | null = null
  for (const pt of doc.points) {
    const q = positions.get(pt.id) ?? pt
    const d = dist(q, p)
    if (d <= tolM && (!best || d < best.d)) best = { d, hit: { type: 'point', id: pt.id } }
  }
  if (best) {
    // A column's center point IS the column: selecting/dragging it means the
    // column (its properties, its relations) — never a bare point.
    const pid = best.hit.type === 'point' ? best.hit.id : null
    const col = pid ? doc.objects.find((o) => o.kind === 'column' && o.point === pid && visibleLayer(o)) : undefined
    if (col) return { type: 'object', id: col.id, object: col }
    return best.hit
  }
  // Object bodies (openings before walls: they sit on top).
  const ordered = [...doc.objects].sort((a, b) => rank(a) - rank(b))
  for (const o of ordered) {
    if (!visibleLayer(o)) continue
    if (o.kind === 'column') {
      const poly = columnPolygon(doc, o, positions)
      if (poly && pointInPolygon(p, poly)) return { type: 'object', id: o.id, object: o }
    } else if (o.kind === 'opening') {
      const g = openingGeometry(doc, o, positions)
      if (g && pointInPolygon(p, g.polygon)) return { type: 'object', id: o.id, object: o }
    } else if (o.kind === 'wall' || o.kind === 'beam') {
      const poly = bodyPolygon(doc, o, positions)
      if (poly && pointInPolygon(p, poly)) return { type: 'object', id: o.id, object: o }
    }
  }
  // Lines (incl. aux / roof edge / wall lines by distance)
  let bestLine: { d: number; id: string } | null = null
  for (const l of doc.lines) {
    if (hiddenLines.has(l.id)) continue
    const a = positions.get(l.a)
    const b = positions.get(l.b)
    if (!a || !b) continue
    const d = dist(closestOnSegment(p, a, b), p)
    if (d <= tolM && (!bestLine || d < bestLine.d)) bestLine = { d, id: l.id }
  }
  if (bestLine) {
    const owner = doc.objects.find((o) => 'line' in o && o.line === bestLine!.id && visibleLayer(o))
    if (owner) return { type: 'object', id: owner.id, object: owner }
    return { type: 'line', id: bestLine.id }
  }
  return null
}

function rank(o: SketchObject): number {
  switch (o.kind) {
    case 'opening': return 0
    case 'column': return 1
    case 'beam': return 2
    case 'wall': return 3
    default: return 4
  }
}
