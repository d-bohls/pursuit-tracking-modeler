// Identification must call a response what it is. Feeds exact step responses
// of known pole pairs through the real per-response analysis and checks the
// damping it reports.
//
// A fit that only searched complex pole pairs, or a label that tested
// zeta === 1 exactly, would call a critically damped response "underdamped"
// (zeta 0.9999...) and could not represent an overdamped one at all.
//
//   npx tsx test/damping-check.ts

import { analyzeStepResponse, dampingCharacter, dampingMetrics } from '../src/engine/analysis';
import { padResponses } from '../src/engine/stepResponses';

/** Unit-DC step response of y[n] = c1*y[n-1] - c2*y[n-2] + g*x[n-D], with optional noise. */
function stepResponse(c1: number, c2: number, D: number, noise = 0) {
  const n = 40;
  const xn = new Float64Array(n).fill(80);
  const yn = new Float64Array(n);
  const g = 1 - c1 + c2;
  for (let k = 0; k < n; k++) {
    const y1 = k >= 1 ? yn[k - 1] : 0;
    const y2 = k >= 2 ? yn[k - 2] : 0;
    yn[k] = c1 * y1 - c2 * y2 + g * (k - D >= 0 ? xn[k - D] : 0);
  }
  // Seeded pseudo-random noise: like measurement noise, but the same every
  // run, so the check never flakes.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let k = 0; k < n; k++) yn[k] += noise * rand();
  return { xn, yn };
}
const realPair = (a: number, b: number, noise = 0) => stepResponse(a + b, a * b, 5, noise);
const complexPair = (r: number, deg: number) => stepResponse(2 * r * Math.cos((deg * Math.PI) / 180), r * r, 5);

const cases: Array<[string, ReturnType<typeof stepResponse>, string]> = [
  ['underdamped (0.85 at 25°)', complexPair(0.85, 25), 'underdamped'],
  ['critically damped (double pole 0.7)', realPair(0.7, 0.7), 'critically damped'],
  ['critically damped, noisy', realPair(0.7, 0.7, 2), 'critically damped'],
  ['overdamped (0.5 and 0.85)', realPair(0.5, 0.85), 'overdamped'],
  ['overdamped, noisy', realPair(0.5, 0.85, 2), 'overdamped'],
  ['strongly overdamped (0.2 and 0.9)', realPair(0.2, 0.9), 'overdamped'],
];

let failed = false;
for (const [label, response, expected] of cases) {
  const [padded] = padResponses([response], 10);
  const { zeta } = dampingMetrics(analyzeStepResponse(response, padded, 100).continuous);
  const got = dampingCharacter(zeta);
  const ok = got === expected;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(36)} ζ = ${zeta.toFixed(3)} -> ${got}`);
}
if (failed) {
  console.error('\nDamping check FAILED');
  process.exitCode = 1;
} else {
  console.log('\nDamping check passed: critical and overdamped responses are named as such.');
}
