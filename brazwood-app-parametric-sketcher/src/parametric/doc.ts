// src/parametric/doc.ts
// DOCUMENT OPERATIONS — the pure reducer the sketcher UI dispatches into
// (wrapped by roofwizard/history.ts's generic `undoable` for undo/redo).
// Every action ends in `settle`: relations are re-compiled, the solver runs,
// and positions are committed ONLY when every constraint holds. When they
// cannot (a contradiction), the doc keeps its LAST CONSISTENT geometry and
// keeps the offending constraint/relation IN the document, flagged by
// `evaluate` — never deleted, never silently altered (owner brief §4).
import type {
  Constraint,
  Dimension,
  LayerKey,
  LayerState,
  Level,
  Pt,
  SketchDoc,
  SketchObject,
  StructuralRelation,
} from './model'
import { constraintRefs, emptyDoc, layerOf, lineById, mintId, objectById, objectLineIds, objectPointIds, pointById, relationRefs } from './model'
import { compileRelations, REL_SEP, type CompileIssue } from './relations'
import { analyze, type SketchAnalysis } from './analysis'
import { solve, type SolveResult } from './solver'
import { dist, projectT } from './geom'

// ---------------------------------------------------------------------------
// EVALUATION (derived, memoized by the UI)
// ---------------------------------------------------------------------------

/** User constraints + relation-compiled constraints, as one list. */
export function fullConstraints(doc: SketchDoc): { constraints: Constraint[]; issues: CompileIssue[] } {
  const rel = compileRelations(doc)
  return { constraints: [...doc.constraints, ...rel.constraints], issues: rel.issues }
}

/** Point ids pinned by locked objects / locked layers. */
export function pinnedPoints(doc: SketchDoc): Set<string> {
  const out = new Set<string>()
  for (const o of doc.objects) {
    const layer = doc.layers[layerOf(o)]
    if (o.locked === true || layer.locked) for (const p of objectPointIds(doc, o)) out.add(p)
  }
  return out
}

export interface Evaluation {
  solved: SolveResult
  analysis: SketchAnalysis
  issues: CompileIssue[]
}

function solvableDoc(doc: SketchDoc): { doc: SketchDoc; issues: CompileIssue[] } {
  const { constraints, issues } = fullConstraints(doc)
  return { doc: { ...doc, constraints }, issues }
}

export function evaluate(doc: SketchDoc, drag?: ReadonlyMap<string, Pt>): Evaluation {
  const s = solvableDoc(doc)
  const pinned = pinnedPoints(doc)
  const solved = solve({ doc: s.doc, pinned, drag })
  const analysis = analyze(s.doc, solved, pinned)
  return { solved, analysis, issues: s.issues }
}

/** Solve and commit positions when consistent; otherwise keep the previous
 *  geometry (constraints stay). */
export function settle(doc: SketchDoc, drag?: ReadonlyMap<string, Pt>): { doc: SketchDoc; ok: boolean; conflicts: string[] } {
  const s = solvableDoc(doc)
  const pinned = pinnedPoints(doc)
  const solved = solve({ doc: s.doc, pinned, drag })
  if (!solved.ok) return { doc, ok: false, conflicts: solved.conflicts }
  let changed = false
  const points = doc.points.map((p) => {
    const q = solved.points.get(p.id)
    if (!q) return p
    if (Math.abs(q.x - p.x) < 1e-12 && Math.abs(q.y - p.y) < 1e-12) return p
    changed = true
    return { ...p, x: q.x, y: q.y }
  })
  return { doc: changed ? { ...doc, points } : doc, ok: true, conflicts: [] }
}

/** Object ids whose geometry differs between two docs (preview: "this change
 *  also moves …"). */
export function movedObjects(before: SketchDoc, after: SketchDoc, eps = 1e-6): string[] {
  const moved = new Set<string>()
  for (const p of after.points) {
    const q = pointById(before, p.id)
    if (!q || Math.abs(q.x - p.x) > eps || Math.abs(q.y - p.y) > eps) moved.add(p.id)
  }
  if (moved.size === 0) return []
  return after.objects.filter((o) => objectPointIds(after, o).some((id) => moved.has(id))).map((o) => o.id)
}

// ---------------------------------------------------------------------------
// ACTIONS
// ---------------------------------------------------------------------------

export type PointRef = { pointId: string } | Pt

export type ObjectSpec =
  | { kind: 'wall'; wallType: 'exterior' | 'interior'; thicknessM?: number; heightM?: number; lineIs?: 'center' | 'faceA' | 'faceB'; role?: SketchObject['role'] }
  | { kind: 'beam'; sectionWmm?: number; sectionHmm?: number; material?: string; levelM?: number; role?: SketchObject['role'] }
  | { kind: 'aux'; auxType: 'guide' | 'axis' | 'grid' }
  | { kind: 'roofEdge'; edgeType: 'eave' | 'gable' | 'spanBoundary' }

export type SketchAction =
  | { kind: 'replaceDoc'; doc: SketchDoc }
  /** Commit an already-settled doc (a confirmed preview) verbatim. */
  | { kind: 'commitDoc'; doc: SketchDoc }
  | { kind: 'addPoint'; at: Pt }
  | {
      kind: 'addLine'
      a: PointRef
      b: PointRef
      construction?: boolean
      /** Inferred while drawing (near-horizontal/vertical) — SolidWorks-style. */
      auto?: ('horizontal' | 'vertical')[]
      /** Make the new line an object right away. */
      as?: ObjectSpec
      name?: string
    }
  | { kind: 'addColumn'; at: PointRef; sectionWmm?: number; sectionHmm?: number; heightM?: number; rotationDeg?: number; name?: string }
  | { kind: 'addOpening'; wall: string; offsetM: number; widthM?: number; heightM?: number; sillM?: number; name?: string }
  | { kind: 'addRoofOutline'; lines: string[]; name?: string }
  | { kind: 'convertLine'; line: string; as: ObjectSpec; name?: string }
  | { kind: 'movePoints'; targets: Record<string, Pt> }
  | { kind: 'deleteLines'; ids: string[] }
  | { kind: 'addConstraint'; c: DistributiveOmit<Constraint, 'id'> }
  | { kind: 'removeConstraint'; id: string }
  | { kind: 'setConstraintValue'; id: string; value: number }
  | { kind: 'addDimension'; dim: Omit<Dimension, 'id' | 'constraintId'>; value?: number }
  | { kind: 'setDimensionDriving'; id: string; driving: boolean; value?: number }
  | { kind: 'setDimensionValue'; id: string; value: number }
  | { kind: 'removeDimension'; id: string }
  | { kind: 'updateObject'; id: string; patch: Partial<SketchObject> }
  | { kind: 'removeObject'; id: string; keepGeometry?: boolean }
  | { kind: 'addRelation'; relation: DistributiveOmit<StructuralRelation, 'id'> }
  | { kind: 'updateRelation'; id: string; patch: Partial<StructuralRelation> }
  | { kind: 'removeRelation'; id: string }
  | { kind: 'setLayer'; key: LayerKey; patch: Partial<LayerState> }
  | { kind: 'setLevels'; levels: Level[] }
  | { kind: 'setRoofSlope'; slopePct: number | undefined }
  | { kind: 'setRoofSupports'; supports: string[] }

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export const DEFAULTS = {
  wallExtThicknessM: 0.25,
  wallIntThicknessM: 0.15,
  wallHeightM: 3,
  columnSectionMm: 150,
  columnHeightM: 3,
  beamSectionWmm: 150,
  beamSectionHmm: 200,
  beamMaterial: 'GLULAM_2L',
  beamLevelM: 3,
  openingWidthM: 1,
  openingHeightM: 2.1,
  openingSillM: 0,
} as const

const AUTO_NAME_PREFIX: Record<SketchObject['kind'], string> = {
  wall: 'ק',
  column: 'ע',
  beam: 'קורה ',
  opening: 'פ',
  roofOutline: 'מתאר גג',
  roofEdge: 'קצה ',
  aux: 'עזר ',
}

function autoName(doc: SketchDoc, kind: SketchObject['kind']): string {
  const n = doc.objects.filter((o) => o.kind === kind).length + 1
  if (kind === 'roofOutline') return n === 1 ? 'מתאר גג' : `מתאר גג ${n}`
  return `${AUTO_NAME_PREFIX[kind]}${n}`
}

function resolvePoint(doc: SketchDoc, ref: PointRef): { doc: SketchDoc; id: string } {
  if ('pointId' in ref) return { doc, id: ref.pointId }
  const m = mintId(doc, 'p')
  return { doc: { ...m.doc, points: [...m.doc.points, { id: m.id, x: ref.x, y: ref.y }] }, id: m.id }
}

type NewObject = DistributiveOmit<SketchObject, 'id' | 'name'> & { name?: string }

function addObject(doc: SketchDoc, o: NewObject): { doc: SketchDoc; id: string } {
  const m = mintId(doc, 'o')
  const name = o.name ?? autoName(doc, o.kind)
  const obj = { ...o, id: m.id, name } as SketchObject
  return { doc: { ...m.doc, objects: [...m.doc.objects, obj] }, id: m.id }
}

function objectFromSpec(spec: ObjectSpec, lineId: string, name?: string): NewObject {
  switch (spec.kind) {
    case 'wall':
      return {
        kind: 'wall',
        name,
        wallType: spec.wallType,
        line: lineId,
        thicknessM: spec.thicknessM ?? (spec.wallType === 'exterior' ? DEFAULTS.wallExtThicknessM : DEFAULTS.wallIntThicknessM),
        heightM: spec.heightM ?? DEFAULTS.wallHeightM,
        lineIs: spec.lineIs ?? 'center',
        role: spec.role ?? (spec.wallType === 'exterior' ? 'bearing' : 'non-bearing'),
      }
    case 'beam':
      return {
        kind: 'beam',
        name,
        line: lineId,
        sectionWmm: spec.sectionWmm ?? DEFAULTS.beamSectionWmm,
        sectionHmm: spec.sectionHmm ?? DEFAULTS.beamSectionHmm,
        material: spec.material ?? DEFAULTS.beamMaterial,
        levelM: spec.levelM ?? DEFAULTS.beamLevelM,
        supports: [],
        role: spec.role ?? 'bearing',
      }
    case 'aux':
      return { kind: 'aux', name, line: lineId, auxType: spec.auxType, role: 'none' }
    case 'roofEdge':
      return { kind: 'roofEdge', name, line: lineId, edgeType: spec.edgeType, role: 'none' }
  }
}

/** Remove points no line or column references any more. */
function pruneOrphanPoints(doc: SketchDoc): SketchDoc {
  const used = new Set<string>()
  for (const l of doc.lines) {
    used.add(l.a)
    used.add(l.b)
  }
  for (const o of doc.objects) if (o.kind === 'column') used.add(o.point)
  const points = doc.points.filter((p) => used.has(p.id))
  if (points.length === doc.points.length) return doc
  const gone = new Set(doc.points.filter((p) => !used.has(p.id)).map((p) => p.id))
  return dropConstraintsReferencing({ ...doc, points }, gone)
}

function dropConstraintsReferencing(doc: SketchDoc, gone: ReadonlySet<string>): SketchDoc {
  const constraints = doc.constraints.filter((c) => !constraintRefs(c).some((r) => gone.has(r)))
  const goneC = new Set(doc.constraints.filter((c) => !constraints.includes(c)).map((c) => c.id))
  const dimensions = doc.dimensions.filter((d) => !d.refs.some((r) => gone.has(r)) && !(d.constraintId && goneC.has(d.constraintId)))
  return { ...doc, constraints, dimensions }
}

function removeLines(doc: SketchDoc, ids: ReadonlySet<string>): SketchDoc {
  const lines = doc.lines.filter((l) => !ids.has(l.id))
  // Objects owning a deleted line go too (and their relations).
  const deadObjects = doc.objects.filter((o) => objectLineIds(o).some((l) => ids.has(l)))
  let next: SketchDoc = { ...doc, lines }
  for (const o of deadObjects) next = removeObjectInternal(next, o.id, true)
  next = dropConstraintsReferencing(next, ids)
  return pruneOrphanPoints(next)
}

function removeRelationInternal(doc: SketchDoc, id: string): SketchDoc {
  const relations = doc.relations.filter((r) => r.id !== id)
  if (relations.length === doc.relations.length) return doc
  let next: SketchDoc = { ...doc, relations }
  // A divide relation owns its guide line.
  const guideId = `${id}${REL_SEP}line`
  if (next.lines.some((l) => l.id === guideId)) {
    next = { ...next, lines: next.lines.filter((l) => l.id !== guideId) }
    next = dropConstraintsReferencing(next, new Set([guideId]))
  }
  // beamBetween recorded supports on the beam.
  const r = doc.relations.find((x) => x.id === id)
  if (r && r.kind === 'beamBetween') {
    next = {
      ...next,
      objects: next.objects.map((o) =>
        o.id === r.beam && o.kind === 'beam' ? { ...o, supports: o.supports.filter((s) => s !== r.supportA && s !== r.supportB) } : o,
      ),
    }
  }
  return next
}

function removeObjectInternal(doc: SketchDoc, id: string, geometryAlreadyGone: boolean): SketchDoc {
  const o = objectById(doc, id)
  if (!o) return doc
  let next: SketchDoc = { ...doc, objects: doc.objects.filter((x) => x.id !== id) }
  for (const r of doc.relations) if (relationRefs(r).includes(id)) next = removeRelationInternal(next, r.id)
  // Openings on a removed wall go with it.
  if (o.kind === 'wall') {
    for (const op of doc.objects) if (op.kind === 'opening' && op.wall === id) next = removeObjectInternal(next, op.id, true)
  }
  // Beams that bore on this object lose it from their support list.
  next = {
    ...next,
    objects: next.objects.map((b) => (b.kind === 'beam' && b.supports.includes(id) ? { ...b, supports: b.supports.filter((s) => s !== id) } : b)),
  }
  if (!geometryAlreadyGone && o.kind === 'column') next = pruneOrphanPoints(next)
  return next
}

function newId(doc: SketchDoc, prefix: string): { id: string; doc: SketchDoc } {
  return mintId(doc, prefix)
}

/** Pure reducer. Returns the SAME doc for a no-op. */
export function sketchReducer(doc: SketchDoc, a: SketchAction): SketchDoc {
  switch (a.kind) {
    case 'replaceDoc':
      return settle(a.doc).doc
    case 'commitDoc':
      return a.doc
    case 'addPoint': {
      const r = resolvePoint(doc, a.at)
      return r.doc
    }
    case 'addLine': {
      const ra = resolvePoint(doc, a.a)
      const rb = resolvePoint(ra.doc, a.b)
      if (ra.id === rb.id) return doc
      const m = newId(rb.doc, 'l')
      let next: SketchDoc = { ...m.doc, lines: [...m.doc.lines, { id: m.id, a: ra.id, b: rb.id, ...(a.construction ? { construction: true } : {}) }] }
      for (const k of a.auto ?? []) {
        const c = newId(next, 'c')
        next = { ...c.doc, constraints: [...c.doc.constraints, { id: c.id, kind: k, line: m.id }] }
      }
      if (a.as) next = addObject(next, objectFromSpec(a.as, m.id, a.name)).doc
      return settle(next).doc
    }
    case 'addColumn': {
      const rp = resolvePoint(doc, a.at)
      const next = addObject(rp.doc, {
        kind: 'column',
        name: a.name,
        point: rp.id,
        sectionWmm: a.sectionWmm ?? DEFAULTS.columnSectionMm,
        sectionHmm: a.sectionHmm ?? DEFAULTS.columnSectionMm,
        rotationDeg: a.rotationDeg ?? 0,
        heightM: a.heightM ?? DEFAULTS.columnHeightM,
        role: 'bearing',
      })
      return settle(next.doc).doc
    }
    case 'addOpening': {
      const w = objectById(doc, a.wall)
      if (!w || w.kind !== 'wall') return doc
      const next = addObject(doc, {
        kind: 'opening',
        name: a.name,
        wall: a.wall,
        offsetM: a.offsetM,
        widthM: a.widthM ?? DEFAULTS.openingWidthM,
        heightM: a.heightM ?? DEFAULTS.openingHeightM,
        sillM: a.sillM ?? DEFAULTS.openingSillM,
        role: 'none',
      })
      return next.doc
    }
    case 'addRoofOutline': {
      if (a.lines.length < 3 || a.lines.some((l) => !lineById(doc, l))) return doc
      const next = addObject(doc, { kind: 'roofOutline', name: a.name, lines: [...a.lines], role: 'none' })
      return next.doc
    }
    case 'convertLine': {
      if (!lineById(doc, a.line)) return doc
      const next = addObject(doc, objectFromSpec(a.as, a.line, a.name))
      return settle(next.doc).doc
    }
    case 'movePoints': {
      const drag = new Map<string, Pt>()
      for (const [id, p] of Object.entries(a.targets)) if (pointById(doc, id)) drag.set(id, p)
      if (drag.size === 0) return doc
      const pinned = pinnedPoints(doc)
      for (const id of drag.keys()) if (pinned.has(id)) drag.delete(id)
      if (drag.size === 0) return doc
      // No constraints at all: a drag is a plain move.
      const { constraints } = fullConstraints(doc)
      if (constraints.length === 0) {
        return { ...doc, points: doc.points.map((p) => (drag.has(p.id) ? { ...p, ...drag.get(p.id)! } : p)) }
      }
      return settle(doc, drag).doc
    }
    case 'deleteLines': {
      const ids = new Set(a.ids.filter((id) => lineById(doc, id)))
      if (ids.size === 0) return doc
      return settle(removeLines(doc, ids)).doc
    }
    case 'addConstraint': {
      for (const ref of constraintRefs(a.c as Constraint)) {
        if (!pointById(doc, ref) && !lineById(doc, ref)) return doc
      }
      const m = newId(doc, 'c')
      const c = { ...a.c, id: m.id } as Constraint
      return settle({ ...m.doc, constraints: [...m.doc.constraints, c] }).doc
    }
    case 'removeConstraint': {
      const constraints = doc.constraints.filter((c) => c.id !== a.id)
      if (constraints.length === doc.constraints.length) return doc
      const dimensions = doc.dimensions.map((d) => (d.constraintId === a.id ? { ...d, driving: false, constraintId: undefined } : d))
      return settle({ ...doc, constraints, dimensions }).doc
    }
    case 'setConstraintValue': {
      if (!Number.isFinite(a.value)) return doc
      const constraints = doc.constraints.map((c) => {
        if (c.id !== a.id) return c
        if (c.kind === 'angle') return { ...c, valueDeg: a.value }
        if ('valueM' in c) return { ...c, valueM: a.value }
        return c
      })
      return settle({ ...doc, constraints }).doc
    }
    case 'addDimension': {
      const refsOk = a.dim.refs.every((r) => pointById(doc, r) || lineById(doc, r))
      if (!refsOk) return doc
      const m = newId(doc, 'd')
      let next = m.doc
      let constraintId: string | undefined
      if (a.dim.driving) {
        const value = a.value ?? measureDimension(doc, a.dim)
        if (value === null) return doc
        const c = constraintForDimension(next, a.dim, value)
        if (!c) return doc
        next = c.doc
        constraintId = c.id
      }
      const dim: Dimension = { ...a.dim, id: m.id, ...(constraintId ? { constraintId } : {}) }
      return settle({ ...next, dimensions: [...next.dimensions, dim] }).doc
    }
    case 'setDimensionDriving': {
      const d = doc.dimensions.find((x) => x.id === a.id)
      if (!d || d.driving === a.driving) return doc
      if (!a.driving) {
        return settle({
          ...doc,
          constraints: doc.constraints.filter((c) => c.id !== d.constraintId),
          dimensions: doc.dimensions.map((x) => (x.id === a.id ? { ...x, driving: false, constraintId: undefined } : x)),
        }).doc
      }
      const value = a.value ?? measureDimension(doc, d)
      if (value === null) return doc
      const c = constraintForDimension(doc, d, value)
      if (!c) return doc
      return settle({ ...c.doc, dimensions: c.doc.dimensions.map((x) => (x.id === a.id ? { ...x, driving: true, constraintId: c.id } : x)) }).doc
    }
    case 'setDimensionValue': {
      const d = doc.dimensions.find((x) => x.id === a.id)
      if (!d || !d.driving || !d.constraintId) return doc
      return sketchReducer(doc, { kind: 'setConstraintValue', id: d.constraintId, value: a.value })
    }
    case 'removeDimension': {
      const d = doc.dimensions.find((x) => x.id === a.id)
      if (!d) return doc
      return settle({
        ...doc,
        constraints: doc.constraints.filter((c) => c.id !== d.constraintId),
        dimensions: doc.dimensions.filter((x) => x.id !== a.id),
      }).doc
    }
    case 'updateObject': {
      const o = objectById(doc, a.id)
      if (!o) return doc
      const patched = { ...o, ...a.patch } as SketchObject
      return settle({ ...doc, objects: doc.objects.map((x) => (x.id === a.id ? patched : x)) }).doc
    }
    case 'removeObject': {
      const o = objectById(doc, a.id)
      if (!o) return doc
      let next = removeObjectInternal(doc, a.id, false)
      if (!a.keepGeometry) {
        const lines = new Set(objectLineIds(o).filter((l) => !next.objects.some((x) => objectLineIds(x).includes(l))))
        if (lines.size > 0) next = removeLines(next, lines)
        else next = pruneOrphanPoints(next)
      }
      return settle(next).doc
    }
    case 'addRelation': {
      for (const ref of relationRefs(a.relation as StructuralRelation)) {
        if (!objectById(doc, ref) && !pointById(doc, ref)) return doc
      }
      const m = newId(doc, 'r')
      let next = m.doc
      let rel = { ...a.relation, id: m.id } as StructuralRelation
      if (rel.kind === 'beamBetween') {
        const beam = objectById(next, rel.beam)
        if (!beam || beam.kind !== 'beam') return doc
        const bl = lineById(next, beam.line)
        if (!bl) return doc
        // Orient supports to the nearer beam end so the relation is stable.
        const pa = pointById(next, bl.a)!
        const pb = pointById(next, bl.b)!
        const sA = supportAnchor(next, rel.supportA)
        const sB = supportAnchor(next, rel.supportB)
        if (sA && sB && dist(pa, sA) + dist(pb, sB) > dist(pa, sB) + dist(pb, sA)) {
          rel = { ...rel, supportA: rel.supportB, supportB: rel.supportA }
        }
        const supports = [...new Set([...beam.supports, rel.supportA, rel.supportB])]
        next = { ...next, objects: next.objects.map((o) => (o.id === beam.id ? { ...beam, supports } : o)) }
      }
      if (rel.kind === 'divide') {
        const pa = pointById(next, rel.boundA)
        const pb = pointById(next, rel.boundB)
        if (!pa || !pb || rel.columns.length === 0) return doc
        const cols = rel.columns
          .map((id) => objectById(next, id))
          .filter((o): o is SketchObject & { kind: 'column' } => !!o && o.kind === 'column')
        if (cols.length !== rel.columns.length) return doc
        const ordered = [...cols].sort((x, y) => projectT(pointById(next, x.point)!, pa, pb) - projectT(pointById(next, y.point)!, pa, pb))
        rel = { ...rel, columns: ordered.map((c) => c.id) }
        next = { ...next, lines: [...next.lines, { id: `${rel.id}${REL_SEP}line`, a: rel.boundA, b: rel.boundB, construction: true }] }
      }
      return settle({ ...next, relations: [...next.relations, rel] }).doc
    }
    case 'updateRelation': {
      const r = doc.relations.find((x) => x.id === a.id)
      if (!r) return doc
      const patched = { ...r, ...a.patch } as StructuralRelation
      return settle({ ...doc, relations: doc.relations.map((x) => (x.id === a.id ? patched : x)) }).doc
    }
    case 'removeRelation':
      return settle(removeRelationInternal(doc, a.id)).doc
    case 'setLayer': {
      const cur = doc.layers[a.key]
      const next = { ...cur, ...a.patch }
      if (next.visible === cur.visible && next.locked === cur.locked) return doc
      return { ...doc, layers: { ...doc.layers, [a.key]: next } }
    }
    case 'setLevels':
      return { ...doc, levels: a.levels }
    case 'setRoofSlope':
      return { ...doc, roofSlopePct: a.slopePct }
    case 'setRoofSupports':
      return { ...doc, roofSupports: a.supports }
  }
}

function supportAnchor(doc: SketchDoc, id: string): Pt | null {
  const o = objectById(doc, id)
  if (!o) return null
  if (o.kind === 'column') return pointById(doc, o.point) ?? null
  const lineId = o.kind === 'wall' || o.kind === 'beam' || o.kind === 'aux' || o.kind === 'roofEdge' ? o.line : null
  if (!lineId) return null
  const l = lineById(doc, lineId)
  if (!l) return null
  const pa = pointById(doc, l.a)
  const pb = pointById(doc, l.b)
  return pa && pb ? { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } : null
}

/** Current measured value of a dimension (meters or degrees); null when its
 *  geometry is missing. Used for reference dimensions AND to seed a driving
 *  one with the as-drawn value. */
export function measureDimension(doc: SketchDoc, d: Pick<Dimension, 'kind' | 'refs'>, positions?: ReadonlyMap<string, Pt>): number | null {
  const P = (id: string): Pt | null => positions?.get(id) ?? pointById(doc, id) ?? null
  const L = (id: string): { a: Pt; b: Pt } | null => {
    const l = lineById(doc, id)
    if (!l) return null
    const a = P(l.a)
    const b = P(l.b)
    return a && b ? { a, b } : null
  }
  switch (d.kind) {
    case 'length': {
      const l = L(d.refs[0] ?? '')
      return l ? dist(l.a, l.b) : null
    }
    case 'pointDistance': {
      const p = P(d.refs[0] ?? '')
      const q = P(d.refs[1] ?? '')
      return p && q ? dist(p, q) : null
    }
    case 'pointLineDistance': {
      const p = P(d.refs[0] ?? '')
      const l = L(d.refs[1] ?? '')
      if (!p || !l) return null
      const dx = l.b.x - l.a.x
      const dy = l.b.y - l.a.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-12) return null
      return (dx * (p.y - l.a.y) - dy * (p.x - l.a.x)) / len
    }
    case 'lineDistance': {
      const a = L(d.refs[0] ?? '')
      const b = L(d.refs[1] ?? '')
      if (!a || !b) return null
      const dx = a.b.x - a.a.x
      const dy = a.b.y - a.a.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-12) return null
      const m = { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }
      return (dx * (m.y - a.a.y) - dy * (m.x - a.a.x)) / len
    }
    case 'angle': {
      const a = L(d.refs[0] ?? '')
      const b = L(d.refs[1] ?? '')
      if (!a || !b) return null
      const u = { x: a.b.x - a.a.x, y: a.b.y - a.a.y }
      const w = { x: b.b.x - b.a.x, y: b.b.y - b.a.y }
      return (Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y) * 180) / Math.PI
    }
  }
}

function constraintForDimension(doc: SketchDoc, d: Pick<Dimension, 'kind' | 'refs'>, value: number): { doc: SketchDoc; id: string } | null {
  const m = newId(doc, 'c')
  let c: Constraint | null = null
  switch (d.kind) {
    case 'length':
      c = { id: m.id, kind: 'length', line: d.refs[0]!, valueM: value }
      break
    case 'pointDistance':
      c = { id: m.id, kind: 'pointDistance', p: d.refs[0]!, q: d.refs[1]!, valueM: value }
      break
    case 'pointLineDistance':
      c = { id: m.id, kind: 'pointLineDistance', p: d.refs[0]!, line: d.refs[1]!, valueM: value }
      break
    case 'lineDistance':
      c = { id: m.id, kind: 'lineDistance', a: d.refs[0]!, b: d.refs[1]!, valueM: value }
      break
    case 'angle':
      c = { id: m.id, kind: 'angle', a: d.refs[0]!, b: d.refs[1]!, valueDeg: value }
      break
  }
  if (!c) return null
  return { doc: { ...m.doc, constraints: [...m.doc.constraints, c] }, id: m.id }
}

export { emptyDoc }
