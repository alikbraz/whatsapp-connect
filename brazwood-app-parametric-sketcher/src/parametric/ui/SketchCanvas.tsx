// src/parametric/ui/SketchCanvas.tsx
// The drawing surface of the parametric sketcher (owner brief §5): a fixed,
// full-size SVG — never a scrolling page. Wheel = zoom about the cursor,
// middle button (or the hand tool) = pan. Renders geometry, semantic objects,
// dimensions (driving = boxed, reference = in parentheses), constraint
// badges, free/defined points, conflicts (red) and the live preview ghost.
// All logic lives in ParametricSketcher.tsx; this file only draws and
// forwards pointer events in WORLD coordinates.
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react'
import type { Constraint, Dimension, Pt, SketchDoc, SketchObject } from '../model'
import { CONSTRAINT_LABEL_HE, constraintRefs, layerOf, lineById } from '../model'
import { bodyPolygon, columnPolygon, openingGeometry } from '../objects'
import { add, leftNormal, mid, scale, sub, unit as unitVec } from '../geom'
import type { Evaluation } from '../doc'
import { measureDimension } from '../doc'
import { formatLength, type LengthUnit } from '../../roofwizard/units'
import { gridStepM, panBy, toScreen, toWorld, zoomAt, type Camera } from './camera'
import type { Snap } from './snap'
import { hitTest, type Hit } from './hit'

export interface Draft {
  from: Pt
  to: Pt
}

export interface PreviewGhost {
  positions: ReadonlyMap<string, Pt>
  affected: ReadonlySet<string>
}

export interface CanvasPointer {
  world: Pt
  screen: Pt
  hit: Hit | null
  button: number
  shift: boolean
}

export interface SketchCanvasProps {
  doc: SketchDoc
  positions: ReadonlyMap<string, Pt>
  evaluation: Evaluation
  selection: ReadonlySet<string>
  /** Ids to emphasise during a pick flow (candidates). */
  highlight: ReadonlySet<string>
  snap: Snap | null
  draft: Draft | null
  preview: PreviewGhost | null
  camera: Camera
  onCamera: (c: Camera) => void
  showGrid: boolean
  panMode: boolean
  unit: LengthUnit
  cursor: string
  onDown: (p: CanvasPointer, ev: RPointerEvent<SVGSVGElement>) => void
  onMove: (p: CanvasPointer, ev: RPointerEvent<SVGSVGElement>) => void
  onUp: (p: CanvasPointer, ev: RPointerEvent<SVGSVGElement>) => void
  onDimensionClick: (id: string) => void
  onConstraintClick: (id: string) => void
  onSize: (w: number, h: number) => void
  /** Typed-length readout while drawing (owner: numeric entry on the fly). */
  typed?: string
}

const HIT_TOL_PX = 9

const C = {
  grid: '#ececea',
  gridMajor: '#dcdcd8',
  axis: '#c9c9c4',
  line: '#1f1f1f',
  wallExt: '#c7c7c2',
  wallInt: '#e4e4e0',
  wallStroke: '#4a4a46',
  beam: '#8b6a3e',
  beamFill: '#e9dcc8',
  column: '#3f3f3b',
  opening: '#ffffff',
  aux: '#7a8aa6',
  roof: '#3f4a6b',
  sel: '#2563eb',
  free: '#2563eb',
  defined: '#1f1f1f',
  conflict: '#c0392b',
  ghost: '#3f4a6b',
  dimDriving: '#1f1f1f',
  dimRef: '#6b6b66',
  snap: '#059669',
  hl: '#d97706',
} as const

export function SketchCanvas(props: SketchCanvasProps) {
  const { doc, positions, evaluation, selection, highlight, snap, draft, preview, camera, onCamera, showGrid, panMode, unit, cursor } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const panRef = useRef<{ x: number; y: number; cam: Camera } | null>(null)

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r) return
      const w = Math.max(1, Math.round(r.width))
      const h = Math.max(1, Math.round(r.height))
      setSize({ w, h })
      props.onSize(w, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Non-passive wheel listener: the page must never scroll under the canvas.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const h = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  const { w, h } = size
  const S = useCallback((p: Pt): Pt => toScreen(camera, w, h, p), [camera, w, h])
  const P = (id: string): Pt | undefined => positions.get(id)

  const screenOf = (ev: RPointerEvent<SVGSVGElement> | RWheelEvent<SVGSVGElement>): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ev.clientX - r.left, y: ev.clientY - r.top }
  }
  const pointerInfo = (ev: RPointerEvent<SVGSVGElement>): CanvasPointer => {
    const screen = screenOf(ev)
    const world = toWorld(camera, w, h, screen)
    const hit = hitTest(doc, positions, world, HIT_TOL_PX / camera.pxPerM)
    return { world, screen, hit, button: ev.button, shift: ev.shiftKey }
  }

  const onWheel = (ev: RWheelEvent<SVGSVGElement>) => {
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15
    onCamera(zoomAt(camera, w, h, screenOf(ev), factor))
  }
  const onPointerDown = (ev: RPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(ev.pointerId)
    if (ev.button === 1 || (panMode && ev.button === 0)) {
      panRef.current = { x: ev.clientX, y: ev.clientY, cam: camera }
      ev.preventDefault()
      return
    }
    props.onDown(pointerInfo(ev), ev)
  }
  const onPointerMove = (ev: RPointerEvent<SVGSVGElement>) => {
    if (panRef.current) {
      const { x, y, cam } = panRef.current
      onCamera(panBy(cam, ev.clientX - x, ev.clientY - y))
      return
    }
    props.onMove(pointerInfo(ev), ev)
  }
  const onPointerUp = (ev: RPointerEvent<SVGSVGElement>) => {
    if (panRef.current) {
      panRef.current = null
      return
    }
    props.onUp(pointerInfo(ev), ev)
  }

  // ---- derived render data
  const layerVisible = (o: SketchObject): boolean => !o.hidden && doc.layers[layerOf(o)].visible
  const ownedLines = new Set<string>()
  for (const o of doc.objects) {
    if ('line' in o) ownedLines.add(o.line)
    if (o.kind === 'roofOutline') for (const l of o.lines) ownedLines.add(l)
  }
  const hiddenLines = new Set<string>()
  for (const o of doc.objects) {
    if (layerVisible(o)) continue
    if ('line' in o) hiddenLines.add(o.line)
    if (o.kind === 'roofOutline') for (const l of o.lines) hiddenLines.add(l)
  }
  const conflictPts = new Set<string>()
  const conflictLines = new Set<string>()
  for (const c of [...doc.constraints]) {
    if (evaluation.analysis.status.get(c.id) !== 'conflict') continue
    for (const r of constraintRefs(c)) {
      if (lineById(doc, r)) conflictLines.add(r)
      else conflictPts.add(r)
    }
  }
  const conflictObjects = evaluation.analysis.conflictObjects
  const isSel = (id: string): boolean => selection.has(id)

  const strokeFor = (id: string, base: string): string =>
    isSel(id) ? C.sel : highlight.has(id) ? C.hl : conflictLines.has(id) || conflictObjects.has(id) ? C.conflict : base

  // ---- grid
  const gridEls: React.ReactNode[] = []
  if (showGrid) {
    const step = gridStepM(camera.pxPerM)
    const tl = toWorld(camera, w, h, { x: 0, y: 0 })
    const br = toWorld(camera, w, h, { x: w, y: h })
    const x0 = Math.floor(tl.x / step) * step
    const x1 = Math.ceil(br.x / step) * step
    const y0 = Math.floor(br.y / step) * step
    const y1 = Math.ceil(tl.y / step) * step
    const count = (x1 - x0) / step + (y1 - y0) / step
    if (count < 600) {
      for (let x = x0; x <= x1 + 1e-9; x += step) {
        const major = Math.abs(Math.round(x / step) % 5) === 0
        const sx = S({ x, y: 0 }).x
        gridEls.push(<line key={`gx${x.toFixed(4)}`} x1={sx} y1={0} x2={sx} y2={h} stroke={Math.abs(x) < 1e-9 ? C.axis : major ? C.gridMajor : C.grid} strokeWidth={Math.abs(x) < 1e-9 ? 1.5 : 1} />)
      }
      for (let y = y0; y <= y1 + 1e-9; y += step) {
        const major = Math.abs(Math.round(y / step) % 5) === 0
        const sy = S({ x: 0, y }).y
        gridEls.push(<line key={`gy${y.toFixed(4)}`} x1={0} y1={sy} x2={w} y2={sy} stroke={Math.abs(y) < 1e-9 ? C.axis : major ? C.gridMajor : C.grid} strokeWidth={Math.abs(y) < 1e-9 ? 1.5 : 1} />)
      }
    }
  }

  // ---- preview ghost
  const ghostEls: React.ReactNode[] = []
  if (preview) {
    for (const l of doc.lines) {
      const a = preview.positions.get(l.a)
      const b = preview.positions.get(l.b)
      if (!a || !b) continue
      const sa = S(a)
      const sb = S(b)
      ghostEls.push(<line key={`g${l.id}`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={C.ghost} strokeWidth={1.5} strokeDasharray="6 4" opacity={0.7} />)
    }
    for (const o of doc.objects) {
      if (!preview.affected.has(o.id)) continue
      const poly = o.kind === 'column' ? columnPolygon(doc, o, preview.positions) : o.kind === 'wall' || o.kind === 'beam' ? bodyPolygon(doc, o, preview.positions) : null
      if (poly) ghostEls.push(<polygon key={`gp${o.id}`} points={poly.map((p) => `${S(p).x},${S(p).y}`).join(' ')} fill="none" stroke={C.ghost} strokeWidth={1.5} strokeDasharray="6 4" opacity={0.8} />)
    }
  }

  // ---- objects
  const objEls: React.ReactNode[] = []
  const labelEls: React.ReactNode[] = []
  const sorted = [...doc.objects].sort((a, b) => drawRank(a) - drawRank(b))
  for (const o of sorted) {
    if (!layerVisible(o)) continue
    const stroke = strokeFor(o.id, C.wallStroke)
    const sw = isSel(o.id) || highlight.has(o.id) ? 2.5 : 1.25
    if (o.kind === 'wall' || o.kind === 'beam') {
      const poly = bodyPolygon(doc, o, positions)
      if (!poly) continue
      const pts = poly.map((p) => S(p))
      const fill = o.kind === 'wall' ? (o.wallType === 'exterior' ? C.wallExt : C.wallInt) : C.beamFill
      objEls.push(
        <polygon
          key={o.id}
          points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
          fill={fill}
          stroke={o.kind === 'beam' ? strokeFor(o.id, C.beam) : stroke}
          strokeWidth={sw}
          strokeDasharray={o.role === 'non-bearing' ? '4 3' : undefined}
          data-object={o.id}
        />,
      )
      const seg = lineById(doc, o.line)
      const a = seg ? P(seg.a) : undefined
      const b = seg ? P(seg.b) : undefined
      if (a && b) {
        const sa = S(a)
        const sb = S(b)
        objEls.push(<line key={`${o.id}-axis`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={o.kind === 'beam' ? C.beam : C.wallStroke} strokeWidth={0.75} strokeDasharray={o.kind === 'beam' ? '8 4' : undefined} opacity={0.8} />)
        const m = S(mid(a, b))
        labelEls.push(<text key={`${o.id}-n`} x={m.x} y={m.y - 6} fontSize={11} textAnchor="middle" fill={C.line} className="select-none">{o.name}</text>)
      }
    } else if (o.kind === 'column') {
      const poly = columnPolygon(doc, o, positions)
      if (!poly) continue
      const pts = poly.map((p) => S(p))
      objEls.push(
        <polygon key={o.id} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={o.role === 'bearing' ? C.column : '#9a9a95'} stroke={strokeFor(o.id, C.column)} strokeWidth={sw} data-object={o.id} />,
      )
      const c = P(o.point)
      if (c) {
        const sc = S(c)
        labelEls.push(<text key={`${o.id}-n`} x={sc.x + 10} y={sc.y - 8} fontSize={11} fill={C.line} className="select-none">{o.name}</text>)
      }
    } else if (o.kind === 'opening') {
      const g = openingGeometry(doc, o, positions)
      if (!g) continue
      const pts = g.polygon.map((p) => S(p))
      objEls.push(<polygon key={o.id} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={C.opening} stroke={strokeFor(o.id, C.wallStroke)} strokeWidth={sw} data-object={o.id} />)
      const sa = S(g.seg.a)
      const sb = S(g.seg.b)
      objEls.push(<line key={`${o.id}-s`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={C.wallStroke} strokeWidth={0.75} />)
      const m = S(mid(g.seg.a, g.seg.b))
      labelEls.push(<text key={`${o.id}-n`} x={m.x} y={m.y + 4} fontSize={10} textAnchor="middle" fill={C.line} className="select-none">{o.name}</text>)
    } else if (o.kind === 'aux' || o.kind === 'roofEdge') {
      const seg = lineById(doc, o.line)
      const a = seg ? P(seg.a) : undefined
      const b = seg ? P(seg.b) : undefined
      if (!a || !b) continue
      const sa = S(a)
      const sb = S(b)
      const base = o.kind === 'aux' ? C.aux : C.roof
      objEls.push(
        <line key={o.id} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={strokeFor(o.id, base)} strokeWidth={isSel(o.id) ? 2.5 : o.kind === 'roofEdge' ? 2 : 1} strokeDasharray={o.kind === 'aux' ? (o.auxType === 'axis' ? '14 4 2 4' : '5 4') : '10 4 2 4'} data-object={o.id} />,
      )
      const m = S(mid(a, b))
      labelEls.push(<text key={`${o.id}-n`} x={m.x} y={m.y - 5} fontSize={10} textAnchor="middle" fill={base} className="select-none">{o.name}</text>)
    } else if (o.kind === 'roofOutline') {
      const pts: Pt[] = []
      for (const lid of o.lines) {
        const l = lineById(doc, lid)
        const a = l ? P(l.a) : undefined
        const b = l ? P(l.b) : undefined
        if (a && b) pts.push(a, b)
      }
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const sa = S(pts[i]!)
        const sb = S(pts[i + 1]!)
        objEls.push(<line key={`${o.id}-${i}`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={strokeFor(o.id, C.roof)} strokeWidth={2.5} strokeDasharray="12 5" />)
      }
    }
  }

  // ---- bare lines (no owner)
  const lineEls: React.ReactNode[] = []
  for (const l of doc.lines) {
    if (ownedLines.has(l.id) || hiddenLines.has(l.id)) continue
    const a = P(l.a)
    const b = P(l.b)
    if (!a || !b) continue
    const sa = S(a)
    const sb = S(b)
    lineEls.push(
      <line key={l.id} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={strokeFor(l.id, l.construction ? C.aux : C.line)} strokeWidth={isSel(l.id) ? 2.5 : 1.5} strokeDasharray={l.construction ? '5 4' : undefined} data-line={l.id} />,
    )
  }

  // ---- points
  const pointEls: React.ReactNode[] = []
  const visiblePoint = (id: string): boolean => {
    const owners = doc.lines.filter((l) => l.a === id || l.b === id)
    if (owners.length > 0 && owners.every((l) => hiddenLines.has(l.id))) return false
    return true
  }
  for (const pt of doc.points) {
    if (!visiblePoint(pt.id)) continue
    const p = P(pt.id) ?? pt
    const s = S(p)
    const free = evaluation.analysis.freePoints.has(pt.id)
    const conflict = conflictPts.has(pt.id)
    const sel = isSel(pt.id)
    pointEls.push(
      <circle
        key={pt.id}
        cx={s.x}
        cy={s.y}
        r={sel ? 5 : 3.5}
        fill={conflict ? C.conflict : free ? '#ffffff' : C.defined}
        stroke={sel ? C.sel : conflict ? C.conflict : free ? C.free : C.defined}
        strokeWidth={sel ? 2 : 1.5}
        data-point={pt.id}
      />,
    )
  }

  // ---- dimensions
  const dimEls: React.ReactNode[] = []
  if (doc.layers.dims.visible) {
    for (const d of doc.dimensions) {
      const el = renderDimension(doc, positions, d, S, unit, evaluation, isSel(d.id), () => props.onDimensionClick(d.id))
      if (el) dimEls.push(el)
    }
  }

  // ---- constraint badges
  const badgeEls: React.ReactNode[] = []
  if (doc.layers.constraints.visible) {
    const perAnchor = new Map<string, number>()
    for (const c of doc.constraints) {
      if (dimensionOf(doc, c.id)) continue // shown as a dimension already
      const anchor = constraintAnchor(doc, positions, c)
      if (!anchor) continue
      const key = `${anchor.x.toFixed(3)},${anchor.y.toFixed(3)}`
      const k = perAnchor.get(key) ?? 0
      perAnchor.set(key, k + 1)
      const s = S(anchor)
      const st = evaluation.analysis.status.get(c.id)
      const color = st === 'conflict' ? C.conflict : st === 'redundant' ? C.hl : isSel(c.id) ? C.sel : '#555552'
      badgeEls.push(
        <g key={c.id} transform={`translate(${s.x + 8 + k * 18},${s.y + 8})`} onClick={(e) => { e.stopPropagation(); props.onConstraintClick(c.id) }} style={{ cursor: 'pointer' }}>
          <title>{CONSTRAINT_LABEL_HE[c.kind]}</title>
          <rect x={0} y={0} width={16} height={14} rx={3} fill="#ffffff" stroke={color} strokeWidth={isSel(c.id) ? 1.75 : 1} />
          <text x={8} y={10.5} fontSize={9} textAnchor="middle" fill={color} className="select-none">{GLYPH[c.kind]}</text>
        </g>,
      )
    }
  }

  // ---- draft + snap + typed readout
  const overlayEls: React.ReactNode[] = []
  if (draft) {
    const sa = S(draft.from)
    const sb = S(draft.to)
    const d = sub(draft.to, draft.from)
    const lengthM = Math.hypot(d.x, d.y)
    const ang = (Math.atan2(d.y, d.x) * 180) / Math.PI
    overlayEls.push(<line key="draft" x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={C.sel} strokeWidth={1.5} strokeDasharray="4 3" />)
    const label = props.typed && props.typed.length > 0 ? `${props.typed}▏` : formatLength(lengthM, unit)
    overlayEls.push(
      <g key="draft-label" transform={`translate(${sb.x + 12},${sb.y - 12})`}>
        <rect x={-4} y={-13} width={label.length * 7 + 54} height={18} rx={3} fill="#ffffff" stroke={C.sel} />
        <text x={0} y={0} fontSize={11} fill={C.line} className="tnum select-none">{`${label} · ${ang.toFixed(1)}°`}</text>
      </g>,
    )
  }
  if (snap && snap.kind !== 'free') {
    const s = S(snap.point)
    overlayEls.push(
      <g key="snap">
        {snap.kind === 'point' && <circle cx={s.x} cy={s.y} r={7} fill="none" stroke={C.snap} strokeWidth={2} />}
        {snap.kind === 'intersection' && <g stroke={C.snap} strokeWidth={2}><line x1={s.x - 6} y1={s.y - 6} x2={s.x + 6} y2={s.y + 6} /><line x1={s.x - 6} y1={s.y + 6} x2={s.x + 6} y2={s.y - 6} /></g>}
        {snap.kind === 'midpoint' && <polygon points={`${s.x},${s.y - 7} ${s.x - 7},${s.y + 6} ${s.x + 7},${s.y + 6}`} fill="none" stroke={C.snap} strokeWidth={2} />}
        {(snap.kind === 'on-line' || snap.kind === 'axis') && <rect x={s.x - 5} y={s.y - 5} width={10} height={10} fill="none" stroke={C.snap} strokeWidth={2} transform={`rotate(45 ${s.x} ${s.y})`} />}
        {snap.kind === 'grid' && <circle cx={s.x} cy={s.y} r={2.5} fill={C.snap} />}
        {snap.axis && draft && (
          <line x1={S(draft.from).x} y1={S(draft.from).y} x2={s.x} y2={s.y} stroke={C.snap} strokeWidth={1} strokeDasharray="2 3" />
        )}
      </g>,
    )
  }

  return (
    <svg
      ref={svgRef}
      className="block h-full w-full touch-none select-none bg-surface"
      style={{ cursor }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="parametric-canvas"
    >
      <g>{gridEls}</g>
      <g>{ghostEls}</g>
      <g>{objEls}</g>
      <g>{lineEls}</g>
      <g>{dimEls}</g>
      <g>{badgeEls}</g>
      <g>{labelEls}</g>
      <g>{pointEls}</g>
      <g>{overlayEls}</g>
    </svg>
  )
}

const GLYPH: Record<Constraint['kind'], string> = {
  horizontal: '—',
  vertical: '|',
  parallel: '∥',
  perpendicular: '⊥',
  collinear: '≡',
  equalLength: '=',
  equalAngle: '∡',
  coincident: '•',
  pointOnLine: '⌖',
  midpoint: '½',
  symmetric: '⇔',
  centered: '⊙',
  fixed: '⚓',
  length: 'L',
  pointDistance: 'd',
  pointLineDistance: 'd',
  lineDistance: 'd',
  angle: '∠',
  equalDistance: '≍',
}

function drawRank(o: SketchObject): number {
  switch (o.kind) {
    case 'roofOutline': return 0
    case 'roofEdge': return 1
    case 'aux': return 2
    case 'wall': return 3
    case 'beam': return 4
    case 'opening': return 5
    case 'column': return 6
  }
}

function dimensionOf(doc: SketchDoc, constraintId: string): Dimension | undefined {
  return doc.dimensions.find((d) => d.constraintId === constraintId)
}

/** Where to draw a constraint's badge: a line's midpoint or the point itself. */
function constraintAnchor(doc: SketchDoc, positions: ReadonlyMap<string, Pt>, c: Constraint): Pt | null {
  const refs = constraintRefs(c)
  const first = refs[0]
  if (!first) return null
  const l = lineById(doc, first)
  if (l) {
    const a = positions.get(l.a)
    const b = positions.get(l.b)
    return a && b ? mid(a, b) : null
  }
  return positions.get(first) ?? null
}

function renderDimension(
  doc: SketchDoc,
  positions: ReadonlyMap<string, Pt>,
  d: Dimension,
  S: (p: Pt) => Pt,
  unit: LengthUnit,
  ev: Evaluation,
  selected: boolean,
  onClick: () => void,
): React.ReactNode {
  const value = measureDimension(doc, d, positions)
  if (value === null) return null
  const seg = (id: string): { a: Pt; b: Pt } | null => {
    const l = lineById(doc, id)
    const a = l ? positions.get(l.a) : undefined
    const b = l ? positions.get(l.b) : undefined
    return a && b ? { a, b } : null
  }
  let anchor: Pt | null = null
  let dir: Pt = { x: 1, y: 0 }
  let extA: Pt | null = null
  let extB: Pt | null = null
  switch (d.kind) {
    case 'length': {
      const s = seg(d.refs[0]!)
      if (!s) return null
      anchor = mid(s.a, s.b)
      dir = unitVec(sub(s.b, s.a))
      extA = s.a
      extB = s.b
      break
    }
    case 'pointDistance': {
      const a = positions.get(d.refs[0]!)
      const b = positions.get(d.refs[1]!)
      if (!a || !b) return null
      anchor = mid(a, b)
      dir = unitVec(sub(b, a))
      extA = a
      extB = b
      break
    }
    case 'pointLineDistance': {
      const p = positions.get(d.refs[0]!)
      const s = seg(d.refs[1]!)
      if (!p || !s) return null
      const n = leftNormal(s.a, s.b)
      const foot = add(p, scale(n, -value))
      anchor = mid(p, foot)
      dir = n
      extA = p
      extB = foot
      break
    }
    case 'lineDistance': {
      const a = seg(d.refs[0]!)
      const b = seg(d.refs[1]!)
      if (!a || !b) return null
      const n = leftNormal(a.a, a.b)
      const m = mid(b.a, b.b)
      const foot = add(m, scale(n, -value))
      anchor = mid(m, foot)
      dir = n
      extA = m
      extB = foot
      break
    }
    case 'angle': {
      const a = seg(d.refs[0]!)
      const b = seg(d.refs[1]!)
      if (!a || !b) return null
      anchor = mid(mid(a.a, a.b), mid(b.a, b.b))
      break
    }
  }
  if (!anchor) return null
  const off = d.labelOffsetM ?? { x: -dir.y * 0.35, y: dir.x * 0.35 }
  const at = S(add(anchor, off))
  const text = d.kind === 'angle' ? `${value.toFixed(1)}°` : formatLength(Math.abs(value), unit)
  const label = d.driving ? text : `(${text})`
  const st = d.constraintId ? ev.analysis.status.get(d.constraintId) : undefined
  const color = st === 'conflict' ? C.conflict : selected ? C.sel : d.driving ? C.dimDriving : C.dimRef
  const wpx = Math.max(28, label.length * 7 + 10)
  return (
    <g key={d.id} onClick={(e) => { e.stopPropagation(); onClick() }} style={{ cursor: 'pointer' }} data-dimension={d.id}>
      {extA && extB && (
        <g stroke={color} strokeWidth={0.75} opacity={0.6}>
          <line x1={S(add(extA, off)).x} y1={S(add(extA, off)).y} x2={S(add(extB, off)).x} y2={S(add(extB, off)).y} />
          <line x1={S(extA).x} y1={S(extA).y} x2={S(add(extA, off)).x} y2={S(add(extA, off)).y} />
          <line x1={S(extB).x} y1={S(extB).y} x2={S(add(extB, off)).x} y2={S(add(extB, off)).y} />
        </g>
      )}
      <rect x={at.x - wpx / 2} y={at.y - 9} width={wpx} height={18} rx={3} fill="#ffffff" stroke={d.driving ? color : 'none'} strokeWidth={selected ? 2 : 1} />
      <text x={at.x} y={at.y + 4} fontSize={11} textAnchor="middle" fill={color} className="tnum select-none">{label}</text>
    </g>
  )
}
