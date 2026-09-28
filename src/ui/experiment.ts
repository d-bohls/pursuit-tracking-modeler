// The live tracking experiment. A target line jumps to a new random vertical
// position every `stepPeriodMs` on average (step input); the operator tracks
// it with the pointer, and both positions are sampled every `samplePeriodMs`.
//
// Two timers produce the data: onSampleTick records x[n] and y[n], and
// onStepTick steps the target. Drawing is separate: the samples are kept in a
// history buffer in LOGICAL units and the visible window is redrawn each
// animation frame, so the plot is independent of the canvas's size,
// resolution and theme.

import {
  continuousPairToDiscrete,
  continuousPoleToDiscrete,
  discretePoleToContinuous,
  pairNaturalFrequency,
  pairProduct,
} from '../engine/poleConversion';

export type SimulationMode = 'none' | 'first' | 'second';

export interface ExperimentConfig {
  stepPeriodMs: number;
  samplePeriodMs: number;
  scrollPeriodMs: number;
  simulationMode: SimulationMode;
  discretePoints: boolean;
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
 * The coordinate space target and tracker positions are recorded in.
 *
 * Deliberately NOT the canvas height: if a recording's units -- and so its
 * step sizes and its RMS error in "pixels" -- changed with the window size,
 * two recordings from the same person would be incomparable. The canvas is a
 * viewport onto this fixed space.
 */
export const LOGICAL_HEIGHT = 493;

/**
 * A run ends itself after this many complete step responses. A step response runs from one
 * step to the next, so it takes MAX_RESPONSES + 1 steps: the last one only
 * closes step response MAX_RESPONSES off.
 */
export const MAX_RESPONSES = 10;

/**
 * Each gap between steps is the step period scaled by a random factor in
 * [1 - JITTER, 1 + JITTER]. On a fixed beat you learn when the next step is
 * due, and a step you can anticipate measures your timing, not your reaction:
 * the identified delay comes out short. The mean gap is still the period.
 */
const STEP_JITTER = 0.25;
const BUFFER_ZONE = 50; // guard band the target stays clear of, top and bottom
/** How much time one full plot width represents. */
const VISIBLE_MS = 20_000;

/**
 * Where the pen sits, as a fraction of the plot width. The newest sample is
 * drawn here from the very first frame and history runs back to the left, so
 * the trace scrolls immediately instead of sweeping across an empty canvas
 * and only starting to scroll on reaching the right edge.
 *
 * At 0.8 the plot shows 16 of its 20 seconds as history, where the midpoint
 * showed 10, and the strip to the right keeps the pen's marks and each new
 * step clear of the frame -- at the very edge both would be cut in half.
 */
const LEAD_ANCHOR = 0.8;

/**
 * The system the simulation modes play back, held in CONTINUOUS (s-plane)
 * form so it survives a change of sample period.
 */
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

// Starting model, before any identification has been run: a first-order pole
// at -3.0 rad/s, and the discrete pair (0.8, 0.2) at the default 100 ms period,
// converted to continuous so it lives in the same units as everything else.
//
// Note this demo pole is far more damped than a real tracker: zeta = 0.62,
// about 8% overshoot. Once you run system identification the model below is
// replaced by the identified one (see setSimulationModel), which is what the
// self-test and Replay play back.
const seed = discretePoleToContinuous(0.8, 0.2, 0.1);
const DEFAULT_SIMULATION_MODEL: SimulationModel = {
  P11: -3.0,
  D1: 0.4,
  P21: seed.cr,
  P22: seed.ci,
  D2: 0.4,
};

/** Natural frequency and damping ratio of a continuous second-order model. */
export function dampingOf(model: SimulationModel): { wn: number; zeta: number } {
  const wn = pairNaturalFrequency(model.P21, model.P22);
  return { wn, zeta: wn === 0 ? 0 : -model.P21 / wn };
}

/** One 50 ms column of the plot, in logical units. */
interface Frame {
  target: number;
  tracker: number;
  /** The model's prediction, when it is being drawn. */
  model: number | null;
  /** True on the column where the target stepped -- drawn as a step divider. */
  stepped: boolean;
}

interface Palette {
  surface: string;
  grid: string;
  axis: string;
  muted: string;
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
  /** Last pointer height over the plot, or null when it is elsewhere. */
  private pointerY: number | null = null;
  /** The finger currently holding a run open, if any. */
  private touchPointerId: number | null = null;
  private currentModelY = this.centerY;

  private xs: number[] = [];
  private ys: number[] = [];

  private history: Frame[] = [];
  /** Columns trimmed off the front of `history`; 0 while its first column is the run's start. */
  private historyDropped = 0;
  private steppedThisColumn = false;

  private active = false;
  private phase: Phase = 'idle';
  private startedAt = 0;
  private stepCount = 0;

  /** Replay state: a finished recording played back with the model beside it. */
  private replayXs: Float64Array = new Float64Array();
  private replayYs: Float64Array = new Float64Array();
  private replayModel: Float64Array = new Float64Array();
  private replayElapsedMs = 0;
  /** The period the replayed samples were RECORDED at, which paces the replay. */
  private replayPeriodMs = 100;

  private sampleTimerHandle: ReturnType<typeof setInterval> | null = null;
  private scrollTimerHandle: ReturnType<typeof setInterval> | null = null;
  private stepTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private frameHandle: number | null = null;

  private onEnd: (result: ExperimentResult) => void;
  private onState: (state: ExperimentState) => void;
  private onStep: () => void;
  /** A press on the plot while something is running. The page decides what
   *  that means -- it offers a Stop rather than stopping outright, so a
   *  stray click can't destroy a run in progress. */
  private onGraphPress: () => void;
  /** A finger went down on an idle plot: the page decides to start a run. */
  private onTouchStart: () => void;

  private palette: Palette = {
    surface: '#ffffff',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    muted: '#898781',
    target: '#2a78d6',
    you: '#eb6834',
    model: '#15946a',
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
      onTouchStart: () => void;
    },
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
    this.onEnd = callbacks.onEnd;
    this.onState = callbacks.onState;
    this.onStep = callbacks.onStep;
    this.onGraphPress = callbacks.onGraphPress;
    this.onTouchStart = callbacks.onTouchStart;

    // Touch drives a run by holding: press to start, lift to stop. With a
    // finger the pointer IS the instrument -- it has to be on the glass to
    // track at all -- so a tap to stop cannot be told apart from tracking,
    // and lifting is the one gesture that unambiguously means "done".
    //
    // Decided per EVENT, not per device: a laptop with a touchscreen gets
    // press-and-hold from its screen and click-to-start from its mouse, in
    // the same session.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        if (!this.active) this.holdToRecord(e);
        // A finger already holding a recording is the instrument, and a second
        // one should not end the run. Anything else -- a replay -- has no
        // finger to lift, so a tap stops it, as a click does.
        else if (this.touchPointerId === null) this.onGraphPress();
        return;
      }
      if (this.active) this.onGraphPress();
    });

    const liftEnds = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || e.pointerId !== this.touchPointerId) return;
      this.touchPointerId = null;
      if (this.phase === 'recording') this.end();
    };
    canvas.addEventListener('pointerup', liftEnds);
    canvas.addEventListener('pointercancel', liftEnds);
    // Pointer, not mouse: a finger on a tablet is a perfectly good tracking
    // experiment, and identifies a visibly different system than a mouse does.
    //
    // Tracking is only live while YOU are the one being recorded. During a
    // replay the plot is a playback of something that already happened, so
    // moving over it must not write into it.
    //
    // The pointer's height is followed even when idle, though: begin() needs
    // it to start the trace where the pointer actually is.
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const v = ((e.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT;
      this.pointerY = Math.max(0, Math.min(LOGICAL_HEIGHT, v));
      if (this.phase !== 'recording' || this.config.simulationMode !== 'none') return;
      this.currentTrackerY = this.pointerY;
    });
    canvas.addEventListener('pointerleave', () => (this.pointerY = null));

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
      muted: read('--plot-muted', '#898781'),
      target: read('--series-target', '#2a78d6'),
      you: read('--series-you', '#eb6834'),
      model: read('--series-model', '#15946a'),
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
   * Point the simulation and the ghost at a system. Call this with the
   * identified model so the self-test and Replay play it back. Without it the simulation plays the built-in demo pole forever.
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

  /** True if the plot is currently showing a model line, from any run. */
  hasModelTrace(): boolean {
    return this.history.some((f) => f.model !== null);
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
    const total = this.replayXs.length * this.replayPeriodMs;
    this.onState({
      phase,
      steps: this.stepCount,
      samples: this.xs.length,
      elapsedMs: this.startedAt ? performance.now() - this.startedAt : 0,
      progress: phase === 'replaying' && total > 0 ? Math.min(1, this.replayElapsedMs / total) : 0,
    });
  }

  begin() {
    if (this.active) return;
    this.active = true;
    this.startedAt = performance.now();
    this.stepCount = 0;
    this.xs = [];
    this.ys = [];
    this.history = [];
    this.historyDropped = 0;
    // onStepTick raises this and only the next onScrollTick lowers it, so a
    // run stopped inside that 50 ms window leaves it set -- and the next run's
    // first column would be drawn as a step divider for a step that never
    // happened.
    this.steppedThisColumn = false;
    this.currentTargetY = this.centerY;
    this.currentModelY = this.centerY;
    // Seed the trace where the pointer IS, not where the last run left it.
    // Without this a second recording opens with the red line at the height
    // the previous run ended on, and it stays there until you happen to move.
    // Clicking Record puts the pointer on the plot's centre, which is where
    // the target starts; starting with the space bar from off the plot has no
    // pointer height to use, so the centre is the honest default there too.
    this.currentTrackerY =
      this.config.simulationMode !== 'none' ? this.currentTargetY : this.pointerY ?? this.centerY;

    this.discretizeModel();

    this.sampleTimerHandle = setInterval(() => this.onSampleTick(), this.config.samplePeriodMs);
    this.scrollTimerHandle = setInterval(() => this.onScrollTick(), this.config.scrollPeriodMs);
    this.scheduleStep();
    this.startDrawing();
    this.emitState('recording');
  }

  /**
   * Re-discretize the simulation model at whatever sample period is in force
   * now, so changing the sample period keeps the same physical dynamics
   * instead of silently changing the system.
   */
  private discretizeModel(periodMs = this.config.samplePeriodMs) {
    const ts = periodMs / 1000;
    const d1 = continuousPoleToDiscrete(this.simModel.P11, 0, ts);
    const d2 = continuousPairToDiscrete(this.simModel.P21, this.simModel.P22, ts);
    this.activeSim = {
      p11: d1.dr,
      d1: Math.max(1, Math.round((this.simModel.D1 * 1000) / periodMs)),
      p21: d2.dr,
      p22: d2.di,
      d2: Math.max(1, Math.round((this.simModel.D2 * 1000) / periodMs)),
    };
  }

  /**
   * Play a finished recording back with the identified model running beside
   * it: the target you were given, the response you actually made, and what
   * the model says you would have made. Nothing is recorded and the plot does
   * not track the pointer -- this is a playback of something that already
   * happened.
   */
  /**
   * `samplePeriodMs` is the period the samples were recorded at. It paces the
   * playback and discretizes the model, so a recording made at 50 ms replays
   * at its real speed, with its real model, whatever Settings says today.
   */
  startReplay(xs: Float64Array, ys: Float64Array, samplePeriodMs: number) {
    if (this.active || xs.length < 2) return;
    this.active = true;
    this.startedAt = performance.now();
    this.replayXs = xs;
    this.replayYs = ys;
    this.replayPeriodMs = samplePeriodMs;
    this.replayElapsedMs = 0;
    this.stepCount = 0;
    this.history = [];
    this.historyDropped = 0;

    this.discretizeModel(samplePeriodMs);
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
    const gain = 1 - 2 * p21 + pairProduct(p21, p22);
    const out = new Float64Array(xs.length);
    out[0] = xs[0];
    if (xs.length > 1) out[1] = xs[0];
    for (let n = 2; n < xs.length; n++) {
      const delayed = n - d2 >= 0 ? xs[n - d2] : xs[0];
      out[n] = 2 * p21 * out[n - 1] - pairProduct(p21, p22) * out[n - 2] + gain * delayed;
    }
    return out;
  }

  private onReplayTick() {
    // Wall-clock, not a tick count. setInterval is throttled hard in a
    // background tab, so counting ticks makes a replay of a 44 s recording
    // crawl for minutes and its progress readout lie about where it is.
    this.replayElapsedMs = performance.now() - this.startedAt;
    const i = Math.floor(this.replayElapsedMs / this.replayPeriodMs);
    if (i >= this.replayXs.length) {
      this.endReplay();
      return;
    }

    const stepped = i > 0 && this.replayXs[i] !== this.replayXs[i - 1] && this.currentTargetY !== this.replayXs[i];
    this.currentTargetY = this.replayXs[i];
    this.currentTrackerY = this.replayYs[i];
    this.currentModelY = this.replayModel[i];
    if (stepped) this.stepCount += 1;

    this.history.push({
      target: this.currentTargetY,
      tracker: this.currentTrackerY,
      model: this.currentModelY,
      stepped,
    });
    this.trimHistory();

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

  /**
   * Starts a recording that lasts as long as this touch does. The press may
   * begin on the plot or on the Record button: the pointer is captured to the
   * plot either way, so its moves track and its lift ends the run even when
   * the finger went down on a button that has since been hidden.
   */
  holdToRecord(e: PointerEvent) {
    if (this.active) return;
    this.touchPointerId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (lifted before this ran). Its pointerup
      // has been and gone, so the run would never end: do not start one.
      this.touchPointerId = null;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const v = ((e.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT;
    this.pointerY = Math.max(0, Math.min(LOGICAL_HEIGHT, v));
    this.onTouchStart();
  }

  end() {
    if (!this.active || this.phase !== 'recording') return;
    this.active = false;
    this.touchPointerId = null;
    for (const h of [this.sampleTimerHandle, this.scrollTimerHandle]) {
      if (h) clearInterval(h);
    }
    if (this.stepTimerHandle) clearTimeout(this.stepTimerHandle);
    this.sampleTimerHandle = this.scrollTimerHandle = this.stepTimerHandle = null;
    this.stopDrawing();
    this.draw();
    this.emitState('finished');
    this.onEnd(this.getSamples());
  }

  /** Arms the next step, a randomly jittered step period from now. */
  private scheduleStep() {
    const factor = 1 + STEP_JITTER * (2 * Math.random() - 1);
    this.stepTimerHandle = setTimeout(() => {
      this.onStepTick();
      if (!this.active || this.phase !== 'recording') return;
      if (this.stepCount <= MAX_RESPONSES) {
        this.scheduleStep();
      } else {
        // That was the closing step. Stay just long enough for samples to
        // land at the new level -- that is how a step is seen at all -- then
        // stop, rather than recording a whole step period nobody will use.
        this.stepTimerHandle = setTimeout(() => this.end(), this.config.samplePeriodMs * 3.5);
      }
    }, this.config.stepPeriodMs * factor);
  }

  private onStepTick() {
    this.stepCount += 1;
    let dy = this.randomInt(this.minDy, this.maxDy);
    // A fair coin for the direction, so the target random-walks rather than
    // drifting one way:
    if (this.randomInt(0, 1) === 0) dy = -dy;
    if (this.currentTargetY + dy < this.minY || this.currentTargetY + dy > this.maxY) dy = -dy;
    this.currentTargetY += dy;
    this.steppedThisColumn = true;
    // A step is what closes out the previous step response, so this is the moment a
    // newly analysable step response appears -- see the incremental analysis in main.
    this.onStep();
    this.emitState('recording');
  }

  private onSampleTick() {
    if (this.config.simulationMode !== 'none') {
      this.currentTrackerY = this.simulate(this.config.simulationMode);
    }
    this.xs.push(this.currentTargetY);
    this.ys.push(this.currentTrackerY);

    // The status carries a running clock, and this is the only timer that
    // fires often enough to move it -- the step response timer ticks once every few
    // seconds, which left the reading frozen between steps.
    this.emitState('recording');
  }

  /**
   * Plays the target through the identified system in place of a human hand,
   * using the discrete parameters derived in begin(). Same difference
   * equations the analysis reports, so what you see is literally the model it
   * printed, recursing on the tracker's own past output.
   */
  private simulate(mode: 'first' | 'second'): number {
    const n = this.xs.length;
    const past = this.ys;
    const fallback = this.currentTrackerY;

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
      const gain = 1 - 2 * p21 + pairProduct(p21, p22);
      return 2 * p21 * past[past.length - 1] - pairProduct(p21, p22) * past[past.length - 2] + gain * this.xs[n - d2];
    }
    return fallback;
  }

  /** Appends one column of history at the scroll rate (20 Hz by default). */
  private onScrollTick() {
    // No model line while recording: it gave you something to follow while
    // being measured. Replay draws the model, after the fact.
    this.history.push({
      target: this.currentTargetY,
      tracker: this.currentTrackerY,
      model: null,
      stepped: this.steppedThisColumn,
    });
    this.steppedThisColumn = false;

    this.trimHistory();
  }

  /** Keeps just enough history to fill the plot. */
  private trimHistory() {
    const cap = Math.ceil(VISIBLE_MS / this.config.scrollPeriodMs) + 2;
    const excess = this.history.length - cap;
    if (excess <= 0) return;
    this.history.splice(0, excess);
    this.historyDropped += excess;
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

    // Step dividers: where the target stepped, i.e. where one step response ends and
    // the next begins. The analysis splits the recording at exactly these
    // instants, so drawing them makes the unit of analysis visible.
    // Muted rather than axis grey: at axis contrast the dividers were easy
    // to miss entirely, and they are the unit the whole analysis works in.
    ctx.strokeStyle = this.palette.muted;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    const divider = (x: number) => {
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, pad + plotH);
      ctx.stroke();
    };
    for (let i = start; i < n; i++) {
      if (this.history[i].stepped) divider(xAt(i));
    }
    // And where the run began, until it scrolls off: the edge of the data,
    // which otherwise just stops in mid-air. Dotted and fainter, so it is not
    // read as one more step.
    if (this.historyDropped === 0 && xAt(0) >= 0) {
      ctx.strokeStyle = this.palette.axis;
      ctx.lineWidth = 1.5 * dpr;
      ctx.lineCap = 'round';
      ctx.setLineDash([0.1 * dpr, 4 * dpr]);
      divider(xAt(0));
      ctx.lineCap = 'butt';
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

    // Solid like the other two: the dashed lines on this plot mark steps and
    // the start of the run. Its green is dark enough to carry it on colour.
    series((f) => f.model, this.palette.model, 2, []);
    series((f) => f.target, this.palette.target, 2, []);
    series((f) => f.tracker, this.palette.you, 2, []);

    // A mark at the pen for each series: it says where each one is RIGHT NOW,
    // which a bare line end does not, and the shapes give the three series a
    // second channel besides hue. Drawn in the same order as the lines, so
    // your own trace sits on top where they coincide.
    const last = this.history[n - 1];
    const mark = (shape: 'square' | 'circle' | 'diamond', v: number | null, color: string) => {
      if (v === null) return;
      const x = anchorX;
      const y = yAt(v);
      const r = 4 * dpr;
      ctx.beginPath();
      if (shape === 'circle') ctx.arc(x, y, r, 0, 2 * Math.PI);
      else if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
      else {
        ctx.moveTo(x, y - r * 1.25);
        ctx.lineTo(x + r * 1.25, y);
        ctx.lineTo(x, y + r * 1.25);
        ctx.lineTo(x - r * 1.25, y);
        ctx.closePath();
      }
      // A ring in the surface colour keeps two marks legible where they
      // overlap, which they do every time the model agrees with you.
      ctx.strokeStyle = this.palette.surface;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fill();
    };

    mark('diamond', last.model, this.palette.model);
    mark('square', last.target, this.palette.target);
    mark('circle', last.tracker, this.palette.you);
  }
}
