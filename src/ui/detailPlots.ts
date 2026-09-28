// The selected card's detail plots -- step response, frequency response and
// pole locations -- for one step response or the model, and dragging the pole
// pair to explore.

import {
  dampingCharacter,
  dampingMetrics,
  firstOrderMagnitudeResponse,
  secondOrderMagnitudeResponse,
  type StepResponseAnalysis,
} from '../engine/analysis';
import type { DiscreteModelParams } from '../engine/types';
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
const keyMeasured = $<HTMLSpanElement>('keyMeasured');
const keyFit = $<HTMLLIElement>('keyFit');
const responseDetailHeading = $<HTMLHeadingElement>('responseDetailHeading');

/** What the detail plots show: one step response, or the model built from several. */
export type DetailSubject =
  | {
      kind: 'step';
      t: StepResponseAnalysis;
      index: number;
      /** The samples just before its step, so the plot shows the step. */
      lead: StepResponse | undefined;
      samplePeriodMs: number;
    }
  | {
      kind: 'model';
      /** The fitted model: the median of the step responses. */
      model: DiscreteModelParams;
      /** Its pole pair as dragged, which the plots start from. */
      adjusted: { p1: number; p2: number } | null;
      /** The step responses it was built from, each with its lead-in. */
      steps: Array<{ t: StepResponseAnalysis; lead: StepResponse | undefined }>;
      samplePeriodMs: number;
    };

let plotted: DetailSubject | null = null;

function sameSubject(a: DetailSubject | null, b: DetailSubject): boolean {
  if (!a || a.kind !== b.kind || a.samplePeriodMs !== b.samplePeriodMs) return false;
  if (a.kind === 'step' && b.kind === 'step') return a.t === b.t;
  if (a.kind === 'model' && b.kind === 'model') {
    const m = a.model;
    const n = b.model;
    return (
      m.P11 === n.P11 &&
      m.P21 === n.P21 &&
      m.P22 === n.P22 &&
      m.D2 === n.D2 &&
      a.adjusted?.p1 === b.adjusted?.p1 &&
      a.adjusted?.p2 === b.adjusted?.p2 &&
      a.steps.length === b.steps.length &&
      a.steps.every((s, i) => s.t === b.steps[i].t)
    );
  }
  return false;
}

/** The subject's own second-order fit, the pole a drag starts from. */
function fitOf(subject: DetailSubject) {
  const d = subject.kind === 'step' ? subject.t.discrete : subject.model;
  return { p1: d.P21, p2: d.P22 };
}

/**
 * Shows a step response or the model in the detail plots, or clears them.
 * @param force redraw even if the same subject is already plotted -- needed
 *              after a theme change, which the canvases cannot inherit.
 * @param emptyHeading what the heading says when there is nothing to show.
 */
export function showDetail(subject: DetailSubject | undefined, force = false, emptyHeading = 'Step details') {
  if (!subject) {
    // Canvases keep their last drawing, so returning early here would leave
    // a previous run's plots on screen under an empty heading.
    responseDetailHeading.textContent = emptyHeading;
    if (plotted) {
      clearPlot(stepGraph);
      clearPlot(freqGraph);
      clearPlot(poleGraph);
      plotted = null;
    }
    poleReadout.textContent = '';
    poleResetBtn.hidden = true;
    detailLegend.hidden = true;
    return;
  }
  const same = sameSubject(plotted, subject);
  if (same && !force) return;
  // A different subject starts from its own fit -- a pole dragged on one step
  // means nothing for the next -- or, for the model, from its kept adjustment.
  if (!same) dragged = subject.kind === 'model' ? subject.adjusted : null;
  plotted = subject;
  responseDetailHeading.textContent = subject.kind === 'step' ? `Step ${subject.index + 1} details` : 'Model details';

  // Measured response: |H[k]| of the DFT of the step response's deconvolved
  // h[n], computed once -- a drag redraws many times a second and only the
  // model curves move. The model has no single measurement to compare.
  plottedSpectrum = subject.kind === 'step' ? spectrumOf(subject.t) : null;
  plottedSpectra = subject.kind === 'model' ? subject.steps.map(({ t }) => spectrumOf(t)) : [];
  drawDetail();
}

/** |H[k]|: the DFT magnitude of a step response's deconvolved h[n]. */
function spectrumOf(t: StepResponseAnalysis): Float64Array {
  const Hk = dft(t.hn);
  const out = new Float64Array(Hk.real.length);
  for (let i = 0; i < out.length; i++) out[i] = magnitudeOfComplex(Hk.real[i], Hk.imag[i]);
  return out;
}

/**
 * The pole pair being shown, when it has been dragged off the fit. On a step
 * it is exploration only. On the model it IS the model: every change is
 * reported, and the app keeps it and plays it back.
 */
let dragged: { p1: number; p2: number } | null = null;

let modelPoleListener: ((pole: { p1: number; p2: number } | null) => void) | null = null;

/** Called with the model's pole pair whenever it is dragged, or null when it returns to the fit. */
export function onModelPoleChange(listener: (pole: { p1: number; p2: number } | null) => void) {
  modelPoleListener = listener;
}

function setDragged(pole: { p1: number; p2: number } | null) {
  dragged = pole;
  drawDetail();
  if (plotted?.kind === 'model') modelPoleListener?.(pole);
}
let plottedSpectrum: Float64Array | null = null;
/** For the model: each step response's own spectrum. */
let plottedSpectra: Float64Array[] = [];

/** The frequency grid the model's curves are drawn on when there is no measurement. */
const MODEL_GRID = 256;

/** Redraws the three plots for the current pole pair. */
function drawDetail() {
  const subject = plotted;
  if (!subject) return;
  const fit = fitOf(subject);
  const pole = dragged ?? fit;
  const d = subject.kind === 'step' ? subject.t.discrete : subject.model;
  const D = d.D2;
  const n = plottedSpectrum?.length ?? MODEL_GRID;

  plotFrequencyResponse(freqGraph, {
    sampled: plottedSpectrum ?? undefined,
    others: plottedSpectra,
    firstOrder: firstOrderMagnitudeResponse(d.P11, n),
    secondOrder: secondOrderMagnitudeResponse(pole.p1, pole.p2, n),
  });
  plotPoleLocations(
    poleGraph,
    [pole],
    dragged ? fit : undefined,
    subject.kind === 'model' ? subject.steps.map(({ t }) => ({ p1: t.discrete.P21, p2: t.discrete.P22 })) : [],
  );

  let errPct: number;
  if (subject.kind === 'step') {
    const { t } = subject;
    const model = simulateSecondOrder(t.response.xn, pole.p1, pole.p2, D);
    // Led in from just before the step, as the thumbnails are, so the plot
    // shows the step and not just its aftermath. Before the step the models
    // sit at rest on the old target level, which is 0 in the step response's frame.
    const lead = subject.lead;
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
      samplePeriodMs: subject.samplePeriodMs,
      stepIndex: k,
    });
    errPct = fitErrorPct(t, pole, D);
  } else {
    drawModelStep(subject, pole, fit, D);
    // How well the model fits the step responses it came from, on average.
    const errs = subject.steps.map(({ t }) => fitErrorPct(t, pole, D)).filter(Number.isFinite);
    errPct = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
  }

  // What the pole MEANS, and what it costs: the error is lowest at the fit,
  // which is the whole point of identification, and dragging lets you see it.
  const c = discretePairToContinuous(pole.p1, pole.p2, subject.samplePeriodMs / 1000);
  const { wn, zeta, overshoot } = dampingMetrics({ P11: 0, D1: 0, P21: c.cr, P22: c.ci, D2: 0 });
  const errText = Number.isFinite(errPct)
    ? `${errPct < 10 ? errPct.toFixed(1) : errPct.toFixed(0)}% err${subject.kind === 'model' ? ' on average' : ''}`
    : '';
  poleReadout.textContent =
    `ζ ${zeta.toFixed(2)} ${dampingCharacter(zeta)} · ωn ${wn.toFixed(2)} rad/s · ${overshoot.toFixed(0)}% overshoot` +
    (errText ? ` · ${errText}` : '');
  poleResetBtn.hidden = !dragged;
  detailLegend.hidden = false;
  keyMeasured.textContent = subject.kind === 'model' ? 'Steps, scaled' : 'Measured';
  keyModel.textContent = dragged ? 'Dragged model' : 'Model';
  keyFit.hidden = !dragged;
}

/** A model's RMS error against one recorded step response, as a percentage of its step. */
function fitErrorPct(t: StepResponseAnalysis, pole: { p1: number; p2: number }, D: number): number {
  const model = simulateSecondOrder(t.response.xn, pole.p1, pole.p2, D);
  let sq = 0;
  for (let i = 0; i < model.length; i++) sq += (t.response.yn[i] - model[i]) ** 2;
  return t.stepSize > 0 ? (Math.sqrt(sq / model.length) / t.stepSize) * 100 : NaN;
}

/**
 * The model's response to a unit step, over every step response it was built
 * from, each scaled to a unit step so they share one axis.
 */
function drawModelStep(
  subject: Extract<DetailSubject, { kind: 'model' }>,
  pole: { p1: number; p2: number },
  fit: { p1: number; p2: number },
  D: number,
) {
  const body = Math.max(2, ...subject.steps.map(({ t }) => t.response.xn.length));
  const k = Math.max(2, Math.round(body * 0.1));
  const unit = new Float64Array(body).fill(1);
  const withLead = (tail: Float64Array) => {
    const out = new Float64Array(k + tail.length);
    out.set(tail, k);
    return out;
  };
  const others = subject.steps.map(({ t, lead }) => {
    const out = new Float64Array(k + body).fill(NaN);
    const step = t.response.xn[t.response.xn.length - 1];
    if (!step) return out;
    if (lead) {
      const from = Math.max(0, lead.yn.length - k);
      for (let i = from; i < lead.yn.length; i++) out[k - (lead.yn.length - i)] = lead.yn[i] / step;
    }
    for (let i = 0; i < t.response.yn.length; i++) out[k + i] = t.response.yn[i] / step;
    return out;
  });
  plotStepResponse(stepGraph, {
    target: withLead(unit),
    others,
    model: withLead(simulateSecondOrder(unit, pole.p1, pole.p2, D)),
    fit: dragged ? withLead(simulateSecondOrder(unit, fit.p1, fit.p2, D)) : undefined,
    samplePeriodMs: subject.samplePeriodMs,
    stepIndex: k,
  });
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
  if (!plotted) return;
  poleGraph.setPointerCapture(e.pointerId);
  poleGraph.dataset.dragging = 'true';
  const current = dragged ?? fitOf(plotted);
  const z = zAt(e);
  if (z.onAxis && current.p2 <= 0) {
    const hi = current.p1 - current.p2;
    const lo = current.p1 + current.p2;
    dragMode = { kind: 'split', fixed: Math.abs(z.re - hi) < Math.abs(z.re - lo) ? lo : hi };
  } else {
    dragMode = { kind: 'pair' };
  }
  setDragged(poleAt(e));
});
poleGraph.addEventListener('pointermove', (e) => {
  if (poleGraph.dataset.dragging !== 'true') return;
  setDragged(poleAt(e));
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  poleGraph.addEventListener(type, () => (poleGraph.dataset.dragging = 'false'));
}
poleGraph.addEventListener('keydown', (e) => {
  if (!plotted) return;
  if (e.key === 'Escape') {
    if (!dragged) return;
    setDragged(null);
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
  const from = dragged ?? fitOf(plotted);
  setDragged(clampPole(from.p1 + move[0], from.p2 + move[1]));
});
poleResetBtn.addEventListener('click', () => setDragged(null));

// A canvas's backing store is sized when it is drawn, so a plot that is not
// redrawn after a resize is stretched, soft and off its own pointer mapping.
// One frame's worth of resizes is batched into a single redraw.
let resizeFrame = 0;
const plotResizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawDetail);
});
for (const canvas of [stepGraph, freqGraph, poleGraph]) plotResizeObserver.observe(canvas);
