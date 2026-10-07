// PARAMETRIC SKETCH ↔ ROOF MODEL integration (owner brief 2026-10-07 §6/§7):
// the sketch document persists on the roof snapshot, and building the roof
// from the sketch adopts its footprint through the free-walls path, keeping
// edge kinds + applying per-edge overhang requests.
import { beforeAll, describe, expect, it } from 'vitest'
import { emptyDoc, type SketchDoc } from '../parametric/model'
import { sketchReducer } from '../parametric/doc'
import { deriveRoof } from '../parametric/roofBridge'
import { restoreSnapshot, toSnapshot } from './persist'
import { initRoofModel, roofReducer } from './state'
import { initEngine } from './engine/skeleton'
import { undoableRoofReducer } from './history'
import { initHistory } from './history'

function sketchWithBuilding(): SketchDoc {
  let d = emptyDoc()
  const add = (a: { x: number; y: number } | { pointId: string }, b: { x: number; y: number } | { pointId: string }, auto: 'horizontal' | 'vertical') => {
    d = sketchReducer(d, { kind: 'addLine', a, b, auto: [auto], as: { kind: 'wall', wallType: 'exterior', lineIs: 'faceB' } })
  }
  add({ x: 0, y: 0 }, { x: 10, y: 0 }, 'horizontal')
  add({ pointId: d.lines[0]!.b }, { x: 10, y: 6 }, 'vertical')
  add({ pointId: d.lines[1]!.b }, { x: 0, y: 6 }, 'horizontal')
  add({ pointId: d.lines[2]!.b }, { pointId: d.lines[0]!.a }, 'vertical')
  const w1 = d.objects[0]!.id
  d = sketchReducer(d, { kind: 'addLine', a: { x: -1, y: -0.6 }, b: { x: 11, y: -0.6 }, as: { kind: 'roofEdge', edgeType: 'eave' } })
  const edge = d.objects[d.objects.length - 1]!.id
  d = sketchReducer(d, { kind: 'addRelation', relation: { kind: 'roofOverhang', roofEdge: edge, wall: w1, overhangM: 0.6 } })
  return d
}

describe('adoptParametricSketch', () => {
  beforeAll(async () => {
    await initEngine()
  })

  it('stores the sketch and adopts the derived footprint as a free contour with per-edge overhangs', () => {
    const doc = sketchWithBuilding()
    const der = deriveRoof(doc)
    expect(der.ok).toBe(true)
    if (!der.ok) return
    const m0 = roofReducer(initRoofModel('gable'), { kind: 'engineReady' })
    const m1 = roofReducer(m0, { kind: 'adoptParametricSketch', doc, contour: der.ring, edgeOverhangM: der.edgeOverhangM, slopePct: 35 })
    expect(m1.parametricSketch).toBe(doc)
    expect(m1.templateId).toBe('free')
    expect(m1.freeWalls?.length).toBe(4)
    expect(m1.contour.length).toBe(4)
    expect(m1.slopePct).toBe(35)
    // Outer-face ring: the sketch lines ARE the outer faces (lineIs faceB on a CCW loop) → 10 × 6.
    const xs = m1.contour.map((p) => p.x)
    const ys = m1.contour.map((p) => p.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 6)
    // The overhang request landed on exactly one edge; the others keep the global default.
    const overs = (m1.edgeAttrs ?? []).map((e) => e.overhangM)
    expect(overs.filter((o) => Math.abs(o - 0.6) < 1e-9).length).toBe(1)
    expect(overs.filter((o) => Math.abs(o - m0.overhangM) < 1e-9).length).toBe(3)
    expect(m1.centerlines.length).toBeGreaterThan(0)
  })

  it('keeps eave/gable kinds across a re-adopt with the same wall count', () => {
    const doc = sketchWithBuilding()
    const der = deriveRoof(doc)
    if (!der.ok) throw new Error('derivation failed')
    let m = roofReducer(initRoofModel('gable'), { kind: 'engineReady' })
    m = roofReducer(m, { kind: 'adoptParametricSketch', doc, contour: der.ring, edgeOverhangM: der.edgeOverhangM })
    // Make a SHORT end (6 m) a gable — a triangular end face the engine
    // keeps realizing after the long side is widened.
    const n = m.contour.length
    const gableEdge = m.contour.findIndex((p, k) => {
      const q = m.contour[(k + 1) % n]!
      return Math.abs(Math.hypot(q.x - p.x, q.y - p.y) - 6) < 1e-6
    })
    expect(gableEdge).toBeGreaterThanOrEqual(0)
    m = roofReducer(m, { kind: 'setEdgeKind', edgeIndex: gableEdge, value: 'gable' })
    expect(m.edgeAttrs?.[gableEdge]?.kind).toBe('gable')
    // Widen the sketch, re-adopt: same edge count, the gable survives.
    const lenLine = doc.lines[0]!.id
    const wider = sketchReducer(sketchReducer(doc, { kind: 'addConstraint', c: { kind: 'fixed', p: doc.lines[0]!.a, x: 0, y: 0 } }), {
      kind: 'addDimension',
      dim: { kind: 'length', refs: [lenLine], driving: true },
      value: 14,
    })
    const der2 = deriveRoof(wider)
    if (!der2.ok) throw new Error('derivation failed')
    const m2 = roofReducer(m, { kind: 'adoptParametricSketch', doc: wider, contour: der2.ring, edgeOverhangM: der2.edgeOverhangM })
    expect(m2.edgeAttrs?.[gableEdge]?.kind).toBe('gable')
    const xs = m2.contour.map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(14, 6)
  })

  it('round-trips through the roof snapshot and is transparent in the wizard undo ring', () => {
    const doc = sketchWithBuilding()
    const m = roofReducer(initRoofModel('gable'), { kind: 'setParametricSketch', doc })
    const snap = toSnapshot(m)
    const back = restoreSnapshot(snap)
    expect(back.model?.parametricSketch?.objects.length).toBe(doc.objects.length)
    expect(back.model?.parametricSketch?.relations.length).toBe(1)
    // Transparent: no undo step for a sketch autosave.
    const h0 = initHistory(initRoofModel('gable'))
    const h1 = undoableRoofReducer(h0, { kind: 'setParametricSketch', doc })
    expect(h1.past.length).toBe(0)
    expect(h1.present.parametricSketch).toBe(doc)
    // A snapshot with a corrupt sketch field is refused as a whole (shape guard).
    const bad = { ...snap, model: { ...snap.model, parametricSketch: 'nope' } }
    expect(restoreSnapshot(bad).model).toBeNull()
  })
})
