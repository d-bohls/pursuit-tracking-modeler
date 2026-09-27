// z = exp(s*Ts): the mapping between an s-plane (Laplace) pole and its z-plane
// (discrete-time) counterpart under sample period Ts.
//
// Ts is in SECONDS, so the returned poles are in rad/s and share one time
// unit with the delays. Passing the sample period in milliseconds would put
// the poles in rad/ms, 1000x off from everything beside them.

/** s = cr + j*ci  -->  z = r*exp(j*w) = exp(s*Ts). Ts in seconds. */
export function continuousPoleToDiscrete(cr: number, ci: number, tsSeconds: number): { dr: number; di: number } {
  const r = Math.exp(cr * tsSeconds);
  const w = ci * tsSeconds;
  return { dr: r * Math.cos(w), di: r * Math.sin(w) };
}

/** z = dr + j*di  -->  s = ln(z)/Ts. Ts in seconds; result in rad/s. */
export function discretePoleToContinuous(dr: number, di: number, tsSeconds: number): { cr: number; ci: number } {
  if (dr === 0 && di === 0) {
    return { cr: -Infinity, ci: 0 }; // pole at the origin -> s -> -infinity
  }
  const cr = Math.log(dr * dr + di * di) / (2 * tsSeconds);
  let ci: number;
  if (dr === 0) {
    ci = (di < 0 ? -1 : 1) * (Math.PI / 2 / tsSeconds);
  } else {
    ci = Math.atan2(di, dr) / tsSeconds; // atan2, not atan(di/dr), which loses the quadrant when dr < 0
  }
  return { cr, ci };
}

// ------------------------------------------------------------ pole PAIRS
//
// The second-order model's two poles are stored as one pair (p1, p2):
//
//   p2 > 0   a complex pair, p1 +/- j*p2 -- underdamped
//   p2 = 0   a double real pole at p1   -- critically damped
//   p2 < 0   two real poles, p1 +/- |p2| -- overdamped
//
// With only the first case, an overdamped response would collapse to the
// nearest complex pair and report zeta just under 1 -- "underdamped" --
// however carefully it avoided overshoot. A signed p2 keeps one continuous
// knob through critical damping, so step responses can still be averaged and
// medianed parameter by parameter. The same convention holds in continuous
// time: (cr, ci) with ci < 0 means the real poles cr +/- |ci|.

/** Product of the pair: the y[n-2] coefficient of the recursion, and |z|^2 for a complex pair. */
export function pairProduct(p1: number, p2: number): number {
  return p1 * p1 + p2 * Math.abs(p2);
}

/** Natural frequency of a continuous pair: sqrt of the product of its poles. */
export function pairNaturalFrequency(cr: number, ci: number): number {
  return Math.sqrt(Math.max(0, pairProduct(cr, ci)));
}

/** A discrete pole pair to its continuous pair, under z = exp(s*Ts). */
export function discretePairToContinuous(dr: number, di: number, tsSeconds: number): { cr: number; ci: number } {
  if (di >= 0) return discretePoleToContinuous(dr, di, tsSeconds);
  // Two real poles map one by one. A pole at or below zero has no real log;
  // the fit never produces one, so clamp rather than return a complex answer.
  const s1 = Math.log(Math.max(1e-9, dr - di)) / tsSeconds; // dr + |di|
  const s2 = Math.log(Math.max(1e-9, dr + di)) / tsSeconds; // dr - |di|
  return { cr: (s1 + s2) / 2, ci: -(s1 - s2) / 2 };
}

/** A continuous pole pair to its discrete pair, under z = exp(s*Ts). */
export function continuousPairToDiscrete(cr: number, ci: number, tsSeconds: number): { dr: number; di: number } {
  if (ci >= 0) return continuousPoleToDiscrete(cr, ci, tsSeconds);
  const z1 = Math.exp((cr - ci) * tsSeconds); // cr + |ci|
  const z2 = Math.exp((cr + ci) * tsSeconds); // cr - |ci|
  return { dr: (z1 + z2) / 2, di: -(z1 - z2) / 2 };
}
