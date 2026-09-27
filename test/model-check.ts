// The fitters must recover a model from its own response. Simulates known
// 1-pole and 2-pole models (complex, critical and overdamped) driven by a
// step, fits the result, and checks the poles and delay come back.
//
//   npx tsx test/model-check.ts

import { fit1PoleOutputError, fit2PoleOutputError, simulateFirstOrder, simulateSecondOrder } from '../src/engine/curveFit';

// A step of 100 units after 3 samples at rest, like a recorded step response.
const N = 60;
const step = Float64Array.from({ length: N }, (_, n) => (n < 3 ? 0 : 100));

let failed = false;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
  if (!ok) failed = true;
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

{
  const p = 0.7;
  const D = 4;
  const fit = fit1PoleOutputError(step, simulateFirstOrder(step, p, D));
  check('1-pole', near(fit.p, p, 0.002) && fit.D === D, `p=${fit.p.toFixed(3)} D=${fit.D} (built with p=${p} D=${D})`);
}

for (const [label, p1, p2, D] of [
  ['2-pole, underdamped', 0.8, 0.3, 5],
  ['2-pole, critically damped', 0.6, 0, 3],
  ['2-pole, overdamped', 0.6, -0.2, 6],
] as const) {
  const fit = fit2PoleOutputError(step, simulateSecondOrder(step, p1, p2, D));
  const ok = near(fit.p1, p1, 0.005) && near(fit.p2, p2, 0.005) && fit.D === D;
  check(label, ok, `p1=${fit.p1.toFixed(3)} p2=${fit.p2.toFixed(3)} D=${fit.D} (built with p1=${p1} p2=${p2} D=${D})`);
}

// Unity DC gain: the response settles on the step it was given.
{
  const y = simulateSecondOrder(Float64Array.from({ length: 400 }, () => 100), 0.8, 0.3, 5);
  check('2-pole, unity gain', near(y[y.length - 1], 100, 1e-6), `settles at ${y[y.length - 1].toFixed(6)}`);
}

if (failed) {
  console.error('\nModel check FAILED');
  process.exitCode = 1;
} else {
  console.log('\nModel check passed: the fitters recover every model from its own response.');
}
