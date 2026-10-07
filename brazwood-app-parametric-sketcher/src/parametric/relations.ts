// src/parametric/relations.ts
// STRUCTURAL RELATIONS → CONSTRAINTS (owner brief §3). PURE. Every relation
// compiles into one or more solver constraints whose ids are
// `${relationId}~${k}` (analysis.ts maps them back for highlighting). The
// compile runs fresh on EVERY settle (doc.ts) so a thickness / section edit
// on a wall or beam re-derives the face offsets — nothing is copied.
import type { Constraint, SketchDoc, SketchObject, WallFaceRef } from './model'
import { objectById } from './model'
import { offsetOf, outerSign } from './objects'

export const REL_SEP = '~'

export interface CompileIssue {
  relationId: string
  /** Hebrew, shown next to the relation in the panel. */
  message: string
}

function lineOf(o: SketchObject | undefined): string | null {
  if (!o) return null
  if (o.kind === 'wall' || o.kind === 'beam' || o.kind === 'aux' || o.kind === 'roofEdge') return o.line
  return null
}

function refOffset(o: SketchObject, ref: WallFaceRef): number {
  return offsetOf(o, ref)
}

/** Compile every relation. Constraints referencing missing objects are
 *  skipped and reported — a relation never silently disappears (it stays in
 *  the list, flagged), the user decides. */
export function compileRelations(doc: SketchDoc): { constraints: Constraint[]; issues: CompileIssue[] } {
  const out: Constraint[] = []
  const issues: CompileIssue[] = []
  for (const r of doc.relations) {
    let k = 0
    const cid = (): string => `${r.id}${REL_SEP}${k++}`
    const fail = (message: string): void => {
      issues.push({ relationId: r.id, message })
    }
    switch (r.kind) {
      case 'columnOnAxis': {
        const col = objectById(doc, r.column)
        const ax = objectById(doc, r.line)
        const line = lineOf(ax)
        if (!col || col.kind !== 'column' || !line) {
          fail('עמוד או ציר חסרים')
          break
        }
        out.push({ id: cid(), kind: 'pointOnLine', p: col.point, line })
        break
      }
      case 'columnAtCorner': {
        const col = objectById(doc, r.column)
        const wa = objectById(doc, r.wallA)
        const wb = objectById(doc, r.wallB)
        if (!col || col.kind !== 'column' || !wa || wa.kind !== 'wall' || !wb || wb.kind !== 'wall') {
          fail('עמוד או קיר חסרים')
          break
        }
        out.push({ id: cid(), kind: 'pointLineDistance', p: col.point, line: wa.line, valueM: r.distA, offsetM: refOffset(wa, r.refA) })
        out.push({ id: cid(), kind: 'pointLineDistance', p: col.point, line: wb.line, valueM: r.distB, offsetM: refOffset(wb, r.refB) })
        break
      }
      case 'offsetFromWall': {
        const t = objectById(doc, r.target)
        const w = objectById(doc, r.wall)
        if (!t || !w || w.kind !== 'wall') {
          fail('יעד או קיר חסרים')
          break
        }
        if (t.kind === 'column') {
          out.push({ id: cid(), kind: 'pointLineDistance', p: t.point, line: w.line, valueM: r.distM, offsetM: refOffset(w, r.ref) })
        } else {
          const tl = lineOf(t)
          if (!tl) {
            fail('ליעד אין קו')
            break
          }
          out.push({ id: cid(), kind: 'lineDistance', a: w.line, b: tl, valueM: r.distM, offsetM: refOffset(w, r.ref) })
        }
        break
      }
      case 'beamBetween': {
        const beam = objectById(doc, r.beam)
        if (!beam || beam.kind !== 'beam') {
          fail('הקורה חסרה')
          break
        }
        const bl = doc.lines.find((l) => l.id === beam.line)
        if (!bl) {
          fail('לקורה אין קו')
          break
        }
        const ends: [string, string][] = [
          [bl.a, r.supportA],
          [bl.b, r.supportB],
        ]
        for (const [endPoint, supportId] of ends) {
          const s = objectById(doc, supportId)
          if (!s) {
            fail('תמיכה חסרה')
            continue
          }
          if (s.kind === 'column') out.push({ id: cid(), kind: 'coincident', p: endPoint, q: s.point })
          else {
            const sl = lineOf(s)
            if (!sl) {
              fail('לתמיכה אין קו')
              continue
            }
            out.push({ id: cid(), kind: 'pointOnLine', p: endPoint, line: sl })
          }
        }
        break
      }
      case 'alignTo': {
        const t = objectById(doc, r.target)
        const ref = objectById(doc, r.reference)
        const tl = lineOf(t)
        const rl = lineOf(ref)
        if (!t || !ref || !tl || !rl) {
          fail('יעד או ייחוס חסרים')
          break
        }
        // The target's own center must sit at gap from the reference line:
        // the target's sketch line may itself be a face (walls), so correct
        // for that too — offset(ref line) minus offset(target line from its
        // center) keeps "gap" a center-to-reference distance.
        const targetLineOffset = offsetOf(t, 'center')
        out.push({ id: cid(), kind: 'lineDistance', a: rl, b: tl, valueM: r.gapM, offsetM: refOffset(ref, r.ref) - targetLineOffset })
        break
      }
      case 'divide': {
        const cols = r.columns.map((id) => objectById(doc, id))
        if (cols.some((c) => !c || c.kind !== 'column')) {
          fail('עמוד חסר בחלוקה')
          break
        }
        const pts = cols.map((c) => (c as { point: string }).point)
        const chain = [r.boundA, ...pts, r.boundB]
        const guide = doc.lines.find((l) => l.id === `${r.id}${REL_SEP}line`)
        if (!guide) {
          fail('קו החלוקה חסר')
          break
        }
        for (const p of pts) out.push({ id: cid(), kind: 'pointOnLine', p, line: guide.id })
        if (r.by === 'count') {
          for (let i = 0; i + 2 < chain.length; i++) {
            out.push({ id: cid(), kind: 'equalDistance', p: chain[i]!, q: chain[i + 1]!, r: chain[i + 1]!, s: chain[i + 2]! })
          }
        } else {
          const s = r.spacingM ?? 0
          if (!(s > 0)) {
            fail('מרווח החלוקה חייב להיות חיובי')
            break
          }
          for (let i = 0; i + 1 < chain.length - 1; i++) {
            out.push({ id: cid(), kind: 'pointDistance', p: chain[i]!, q: chain[i + 1]!, valueM: s })
          }
        }
        break
      }
      case 'roofOverhang': {
        const edge = objectById(doc, r.roofEdge)
        const wall = objectById(doc, r.wall)
        const el = lineOf(edge)
        if (!edge || !wall || wall.kind !== 'wall' || !el) {
          fail('קצה גג או קיר חסרים')
          break
        }
        const sign = outerSign(doc, wall)
        const outerFace: WallFaceRef = sign > 0 ? 'faceA' : 'faceB'
        out.push({
          id: cid(),
          kind: 'lineDistance',
          a: wall.line,
          b: el,
          valueM: sign * r.overhangM,
          offsetM: refOffset(wall, outerFace),
        })
        break
      }
    }
  }
  return { constraints: out, issues }
}

export const isRelationConstraintId = (cid: string): boolean => cid.includes(REL_SEP)
