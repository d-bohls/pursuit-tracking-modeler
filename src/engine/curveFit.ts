// Least-squares fitting of the 1-pole and 2-pole models: a coarse-to-fine
// grid search for the pole(s) and delay that best reproduce the target.

import { pairProduct } from './poleConversion';

export interface Fit1PoleResult {
  p: number;
  D: number;
  error: number;
}

export interface Fit2PoleResult {
  p1: number;
  p2: number;
  D: number;
  error: number;
  /** true if every sample of h was indistinguishable from zero -- no fit was possible. */
  degenerate: boolean;
}

function sumOfSquaresAgainstModel(h: Float64Array, model: (n: number) => number): number {
  let sum = 0;
  for (let i = 0; i < h.length; i++) {
    const d = h[i] - model(i);
    sum += d * d;
  }
  return sum;
}

/** First-order model: h_hat[n] = (1-p) * p^(n-D) for n >= D, else 0. */
export function fit1PoleTimeDomain(h: Float64Array): Fit1PoleResult {
  const n = h.length;
  if (n === 0) return { p: 0, D: 0, error: NaN };

  let Dmin = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(h[i]) > 0) {
      Dmin = i;
      break;
    }
  }
  let Dmax = n - 1;
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (h[i] > max) {
      max = h[i];
      Dmax = i;
    }
  }
  if (Dmin > Dmax) Dmax = Dmin;

  let dp = 0.1;
  let pmin = 0;
  let pmax = 1;
  let bestP = 0;
  let bestD = Dmin;
  let leastSum = Infinity;

  const model = (p: number, D: number) => (i: number) => (i < D ? 0 : (1 - p) * Math.pow(p, i - D));

  while (true) {
    for (let D = Dmin; D <= Dmax; D += 1) {
      for (let p = pmin; p <= pmax + 1e-12; p += dp) {
        const cur = sumOfSquaresAgainstModel(h, model(p, D));
        if (cur < leastSum) {
          leastSum = cur;
          bestP = p;
          bestD = D;
        }
      }
    }
    pmin = bestP - dp;
    pmax = bestP + dp;
    if (dp === 0.001) break;
    dp = dp === 0.1 ? 0.01 : 0.001;
  }

  return { p: bestP, D: bestD, error: leastSum };
}

/**
 * Second-order (complex-conjugate pole pair) model:
 *   h_hat[n] = value3 * value2^(n-(D-1)) * sin(value4*(n-(D-1))) / p2   for n >= D-1, else 0
 * where value2 = |pole| = sqrt(p1^2+p2^2), value3 = 1-2*p1+value2^2 (DC-gain
 * numerator), value4 = angle(pole) = acos(p1/value2).
 */
export function fit2PoleTimeDomain(h: Float64Array): Fit2PoleResult {
  const n = h.length;
  if (n === 0) return { p1: 0, p2: 0, D: 0, error: NaN, degenerate: true };

  let Dmin = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(h[i]) > 0) {
      Dmin = i;
      break;
    }
  }
  let Dmax = n - 1;
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (h[i] > max) {
      max = h[i];
      Dmax = i;
    }
  }
  if (Dmin > Dmax) Dmax = Dmin;

  // NOTE ON THE (D - 1) OFFSET -- do not "fix" this to (D).
  //
  // It looks like an off-by-one next to fit1PoleTimeDomain, which uses
  // p^(n - D). It isn't. The two closed forms have different values at their
  // own origin: p^0 = 1, but sin(theta * 0) = 0. So the second-order form has
  // to start one sample earlier for its first NONZERO sample to land on n = D,
  // which is the delay the printed difference equation
  //   y[n] - 2*p1*y[n-1] + (p1^2+p2^2)*y[n-2] = gain * x[n-D]
  // actually means. At n = D the exponent is 1 and the model evaluates to
  // gain * r * sin(theta) / p2 = gain, since p2 = r*sin(theta) -- exactly the
  // first sample the difference equation produces.
  //
  // Verified mechanically: test/model-check.ts runs that difference
  // equation as a recursion and compares. The (D - 1) form agrees to 1.7e-16;
  // the (D) form is off by exactly one sample. Both offsets are correct for
  // their own parameterization, and both describe the same delay D.
  const modelH = (p1: number, p2: number, D: number, i: number): number => {
    const value1 = p1 * p1 + p2 * p2;
    const value2 = Math.sqrt(value1);
    const value3 = 1 - 2 * p1 + value1;
    const value4 = Math.acos(Math.max(-1, Math.min(1, p1 / value2)));
    const exponent = i - (D - 1);
    if (exponent < 0) return 0;
    return (value3 * Math.pow(value2, exponent) * Math.sin(value4 * exponent)) / p2;
  };

  // p1 ranges over both signs -- a pole's real part genuinely can be negative.
  //
  // p2 MUST NOT. The pole pair is p1 +/- j*p2, so +p2 and -p2 name the same
  // pair, and the difference equation this fit reports
  //   y[n] - 2*p1*y[n-1] + (p1^2 + p2^2)*y[n-2] = gain*x[n-D]
  // depends on p2 only through p2^2 -- the sign carries no information about
  // the system. But the closed form above divides by p2, so flipping the sign
  // negates the whole modelled response: h[D] becomes -gain instead of +gain,
  // and gain = (1-p1)^2 + p2^2 is always positive. A negative-p2 fit therefore
  // matches -1x a valid impulse response, i.e. a system whose difference
  // equation is NOT the one that then gets printed and simulated.
  let dp = 0.1;
  let p1min = -0.95;
  let p1max = 0.95;
  let p2min = dp;
  let p2max = 0.95;
  let bestP1 = 0;
  let bestP2 = dp;
  let bestD = Dmin;
  let leastSum = Infinity;

  while (true) {
    for (let D = Dmin; D <= Dmax; D += 1) {
      for (let p1 = p1min; p1 <= p1max + 1e-12; p1 += dp) {
        for (let p2 = p2min; p2 <= p2max + 1e-12; p2 += dp) {
          if (p2 < 1e-9) continue; // p2 -> 0 collapses the pair onto the real axis; the model divides by it
          if (p1 * p1 + p2 * p2 >= 0.999) continue; // reject unstable/marginal poles (|pole| >= ~1)
          const cur = sumOfSquaresAgainstModel(h, (i) => modelH(p1, p2, D, i));
          if (cur < leastSum) {
            leastSum = cur;
            bestP1 = p1;
            bestP2 = p2;
            bestD = D;
          }
        }
      }
    }
    p1min = bestP1 - dp;
    p1max = bestP1 + dp;
    p2min = Math.max(1e-9, bestP2 - dp); // never let refinement walk back into p2 <= 0
    p2max = bestP2 + dp;
    if (dp === 0.001) break;
    dp = dp === 0.1 ? 0.01 : 0.001;
  }

  return { p1: bestP1, p2: bestP2, D: bestD, error: leastSum, degenerate: !Number.isFinite(leastSum) };
}

// ---------------------------------------------------------------------------
// Output-error identification
// ---------------------------------------------------------------------------
// There is no need to go through h[n]. Both x[n] and y[n] are recorded, so the
// model can be driven by the real input and compared against the real output
// directly. That is standard output-error identification, it avoids
// deconvolution's numerical fragility, and it fits the recorded
// responses far more closely.
//
// Deconvolution and the DFT are still computed, for the frequency-response
// plot; they are just no longer what the parameters are fitted against.

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
 */
export function simulateSecondOrder(xn: ArrayLike<number>, p1: number, p2: number, D: number): Float64Array {
  const n = xn.length;
  const a1 = 2 * p1;
  const a2 = pairProduct(p1, p2);
  const gain = 1 - 2 * p1 + a2;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const y1 = k >= 1 ? out[k - 1] : 0;
    const y2 = k >= 2 ? out[k - 2] : 0;
    out[k] = a1 * y1 - a2 * y2 + gain * (k - D >= 0 ? xn[k - D] : 0);
  }
  return out;
}

function rmsAgainst(yn: ArrayLike<number>, sim: Float64Array): number {
  let s = 0;
  for (let k = 0; k < sim.length; k++) s += (yn[k] - sim[k]) ** 2;
  return Math.sqrt(s / sim.length);
}

export function fit1PoleOutputError(xn: ArrayLike<number>, yn: ArrayLike<number>): OutputErrorFit1 {
  const maxD = Math.max(1, Math.min(20, Math.floor(xn.length / 2)));
  let best: OutputErrorFit1 = { p: 0, D: 0, rms: Infinity };
  let dp = 0.05;
  let pmin = 0;
  let pmax = 0.99;
  for (let pass = 0; pass < 3; pass++) {
    for (let D = 0; D <= maxD; D++) {
      for (let p = Math.max(0, pmin); p <= Math.min(0.999, pmax) + 1e-12; p += dp) {
        const r = rmsAgainst(yn, simulateFirstOrder(xn, p, D));
        if (r < best.rms) best = { p, D, rms: r };
      }
    }
    pmin = best.p - dp;
    pmax = best.p + dp;
    dp /= 5;
  }
  return best;
}

export function fit2PoleOutputError(xn: ArrayLike<number>, yn: ArrayLike<number>): OutputErrorFit2 {
  const maxD = Math.max(1, Math.min(20, Math.floor(xn.length / 2)));
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
          const r = rmsAgainst(yn, simulateSecondOrder(xn, p1, p2, D));
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
  const real = fitRealPair(xn, yn, maxD);
  return real.rms < best.rms ? real : best;
}

/** Best pair of real poles in (0, 1), same three-pass refinement as the complex search. */
function fitRealPair(xn: ArrayLike<number>, yn: ArrayLike<number>, maxD: number): OutputErrorFit2 {
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
          const r = rmsAgainst(yn, simulateSecondOrder(xn, c, -h, D));
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
