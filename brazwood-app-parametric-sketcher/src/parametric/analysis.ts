// src/parametric/analysis.ts
// DEGREES-OF-FREEDOM + CONFLICT ANALYSIS (owner brief §4: "להציג מה עדיין
// חופשי לזוז ומה מוגדר במלואו … לזהות אילוצים סותרים ולהדגיש את האובייקטים
// והיחסים המעורבים"). Pure. Works on the solver's compiled system at the
// CURRENT positions:
//   - rank of the Jacobian → remaining DOF (n − rank);
//   - null space → which POINTS can still move (any nonzero component);
//   - row dependence → REDUNDANT constraints (consistent but over-defining);
//   - solver residuals → CONFLICTING constraints (cannot all hold).
import type { Pt, SketchDoc } from './model'
import { constraintRefs, lineById, objectLineIds, objectPointIds } from './model'
import { nullSpace, rref, transpose } from './linalg'
import { compile, jacobian, type SolveResult } from './solver'

export type ConstraintStatus = 'ok' | 'redundant' | 'conflict'

export interface SketchAnalysis {
  /** Remaining degrees of freedom of the whole sketch (rigid-body motions
   *  included — an unpinned sketch always keeps at least 3 until a point is
   *  fixed). */
  dof: number
  /** Point ids that can still move. */
  freePoints: Set<string>
  /** Point ids that are fully defined. */
  definedPoints: Set<string>
  status: Map<string, ConstraintStatus>
  /** Constraint ids in conflict (from the solve). */
  conflicts: string[]
  /** Constraint ids that are redundant (dependent rows, no residual). */
  redundant: string[]
  /** Object ids that touch a conflicting constraint — for highlighting. */
  conflictObjects: Set<string>
  /** Structural-relation ids whose compiled constraints are in conflict. */
  conflictRelations: Set<string>
}

/** Map constraint ids back to the relation that compiled them (relations.ts
 *  mints constraint ids as `${relationId}~k`). */
export function relationOfConstraint(cid: string): string | null {
  const i = cid.indexOf('~')
  return i > 0 ? cid.slice(0, i) : null
}

export function analyze(doc: SketchDoc, solved: SolveResult, pinned?: ReadonlySet<string>, positions?: ReadonlyMap<string, Pt>): SketchAnalysis {
  const system = compile(doc, pinned)
  const { n, hard, pointIds } = system
  const v = new Float64Array(n)
  doc.points.forEach((p, i) => {
    const q = positions?.get(p.id) ?? solved.points.get(p.id) ?? p
    v[2 * i] = q.x
    v[2 * i + 1] = q.y
  })
  const J = jacobian(hard, v, n)
  const freePoints = new Set<string>()
  const definedPoints = new Set<string>()
  let dof = n
  if (hard.length > 0 && n > 0) {
    const ns = nullSpace(J, n, 1e-8)
    dof = ns.length
    pointIds.forEach((pid, i) => {
      const moves = ns.some((vec) => Math.abs(vec[2 * i]!) > 1e-7 || Math.abs(vec[2 * i + 1]!) > 1e-7)
      if (moves) freePoints.add(pid)
      else definedPoints.add(pid)
    })
  } else {
    for (const pid of pointIds) freePoints.add(pid)
  }

  // Row dependence: rank-revealing on Jᵀ (columns = equations). A non-pivot
  // column is an equation linearly dependent on the ones before it.
  const redundantSet = new Set<string>()
  if (hard.length > 0 && n > 0) {
    const JT = transpose(J, n)
    const { pivots } = rref(JT, hard.length, 1e-8)
    const pivotSet = new Set(pivots)
    hard.forEach((eq, i) => {
      if (!pivotSet.has(i)) redundantSet.add(eq.cid)
    })
  }
  const conflicts = solved.conflicts.filter((c) => !c.startsWith('pin:'))
  const conflictSet = new Set(solved.conflicts)
  const status = new Map<string, ConstraintStatus>()
  const redundant: string[] = []
  for (const c of doc.constraints) {
    if (conflictSet.has(c.id)) status.set(c.id, 'conflict')
    else if (redundantSet.has(c.id)) {
      status.set(c.id, 'redundant')
      redundant.push(c.id)
    } else status.set(c.id, 'ok')
  }

  // Objects touching a conflicting constraint (through their points/lines).
  const conflictGeom = new Set<string>()
  for (const c of doc.constraints) {
    if (!conflictSet.has(c.id)) continue
    for (const ref of constraintRefs(c)) {
      conflictGeom.add(ref)
      const l = lineById(doc, ref)
      if (l) {
        conflictGeom.add(l.a)
        conflictGeom.add(l.b)
      }
    }
  }
  for (const pid of solved.conflicts) {
    if (pid.startsWith('pin:')) conflictGeom.add(pid.slice(4))
  }
  const conflictObjects = new Set<string>()
  for (const o of doc.objects) {
    const ids = [...objectPointIds(doc, o), ...objectLineIds(o)]
    if (ids.some((id) => conflictGeom.has(id))) conflictObjects.add(o.id)
  }
  const conflictRelations = new Set<string>()
  for (const cid of solved.conflicts) {
    const rid = relationOfConstraint(cid)
    if (rid && doc.relations.some((r) => r.id === rid)) conflictRelations.add(rid)
  }

  return { dof, freePoints, definedPoints, status, conflicts, redundant, conflictObjects, conflictRelations }
}
