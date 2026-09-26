// The live tracking experiment. A target line jumps to a new random vertical
// position every `stepPeriodMs` on average (step input); the operator tracks
// it with the pointer, and both positions are sampled every `samplePeriodMs`.
//
// Two timers produce the data: onSampleTick records x[n] and y[n], and
// onStepTick steps the target. Drawing is separate: the samples are kept in a
// history buffer in LOGICAL units and the visible window is redrawn each
// animation frame, so the plot is independent of the canvas's size,
// resolution and theme.

import { continuousPoleToDiscrete, discretePoleToContinuous } from '../engine/poleConversion';

export type SimulationMode = 'none' | 'first' | 'second';

export interface ExperimentConfig {
  trialPeriodMs: number;
  samplePeriodMs: number;
  scrollPeriodMs: number;
  simulationMode: SimulationMode;
  discretePoints: boolean;
}

export interface ExperimentResult {
  xs: Float64Array;
  ys: Float64Array;
}

const MAX_TRIALS = 10;
const BUFFER_ZONE_FRACTION = 50 / 493;

export interface SimulationModel {
  /** First-order pole, rad/s (negative for a stable, decaying response). */
  P11: number;
  /** First-order delay, seconds. */
  D1: number;
  /** Second-order pole, real part, rad/s. */
  P21: number;
  /** Second-order pole, imaginary part, rad/s. */
  P22: number;
  /** Second-order delay, seconds. */
  D2: number;
}

// Note this demo pole is far more damped than a real tracker: zeta = 0.62,
// about 8% overshoot. Once you run system identification the model below is
// replaced by YOUR measured one (see setSimulationModel), which is the whole
// point of the "simulate a previously identified system" feature.
const seed = discretePoleToContinuous(0.8, 0.2, 0.1);
export const DEFAULT_SIMULATION_MODEL: SimulationModel = {
  P11: -3.0,
  D1: 0.4,
  P21: seed.cr,
  P22: seed.ci,
  D2: 0.4,
};

/** Natural frequency and damping ratio of a continuous second-order model. */
export function dampingOf(model: SimulationModel): { wn: number; zeta: number } {
  const wn = Math.hypot(model.P21, model.P22);
  return { wn, zeta: wn === 0 ? 0 : -model.P21 / wn };
}

export class TrackingExperiment {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Offscreen scratch copy used to scroll the plot -- see onScrollTick. */
  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;
  private config: ExperimentConfig;

  private minY = 0;
  private maxY = 0;
  private centerY = 0;
  private minDy = 0;
  private maxDy = 0;

  private currentTargetY = 0;
  private currentTrackerY = 0;
  private previousTargetY = 0;
  private previousTrackerY = 0;

  private xs: number[] = [];
  private ys: number[] = [];

  private active = false;
  private isNewExperiment = true;
  private trialTimerCount = 0;

  private sampleTimerHandle: ReturnType<typeof setInterval> | null = null;
  private scrollTimerHandle: ReturnType<typeof setInterval> | null = null;
  private trialTimerHandle: ReturnType<typeof setInterval> | null = null;

  private onEnd: (result: ExperimentResult) => void;
  private onHint: (text: string) => void;

  /** Continuous-domain model the simulation modes play back. */
  private simModel: SimulationModel = DEFAULT_SIMULATION_MODEL;
  /** simModel discretized at the sample period in force for the current run. */
  private activeSim = {
    p11: 0,
    d1: 0,
    p21: 0,
    p22: 0,
    d2: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    config: ExperimentConfig,
    callbacks: { onEnd: (result: ExperimentResult) => void; onHint: (text: string) => void },
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.buffer = document.createElement('canvas');
    this.buffer.width = canvas.width;
    this.buffer.height = canvas.height;
    this.bufferCtx = this.buffer.getContext('2d')!;
    this.config = config;
    this.onEnd = callbacks.onEnd;
    this.onHint = callbacks.onHint;

    const h = canvas.height;
    const buffer = h * BUFFER_ZONE_FRACTION;
    this.minY = buffer;
    this.maxY = h - buffer;
    this.centerY = h / 2;
    this.minDy = h / 15;
    this.maxDy = h / 5;
    this.currentTargetY = this.centerY;
    this.currentTrackerY = this.centerY;

    this.clearCanvas();
    canvas.addEventListener('click', () => this.toggle());
    canvas.addEventListener('mousemove', (e) => {
      if (this.config.simulationMode === 'none') {
        const rect = canvas.getBoundingClientRect();
        this.currentTrackerY = ((e.clientY - rect.top) / rect.height) * canvas.height;
      }
    });
  }

  /**
   * Point the simulation modes at a system. Without this the simulation is stuck on
   * the built-in demo pole forever, and replays a near-critically-damped response
   * no matter what you recorded.
   */
  setSimulationModel(model: SimulationModel) {
    this.simModel = model;
  }

  getSimulationModel(): SimulationModel {
    return this.simModel;
  }

  updateConfig(config: Partial<ExperimentConfig>) {
    this.config = { ...this.config, ...config };
  }

  private clearCanvas() {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private toggle() {
    if (this.active) this.end();
    else this.begin();
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private begin() {
    this.active = true;
    this.isNewExperiment = true;
    this.trialTimerCount = 0;
    this.xs = [];
    this.ys = [];
    this.currentTargetY = this.centerY;
    if (this.config.simulationMode !== 'none') this.currentTrackerY = this.currentTargetY;
    const ts = this.config.samplePeriodMs / 1000;
    const d1 = continuousPoleToDiscrete(this.simModel.P11, 0, ts);
    const d2 = continuousPoleToDiscrete(this.simModel.P21, this.simModel.P22, ts);
    this.activeSim = {
      p11: d1.dr,
      d1: Math.max(1, Math.round((this.simModel.D1 * 1000) / this.config.samplePeriodMs)),
      p21: d2.dr,
      p22: d2.di,
      d2: Math.max(1, Math.round((this.simModel.D2 * 1000) / this.config.samplePeriodMs)),
    };

    this.clearCanvas();
    this.onHint('Experiment running -- track the black line. Click again to stop.');

    this.sampleTimerHandle = setInterval(() => this.onSampleTick(), this.config.samplePeriodMs);
    this.scrollTimerHandle = setInterval(() => this.onScrollTick(), this.config.scrollPeriodMs);
    this.trialTimerHandle = setInterval(() => this.onTrialTick(), this.config.trialPeriodMs);
  }

  private end() {
    this.active = false;
    if (this.sampleTimerHandle) clearInterval(this.sampleTimerHandle);
    if (this.scrollTimerHandle) clearInterval(this.scrollTimerHandle);
    if (this.trialTimerHandle) clearInterval(this.trialTimerHandle);
    this.sampleTimerHandle = this.scrollTimerHandle = this.trialTimerHandle = null;
    this.onHint('Click inside the graph to start a new experiment.');
    this.onEnd({ xs: Float64Array.from(this.xs), ys: Float64Array.from(this.ys) });
  }

  private onTrialTick() {
    if (this.trialTimerCount > MAX_TRIALS) {
      this.end();
      return;
    }
    this.trialTimerCount += 1;
    let dy = this.randomInt(this.minDy, this.maxDy);
    if (this.randomInt(0, 1) === 0) dy = -dy;
    if (this.currentTargetY + dy < this.minY || this.currentTargetY + dy > this.maxY) dy = -dy;
    this.currentTargetY += dy;
  }

  private onSampleTick() {
    if (this.config.simulationMode !== 'none') {
      this.currentTrackerY = this.simulateResponse();
    }
    this.xs.push(this.currentTargetY);
    this.ys.push(this.currentTrackerY);
  }

  /**
   * Plays the target through the identified system in place of a human hand,
   * using the discrete parameters derived in begin() from whatever model
   * setSimulationModel was last given. Same difference equations the analysis
   * reports, so what you see here is literally the model it printed.
   */
  private simulateResponse(): number {
    const n = this.xs.length;

    if (this.config.simulationMode === 'first') {
      // y[n] = p*y[n-1] + (1-p)*x[n-D]
      const { p11, d1 } = this.activeSim;
      if (n > d1) {
        return p11 * this.ys[n - 1] + (1 - p11) * this.xs[n - d1];
      }
      return this.currentTrackerY;
    }

    if (this.config.simulationMode === 'second') {
      // y[n] = 2*p1*y[n-1] - (p1^2+p2^2)*y[n-2] + gain*x[n-D]
      const { p21, p22, d2 } = this.activeSim;
      if (n > Math.max(d2, 2)) {
        const gain = 1 - 2 * p21 + p21 * p21 + p22 * p22;
        return 2 * p21 * this.ys[n - 1] - (p21 * p21 + p22 * p22) * this.ys[n - 2] + gain * this.xs[n - d2];
      }
      return this.currentTrackerY;
    }

    return this.currentTrackerY;
  }

  private onScrollTick() {
    const { width, height } = this.canvas;

    // This MUST go through an offscreen buffer. Drawing the canvas onto itself
    // (ctx.drawImage(this.canvas, -1, 0)) composites with the default
    // 'source-over' rule, under which transparent source pixels leave the
    // destination untouched -- so nothing is ever erased. Each tick just
    // stamps another 1px-shifted copy over the previous frame, the old traces
    // never scroll away, and the plot turns into an accumulating smear whose
    // leading edge creeps left far slower than one pixel per tick.
    this.bufferCtx.clearRect(0, 0, width, height);
    this.bufferCtx.drawImage(this.canvas, 0, 0);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.drawImage(this.buffer, -1, 0);

    const newX = this.currentTargetY;
    const newY = this.currentTrackerY;
    if (this.isNewExperiment) {
      this.isNewExperiment = false;
      this.previousTargetY = newX;
      this.previousTrackerY = newY;
    }

    const xCol = width - 2;
    if (this.config.discretePoints) {
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(xCol, newX, 2, 2);
      this.ctx.fillStyle = '#cc2200';
      this.ctx.fillRect(xCol, newY, 2, 2);
    } else {
      this.ctx.strokeStyle = '#000000';
      this.ctx.beginPath();
      this.ctx.moveTo(xCol - 1, this.previousTargetY);
      this.ctx.lineTo(xCol, newX);
      this.ctx.stroke();

      this.ctx.strokeStyle = '#cc2200';
      this.ctx.beginPath();
      this.ctx.moveTo(xCol - 1, this.previousTrackerY);
      this.ctx.lineTo(xCol, newY);
      this.ctx.stroke();
    }

    this.previousTargetY = newX;
    this.previousTrackerY = newY;
  }
}
