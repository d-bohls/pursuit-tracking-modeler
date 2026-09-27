
import { readFileSync } from 'node:fs';
import { parseSessionFile } from '../src/engine/dataFormat';
import { analyzeExperiment, firstOrderDifferenceEquation, secondOrderDifferenceEquation } from '../src/engine/analysis';

const path = process.argv[2] ?? 'test/data/reference-data.txt';
const text = readFileSync(path, 'utf-8');
const { xs, ys } = parseSessionFile(text);
console.log(`Loaded ${xs.length} raw samples from ${path}`);

const SAMPLE_PERIOD_MS = 100;

const result = analyzeExperiment(xs, ys, SAMPLE_PERIOD_MS);
console.log(`Parsed into ${result.responses.length} responses.\n`);

const round = (v: number, d = 3) => Number(v.toFixed(d));

console.log('per-response P21:', result.responses.map((t) => round(t.discrete.P21)));
console.log('per-response P22:', result.responses.map((t) => round(t.discrete.P22)));
console.log('per-response D2 :', result.responses.map((t) => t.discrete.D2));
console.log(
  'per-response RMS error (px):',
  result.responses.map((t) => round(t.fit2Rms, 2)),
);
console.log();
console.log('Average model:', secondOrderDifferenceEquation(result.averageDiscrete));
console.log('First-order avg model:', firstOrderDifferenceEquation(result.averageDiscrete));

const poleMag = Math.sqrt(result.averageDiscrete.P21 ** 2 + result.averageDiscrete.P22 ** 2);
console.log(`avg P21 = ${round(result.averageDiscrete.P21, 4)}, avg P22 = ${round(result.averageDiscrete.P22, 4)}, avg D2 = ${round(result.averageDiscrete.D2, 2)}`);
console.log(`pole magnitude = ${round(poleMag, 4)} (stable iff < 1)`);
console.log(`mean RMS error = ${round(result.responses.reduce((a, t) => a + t.fit2Rms, 0) / result.responses.length, 2)} px`);
console.log(`median model: ${secondOrderDifferenceEquation(result.medianDiscrete)}`);
