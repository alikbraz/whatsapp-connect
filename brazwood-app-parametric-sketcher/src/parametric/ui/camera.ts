// src/parametric/ui/camera.ts
// Canvas camera (owner brief §5): world meters ↔ screen pixels, with y UP in
// world space (so a CCW angle reads CCW on screen). Zoom keeps the world
// point under the cursor fixed; fit frames a bounding box with padding.
import type { Pt } from '../model'

export interface Camera {
  /** World point at the canvas center. */
  cx: number
  cy: number
  pxPerM: number
}

export const ZOOM_MIN = 4
export const ZOOM_MAX = 2000

export function toScreen(cam: Camera, w: number, h: number, p: Pt): Pt {
  return { x: (p.x - cam.cx) * cam.pxPerM + w / 2, y: (cam.cy - p.y) * cam.pxPerM + h / 2 }
}

export function toWorld(cam: Camera, w: number, h: number, s: Pt): Pt {
  return { x: (s.x - w / 2) / cam.pxPerM + cam.cx, y: cam.cy - (s.y - h / 2) / cam.pxPerM }
}

/** Zoom by `factor` about a SCREEN point. */
export function zoomAt(cam: Camera, w: number, h: number, screen: Pt, factor: number): Camera {
  const before = toWorld(cam, w, h, screen)
  const pxPerM = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.pxPerM * factor))
  const next = { ...cam, pxPerM }
  const after = toWorld(next, w, h, screen)
  return { cx: cam.cx + (before.x - after.x), cy: cam.cy + (before.y - after.y), pxPerM }
}

export function panBy(cam: Camera, dxPx: number, dyPx: number): Camera {
  return { ...cam, cx: cam.cx - dxPx / cam.pxPerM, cy: cam.cy + dyPx / cam.pxPerM }
}

export function fitTo(b: { minX: number; minY: number; maxX: number; maxY: number } | null, w: number, h: number, padPx = 60): Camera {
  if (!b || w <= 0 || h <= 0) return { cx: 5, cy: 3, pxPerM: 60 }
  const bw = Math.max(b.maxX - b.minX, 0.5)
  const bh = Math.max(b.maxY - b.minY, 0.5)
  const pxPerM = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((w - 2 * padPx) / bw, (h - 2 * padPx) / bh)))
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, pxPerM }
}

/** A "nice" grid step (meters) for the current zoom: ≥ 24 px apart. */
export function gridStepM(pxPerM: number): number {
  const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50]
  for (const s of steps) if (s * pxPerM >= 24) return s
  return 100
}
