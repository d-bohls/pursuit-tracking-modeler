// The model card: the identified model's numbers, what they mean, and the
// transfer functions they come from.

import type { SimulationMode } from './experiment';
import {
  aggregateResponses,
  dampingCharacter,
  dampingMetrics,
  secondOrderDifferenceEquation,
  type StepResponseAnalysis,
} from '../engine/analysis';
import { outlierBounds, outlierKindOf } from '../engine/outliers';
import { pairProduct } from '../engine/poleConversion';
import { $ } from './dom';
import { selfTestLabel } from './labels';

const readoutEl = $<HTMLDivElement>('readout');
const readoutSource = $<HTMLParagraphElement>('readoutSource');
const readoutHeading = $<HTMLHeadingElement>('readoutHeading');

export interface ReadoutInput {
  responses: StepResponseAnalysis[];
  excluded: ReadonlySet<number>;
  samplePeriodMs: number;
  /** Who produced the step responses: you, or a model in a self-test. */
  source: SimulationMode;
}

function tile(label: string, value: string, unit: string, note: string) {
  return (
    `<div class="tile"><p class="tile-label">${label}</p>` +
    `<p class="tile-value">${value}<span class="unit">${unit}</span></p>` +
    `<p class="tile-note">${note}</p></div>`
  );
}

export function renderReadout({ responses, excluded, samplePeriodMs, source }: ReadoutInput) {
  // A model run must never be presented as yours: the heading names whose
  // system this is, taken from the data on screen rather than the setting.
  const byModel = source !== 'none' && responses.length > 0;
  readoutHeading.textContent = byModel ? selfTestLabel(source) : 'Your model';
  readoutHeading.parentElement!.parentElement!.dataset.source = byModel ? 'model' : 'you';

  const included = responses.filter((_, i) => !excluded.has(i));
  if (included.length === 0) {
    readoutSource.textContent = responses.length === 0 ? '' : 'All step responses excluded';
    readoutEl.innerHTML =
      responses.length === 0
        ? '<p class="empty">Record a few step responses and your identified model appears here, updating as each step interval completes.</p>'
        : '<p class="empty">Tick at least one step response to identify a model.</p>';
    return;
  }

  // The median, which a flagged step response cannot skew. See analysis.ts.
  const agg = aggregateResponses(included, samplePeriodMs);
  const c = agg.medianContinuous;
  const d = agg.medianDiscrete;
  const { wn, zeta, overshoot } = dampingMetrics(c);
  const character = dampingCharacter(zeta);
  const tau = c.P11 === 0 ? Infinity : -1 / c.P11;

  const excludedCount = responses.length - included.length;
  readoutSource.textContent =
    `Median of ${included.length} step response${included.length === 1 ? '' : 's'}` +
    (excludedCount > 0 ? ` · ${excludedCount} excluded` : '');

  // The lede is what the numbers MEAN about the person. 2% settling time of a
  // second-order system. It runs away as zeta -> 0, and a "settles in 740 s" note
  // is worse than no note at all, so a barely damped fit says so instead of quoting
  // a number nobody should believe. Overdamped, the response settles at the pace of
  // its SLOWER real pole, ωn(ζ - √(ζ²-1)), not at ζωn, which would flatter it.
  const decay = zeta > 1 ? wn * (zeta - Math.sqrt(zeta * zeta - 1)) : zeta * wn;
  const settlingS = decay > 0 ? 4 / decay : Infinity;
  const settlingNote =
    settlingS <= 30 ? `settles in ~${settlingS.toFixed(1)} s` : 'settles too slowly to quote';

  const tiles =
    tile('Reaction delay', (c.D2 * 1000).toFixed(0), ' ms', 'before the response begins') +
    tile('Overshoot', overshoot.toFixed(0), ' %', 'past the target on the first swing') +
    tile('Damping ζ', zeta.toFixed(2), '', character) +
    tile('Natural frequency', wn.toFixed(2), ' rad/s', settlingNote);

  const verdict =
    `<p class="verdict">${byModel ? 'The model reacts' : 'You react'} after <strong>${(c.D2 * 1000).toFixed(0)} ms</strong>, ` +
    `then ${byModel ? 'closes' : 'close'} in on the target` +
    `${overshoot >= 1 ? `, overshooting by <strong>${overshoot.toFixed(0)}%</strong> before settling` : ' without overshooting'}.</p>`;

  const twoZetaWn = (2 * zeta * wn).toFixed(2);
  const continuous =
    `<section class="model"><h3 class="model-label">Continuous · derived from the fit</h3>` +
    `<div class="tf"><span class="tf-lhs">H(s) =</span>` +
    `<span class="frac"><span class="num">${wn.toFixed(2)}<sup>2</sup></span>` +
    `<span class="den">s<sup>2</sup> + ${twoZetaWn}s + ${wn.toFixed(2)}<sup>2</sup></span></span>` +
    `<span class="tf-delay">· e<sup>−${c.D2.toFixed(2)}s</sup></span></div></section>`;

  // The discrete model is what was actually FITTED -- the continuous one is
  // derived from it -- so it gets equal billing: its own H(z), and the
  // difference equation solved for y[n], the form you can run by hand and the
  // recursion the simulation executes. The engine's own string rides along in
  // a data attribute, so a test can hold the display to the engine exactly.
  const a1 = 2 * d.P21;
  const a2 = pairProduct(d.P21, d.P22);
  const b0 = 1 - a1 + a2;
  const num = (v: number) => v.toFixed(3);
  const delay = Number.isInteger(d.D2) ? String(d.D2) : d.D2.toFixed(1);
  // U+202F joins a coefficient to its variable, so a wrapped equation breaks
  // between terms -- never between "0.153" and the x[n-7.5] it multiplies.
  // The sign is bound to its term too, so a wrap lands BEFORE the operator
  // and it leads the continuation line, as typeset maths does.
  const signed = (v: number, body: string) => `${v < 0 ? '−' : '+'} ${num(Math.abs(v))} ${body}`;
  const discrete =
    `<section class="model"><h3 class="model-label">Discrete · sampled every ${samplePeriodMs} ms</h3>` +
    `<div class="tf"><span class="tf-lhs">H(z) =</span>` +
    `<span class="frac"><span class="num">${num(b0)} <var>z</var><sup>−${delay}</sup></span>` +
    `<span class="den">1 ${signed(-a1, '<var>z</var><sup>−1</sup>')} ${signed(a2, '<var>z</var><sup>−2</sup>')}</span></span></div>` +
    `<p class="diffeq" data-equation="${secondOrderDifferenceEquation(d)}">` +
    `<var>y</var>[<var>n</var>] = ${num(a1)} <var>y</var>[<var>n</var>−1] ${signed(-a2, '<var>y</var>[<var>n</var>−2]')} ` +
    `${signed(b0, `<var>x</var>[<var>n</var>−${delay}]`)}</p></section>`;

  const details =
    `<p class="details-line">Best first-order fit: τ = ${tau.toFixed(3)} s, delay ${(c.D1 * 1000).toFixed(0)} ms</p>`;

  const bounds = outlierBounds(responses);
  const poor = responses.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'poor').length;
  const degenerate = responses.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'degenerate').length;
  const notes: string[] = [];
  const responsesFit = (n: number) => `${n} step response${n === 1 ? ' fits' : 's fit'}`;
  if (poor > 0) notes.push(`${responsesFit(poor)} more than 3× worse than the median`);
  if (degenerate > 0) notes.push(`${responsesFit(degenerate)} more than 3× better than the median, likely too little movement to measure`);
  const flagged = poor + degenerate;
  const flag =
    notes.length > 0
      ? `<p class="flag">Relative to step size, ${notes.join('; ')}. ` +
        `${flagged === 1 ? "It's" : "They're"} marked ⚠ in Session; untick ${flagged === 1 ? 'it' : 'one'} to see how much it moves the model.</p>`
      : '';

  readoutEl.innerHTML =
    `<div class="readout-row"><div class="tiles-box"><div class="tiles">${tiles}</div></div>` +
    `<div class="readout-text">${verdict}${continuous}${discrete}${details}${flag}</div></div>`;
}
