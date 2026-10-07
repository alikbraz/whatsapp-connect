// Owner brief §7 — the full flow, end to end, on the pure core:
// exterior walls → interior wall → columns → bearing beam → dimensions and
// relations → roof derivation; then: change a dimension / an angle and
// verify structure + roof follow the relations; contradiction detection;
// undo/redo; save and reopen.
import { describe, expect, it } from 'vitest'
import { initHistory, undoable } from '../roofwizard/history'
import { evaluate, movedObjects, sketchReducer, type SketchAction } from './doc'
import { emptyDoc, objectById, pointById, type SketchDoc } from './model'
import { parseDoc, restoreDoc, serializeDoc } from './persist'
import { deriveRoof } from './roofBridge'
import { signedArea } from './geom'

const reduce = (doc: SketchDoc, ...actions: SketchAction[]): SketchDoc => actions.reduce(sketchReducer, doc)

const lastObject = (doc: SketchDoc) => doc.objects[doc.objects.length - 1]!

/** Build the scenario: a 10×6 building, exterior walls on the outer face
 *  (lineIs faceB → body to the left/inside of a CCW loop). */
function buildScenario(): { doc: SketchDoc; ids: Record<string, string> } {
  const ids: Record<string, string> = {}
  let doc = emptyDoc()
  // Exterior walls, CCW: (0,0)→(10,0)→(10,6)→(0,6)→back. Drawn with shared points.
  doc = reduce(doc, { kind: 'addLine', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, auto: ['horizontal'], as: { kind: 'wall', wallType: 'exterior', lineIs: 'faceB' } })
  ids.w1 = lastObject(doc).id
  const l1 = doc.lines[0]!
  doc = reduce(doc, { kind: 'addLine', a: { pointId: l1.b }, b: { x: 10, y: 6 }, auto: ['vertical'], as: { kind: 'wall', wallType: 'exterior', lineIs: 'faceB' } })
  ids.w2 = lastObject(doc).id
  const l2 = doc.lines[1]!
  doc = reduce(doc, { kind: 'addLine', a: { pointId: l2.b }, b: { x: 0, y: 6 }, auto: ['horizontal'], as: { kind: 'wall', wallType: 'exterior', lineIs: 'faceB' } })
  ids.w3 = lastObject(doc).id
  const l3 = doc.lines[2]!
  doc = reduce(doc, { kind: 'addLine', a: { pointId: l3.b }, b: { pointId: l1.a }, auto: ['vertical'], as: { kind: 'wall', wallType: 'exterior', lineIs: 'faceB' } })
  ids.w4 = lastObject(doc).id
  ids.l1 = l1.id
  ids.l2 = l2.id
  ids.l3 = l3.id
  ids.l4 = doc.lines[3]!.id
  ids.p1 = l1.a
  ids.p2 = l1.b
  ids.p3 = l2.b
  ids.p4 = l3.b
  // Fix the origin corner and dimension the two sides (driving).
  doc = reduce(doc, { kind: 'addConstraint', c: { kind: 'fixed', p: ids.p1, x: 0, y: 0 } })
  doc = reduce(doc, { kind: 'addDimension', dim: { kind: 'length', refs: [ids.l1], driving: true }, value: 10 })
  ids.dLen = doc.dimensions[doc.dimensions.length - 1]!.id
  doc = reduce(doc, { kind: 'addDimension', dim: { kind: 'length', refs: [ids.l2], driving: true }, value: 6 })
  ids.dWid = doc.dimensions[doc.dimensions.length - 1]!.id
  // Interior wall: a vertical wall at x=4, parallel to w4 at a fixed distance (relation offsetFromWall).
  doc = reduce(doc, { kind: 'addLine', a: { x: 4, y: 0 }, b: { x: 4, y: 6 }, as: { kind: 'wall', wallType: 'interior', thicknessM: 0.15 } })
  ids.wInt = lastObject(doc).id
  const lInt = doc.lines[4]!
  ids.lInt = lInt.id
  doc = reduce(doc, { kind: 'addConstraint', c: { kind: 'pointOnLine', p: lInt.a, line: ids.l1 } })
  doc = reduce(doc, { kind: 'addConstraint', c: { kind: 'pointOnLine', p: lInt.b, line: ids.l3 } })
  doc = reduce(doc, { kind: 'addRelation', relation: { kind: 'offsetFromWall', target: ids.wInt, wall: ids.w4, ref: 'faceA', distM: 4 } })
  ids.rInt = doc.relations[doc.relations.length - 1]!.id
  // Columns: one at the corner of w1/w2 (inside), one centered between w2 and the interior wall.
  doc = reduce(doc, { kind: 'addColumn', at: { x: 9.5, y: 0.5 } })
  ids.cCorner = lastObject(doc).id
  doc = reduce(doc, { kind: 'addRelation', relation: { kind: 'columnAtCorner', column: ids.cCorner, wallA: ids.w1, wallB: ids.w2, refA: 'faceA', refB: 'faceA', distA: 0.2, distB: 0.2 } })
  ids.rCorner = doc.relations[doc.relations.length - 1]!.id
  doc = reduce(doc, { kind: 'addColumn', at: { x: 7, y: 3 } })
  ids.cMid = lastObject(doc).id
  const cMid = objectById(doc, ids.cMid)!
  if (cMid.kind !== 'column') throw new Error('column expected')
  ids.cMidPt = cMid.point
  doc = reduce(doc, { kind: 'addConstraint', c: { kind: 'centered', p: ids.cMidPt, a: ids.l2, b: ids.lInt } })
  doc = reduce(doc, { kind: 'addConstraint', c: { kind: 'centered', p: ids.cMidPt, a: ids.l1, b: ids.l3 } })
  // Bearing beam from the corner column to the middle column.
  doc = reduce(doc, { kind: 'addLine', a: { x: 9.5, y: 0.5 }, b: { x: 7, y: 3 }, as: { kind: 'beam' } })
  ids.beam = lastObject(doc).id
  doc = reduce(doc, { kind: 'addRelation', relation: { kind: 'beamBetween', beam: ids.beam, supportA: ids.cCorner, supportB: ids.cMid } })
  ids.rBeam = doc.relations[doc.relations.length - 1]!.id
  // A roof overhang request on w1 (0.5 m) via a roof edge line.
  doc = reduce(doc, { kind: 'addLine', a: { x: -1, y: -0.5 }, b: { x: 11, y: -0.5 }, as: { kind: 'roofEdge', edgeType: 'eave' } })
  ids.edge = lastObject(doc).id
  doc = reduce(doc, { kind: 'addRelation', relation: { kind: 'roofOverhang', roofEdge: ids.edge, wall: ids.w1, overhangM: 0.5 } })
  return { doc, ids }
}

describe('parametric scenario (owner brief §7)', () => {
  it('builds the full flow with every relation satisfied', () => {
    const { doc, ids } = buildScenario()
    const ev = evaluate(doc)
    expect(ev.solved.ok).toBe(true)
    expect(ev.analysis.conflicts).toEqual([])
    expect(ev.issues).toEqual([])
    // Corner column: 0.2 m inside both faces (w1 thickness 0.25, line is faceB → faceA is +0.25).
    const pc = pointById(doc, (objectById(doc, ids.cCorner) as { point: string }).point)!
    expect(pc.y).toBeCloseTo(0.25 + 0.2, 6)
    expect(pc.x).toBeCloseTo(10 - 0.25 - 0.2, 6)
    // Interior wall line 4 m from w4's faceA (w4 runs (0,6)→(0,0); faceA = left = +x side; 0.25 + 4).
    const lInt = doc.lines.find((l) => l.id === ids.lInt)!
    expect(pointById(doc, lInt.a)!.x).toBeCloseTo(4.25, 6)
    // Middle column centered between w2's line (x=10) and the interior line (x=4.25), and between y=0 and y=6.
    const pm = pointById(doc, ids.cMidPt)!
    expect(pm.x).toBeCloseTo((10 + 4.25) / 2, 5)
    expect(pm.y).toBeCloseTo(3, 5)
    // Beam ends sit on both columns and the beam records its supports.
    const beam = objectById(doc, ids.beam)!
    if (beam.kind !== 'beam') throw new Error('beam expected')
    expect(beam.supports.sort()).toEqual([ids.cCorner, ids.cMid].sort())
    const bl = doc.lines.find((l) => l.id === beam.line)!
    expect(pointById(doc, bl.a)).toMatchObject({ x: expect.closeTo(pc.x, 6), y: expect.closeTo(pc.y, 6) })
    expect(pointById(doc, bl.b)).toMatchObject({ x: expect.closeTo(pm.x, 6), y: expect.closeTo(pm.y, 6) })
    // Roof edge 0.5 m outside w1's outer face (faceB == the sketch line at y=0 → y = -0.5).
    const edge = objectById(doc, ids.edge)!
    if (edge.kind !== 'roofEdge') throw new Error('edge expected')
    const el = doc.lines.find((l) => l.id === edge.line)!
    expect(pointById(doc, el.a)!.y).toBeCloseTo(-0.5, 6)
    expect(pointById(doc, el.b)!.y).toBeCloseTo(-0.5, 6)
  })

  it('derives the roof ring from the exterior walls with the overhang request per edge', () => {
    const { doc, ids } = buildScenario()
    const roof = deriveRoof(doc)
    expect(roof.ok).toBe(true)
    if (!roof.ok) return
    expect(roof.source).toBe('exteriorWalls')
    expect(roof.ring.length).toBe(4)
    expect(signedArea(roof.ring)).toBeCloseTo(60, 6)
    expect(roof.supports).toContain(ids.w1)
    expect(roof.supports).toContain(ids.beam)
    expect(roof.supports).toContain(ids.cCorner)
    const k = roof.edgeWalls.indexOf(ids.w1)
    expect(k).toBeGreaterThanOrEqual(0)
    expect(roof.edgeOverhangM[k]).toBe(0.5)
  })

  it('SUCCESS TEST: changing the width dimension updates walls, interior wall, columns, beam and roof — no relation lost', () => {
    const { doc, ids } = buildScenario()
    const next = sketchReducer(doc, { kind: 'setDimensionValue', id: ids.dLen, value: 14 })
    const ev = evaluate(next)
    expect(ev.solved.ok).toBe(true)
    expect(next.relations.length).toBe(doc.relations.length)
    expect(next.constraints.length).toBe(doc.constraints.length)
    // Walls: w2 moved to x=14.
    expect(pointById(next, ids.p2)!.x).toBeCloseTo(14, 6)
    expect(pointById(next, ids.p3)!.x).toBeCloseTo(14, 6)
    // Interior wall stayed at 4.25 (fixed distance from w4), parallel.
    const lInt = next.lines.find((l) => l.id === ids.lInt)!
    expect(pointById(next, lInt.a)!.x).toBeCloseTo(4.25, 6)
    expect(pointById(next, lInt.b)!.x).toBeCloseTo(4.25, 6)
    // Corner column followed the corner.
    const pc = pointById(next, (objectById(next, ids.cCorner) as { point: string }).point)!
    expect(pc.x).toBeCloseTo(14 - 0.45, 6)
    // Middle column stayed centered between w2 and the interior wall.
    expect(pointById(next, ids.cMidPt)!.x).toBeCloseTo((14 + 4.25) / 2, 5)
    // Beam still spans the two columns.
    const beam = objectById(next, ids.beam)!
    if (beam.kind !== 'beam') throw new Error('beam')
    const bl = next.lines.find((l) => l.id === beam.line)!
    expect(pointById(next, bl.a)!.x).toBeCloseTo(pc.x, 6)
    expect(pointById(next, bl.b)!.x).toBeCloseTo((14 + 4.25) / 2, 5)
    // Roof follows.
    const roof = deriveRoof(next)
    expect(roof.ok).toBe(true)
    if (roof.ok) expect(signedArea(roof.ring)).toBeCloseTo(14 * 6, 6)
    // Preview reports the affected objects honestly.
    const moved = movedObjects(doc, next)
    expect(moved).toContain(ids.w2)
    expect(moved).toContain(ids.cCorner)
    expect(moved).toContain(ids.cMid)
    expect(moved).toContain(ids.beam)
    expect(moved).not.toContain(ids.w4)
  })

  it('SUCCESS TEST: changing an angle keeps every relation', () => {
    const { doc, ids } = buildScenario()
    // Replace w2's 'vertical' with an angle dimension of 80° from w1, then skew.
    const vert = doc.constraints.find((c) => c.kind === 'vertical' && c.line === ids.l2)!
    let next = sketchReducer(doc, { kind: 'removeConstraint', id: vert.id })
    next = sketchReducer(next, { kind: 'addDimension', dim: { kind: 'angle', refs: [ids.l1, ids.l2], driving: true }, value: 80 })
    const ev = evaluate(next)
    expect(ev.solved.ok).toBe(true)
    const p2 = pointById(next, ids.p2)!
    const p3 = pointById(next, ids.p3)!
    const ang = (Math.atan2(p3.y - p2.y, p3.x - p2.x) * 180) / Math.PI
    expect(ang).toBeCloseTo(80, 5)
    expect(Math.hypot(p3.x - p2.x, p3.y - p2.y)).toBeCloseTo(6, 6)
    // Corner column still 0.2 m from both faces; beam still on both columns.
    const pc = pointById(next, (objectById(next, ids.cCorner) as { point: string }).point)!
    expect(pc.y).toBeCloseTo(0.45, 6)
    const beam = objectById(next, ids.beam)!
    if (beam.kind !== 'beam') throw new Error('beam')
    const bl = next.lines.find((l) => l.id === beam.line)!
    expect(pointById(next, bl.a)).toMatchObject({ x: expect.closeTo(pc.x, 6), y: expect.closeTo(pc.y, 6) })
    expect(deriveRoof(next).ok).toBe(true)
  })

  it('a contradicting dimension is kept, flagged, and the geometry stays at the last consistent state', () => {
    const { doc, ids } = buildScenario()
    // w3 is parallel to w1 across the same span: dimensioning it to 12 contradicts length(w1)=10.
    const next = sketchReducer(doc, { kind: 'addDimension', dim: { kind: 'length', refs: [ids.l3], driving: true }, value: 12 })
    expect(next.dimensions.length).toBe(doc.dimensions.length + 1) // kept, not dropped
    expect(next.constraints.length).toBe(doc.constraints.length + 1)
    // Geometry unchanged.
    expect(pointById(next, ids.p3)!.x).toBeCloseTo(10, 9)
    const ev = evaluate(next)
    expect(ev.solved.ok).toBe(false)
    expect(ev.analysis.conflicts.length).toBeGreaterThan(0)
    const newDim = next.dimensions[next.dimensions.length - 1]!
    expect(ev.analysis.status.get(newDim.constraintId!)).toBe('conflict')
    expect(ev.analysis.conflictObjects.has(ids.w3)).toBe(true)
    // Removing the offending dimension restores a consistent sketch — the user's choice, not the app's.
    const fixed = sketchReducer(next, { kind: 'removeDimension', id: newDim.id })
    expect(evaluate(fixed).solved.ok).toBe(true)
  })

  it('reports what is free and what is fully defined', () => {
    const { doc } = buildScenario()
    const ev = evaluate(doc)
    // The roof edge line's endpoints can still slide along the edge (its x is free); walls are defined.
    expect(ev.analysis.dof).toBeGreaterThan(0)
    const w1 = doc.objects.find((o) => o.kind === 'wall')!
    const l = doc.lines.find((x) => x.id === (w1 as { line: string }).line)!
    expect(ev.analysis.definedPoints.has(l.a)).toBe(true)
    expect(ev.analysis.definedPoints.has(l.b)).toBe(true)
  })

  it('undo / redo step through the edits', () => {
    const { doc, ids } = buildScenario()
    const r = undoable<SketchDoc, SketchAction>(sketchReducer)
    let h = initHistory(doc)
    h = r(h, { kind: 'setDimensionValue', id: ids.dLen, value: 12 })
    expect(pointById(h.present, ids.p2)!.x).toBeCloseTo(12, 6)
    h = r(h, { kind: 'undo' })
    expect(pointById(h.present, ids.p2)!.x).toBeCloseTo(10, 6)
    h = r(h, { kind: 'redo' })
    expect(pointById(h.present, ids.p2)!.x).toBeCloseTo(12, 6)
  })

  it('save and reopen keeps objects, dimensions and relations', () => {
    const { doc, ids } = buildScenario()
    const json = serializeDoc(doc)
    const back = parseDoc(json)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.doc.objects.length).toBe(doc.objects.length)
    expect(back.doc.relations.length).toBe(doc.relations.length)
    expect(back.doc.dimensions.length).toBe(doc.dimensions.length)
    const ev = evaluate(back.doc)
    expect(ev.solved.ok).toBe(true)
    // And still parametric after reopening.
    const next = sketchReducer(back.doc, { kind: 'setDimensionValue', id: ids.dLen, value: 11 })
    expect(pointById(next, ids.p2)!.x).toBeCloseTo(11, 6)
    // Garbage is refused, not silently replaced.
    expect(restoreDoc({ foo: 1 }).ok).toBe(false)
    expect(restoreDoc(undefined).ok).toBe(true)
  })

  it('locking an object pins it: a dimension that must move it conflicts instead of moving it', () => {
    const { doc, ids } = buildScenario()
    const locked = sketchReducer(doc, { kind: 'updateObject', id: ids.w2, patch: { locked: true } })
    const next = sketchReducer(locked, { kind: 'setDimensionValue', id: ids.dLen, value: 12 })
    expect(pointById(next, ids.p2)!.x).toBeCloseTo(10, 9)
    expect(evaluate(next).solved.ok).toBe(false)
  })

  it('divide: three columns evenly between two bounds, following a width change', () => {
    const { doc, ids } = buildScenario()
    let next = doc
    const cols: string[] = []
    for (const x of [2, 5, 8]) {
      next = sketchReducer(next, { kind: 'addColumn', at: { x, y: 5 } })
      cols.push(lastObject(next).id)
    }
    next = sketchReducer(next, { kind: 'addRelation', relation: { kind: 'divide', columns: cols, boundA: ids.p4, boundB: ids.p3, by: 'count' } })
    expect(evaluate(next).solved.ok).toBe(true)
    const xs = cols.map((id) => pointById(next, (objectById(next, id) as { point: string }).point)!.x)
    expect(xs[0]).toBeCloseTo(2.5, 5)
    expect(xs[1]).toBeCloseTo(5, 5)
    expect(xs[2]).toBeCloseTo(7.5, 5)
    const wider = sketchReducer(next, { kind: 'setDimensionValue', id: ids.dLen, value: 20 })
    const xs2 = cols.map((id) => pointById(wider, (objectById(wider, id) as { point: string }).point)!.x)
    expect(xs2[1]).toBeCloseTo(10, 5)
    expect(xs2[2]).toBeCloseTo(15, 5)
    // Removing the relation removes its guide line and leaves the columns free.
    const rid = next.relations[next.relations.length - 1]!.id
    const without = sketchReducer(wider, { kind: 'removeRelation', id: rid })
    expect(without.lines.some((l) => l.id.startsWith(rid))).toBe(false)
  })

  it('deleting a wall removes its openings and relations but never other objects', () => {
    const { doc, ids } = buildScenario()
    const withOpening = sketchReducer(doc, { kind: 'addOpening', wall: ids.w1, offsetM: 3, widthM: 1.2 })
    const opening = lastObject(withOpening)
    const next = sketchReducer(withOpening, { kind: 'removeObject', id: ids.w1 })
    expect(objectById(next, opening.id)).toBeUndefined()
    expect(next.relations.some((r) => r.id === ids.rCorner)).toBe(false)
    expect(objectById(next, ids.cCorner)).toBeDefined()
    expect(objectById(next, ids.beam)).toBeDefined()
  })
})
