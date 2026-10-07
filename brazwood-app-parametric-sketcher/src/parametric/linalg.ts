// src/parametric/linalg.ts
// Dense linear algebra for the constraint solver — sizes are tiny (a sketch
// has tens of points), so plain arrays of Float64Array are the right tool.
// No dependency: nothing in the catalog does this and the solver must stay
// framework-free (same doctrine as roofwizard/freeWalls.ts).

export type Mat = Float64Array[]

export const zeros = (rows: number, cols: number): Mat =>
  Array.from({ length: rows }, () => new Float64Array(cols))

/** Solve A x = b for symmetric positive-definite A (Cholesky). Returns null
 *  when A is not SPD within tolerance (caller raises damping). */
export function solveSPD(A: Mat, b: Float64Array): Float64Array | null {
  const n = b.length
  const L = zeros(n, n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i]![j]!
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!
      if (i === j) {
        if (s <= 1e-300) return null
        L[i]![j] = Math.sqrt(s)
      } else {
        L[i]![j] = s / L[j]![j]!
      }
    }
  }
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = b[i]!
    for (let k = 0; k < i; k++) s -= L[i]![k]! * y[k]!
    y[i] = s / L[i]![i]!
  }
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!
    x[i] = s / L[i]![i]!
  }
  return x
}

export interface Rref {
  /** Reduced matrix (copy). */
  R: Mat
  /** Pivot column for each pivot row, in order. */
  pivots: number[]
  rank: number
}

/** Reduced row-echelon form with partial pivoting and a RELATIVE tolerance
 *  (entries below tol × the matrix's largest absolute entry are zero). */
export function rref(M: Mat, cols: number, tol = 1e-9): Rref {
  const R = M.map((r) => Float64Array.from(r))
  const rows = R.length
  let maxAbs = 0
  for (const r of R) for (let j = 0; j < cols; j++) maxAbs = Math.max(maxAbs, Math.abs(r[j]!))
  const eps = tol * (maxAbs > 0 ? maxAbs : 1)
  const pivots: number[] = []
  let row = 0
  for (let col = 0; col < cols && row < rows; col++) {
    let best = row
    for (let i = row + 1; i < rows; i++) if (Math.abs(R[i]![col]!) > Math.abs(R[best]![col]!)) best = i
    if (Math.abs(R[best]![col]!) <= eps) continue
    if (best !== row) {
      const t = R[best]!
      R[best] = R[row]!
      R[row] = t
    }
    const pr = R[row]!
    const pv = pr[col]!
    for (let j = 0; j < cols; j++) pr[j] = pr[j]! / pv
    for (let i = 0; i < rows; i++) {
      if (i === row) continue
      const f = R[i]![col]!
      if (f === 0) continue
      const ri = R[i]!
      for (let j = 0; j < cols; j++) ri[j] = ri[j]! - f * pr[j]!
    }
    pivots.push(col)
    row++
  }
  return { R, pivots, rank: pivots.length }
}

/** Null-space basis of M (cols variables): one vector per free column. */
export function nullSpace(M: Mat, cols: number, tol = 1e-9): Float64Array[] {
  const { R, pivots } = rref(M, cols, tol)
  const pivotSet = new Set(pivots)
  const free: number[] = []
  for (let j = 0; j < cols; j++) if (!pivotSet.has(j)) free.push(j)
  return free.map((fc) => {
    const v = new Float64Array(cols)
    v[fc] = 1
    pivots.forEach((pc, i) => {
      v[pc] = -R[i]![fc]!
    })
    return v
  })
}

export function transpose(M: Mat, cols: number): Mat {
  const T = zeros(cols, M.length)
  for (let i = 0; i < M.length; i++) for (let j = 0; j < cols; j++) T[j]![i] = M[i]![j]!
  return T
}
