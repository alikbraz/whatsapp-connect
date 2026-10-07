// src/parametric/ui/panels.tsx
// Compact side panels of the parametric sketcher (owner brief §5 "פאנל
// מאפיינים קומפקטי", §4 "לאפשר בחירה, עריכה ומחיקה של כל יחס", §2 object
// properties, §6 roof supports). Presentational: every edit goes back to
// ParametricSketcher.tsx through callbacks; nothing here touches the doc.
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Lock, LockOpen, Trash2 } from 'lucide-react'
import type { Constraint, Dimension, LayerKey, SketchDoc, SketchObject, StructuralRelation, StructuralRole, WallFaceRef } from '../model'
import { CONSTRAINT_LABEL_HE, LAYER_KEYS, OBJECT_LABEL_HE, RELATION_LABEL_HE, ROLE_LABEL_HE, constraintRefs, objectById, relationRefs } from '../model'
import type { Evaluation } from '../doc'
import { measureDimension } from '../doc'
import type { RoofDerivationResult } from '../roofBridge'
import { supportNames } from '../roofBridge'
import { formatLength, interpretInUnit, UNIT_HE, type LengthUnit } from '../../roofwizard/units'

export const panelCls = 'rounded-lg border border-border bg-surface p-2 shadow-card'
export const chipCls = 'min-h-[32px] rounded-md border border-border bg-surface px-2 text-xs text-fg hover:bg-surface-2'
export const chipOn = 'min-h-[32px] rounded-md border border-brand bg-brand px-2 text-xs text-white'
const fieldCls = 'tnum min-h-[32px] w-full rounded-md border border-border-strong bg-surface px-2 text-right text-xs focus:border-brand'
const smallLabel = 'block text-[11px] text-muted'

/** A length field in the active unit (stores meters); commits on blur/Enter. */
export function LengthField({ label, valueM, unit, onCommit, min }: { label: string; valueM: number; unit: LengthUnit; onCommit: (m: number) => void; min?: number }) {
  const [text, setText] = useState(formatLength(valueM, unit))
  useEffect(() => setText(formatLength(valueM, unit)), [valueM, unit])
  const commit = () => {
    const m = interpretInUnit(text, unit)
    if (m === null || (min !== undefined && m < min)) {
      setText(formatLength(valueM, unit))
      return
    }
    if (Math.abs(m - valueM) > 1e-9) onCommit(m)
  }
  return (
    <label className="block">
      <span className={smallLabel}>{label} ({UNIT_HE[unit]})</span>
      <input className={fieldCls} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} inputMode="decimal" />
    </label>
  )
}

export function NumberField({ label, value, onCommit, step, suffix }: { label: string; value: number; onCommit: (v: number) => void; step?: number; suffix?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const v = parseFloat(text)
    if (!Number.isFinite(v)) {
      setText(String(value))
      return
    }
    if (v !== value) onCommit(v)
  }
  return (
    <label className="block">
      <span className={smallLabel}>{label}{suffix ? ` (${suffix})` : ''}</span>
      <input className={fieldCls} value={text} step={step} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} inputMode="decimal" />
    </label>
  )
}

export function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <label className="block">
      <span className={smallLabel}>{label}</span>
      <input className={fieldCls + ' text-right'} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text.trim() && text !== value) onCommit(text.trim()) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; he: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="block">
      <span className={smallLabel}>{label}</span>
      <select className={fieldCls} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.he}</option>)}
      </select>
    </label>
  )
}

const ROLE_OPTIONS: { v: StructuralRole; he: string }[] = (['bearing', 'non-bearing', 'none'] as StructuralRole[]).map((v) => ({ v, he: ROLE_LABEL_HE[v] }))
const FACE_OPTIONS: { v: WallFaceRef; he: string }[] = [
  { v: 'center', he: 'מרכז' },
  { v: 'faceA', he: 'פן A (שמאל)' },
  { v: 'faceB', he: 'פן B (ימין)' },
]

// ---------------------------------------------------------------------------
// OBJECT PROPERTIES
// ---------------------------------------------------------------------------

export function ObjectProperties({ o, unit, onPatch, onRemove }: { o: SketchObject; unit: LengthUnit; onPatch: (patch: Partial<SketchObject>) => void; onRemove: () => void }) {
  return (
    <div className={panelCls + ' space-y-2'}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{OBJECT_LABEL_HE[o.kind]} · {o.name}</span>
        <div className="flex items-center gap-1">
          <button type="button" title={o.locked ? 'שחרר קיבוע' : 'קבע (לא יזוז)'} className="rounded p-1 hover:bg-surface-2" onClick={() => onPatch({ locked: !o.locked })}>
            {o.locked ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>
          <button type="button" title={o.hidden ? 'הצג' : 'הסתר'} className="rounded p-1 hover:bg-surface-2" onClick={() => onPatch({ hidden: !o.hidden })}>
            {o.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button type="button" title="מחק אובייקט" className="rounded p-1 text-danger hover:bg-danger-soft" onClick={onRemove}><Trash2 size={14} /></button>
        </div>
      </div>
      <TextField label="שם / קוד" value={o.name} onCommit={(name) => onPatch({ name })} />
      {o.kind !== 'aux' && o.kind !== 'roofEdge' && o.kind !== 'roofOutline' && o.kind !== 'opening' && (
        <Select label="תפקיד מבני (כוונת המשתמש — לא אישור הנדסי)" value={o.role} options={ROLE_OPTIONS} onChange={(role) => onPatch({ role })} />
      )}
      {o.kind === 'wall' && (
        <div className="grid grid-cols-2 gap-2">
          <Select label="סוג" value={o.wallType} options={[{ v: 'exterior', he: 'קיר חוץ' }, { v: 'interior', he: 'קיר פנים' }]} onChange={(wallType) => onPatch({ wallType })} />
          <Select label="הקו המשורטט הוא" value={o.lineIs} options={FACE_OPTIONS} onChange={(lineIs) => onPatch({ lineIs })} />
          <LengthField label="עובי" valueM={o.thicknessM} unit={unit} min={0.01} onCommit={(thicknessM) => onPatch({ thicknessM })} />
          <LengthField label="גובה" valueM={o.heightM} unit={unit} min={0} onCommit={(heightM) => onPatch({ heightM })} />
        </div>
      )}
      {o.kind === 'column' && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="חתך רוחב" value={o.sectionWmm} suffix="מ״מ" onCommit={(sectionWmm) => onPatch({ sectionWmm })} />
          <NumberField label="חתך עומק" value={o.sectionHmm} suffix="מ״מ" onCommit={(sectionHmm) => onPatch({ sectionHmm })} />
          <NumberField label="כיוון" value={o.rotationDeg} suffix="°" onCommit={(rotationDeg) => onPatch({ rotationDeg })} />
          <LengthField label="גובה" valueM={o.heightM} unit={unit} min={0} onCommit={(heightM) => onPatch({ heightM })} />
        </div>
      )}
      {o.kind === 'beam' && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="חתך רוחב" value={o.sectionWmm} suffix="מ״מ" onCommit={(sectionWmm) => onPatch({ sectionWmm })} />
          <NumberField label="חתך גובה" value={o.sectionHmm} suffix="מ״מ" onCommit={(sectionHmm) => onPatch({ sectionHmm })} />
          <TextField label="חומר" value={o.material} onCommit={(material) => onPatch({ material })} />
          <LengthField label="מפלס תחתית" valueM={o.levelM} unit={unit} onCommit={(levelM) => onPatch({ levelM })} />
          <div className="col-span-2 text-[11px] text-muted">נקודות תמיכה: {o.supports.length === 0 ? 'טרם הוגדרו (יחס «קורה בין תמיכות»)' : o.supports.join(', ')}</div>
        </div>
      )}
      {o.kind === 'opening' && (
        <div className="grid grid-cols-2 gap-2">
          <LengthField label="מיקום (מתחילת הקיר)" valueM={o.offsetM} unit={unit} min={0} onCommit={(offsetM) => onPatch({ offsetM })} />
          <LengthField label="רוחב" valueM={o.widthM} unit={unit} min={0.05} onCommit={(widthM) => onPatch({ widthM })} />
          <LengthField label="גובה" valueM={o.heightM} unit={unit} min={0.05} onCommit={(heightM) => onPatch({ heightM })} />
          <LengthField label="סף" valueM={o.sillM} unit={unit} min={0} onCommit={(sillM) => onPatch({ sillM })} />
        </div>
      )}
      {o.kind === 'aux' && (
        <Select label="סוג קו עזר" value={o.auxType} options={[{ v: 'guide', he: 'קו עזר' }, { v: 'axis', he: 'ציר' }, { v: 'grid', he: 'רשת צירים' }]} onChange={(auxType) => onPatch({ auxType })} />
      )}
      {o.kind === 'roofEdge' && (
        <Select label="סוג קצה" value={o.edgeType} options={[{ v: 'eave', he: 'מרזב (eave)' }, { v: 'gable', he: 'גמלון' }, { v: 'spanBoundary', he: 'גבול מפתח' }]} onChange={(edgeType) => onPatch({ edgeType })} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CONSTRAINTS / DIMENSIONS / RELATIONS OF THE SELECTION
// ---------------------------------------------------------------------------

function describeRefs(doc: SketchDoc, refs: readonly string[]): string {
  return refs
    .map((r) => {
      const owner = doc.objects.find((o) => ('line' in o && o.line === r) || (o.kind === 'column' && o.point === r))
      return owner ? owner.name : r
    })
    .join(' · ')
}

export function ConstraintList({ doc, ev, ids, unit, selectedId, onSelect, onRemove, onSetValue, onToggleDriving }: {
  doc: SketchDoc
  ev: Evaluation
  /** Constraint ids to list. */
  ids: readonly string[]
  unit: LengthUnit
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onSetValue: (id: string, v: number) => void
  onToggleDriving: (dim: Dimension) => void
}) {
  if (ids.length === 0) return null
  return (
    <div className={panelCls + ' space-y-1'}>
      <div className="text-xs font-medium">יחסים ומידות</div>
      {ids.map((id) => {
        const c = doc.constraints.find((x) => x.id === id)
        if (!c) return null
        const dim = doc.dimensions.find((d) => d.constraintId === id)
        const st = ev.analysis.status.get(id) ?? 'ok'
        return <ConstraintRow key={id} doc={doc} c={c} dim={dim} status={st} unit={unit} selected={selectedId === id} onSelect={() => onSelect(id)} onRemove={() => onRemove(id)} onSetValue={(v) => onSetValue(id, v)} onToggleDriving={dim ? () => onToggleDriving(dim) : undefined} />
      })}
    </div>
  )
}

function ConstraintRow({ doc, c, dim, status, unit, selected, onSelect, onRemove, onSetValue, onToggleDriving }: {
  doc: SketchDoc
  c: Constraint
  dim?: Dimension
  status: 'ok' | 'redundant' | 'conflict'
  unit: LengthUnit
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  onSetValue: (v: number) => void
  onToggleDriving?: () => void
}) {
  const hasValue = 'valueM' in c || 'valueDeg' in c
  const value = 'valueDeg' in c ? c.valueDeg : 'valueM' in c ? c.valueM : null
  const [text, setText] = useState('')
  useEffect(() => {
    if (value === null) return
    setText('valueDeg' in c ? String(value) : formatLength(value, unit))
  }, [value, unit, c])
  const commit = () => {
    if (value === null) return
    const v = 'valueDeg' in c ? parseFloat(text) : interpretInUnit(text, unit)
    if (v === null || !Number.isFinite(v)) return
    if (Math.abs(v - value) > 1e-9) onSetValue(v)
  }
  const tone = status === 'conflict' ? 'border-danger bg-danger-soft' : status === 'redundant' ? 'border-[#d97706]' : selected ? 'border-brand' : 'border-border'
  return (
    <div className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-xs ${tone}`} onClick={onSelect} role="button" tabIndex={0}>
      <span className="flex-1 truncate" title={describeRefs(doc, constraintRefs(c))}>
        {CONSTRAINT_LABEL_HE[c.kind]}
        <span className="text-muted"> · {describeRefs(doc, constraintRefs(c))}</span>
        {status === 'conflict' && <span className="text-danger"> · סתירה</span>}
        {status === 'redundant' && <span className="text-[#b45309]"> · כפול</span>}
      </span>
      {hasValue && (
        <input className="tnum w-16 rounded border border-border-strong px-1 text-right text-xs" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} onClick={(e) => e.stopPropagation()} />
      )}
      {onToggleDriving && dim && (
        <button type="button" className="rounded border border-border px-1 text-[10px]" title="הפוך למידת ייחוס (מדידה בלבד)" onClick={(e) => { e.stopPropagation(); onToggleDriving() }}>מניעה</button>
      )}
      <button type="button" className="rounded p-0.5 text-danger hover:bg-danger-soft" title="מחק יחס" onClick={(e) => { e.stopPropagation(); onRemove() }}><Trash2 size={13} /></button>
    </div>
  )
}

export function ReferenceDimensionList({ doc, dims, unit, onRemove, onMakeDriving }: { doc: SketchDoc; dims: readonly Dimension[]; unit: LengthUnit; onRemove: (id: string) => void; onMakeDriving: (d: Dimension) => void }) {
  if (dims.length === 0) return null
  return (
    <div className={panelCls + ' space-y-1'}>
      <div className="text-xs font-medium">מידות ייחוס (מדידה בלבד)</div>
      {dims.map((d) => {
        const v = measureDimension(doc, d)
        return (
          <div key={d.id} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-xs">
            <span className="flex-1">{CONSTRAINT_LABEL_HE[d.kind]} · {describeRefs(doc, d.refs)} = <span className="tnum">{v === null ? '—' : d.kind === 'angle' ? `${v.toFixed(1)}°` : formatLength(Math.abs(v), unit)}</span></span>
            <button type="button" className="rounded border border-border px-1 text-[10px]" title="הפוך למידה מניעה" onClick={() => onMakeDriving(d)}>ייחוס</button>
            <button type="button" className="rounded p-0.5 text-danger hover:bg-danger-soft" onClick={() => onRemove(d.id)}><Trash2 size={13} /></button>
          </div>
        )
      })}
    </div>
  )
}

export function RelationList({ doc, ev, relations, unit, onRemove, onPatch }: {
  doc: SketchDoc
  ev: Evaluation
  relations: readonly StructuralRelation[]
  unit: LengthUnit
  onRemove: (id: string) => void
  onPatch: (id: string, patch: Partial<StructuralRelation>) => void
}) {
  if (relations.length === 0) return null
  return (
    <div className={panelCls + ' space-y-1'}>
      <div className="text-xs font-medium">יחסים מבניים</div>
      {relations.map((r) => {
        const conflict = ev.analysis.conflictRelations.has(r.id)
        const issue = ev.issues.find((i) => i.relationId === r.id)
        const names = relationRefs(r).map((id) => objectById(doc, id)?.name ?? id).join(' · ')
        return (
          <div key={r.id} className={`space-y-1 rounded-md border px-1.5 py-1 text-xs ${conflict ? 'border-danger bg-danger-soft' : 'border-border'}`}>
            <div className="flex items-center gap-1">
              <span className="flex-1 truncate">{RELATION_LABEL_HE[r.kind]} <span className="text-muted">· {names}</span>{conflict && <span className="text-danger"> · סתירה</span>}</span>
              <button type="button" className="rounded p-0.5 text-danger hover:bg-danger-soft" title="מחק יחס" onClick={() => onRemove(r.id)}><Trash2 size={13} /></button>
            </div>
            {issue && <div className="text-danger">{issue.message}</div>}
            {r.kind === 'offsetFromWall' && (
              <div className="grid grid-cols-2 gap-1">
                <Select label="מפני" value={r.ref} options={FACE_OPTIONS} onChange={(ref) => onPatch(r.id, { ref })} />
                <LengthField label="מרחק" valueM={r.distM} unit={unit} onCommit={(distM) => onPatch(r.id, { distM })} />
              </div>
            )}
            {r.kind === 'columnAtCorner' && (
              <div className="grid grid-cols-2 gap-1">
                <Select label={`מפני ${objectById(doc, r.wallA)?.name ?? ''}`} value={r.refA} options={FACE_OPTIONS} onChange={(refA) => onPatch(r.id, { refA })} />
                <LengthField label="מרחק" valueM={r.distA} unit={unit} onCommit={(distA) => onPatch(r.id, { distA })} />
                <Select label={`מפני ${objectById(doc, r.wallB)?.name ?? ''}`} value={r.refB} options={FACE_OPTIONS} onChange={(refB) => onPatch(r.id, { refB })} />
                <LengthField label="מרחק" valueM={r.distB} unit={unit} onCommit={(distB) => onPatch(r.id, { distB })} />
              </div>
            )}
            {r.kind === 'alignTo' && (
              <div className="grid grid-cols-2 gap-1">
                <Select label="יישור לפי" value={r.ref} options={FACE_OPTIONS} onChange={(ref) => onPatch(r.id, { ref })} />
                <LengthField label="מרווח" valueM={r.gapM} unit={unit} onCommit={(gapM) => onPatch(r.id, { gapM })} />
              </div>
            )}
            {r.kind === 'roofOverhang' && <LengthField label="בליטה מפני הקיר החיצוני" valueM={r.overhangM} unit={unit} min={0} onCommit={(overhangM) => onPatch(r.id, { overhangM })} />}
            {r.kind === 'divide' && (
              <div className="grid grid-cols-2 gap-1">
                <Select label="חלוקה לפי" value={r.by} options={[{ v: 'count', he: 'מספר (שווה)' }, { v: 'spacing', he: 'מרווח קבוע' }]} onChange={(by) => onPatch(r.id, { by })} />
                {r.by === 'spacing' && <LengthField label="מרווח" valueM={r.spacingM ?? 1} unit={unit} min={0.01} onCommit={(spacingM) => onPatch(r.id, { spacingM })} />}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LAYERS
// ---------------------------------------------------------------------------

const LAYER_HE: Record<LayerKey, string> = {
  wallExt: 'קירות חוץ',
  wallInt: 'קירות פנים',
  column: 'עמודים',
  beam: 'קורות',
  opening: 'פתחים',
  roof: 'גג',
  aux: 'קווי עזר וצירים',
  dims: 'מידות',
  constraints: 'סימוני יחסים',
}

export function LayersPanel({ doc, onSet }: { doc: SketchDoc; onSet: (key: LayerKey, patch: { visible?: boolean; locked?: boolean }) => void }) {
  return (
    <div className={panelCls}>
      <div className="mb-1 text-xs font-medium">שכבות — הצגה ונעילה</div>
      <div className="space-y-0.5">
        {LAYER_KEYS.map((k) => {
          const l = doc.layers[k]
          const lockable = k !== 'dims' && k !== 'constraints'
          return (
            <div key={k} className="flex items-center gap-1 text-xs">
              <button type="button" className="rounded p-0.5 hover:bg-surface-2" title={l.visible ? 'הסתר' : 'הצג'} onClick={() => onSet(k, { visible: !l.visible })}>{l.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
              {lockable ? (
                <button type="button" className="rounded p-0.5 hover:bg-surface-2" title={l.locked ? 'שחרר' : 'נעל (לא יזוז)'} onClick={() => onSet(k, { locked: !l.locked })}>{l.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
              ) : <span className="w-[22px]" />}
              <span className={l.visible ? '' : 'text-muted'}>{LAYER_HE[k]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ROOF
// ---------------------------------------------------------------------------

export function RoofPanel({ doc, derivation, slopePct, onSlope, onBuild, buildLabel }: {
  doc: SketchDoc
  derivation: RoofDerivationResult
  slopePct: number
  onSlope: (v: number) => void
  onBuild: () => void
  buildLabel: string
}) {
  return (
    <div className={panelCls + ' space-y-2'}>
      <div className="text-xs font-medium">חיבור למודל הגג</div>
      {derivation.ok ? (
        <>
          <div className="text-[11px] text-muted">
            מקור המתאר: {derivation.source === 'roofOutline' ? 'מתאר גג משורטט' : 'פני החוץ של קירות החוץ'} · {derivation.ring.length} פינות
          </div>
          <div className="text-[11px]">הגג נשען על: <span className="text-fg">{supportNames(doc, derivation.supports).join(', ') || '—'}</span></div>
          <div className="text-[10px] text-muted">סימון «נושא» מתעד את כוונת המשתמש; אינו אישור הנדסי לכושר נשיאה.</div>
        </>
      ) : (
        <div className="text-[11px] text-danger">{derivation.message}</div>
      )}
      <NumberField label="שיפוע הגג" value={slopePct} suffix="%" onCommit={onSlope} />
      <button type="button" disabled={!derivation.ok} className="min-h-[36px] w-full rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-50" onClick={onBuild}>{buildLabel}</button>
    </div>
  )
}
