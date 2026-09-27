// The full pipeline: raw samples -> step responses -> curve fit -> discrete
// model -> continuous (Laplace) model.

import { splitStepResponses, padResponses } from './stepResponses';
import { deconvolve } from './dsp';
import { fit1PoleOutputError, fit2PoleOutputError } from './curveFit';
import { discretePairToContinuous, discretePoleToContinuous, pairNaturalFrequency, pairProduct } from './poleConversion';
import type { ContinuousModelParams, DiscreteModelParams, StepResponse } from './types';

export interface StepResponseAnalysis {
  /** The raw (unpadded) step response the model was identified against. */
  response: StepResponse;
  /** Deconvolved impulse response of the padded step response -- used for the frequency plot. */
  hn: Float64Array;
  discrete: DiscreteModelParams;
  continuous: ContinuousModelParams;
  /** RMS error of the first-order model against the recorded response, in pixels. */
  fit1Rms: number;
  /** RMS error of the second-order model against the recorded response, in pixels. */
  fit2Rms: number;
  /** Size of this step response's step, in pixels -- the scale the RMS should be read against. */
  stepSize: number;
}

/**
 * The summary models a set of step responses agrees on. Split out from AnalysisResult
 * so the UI can re-derive it from a SUBSET of step responses -- excluding a step response that
 * fit badly is a judgement the operator should be able to make and see the
 * consequences of, which means this has to be computable without re-running
 * the (far more expensive) per-response identification.
 */
export interface ResponseAggregate {
  averageDiscrete: DiscreteModelParams;
  averageContinuous: ContinuousModelParams;
  /**
   * Median of the per-response parameters. The mean has no defence against a
   * degenerate step response: on the reference recording two of ten fit ~10x
   * worse than the rest and report a 1-sample delay against the others' 7-9,
   * dragging the mean damping ratio from ~0.12 to 0.16. The median is what the
   * app reports.
   */
  medianDiscrete: DiscreteModelParams;
  medianContinuous: ContinuousModelParams;
}

export interface AnalysisResult extends ResponseAggregate {
  responses: StepResponseAnalysis[];
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
 * Identify ONE step response: deconvolution for the frequency plot, then an
 * output-error fit of a first- and second-order model, reported in both the
 * discrete and continuous domains.
 *
 * `response` is the raw (unpadded) step response the models are fitted against; `padded`
 * is the same step response run through padResponses, used only for the deconvolution.
 *
 * Exposed separately from analyzeExperiment so a live recording can identify
 * each step response as it completes (~13 ms) instead of re-identifying every step response
 * from scratch each time a new one lands.
 */
export function analyzeStepResponse(response: StepResponse, padded: StepResponse, samplePeriodMs: number): StepResponseAnalysis {
  // Identify against the recorded response, driving the model with the real
  // input (output-error). Deconvolution and the DFT are still computed, but
  // only to draw the frequency-response plot -- see the note in curveFit.ts
  // for why fitting h[n] biases the damping.
  const hn = deconvolve(padded.xn, padded.yn);

  const fit1 = fit1PoleOutputError(response.xn, response.yn);
  const fit2 = fit2PoleOutputError(response.xn, response.yn);

  // seconds, so the continuous poles come out in rad/s and match the
  // delays below (see the units note in poleConversion.ts)
  const tsSeconds = samplePeriodMs / 1000;
  const c1 = discretePoleToContinuous(fit1.p, 0, tsSeconds);
  const c2 = discretePairToContinuous(fit2.p1, fit2.p2, tsSeconds);

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
    response,
    hn,
    discrete,
    continuous,
    fit1Rms: fit1.rms,
    fit2Rms: fit2.rms,
    stepSize: Math.abs(response.xn[response.xn.length - 1]),
  };
}

/**
 * Mean and median of a set of identified step responses. Takes the step responses rather than
 * the raw samples so the caller can leave step responses out -- see ResponseAggregate.
 */
export function aggregateResponses(responses: StepResponseAnalysis[], samplePeriodMs: number): ResponseAggregate {
  const averageDiscrete: DiscreteModelParams = {
    P11: average(responses.map((t) => t.discrete.P11)),
    D1: average(responses.map((t) => t.discrete.D1)),
    P21: average(responses.map((t) => t.discrete.P21)),
    P22: average(responses.map((t) => t.discrete.P22)),
    D2: average(responses.map((t) => t.discrete.D2)),
  };

  const c1avg = discretePoleToContinuous(averageDiscrete.P11, 0, samplePeriodMs / 1000);
  const c2avg = discretePairToContinuous(averageDiscrete.P21, averageDiscrete.P22, samplePeriodMs / 1000);
  const averageContinuous: ContinuousModelParams = {
    P11: c1avg.cr,
    D1: (averageDiscrete.D1 * samplePeriodMs) / 1000,
    P21: c2avg.cr,
    P22: c2avg.ci,
    D2: (averageDiscrete.D2 * samplePeriodMs) / 1000,
  };

  const medianDiscrete: DiscreteModelParams = {
    P11: median(responses.map((t) => t.discrete.P11)),
    D1: median(responses.map((t) => t.discrete.D1)),
    P21: median(responses.map((t) => t.discrete.P21)),
    P22: median(responses.map((t) => t.discrete.P22)),
    D2: median(responses.map((t) => t.discrete.D2)),
  };
  const m1 = discretePoleToContinuous(medianDiscrete.P11, 0, samplePeriodMs / 1000);
  const m2 = discretePairToContinuous(medianDiscrete.P21, medianDiscrete.P22, samplePeriodMs / 1000);
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
  const rawResponses = splitStepResponses(rawXs, rawYs);
  const padded = padResponses(rawResponses, 10);
  const responses = rawResponses.map((response, i) => analyzeStepResponse(response, padded[i], samplePeriodMs));
  return { responses, ...aggregateResponses(responses, samplePeriodMs) };
}

/** e.g. "y[n]-(0.7234)y[n-1]=(0.2766)x[n-3]" */
export function firstOrderDifferenceEquation(d: DiscreteModelParams, decimals = 4): string {
  return `y[n]-(${d.P11.toFixed(decimals)})y[n-1]=(${(1 - d.P11).toFixed(decimals)})x[n-${d.D1}]`;
}

/** e.g. "y[n]-(1.4)y[n-1]+(0.53)y[n-2]=(0.13)x[n-5]" */
export function secondOrderDifferenceEquation(d: DiscreteModelParams, decimals = 4): string {
  const a2 = pairProduct(d.P21, d.P22);
  const gain = 1 - 2 * d.P21 + a2;
  return `y[n]-(${(2 * d.P21).toFixed(decimals)})y[n-1]+(${a2.toFixed(decimals)})y[n-2]=(${gain.toFixed(decimals)})x[n-${d.D2}]`;
}

/**
 * How close to critical a damping ratio has to be to be called critical. A
 * fitted zeta is a measurement, never exactly 1.000, so an exact test left
 * "critically damped" unreachable: a perfectly critical response read as
 * "underdamped" at zeta = 0.9999.
 */
const CRITICAL_BAND = 0.05;

export function dampingCharacter(zeta: number): 'underdamped' | 'critically damped' | 'overdamped' {
  if (zeta < 1 - CRITICAL_BAND) return 'underdamped';
  if (zeta > 1 + CRITICAL_BAND) return 'overdamped';
  return 'critically damped';
}

/** Natural frequency / damping ratio / overshoot of a continuous 2nd-order model. */
export function dampingMetrics(c: ContinuousModelParams) {
  const wn = pairNaturalFrequency(c.P21, c.P22);
  const zeta = wn === 0 ? 0 : -c.P21 / wn;
  const overshoot = zeta > 0 && zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  return { wn, zeta, overshoot };
}

/**
 * Magnitude response |H(e^jw)| of the identified FIRST-ORDER model, evaluated
 * on the same w = 2*pi*k/N grid as the DFT so it can be overlaid on it.
 *   H(z) = (1-p) / (1 - p*z^-1)
 * (The pure delay is omitted: it has unit magnitude and only shifts phase.)
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
 *   H(z) = gain / (1 - 2*p1*z^-1 + (p1^2+p2^2)*z^-2),  gain = 1 - 2*p1 + p1^2 + p2^2
 */
export function secondOrderMagnitudeResponse(P21: number, P22: number, n: number): Float64Array {
  const out = new Float64Array(n);
  const v1 = pairProduct(P21, P22);
  const gain = 1 - 2 * P21 + v1;
  for (let k = 0; k < n; k++) {
    const w = (2 * Math.PI * k) / n;
    const re = 1 - 2 * P21 * Math.cos(w) + v1 * Math.cos(2 * w);
    const im = 2 * P21 * Math.sin(w) - v1 * Math.sin(2 * w);
    out[k] = gain / Math.sqrt(re * re + im * im);
  }
  return out;
}
