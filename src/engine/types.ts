// Shared types for the system-identification engine.

/** One experiment trial: a step input and the human operator's tracking response. */
export interface Trial {
  /** Target position x[n], time-shifted so the trial starts at 0. */
  xn: Float64Array;
  /** Operator (mouse) position y[n], time-shifted so the trial starts at 0. */
  yn: Float64Array;
  /** Deconvolved impulse response h[n] (populated by calculateImpulseResponse). */
  hn?: Float64Array;
  /** DFT of h[n] (populated by calculateImpulseResponse). */
  Hk?: ComplexArray;
}

export interface ComplexArray {
  real: Float64Array;
  imag: Float64Array;
}

/** Discrete-time model: y[n] - 2*P21*y[n-1] + (P21^2+P22^2)*y[n-2] = gain * x[n - D2] */
export interface DiscreteModelParams {
  /** First-order pole. */
  P11: number;
  /** First-order delay (samples). */
  D1: number;
  /** Second-order pole, real part (or magnitude*cos(theta)). */
  P21: number;
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

export interface Complex {
  real: number;
  imag: number;
}
