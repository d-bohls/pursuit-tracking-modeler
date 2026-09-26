
import type { Complex } from './types';

export function magnitudeOfComplex(real: number, imag: number): number {
  return Math.sqrt(real * real + imag * imag);
}

export function phaseOfComplex(real: number, imag: number): number {
  return Math.atan2(imag, real);
}

export function addComplex(a: Complex, b: Complex): Complex {
  return { real: a.real + b.real, imag: a.imag + b.imag };
}

export function subtractComplex(a: Complex, b: Complex): Complex {
  return { real: a.real - b.real, imag: a.imag - b.imag };
}

export function conjugate(c: Complex): Complex {
  return { real: c.real, imag: -c.imag };
}
