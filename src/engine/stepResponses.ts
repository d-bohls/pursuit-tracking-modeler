// Splitting a recording at each step, and padding the pieces to a common
// length.

import type { StepResponse } from './types';

/**
 * Where the recording splits: 0, then the index of every sample at which the
 * target has just stepped. Step response k runs from indices[k] to indices[k + 1]; the
 * stretch before the first step and the one after the last are not step responses.
 * Shared by splitStepResponses and responseLeadIns so the two can never disagree.
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

export function splitStepResponses(xs: Float64Array, ys: Float64Array): StepResponse[] {
  const indices = stepIndices(xs, ys);
  const responseCount = indices.length - 1;
  const responses: StepResponse[] = [];
  for (let i1 = 1; i1 < responseCount; i1++) {
    const shift = xs[indices[i1] - 1];
    const start = indices[i1];
    const end = indices[i1 + 1];
    const xn = new Float64Array(end - start);
    const yn = new Float64Array(end - start);
    for (let i = start; i < end; i++) {
      xn[i - start] = xs[i] - shift;
      yn[i - start] = ys[i] - shift;
    }
    responses.push({ xn, yn });
  }
  return responses;
}

/**
 * Pad each step response to 10x its original length by repeating its final sample,
 * so every step response (and thus every deconvolved h[n]) has a common length for
 * curve fitting. Fixed to pad yn with yn's own tail (see file header).
 */
export function padResponses(responses: StepResponse[], factor = 10): StepResponse[] {
  return responses.map(({ xn, yn }) => {
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
 * The samples just BEFORE each step response's step, in that step response's frame, one entry
 * per step response that splitStepResponses returns. Display only: a step response starts on its
 * step, so without these a thumbnail shows the response but not the step
 * that caused it. Each lead-in is `fraction` of its own step response's length, at
 * least two samples, and never reaches back past the previous step.
 */
export function responseLeadIns(xs: Float64Array, ys: Float64Array, fraction: number): StepResponse[] {
  const indices = stepIndices(xs, ys);
  const leads: StepResponse[] = [];
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
