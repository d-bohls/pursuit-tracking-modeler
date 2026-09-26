// Checks the second-order closed-form impulse response used by the curve
// fitter against the difference equation the UI actually prints, by running
// that difference equation as a recursion and comparing sample by sample.
//
// This exists because the delay offset in the 2-pole model (n - (D-1)) looks
// like an off-by-one next to the 1-pole model (n - D), and it is worth being
// able to settle that question mechanically instead of by eye.
//
//   npx tsx test/model-check.ts

import { fit2PoleTimeDomain } from '../src/engine/curveFit';

const P1 = 0.8;
const P2 = 0.3;
const D = 5;
const N = 40;

const gain = 1 - 2 * P1 + P1 * P1 + P2 * P2;

// Ground truth: the printed difference equation
//   y[n] - 2*p1*y[n-1] + (p1^2+p2^2)*y[n-2] = gain * x[n-D]
// driven by an impulse x[n] = delta[n], so the forcing term fires at n = D.
const truth = new Float64Array(N);
for (let n = 0; n < N; n++) {
  const y1 = n >= 1 ? truth[n - 1] : 0;
  const y2 = n >= 2 ? truth[n - 2] : 0;
  const forcing = n === D ? gain : 0;
  truth[n] = 2 * P1 * y1 - (P1 * P1 + P2 * P2) * y2 + forcing;
}

// The closed form, parameterized by which delay offset it uses.
function closedForm(offset: number): Float64Array {
  const r = Math.sqrt(P1 * P1 + P2 * P2);
  const theta = Math.acos(P1 / r);
  const out = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const k = n - offset;
    out[n] = k < 0 ? 0 : (gain * Math.pow(r, k) * Math.sin(theta * k)) / P2;
  }
  return out;
}

const maxAbsDiff = (a: Float64Array, b: Float64Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

const asShipped = closedForm(D - 1);
const proposed = closedForm(D);

console.log(`Second-order model check: p1=${P1}, p2=${P2}, D=${D}, gain=${gain.toFixed(4)}\n`);
console.log('n     difference eqn   closed form n-(D-1)   closed form n-D');
for (let n = 0; n < 10; n++) {
  console.log(
    `${String(n).padStart(2)}  ${truth[n].toFixed(6).padStart(14)}  ${asShipped[n].toFixed(6).padStart(18)}  ${proposed[n].toFixed(6).padStart(16)}`,
  );
}

const errShipped = maxAbsDiff(truth, asShipped);
const errProposed = maxAbsDiff(truth, proposed);
console.log(`\nmax |difference eqn - closed form|`);
console.log(`  offset n-(D-1)  : ${errShipped.toExponential(3)}`);
console.log(`  offset n-D      : ${errProposed.toExponential(3)}`);

// And does the fitter recover the delay the difference equation was built with?
const fit = fit2PoleTimeDomain(truth);
console.log(`\nfit of the ground-truth response: p1=${fit.p1.toFixed(3)}, p2=${fit.p2.toFixed(3)}, D=${fit.D}`);
console.log(`  (built with p1=${P1}, p2=${P2}, D=${D})`);

const verdict = errShipped < 1e-9 ? 'n-(D-1) is correct' : errProposed < 1e-9 ? 'n-D is correct' : 'NEITHER matches';
console.log(`\nverdict: ${verdict}`);
if (errShipped > 1e-9 && errProposed > 1e-9) process.exitCode = 1;
