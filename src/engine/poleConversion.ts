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
    ci = Math.atan2(di, dr) / tsSeconds;
  }
  return { cr, ci };
}
