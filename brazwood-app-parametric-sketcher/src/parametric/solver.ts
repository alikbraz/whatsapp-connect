// src/parametric/solver.ts
// NUMERIC CONSTRAINT SOLVER for the parametric sketch (owner brief §1/§4).
// PURE — no React, no DOM. Levenberg–Marquardt least squares over every
// point coordinate, with:
//   - HARD equations from constraints (must reach |r| < tol — a solve that
//     cannot is a CONFLICT, reported, never patched by dropping a constraint:
//     brief §4 "לא למחוק או לשנות אילוץ בשקט כדי לפתור סתירה");
//   - SOFT "stay" terms (tiny weight) so an under-constrained sketch moves
//     MINIMALLY from where it was — the dimension the user typed changes,
//     everything else stays put as far as the relations allow;
//   - optional DRAG targets (medium weight) for interactive dragging: a
//     fully-defined point simply refuses to follow the cursor.
// Residual units: meters for distance-like equations; orientation equations
// use UNIT vectors scaled by SCALE_M so one "meter" of error means roughly
// the same thing everywhere (conditioning, not physics).
import type { Constraint, Pt, SketchDoc } from './model'
import { lineById } from './model'
import { solveSPD, zeros, type Mat } from './linalg'

export const SOLVE_TOL = 1e-7
/** Above this a hard equation counts as violated (conflict / not converged). */
export const CONFLICT_TOL = 1e-5
const SCALE_M = 1
const SOFT_W = 1e-4
const DRAG_W = 0.2

export interface Equation {
  /** Constraint id this equation belongs to ('pin:<pointId>' for a lock pin). */
  cid: string
  /** Variable indices this equation reads (for the sparse numeric Jacobian). */
  deps: number[]
  f: (v: Float64Array) => number
  /** 1 for hard equations; <1 for soft terms (excluded from convergence). */
  weight: number
}

export interface CompiledSystem {
  /** pointId → variable index of x (y is +1). */
  index: Map<string, number>
  pointIds: string[]
  n: number
  hard: Equation[]
}

export interface SolveInput {
  doc: SketchDoc
  /** Point ids pinned at their current position (locked objects). */
  pinned?: ReadonlySet<string>
  /** Interactive drag targets (point id → where the cursor wants it). */
  drag?: ReadonlyMap<string, Pt>
  /** Start from these positions instead of doc.points (preview/what-if). */
  start?: ReadonlyMap<string, Pt>
}

export interface SolveResult {
  ok: boolean
  /** Solved positions (best effort when !ok — callers must NOT commit those). */
  points: Map<string, Pt>
  /** Max |residual| per constraint id (hard only). */
  residuals: Map<string, number>
  /** Constraint ids whose equations stayed violated (empty when ok). */
  conflicts: string[]
  iterations: number
  system: CompiledSystem
}

const EMPTY: Pt = { x: 0, y: 0 }

/** Build the hard equations. Exported for the analysis module (Jacobian). */
export function compile(doc: SketchDoc, pinned?: ReadonlySet<string>): CompiledSystem {
  const index = new Map<string, number>()
  const pointIds: string[] = []
  doc.points.forEach((p, i) => {
    index.set(p.id, 2 * i)
    pointIds.push(p.id)
  })
  const n = doc.points.length * 2
  const hard: Equation[] = []
  const ix = (pid: string): number => {
    const i = index.get(pid)
    if (i === undefined) throw new Error(`parametric: unknown point ${pid}`)
    return i
  }
  const lineIx = (lid: string): [number, number] => {
    const l = lineById(doc, lid)
    if (!l) throw new Error(`parametric: unknown line ${lid}`)
    return [ix(l.a), ix(l.b)]
  }
  const D = (v: Float64Array, a: number, b: number): Pt => ({ x: v[b]! - v[a]!, y: v[b + 1]! - v[a + 1]! })
  const U = (d: Pt): Pt => {
    const l = Math.hypot(d.x, d.y)
    return l < 1e-12 ? EMPTY : { x: d.x / l, y: d.y / l }
  }
  const sdist = (v: Float64Array, p: number, a: number, b: number): number => {
    const d = D(v, a, b)
    const l = Math.hypot(d.x, d.y)
    if (l < 1e-12) return 0
    const px = v[p]! - v[a]!
    const py = v[p + 1]! - v[a + 1]!
    return (d.x * py - d.y * px) / l
  }
  const push = (cid: string, deps: number[], f: (v: Float64Array) => number): void => {
    const set = [...new Set(deps.flatMap((d) => [d, d + 1]))]
    hard.push({ cid, deps: set, f, weight: 1 })
  }

  for (const c of doc.constraints) emit(c)

  function emit(c: Constraint): void {
    switch (c.kind) {
      case 'horizontal': {
        const [a, b] = lineIx(c.line)
        push(c.id, [a, b], (v) => v[b + 1]! - v[a + 1]!)
        return
      }
      case 'vertical': {
        const [a, b] = lineIx(c.line)
        push(c.id, [a, b], (v) => v[b]! - v[a]!)
        return
      }
      case 'parallel': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        push(c.id, [a1, a2, b1, b2], (v) => {
          const u = U(D(v, a1, a2))
          const w = U(D(v, b1, b2))
          return (u.x * w.y - u.y * w.x) * SCALE_M
        })
        return
      }
      case 'perpendicular': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        push(c.id, [a1, a2, b1, b2], (v) => {
          const u = U(D(v, a1, a2))
          const w = U(D(v, b1, b2))
          return (u.x * w.x + u.y * w.y) * SCALE_M
        })
        return
      }
      case 'collinear': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        push(c.id, [a1, a2, b1], (v) => sdist(v, b1, a1, a2))
        push(c.id, [a1, a2, b2], (v) => sdist(v, b2, a1, a2))
        return
      }
      case 'equalLength': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        push(c.id, [a1, a2, b1, b2], (v) => {
          const u = D(v, a1, a2)
          const w = D(v, b1, b2)
          return Math.hypot(u.x, u.y) - Math.hypot(w.x, w.y)
        })
        return
      }
      case 'equalAngle': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        const [c1, c2] = lineIx(c.c)
        const [d1, d2] = lineIx(c.d)
        push(c.id, [a1, a2, b1, b2, c1, c2, d1, d2], (v) => {
          const ang = (p: Pt, q: Pt): number => Math.atan2(p.x * q.y - p.y * q.x, p.x * q.x + p.y * q.y)
          const t1 = ang(U(D(v, a1, a2)), U(D(v, b1, b2)))
          const t2 = ang(U(D(v, c1, c2)), U(D(v, d1, d2)))
          let d = t1 - t2
          while (d > Math.PI) d -= 2 * Math.PI
          while (d < -Math.PI) d += 2 * Math.PI
          return d * SCALE_M
        })
        return
      }
      case 'coincident': {
        const p = ix(c.p)
        const q = ix(c.q)
        push(c.id, [p, q], (v) => v[p]! - v[q]!)
        push(c.id, [p, q], (v) => v[p + 1]! - v[q + 1]!)
        return
      }
      case 'pointOnLine': {
        const p = ix(c.p)
        const [a, b] = lineIx(c.line)
        push(c.id, [p, a, b], (v) => sdist(v, p, a, b))
        return
      }
      case 'midpoint': {
        const p = ix(c.p)
        const [a, b] = lineIx(c.line)
        push(c.id, [p, a, b], (v) => v[p]! - (v[a]! + v[b]!) / 2)
        push(c.id, [p, a, b], (v) => v[p + 1]! - (v[a + 1]! + v[b + 1]!) / 2)
        return
      }
      case 'symmetric': {
        const p = ix(c.p)
        const q = ix(c.q)
        const [a, b] = lineIx(c.axis)
        // midpoint of p,q on the axis; p-q perpendicular to the axis.
        push(c.id, [p, q, a, b], (v) => {
          const d = D(v, a, b)
          const l = Math.hypot(d.x, d.y)
          if (l < 1e-12) return 0
          const mx = (v[p]! + v[q]!) / 2 - v[a]!
          const my = (v[p + 1]! + v[q + 1]!) / 2 - v[a + 1]!
          return (d.x * my - d.y * mx) / l
        })
        push(c.id, [p, q, a, b], (v) => {
          const u = U(D(v, a, b))
          return ((v[p]! - v[q]!) * u.x + (v[p + 1]! - v[q + 1]!) * u.y)
        })
        return
      }
      case 'centered': {
        const p = ix(c.p)
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        push(c.id, [p, a1, a2, b1, b2], (v) => Math.abs(sdist(v, p, a1, a2)) - Math.abs(sdist(v, p, b1, b2)))
        return
      }
      case 'fixed': {
        const p = ix(c.p)
        push(c.id, [p], (v) => v[p]! - c.x)
        push(c.id, [p], (v) => v[p + 1]! - c.y)
        return
      }
      case 'length': {
        const [a, b] = lineIx(c.line)
        push(c.id, [a, b], (v) => {
          const d = D(v, a, b)
          return Math.hypot(d.x, d.y) - c.valueM
        })
        return
      }
      case 'pointDistance': {
        const p = ix(c.p)
        const q = ix(c.q)
        push(c.id, [p, q], (v) => Math.hypot(v[p]! - v[q]!, v[p + 1]! - v[q + 1]!) - c.valueM)
        return
      }
      case 'pointLineDistance': {
        const p = ix(c.p)
        const [a, b] = lineIx(c.line)
        const target = c.valueM + (c.offsetM ?? 0)
        push(c.id, [p, a, b], (v) => sdist(v, p, a, b) - target)
        return
      }
      case 'lineDistance': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        const target = c.valueM + (c.offsetM ?? 0)
        push(c.id, [a1, a2, b1], (v) => sdist(v, b1, a1, a2) - target)
        push(c.id, [a1, a2, b2], (v) => sdist(v, b2, a1, a2) - target)
        return
      }
      case 'angle': {
        const [a1, a2] = lineIx(c.a)
        const [b1, b2] = lineIx(c.b)
        const targetRad = (c.valueDeg * Math.PI) / 180
        push(c.id, [a1, a2, b1, b2], (v) => {
          const u = U(D(v, a1, a2))
          const w = U(D(v, b1, b2))
          let d = Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y) - targetRad
          while (d > Math.PI) d -= 2 * Math.PI
          while (d < -Math.PI) d += 2 * Math.PI
          return d * SCALE_M
        })
        return
      }
      case 'equalDistance': {
        const p = ix(c.p)
        const q = ix(c.q)
        const r = ix(c.r)
        const s = ix(c.s)
        push(c.id, [p, q, r, s], (v) =>
          Math.hypot(v[p]! - v[q]!, v[p + 1]! - v[q + 1]!) - Math.hypot(v[r]! - v[s]!, v[r + 1]! - v[s + 1]!),
        )
        return
      }
    }
  }

  if (pinned) {
    for (const pid of pinned) {
      const i = index.get(pid)
      if (i === undefined) continue
      const p0 = doc.points.find((p) => p.id === pid)!
      push(`pin:${pid}`, [i], (v) => v[i]! - p0.x)
      push(`pin:${pid}`, [i], (v) => v[i + 1]! - p0.y)
    }
  }

  return { index, pointIds, n, hard }
}

/** Numeric Jacobian row for one equation (central differences on its deps). */
function jacobianRow(eq: Equation, v: Float64Array, row: Float64Array): void {
  for (const j of eq.deps) {
    const x0 = v[j]!
    const h = 1e-6 * Math.max(1, Math.abs(x0))
    v[j] = x0 + h
    const fp = eq.f(v)
    v[j] = x0 - h
    const fm = eq.f(v)
    v[j] = x0
    row[j] = ((fp - fm) / (2 * h)) * eq.weight
  }
}

export function jacobian(eqs: readonly Equation[], v: Float64Array, n: number): Mat {
  const J = zeros(eqs.length, n)
  eqs.forEach((eq, i) => jacobianRow(eq, v, J[i]!))
  return J
}

function residuals(eqs: readonly Equation[], v: Float64Array): Float64Array {
  const r = new Float64Array(eqs.length)
  eqs.forEach((eq, i) => {
    r[i] = eq.f(v) * eq.weight
  })
  return r
}

function cost(r: Float64Array): number {
  let s = 0
  for (const x of r) s += x * x
  return s
}

/** One Levenberg–Marquardt run on a fixed equation set. */
function lm(eqs: readonly Equation[], v: Float64Array, n: number, maxIter: number, tol: number): number {
  let lambda = 1e-3
  let r = residuals(eqs, v)
  let c = cost(r)
  let iter = 0
  const hasSoft = eqs.some((eq) => eq.weight !== 1)
  let lastImprovement = Infinity
  for (; iter < maxIter; iter++) {
    let maxHard = 0
    eqs.forEach((eq, i) => {
      if (eq.weight === 1) maxHard = Math.max(maxHard, Math.abs(r[i]!))
    })
    // Hard equations satisfied: stop — unless soft terms (stay/drag) still
    // have somewhere to pull, in which case keep going while the cost keeps
    // dropping meaningfully.
    if (maxHard < tol && (!hasSoft || lastImprovement < 1e-14 * Math.max(1, c))) break
    const J = jacobian(eqs, v, n)
    // Normal equations: (JᵀJ + λ·diag(JᵀJ) + λ·1e-12 I) δ = -Jᵀr
    const A = zeros(n, n)
    const g = new Float64Array(n)
    for (let i = 0; i < eqs.length; i++) {
      const Ji = J[i]!
      const ri = r[i]!
      for (const a of eqs[i]!.deps) {
        g[a] = g[a]! + Ji[a]! * ri
        for (const b of eqs[i]!.deps) A[a]![b] = A[a]![b]! + Ji[a]! * Ji[b]!
      }
    }
    let improved = false
    for (let tries = 0; tries < 12; tries++) {
      const Ad = A.map((row) => Float64Array.from(row))
      for (let k = 0; k < n; k++) Ad[k]![k] = Ad[k]![k]! * (1 + lambda) + lambda * 1e-9 + 1e-14
      const negG = new Float64Array(n)
      for (let k = 0; k < n; k++) negG[k] = -g[k]!
      const delta = solveSPD(Ad, negG)
      if (!delta) {
        lambda *= 10
        continue
      }
      const vNew = Float64Array.from(v)
      for (let k = 0; k < n; k++) vNew[k] = vNew[k]! + delta[k]!
      const rNew = residuals(eqs, vNew)
      const cNew = cost(rNew)
      if (cNew < c || cNew < 1e-30) {
        v.set(vNew)
        r = rNew
        lastImprovement = c - cNew
        c = cNew
        lambda = Math.max(lambda / 3, 1e-12)
        improved = true
        break
      }
      lambda *= 5
    }
    if (!improved) break
  }
  return iter
}

export function solve(input: SolveInput): SolveResult {
  const { doc } = input
  const system = compile(doc, input.pinned)
  const { n, hard, index, pointIds } = system
  const v = new Float64Array(n)
  doc.points.forEach((p, i) => {
    const s = input.start?.get(p.id)
    v[2 * i] = s ? s.x : p.x
    v[2 * i + 1] = s ? s.y : p.y
  })
  const v0 = Float64Array.from(v)
  const pinnedSet = input.pinned ?? new Set<string>()

  // Phase 1: hard + soft stay (+ drag) — finds the nearby solution.
  const soft: Equation[] = []
  pointIds.forEach((pid, i) => {
    if (pinnedSet.has(pid)) return
    const ixp = 2 * i
    const target = input.drag?.get(pid)
    const w = target ? DRAG_W : SOFT_W
    const tx = target ? target.x : v0[ixp]!
    const ty = target ? target.y : v0[ixp + 1]!
    soft.push({ cid: `soft:${pid}`, deps: [ixp], f: (vv) => vv[ixp]! - tx, weight: w })
    soft.push({ cid: `soft:${pid}`, deps: [ixp + 1], f: (vv) => vv[ixp + 1]! - ty, weight: w })
  })
  let iterations = 0
  if (hard.length > 0) {
    iterations += lm([...hard, ...soft], v, n, 80, SOLVE_TOL)
    // Phase 2: polish on the hard set alone (damping → minimum-norm step).
    iterations += lm(hard, v, n, 40, SOLVE_TOL)
  } else if (input.drag) {
    iterations += lm(soft, v, n, 5, SOLVE_TOL)
  }

  const res = new Map<string, number>()
  for (const eq of hard) {
    const r = Math.abs(eq.f(v))
    res.set(eq.cid, Math.max(res.get(eq.cid) ?? 0, r))
  }
  const conflicts = [...res.entries()].filter(([, r]) => r > CONFLICT_TOL).map(([cid]) => cid)
  const points = new Map<string, Pt>()
  for (const [pid, i] of index) points.set(pid, { x: v[i]!, y: v[i + 1]! })
  return { ok: conflicts.length === 0, points, residuals: res, conflicts, iterations, system }
}
