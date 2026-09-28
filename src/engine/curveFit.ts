// Output-error identification of the 1-pole and 2-pole models: each model is
// driven by the recorded input x[n], and the pole(s) and delay are chosen to
// minimise the RMS error against the recorded response y[n]. Each search is a
// coarse-to-fine grid (three passes, re-centred on the best guess each time).
//
// Fitting the response itself, rather than the deconvolved impulse response
// h[n], matters: for a held-step input h[n] is the first difference of the
// response, which amplifies the fast initial transient and shrinks the slow
// ringing tail -- the very part that carries the damping. Deconvolution and
// the DFT are computed only for the frequency-response plot.
//
// A complex pair is searched with p2 > 0: its recursion depends on p2 only
// through p2^2, so a negative p2 would be the same system. Negative p2 is
// reserved for real pairs, which are searched separately (see pairProduct).

import { pairProduct } from './poleConversion';

export interface OutputErrorFit1 {
  p: number;
  D: number;
  /** RMS error against the recorded response, in the same units as y (pixels). */
  rms: number;
}

export interface OutputErrorFit2 {
  p1: number;
  p2: number;
  D: number;
  rms: number;
}

/** y[n] = p*y[n-1] + (1-p)*x[n-D] driven by the recorded input. */
export function simulateFirstOrder(xn: ArrayLike<number>, p: number, D: number): Float64Array {
  const n = xn.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const y1 = k >= 1 ? out[k - 1] : 0;
    out[k] = p * y1 + (1 - p) * (k - D >= 0 ? xn[k - D] : 0);
  }
  return out;
}

/**
 * y[n] = 2*p1*y[n-1] - a2*y[n-2] + gain*x[n-D], gain fixed for unity DC, where
 * a2 is the product of the pair -- see pairProduct for what a negative p2 means.
 * D may fall between samples -- the median of an even number of delays does --
 * and x is then read by linear interpolation.
 */
export function simulateSecondOrder(xn: ArrayLike<number>, p1: number, p2: number, D: number): Float64Array {
  const n = xn.length;
  const a1 = 2 * p1;
  const a2 = pairProduct(p1, p2);
  const gain = 1 - 2 * p1 + a2;
  const whole = Math.floor(D);
  const frac = D - whole;
  const x = (j: number) => (j >= 0 && j < n ? xn[j] : 0);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const y1 = k >= 1 ? out[k - 1] : 0;
    const y2 = k >= 2 ? out[k - 2] : 0;
    const delayed = frac === 0 ? x(k - whole) : (1 - frac) * x(k - whole) + frac * x(k - whole - 1);
    out[k] = a1 * y1 - a2 * y2 + gain * delayed;
  }
  return out;
}

/**
 * What a fit is scored against: one or more recorded responses, each with a
 * weight on its mean squared error. One target with weight 1 is the ordinary
 * single-response fit; several are a joint fit of one model to all of them.
 */
export interface FitTarget {
  xn: ArrayLike<number>;
  yn: ArrayLike<number>;
  weight: number;
}

/** sqrt of the weighted sum of mean squared errors: the RMS, for one target of weight 1. */
function scoreAgainst(targets: FitTarget[], simulate: (xn: ArrayLike<number>) => Float64Array): number {
  let total = 0;
  for (const { xn, yn, weight } of targets) {
    const sim = simulate(xn);
    let s = 0;
    for (let k = 0; k < sim.length; k++) s += (yn[k] - sim[k]) ** 2;
    total += (weight * s) / sim.length;
  }
  return Math.sqrt(total);
}

/** The longest delay searched: 20 samples, and no more than half the shortest response. */
function maxDelayFor(targets: FitTarget[]) {
  const shortest = Math.min(...targets.map((t) => t.xn.length));
  return Math.max(1, Math.min(20, Math.floor(shortest / 2)));
}

export function fit1PoleOutputError(xn: ArrayLike<number>, yn: ArrayLike<number>): OutputErrorFit1 {
  return fit1Pole([{ xn, yn, weight: 1 }]);
}

export function fit2PoleOutputError(xn: ArrayLike<number>, yn: ArrayLike<number>): OutputErrorFit2 {
  return fit2Pole([{ xn, yn, weight: 1 }]);
}

export function fit1Pole(targets: FitTarget[]): OutputErrorFit1 {
  const maxD = maxDelayFor(targets);
  let best: OutputErrorFit1 = { p: 0, D: 0, rms: Infinity };
  let dp = 0.05;
  let pmin = 0;
  let pmax = 0.99;
  for (let pass = 0; pass < 3; pass++) {
    for (let D = 0; D <= maxD; D++) {
      for (let p = Math.max(0, pmin); p <= Math.min(0.999, pmax) + 1e-12; p += dp) {
        const r = scoreAgainst(targets, (xn) => simulateFirstOrder(xn, p, D));
        if (r < best.rms) best = { p, D, rms: r };
      }
    }
    pmin = best.p - dp;
    pmax = best.p + dp;
    dp /= 5;
  }
  return best;
}

export function fit2Pole(targets: FitTarget[]): OutputErrorFit2 {
  const maxD = maxDelayFor(targets);
  let best: OutputErrorFit2 = { p1: 0, p2: 0.05, D: 0, rms: Infinity };
  let dp = 0.05;
  let p1min = -0.95;
  let p1max = 0.95;
  let p2min = dp;
  let p2max = 0.95;
  for (let pass = 0; pass < 3; pass++) {
    for (let D = 0; D <= maxD; D++) {
      for (let p1 = p1min; p1 <= p1max + 1e-12; p1 += dp) {
        for (let p2 = Math.max(1e-6, p2min); p2 <= p2max + 1e-12; p2 += dp) {
          if (p1 * p1 + p2 * p2 >= 0.999) continue; // keep the pole inside the unit circle
          const r = scoreAgainst(targets, (xn) => simulateSecondOrder(xn, p1, p2, D));
          if (r < best.rms) best = { p1, p2, D, rms: r };
        }
      }
    }
    p1min = best.p1 - dp;
    p1max = best.p1 + dp;
    p2min = Math.max(1e-6, best.p2 - dp);
    p2max = best.p2 + dp;
    dp /= 5;
  }

  // The complex search above cannot represent two real poles -- an
  // overdamped response -- so search those separately, as a centre c and a
  // half-split h (poles c +/- h, stored as p2 = -h). It is kept only if it
  // fits strictly better, so a response the complex pair already describes
  // is identified exactly as before. h = 0 is the double pole: critical.
  const real = fitRealPair(targets, maxD);
  return real.rms < best.rms ? real : best;
}

/**
 * A 2-pole fit started from candidate models rather than searched from
 * scratch: the candidate that scores best against the targets is refined
 * locally, to the same final resolution as fit2Pole. For a joint fit the
 * candidates are the responses' own fits, and the joint optimum lies among
 * them; this finds it in a fraction of the time a full search takes, which
 * matters while a recording is running.
 */
export function refine2Pole(
  targets: FitTarget[],
  candidates: Array<{ p1: number; p2: number; D: number }>,
): OutputErrorFit2 {
  const maxD = maxDelayFor(targets);
  const score = (p1: number, p2: number, D: number) =>
    scoreAgainst(targets, (xn) => simulateSecondOrder(xn, p1, p2, D));
  let best: OutputErrorFit2 = { p1: 0, p2: 0.05, D: 0, rms: Infinity };
  for (const c of candidates) {
    const D = Math.min(maxD, Math.max(0, Math.round(c.D)));
    const r = score(c.p1, c.p2, D);
    if (r < best.rms) best = { p1: c.p1, p2: c.p2, D, rms: r };
  }
  // Near critical damping the best model may be on either side of the
  // complex/real boundary, so refine both ways there.
  const start = best;
  for (const kind of start.p2 >= 0.05 ? ['complex'] : start.p2 <= -0.05 ? ['real'] : ['complex', 'real']) {
    let cur = start;
    for (const dp of [0.01, 0.002]) {
      const from = cur;
      for (let D = Math.max(0, from.D - 2); D <= Math.min(maxD, from.D + 2); D++) {
        for (let i = -5; i <= 5; i++) {
          for (let j = -5; j <= 5; j++) {
            let p1: number;
            let p2: number;
            if (kind === 'complex') {
              p1 = from.p1 + i * dp;
              p2 = Math.max(1e-6, Math.abs(from.p2) + j * dp);
              if (p1 * p1 + p2 * p2 >= 0.999) continue;
            } else {
              const h = Math.max(0, -Math.min(0, from.p2) + j * dp);
              p1 = from.p1 + i * dp;
              p2 = -h;
              if (p1 - h <= 0 || p1 + h >= 0.999) continue;
            }
            const r = score(p1, p2, D);
            if (r < cur.rms) cur = { p1, p2, D, rms: r };
          }
        }
      }
    }
    if (cur.rms < best.rms) best = cur;
  }
  return best;
}

/** Best pair of real poles in (0, 1), same three-pass refinement as the complex search. */
function fitRealPair(targets: FitTarget[], maxD: number): OutputErrorFit2 {
  let best: OutputErrorFit2 = { p1: 0.5, p2: 0, D: 0, rms: Infinity };
  let dp = 0.05;
  let cmin = dp;
  let cmax = 0.95;
  let hmin = 0;
  let hmax = 0.5;
  for (let pass = 0; pass < 3; pass++) {
    for (let D = 0; D <= maxD; D++) {
      for (let c = cmin; c <= cmax + 1e-12; c += dp) {
        for (let h = Math.max(0, hmin); h <= hmax + 1e-12; h += dp) {
          // both poles real, positive and inside the unit circle
          if (c - h <= 0 || c + h >= 0.999) continue;
          const r = scoreAgainst(targets, (xn) => simulateSecondOrder(xn, c, -h, D));
          if (r < best.rms) best = { p1: c, p2: -h, D, rms: r };
        }
      }
    }
    cmin = best.p1 - dp;
    cmax = best.p1 + dp;
    hmin = -best.p2 - dp;
    hmax = -best.p2 + dp;
    dp /= 5;
  }
  return best;
}
