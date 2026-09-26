// The full pipeline: raw samples -> step responses -> curve fit -> discrete
// model -> continuous (Laplace) model.

import { parseTrials, padTrials } from './trials';
import { deconvolve, dft } from './dsp';
import { fit1PoleOutputError, fit2PoleOutputError } from './curveFit';
import { discretePoleToContinuous } from './poleConversion';
import type { ContinuousModelParams, DiscreteModelParams, Trial } from './types';

export interface TrialAnalysis {
  /** The raw (unpadded) trial the model was identified against. */
  trial: Trial;
  /** Deconvolved impulse response of the padded trial -- used for the frequency plot. */
  hn: Float64Array;
  discrete: DiscreteModelParams;
  continuous: ContinuousModelParams;
  /** RMS error of the first-order model against the recorded response, in pixels. */
  fit1Rms: number;
  /** RMS error of the second-order model against the recorded response, in pixels. */
  fit2Rms: number;
  /** Size of this trial's step, in pixels -- the scale the RMS should be read against. */
  stepSize: number;
}

/**
 * The summary models a set of trials agrees on. Split out from AnalysisResult
 * so the UI can re-derive it from a SUBSET of trials -- excluding a trial that
 * fit badly is a judgement the operator should be able to make and see the
 * consequences of, which means this has to be computable without re-running
 * the (far more expensive) per-trial identification.
 */
export interface TrialAggregate {
  averageDiscrete: DiscreteModelParams;
  averageContinuous: ContinuousModelParams;
  /**
   * Median of the per-trial parameters. The median is reported alongside so the
   * pull is visible rather than silently baked into one number.
   */
  medianDiscrete: DiscreteModelParams;
  medianContinuous: ContinuousModelParams;
}

export interface AnalysisResult extends TrialAggregate {
  trials: TrialAnalysis[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Identify ONE trial: deconvolution for the frequency plot, then an
 * output-error fit of a first- and second-order model, reported in both the
 * discrete and continuous domains.
 *
 * `trial` is the raw (unpadded) trial the models are fitted against; `padded`
 * is the same trial run through padTrials, used only for the deconvolution.
 *
 * Exposed separately from analyzeExperiment so a live recording can identify
 * each trial as it completes (~13 ms) instead of re-identifying every trial
 * from scratch each time a new one lands.
 */
export function analyzeTrial(trial: Trial, padded: Trial, samplePeriodMs: number): TrialAnalysis {
  // Identify against the recorded response, driving the model with the real
  // input (output-error). Deconvolution and the DFT are still computed, but
  // only to draw the frequency-response plot -- see the note in curveFit.ts
  // for why fitting h[n] biases the damping.
  const hn = deconvolve(padded.xn, padded.yn);

  const fit1 = fit1PoleOutputError(trial.xn, trial.yn);
  const fit2 = fit2PoleOutputError(trial.xn, trial.yn);

  // seconds, so the continuous poles come out in rad/s and match the
  // delays below (see the units note in poleConversion.ts)
  const tsSeconds = samplePeriodMs / 1000;
  const c1 = discretePoleToContinuous(fit1.p, 0, tsSeconds);
  const c2 = discretePoleToContinuous(fit2.p1, fit2.p2, tsSeconds);

  const discrete: DiscreteModelParams = {
    P11: fit1.p,
    D1: fit1.D,
    P21: fit2.p1,
    P22: fit2.p2,
    D2: fit2.D,
  };
  const continuous: ContinuousModelParams = {
    P11: c1.cr, // continuous pole is real for the 1-pole model
    D1: (fit1.D * samplePeriodMs) / 1000,
    P21: c2.cr,
    P22: c2.ci,
    D2: (fit2.D * samplePeriodMs) / 1000,
  };

  return {
    trial,
    hn,
    discrete,
    continuous,
    fit1Rms: fit1.rms,
    fit2Rms: fit2.rms,
    stepSize: Math.abs(trial.xn[trial.xn.length - 1]),
  };
}

/**
 * Mean and median of a set of identified trials. Takes the trials rather than
 * the raw samples so the caller can leave trials out -- see TrialAggregate.
 */
export function aggregateTrials(trials: TrialAnalysis[], samplePeriodMs: number): TrialAggregate {
  const averageDiscrete: DiscreteModelParams = {
    P11: average(trials.map((t) => t.discrete.P11)),
    D1: average(trials.map((t) => t.discrete.D1)),
    P21: average(trials.map((t) => t.discrete.P21)),
    P22: average(trials.map((t) => t.discrete.P22)),
    D2: average(trials.map((t) => t.discrete.D2)),
  };

  const c1avg = discretePoleToContinuous(averageDiscrete.P11, 0, samplePeriodMs / 1000);
  const c2avg = discretePoleToContinuous(averageDiscrete.P21, averageDiscrete.P22, samplePeriodMs / 1000);
  const averageContinuous: ContinuousModelParams = {
    P11: c1avg.cr,
    D1: (averageDiscrete.D1 * samplePeriodMs) / 1000,
    P21: c2avg.cr,
    P22: c2avg.ci,
    D2: (averageDiscrete.D2 * samplePeriodMs) / 1000,
  };

  const medianDiscrete: DiscreteModelParams = {
    P11: median(trials.map((t) => t.discrete.P11)),
    D1: median(trials.map((t) => t.discrete.D1)),
    P21: median(trials.map((t) => t.discrete.P21)),
    P22: median(trials.map((t) => t.discrete.P22)),
    D2: median(trials.map((t) => t.discrete.D2)),
  };
  const m1 = discretePoleToContinuous(medianDiscrete.P11, 0, samplePeriodMs / 1000);
  const m2 = discretePoleToContinuous(medianDiscrete.P21, medianDiscrete.P22, samplePeriodMs / 1000);
  const medianContinuous: ContinuousModelParams = {
    P11: m1.cr,
    D1: (medianDiscrete.D1 * samplePeriodMs) / 1000,
    P21: m2.cr,
    P22: m2.ci,
    D2: (medianDiscrete.D2 * samplePeriodMs) / 1000,
  };

  return { averageDiscrete, averageContinuous, medianDiscrete, medianContinuous };
}

export function analyzeExperiment(rawXs: Float64Array, rawYs: Float64Array, samplePeriodMs: number): AnalysisResult {
  const rawTrials = parseTrials(rawXs, rawYs);
  const padded = padTrials(rawTrials, 10);
  const trials = rawTrials.map((trial, i) => analyzeTrial(trial, padded[i], samplePeriodMs));
  return { trials, ...aggregateTrials(trials, samplePeriodMs) };
}

/** e.g. */
export function firstOrderDifferenceEquation(d: DiscreteModelParams, decimals = 4): string {
  return `y[n]-(${d.P11.toFixed(decimals)})y[n-1]=(${(1 - d.P11).toFixed(decimals)})x[n-${d.D1}]`;
}

/** e.g. */
export function secondOrderDifferenceEquation(d: DiscreteModelParams, decimals = 4): string {
  const gain = 1 - 2 * d.P21 + d.P21 ** 2 + d.P22 ** 2;
  return `y[n]-(${(2 * d.P21).toFixed(decimals)})y[n-1]+(${(d.P21 ** 2 + d.P22 ** 2).toFixed(decimals)})y[n-2]=(${gain.toFixed(decimals)})x[n-${d.D2}]`;
}

/**
 * Renders the continuous-time (Laplace) model as a standard second-order
 * transfer function H(s) = wn^2 / (s^2 + 2*zeta*wn*s + wn^2) * e^(-D*s),
 * using natural frequency wn and damping ratio zeta derived from the
 * continuous pole location (see analysis notes in README for the derivation).
 * Assumes unity DC gain, matching the discrete model's normalization.
 */
export function continuousSecondOrderTf(c: ContinuousModelParams, decimals = 4): string {
  const a = c.P21; // real part of continuous pole (should be negative for a stable, decaying tracker)
  const b = c.P22; // imaginary part
  const wn = Math.sqrt(a * a + b * b);
  const zeta = wn === 0 ? 0 : -a / wn;
  const delay = c.D2;
  const delayTerm = delay !== 0 ? ` * e^(-${delay.toFixed(decimals)}s)` : '';
  return (
    `H(s) = ${wn.toFixed(decimals)}² / (s² + ${(2 * zeta * wn).toFixed(decimals)}s + ${wn.toFixed(decimals)}²)${delayTerm}\n` +
    `  natural frequency ωn = ${wn.toFixed(decimals)} rad/s, damping ratio ζ = ${zeta.toFixed(decimals)}` +
    (zeta < 1 ? ` (underdamped)` : zeta === 1 ? ` (critically damped)` : ` (overdamped)`)
  );
}

export function continuousFirstOrderTf(c: ContinuousModelParams, decimals = 4): string {
  const a = c.P11; // continuous pole (negative reciprocal of the time constant, for a stable system)
  const tau = a === 0 ? Infinity : -1 / a;
  const delay = c.D1;
  const delayTerm = delay !== 0 ? ` * e^(-${delay.toFixed(decimals)}s)` : '';
  return `H(s) = 1 / (${tau.toFixed(decimals)}s + 1)${delayTerm}\n  time constant τ = ${tau.toFixed(decimals)} s`;
}

/** Natural frequency / damping ratio / overshoot of a continuous 2nd-order model. */
export function dampingMetrics(c: ContinuousModelParams) {
  const wn = Math.hypot(c.P21, c.P22);
  const zeta = wn === 0 ? 0 : -c.P21 / wn;
  const overshoot = zeta > 0 && zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  return { wn, zeta, overshoot };
}

/**
 * Magnitude response |H(e^jw)| of the identified FIRST-ORDER model, evaluated on
 * the same w = 2*pi*k/N grid as the DFT so it can be overlaid on it.
 */
export function firstOrderMagnitudeResponse(P11: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const w = (2 * Math.PI * k) / n;
    out[k] = (1 - P11) / Math.sqrt((1 - P11 * Math.cos(w)) ** 2 + (P11 * Math.sin(w)) ** 2);
  }
  return out;
}

/**
 * Magnitude response of the identified SECOND-ORDER model on the same grid.
 */
export function secondOrderMagnitudeResponse(P21: number, P22: number, n: number): Float64Array {
  const out = new Float64Array(n);
  const v1 = P21 * P21 + P22 * P22;
  const gain = 1 - 2 * P21 + v1;
  for (let k = 0; k < n; k++) {
    const w = (2 * Math.PI * k) / n;
    const re = 1 - 2 * P21 * Math.cos(w) + v1 * Math.cos(2 * w);
    const im = 2 * P21 * Math.sin(w) - v1 * Math.sin(2 * w);
    out[k] = gain / Math.sqrt(re * re + im * im);
  }
  return out;
}
