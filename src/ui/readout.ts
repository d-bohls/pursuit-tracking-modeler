// The model card: the numbers of the selected card's model -- one step
// response's, or the model built from all of them -- what they mean, and the
// transfer functions they come from.

import type { SimulationMode } from './experiment';
import type { ContinuousModelParams, DiscreteModelParams } from '../engine/types';
import {
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
  /** The selected card: a step response's index, or the model of them all. */
  selected: number | 'model';
  /** The model, with its pole as dragged; null when no step response is ticked. */
  model: {
    discrete: DiscreteModelParams;
    continuous: ContinuousModelParams;
    adjusted: boolean;
    /** How it came from the step responses. */
    method: 'median' | 'joint';
  } | null;
}

function tile(label: string, value: string, unit: string, note: string) {
  return (
    `<div class="tile"><p class="tile-label">${label}</p>` +
    `<p class="tile-value">${value}<span class="unit">${unit}</span></p>` +
    `<p class="tile-note">${note}</p></div>`
  );
}

export function renderReadout({ responses, excluded, samplePeriodMs, source, selected, model }: ReadoutInput) {
  // A model run must never be presented as yours: the heading names whose
  // system this is, taken from the data on screen rather than the setting.
  const byModel = source !== 'none' && responses.length > 0;
  const step = selected === 'model' ? null : responses[selected] ? selected : null;
  // A single step's numbers must never be mistaken for the model's: the
  // heading says which one is showing.
  readoutHeading.textContent =
    step !== null ? `Step ${step + 1} model${byModel ? ' · self-test' : ''}` : byModel
        ? selfTestLabel(source)
        : model?.method === 'joint'
          ? 'Joint model'
          : 'Median model';
  readoutHeading.parentElement!.parentElement!.dataset.source = byModel ? 'model' : 'you';
  readoutHeading.parentElement!.parentElement!.dataset.selected = step !== null ? 'step' : 'model';

  const included = responses.filter((_, i) => !excluded.has(i));
  if (step === null && (included.length === 0 || !model)) {
    readoutSource.textContent = responses.length === 0 ? '' : 'All step responses excluded';
    readoutEl.innerHTML =
      responses.length === 0
        ? '<p class="empty">Record a few step responses and the identified model appears here, updating as each step interval completes.</p>'
        : '<p class="empty">Tick at least one step response to identify a model.</p>';
    return;
  }

  // The model is the median, which a flagged step response cannot skew; see
  // analysis.ts. A step's own fit is shown as it is.
  let c;
  let d;
  if (step !== null) {
    c = responses[step].continuous;
    d = responses[step].discrete;
    readoutSource.textContent = '';
  } else {
    c = model!.continuous;
    d = model!.discrete;
    const excludedCount = responses.length - included.length;
    readoutSource.textContent =
      `${model!.method === 'joint' ? 'Fitted to' : 'Median of'} ${included.length} step response${included.length === 1 ? '' : 's'}` +
      (excludedCount > 0 ? ` · ${excludedCount} excluded` : '') +
      (model!.adjusted ? ' · pole adjusted' : '');
  }
  const { wn, zeta, overshoot } = dampingMetrics(c);
  const character = dampingCharacter(zeta);
  const tau = c.P11 === 0 ? Infinity : -1 / c.P11;

  // The lede is what the numbers MEAN about the person. H(s) is the evidence,
  // and sits below.
  // 2% settling time of a second-order system. It runs away as zeta -> 0, and
  // a "settles in 740 s" note is worse than no note at all, so a barely damped
  // fit says so instead of quoting a number nobody should believe.
  // Overdamped, the response settles at the pace of its SLOWER real pole,
  // ωn(ζ - √(ζ²-1)), not at ζωn, which would flatter it.
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
    `<p class="verdict">${step !== null ? 'In this step, ' : ''}${
      step !== null ? (byModel ? 'the model reacts' : 'you react') : byModel ? 'The model reacts' : 'You react'
    } after <strong>${(c.D2 * 1000).toFixed(0)} ms</strong>, ` +
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
  const kind = step !== null ? outlierKindOf(responses[step], bounds) : null;
  const poor = responses.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'poor').length;
  const degenerate = responses.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'degenerate').length;
  const notes: string[] = [];
  const responsesFit = (n: number) => `${n} step response${n === 1 ? ' fits' : 's fit'}`;
  if (poor > 0) notes.push(`${responsesFit(poor)} more than 3× worse than the median`);
  if (degenerate > 0) notes.push(`${responsesFit(degenerate)} more than 3× better than the median, likely too little movement to measure`);
  const flagged = poor + degenerate;
  const flag =
    step !== null
      ? kind
        ? `<p class="flag">Relative to its step size, this step fits more than 3× ` +
          `${kind === 'poor' ? 'worse than the median, so it may not have measured the same system' : 'better than the median, likely too little movement to measure'}` +
          `${excluded.has(step) ? '.' : '; untick it to leave it out of the model.'}</p>`
        : ''
      : notes.length > 0
      ? `<p class="flag">Relative to step size, ${notes.join('; ')}. ` +
        `${flagged === 1 ? "It's" : "They're"} marked ⚠ in Session; untick ${flagged === 1 ? 'it' : 'one'} to see how much it moves the model.</p>`
      : '';

  readoutEl.innerHTML =
    `<div class="readout-row"><div class="tiles-box"><div class="tiles">${tiles}</div></div>` +
    `<div class="readout-text">${verdict}${continuous}${discrete}${details}${flag}</div></div>`;
}
