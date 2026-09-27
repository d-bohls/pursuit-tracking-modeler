// The inspected step response's detail plots -- step response, frequency
// response and pole locations -- and dragging its pole pair to explore.

import {
  dampingCharacter,
  dampingMetrics,
  firstOrderMagnitudeResponse,
  secondOrderMagnitudeResponse,
  type StepResponseAnalysis,
} from '../engine/analysis';
import { magnitudeOfComplex } from '../engine/complex';
import { simulateSecondOrder } from '../engine/curveFit';
import { dft } from '../engine/dsp';
import { discretePairToContinuous } from '../engine/poleConversion';
import type { StepResponse } from '../engine/types';
import { $ } from './dom';
import { clearPlot, plotFrequencyResponse, plotPoleLocations, plotStepResponse, poleGeometry } from './plotting';

const stepGraph = $<HTMLCanvasElement>('stepGraph');
const freqGraph = $<HTMLCanvasElement>('freqGraph');
const poleGraph = $<HTMLCanvasElement>('poleGraph');
const poleReadout = $<HTMLParagraphElement>('poleReadout');
const poleResetBtn = $<HTMLButtonElement>('poleResetBtn');
const detailLegend = $<HTMLUListElement>('detailLegend');
const keyModel = $<HTMLSpanElement>('keyModel');
const keyFit = $<HTMLLIElement>('keyFit');
const responseDetailHeading = $<HTMLHeadingElement>('responseDetailHeading');

/** The step response the detail plots currently show, so they are not redrawn for nothing. */
let plottedResponse: StepResponseAnalysis | null = null;
/** Its lead-in, and the sample period it was identified at. */
let plottedLead: StepResponse | undefined;
let plottedPeriodMs = 100;

/**
 * Shows step response `index` in the detail plots, or clears them.
 * @param lead the samples just before its step, so the plot shows the step.
 * @param force redraw even if the same step response is already plotted -- needed
 *              after a theme change, which the canvases cannot inherit.
 */
export function showDetail(
  t: StepResponseAnalysis | undefined,
  index: number,
  lead: StepResponse | undefined,
  samplePeriodMs: number,
  force = false,
) {
  if (!t) {
    // Canvases keep their last drawing, so returning early here is what left
    // a previous run's plots on screen under a "Step details" heading after
    // a run that produced no step responses at all.
    responseDetailHeading.textContent = 'Step details';
    if (plottedResponse) {
      clearPlot(stepGraph);
      clearPlot(freqGraph);
      clearPlot(poleGraph);
      plottedResponse = null;
    }
    poleReadout.textContent = '';
    poleResetBtn.hidden = true;
    detailLegend.hidden = true;
    return;
  }
  if (t === plottedResponse && !force) return;
  // A different step response starts from its own fit: a pole dragged on one step response
  // means nothing for the next.
  if (t !== plottedResponse) dragged = null;
  plottedResponse = t;
  plottedLead = lead;
  plottedPeriodMs = samplePeriodMs;
  responseDetailHeading.textContent = `Step ${index + 1} details`;

  // Measured response: |H[k]| of the DFT of this step response's deconvolved h[n].
  // Computed once per step response -- a drag redraws many times a second and only
  // the model curves move.
  const Hk = dft(t.hn);
  const n = Hk.real.length;
  plottedSpectrum = new Float64Array(n);
  for (let i = 0; i < n; i++) plottedSpectrum[i] = magnitudeOfComplex(Hk.real[i], Hk.imag[i]);
  drawDetail();
}

/**
 * The pole pair being shown, when it has been dragged off the fit. Exploration
 * only: it redraws this step response's plots and never touches the identified model.
 */
let dragged: { p1: number; p2: number } | null = null;
let plottedSpectrum = new Float64Array();

/** Redraws the inspected step response's three plots for the current pole pair. */
function drawDetail() {
  const t = plottedResponse;
  if (!t) return;
  const fit = { p1: t.discrete.P21, p2: t.discrete.P22 };
  const pole = dragged ?? fit;
  const D = t.discrete.D2;
  const n = plottedSpectrum.length;

  // Both models on the same frequency grid as the measurement, so the plot
  // shows how well each reproduces it.
  plotFrequencyResponse(freqGraph, {
    sampled: plottedSpectrum,
    firstOrder: firstOrderMagnitudeResponse(t.discrete.P11, n),
    secondOrder: secondOrderMagnitudeResponse(pole.p1, pole.p2, n),
  });
  plotPoleLocations(poleGraph, [pole], dragged ? fit : undefined);

  const model = simulateSecondOrder(t.response.xn, pole.p1, pole.p2, D);
  // Led in from just before the step, as the thumbnails are, so the plot
  // shows the step and not just its aftermath. Before the step the models
  // sit at rest on the old target level, which is 0 in the step response's frame.
  const lead = plottedLead;
  const k = lead ? lead.xn.length : 0;
  const withLead = (head: Float64Array | null, body: Float64Array) => {
    const out = new Float64Array(k + body.length);
    if (head) out.set(head);
    out.set(body, k);
    return out;
  };
  plotStepResponse(stepGraph, {
    target: withLead(lead?.xn ?? null, t.response.xn),
    measured: withLead(lead?.yn ?? null, t.response.yn),
    model: withLead(null, model),
    fit: dragged ? withLead(null, simulateSecondOrder(t.response.xn, fit.p1, fit.p2, D)) : undefined,
    samplePeriodMs: plottedPeriodMs,
    stepIndex: k,
  });

  // What the pole MEANS, and what it costs: the error is lowest at the fit,
  // which is the whole point of identification, and dragging lets you see it.
  const c = discretePairToContinuous(pole.p1, pole.p2, plottedPeriodMs / 1000);
  const { wn, zeta, overshoot } = dampingMetrics({ P11: 0, D1: 0, P21: c.cr, P22: c.ci, D2: 0 });
  let sq = 0;
  for (let i = 0; i < model.length; i++) sq += (t.response.yn[i] - model[i]) ** 2;
  const errPct = t.stepSize > 0 ? (Math.sqrt(sq / model.length) / t.stepSize) * 100 : NaN;
  const errText = Number.isFinite(errPct) ? `${errPct < 10 ? errPct.toFixed(1) : errPct.toFixed(0)}% err` : '';
  poleReadout.textContent =
    `ζ ${zeta.toFixed(2)} ${dampingCharacter(zeta)} · ωn ${wn.toFixed(2)} rad/s · ${overshoot.toFixed(0)}% overshoot` +
    (errText ? ` · ${errText}` : '');
  poleResetBtn.hidden = !dragged;
  detailLegend.hidden = false;
  keyModel.textContent = dragged ? 'Dragged model' : 'Model';
  keyFit.hidden = !dragged;
}

const POLE_MAX = 0.995;
/** Real poles stay positive: a pole at or below 0 has no continuous equivalent. */
const POLE_MIN = 0.005;

/**
 * Keeps a pair stable and meaningful. A complex pair (p2 >= 0) stays inside
 * the unit circle; a real pair (p2 < 0) keeps both poles on (0, 1).
 */
function clampPole(p1: number, p2: number) {
  if (p2 >= 0) {
    const r = Math.hypot(p1, p2);
    if (r > POLE_MAX) {
      p1 *= POLE_MAX / r;
      p2 *= POLE_MAX / r;
    }
    return { p1, p2 };
  }
  const c = Math.min(POLE_MAX, Math.max(POLE_MIN, p1));
  const h = Math.min(-p2, c - POLE_MIN, POLE_MAX - c);
  return { p1: c, p2: -h };
}

/** Within this many pixels of the real axis, a press means the axis itself. */
const AXIS_SNAP_PX = 6;

/**
 * How the current drag moves the pair. 'pair': the pointer IS a complex pole
 * (its mirror follows), snapping to a double pole -- critical damping -- on
 * the axis, which is otherwise impossible to hit exactly. 'split': one real
 * pole slides along the axis while the other stays put -- overdamped.
 */
let dragMode: { kind: 'pair' } | { kind: 'split'; fixed: number } = { kind: 'pair' };

/** The z-plane point under a pointer, and whether it is on the real axis. */
function zAt(e: PointerEvent) {
  const rect = poleGraph.getBoundingClientRect();
  const { cx, cy, r } = poleGeometry(rect.width, rect.height);
  const dy = Math.abs(cy - (e.clientY - rect.top));
  return { re: (e.clientX - rect.left - cx) / r, im: dy / r, onAxis: dy <= AXIS_SNAP_PX };
}

function poleAt(e: PointerEvent) {
  const z = zAt(e);
  if (dragMode.kind === 'split') {
    const moving = Math.min(POLE_MAX, Math.max(POLE_MIN, z.re));
    return clampPole((moving + dragMode.fixed) / 2, -Math.abs(moving - dragMode.fixed) / 2);
  }
  return clampPole(z.re, z.onAxis ? 0 : z.im);
}

// Press anywhere on the plot to pick the pair up: the conjugate is its mirror,
// so a press below the axis grabs the same pair. Jumping to the press, rather
// than requiring a hit on the marker, makes it usable with a finger. A press
// ON the axis when the pair is already real grabs the nearer real pole
// instead, and splits the pair.
poleGraph.addEventListener('pointerdown', (e) => {
  if (!plottedResponse) return;
  poleGraph.setPointerCapture(e.pointerId);
  poleGraph.dataset.dragging = 'true';
  const current = dragged ?? { p1: plottedResponse.discrete.P21, p2: plottedResponse.discrete.P22 };
  const z = zAt(e);
  if (z.onAxis && current.p2 <= 0) {
    const hi = current.p1 - current.p2;
    const lo = current.p1 + current.p2;
    dragMode = { kind: 'split', fixed: Math.abs(z.re - hi) < Math.abs(z.re - lo) ? lo : hi };
  } else {
    dragMode = { kind: 'pair' };
  }
  dragged = poleAt(e);
  drawDetail();
});
poleGraph.addEventListener('pointermove', (e) => {
  if (poleGraph.dataset.dragging !== 'true') return;
  dragged = poleAt(e);
  drawDetail();
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  poleGraph.addEventListener(type, () => (poleGraph.dataset.dragging = 'false'));
}
poleGraph.addEventListener('keydown', (e) => {
  if (!plottedResponse) return;
  if (e.key === 'Escape') {
    if (!dragged) return;
    dragged = null;
    drawDetail();
    e.preventDefault();
    return;
  }
  const step = e.shiftKey ? 0.05 : 0.01;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  const move = moves[e.key];
  if (!move) return;
  // Arrow keys would otherwise scroll the card, and the space bar is left
  // alone for starting and stopping runs.
  e.preventDefault();
  const from = dragged ?? { p1: plottedResponse.discrete.P21, p2: plottedResponse.discrete.P22 };
  dragged = clampPole(from.p1 + move[0], from.p2 + move[1]);
  drawDetail();
});
poleResetBtn.addEventListener('click', () => {
  dragged = null;
  drawDetail();
});

// A canvas's backing store is sized when it is drawn, so a plot that is not
// redrawn after a resize is stretched, soft and off its own pointer mapping.
// One frame's worth of resizes is batched into a single redraw.
let resizeFrame = 0;
const plotResizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawDetail);
});
for (const canvas of [stepGraph, freqGraph, poleGraph]) plotResizeObserver.observe(canvas);
