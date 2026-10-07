// src/parametric/ui/ParametricSketcher.tsx
// THE PARAMETRIC SKETCHING ENVIRONMENT (owner brief 2026-10-07). A fixed,
// full-screen workspace (brief §5: large canvas, no page scroll; wheel =
// zoom about the cursor, middle button / hand = pan, zoom-to-fit, snapping,
// undo/redo, compact properties panel, layer visibility + lock).
//
// Orchestrates the pure core (../doc.ts reducer wrapped by the roofwizard's
// generic undo ring) and the canvas/panels. Every edit that can move other
// objects (a dimension value, a relation value, a thickness) first shows a
// PREVIEW ghost + the list of affected objects, then commits on confirm
// (brief §4). A contradiction is never resolved by the app: the offending
// constraint stays, highlighted, until the user edits or deletes it.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  Columns3,
  Crosshair,
  DoorOpen,
  Grid2x2,
  Hand,
  House,
  Maximize2,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  Ruler,
  Slash,
  Square,
  SquareDashed,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { initHistory, undoable, type HistoryAction } from '../../roofwizard/history'
import { useLengthUnit } from '../../roofwizard/unitContext'
import { formatLength, interpretInUnit } from '../../roofwizard/units'
import { evaluate, measureDimension, movedObjects, sketchReducer, type ObjectSpec, type SketchAction } from '../doc'
import {
  CONSTRAINT_LABEL_HE,
  OBJECT_LABEL_HE,
  RELATION_LABEL_HE,
  constraintRefs,
  lineById,
  objectById,
  pointById,
  relationRefs,
  type Dimension,
  type Pt,
  type RelationKind,
  type SketchDoc,
  type SketchObject,
  type StructuralRelation,
} from '../model'
import { bounds, signedDist, sub } from '../geom'
import { offsetOf } from '../objects'
import { deriveRoof, type RoofDerivation } from '../roofBridge'
import { fitTo, zoomAt, type Camera } from './camera'
import { snapPoint, type Snap } from './snap'
import { SketchCanvas, type CanvasPointer, type Draft, type PreviewGhost } from './SketchCanvas'
import { ConstraintList, LayersPanel, ObjectProperties, ReferenceDimensionList, RelationList, RoofPanel, chipCls, chipOn, panelCls } from './panels'

export type Tool = 'select' | 'pan' | 'line' | 'wallExt' | 'wallInt' | 'beam' | 'aux' | 'roofEdge' | 'column' | 'opening' | 'dimension'

const TOOLS: { id: Tool; he: string; icon: typeof PenLine; hint: string }[] = [
  { id: 'select', he: 'בחירה', icon: MousePointer2, hint: 'לחיצה בוחרת · גרירה מזיזה (לפי היחסים) · Shift לבחירה מרובה' },
  { id: 'pan', he: 'יד', icon: Hand, hint: 'גרירה מזיזה את התצוגה · גלגלת = Zoom סביב הסמן' },
  { id: 'line', he: 'קו', icon: PenLine, hint: 'לחיצה ראשונה = התחלה · לחיצה שנייה = סוף · אפשר להקליד אורך ו-Enter · Esc מסיים' },
  { id: 'wallExt', he: 'קיר חוץ', icon: Square, hint: 'שרטט את קו הקיר (מרכז/פן — ניתן לשנות בפאנל). סגור את הלולאה כדי שהגג ייבנה' },
  { id: 'wallInt', he: 'קיר פנים', icon: SquareDashed, hint: 'שרטט את קו הקיר הפנימי' },
  { id: 'column', he: 'עמוד', icon: Columns3, hint: 'לחיצה ממקמת עמוד (נצמד לנקודות קיימות)' },
  { id: 'beam', he: 'קורה', icon: Minus, hint: 'שרטט את ציר הקורה בין שתי תמיכות' },
  { id: 'opening', he: 'פתח', icon: DoorOpen, hint: 'לחיצה על קיר ממקמת פתח' },
  { id: 'roofEdge', he: 'קצה גג', icon: House, hint: 'שרטט קו קצה גג / גבול מפתח' },
  { id: 'aux', he: 'קו עזר', icon: Slash, hint: 'קו עזר / ציר — לא חלק מהמבנה' },
  { id: 'dimension', he: 'מידה', icon: Ruler, hint: 'קו = אורך · נקודה+נקודה = מרחק · נקודה+קו = מרחק מקו · קו+קו = זווית/מרחק' },
]

const SNAP_PX = 10
const GRID_M = 0.05

interface PickFlow {
  relation: RelationKind
  /** The object the flow was started from (selected). */
  subject: string
  /** Extra selection (divide: the columns). */
  subjects: string[]
  steps: { want: 'wall' | 'extWall' | 'lineObject' | 'support' | 'point' | 'reference'; hint: string }[]
  collected: string[]
}

interface Pending {
  next: SketchDoc
  affected: string[]
  label: string
}

interface DragState {
  pointIds: string[]
  startWorld: Pt
  start: Map<string, Pt>
  moved: boolean
}

const reducer = undoable<SketchDoc, SketchAction>(sketchReducer)

export interface ParametricSketcherProps {
  initialDoc: SketchDoc
  /** Autosave hook — every committed change (debounced). */
  onChange?: (doc: SketchDoc) => void
  onClose: () => void
  /** Build / update the roof from the sketch (brief §6). */
  onBuildRoof?: (r: { doc: SketchDoc; derivation: RoofDerivation }) => void
  initialSlopePct?: number
  title?: string
  /** True when a roof already exists on the block (button reads "עדכן"). */
  roofExists?: boolean
}

export function ParametricSketcher({ initialDoc, onChange, onClose, onBuildRoof, initialSlopePct, title, roofExists }: ParametricSketcherProps) {
  const unit = useLengthUnit()
  const [hist, rawDispatch] = useReducer(reducer, initialDoc, (d) => initHistory(d))
  const doc = hist.present
  const dispatch = useCallback((a: HistoryAction<SketchAction>) => rawDispatch(a), [])

  const [tool, setTool] = useState<Tool>('select')
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [selectedConstraint, setSelectedConstraint] = useState<string | null>(null)
  const [camera, setCamera] = useState<Camera>({ cx: 5, cy: 3, pxPerM: 60 })
  const sizeRef = useRef({ w: 800, h: 600 })
  const [showGrid, setShowGrid] = useState(true)
  const [snapOn, setSnapOn] = useState(true)
  const [hover, setHover] = useState<Snap | null>(null)
  const [draftStart, setDraftStart] = useState<Snap | null>(null)
  const [typed, setTyped] = useState('')
  const dragRef = useRef<DragState | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [pick, setPick] = useState<PickFlow | null>(null)
  const [dimRefs, setDimRefs] = useState<{ id: string; type: 'point' | 'line' }[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [slopePct, setSlopePct] = useState(initialSlopePct ?? doc.roofSlopePct ?? 40)
  const fittedRef = useRef(false)

  const ev = useMemo(() => evaluate(doc), [doc])
  const derivation = useMemo(() => deriveRoof(doc), [doc])
  const positions = useMemo(() => {
    const m = new Map<string, Pt>()
    for (const p of doc.points) m.set(p.id, { x: p.x, y: p.y })
    return m
  }, [doc])

  // Autosave (debounced) — brief §4 "לשמור … גם לאחר סגירה ופתיחה מחדש".
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => onChangeRef.current?.(doc), 300)
    return () => clearTimeout(t)
  }, [doc])

  // Fit once when the canvas has a size and the doc has geometry.
  const fit = useCallback(() => {
    const { w, h } = sizeRef.current
    const pts = doc.points.length > 0 ? doc.points : [{ x: 0, y: 0 }, { x: 10, y: 6 }]
    setCamera(fitTo(bounds(pts), w, h))
  }, [doc.points])
  const onSize = useCallback((w: number, h: number) => {
    sizeRef.current = { w, h }
    if (!fittedRef.current) {
      fittedRef.current = true
      const pts = initialDoc.points.length > 0 ? initialDoc.points : [{ x: 0, y: 0 }, { x: 10, y: 6 }]
      setCamera(fitTo(bounds(pts), w, h))
    }
  }, [initialDoc.points])

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------
  const geometryOf = (id: string): { type: 'point' | 'line'; id: string } | null => {
    if (pointById(doc, id)) return { type: 'point', id }
    if (lineById(doc, id)) return { type: 'line', id }
    const o = objectById(doc, id)
    if (!o) return null
    if (o.kind === 'column') return { type: 'point', id: o.point }
    if ('line' in o) return { type: 'line', id: o.line }
    return null
  }
  const selectedObjects = [...selection].map((id) => objectById(doc, id)).filter((o): o is SketchObject => !!o)
  const selGeom = [...selection].map(geometryOf).filter((g): g is { type: 'point' | 'line'; id: string } => !!g)
  const selPoints = selGeom.filter((g) => g.type === 'point').map((g) => g.id)
  const selLines = selGeom.filter((g) => g.type === 'line').map((g) => g.id)
  const selGeomIds = new Set(selGeom.map((g) => g.id))

  const constraintsOfSelection = doc.constraints.filter((c) => constraintRefs(c).some((r) => selGeomIds.has(r))).map((c) => c.id)
  const relationsOfSelection = doc.relations.filter((r) => relationRefs(r).some((id) => selection.has(id)))
  const refDimsOfSelection = doc.dimensions.filter((d) => !d.driving && d.refs.some((r) => selGeomIds.has(r)))

  const say = (m: string | null) => setMessage(m)

  const doSnap = (world: Pt, anchor?: Pt, exclude?: ReadonlySet<string>): Snap => {
    const hiddenLines = new Set<string>()
    for (const o of doc.objects) {
      const visible = !o.hidden && doc.layers[o.kind === 'wall' ? (o.wallType === 'exterior' ? 'wallExt' : 'wallInt') : o.kind === 'column' ? 'column' : o.kind === 'beam' ? 'beam' : o.kind === 'opening' ? 'opening' : o.kind === 'aux' ? 'aux' : 'roof'].visible
      if (visible) continue
      if ('line' in o) hiddenLines.add(o.line)
    }
    if (!snapOn) return { point: world, kind: 'free' }
    return snapPoint(doc, positions, world, { radiusM: SNAP_PX / camera.pxPerM, gridM: showGrid ? GRID_M : null, anchor, exclude, hiddenLines })
  }

  /** Run an action through a preview when it moves other objects. */
  const withPreview = (action: SketchAction, label: string, directly: string[]) => {
    const next = sketchReducer(doc, action)
    if (next === doc) return
    const affected = movedObjects(doc, next).filter((id) => !directly.includes(id))
    if (affected.length === 0) {
      dispatch(action)
      return
    }
    setPending({ next, affected, label })
  }
  const confirmPending = () => {
    if (!pending) return
    dispatch({ kind: 'commitDoc', doc: pending.next })
    setPending(null)
  }

  const cancelAll = () => {
    setDraftStart(null)
    setTyped('')
    setPick(null)
    setDimRefs([])
    setPending(null)
    setHover(null)
    say(null)
  }

  const objectSpecFor = (t: Tool): ObjectSpec | undefined => {
    switch (t) {
      case 'wallExt': return { kind: 'wall', wallType: 'exterior' }
      case 'wallInt': return { kind: 'wall', wallType: 'interior' }
      case 'beam': return { kind: 'beam' }
      case 'aux': return { kind: 'aux', auxType: 'guide' }
      case 'roofEdge': return { kind: 'roofEdge', edgeType: 'eave' }
      default: return undefined
    }
  }
  const isLineTool = tool === 'line' || tool === 'wallExt' || tool === 'wallInt' || tool === 'beam' || tool === 'aux' || tool === 'roofEdge'

  // ---------------------------------------------------------------------
  // pointer handling
  // ---------------------------------------------------------------------
  const commitLine = (end: Snap) => {
    if (!draftStart) return
    const a = draftStart.pointId ? { pointId: draftStart.pointId } : draftStart.point
    const b = end.pointId ? { pointId: end.pointId } : end.point
    const d = sub(end.point, draftStart.point)
    if (Math.hypot(d.x, d.y) < 1e-6) return
    const auto: ('horizontal' | 'vertical')[] = []
    const ang = Math.abs((Math.atan2(d.y, d.x) * 180) / Math.PI)
    if (end.axis === 'horizontal' || ang < 1.5 || ang > 178.5) auto.push('horizontal')
    else if (end.axis === 'vertical' || Math.abs(ang - 90) < 1.5) auto.push('vertical')
    // Settle synchronously so the chain can continue from the NEW end point's
    // id (a chained wall must share its corner point with the previous wall —
    // otherwise the loop never closes and the roof cannot be derived).
    const action: SketchAction = { kind: 'addLine', a, b, auto, as: objectSpecFor(tool), construction: tool === 'aux' }
    const next = sketchReducer(doc, action)
    if (next === doc) return
    dispatch({ kind: 'commitDoc', doc: next })
    const known = new Set(doc.points.map((p) => p.id))
    const newLine = next.lines[next.lines.length - 1]!
    const endId = end.pointId ?? (known.has(newLine.b) ? newLine.b : newLine.b)
    const endPt = pointById(next, endId) ?? end.point
    setDraftStart({ point: { x: endPt.x, y: endPt.y }, kind: 'point', pointId: endId })
    setTyped('')
  }

  const handlePickClick = (p: CanvasPointer): boolean => {
    if (!pick) return false
    const step = pick.steps[pick.collected.length]
    if (!step) return false
    const hit = p.hit
    let id: string | null = null
    if (step.want === 'point') {
      if (hit?.type === 'point') id = hit.id
      else if (hit?.type === 'object' && hit.object.kind === 'column') id = hit.object.point
    } else if (hit?.type === 'object') {
      const o = hit.object
      if (step.want === 'wall' && o.kind === 'wall') id = o.id
      if (step.want === 'extWall' && o.kind === 'wall' && o.wallType === 'exterior') id = o.id
      if (step.want === 'lineObject' && 'line' in o) id = o.id
      if (step.want === 'support' && (o.kind === 'column' || o.kind === 'wall' || o.kind === 'beam')) id = o.id
      if (step.want === 'reference' && (o.kind === 'wall' || o.kind === 'beam')) id = o.id
    }
    if (!id) {
      say('בחר ' + step.hint)
      return true
    }
    const collected = [...pick.collected, id]
    if (collected.length < pick.steps.length) {
      setPick({ ...pick, collected })
      say(pick.steps[collected.length]!.hint)
      return true
    }
    finishPick({ ...pick, collected })
    return true
  }

  const finishPick = (f: PickFlow) => {
    const subject = objectById(doc, f.subject)
    if (!subject) {
      setPick(null)
      return
    }
    let relation: StructuralRelation | null = null
    const measuredFromWall = (targetId: string, wallId: string, ref: 'center' | 'faceA' | 'faceB'): number => {
      const wall = objectById(doc, wallId)
      const t = objectById(doc, targetId)
      if (!wall || wall.kind !== 'wall' || !t) return 0
      const wl = lineById(doc, wall.line)
      if (!wl) return 0
      const a = positions.get(wl.a)!
      const b = positions.get(wl.b)!
      const pt = t.kind === 'column' ? positions.get(t.point) : 'line' in t ? midOfLine(t.line) : null
      if (!pt) return 0
      return signedDist(pt, a, b) - offsetOf(wall, ref)
    }
    const midOfLine = (lineId: string): Pt | null => {
      const l = lineById(doc, lineId)
      if (!l) return null
      const a = positions.get(l.a)!
      const b = positions.get(l.b)!
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
    switch (f.relation) {
      case 'columnOnAxis':
        relation = { id: '', kind: 'columnOnAxis', column: f.subject, line: f.collected[0]! }
        break
      case 'columnAtCorner':
        relation = {
          id: '',
          kind: 'columnAtCorner',
          column: f.subject,
          wallA: f.collected[0]!,
          wallB: f.collected[1]!,
          refA: 'center',
          refB: 'center',
          distA: measuredFromWall(f.subject, f.collected[0]!, 'center'),
          distB: measuredFromWall(f.subject, f.collected[1]!, 'center'),
        }
        break
      case 'offsetFromWall':
        relation = { id: '', kind: 'offsetFromWall', target: f.subject, wall: f.collected[0]!, ref: 'center', distM: measuredFromWall(f.subject, f.collected[0]!, 'center') }
        break
      case 'beamBetween':
        relation = { id: '', kind: 'beamBetween', beam: f.subject, supportA: f.collected[0]!, supportB: f.collected[1]! }
        break
      case 'alignTo': {
        const ref = objectById(doc, f.collected[0]!)
        const t = subject
        const rl = ref && 'line' in ref ? lineById(doc, ref.line) : null
        const tm = 'line' in t ? midOfLine(t.line) : null
        let gap = 0
        if (rl && tm && ref) gap = signedDist(tm, positions.get(rl.a)!, positions.get(rl.b)!) - offsetOf(ref, 'center') + offsetOf(t, 'center')
        relation = { id: '', kind: 'alignTo', target: f.subject, reference: f.collected[0]!, ref: 'center', gapM: gap }
        break
      }
      case 'divide':
        relation = { id: '', kind: 'divide', columns: f.subjects, boundA: f.collected[0]!, boundB: f.collected[1]!, by: 'count' }
        break
      case 'roofOverhang': {
        const wall = objectById(doc, f.collected[0]!)
        let over = 0.5
        if (wall && wall.kind === 'wall' && 'line' in subject) {
          const wl = lineById(doc, wall.line)!
          const tm = midOfLine(subject.line)!
          const sd = signedDist(tm, positions.get(wl.a)!, positions.get(wl.b)!)
          over = Math.max(0, Math.abs(sd) - wall.thicknessM / 2 - Math.abs(offsetOf(wall, 'center')))
        }
        relation = { id: '', kind: 'roofOverhang', roofEdge: f.subject, wall: f.collected[0]!, overhangM: over }
        break
      }
    }
    setPick(null)
    if (!relation) return
    const { id: _drop, ...rest } = relation
    void _drop
    const action: SketchAction = { kind: 'addRelation', relation: rest as never }
    const next = sketchReducer(doc, action)
    if (next === doc) {
      say('לא ניתן היה להוסיף את היחס')
      return
    }
    dispatch(action)
    const after = evaluate(next)
    say(after.solved.ok ? `נוסף: ${RELATION_LABEL_HE[relation.kind]}` : 'היחס נוסף אבל סותר יחסים קיימים — ראה הדגשה באדום')
  }

  const onDown = (p: CanvasPointer) => {
    if (pending) return
    if (p.button === 2) {
      // right click: finish the chain / cancel the flow
      cancelAll()
      return
    }
    if (p.button !== 0) return
    if (pick) {
      handlePickClick(p)
      return
    }
    if (isLineTool) {
      const s = doSnap(p.world, draftStart?.point)
      if (!draftStart) {
        setDraftStart(s)
        say(TOOLS.find((t) => t.id === tool)!.hint)
      } else commitLine(s)
      return
    }
    if (tool === 'column') {
      const s = doSnap(p.world)
      dispatch({ kind: 'addColumn', at: s.pointId ? { pointId: s.pointId } : s.point })
      return
    }
    if (tool === 'opening') {
      if (p.hit?.type === 'object' && p.hit.object.kind === 'wall') {
        const wall = p.hit.object
        const l = lineById(doc, wall.line)!
        const a = positions.get(l.a)!
        const b = positions.get(l.b)!
        const d = sub(b, a)
        const len = Math.hypot(d.x, d.y)
        const t = ((p.world.x - a.x) * d.x + (p.world.y - a.y) * d.y) / (len * len)
        dispatch({ kind: 'addOpening', wall: wall.id, offsetM: Math.max(0.5, Math.min(len - 0.5, t * len)) })
      } else say('לחץ על קיר כדי להוסיף פתח')
      return
    }
    if (tool === 'dimension') {
      handleDimensionClick(p)
      return
    }
    // select tool
    const hit = p.hit
    if (!hit) {
      if (!p.shift) {
        setSelection(new Set())
        setSelectedConstraint(null)
      }
      return
    }
    const id = hit.type === 'object' ? hit.object.id : hit.id
    const next = new Set(p.shift ? selection : [])
    if (p.shift && next.has(id)) next.delete(id)
    else next.add(id)
    setSelection(next)
    setSelectedConstraint(null)
    // start a drag on the hit geometry (if not locked)
    const pointIds = new Set<string>()
    for (const sid of next) {
      const o = objectById(doc, sid)
      if (o) {
        if (o.locked || doc.layers[o.kind === 'wall' ? (o.wallType === 'exterior' ? 'wallExt' : 'wallInt') : o.kind === 'column' ? 'column' : o.kind === 'beam' ? 'beam' : o.kind === 'opening' ? 'opening' : o.kind === 'aux' ? 'aux' : 'roof'].locked) continue
        if (o.kind === 'column') pointIds.add(o.point)
        else if ('line' in o) {
          const l = lineById(doc, o.line)
          if (l) {
            pointIds.add(l.a)
            pointIds.add(l.b)
          }
        }
      } else if (lineById(doc, sid)) {
        const l = lineById(doc, sid)!
        pointIds.add(l.a)
        pointIds.add(l.b)
      } else if (pointById(doc, sid)) pointIds.add(sid)
    }
    if (pointIds.size > 0) {
      const start = new Map<string, Pt>()
      for (const pid of pointIds) start.set(pid, positions.get(pid)!)
      dragRef.current = { pointIds: [...pointIds], startWorld: p.world, start, moved: false }
    }
  }

  const onMove = (p: CanvasPointer) => {
    const drag = dragRef.current
    if (drag) {
      const dx = p.world.x - drag.startWorld.x
      const dy = p.world.y - drag.startWorld.y
      if (!drag.moved) {
        if (Math.hypot(dx, dy) * camera.pxPerM < 3) return
        drag.moved = true
        dispatch({ kind: 'gestureStart' })
      }
      const targets: Record<string, Pt> = {}
      // Single point: snap it; a whole object: translate rigidly.
      if (drag.pointIds.length === 1) {
        const s = doSnap(p.world, undefined, new Set(drag.pointIds))
        targets[drag.pointIds[0]!] = s.point
        setHover(s)
      } else {
        for (const pid of drag.pointIds) {
          const s0 = drag.start.get(pid)!
          targets[pid] = { x: s0.x + dx, y: s0.y + dy }
        }
      }
      dispatch({ kind: 'movePoints', targets })
      return
    }
    if (isLineTool || tool === 'column' || tool === 'dimension' || pick) {
      setHover(doSnap(p.world, draftStart?.point))
    } else if (hover) setHover(null)
  }

  const onUp = () => {
    const drag = dragRef.current
    if (drag) {
      dragRef.current = null
      if (drag.moved) {
        dispatch({ kind: 'gestureEnd' })
        setHover(null)
        if (!evaluate(doc).solved.ok) say('הגרירה הוגבלה על ידי היחסים — נקודה מוגדרת במלואה לא זזה')
      }
    }
  }

  const handleDimensionClick = (p: CanvasPointer) => {
    const hit = p.hit
    const ref = hit ? (hit.type === 'point' ? { id: hit.id, type: 'point' as const } : hit.type === 'line' ? { id: hit.id, type: 'line' as const } : hit.object.kind === 'column' ? { id: hit.object.point, type: 'point' as const } : 'line' in hit.object ? { id: hit.object.line, type: 'line' as const } : null) : null
    const addDim = (dim: Omit<Dimension, 'id' | 'constraintId'>) => {
      const value = measureDimension(doc, dim)
      if (value === null) return
      dispatch({ kind: 'addDimension', dim, value: dim.kind === 'angle' ? value : Math.abs(value) < 1e-9 ? 0 : value })
      setDimRefs([])
      say('נוספה מידה מניעה — ערוך את הערך בפאנל או בלחיצה על המידה')
    }
    if (dimRefs.length === 0) {
      if (!ref) return
      setDimRefs([ref])
      say(ref.type === 'line' ? 'לחץ שוב על ריק = אורך · על נקודה = מרחק מקו · על קו = זווית/מרחק' : 'לחץ על נקודה שנייה = מרחק · על קו = מרחק מקו')
      return
    }
    const first = dimRefs[0]!
    if (!ref) {
      if (first.type === 'line') addDim({ kind: 'length', refs: [first.id], driving: true })
      else setDimRefs([])
      return
    }
    if (ref.id === first.id) {
      if (first.type === 'line') addDim({ kind: 'length', refs: [first.id], driving: true })
      return
    }
    if (first.type === 'point' && ref.type === 'point') addDim({ kind: 'pointDistance', refs: [first.id, ref.id], driving: true })
    else if (first.type === 'point' && ref.type === 'line') addDim({ kind: 'pointLineDistance', refs: [first.id, ref.id], driving: true })
    else if (first.type === 'line' && ref.type === 'point') addDim({ kind: 'pointLineDistance', refs: [ref.id, first.id], driving: true })
    else {
      const ang = measureDimension(doc, { kind: 'angle', refs: [first.id, ref.id] }) ?? 0
      const parallel = Math.abs(ang) < 0.5 || Math.abs(Math.abs(ang) - 180) < 0.5
      addDim(parallel ? { kind: 'lineDistance', refs: [first.id, ref.id], driving: true } : { kind: 'angle', refs: [first.id, ref.id], driving: true })
    }
  }

  // ---------------------------------------------------------------------
  // keyboard
  // ---------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ kind: e.shiftKey ? 'redo' : 'undo' })
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        dispatch({ kind: 'redo' })
        return
      }
      if (e.key === 'Escape') {
        if (pending) setPending(null)
        else if (draftStart || pick || dimRefs.length > 0) cancelAll()
        else {
          setSelection(new Set())
          setSelectedConstraint(null)
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (draftStart && typed.length > 0 && e.key === 'Backspace') {
          setTyped((t) => t.slice(0, -1))
          return
        }
        if (selectedConstraint) {
          dispatch({ kind: 'removeConstraint', id: selectedConstraint })
          setSelectedConstraint(null)
          return
        }
        if (selection.size > 0) {
          for (const id of selection) {
            if (objectById(doc, id)) dispatch({ kind: 'removeObject', id })
            else if (lineById(doc, id)) dispatch({ kind: 'deleteLines', ids: [id] })
          }
          setSelection(new Set())
        }
        return
      }
      if (draftStart) {
        if (/^[0-9.]$/.test(e.key)) {
          setTyped((t) => t + e.key)
          return
        }
        if (e.key === 'Enter' && typed.length > 0) {
          const m = interpretInUnit(typed, unit)
          if (m !== null && m > 0 && hover) {
            const d = sub(hover.point, draftStart.point)
            const len = Math.hypot(d.x, d.y)
            const u = len > 1e-9 ? { x: d.x / len, y: d.y / len } : { x: 1, y: 0 }
            const end: Snap = { point: { x: draftStart.point.x + u.x * m, y: draftStart.point.y + u.y * m }, kind: 'free', axis: hover.axis }
            commitLine(end)
          }
          return
        }
      }
      if (e.key.toLowerCase() === 'f') fit()
      if (e.key.toLowerCase() === 'g') setShowGrid((g) => !g)
      if (e.key === ' ') setTool('select')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------------------------------------------------------------------
  // constraint chips for the current selection
  // ---------------------------------------------------------------------
  type Chip = { he: string; action: SketchAction }
  const chips: Chip[] = []
  if (selLines.length === 1 && selPoints.length === 0) {
    chips.push({ he: 'אופקי', action: { kind: 'addConstraint', c: { kind: 'horizontal', line: selLines[0]! } } })
    chips.push({ he: 'אנכי', action: { kind: 'addConstraint', c: { kind: 'vertical', line: selLines[0]! } } })
    chips.push({ he: 'מידת אורך', action: { kind: 'addDimension', dim: { kind: 'length', refs: [selLines[0]!], driving: true } } })
    chips.push({ he: 'מדידת אורך (ייחוס)', action: { kind: 'addDimension', dim: { kind: 'length', refs: [selLines[0]!], driving: false } } })
  }
  if (selLines.length === 2 && selPoints.length === 0) {
    const [a, b] = selLines as [string, string]
    chips.push({ he: 'מקביל', action: { kind: 'addConstraint', c: { kind: 'parallel', a, b } } })
    chips.push({ he: 'ניצב', action: { kind: 'addConstraint', c: { kind: 'perpendicular', a, b } } })
    chips.push({ he: 'על אותו ציר', action: { kind: 'addConstraint', c: { kind: 'collinear', a, b } } })
    chips.push({ he: 'אורכים שווים', action: { kind: 'addConstraint', c: { kind: 'equalLength', a, b } } })
    chips.push({ he: 'מידת זווית', action: { kind: 'addDimension', dim: { kind: 'angle', refs: [a, b], driving: true } } })
    chips.push({ he: 'מרחק בין קווים', action: { kind: 'addDimension', dim: { kind: 'lineDistance', refs: [a, b], driving: true } } })
  }
  if (selLines.length === 4 && selPoints.length === 0) {
    const [a, b, c, d] = selLines as [string, string, string, string]
    chips.push({ he: 'זוויות שוות (1-2 = 3-4)', action: { kind: 'addConstraint', c: { kind: 'equalAngle', a, b, c, d } } })
  }
  if (selPoints.length === 1 && selLines.length === 0) {
    const p = pointById(doc, selPoints[0]!)!
    chips.push({ he: 'קיבוע נקודה', action: { kind: 'addConstraint', c: { kind: 'fixed', p: p.id, x: p.x, y: p.y } } })
  }
  if (selPoints.length === 2 && selLines.length === 0) {
    const [p, q] = selPoints as [string, string]
    chips.push({ he: 'נקודות מחוברות', action: { kind: 'addConstraint', c: { kind: 'coincident', p, q } } })
    chips.push({ he: 'מידת מרחק', action: { kind: 'addDimension', dim: { kind: 'pointDistance', refs: [p, q], driving: true } } })
    chips.push({ he: 'מדידת מרחק (ייחוס)', action: { kind: 'addDimension', dim: { kind: 'pointDistance', refs: [p, q], driving: false } } })
  }
  if (selPoints.length === 1 && selLines.length === 1) {
    const p = selPoints[0]!
    const line = selLines[0]!
    chips.push({ he: 'נקודה על קו', action: { kind: 'addConstraint', c: { kind: 'pointOnLine', p, line } } })
    chips.push({ he: 'נקודת אמצע', action: { kind: 'addConstraint', c: { kind: 'midpoint', p, line } } })
    chips.push({ he: 'מידת מרחק מקו', action: { kind: 'addDimension', dim: { kind: 'pointLineDistance', refs: [p, line], driving: true } } })
  }
  if (selPoints.length === 2 && selLines.length === 1) {
    const [p, q] = selPoints as [string, string]
    chips.push({ he: 'סימטריה סביב הקו', action: { kind: 'addConstraint', c: { kind: 'symmetric', p, q, axis: selLines[0]! } } })
  }
  if (selPoints.length === 1 && selLines.length === 2) {
    const [a, b] = selLines as [string, string]
    chips.push({ he: 'מרכוז בין הקווים', action: { kind: 'addConstraint', c: { kind: 'centered', p: selPoints[0]!, a, b } } })
  }
  const applyChip = (chip: Chip) => {
    const next = sketchReducer(doc, chip.action)
    if (next === doc) {
      say('לא ניתן להוסיף את היחס לבחירה הזו')
      return
    }
    dispatch(chip.action)
    const after = evaluate(next)
    say(after.solved.ok ? `נוסף: ${chip.he}` : `«${chip.he}» סותר יחס קיים — היחסים הסותרים מודגשים באדום; מחק או ערוך אחד מהם`)
  }

  // relation starters for the selection
  type RelStarter = { he: string; flow: PickFlow }
  const starters: RelStarter[] = []
  const single = selectedObjects.length === 1 ? selectedObjects[0]! : null
  if (single) {
    if (single.kind === 'column') {
      starters.push({ he: 'על ציר / קו', flow: { relation: 'columnOnAxis', subject: single.id, subjects: [], steps: [{ want: 'lineObject', hint: 'ציר, קו עזר, קיר או קורה' }], collected: [] } })
      starters.push({ he: 'בפינת קיר', flow: { relation: 'columnAtCorner', subject: single.id, subjects: [], steps: [{ want: 'wall', hint: 'קיר ראשון' }, { want: 'wall', hint: 'קיר שני' }], collected: [] } })
      starters.push({ he: 'מרחק מקיר', flow: { relation: 'offsetFromWall', subject: single.id, subjects: [], steps: [{ want: 'wall', hint: 'קיר' }], collected: [] } })
    }
    if (single.kind === 'beam') {
      starters.push({ he: 'בין שתי תמיכות', flow: { relation: 'beamBetween', subject: single.id, subjects: [], steps: [{ want: 'support', hint: 'תמיכה ראשונה (עמוד / קיר / קורה)' }, { want: 'support', hint: 'תמיכה שנייה' }], collected: [] } })
    }
    if ('line' in single) {
      starters.push({ he: 'יישור לפי קיר/קורה', flow: { relation: 'alignTo', subject: single.id, subjects: [], steps: [{ want: 'reference', hint: 'קיר או קורה לייחוס' }], collected: [] } })
      if (single.kind !== 'wall') starters.push({ he: 'מרחק מקיר', flow: { relation: 'offsetFromWall', subject: single.id, subjects: [], steps: [{ want: 'wall', hint: 'קיר' }], collected: [] } })
    }
    if (single.kind === 'roofEdge') {
      starters.push({ he: 'בליטת גג מקיר חוץ', flow: { relation: 'roofOverhang', subject: single.id, subjects: [], steps: [{ want: 'extWall', hint: 'קיר חוץ' }], collected: [] } })
    }
  }
  const selectedColumns = selectedObjects.filter((o) => o.kind === 'column')
  if (selectedColumns.length >= 1 && selectedColumns.length === selectedObjects.length) {
    starters.push({ he: `חלוקה (${selectedColumns.length} עמודים) בין שני גבולות`, flow: { relation: 'divide', subject: selectedColumns[0]!.id, subjects: selectedColumns.map((c) => c.id), steps: [{ want: 'point', hint: 'נקודת גבול ראשונה' }, { want: 'point', hint: 'נקודת גבול שנייה' }], collected: [] } })
  }

  // ---------------------------------------------------------------------
  // derived UI bits
  // ---------------------------------------------------------------------
  const draft: Draft | null = draftStart && hover ? { from: draftStart.point, to: hover.point } : null
  const preview: PreviewGhost | null = pending
    ? { positions: new Map(pending.next.points.map((p) => [p.id, { x: p.x, y: p.y }])), affected: new Set(pending.affected) }
    : null
  const highlight = useMemo(() => {
    const s = new Set<string>()
    if (pick) for (const id of pick.collected) s.add(id)
    for (const r of dimRefs) s.add(r.id)
    if (selectedConstraint) {
      const c = doc.constraints.find((x) => x.id === selectedConstraint)
      if (c) for (const r of constraintRefs(c)) s.add(r)
    }
    return s
  }, [pick, dimRefs, selectedConstraint, doc.constraints])
  const conflictNames = [...ev.analysis.conflictObjects].map((id) => objectById(doc, id)?.name ?? id)
  const conflictLabels = ev.analysis.conflicts.map((cid) => {
    const c = doc.constraints.find((x) => x.id === cid)
    if (c) return CONSTRAINT_LABEL_HE[c.kind]
    const rid = cid.split('~')[0]!
    const r = doc.relations.find((x) => x.id === rid)
    return r ? RELATION_LABEL_HE[r.kind] : cid
  })
  const cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair'
  const hint = pending
    ? `השינוי «${pending.label}» יזיז גם: ${pending.affected.map((id) => objectById(doc, id)?.name ?? id).join(', ')}`
    : pick
      ? `${RELATION_LABEL_HE[pick.relation]}: בחר ${pick.steps[pick.collected.length]?.hint ?? ''}`
      : message ?? TOOLS.find((t) => t.id === tool)?.hint ?? ''

  const build = () => {
    if (!derivation.ok) return
    const withSlope = sketchReducer(sketchReducer(doc, { kind: 'setRoofSlope', slopePct }), { kind: 'setRoofSupports', supports: derivation.supports })
    dispatch({ kind: 'commitDoc', doc: withSlope })
    onBuildRoof?.({ doc: withSlope, derivation })
  }

  const zoomStep = (f: number) => {
    const { w, h } = sizeRef.current
    setCamera((c) => zoomAt(c, w, h, { x: w / 2, y: h / 2 }, f))
  }

  return (
    <div dir="rtl" className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg text-fg" data-testid="parametric-sketcher">
      {/* top bar */}
      <header className="flex min-h-[48px] items-center gap-2 border-b border-border bg-surface px-3 py-1">
        <span className="text-sm font-medium">{title ?? 'שרטוט פרמטרי'}</span>
        <span aria-hidden className="h-5 w-px bg-border" />
        <button type="button" className={chipCls} title="בטל (Ctrl+Z)" disabled={hist.past.length === 0} onClick={() => dispatch({ kind: 'undo' })}><Undo2 size={14} /></button>
        <button type="button" className={chipCls} title="בצע שוב (Ctrl+Y)" disabled={hist.future.length === 0} onClick={() => dispatch({ kind: 'redo' })}><Redo2 size={14} /></button>
        <span aria-hidden className="h-5 w-px bg-border" />
        <button type="button" className={chipCls} title="התאם לתצוגה (F)" onClick={fit}><Maximize2 size={14} /></button>
        <button type="button" className={chipCls} title="הגדל" onClick={() => zoomStep(1.25)}><Plus size={14} /></button>
        <button type="button" className={chipCls} title="הקטן" onClick={() => zoomStep(1 / 1.25)}><Minus size={14} /></button>
        <button type="button" className={showGrid ? chipOn : chipCls} title="רשת (G)" onClick={() => setShowGrid((g) => !g)}><Grid2x2 size={14} /></button>
        <button type="button" className={snapOn ? chipOn : chipCls} title="הצמדה" onClick={() => setSnapOn((s) => !s)}><Crosshair size={14} /></button>
        <span className="tnum text-xs text-muted">{Math.round(camera.pxPerM)} px/m</span>
        <span className="flex-1" />
        <span
          className={'rounded-md border px-2 py-0.5 text-xs ' + (ev.analysis.conflicts.length > 0 ? 'border-danger bg-danger-soft text-danger' : ev.analysis.dof === 0 ? 'border-brand bg-brand-soft' : 'border-border')}
          title="מה עדיין חופשי לזוז ומה מוגדר במלואו"
          data-testid="dof-chip"
        >
          {ev.analysis.conflicts.length > 0
            ? `סתירה: ${ev.analysis.conflicts.length} יחסים`
            : ev.analysis.dof === 0
              ? 'מוגדר במלואו'
              : `דרגות חופש: ${ev.analysis.dof} · נקודות חופשיות: ${ev.analysis.freePoints.size}`}
        </span>
        <button type="button" className="min-h-[36px] rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-50" disabled={!derivation.ok} onClick={build}>
          {roofExists ? 'עדכן גג מהשרטוט' : 'צור גג מהשרטוט'}
        </button>
        <button type="button" className={chipCls} title="סגור" onClick={onClose}><X size={14} /></button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* tool rail */}
        <aside className="flex w-[72px] flex-col items-stretch gap-1 overflow-y-auto border-l border-border bg-surface p-1">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tool === t.id}
              title={t.hint}
              onClick={() => {
                setTool(t.id)
                cancelAll()
                say(t.hint)
              }}
              className={'flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-md border text-[10px] ' + (tool === t.id ? 'border-brand bg-brand text-white' : 'border-transparent text-fg hover:bg-surface-2')}
            >
              <t.icon size={16} strokeWidth={1.75} />
              {t.he}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            title="מחק את הבחירה (Delete)"
            disabled={selection.size === 0 && !selectedConstraint}
            onClick={() => {
              if (selectedConstraint) {
                dispatch({ kind: 'removeConstraint', id: selectedConstraint })
                setSelectedConstraint(null)
                return
              }
              for (const id of selection) {
                if (objectById(doc, id)) dispatch({ kind: 'removeObject', id })
                else if (lineById(doc, id)) dispatch({ kind: 'deleteLines', ids: [id] })
              }
              setSelection(new Set())
            }}
            className="flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-md border border-transparent text-[10px] text-danger hover:bg-danger-soft disabled:opacity-40"
          >
            <Trash2 size={16} strokeWidth={1.75} />
            מחיקה
          </button>
        </aside>

        {/* canvas */}
        <main className="relative min-w-0 flex-1">
          <SketchCanvas
            doc={doc}
            positions={positions}
            evaluation={ev}
            selection={selection}
            highlight={highlight}
            snap={hover}
            draft={draft}
            preview={preview}
            camera={camera}
            onCamera={setCamera}
            showGrid={showGrid}
            panMode={tool === 'pan'}
            unit={unit}
            cursor={cursor}
            typed={typed}
            onDown={onDown}
            onMove={onMove}
            onUp={onUp}
            onSize={onSize}
            onDimensionClick={(id) => {
              const d = doc.dimensions.find((x) => x.id === id)
              if (!d) return
              setTool('select')
              setSelection(new Set())
              setSelectedConstraint(d.constraintId ?? null)
              if (d.driving && d.constraintId) {
                const cur = measureDimension(doc, d) ?? 0
                const raw = window.prompt(`ערך חדש (${d.kind === 'angle' ? 'מעלות' : unit})`, d.kind === 'angle' ? cur.toFixed(1) : formatLength(Math.abs(cur), unit))
                if (raw === null) return
                const v = d.kind === 'angle' ? parseFloat(raw) : interpretInUnit(raw, unit)
                if (v === null || !Number.isFinite(v)) return
                withPreview({ kind: 'setConstraintValue', id: d.constraintId, value: v }, 'מידה', [])
              }
            }}
            onConstraintClick={(id) => {
              setSelectedConstraint(id)
              const c = doc.constraints.find((x) => x.id === id)
              if (c) say(`${CONSTRAINT_LABEL_HE[c.kind]} — Delete מוחק`)
            }}
          />
          {/* hint / message bar */}
          <div className={'pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-md border px-3 py-1 text-xs shadow-card ' + (pending ? 'border-brand bg-brand-soft' : 'border-border bg-surface/95')} data-testid="hint-bar">
            <span className="flex-1 truncate">{hint}</span>
            {pending && (
              <span className="pointer-events-auto flex gap-1">
                <button type="button" className={chipOn} onClick={confirmPending}>אשר</button>
                <button type="button" className={chipCls} onClick={() => setPending(null)}>בטל</button>
              </span>
            )}
          </div>
          {ev.analysis.conflicts.length > 0 && !pending && (
            <div className="absolute inset-x-2 top-2 rounded-md border border-danger bg-danger-soft px-3 py-1.5 text-xs text-danger shadow-card" data-testid="conflict-banner">
              <b>אילוצים סותרים</b> — הגאומטריה נשארה במצב העקבי האחרון. הסר או ערוך אחד מהיחסים המודגשים: {conflictLabels.join(', ')}
              {conflictNames.length > 0 && <> · אובייקטים מעורבים: {conflictNames.join(', ')}</>}
            </div>
          )}
        </main>

        {/* properties */}
        <aside className="flex w-[300px] flex-col gap-2 overflow-y-auto border-r border-border bg-bg p-2">
          {pick && (
            <div className={panelCls + ' border-brand'}>
              <div className="text-xs">{RELATION_LABEL_HE[pick.relation]} · {pick.collected.length}/{pick.steps.length}</div>
              <div className="text-[11px] text-muted">לחץ על הבד: {pick.steps[pick.collected.length]?.hint}</div>
              <button type="button" className={chipCls + ' mt-1'} onClick={() => setPick(null)}>בטל</button>
            </div>
          )}
          {selectedObjects.length === 1 && (
            <ObjectProperties
              o={selectedObjects[0]!}
              unit={unit}
              onPatch={(patch) => withPreview({ kind: 'updateObject', id: selectedObjects[0]!.id, patch }, `עריכת ${selectedObjects[0]!.name}`, [selectedObjects[0]!.id])}
              onRemove={() => {
                dispatch({ kind: 'removeObject', id: selectedObjects[0]!.id })
                setSelection(new Set())
              }}
            />
          )}
          {selectedObjects.length > 1 && (
            <div className={panelCls + ' text-xs'}>{selectedObjects.length} אובייקטים נבחרו: {selectedObjects.map((o) => `${OBJECT_LABEL_HE[o.kind]} ${o.name}`).join(', ')}</div>
          )}
          {selection.size > 0 && selectedObjects.length === 0 && (
            <div className={panelCls + ' text-xs'}>
              {selPoints.length > 0 && <div>נקודות: {selPoints.map((p) => (ev.analysis.freePoints.has(p) ? `${p} (חופשית)` : `${p} (מוגדרת)`)).join(', ')}</div>}
              {selLines.length > 0 && <div>קווים: {selLines.join(', ')}</div>}
              {selLines.length === 1 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className="text-[11px] text-muted">המר ל:</span>
                  {([['קיר חוץ', { kind: 'wall', wallType: 'exterior' }], ['קיר פנים', { kind: 'wall', wallType: 'interior' }], ['קורה', { kind: 'beam' }], ['קו עזר', { kind: 'aux', auxType: 'guide' }], ['ציר', { kind: 'aux', auxType: 'axis' }], ['קצה גג', { kind: 'roofEdge', edgeType: 'eave' }]] as [string, ObjectSpec][]).map(([he, as]) => (
                    <button key={he} type="button" className={chipCls} onClick={() => dispatch({ kind: 'convertLine', line: selLines[0]!, as })}>{he}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {chips.length > 0 && (
            <div className={panelCls}>
              <div className="mb-1 text-xs font-medium">הוסף יחס גאומטרי</div>
              <div className="flex flex-wrap gap-1">
                {chips.map((c) => <button key={c.he} type="button" className={chipCls} onClick={() => applyChip(c)}>{c.he}</button>)}
              </div>
            </div>
          )}
          {starters.length > 0 && (
            <div className={panelCls}>
              <div className="mb-1 text-xs font-medium">הוסף יחס מבני</div>
              <div className="flex flex-wrap gap-1">
                {starters.map((s) => (
                  <button key={s.he} type="button" className={chipCls} onClick={() => { setPick(s.flow); setTool('select'); say(s.flow.steps[0]!.hint) }}>{s.he}</button>
                ))}
              </div>
            </div>
          )}
          <ConstraintList
            doc={doc}
            ev={ev}
            ids={selection.size > 0 ? constraintsOfSelection : selectedConstraint ? [selectedConstraint] : ev.analysis.conflicts.filter((c) => doc.constraints.some((x) => x.id === c))}
            unit={unit}
            selectedId={selectedConstraint}
            onSelect={setSelectedConstraint}
            onRemove={(id) => {
              dispatch({ kind: 'removeConstraint', id })
              if (selectedConstraint === id) setSelectedConstraint(null)
            }}
            onSetValue={(id, v) => withPreview({ kind: 'setConstraintValue', id, value: v }, 'שינוי מידה', [])}
            onToggleDriving={(d) => dispatch({ kind: 'setDimensionDriving', id: d.id, driving: false })}
          />
          <ReferenceDimensionList doc={doc} dims={selection.size > 0 ? refDimsOfSelection : doc.dimensions.filter((d) => !d.driving)} unit={unit} onRemove={(id) => dispatch({ kind: 'removeDimension', id })} onMakeDriving={(d) => dispatch({ kind: 'setDimensionDriving', id: d.id, driving: true })} />
          <RelationList
            doc={doc}
            ev={ev}
            relations={selection.size > 0 ? relationsOfSelection : doc.relations}
            unit={unit}
            onRemove={(id) => dispatch({ kind: 'removeRelation', id })}
            onPatch={(id, patch) => withPreview({ kind: 'updateRelation', id, patch }, 'שינוי יחס', [])}
          />
          <RoofPanel doc={doc} derivation={derivation} slopePct={slopePct} onSlope={setSlopePct} onBuild={build} buildLabel={roofExists ? 'עדכן גג מהשרטוט' : 'צור גג מהשרטוט'} />
          <LayersPanel doc={doc} onSet={(key, patch) => dispatch({ kind: 'setLayer', key, patch })} />
          <div className="text-[10px] text-muted">
            אובייקטים: {doc.objects.length} · יחסים: {doc.constraints.length + doc.relations.length} · מידות: {doc.dimensions.length}
            {ev.analysis.redundant.length > 0 && <> · יחסים כפולים: {ev.analysis.redundant.length}</>}
          </div>
        </aside>
      </div>
    </div>
  )
}

