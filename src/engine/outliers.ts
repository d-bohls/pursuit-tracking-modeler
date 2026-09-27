// Which step responses fit so much worse, or so much better, than the rest
// that they probably did not measure the same system.

import type { StepResponseAnalysis } from './analysis';

/**
 * Fit error as a percentage of the step that provoked it.
 *
 * Raw pixels are not comparable between step responses: the step size is drawn from
 * LOGICAL_HEIGHT/15 .. LOGICAL_HEIGHT/5, a 3x range, so the same pixel error
 * is a good fit on a big step and a bad one on a small step. On the reference
 * recording step response 3 (9.1 px on a 39 px step) reads as better than step response 2
 * (11.0 px on 77 px) in pixels and far worse -- 23% against 14% -- once the
 * step is accounted for. A step response with no step to speak of has no scale to be
 * judged against at all.
 */
export function errorPctOf(t: StepResponseAnalysis): number {
  return t.stepSize > 0 ? (t.fit2Rms / t.stepSize) * 100 : Infinity;
}

export interface OutlierBounds {
  /** Fit far worse than its peers -- it did not measure the same system. */
  high: number;
  /**
   * Fit far BETTER than its peers, which is just as suspect: a human tracking
   * a step does not produce a 0.3% fit. It means the step response holds almost no
   * dynamics for the model to get wrong, so it contributes a confident number
   * about nothing. The reference recording has exactly one, 40x below the rest.
   */
  low: number;
}

/** 3x either side of the median error, over every step response, excluded or not. */
export function outlierBounds(responses: StepResponseAnalysis[]): OutlierBounds {
  if (responses.length === 0) return { high: Infinity, low: 0 };
  const sorted = responses.map(errorPctOf).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { high: median * 3, low: median / 3 };
}

export function outlierKindOf(t: StepResponseAnalysis, bounds: OutlierBounds): 'poor' | 'degenerate' | null {
  const pct = errorPctOf(t);
  if (pct > bounds.high) return 'poor';
  if (pct < bounds.low) return 'degenerate';
  return null;
}
