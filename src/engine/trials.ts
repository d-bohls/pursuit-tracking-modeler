// Splitting a recording at each step, and padding the pieces to a common
// length.

import type { Trial } from './types';

/**
 * Where the recording splits: 0, then the index of every sample at which the
 * target has just stepped. Trial k runs from indices[k] to indices[k + 1]; the
 * stretch before the first step and the one after the last are not trials.
 * Shared by parseTrials and trialLeadIns so the two can never disagree.
 */
function stepIndices(xs: Float64Array, ys: Float64Array): number[] {
  const ns = Math.min(xs.length, ys.length) - 1;
  if (ns < 1) return [];
  const indices: number[] = [0];
  for (let i = 1; i <= ns; i++) {
    if (xs[i - 1] !== xs[i]) indices.push(i);
  }
  return indices;
}

export function parseTrials(xs: Float64Array, ys: Float64Array): Trial[] {
  const indices = stepIndices(xs, ys);
  const trialCount = indices.length - 1;
  const trials: Trial[] = [];
  for (let i1 = 1; i1 < trialCount; i1++) {
    const shift = xs[indices[i1] - 1];
    const start = indices[i1];
    const end = indices[i1 + 1];
    const xn = new Float64Array(end - start);
    const yn = new Float64Array(end - start);
    for (let i = start; i < end; i++) {
      xn[i - start] = xs[i] - shift;
      yn[i - start] = ys[i] - shift;
    }
    trials.push({ xn, yn });
  }
  return trials;
}

/**
 * Pad each trial to 10x its original length by repeating its final sample,
 * so every trial (and thus every deconvolved h[n]) has a common length for
 * curve fitting. Fixed to pad yn with yn's own tail (see file header).
 */
export function padTrials(trials: Trial[], factor = 10): Trial[] {
  return trials.map(({ xn, yn }) => {
    const n = xn.length;
    const newLength = n * factor + 1;
    const xn2 = new Float64Array(newLength);
    const yn2 = new Float64Array(newLength);
    xn2.set(xn);
    yn2.set(yn);
    const lastX = xn[n - 1];
    const lastY = yn[n - 1];
    for (let i = n; i < newLength; i++) {
      xn2[i] = lastX;
      yn2[i] = lastY;
    }
    return { xn: xn2, yn: yn2 };
  });
}

/**
 * The samples just BEFORE each trial's step, in that trial's frame, one entry
 * per trial that parseTrials returns. Display only: a trial starts on its
 * step, so without these a thumbnail shows the response but not the step
 * that caused it. Each lead-in is `fraction` of its own trial's length, at
 * least two samples, and never reaches back past the previous step.
 */
export function trialLeadIns(xs: Float64Array, ys: Float64Array, fraction: number): Trial[] {
  const indices = stepIndices(xs, ys);
  const leads: Trial[] = [];
  for (let i1 = 1; i1 < indices.length - 1; i1++) {
    const shift = xs[indices[i1] - 1];
    const end = indices[i1];
    const count = Math.max(2, Math.ceil((indices[i1 + 1] - end) * fraction));
    const start = Math.max(indices[i1 - 1], end - count);
    leads.push({
      xn: xs.slice(start, end).map((v) => v - shift),
      yn: ys.slice(start, end).map((v) => v - shift),
    });
  }
  return leads;
}
