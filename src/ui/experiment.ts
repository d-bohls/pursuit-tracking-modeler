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
  /** Draw the identified model's prediction alongside a human recording. */
  showModel: boolean;
}

export interface ExperimentResult {
  xs: Float64Array;
  ys: Float64Array;
}

export type Phase = 'idle' | 'recording' | 'replaying' | 'finished';

export interface ExperimentState {
  phase: Phase;
  /** Steps the target has taken so far. */
  steps: number;
  samples: number;
  elapsedMs: number;
  /** Replay progress, 0..1. Only meaningful while replaying. */
  progress: number;
}

/**
 * This is deliberately NOT the canvas height any more. Tying the recording to
 * the canvas meant a recording's units -- and so its step sizes and its RMS
 * error in "pixels" -- changed with the window size, which makes two
 * recordings from the same person incomparable, and both incomparable with
 * the reference data file. The canvas is now just a viewport onto this fixed space.
 */
export const LOGICAL_HEIGHT = 493;

const MAX_TRIALS = 10;
const BUFFER_ZONE = 50;
/** How much time one full plot width represents. */
const VISIBLE_MS = 20_000;

/**
 * Where the pen sits, as a fraction of the plot width. The newest sample is
 * drawn here from the very first frame and history runs back to the left, so
 * the trace scrolls immediately instead of sweeping across an empty canvas
 * and only starting to scroll on reaching the right edge.
 *
 * At the midpoint this also lines up with the Record button, which sits in
 * the centre of the plot: the pen starts under the pointer that started it.
 */
const LEAD_ANCHOR = 0.5;

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

/** One 50 ms column of the plot, in logical units. */
interface Frame {
  target: number;
  tracker: number;
  /** The model's prediction, when it is being drawn. */
  model: number | null;
  /** True on the column where the target stepped -- drawn as a trial divider. */
  stepped: boolean;
}

interface Palette {
  surface: string;
  grid: string;
  axis: string;
  target: string;
  you: string;
  model: string;
}

export class TrackingExperiment {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: ExperimentConfig;

  private minY = BUFFER_ZONE;
  private maxY = LOGICAL_HEIGHT - BUFFER_ZONE;
  private centerY = LOGICAL_HEIGHT / 2;
  private minDy = LOGICAL_HEIGHT / 15;
  private maxDy = LOGICAL_HEIGHT / 5;

  private currentTargetY = this.centerY;
  private currentTrackerY = this.centerY;
  private currentModelY = this.centerY;

  private xs: number[] = [];
  private ys: number[] = [];
  /** The ghost's own past, so it predicts from the target rather than from you. */
  private ms: number[] = [];

  private history: Frame[] = [];
  private steppedThisColumn = false;

  private active = false;
  private phase: Phase = 'idle';
  private startedAt = 0;
  private trialTimerCount = 0;

  /** Replay state: a finished recording played back with the model beside it. */
  private replayXs: Float64Array = new Float64Array();
  private replayYs: Float64Array = new Float64Array();
  private replayModel: Float64Array = new Float64Array();
  private replayElapsedMs = 0;

  private sampleTimerHandle: ReturnType<typeof setInterval> | null = null;
  private scrollTimerHandle: ReturnType<typeof setInterval> | null = null;
  private trialTimerHandle: ReturnType<typeof setInterval> | null = null;
  private frameHandle: number | null = null;

  private onEnd: (result: ExperimentResult) => void;
  private onState: (state: ExperimentState) => void;
  private onStep: () => void;
  /** A press on the plot while something is running. The page decides what
   *  that means -- it offers a Stop rather than stopping outright, so a
   *  stray click can't destroy a run in progress. */
  private onGraphPress: () => void;

  private palette: Palette = {
    surface: '#ffffff',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    target: '#2a78d6',
    you: '#eb6834',
    model: '#1baf7a',
  };

  /** Continuous-domain model the simulation and the ghost play back. */
  private simModel: SimulationModel = DEFAULT_SIMULATION_MODEL;
  /** simModel discretized at the sample period in force for the current run. */
  private activeSim = { p11: 0, d1: 0, p21: 0, p22: 0, d2: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    config: ExperimentConfig,
    callbacks: {
      onEnd: (result: ExperimentResult) => void;
      onState: (state: ExperimentState) => void;
      onStep: () => void;
      onGraphPress: () => void;
    },
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
    this.onEnd = callbacks.onEnd;
    this.onState = callbacks.onState;
    this.onStep = callbacks.onStep;
    this.onGraphPress = callbacks.onGraphPress;

    canvas.addEventListener('pointerdown', () => {
      if (this.active) this.onGraphPress();
    });
    // Pointer, not mouse: a finger on a tablet is a perfectly good tracking
    // experiment, and identifies a visibly different system than a mouse does.
    //
    // Tracking is only live while YOU are the one being recorded. During a
    // replay the plot is a playback of something that already happened, so
    // moving over it must not write into it.
    canvas.addEventListener('pointermove', (e) => {
      if (this.phase !== 'recording' || this.config.simulationMode !== 'none') return;
      const rect = canvas.getBoundingClientRect();
      const v = ((e.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT;
      this.currentTrackerY = Math.max(0, Math.min(LOGICAL_HEIGHT, v));
    });

    this.refreshTheme();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Re-reads the plot colours from CSS. Call after a theme change. */
  refreshTheme() {
    const s = getComputedStyle(this.canvas);
    const read = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
    this.palette = {
      surface: read('--plot-surface', '#ffffff'),
      grid: read('--plot-grid', '#e1e0d9'),
      axis: read('--plot-axis', '#c3c2b7'),
      target: read('--series-target', '#2a78d6'),
      you: read('--series-you', '#eb6834'),
      model: read('--series-model', '#1baf7a'),
    };
    this.draw();
  }

  /** Sizes the backing store to the element's real device pixels. */
  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.draw();
  }

  /**
   * Point the simulation and the ghost at a system. Without it the simulation is
   * stuck on the built-in demo pole forever.
   */
  setSimulationModel(model: SimulationModel) {
    this.simModel = model;
  }

  getSimulationModel(): SimulationModel {
    return this.simModel;
  }

  updateConfig(config: Partial<ExperimentConfig>) {
    this.config = { ...this.config, ...config };
    if (!this.active) this.draw();
  }

  /** True while a recording or a replay is running. */
  isActive() {
    return this.active;
  }

  isRecording() {
    return this.phase === 'recording';
  }

  getPhase(): Phase {
    return this.phase;
  }

  getSamples(): ExperimentResult {
    return { xs: Float64Array.from(this.xs), ys: Float64Array.from(this.ys) };
  }

  /** Ends whatever is running, recording or replay. */
  stop() {
    if (this.phase === 'replaying') this.endReplay();
    else if (this.phase === 'recording') this.end();
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private emitState(phase: Phase) {
    this.phase = phase;
    const total = this.replayXs.length * this.config.samplePeriodMs;
    this.onState({
      phase,
      steps: this.trialTimerCount,
      samples: this.xs.length,
      elapsedMs: this.startedAt ? performance.now() - this.startedAt : 0,
      progress: phase === 'replaying' && total > 0 ? Math.min(1, this.replayElapsedMs / total) : 0,
    });
  }

  begin() {
    if (this.active) return;
    this.active = true;
    this.startedAt = performance.now();
    this.trialTimerCount = 0;
    this.xs = [];
    this.ys = [];
    this.ms = [];
    this.history = [];
    this.currentTargetY = this.centerY;
    this.currentModelY = this.centerY;
    if (this.config.simulationMode !== 'none') this.currentTrackerY = this.currentTargetY;

    this.discretizeModel();

    this.sampleTimerHandle = setInterval(() => this.onSampleTick(), this.config.samplePeriodMs);
    this.scrollTimerHandle = setInterval(() => this.onScrollTick(), this.config.scrollPeriodMs);
    this.trialTimerHandle = setInterval(() => this.onTrialTick(), this.config.trialPeriodMs);
    this.startDrawing();
    this.emitState('recording');
  }

  private discretizeModel() {
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
  }

  /**
   * Play a finished recording back with the identified model running beside
   * it: the target you were given, the response you actually made, and what
   * the model says you would have made. Nothing is recorded and the plot does
   * not track the pointer -- this is a playback of something that already
   * happened.
   */
  startReplay(xs: Float64Array, ys: Float64Array) {
    if (this.active || xs.length < 2) return;
    this.active = true;
    this.startedAt = performance.now();
    this.replayXs = xs;
    this.replayYs = ys;
    this.replayElapsedMs = 0;
    this.trialTimerCount = 0;
    this.history = [];

    this.discretizeModel();
    this.replayModel = this.modelResponseTo(xs);

    this.currentTargetY = xs[0];
    this.currentTrackerY = ys[0];
    this.currentModelY = this.replayModel[0];

    this.scrollTimerHandle = setInterval(() => this.onReplayTick(), this.config.scrollPeriodMs);
    this.startDrawing();
    this.emitState('replaying');
  }

  /**
   * The identified model's response to a recorded target, computed in one
   * pass rather than stepped alongside the replay -- the difference equation
   * is deterministic, so there is no reason to thread it through a timer.
   */
  private modelResponseTo(xs: Float64Array): Float64Array {
    const { p21, p22, d2 } = this.activeSim;
    const gain = 1 - 2 * p21 + p21 * p21 + p22 * p22;
    const out = new Float64Array(xs.length);
    out[0] = xs[0];
    if (xs.length > 1) out[1] = xs[0];
    for (let n = 2; n < xs.length; n++) {
      const delayed = n - d2 >= 0 ? xs[n - d2] : xs[0];
      out[n] = 2 * p21 * out[n - 1] - (p21 * p21 + p22 * p22) * out[n - 2] + gain * delayed;
    }
    return out;
  }

  private onReplayTick() {
    // Wall-clock, not a tick count. setInterval is throttled hard in a
    // background tab, so counting ticks makes a replay of a 44 s recording
    // crawl for minutes and its progress readout lie about where it is.
    this.replayElapsedMs = performance.now() - this.startedAt;
    const i = Math.floor(this.replayElapsedMs / this.config.samplePeriodMs);
    if (i >= this.replayXs.length) {
      this.endReplay();
      return;
    }

    const stepped = i > 0 && this.replayXs[i] !== this.replayXs[i - 1] && this.currentTargetY !== this.replayXs[i];
    this.currentTargetY = this.replayXs[i];
    this.currentTrackerY = this.replayYs[i];
    this.currentModelY = this.replayModel[i];
    if (stepped) this.trialTimerCount += 1;

    this.history.push({
      target: this.currentTargetY,
      tracker: this.currentTrackerY,
      model: this.currentModelY,
      stepped,
    });
    const cap = Math.ceil(VISIBLE_MS / this.config.scrollPeriodMs) + 2;
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);

    this.emitState('replaying');
  }

  private endReplay() {
    if (this.phase !== 'replaying') return;
    this.active = false;
    if (this.scrollTimerHandle) clearInterval(this.scrollTimerHandle);
    this.scrollTimerHandle = null;
    this.stopDrawing();
    this.draw();
    this.emitState('finished');
  }

  end() {
    if (!this.active || this.phase !== 'recording') return;
    this.active = false;
    for (const h of [this.sampleTimerHandle, this.scrollTimerHandle, this.trialTimerHandle]) {
      if (h) clearInterval(h);
    }
    this.sampleTimerHandle = this.scrollTimerHandle = this.trialTimerHandle = null;
    this.stopDrawing();
    this.draw();
    this.emitState('finished');
    this.onEnd(this.getSamples());
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
    this.steppedThisColumn = true;
    // A step is what closes out the previous trial, so this is the moment a
    // newly analysable trial appears -- see the incremental analysis in main.
    this.onStep();
    this.emitState('recording');
  }

  private onSampleTick() {
    if (this.config.simulationMode !== 'none') {
      this.currentTrackerY = this.simulate(this.config.simulationMode, this.ys);
    }
    this.xs.push(this.currentTargetY);
    this.ys.push(this.currentTrackerY);

    // The ghost runs the target through the identified model on its OWN past,
    // so it shows what the model predicts you would have done, next to what
    // you actually did. Driving it from this.ys would just replay you.
    this.currentModelY = this.simulate('second', this.ms);
    this.ms.push(this.currentModelY);
  }

  /**
   * Plays the target through the identified system in place of a human hand,
   * using the discrete parameters derived in begin(). Same difference
   * equations the analysis reports, so what you see is literally the model it
   * printed. `past` is the output history to recurse on, which lets the same
   * code drive both the simulated tracker and the ghost.
   */
  private simulate(mode: 'first' | 'second', past: number[]): number {
    const n = this.xs.length;
    const fallback = past === this.ms ? this.currentModelY : this.currentTrackerY;

    if (mode === 'first') {
      // y[n] = p*y[n-1] + (1-p)*x[n-D]
      const { p11, d1 } = this.activeSim;
      if (n > d1 && past.length >= 1) {
        return p11 * past[past.length - 1] + (1 - p11) * this.xs[n - d1];
      }
      return fallback;
    }

    // y[n] = 2*p1*y[n-1] - (p1^2+p2^2)*y[n-2] + gain*x[n-D]
    const { p21, p22, d2 } = this.activeSim;
    if (n > Math.max(d2, 2) && past.length >= 2) {
      const gain = 1 - 2 * p21 + p21 * p21 + p22 * p22;
      return 2 * p21 * past[past.length - 1] - (p21 * p21 + p22 * p22) * past[past.length - 2] + gain * this.xs[n - d2];
    }
    return fallback;
  }

  /** Appends one column of history at the scroll rate (20 Hz by default). */
  private onScrollTick() {
    const showModel = this.config.showModel && this.config.simulationMode === 'none';
    this.history.push({
      target: this.currentTargetY,
      tracker: this.currentTrackerY,
      model: showModel ? this.currentModelY : null,
      stepped: this.steppedThisColumn,
    });
    this.steppedThisColumn = false;

    const cap = Math.ceil(VISIBLE_MS / this.config.scrollPeriodMs) + 2;
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
  }

  private startDrawing() {
    if (this.frameHandle !== null) return;
    const tick = () => {
      this.draw();
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  private stopDrawing() {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  /** Redraws the whole visible window from the history buffer. */
  private draw() {
    const { ctx, canvas } = this;
    const { width, height } = canvas;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.palette.surface;
    ctx.fillRect(0, 0, width, height);

    const pad = 8 * dpr;
    const plotH = height - pad * 2;
    const yAt = (v: number) => pad + (v / LOGICAL_HEIGHT) * plotH;

    // A centre line, so a step's size and direction are readable at a glance.
    ctx.strokeStyle = this.palette.grid;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, yAt(this.centerY));
    ctx.lineTo(width, yAt(this.centerY));
    ctx.stroke();

    const n = this.history.length;
    if (n === 0) return;

    // One full width is VISIBLE_MS, so the time scale never changes. Positions
    // are measured BACK from the pen rather than forward from the start of the
    // recording, which is what makes the plot scroll from the first frame.
    const visible = Math.ceil(VISIBLE_MS / this.config.scrollPeriodMs);
    const pxPerColumn = width / visible;
    const anchorX = width * LEAD_ANCHOR;
    const xAt = (i: number) => anchorX - (n - 1 - i) * pxPerColumn;
    const start = Math.max(0, n - 1 - Math.ceil(anchorX / pxPerColumn));

    // Trial dividers: where the target stepped, i.e. where one trial ends and
    // the next begins. The analysis splits the recording at exactly these
    // instants, so drawing them makes the unit of analysis visible.
    ctx.strokeStyle = this.palette.axis;
    ctx.lineWidth = dpr;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    for (let i = start; i < n; i++) {
      if (!this.history[i].stepped) continue;
      const x = xAt(i);
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, pad + plotH);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const series = (pick: (f: Frame) => number | null, color: string, lw: number, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw * dpr;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(dash.map((d) => d * dpr));

      if (this.config.discretePoints) {
        for (let i = start; i < n; i++) {
          const v = pick(this.history[i]);
          if (v === null) continue;
          ctx.fillRect(xAt(i) - dpr, yAt(v) - dpr, 2 * dpr, 2 * dpr);
        }
      } else {
        ctx.beginPath();
        let started = false;
        for (let i = start; i < n; i++) {
          const v = pick(this.history[i]);
          if (v === null) {
            started = false;
            continue;
          }
          const x = xAt(i);
          const y = yAt(v);
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    };

    // The model prediction is dashed as well as coloured: it is the one series
    // that can sit under 3:1 against the light surface, so it never relies on
    // hue alone (it is named in the legend too).
    series((f) => f.model, this.palette.model, 2, [5, 4]);
    series((f) => f.target, this.palette.target, 2, []);
    series((f) => f.tracker, this.palette.you, 2, []);
  }
}
