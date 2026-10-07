import { describe, expect, it } from 'vitest'
import { analyze } from './analysis'
import { emptyDoc, type Constraint, type SketchDoc, type SketchLine, type SketchPoint } from './model'
import { solve } from './solver'

function docWith(points: SketchPoint[], lines: SketchLine[], constraints: Constraint[]): SketchDoc {
  return { ...emptyDoc(), points, lines, constraints }
}

const P = (id: string, x: number, y: number): SketchPoint => ({ id, x, y })
const L = (id: string, a: string, b: string): SketchLine => ({ id, a, b })

/** A 8×6 rectangle: p1(0,0) p2(8,0) p3(8,6) p4(0,6), lines l1..l4. */
function rectDoc(): SketchDoc {
  return docWith(
    [P('p1', 0, 0), P('p2', 8, 0), P('p3', 8, 6), P('p4', 0, 6)],
    [L('l1', 'p1', 'p2'), L('l2', 'p2', 'p3'), L('l3', 'p3', 'p4'), L('l4', 'p4', 'p1')],
    [
      { id: 'c1', kind: 'fixed', p: 'p1', x: 0, y: 0 },
      { id: 'c2', kind: 'horizontal', line: 'l1' },
      { id: 'c3', kind: 'vertical', line: 'l2' },
      { id: 'c4', kind: 'horizontal', line: 'l3' },
      { id: 'c5', kind: 'vertical', line: 'l4' },
      { id: 'd1', kind: 'length', line: 'l1', valueM: 8 },
      { id: 'd2', kind: 'length', line: 'l2', valueM: 6 },
    ],
  )
}

describe('parametric solver', () => {
  it('a consistent sketch solves with zero residual and keeps positions', () => {
    const r = solve({ doc: rectDoc() })
    expect(r.ok).toBe(true)
    expect(r.points.get('p3')).toEqual({ x: expect.closeTo(8, 6), y: expect.closeTo(6, 6) })
  })

  it('changing a driving dimension moves the dependent corners and keeps every relation', () => {
    const d = rectDoc()
    d.constraints = d.constraints.map((c) => (c.id === 'd1' ? { ...c, valueM: 10 } : c))
    const r = solve({ doc: d })
    expect(r.ok).toBe(true)
    const p2 = r.points.get('p2')!
    const p3 = r.points.get('p3')!
    const p4 = r.points.get('p4')!
    expect(p2.x).toBeCloseTo(10, 6)
    expect(p2.y).toBeCloseTo(0, 6)
    expect(p3.x).toBeCloseTo(10, 6)
    expect(p3.y).toBeCloseTo(6, 6)
    expect(p4.x).toBeCloseTo(0, 6)
    expect(p4.y).toBeCloseTo(6, 6)
  })

  it('a contradicting dimension is reported as a conflict, nothing silently dropped', () => {
    const d = rectDoc()
    // l3 is parallel to l1 and spans the same x-range, so its length must be 8.
    d.constraints.push({ id: 'd3', kind: 'length', line: 'l3', valueM: 9 })
    const r = solve({ doc: d })
    expect(r.ok).toBe(false)
    expect(r.conflicts.length).toBeGreaterThan(0)
    expect(r.conflicts).toContain('d3')
    const an = analyze(d, r)
    expect(an.conflicts).toContain('d3')
    expect(an.status.get('d3')).toBe('conflict')
  })

  it('DOF: the fixed+dimensioned rectangle is fully defined, an open sketch is free', () => {
    const d = rectDoc()
    const r = solve({ doc: d })
    const an = analyze(d, r)
    expect(an.dof).toBe(0)
    expect(an.freePoints.size).toBe(0)
    expect(an.definedPoints.size).toBe(4)

    const open = rectDoc()
    open.constraints = open.constraints.filter((c) => c.id !== 'd2')
    const r2 = solve({ doc: open })
    const an2 = analyze(open, r2)
    expect(an2.dof).toBe(1)
    expect(an2.freePoints.has('p3')).toBe(true)
    expect(an2.freePoints.has('p4')).toBe(true)
    expect(an2.definedPoints.has('p1')).toBe(true)
    expect(an2.definedPoints.has('p2')).toBe(true)
  })

  it('a redundant (consistent) constraint is flagged redundant, not conflict', () => {
    const d = rectDoc()
    d.constraints.push({ id: 'r1', kind: 'parallel', a: 'l1', b: 'l3' })
    const r = solve({ doc: d })
    expect(r.ok).toBe(true)
    const an = analyze(d, r)
    expect(an.redundant.length).toBeGreaterThan(0)
    expect(an.conflicts).toEqual([])
  })

  it('midpoint + pointOnLine + pointLineDistance keep a column centered and offset', () => {
    const d = rectDoc()
    d.points.push(P('c', 3, 1), P('m', 1, 1))
    d.constraints.push(
      { id: 'mid', kind: 'midpoint', p: 'm', line: 'l1' },
      { id: 'cen', kind: 'centered', p: 'c', a: 'l4', b: 'l2' },
      { id: 'off', kind: 'pointLineDistance', p: 'c', line: 'l1', valueM: 2, offsetM: 0.1 },
    )
    const r = solve({ doc: d })
    expect(r.ok).toBe(true)
    expect(r.points.get('m')!.x).toBeCloseTo(4, 6)
    expect(r.points.get('c')!.x).toBeCloseTo(4, 5)
    expect(r.points.get('c')!.y).toBeCloseTo(2.1, 6)
    // widen: the column follows the center.
    d.constraints = d.constraints.map((c) => (c.id === 'd1' ? { ...c, valueM: 12 } : c))
    const r2 = solve({ doc: d })
    expect(r2.ok).toBe(true)
    expect(r2.points.get('c')!.x).toBeCloseTo(6, 5)
  })

  it('drag: a fully-defined point refuses to follow the cursor; a free one follows', () => {
    const d = rectDoc()
    const r = solve({ doc: d, drag: new Map([['p3', { x: 20, y: 20 }]]) })
    expect(r.ok).toBe(true)
    expect(r.points.get('p3')!.x).toBeCloseTo(8, 5)
    const open = rectDoc()
    open.constraints = open.constraints.filter((c) => c.id !== 'd2')
    const r2 = solve({ doc: open, drag: new Map([['p3', { x: 8, y: 9 }]]) })
    expect(r2.ok).toBe(true)
    expect(r2.points.get('p3')!.y).toBeCloseTo(9, 3)
    expect(r2.points.get('p4')!.y).toBeCloseTo(9, 3)
  })

  it('pinned points (locked objects) hold and conflict honestly against a dimension', () => {
    const d = rectDoc()
    d.constraints = d.constraints.map((c) => (c.id === 'd1' ? { ...c, valueM: 9 } : c))
    const r = solve({ doc: d, pinned: new Set(['p2']) })
    expect(r.ok).toBe(false)
    expect(r.conflicts).toContain('d1')
  })

  it('angle, equalLength, symmetric, equalDistance, perpendicular, collinear converge', () => {
    const d = docWith(
      [P('a', 0, 0), P('b', 4, 0.2), P('c', 4, 3), P('e', 1, 1), P('f', 3, 1.5), P('g', 2, -1), P('h', 2, 4)],
      [L('l1', 'a', 'b'), L('l2', 'b', 'c'), L('ax', 'g', 'h'), L('l3', 'e', 'f')],
      [
        { id: 'f1', kind: 'fixed', p: 'a', x: 0, y: 0 },
        { id: 'h1', kind: 'horizontal', line: 'l1' },
        { id: 'an', kind: 'angle', a: 'l1', b: 'l2', valueDeg: 90 },
        { id: 'eq', kind: 'equalLength', a: 'l1', b: 'l2' },
        { id: 'ln', kind: 'length', line: 'l1', valueM: 5 },
        { id: 'sym', kind: 'symmetric', p: 'e', q: 'f', axis: 'ax' },
        { id: 'vax', kind: 'vertical', line: 'ax' },
        { id: 'perp', kind: 'perpendicular', a: 'ax', b: 'l1' },
        { id: 'ed', kind: 'equalDistance', p: 'a', q: 'g', r: 'g', s: 'b' },
        { id: 'col', kind: 'pointOnLine', p: 'g', line: 'l1' },
      ],
    )
    const r = solve({ doc: d })
    expect(r.ok).toBe(true)
    expect(r.points.get('b')!.x).toBeCloseTo(5, 5)
    expect(r.points.get('c')!.y).toBeCloseTo(5, 5)
    expect(r.points.get('g')!.x).toBeCloseTo(2.5, 5)
    const e = r.points.get('e')!
    const f = r.points.get('f')!
    expect((e.x + f.x) / 2).toBeCloseTo(2.5, 5)
    expect(e.y).toBeCloseTo(f.y, 5)
  })
})
