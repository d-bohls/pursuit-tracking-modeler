// Shared types for the system-identification engine.

/** One experiment step response: a step input and the human operator's tracking response. */
export interface StepResponse {
  /** Target position x[n], time-shifted so the step response starts at 0. */
  xn: Float64Array;
  /** Operator (pointer) position y[n], time-shifted so the step response starts at 0. */
  yn: Float64Array;
}

export interface ComplexArray {
  real: Float64Array;
  imag: Float64Array;
}

/**
 * Discrete-time model: y[n] - 2*P21*y[n-1] + pairProduct(P21, P22)*y[n-2] = gain * x[n - D2].
 * P22 >= 0: poles P21 +/- j*P22. P22 < 0: real poles P21 +/- |P22| (see poleConversion.ts).
 */
export interface DiscreteModelParams {
  /** First-order pole. */
  P11: number;
  /** First-order delay (samples). */
  D1: number;
  /** Second-order pole, real part (or magnitude*cos(theta)). */
  P21: number;
  /** Second-order pole: imaginary part when >= 0; when < 0, minus the half-split of two real poles. */
  P22: number;
  /** Second-order delay (samples). */
  D2: number;
}

/** Continuous-time (Laplace) equivalent of DiscreteModelParams. */
export interface ContinuousModelParams {
  P11: number;
  D1: number;
  P21: number;
  P22: number;
  D2: number;
}
