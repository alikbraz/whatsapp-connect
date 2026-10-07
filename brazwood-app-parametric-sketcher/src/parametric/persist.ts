// src/parametric/persist.ts
// Sketch document (de)serialization + structural validation. The doc lives
// INSIDE the roof snapshot (RoofModel.parametricSketch → Block.roofModel →
// useProject's localStorage store) so it rides the project's existing
// autosave/undo/history machinery; it also round-trips as a standalone JSON
// string (export / tests). Same doctrine as roofwizard/persist.ts: never
// silently discard unrecognised data — a doc that fails validation is
// reported, not replaced.
import { defaultLayers, emptyDoc, LAYER_KEYS, SKETCH_DOC_VERSION, type SketchDoc } from './model'

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0

export function isSketchDoc(x: unknown): x is SketchDoc {
  if (!isObj(x)) return false
  if (!isNum(x.v)) return false
  if (!Array.isArray(x.points) || !x.points.every((p) => isObj(p) && isStr(p.id) && isNum(p.x) && isNum(p.y))) return false
  if (!Array.isArray(x.lines) || !x.lines.every((l) => isObj(l) && isStr(l.id) && isStr(l.a) && isStr(l.b))) return false
  for (const k of ['constraints', 'dimensions', 'objects', 'relations', 'levels'] as const) {
    if (!Array.isArray(x[k]) || !(x[k] as unknown[]).every((e) => isObj(e) && isStr(e.id))) return false
  }
  if (!isObj(x.layers)) return false
  if (!isNum(x.seq)) return false
  return true
}

/** Fill layers added after a doc was saved (additive, same doctrine as
 *  RoofModel optional fields). */
export function hydrateDoc(doc: SketchDoc): SketchDoc {
  const base = defaultLayers()
  const layers = { ...base }
  for (const k of LAYER_KEYS) {
    const v = (doc.layers as Partial<Record<string, { visible?: unknown; locked?: unknown }>>)[k]
    layers[k] = {
      visible: typeof v?.visible === 'boolean' ? v.visible : base[k].visible,
      locked: typeof v?.locked === 'boolean' ? v.locked : base[k].locked,
    }
  }
  return { ...doc, layers, v: SKETCH_DOC_VERSION }
}

export function serializeDoc(doc: SketchDoc): string {
  return JSON.stringify(doc)
}

export type ParseResult = { ok: true; doc: SketchDoc } | { ok: false; message: string }

export function parseDoc(json: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, message: 'קובץ השרטוט אינו JSON תקין' }
  }
  return restoreDoc(raw)
}

export function restoreDoc(raw: unknown): ParseResult {
  if (raw === undefined || raw === null) return { ok: true, doc: emptyDoc() }
  if (!isSketchDoc(raw)) return { ok: false, message: 'מבנה השרטוט השמור לא זוהה — נפתח שרטוט ריק, הנתונים המקוריים לא נמחקו' }
  if (raw.v > SKETCH_DOC_VERSION) return { ok: false, message: 'השרטוט נשמר בגרסה חדשה יותר של האפליקציה' }
  return { ok: true, doc: hydrateDoc(structuredClone(raw)) }
}

/** Standalone browser key (the sketcher outside a roof block, e.g. a future
 *  dedicated screen). Inside RoofWizard the doc is saved with the roof. */
export const STANDALONE_KEY = 'brazwood_parametric_sketch_v1'
