// src/parametric/model.ts
// PARAMETRIC SKETCHER — domain model (owner brief 2026-10-07: "סביבת שרטוט
// פרמטרית, שבה ניתן להגדיר גאומטריה, יחסים בין אובייקטים ותפקידים מבניים").
// PURE DATA. No React, no DOM, no engine imports. Everything here is
// persisted verbatim (see persist.ts) — meters throughout, plan space
// (x along the building length, y along its width), same frame as
// roofwizard/types.ts's RoofModel.contour so the roof bridge
// (roofBridge.ts) never has to convert units or axes.
//
// Three layers, each referencing the one below by id only:
//   1. GEOMETRY   — points and lines (the only things the solver moves).
//   2. CONSTRAINTS — relations between geometry (what the solver enforces),
//                   including DRIVING dimensions. A REFERENCE dimension is
//                   NOT a constraint — it only reads geometry (see Dimension).
//   3. OBJECTS    — semantic things (wall/column/beam/opening/roof/aux) that
//                   OWN geometry and carry non-geometric properties
//                   (thickness, height, section, material, level, role).
//   4. STRUCTURAL RELATIONS — owner-level intents ("column at wall corner",
//                   "beam between two columns", "divide between bounds") that
//                   COMPILE into constraints (relations.ts). Stored so they can
//                   be listed, edited and deleted as ONE thing.

export interface Pt { x: number; y: number }

export interface SketchPoint {
  id: string
  x: number
  y: number
}

export interface SketchLine {
  id: string
  /** Endpoint ids (SketchPoint). */
  a: string
  b: string
  /** Construction geometry (aux/axis/grid) — never part of the structure. */
  construction?: boolean
}

// ---------------------------------------------------------------------------
// CONSTRAINTS
// ---------------------------------------------------------------------------

/** Which line of a wall a distance is measured from. 'center' = the wall's own
 *  sketch line; 'faceA'/'faceB' = the two faces, offset by ±thickness/2 along
 *  the line's left normal (faceA = left side of a→b, faceB = right side).
 *  Resolved at compile time from the OWNING object's thickness — never a
 *  copied number, so a thickness edit re-solves correctly. */
export type WallFaceRef = 'center' | 'faceA' | 'faceB'

export type Constraint =
  // --- single-line orientation
  | { id: string; kind: 'horizontal'; line: string }
  | { id: string; kind: 'vertical'; line: string }
  // --- two lines
  | { id: string; kind: 'parallel'; a: string; b: string }
  | { id: string; kind: 'perpendicular'; a: string; b: string }
  | { id: string; kind: 'collinear'; a: string; b: string }
  | { id: string; kind: 'equalLength'; a: string; b: string }
  /** angle(a,b) == angle(c,d). */
  | { id: string; kind: 'equalAngle'; a: string; b: string; c: string; d: string }
  // --- points
  | { id: string; kind: 'coincident'; p: string; q: string }
  | { id: string; kind: 'pointOnLine'; p: string; line: string }
  | { id: string; kind: 'midpoint'; p: string; line: string }
  /** p and q mirror each other across `axis`. */
  | { id: string; kind: 'symmetric'; p: string; q: string; axis: string }
  /** p is equidistant from lines a and b (מרכוז בין שני קווים). */
  | { id: string; kind: 'centered'; p: string; a: string; b: string }
  /** Pin a point where it is (קיבוע). */
  | { id: string; kind: 'fixed'; p: string; x: number; y: number }
  // --- driving dimensions
  | { id: string; kind: 'length'; line: string; valueM: number }
  | { id: string; kind: 'pointDistance'; p: string; q: string; valueM: number }
  /** SIGNED distance of p from the line's (optionally offset) axis — sign
   *  keeps the point on its side. `face`+`offsetM` are resolved by
   *  relations.ts (offsetM = ±thickness/2 for a wall face). */
  | { id: string; kind: 'pointLineDistance'; p: string; line: string; valueM: number; offsetM?: number }
  /** Line b parallel to line a at a signed distance (both endpoints of b). */
  | { id: string; kind: 'lineDistance'; a: string; b: string; valueM: number; offsetM?: number }
  /** Angle from line a to line b, degrees CCW. */
  | { id: string; kind: 'angle'; a: string; b: string; valueDeg: number }
  /** |p-q| == |r-s| (equal spacing in a division). */
  | { id: string; kind: 'equalDistance'; p: string; q: string; r: string; s: string }

export type ConstraintKind = Constraint['kind']

/** A displayed dimension. `driving` = also a constraint (constraintId); a
 *  REFERENCE dimension (driving === false) only measures — owner brief §4:
 *  "להבחין בין מידה שמניעה את הגאומטריה לבין מידה שמציגה מדידה בלבד". */
export interface Dimension {
  id: string
  kind: 'length' | 'pointDistance' | 'pointLineDistance' | 'lineDistance' | 'angle'
  refs: string[]
  driving: boolean
  /** The constraint this dimension drives (driving only). */
  constraintId?: string
  /** Where the label sits, as an offset from the measured geometry (meters). */
  labelOffsetM?: Pt
}

// ---------------------------------------------------------------------------
// OBJECTS
// ---------------------------------------------------------------------------

/** The structural role is a SEPARATE attribute from the object type (owner
 *  brief §2: "סוג האובייקט והתפקיד המבני שלו הם מאפיינים נפרדים"). Marking
 *  something 'bearing' records the user's INTENT; it is not an engineering
 *  approval of its capacity (brief §6). */
export type StructuralRole = 'bearing' | 'non-bearing' | 'none'

interface ObjectBase {
  id: string
  /** Free name or code shown in the plan + panel ("ק1", "ע3", "קורה A"). */
  name: string
  role: StructuralRole
  /** Hidden objects still exist and still constrain; locked ones cannot be
   *  dragged (their points are pinned by the solver via an implicit fix). */
  hidden?: boolean
  locked?: boolean
}

export interface WallObject extends ObjectBase {
  kind: 'wall'
  wallType: 'exterior' | 'interior'
  /** The wall's sketch line (axis the solver moves). */
  line: string
  thicknessM: number
  heightM: number
  /** Which wall line the sketch line represents: the wall's center or one of
   *  its faces. For an exterior wall drawn along its outer face: 'faceOut'
   *  means the sketch line IS the outer face and the body lies to the inside. */
  lineIs: 'center' | 'faceA' | 'faceB'
}

export interface ColumnObject extends ObjectBase {
  kind: 'column'
  /** Center point. */
  point: string
  sectionWmm: number
  sectionHmm: number
  rotationDeg: number
  heightM: number
}

export interface BeamObject extends ObjectBase {
  kind: 'beam'
  line: string
  sectionWmm: number
  sectionHmm: number
  material: string
  /** Underside level above floor, meters. */
  levelM: number
  /** Object ids this beam bears on (columns / walls / other beams) —
   *  recorded by relations.ts's beamBetween and shown in the panel. */
  supports: string[]
}

export interface OpeningObject extends ObjectBase {
  kind: 'opening'
  wall: string
  /** Center of the opening along the wall, meters from the wall line's `a`. */
  offsetM: number
  widthM: number
  heightM: number
  sillM: number
}

/** A closed roof outline — the loop the roof engine receives (eave/gable
 *  attributes live on the RoofModel side). */
export interface RoofOutlineObject extends ObjectBase {
  kind: 'roofOutline'
  /** Ordered loop of line ids (each shares an endpoint with the next). */
  lines: string[]
}

/** One roof-edge / span-boundary marker on a line. */
export interface RoofEdgeObject extends ObjectBase {
  kind: 'roofEdge'
  line: string
  edgeType: 'eave' | 'gable' | 'spanBoundary'
}

export interface AuxObject extends ObjectBase {
  kind: 'aux'
  line: string
  auxType: 'guide' | 'axis' | 'grid'
}

export type SketchObject =
  | WallObject
  | ColumnObject
  | BeamObject
  | OpeningObject
  | RoofOutlineObject
  | RoofEdgeObject
  | AuxObject

export type ObjectKind = SketchObject['kind']

// ---------------------------------------------------------------------------
// STRUCTURAL RELATIONS (owner brief §3) — compiled into constraints
// ---------------------------------------------------------------------------

export type StructuralRelation =
  /** Column center on an axis / aux line (or any line). */
  | { id: string; kind: 'columnOnAxis'; column: string; line: string }
  /** Column at the corner of two walls, measured to each wall's center/face. */
  | {
      id: string
      kind: 'columnAtCorner'
      column: string
      wallA: string
      wallB: string
      refA: WallFaceRef
      refB: WallFaceRef
      /** Clearance from each wall ref to the column CENTER (meters, signed —
       *  positive = toward the wall's faceA side). */
      distA: number
      distB: number
    }
  /** Column (or beam line) at a signed distance from a wall center/face. */
  | { id: string; kind: 'offsetFromWall'; target: string; wall: string; ref: WallFaceRef; distM: number }
  /** Beam ends rest on two supports (column point / wall line / beam line). */
  | { id: string; kind: 'beamBetween'; beam: string; supportA: string; supportB: string }
  /** Align a line object (wall/beam/roofEdge/aux) to a wall or beam's
   *  center / faceA / faceB with an extra gap. */
  | { id: string; kind: 'alignTo'; target: string; reference: string; ref: WallFaceRef; gapM: number }
  /** N columns spread evenly between two bound points (local division). */
  | {
      id: string
      kind: 'divide'
      columns: string[]
      boundA: string
      boundB: string
      /** 'count' = evenly spaced (the column list length); 'spacing' = a
       *  fixed pitch from boundA (the last gap absorbs the remainder). */
      by: 'count' | 'spacing'
      spacingM?: number
    }
  /** Roof edge line parallel to an exterior wall's outer face at the overhang. */
  | { id: string; kind: 'roofOverhang'; roofEdge: string; wall: string; overhangM: number }

export type RelationKind = StructuralRelation['kind']

// ---------------------------------------------------------------------------
// LEVELS / SLOPES (non-geometric: brief §3 "מפלסים, הפרשי גובה ושיפועים")
// ---------------------------------------------------------------------------

export interface Level {
  id: string
  name: string
  elevationM: number
}

// ---------------------------------------------------------------------------
// LAYERS (visibility + lock per object family — brief §5)
// ---------------------------------------------------------------------------

export type LayerKey = 'wallExt' | 'wallInt' | 'column' | 'beam' | 'opening' | 'roof' | 'aux' | 'dims' | 'constraints'

export interface LayerState { visible: boolean; locked: boolean }

export const LAYER_KEYS: LayerKey[] = ['wallExt', 'wallInt', 'column', 'beam', 'opening', 'roof', 'aux', 'dims', 'constraints']

export const defaultLayers = (): Record<LayerKey, LayerState> => ({
  wallExt: { visible: true, locked: false },
  wallInt: { visible: true, locked: false },
  column: { visible: true, locked: false },
  beam: { visible: true, locked: false },
  opening: { visible: true, locked: false },
  roof: { visible: true, locked: false },
  aux: { visible: true, locked: false },
  dims: { visible: true, locked: false },
  constraints: { visible: true, locked: false },
})

// ---------------------------------------------------------------------------
// DOCUMENT
// ---------------------------------------------------------------------------

export const SKETCH_DOC_VERSION = 1

export interface SketchDoc {
  v: number
  points: SketchPoint[]
  lines: SketchLine[]
  constraints: Constraint[]
  dimensions: Dimension[]
  objects: SketchObject[]
  relations: StructuralRelation[]
  levels: Level[]
  layers: Record<LayerKey, LayerState>
  /** Monotonic id counter — ids are minted from the doc, never from a module
   *  counter, so save/load can never collide. */
  seq: number
  /** The roof's declared supports (object ids the roof rests on) — written
   *  by the roof bridge when the roof is (re)built from this sketch. */
  roofSupports?: string[]
  /** Slope percent handed to the roof (brief §3 "שיפועים"); the roof model
   *  stays the owner of slopePct — this is only the sketch's request. */
  roofSlopePct?: number
}

export function emptyDoc(): SketchDoc {
  return {
    v: SKETCH_DOC_VERSION,
    points: [],
    lines: [],
    constraints: [],
    dimensions: [],
    objects: [],
    relations: [],
    levels: [{ id: 'lv0', name: 'רצפה 0.00', elevationM: 0 }],
    layers: defaultLayers(),
    seq: 1,
  }
}

export function mintId(doc: SketchDoc, prefix: string): { id: string; doc: SketchDoc } {
  const id = `${prefix}${doc.seq}`
  return { id, doc: { ...doc, seq: doc.seq + 1 } }
}

export const pointById = (doc: SketchDoc, id: string): SketchPoint | undefined => doc.points.find((p) => p.id === id)
export const lineById = (doc: SketchDoc, id: string): SketchLine | undefined => doc.lines.find((l) => l.id === id)
export const objectById = (doc: SketchDoc, id: string): SketchObject | undefined => doc.objects.find((o) => o.id === id)
export const constraintById = (doc: SketchDoc, id: string): Constraint | undefined =>
  doc.constraints.find((c) => c.id === id)

/** The layer an object family lives on. */
export function layerOf(o: SketchObject): LayerKey {
  switch (o.kind) {
    case 'wall': return o.wallType === 'exterior' ? 'wallExt' : 'wallInt'
    case 'column': return 'column'
    case 'beam': return 'beam'
    case 'opening': return 'opening'
    case 'roofOutline':
    case 'roofEdge': return 'roof'
    case 'aux': return 'aux'
  }
}

/** Point ids an object owns (directly or through its line). */
export function objectPointIds(doc: SketchDoc, o: SketchObject): string[] {
  const ofLine = (lineId: string): string[] => {
    const l = lineById(doc, lineId)
    return l ? [l.a, l.b] : []
  }
  switch (o.kind) {
    case 'wall':
    case 'beam':
    case 'roofEdge':
    case 'aux':
      return ofLine(o.line)
    case 'column':
      return [o.point]
    case 'opening':
      return []
    case 'roofOutline':
      return [...new Set(o.lines.flatMap(ofLine))]
  }
}

/** Line ids an object owns. */
export function objectLineIds(o: SketchObject): string[] {
  switch (o.kind) {
    case 'wall':
    case 'beam':
    case 'roofEdge':
    case 'aux':
      return [o.line]
    case 'roofOutline':
      return o.lines
    case 'column':
    case 'opening':
      return []
  }
}

/** Geometry ids (points + lines) a constraint references. */
export function constraintRefs(c: Constraint): string[] {
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
    case 'length':
      return [c.line]
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'equalLength':
    case 'angle':
    case 'lineDistance':
      return [c.a, c.b]
    case 'equalAngle':
      return [c.a, c.b, c.c, c.d]
    case 'coincident':
    case 'pointDistance':
      return [c.p, c.q]
    case 'pointOnLine':
    case 'midpoint':
    case 'pointLineDistance':
      return [c.p, c.line]
    case 'symmetric':
      return [c.p, c.q, c.axis]
    case 'centered':
      return [c.p, c.a, c.b]
    case 'fixed':
      return [c.p]
    case 'equalDistance':
      return [c.p, c.q, c.r, c.s]
  }
}

/** Object ids a structural relation references. */
export function relationRefs(r: StructuralRelation): string[] {
  switch (r.kind) {
    case 'columnOnAxis': return [r.column, r.line]
    case 'columnAtCorner': return [r.column, r.wallA, r.wallB]
    case 'offsetFromWall': return [r.target, r.wall]
    case 'beamBetween': return [r.beam, r.supportA, r.supportB]
    case 'alignTo': return [r.target, r.reference]
    case 'divide': return [...r.columns, r.boundA, r.boundB]
    case 'roofOverhang': return [r.roofEdge, r.wall]
  }
}

/** Hebrew labels (UI + warnings). */
export const CONSTRAINT_LABEL_HE: Record<ConstraintKind, string> = {
  horizontal: 'אופקי',
  vertical: 'אנכי',
  parallel: 'מקביל',
  perpendicular: 'ניצב',
  collinear: 'על אותו ציר',
  equalLength: 'אורכים שווים',
  equalAngle: 'זוויות שוות',
  coincident: 'נקודות מחוברות',
  pointOnLine: 'נקודה על קו',
  midpoint: 'נקודת אמצע',
  symmetric: 'סימטריה סביב ציר',
  centered: 'מרכוז',
  fixed: 'קיבוע',
  length: 'אורך',
  pointDistance: 'מרחק',
  pointLineDistance: 'מרחק מקו',
  lineDistance: 'מרחק בין קווים',
  angle: 'זווית',
  equalDistance: 'מרווחים שווים',
}

export const RELATION_LABEL_HE: Record<RelationKind, string> = {
  columnOnAxis: 'עמוד על ציר',
  columnAtCorner: 'עמוד בפינת קיר',
  offsetFromWall: 'מרחק מקיר',
  beamBetween: 'קורה בין תמיכות',
  alignTo: 'יישור לפי',
  divide: 'חלוקה',
  roofOverhang: 'בליטת גג',
}

export const OBJECT_LABEL_HE: Record<ObjectKind, string> = {
  wall: 'קיר',
  column: 'עמוד',
  beam: 'קורה',
  opening: 'פתח',
  roofOutline: 'מתאר גג',
  roofEdge: 'קצה גג',
  aux: 'קו עזר',
}

export const ROLE_LABEL_HE: Record<StructuralRole, string> = {
  bearing: 'נושא',
  'non-bearing': 'לא נושא',
  none: 'ללא תפקיד מבני',
}
