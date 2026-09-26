// The DFT and deconvolution behind the frequency-response plot.

import type { ComplexArray } from './types';

export function dft(x: Float64Array): ComplexArray {
  const N = x.length;
  const real = new Float64Array(N);
  const imag = new Float64Array(N);
  if (N === 0) return { real, imag };

  const factor1 = (-2 * Math.PI) / N;
  for (let k = 0; k < N; k++) {
    let sumR = 0;
    let sumI = 0;
    const factor2 = factor1 * k;
    for (let n = 0; n < N; n++) {
      const phase = factor2 * n;
      sumR += x[n] * Math.cos(phase);
      sumI += x[n] * Math.sin(phase);
    }
    real[k] = sumR;
    imag[k] = sumI;
  }
  return { real, imag };
}

export function deconvolve(x: Float64Array, y: Float64Array): Float64Array {
  const n = Math.min(x.length, y.length);
  const h = new Float64Array(n);
  if (n === 0 || x[0] === 0) return h;

  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 1; j <= i; j++) {
      sum += x[j] * h[i - j];
    }
    h[i] = (y[i] - sum) / x[0];
  }
  return h;
}

export function sumOfSquares(a: Float64Array, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}
