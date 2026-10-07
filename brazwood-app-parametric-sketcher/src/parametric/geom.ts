// src/parametric/geom.ts
// Small pure 2D vector helpers shared by the solver, relations and the UI.
import type { Pt } from './model'

export const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y })
export const add = (p: Pt, q: Pt): Pt => ({ x: p.x + q.x, y: p.y + q.y })
export const scale = (p: Pt, k: number): Pt => ({ x: p.x * k, y: p.y * k })
export const dot = (p: Pt, q: Pt): number => p.x * q.x + p.y * q.y
export const cross = (p: Pt, q: Pt): number => p.x * q.y - p.y * q.x
export const len = (p: Pt): number => Math.hypot(p.x, p.y)
export const dist = (p: Pt, q: Pt): number => Math.hypot(p.x - q.x, p.y - q.y)
export const mid = (p: Pt, q: Pt): Pt => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
/** Left-hand normal of a→b (CCW 90°), unit length; {0,0} for a zero vector. */
export function leftNormal(a: Pt, b: Pt): Pt {
  const d = sub(b, a)
  const l = len(d)
  if (l < 1e-12) return { x: 0, y: 0 }
  return { x: -d.y / l, y: d.x / l }
}
export function unit(d: Pt): Pt {
  const l = len(d)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: d.x / l, y: d.y / l }
}
/** Signed distance of p from the infinite line a→b (positive = left side). */
export function signedDist(p: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a)
  const l = len(d)
  if (l < 1e-12) return dist(p, a)
  return cross(d, sub(p, a)) / l
}
/** Parameter t of the projection of p onto a→b (0 at a, 1 at b). */
export function projectT(p: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a)
  const l2 = dot(d, d)
  if (l2 < 1e-18) return 0
  return dot(sub(p, a), d) / l2
}
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
/** Closest point on SEGMENT a→b. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const t = Math.max(0, Math.min(1, projectT(p, a, b)))
  return lerp(a, b, t)
}
/** Intersection of infinite lines (a1→a2) and (b1→b2); null when parallel. */
export function lineIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const r = sub(a2, a1)
  const s = sub(b2, b1)
  const den = cross(r, s)
  if (Math.abs(den) < 1e-12) return null
  const t = cross(sub(b1, a1), s) / den
  return add(a1, scale(r, t))
}
export const angleDeg = (d: Pt): number => (Math.atan2(d.y, d.x) * 180) / Math.PI
export const degToRad = (deg: number): number => (deg * Math.PI) / 180
/** Wrap an angle (degrees) into (-180, 180]. */
export function wrapDeg(a: number): number {
  let r = ((a + 180) % 360 + 360) % 360 - 180
  if (r === -180) r = 180
  return r
}
/** Shoelace signed area of a ring (CCW positive). */
export function signedArea(ring: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!
    const q = ring[(i + 1) % ring.length]!
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}
export function bounds(pts: readonly Pt[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (pts.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}
