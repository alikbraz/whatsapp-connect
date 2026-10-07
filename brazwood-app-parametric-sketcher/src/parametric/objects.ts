// src/parametric/objects.ts
// Semantic-object geometry helpers (owner brief §2). PURE. Everything here
// DERIVES drawing geometry from the sketch (never stores it): a wall's body
// polygon from its line + thickness, a column's rectangle from its point +
// section, an opening's footprint from its wall. Also the face-offset math
// relations.ts needs ("מרחק מפני הקיר, ולא רק מקו המרכז שלו").
import type { Pt, SketchDoc, SketchObject, WallFaceRef, WallObject } from './model'
import { lineById, pointById } from './model'
import { add, leftNormal, lerp, scale, signedDist, sub, unit } from './geom'

export interface Seg { a: Pt; b: Pt }

export function lineSeg(doc: SketchDoc, lineId: string, positions?: ReadonlyMap<string, Pt>): Seg | null {
  const l = lineById(doc, lineId)
  if (!l) return null
  const a = positions?.get(l.a) ?? pointById(doc, l.a)
  const b = positions?.get(l.b) ?? pointById(doc, l.b)
  if (!a || !b) return null
  return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } }
}

/** Half-width of an object's body across its line (walls: thickness/2,
 *  beams: section width/2, everything else 0). */
export function halfWidthM(o: SketchObject): number {
  if (o.kind === 'wall') return o.thicknessM / 2
  if (o.kind === 'beam') return o.sectionWmm / 2000
  return 0
}

/** Position of a reference line (center / faceA / faceB) along the LEFT
 *  normal of the object's own sketch line, relative to the CENTER. */
function refPos(o: SketchObject, ref: WallFaceRef): number {
  const h = halfWidthM(o)
  return ref === 'faceA' ? h : ref === 'faceB' ? -h : 0
}

/** Where the object's sketch line sits relative to its center (walls can be
 *  drawn along a face; beams/aux are always on center). */
function linePos(o: SketchObject): number {
  if (o.kind === 'wall') return refPos(o, o.lineIs)
  return 0
}

/** Signed offset (meters, along the left normal of the object's sketch line)
 *  from the SKETCH LINE to the requested reference line. A constraint that
 *  wants "distance d from faceA" measures sdist(p, line) == d + offsetOf(...). */
export function offsetOf(o: SketchObject, ref: WallFaceRef): number {
  return refPos(o, ref) - linePos(o)
}

/** The exterior-wall OUTER side: +1 when the outside lies on the left
 *  (faceA) side of a→b, −1 when on the right. Decided against the centroid
 *  of every exterior wall endpoint (the building interior) — never a stored
 *  guess, so re-drawing a wall the other way round stays correct. Falls back
 *  to −1 (CCW ring convention: interior on the left) when undecidable. */
export function outerSign(doc: SketchDoc, wall: WallObject, positions?: ReadonlyMap<string, Pt>): 1 | -1 {
  const ext = doc.objects.filter((o): o is WallObject => o.kind === 'wall' && o.wallType === 'exterior')
  const pts: Pt[] = []
  for (const w of ext) {
    const s = lineSeg(doc, w.line, positions)
    if (s) pts.push(s.a, s.b)
  }
  const seg = lineSeg(doc, wall.line, positions)
  if (!seg || pts.length < 3) return -1
  const c = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 })
  const centroid = scale(c, 1 / pts.length)
  const d = signedDist(centroid, seg.a, seg.b)
  if (Math.abs(d) < 1e-9) return -1
  return d > 0 ? -1 : 1
}

/** The two body edges of a wall/beam (left face first), in plan. */
export function bodyFaces(doc: SketchDoc, o: SketchObject, positions?: ReadonlyMap<string, Pt>): { faceA: Seg; faceB: Seg; center: Seg } | null {
  const lineId = o.kind === 'wall' || o.kind === 'beam' ? o.line : null
  if (!lineId) return null
  const s = lineSeg(doc, lineId, positions)
  if (!s) return null
  const n = leftNormal(s.a, s.b)
  const offA = offsetOf(o, 'faceA')
  const offB = offsetOf(o, 'faceB')
  const offC = offsetOf(o, 'center')
  const shift = (seg: Seg, k: number): Seg => ({ a: add(seg.a, scale(n, k)), b: add(seg.b, scale(n, k)) })
  return { faceA: shift(s, offA), faceB: shift(s, offB), center: shift(s, offC) }
}

/** Wall/beam body polygon (4 points). */
export function bodyPolygon(doc: SketchDoc, o: SketchObject, positions?: ReadonlyMap<string, Pt>): Pt[] | null {
  const f = bodyFaces(doc, o, positions)
  if (!f) return null
  return [f.faceA.a, f.faceA.b, f.faceB.b, f.faceB.a]
}

/** Column rectangle (4 points) around its center point. */
export function columnPolygon(doc: SketchDoc, o: SketchObject, positions?: ReadonlyMap<string, Pt>): Pt[] | null {
  if (o.kind !== 'column') return null
  const c = positions?.get(o.point) ?? pointById(doc, o.point)
  if (!c) return null
  const w = o.sectionWmm / 2000
  const h = o.sectionHmm / 2000
  const r = (o.rotationDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const corner = (dx: number, dy: number): Pt => ({ x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos })
  return [corner(-w, -h), corner(w, -h), corner(w, h), corner(-w, h)]
}

/** Opening footprint on its wall: the segment along the wall's center line
 *  plus the body polygon it cuts. Null when the wall is missing. */
export function openingGeometry(doc: SketchDoc, o: SketchObject, positions?: ReadonlyMap<string, Pt>): { seg: Seg; polygon: Pt[] } | null {
  if (o.kind !== 'opening') return null
  const wall = doc.objects.find((w) => w.id === o.wall)
  if (!wall || wall.kind !== 'wall') return null
  const faces = bodyFaces(doc, wall, positions)
  if (!faces) return null
  const c = faces.center
  const d = sub(c.b, c.a)
  const L = Math.hypot(d.x, d.y)
  if (L < 1e-9) return null
  const u = unit(d)
  const t0 = Math.max(0, Math.min(L, o.offsetM - o.widthM / 2))
  const t1 = Math.max(0, Math.min(L, o.offsetM + o.widthM / 2))
  const n = leftNormal(c.a, c.b)
  const h = halfWidthM(wall)
  const p0 = add(c.a, scale(u, t0))
  const p1 = add(c.a, scale(u, t1))
  return {
    seg: { a: p0, b: p1 },
    polygon: [add(p0, scale(n, h)), add(p1, scale(n, h)), add(p1, scale(n, -h)), add(p0, scale(n, -h))],
  }
}

/** A point along a line at parameter t (0..1). */
export function pointAlong(doc: SketchDoc, lineId: string, t: number, positions?: ReadonlyMap<string, Pt>): Pt | null {
  const s = lineSeg(doc, lineId, positions)
  return s ? lerp(s.a, s.b, t) : null
}
