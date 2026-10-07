// src/parametric/roofBridge.ts
// SKETCH → ROOF (owner brief §6: "הגג יוכל להסתמך על קירות, קורות ועמודים
// שהוגדרו, ויהיה ברור על אילו רכיבים הוא נשען"). PURE. Derives the roof's
// footprint ring (meters, plan frame — the SAME frame as RoofModel.contour)
// and the list of supporting objects from the sketch:
//   1. an explicit roofOutline object (a closed loop of lines) wins;
//   2. otherwise the EXTERIOR walls' OUTER faces, intersected corner by
//      corner (the roof sits on the outside of the walls — this is what the
//      existing free-walls engine expects as "the contour").
// Per-edge overhang requests come from roofOverhang relations. The RoofModel
// side (state.ts 'adoptParametricSketch') owns everything after this.
import type { Pt, SketchDoc, WallObject } from './model'
import { lineById, objectById, pointById } from './model'
import { bodyFaces, lineSeg, outerSign } from './objects'
import { lineIntersection, signedArea } from './geom'

export interface RoofDerivation {
  ok: true
  source: 'roofOutline' | 'exteriorWalls'
  /** CCW ring, no repeated closing point. */
  ring: Pt[]
  /** Object ids the roof rests on (walls on the ring + bearing members). */
  supports: string[]
  /** Per ring edge (edge k = ring[k]→ring[k+1]): the wall object it comes
   *  from (exteriorWalls source) or null. */
  edgeWalls: (string | null)[]
  /** Per ring edge: overhang requested by a roofOverhang relation, or null. */
  edgeOverhangM: (number | null)[]
}

export type RoofDerivationResult = RoofDerivation | { ok: false; message: string }

/** Union-find over point ids merged by coincident constraints, so a loop
 *  drawn with "coincident" joints (not shared ids) still closes. */
function pointClasses(doc: SketchDoc): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  for (const p of doc.points) parent.set(p.id, p.id)
  for (const c of doc.constraints) {
    if (c.kind !== 'coincident') continue
    const a = find(c.p)
    const b = find(c.q)
    if (a !== b) parent.set(a, b)
  }
  const out = new Map<string, string>()
  for (const p of doc.points) out.set(p.id, find(p.id))
  return out
}

/** Order a set of lines into one closed loop (by shared endpoints). Null
 *  when they do not form exactly one simple loop. */
export function orderLoop(doc: SketchDoc, lineIds: readonly string[]): string[] | null {
  if (lineIds.length < 3) return null
  const cls = pointClasses(doc)
  const ends = new Map<string, [string, string]>()
  for (const id of lineIds) {
    const l = lineById(doc, id)
    if (!l) return null
    ends.set(id, [cls.get(l.a) ?? l.a, cls.get(l.b) ?? l.b])
  }
  const degree = new Map<string, number>()
  for (const [a, b] of ends.values()) {
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  for (const d of degree.values()) if (d !== 2) return null
  const remaining = new Set(lineIds)
  const first = lineIds[0]!
  const order = [first]
  remaining.delete(first)
  let cursor = ends.get(first)![1]
  const start = ends.get(first)![0]
  while (remaining.size > 0) {
    let found: string | null = null
    for (const id of remaining) {
      const [a, b] = ends.get(id)!
      if (a === cursor || b === cursor) {
        found = id
        cursor = a === cursor ? b : a
        break
      }
    }
    if (!found) return null
    order.push(found)
    remaining.delete(found)
  }
  return cursor === start ? order : null
}

function ringFromLoop(doc: SketchDoc, loop: readonly string[]): Pt[] | null {
  const cls = pointClasses(doc)
  const ring: Pt[] = []
  let cursor: string | null = null
  for (let i = 0; i < loop.length; i++) {
    const l = lineById(doc, loop[i]!)
    if (!l) return null
    const a = cls.get(l.a) ?? l.a
    const b = cls.get(l.b) ?? l.b
    let startId: string
    if (cursor === null) {
      // Orient the first line so that it connects to the second one.
      const n = lineById(doc, loop[1]!)
      const nA = n ? cls.get(n.a) ?? n.a : ''
      const nB = n ? cls.get(n.b) ?? n.b : ''
      startId = b === nA || b === nB ? l.a : l.b
    } else {
      startId = a === cursor ? l.a : l.b
    }
    const p = pointById(doc, startId)
    if (!p) return null
    ring.push({ x: p.x, y: p.y })
    cursor = cls.get(startId === l.a ? l.b : l.a) ?? (startId === l.a ? l.b : l.a)
  }
  return ring
}

function exteriorWalls(doc: SketchDoc): WallObject[] {
  return doc.objects.filter((o): o is WallObject => o.kind === 'wall' && o.wallType === 'exterior')
}

function overhangFor(doc: SketchDoc, wallId: string): number | null {
  const r = doc.relations.find((x) => x.kind === 'roofOverhang' && x.wall === wallId)
  return r && r.kind === 'roofOverhang' ? r.overhangM : null
}

function bearingSupports(doc: SketchDoc): string[] {
  return doc.objects.filter((o) => o.role === 'bearing' && (o.kind === 'wall' || o.kind === 'column' || o.kind === 'beam')).map((o) => o.id)
}

export function deriveRoof(doc: SketchDoc): RoofDerivationResult {
  const outline = doc.objects.find((o) => o.kind === 'roofOutline')
  if (outline && outline.kind === 'roofOutline') {
    const loop = orderLoop(doc, outline.lines)
    if (!loop) return { ok: false, message: 'מתאר הגג אינו לולאה סגורה אחת' }
    let ring = ringFromLoop(doc, loop)
    if (!ring) return { ok: false, message: 'מתאר הגג חסר נקודות' }
    if (signedArea(ring) < 0) ring = ring.reverse()
    const supports = [...new Set(bearingSupports(doc))]
    return {
      ok: true,
      source: 'roofOutline',
      ring,
      supports,
      edgeWalls: ring.map(() => null),
      edgeOverhangM: ring.map(() => null),
    }
  }
  const walls = exteriorWalls(doc)
  if (walls.length < 3) return { ok: false, message: 'נדרשים לפחות שלושה קירות חוץ סגורים (או מתאר גג) כדי לבנות גג' }
  const loop = orderLoop(doc, walls.map((w) => w.line))
  if (!loop) return { ok: false, message: 'קירות החוץ אינם סוגרים לולאה אחת — חבר את הפינות' }
  const wallByLine = new Map(walls.map((w) => [w.line, w] as const))
  // Walk the loop and intersect consecutive OUTER faces.
  const orderedWalls = loop.map((l) => wallByLine.get(l)!)
  const faces = orderedWalls.map((w) => {
    const f = bodyFaces(doc, w)
    const sign = outerSign(doc, w)
    const seg = f ? (sign > 0 ? f.faceA : f.faceB) : lineSeg(doc, w.line)!
    return seg
  })
  const n = faces.length
  const ring: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = faces[(i - 1 + n) % n]!
    const cur = faces[i]!
    const x = lineIntersection(prev.a, prev.b, cur.a, cur.b)
    if (!x) return { ok: false, message: `קירות ${orderedWalls[(i - 1 + n) % n]!.name} ו-${orderedWalls[i]!.name} מקבילים — אין פינה ביניהם` }
    ring.push(x)
  }
  // ring[i] is the corner BETWEEN wall i-1 and wall i, so edge i (ring[i]→ring[i+1]) is wall i.
  let order = orderedWalls
  let finalRing = ring
  if (signedArea(ring) < 0) {
    finalRing = [...ring].reverse()
    // Reversing the ring: edge k of the reversed ring is wall (n-1-k) ... rotate so edges line up.
    // reversed ring: r'[k] = ring[n-1-k]; edge k = ring[n-1-k]→ring[n-2-k] = wall (n-2-k) reversed.
    order = ring.map((_, k) => orderedWalls[(n - 2 - k + n) % n]!)
  }
  const supports = [...new Set([...order.map((w) => w.id), ...bearingSupports(doc)])]
  return {
    ok: true,
    source: 'exteriorWalls',
    ring: finalRing,
    supports,
    edgeWalls: order.map((w) => w.id),
    edgeOverhangM: order.map((w) => overhangFor(doc, w.id)),
  }
}

/** Human-readable support list for the roof panel ("הגג נשען על: ק1, ק2, ע1 …"). */
export function supportNames(doc: SketchDoc, supports: readonly string[]): string[] {
  return supports.map((id) => objectById(doc, id)?.name ?? id)
}
