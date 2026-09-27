import './style.css';
import {
  TrackingExperiment,
  MAX_TRIALS,
  dampingOf,
  type ExperimentConfig,
  type ExperimentState,
  type SimulationMode,
  type SimulationModel,
} from './ui/experiment';
import {
  clearPlot,
  plotFrequencyResponse,
  plotPoleLocations,
  plotStepResponse,
  plotTrialSparkline,
  poleGeometry,
} from './ui/plotting';
import { simulateSecondOrder } from './engine/curveFit';
import { discretePoleToContinuous } from './engine/poleConversion';
import {
  analyzeTrial,
  aggregateTrials,
  secondOrderDifferenceEquation,
  dampingMetrics,
  firstOrderMagnitudeResponse,
  secondOrderMagnitudeResponse,
  type TrialAnalysis,
} from './engine/analysis';
import { parseTrials, padTrials, trialLeadIns } from './engine/trials';
import { dft } from './engine/dsp';
import { magnitudeOfComplex } from './engine/complex';
import { parseRecording, formatAllSamplesBlock } from './engine/dataFormat';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const graphCanvas = $<HTMLCanvasElement>('graph');
const stepGraph = $<HTMLCanvasElement>('stepGraph');
const poleReadout = $<HTMLParagraphElement>('poleReadout');
const poleResetBtn = $<HTMLButtonElement>('poleResetBtn');
const legendYou = $<HTMLSpanElement>('legendYou');
const statusEl = $<HTMLParagraphElement>('status');
const stageActions = $<HTMLDivElement>('stageActions');
const stageEl = $<HTMLElement>('stage');
const stageHint = $<HTMLUListElement>('stageHint');
const recordCallout = $<HTMLSpanElement>('recordCallout');
const replayCallout = $<HTMLSpanElement>('replayCallout');
const stageChrome = document.querySelector('.stage-chrome') as HTMLDivElement;
const runHint = $<HTMLUListElement>('runHint');
const stageFlash = $<HTMLParagraphElement>('stageFlash');
const recordBtn = $<HTMLButtonElement>('recordBtn');
const replayBtn = $<HTMLButtonElement>('replayBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const dataDialog = $<HTMLDialogElement>('dataDialog');
const dataBtn = $<HTMLButtonElement>('dataBtn');
const themeGroup = $<HTMLDivElement>('themeGroup');
const paceGroup = $<HTMLDivElement>('paceGroup');
const resetSettingsBtn = $<HTMLButtonElement>('resetSettingsBtn');
const legendModel = document.querySelector('.legend-model') as HTMLLIElement;

const readoutEl = $<HTMLDivElement>('readout');
const readoutSource = $<HTMLParagraphElement>('readoutSource');
const readoutHeading = $<HTMLHeadingElement>('readoutHeading');
const filmstripEl = $<HTMLDivElement>('filmstrip');
const trialDetailHeading = $<HTMLHeadingElement>('trialDetailHeading');
const freqGraph = $<HTMLCanvasElement>('freqGraph');
const poleGraph = $<HTMLCanvasElement>('poleGraph');

const saveDataBtn = $<HTMLButtonElement>('saveDataBtn');
const loadDataBtn = $<HTMLButtonElement>('loadDataBtn');
const fileInput = $<HTMLInputElement>('fileInput');
const samplesOut = $<HTMLTextAreaElement>('samplesOut');
const simModelInfo = $<HTMLParagraphElement>('simModelInfo');

const trialPeriodInput = $<HTMLInputElement>('trialPeriod');
const samplePeriodInput = $<HTMLInputElement>('samplePeriod');
const simulationModeSelect = $<HTMLSelectElement>('simulationMode');
const showModelCheckbox = $<HTMLInputElement>('showModel');
const discretePointsCheckbox = $<HTMLInputElement>('discretePoints');

/** The model the simulation and the readout report. See the note in analysis.ts. */
const SIM_SOURCE: 'mean' | 'median' = 'median';

/**
 * Identified trials for the recording on screen, in recording order. Built up
 * incrementally while recording (one trial identified per step, ~13 ms) and
 * all at once when a data file is loaded.
 */
let trials: TrialAnalysis[] = [];
/** A few samples from before each trial's step, so its thumbnail shows the step. */
let leadIns: ReturnType<typeof trialLeadIns> = [];
/** The lead-in is this fraction of the trial, and at least two samples. */
const LEAD_FRACTION = 0.1;
/** Trials the operator has taken out of the model. */
const excluded = new Set<number>();
let inspected = 0;
/**
 * While a run is live, the newest trial is selected as it arrives. Picking an
 * earlier one pins it, so trials landing mid-inspection do not yank it away;
 * picking the newest again resumes following.
 */
let followLatest = true;
let lastSamples: { xs: Float64Array; ys: Float64Array } | null = null;
let identifiedYet = false;
/** The sample period the trials on screen were identified at. */
let analysisSamplePeriodMs = 100;
let syncHandle: ReturnType<typeof setTimeout> | null = null;
/** A run has started but has not yet earned the right to clear the old one. */
let pendingReset = false;
let pendingSamplePeriodMs = 100;

/**
 * Who produced a run: you ('none' -- no model driving), or one of the models
 * via the self-test setting. Tracked twice, because they diverge: runMode is
 * the run in progress, analysisSource is the run the readout DESCRIBES. The
 * readout must follow the data, not the setting -- flip the setting back to
 * "You" after a model run and the model's numbers are still on screen.
 */
let runMode: SimulationMode = 'none';
let pendingSource: SimulationMode = 'none';
let analysisSource: SimulationMode = 'none';
/**
 * Who made the trace on the plot right now. The legend names the tracking
 * line after it, so a model run is never captioned "You". Set when a trace is
 * drawn -- recording, replaying, loading -- rather than read from the
 * setting, which may have changed since.
 */
let plotSource: SimulationMode = 'none';

const modelName = (m: SimulationMode) => (m === 'first' ? 'first-order model' : 'second-order model');

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/* ------------------------------------------------------------ persistence */

const STORE_KEY = 'tracking-lab.settings';

/** 'system' follows the OS; the other two pin the page regardless of it. */
type ThemeChoice = 'light' | 'dark' | 'system';
let themeChoice: ThemeChoice = 'system';

/** What the controls read with nothing stored, and what Reset restores. */
const DEFAULT_SETTINGS = {
  trialPeriodMs: 4000,
  samplePeriodMs: 100,
  simulationMode: 'none',
  showModel: false,
  discretePoints: false,
  theme: 'system' as ThemeChoice,
};

interface StoredSettings {
  trialPeriodMs?: number;
  samplePeriodMs?: number;
  showModel?: boolean;
  discretePoints?: boolean;
  theme?: ThemeChoice;
}

/**
 * Settings survive a reload, recordings do not. Every read and write is
 * guarded: localStorage throws outright in some privacy modes, and a page
 * that cannot remember your sample period should still run.
 */
function readSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredSettings) : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    const stored: StoredSettings = {
      trialPeriodMs: currentConfig().trialPeriodMs,
      samplePeriodMs: currentConfig().samplePeriodMs,
      showModel: showModelCheckbox.checked,
      discretePoints: discretePointsCheckbox.checked,
    };
    stored.theme = themeChoice;
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    /* nothing to do -- the app works fine without a memory */
  }
}

/** Applies stored settings to the controls, before anything reads them. */
function applyStoredSettings() {
  const s = readSettings();
  if (typeof s.trialPeriodMs === 'number') trialPeriodInput.value = String(clamp(s.trialPeriodMs, 1000, 10000));
  if (typeof s.samplePeriodMs === 'number') samplePeriodInput.value = String(clamp(s.samplePeriodMs, 50, 500));
  // The self-test mode is deliberately NOT restored. Left on a model, it
  // would make the next visit's Record a model run -- every session starts
  // with you tracking, and a self-test is something you choose each time.
  if (typeof s.showModel === 'boolean') showModelCheckbox.checked = s.showModel;
  if (typeof s.discretePoints === 'boolean') discretePointsCheckbox.checked = s.discretePoints;
  // Default to the OS preference. index.html therefore ships with NO
  // data-theme, so the prefers-color-scheme block styles the very first paint
  // and there is no flash before this runs.
  applyTheme(s.theme ?? DEFAULT_SETTINGS.theme);
}

/**
 * 'light' and 'dark' pin the page with data-theme. 'system' removes the
 * attribute and lets the prefers-color-scheme block in style.css decide,
 * which is why that block has to stay even though dark is the default.
 */
function applyTheme(choice: ThemeChoice) {
  themeChoice = choice;
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  for (const b of themeGroup.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.getAttribute('data-theme') === choice));
  }
}

applyStoredSettings();

function currentConfig(): ExperimentConfig {
  return {
    trialPeriodMs: clamp(Number(trialPeriodInput.value) || 4000, 1000, 10000),
    samplePeriodMs: clamp(Number(samplePeriodInput.value) || 100, 50, 500),
    scrollPeriodMs: 50,
    simulationMode: simulationModeSelect.value as SimulationMode,
    discretePoints: discretePointsCheckbox.checked,
    showModel: showModelCheckbox.checked,
  };
}

const experiment = new TrackingExperiment(graphCanvas, currentConfig(), {
  onState: renderState,
  onStep: scheduleSync,
  onGraphPress: stopRun,
  onTouchStart: startRecording,
  onEnd: ({ xs, ys }) => {
    // A run that captured nothing must not replace the recording that was
    // already loaded. Starting it cleared the trials, so rebuild them from the
    // recording that is being kept -- otherwise the app is left holding data
    // with no analysis of it.
    // Decide from THIS run's samples, not from pendingReset: a run can end
    // between its last trial closing and the sync that would have noticed,
    // and that run has still earned its keep.
    const produced = parseTrials(xs, ys).length > 0;
    if (produced) {
      if (pendingReset) clearAnalysis(pendingSamplePeriodMs, pendingSource);
      lastSamples = { xs, ys };
      displaySamples(xs, ys);
      saveDataBtn.disabled = false;
    } else {
      // Nothing analysable: throw the run away and keep what was on screen.
      pendingReset = false;
    }
    syncAnalysis();
    statusEl.textContent = produced
      ? `${runMode === 'none' ? 'Stopped' : 'Model run stopped'} · ${xs.length} samples · ${trialCount(trials.length)}`
      : xs.length < 2
        ? 'Stopped · nothing recorded'
        : 'Stopped · no complete trials';
    // The 'finished' state is emitted BEFORE this callback, so the render that
    // went with it still saw the previous recording -- or none at all. Re-check
    // now that there is something to replay.
    updateActionAvailability();
    // Announced from here rather than from renderState: only now are the
    // finished run's trials counted, and onEnd fires for recordings only, so
    // a replay never claims to have recorded anything.
    if (produced) flash(`${runMode === 'none' ? 'Recording finished' : 'Model run finished'} · ${trialCount(trials.length)}`);
    else if (xs.length < 2) flash('Nothing recorded');
    // Only claim to have kept something when there was something to keep.
    else flash(lastSamples ? 'No complete trials · previous recording kept' : 'No complete trials');
  },
});

/** How long the end-of-run message stays up before it starts fading. */
const FLASH_HOLD_MS = 2400;
let flashHoldHandle: ReturnType<typeof setTimeout> | null = null;
let flashHideHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Centres the message in the gap between the bottom of the legend/status
 * row and the top of the button column. Measured rather than set as a
 * percentage: the column's top edge moves with the plot's height, and at 25%
 * a short plot put the message across the Settings button.
 */
function placeFlash() {
  const stage = stageEl.getBoundingClientRect();
  const above = stageChrome.getBoundingClientRect().bottom;
  const below = settingsBtn.getBoundingClientRect().top;
  if (stageActions.hidden || below <= above) {
    stageFlash.style.top = '';
    return;
  }
  stageFlash.style.top = `${(above + below) / 2 - stage.top}px`;
}

/** Says one thing, big, across the plot, then fades itself out. */
function flash(message: string) {
  if (flashHoldHandle) clearTimeout(flashHoldHandle);
  if (flashHideHandle) clearTimeout(flashHideHandle);
  stageFlash.textContent = message;
  stageFlash.hidden = false;
  placeFlash();
  stageFlash.dataset.fading = 'false';
  flashHoldHandle = setTimeout(() => {
    stageFlash.dataset.fading = 'true';
    // Outlasts the 600ms opacity transition; under prefers-reduced-motion
    // there is no transition and this is simply when it disappears.
    flashHideHandle = setTimeout(() => (stageFlash.hidden = true), 650);
  }, FLASH_HOLD_MS);
}

/**
 * Takes the message down at once. It is news about the run that just ended,
 * so reaching for any of the buttons means it has been read -- and left up,
 * it would sit over the next run or the settings dialog.
 */
function dismissFlash() {
  if (flashHoldHandle) clearTimeout(flashHoldHandle);
  if (flashHideHandle) clearTimeout(flashHideHandle);
  flashHoldHandle = flashHideHandle = null;
  stageFlash.hidden = true;
}
// Capture phase, so it runs before a button's own handler opens a dialog or
// starts a run -- and on a press rather than the click, so it goes the moment
// the pointer comes down.
stageActions.addEventListener('pointerdown', dismissFlash, true);
stageActions.addEventListener('click', dismissFlash, true);

/**
 * A press on a running plot stops it. Nothing is confirmed: the space bar
 * does the same, and Record starts again. The cost is that a stray click on
 * the plot -- where your pointer already is while tracking -- ends the run.
 */
function stopRun() {
  if (experiment.isActive()) experiment.stop();
}

/* ------------------------------------------------------------ live state */

/** The phase of the previous render, so 'finished' knows what just ended. */
let previousPhase: ExperimentState['phase'] = 'idle';

function renderState(state: ExperimentState) {
  const recording = state.phase === 'recording';
  const replaying = state.phase === 'replaying';
  const running = recording || replaying;

  // The actions are the plot's resting state; while something is running the
  // plot is the thing to look at, so they get out of the way.
  stageActions.hidden = running;
  stageEl.dataset.resting = String(!running);
  stageHint.hidden = running;
  runHint.hidden = !running;
  if (recording && runMode !== 'none') {
    // Nothing for the hand to do: the model is the one tracking.
    setList(runHint, [
      `The ${modelName(runMode)} is tracking the target, not you`,
      touchFirst ? 'Tap the plot to stop the run' : 'Click the plot or press Space to stop',
    ]);
  } else if (recording) {
    setList(runHint, [
      touchFirst
        ? "Slide your finger up and down to match the target's height"
        : "Move your pointer up and down to match the target's height",
      touchFirst ? 'Lift your finger to stop recording' : 'Click the plot or press Space to stop',
    ]);
  } else if (replaying) {
    setList(runHint, [touchFirst ? 'Tap the plot to stop the replay' : 'Click the plot or press Space to stop']);
  }
  statusEl.dataset.recording = String(recording);
  updateActionAvailability();
  syncLegend();

  if (recording) {
    // `steps` counts target jumps, and the trial under way is the one that
    // began at the last jump -- so after three jumps you are recording the
    // third trial, and before the first there is nothing yet. The run stops
    // itself at the limit, so say what the limit is; the closing step starts
    // no new trial, so the count stops there.
    const which = state.steps === 0 ? 'no trials yet' : `trial ${Math.min(state.steps, MAX_TRIALS)} of ${MAX_TRIALS}`;
    const who = runMode === 'none' ? 'Recording' : `Model run (${runMode === 'first' ? 'first' : 'second'}-order)`;
    statusEl.textContent = `${who} · ${which} · ${elapsed(state.elapsedMs)}`;
  } else if (replaying) {
    // "with the model" was redundant -- the legend names the model line right
    // beside this -- and it was what pushed the label into an ellipsis.
    statusEl.textContent = `Replaying · ${Math.round(state.progress * 100)}% · ${elapsed(state.elapsedMs)}`;
  } else if (state.phase === 'finished') {
    // A finished RECORDING gets its line from onEnd instead, which runs a
    // moment later and is the only place the run's trials have been counted.
    if (previousPhase === 'replaying') statusEl.textContent = 'Replay finished';
    setGuide(
      touchFirst ? 'Hold Record or the plot to record again; lift to stop' : RECORD_AGAIN,
      'Replay shows that run again with the model overlaid',
    );
  } else {
    statusEl.textContent = 'Ready';
  }

  previousPhase = state.phase;
}

/**
 * Running time to a tenth of a second, switching to m:ss.s past a minute.
 * The tenth is why onSampleTick emits state: a whole-second reading updated
 * only on trial ticks looks stopped between steps.
 */
function elapsed(ms: number): string {
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const mins = Math.floor(total / 60);
  return `${mins}:${(total - mins * 60).toFixed(1).padStart(4, '0')}`;
}

/** The resting guide for Record once there is a run on screen to replace. */
const RECORD_AGAIN = 'Record starts a new run, replacing this one';

const trialCount = (n: number) => `${n} trial${n === 1 ? '' : 's'}`;

/**
 * True where the primary input cannot hover and is coarse -- a touchscreen.
 * The copy follows this, while the BEHAVIOUR follows each event's own
 * pointerType, so a hybrid machine reads touch wording and still works with
 * its mouse.
 */
const touchFirst = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Fills a hint list. Both plot hints are lists, so both go through here. */
function setList(list: HTMLUListElement, items: string[]) {
  list.innerHTML = '';
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

/**
 * The resting directions. A wide plot shows them as callouts beside their own
 * buttons, a narrow one as the list under the buttons; both are kept current
 * so a resize never shows stale text.
 */
function setGuide(record: string, replay: string) {
  recordCallout.textContent = record;
  replayCallout.textContent = replay;
  setList(stageHint, [record, replay]);
}

/**
 * The model's legend entry follows what is actually DRAWN. It used to follow
 * the mode instead, so the moment a replay ended the entry vanished while its
 * dashed line was still sitting on the plot.
 */
function syncLegend() {
  legendYou.textContent = plotSource === 'none' ? 'You' : 'Model (tracking)';
  const drawingModel = showModelCheckbox.checked && simulationModeSelect.value === 'none';
  legendModel.hidden = !(experiment.hasModelTrace() || experiment.getPhase() === 'replaying' || drawingModel);
}

/** Replay needs something to replay, and nothing may run over a live run. */
function updateActionAvailability() {
  const running = experiment.isActive();
  const hasRun = !!lastSamples && lastSamples.xs.length >= 2;
  replayBtn.setAttribute('aria-disabled', String(running || !hasRun));
  replayBtn.title = !hasRun
    ? 'Nothing to replay yet — record a run first, or open one from Recorded data'
    : running
      ? 'Available when this run stops'
      : "Replay the last run with the model's response to the same steps overlaid";
}

/**
 * A trial only becomes visible to parseTrials once a sample lands at the NEW
 * target value, so give the sampler a couple of ticks before re-splitting.
 */
function scheduleSync() {
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = setTimeout(syncAnalysis, currentConfig().samplePeriodMs * 2);
}

/**
 * Identifies whatever trials have completed but not yet been identified, then
 * redraws. Cheap enough to run mid-recording: each new trial costs one fit
 * (~13 ms), rather than re-identifying the whole recording every time.
 */
function syncAnalysis() {
  const live = experiment.isActive() && pendingReset;
  const { xs, ys } = experiment.isActive() ? experiment.getSamples() : lastSamples ?? { xs: new Float64Array(), ys: new Float64Array() };
  if (xs.length === 0) return;

  const raw = parseTrials(xs, ys);

  // The previous run stays on screen until this one has something to replace
  // it WITH. Pressing Record used to blank the readout instantly, so a run
  // that turned out to be a misfire took the last good analysis with it.
  if (live && raw.length > 0) clearAnalysis(pendingSamplePeriodMs, pendingSource);

  if (raw.length <= trials.length) {
    renderResults();
    return;
  }

  const longest = raw.reduce((m, t) => Math.max(m, t.xn.length), 0);
  leadIns = trialLeadIns(xs, ys, Math.max(2, Math.ceil(longest * LEAD_FRACTION)));
  const padded = padTrials(raw, 10);
  for (let i = trials.length; i < raw.length; i++) {
    trials.push(analyzeTrial(raw[i], padded[i], analysisSamplePeriodMs));
  }
  identifiedYet = true;
  if (experiment.isActive() && followLatest) inspected = trials.length - 1;
  pushModelToSimulation();
  renderResults();
  if (experiment.isActive() && followLatest) filmstripEl.scrollTo({ left: filmstripEl.scrollWidth });
}

/** Throws the current analysis away immediately. */
function clearAnalysis(samplePeriodMs: number, source: SimulationMode) {
  // Drop any sync the previous run had queued, so it cannot land on the state
  // this reset is establishing.
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = null;
  trials = [];
  leadIns = [];
  excluded.clear();
  inspected = 0;
  followLatest = true;
  analysisSamplePeriodMs = samplePeriodMs;
  analysisSource = source;
  pendingReset = false;
}

/**
 * Arms a reset for the next run without performing it. syncAnalysis carries
 * it out the moment that run produces its first trial, which is the first
 * moment there is anything to show in place of what is on screen.
 */
function armReset(samplePeriodMs: number, source: SimulationMode) {
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = null;
  pendingReset = true;
  pendingSamplePeriodMs = samplePeriodMs;
  pendingSource = source;
}

/* ------------------------------------------------------------- rendering */

function includedTrials(): TrialAnalysis[] {
  return trials.filter((_, i) => !excluded.has(i));
}

/**
 * Fit error as a percentage of the step that provoked it.
 *
 * Raw pixels are not comparable between trials: the step size is drawn from
 * LOGICAL_HEIGHT/15 .. LOGICAL_HEIGHT/5, a 3x range, so the same pixel error
 * is a good fit on a big step and a bad one on a small step. On the reference
 * recording trial 3 (9.1 px on a 39 px step) reads as better than trial 2
 * (11.0 px on 77 px) in pixels and far worse -- 23% against 14% -- once the
 * step is accounted for. A trial with no step to speak of has no scale to be
 * judged against at all.
 */
function errorPctOf(t: TrialAnalysis): number {
  return t.stepSize > 0 ? (t.fit2Rms / t.stepSize) * 100 : Infinity;
}

interface OutlierBounds {
  /** Fit far worse than its peers -- it did not measure the same system. */
  high: number;
  /**
   * Fit far BETTER than its peers, which is just as suspect: a human tracking
   * a step does not produce a 0.3% fit. It means the trial holds almost no
   * dynamics for the model to get wrong, so it contributes a confident number
   * about nothing. The reference recording has exactly one, 40x below the rest.
   */
  low: number;
}

function outlierBounds(): OutlierBounds {
  if (trials.length === 0) return { high: Infinity, low: 0 };
  const sorted = trials.map(errorPctOf).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { high: median * 3, low: median / 3 };
}

function outlierKindOf(t: TrialAnalysis, bounds: OutlierBounds): 'poor' | 'degenerate' | null {
  const pct = errorPctOf(t);
  if (pct > bounds.high) return 'poor';
  if (pct < bounds.low) return 'degenerate';
  return null;
}

function renderResults() {
  renderReadout();
  renderFilmstrip();
  renderPlots();
}

function pushModelToSimulation() {
  const included = includedTrials();
  if (included.length === 0) return;
  const agg = aggregateTrials(included, analysisSamplePeriodMs);
  const source = SIM_SOURCE === 'median' ? agg.medianContinuous : agg.averageContinuous;
  experiment.setSimulationModel({
    P11: source.P11,
    D1: source.D1,
    P21: source.P21,
    P22: source.P22,
    D2: source.D2,
  });
  renderSimModelInfo();
}

function tile(label: string, value: string, unit: string, note: string) {
  return (
    `<div class="tile"><p class="tile-label">${label}</p>` +
    `<p class="tile-value">${value}<span class="unit">${unit}</span></p>` +
    `<p class="tile-note">${note}</p></div>`
  );
}

function renderReadout() {
  // A model run must never be presented as yours: the heading names whose
  // system this is, taken from the data on screen rather than the setting.
  const byModel = analysisSource !== 'none' && trials.length > 0;
  readoutHeading.textContent = byModel
    ? `${modelName(analysisSource).replace(/^./, (c) => c.toUpperCase())} · self-test`
    : 'Your tracking system';
  readoutHeading.parentElement!.parentElement!.dataset.source = byModel ? 'model' : 'you';

  const included = includedTrials();
  if (included.length === 0) {
    readoutSource.textContent = trials.length === 0 ? 'No trials yet' : 'All trials excluded';
    readoutEl.innerHTML =
      trials.length === 0
        ? '<p class="empty">Record a few steps and your identified model appears here, updating as each trial completes.</p>'
        : '<p class="empty">Tick at least one trial to identify a model.</p>';
    return;
  }

  const agg = aggregateTrials(included, analysisSamplePeriodMs);
  const c = SIM_SOURCE === 'median' ? agg.medianContinuous : agg.averageContinuous;
  const d = SIM_SOURCE === 'median' ? agg.medianDiscrete : agg.averageDiscrete;
  const { wn, zeta, overshoot } = dampingMetrics(c);
  const character = zeta < 1 ? 'underdamped' : zeta === 1 ? 'critically damped' : 'overdamped';
  const tau = c.P11 === 0 ? Infinity : -1 / c.P11;

  const excludedCount = trials.length - included.length;
  readoutSource.textContent =
    `${SIM_SOURCE === 'median' ? 'Median' : 'Average'} of ${included.length} trial${included.length === 1 ? '' : 's'}` +
    (excludedCount > 0 ? ` · ${excludedCount} excluded` : '');

  // The lede is what the numbers MEAN about the person. 2% settling time of a
  // second-order system. It runs away as zeta -> 0, and a "settles in 740 s" note
  // is worse than no note at all, so a barely damped fit says so instead of quoting
  // a number nobody should believe.
  const settlingS = zeta > 0 && wn > 0 ? 4 / (zeta * wn) : Infinity;
  const settlingNote =
    settlingS <= 30 ? `settles in ~${settlingS.toFixed(1)} s` : 'settles too slowly to quote';

  const tiles =
    tile('Reaction delay', (c.D2 * 1000).toFixed(0), ' ms', 'before the response begins') +
    tile('Overshoot', overshoot.toFixed(0), ' %', 'past the target on the first swing') +
    tile('Damping ζ', zeta.toFixed(2), '', character) +
    tile('Natural frequency', wn.toFixed(2), ' rad/s', settlingNote);

  const verdict =
    `<p class="verdict">${byModel ? 'The model reacts' : 'You react'} after <strong>${(c.D2 * 1000).toFixed(0)} ms</strong>, ` +
    `then ${byModel ? 'closes' : 'close'} in on the target` +
    `${overshoot >= 1 ? `, overshooting by <strong>${overshoot.toFixed(0)}%</strong> before settling` : ' without overshooting'}.</p>`;

  const twoZetaWn = (2 * zeta * wn).toFixed(2);
  const continuous =
    `<section class="model"><h3 class="model-label">Continuous · derived from the fit</h3>` +
    `<div class="tf"><span class="tf-lhs">H(s) =</span>` +
    `<span class="frac"><span class="num">${wn.toFixed(2)}<sup>2</sup></span>` +
    `<span class="den">s<sup>2</sup> + ${twoZetaWn}s + ${wn.toFixed(2)}<sup>2</sup></span></span>` +
    `<span class="tf-delay">· e<sup>−${c.D2.toFixed(2)}s</sup></span></div></section>`;

  // The discrete model is what was actually FITTED -- the continuous one is
  // derived from it -- so it gets equal billing: its own H(z), and the
  // difference equation solved for y[n], the form you can run by hand and the
  // recursion the simulation executes. The engine's own string rides along in
  // a data attribute, so a test can hold the display to the engine exactly.
  const a1 = 2 * d.P21;
  const a2 = d.P21 ** 2 + d.P22 ** 2;
  const b0 = 1 - a1 + a2;
  const num = (v: number) => v.toFixed(3);
  const delay = Number.isInteger(d.D2) ? String(d.D2) : d.D2.toFixed(1);
  // U+202F joins a coefficient to its variable, so a wrapped equation breaks
  // between terms -- never between "0.153" and the x[n-7.5] it multiplies.
  // The sign is bound to its term too, so a wrap lands BEFORE the operator
  // and it leads the continuation line, as typeset maths does.
  const signed = (v: number, body: string) => `${v < 0 ? '−' : '+'} ${num(Math.abs(v))} ${body}`;
  const discrete =
    `<section class="model"><h3 class="model-label">Discrete · sampled every ${analysisSamplePeriodMs} ms</h3>` +
    `<div class="tf"><span class="tf-lhs">H(z) =</span>` +
    `<span class="frac"><span class="num">${num(b0)} <var>z</var><sup>−${delay}</sup></span>` +
    `<span class="den">1 ${signed(-a1, '<var>z</var><sup>−1</sup>')} ${signed(a2, '<var>z</var><sup>−2</sup>')}</span></span></div>` +
    `<p class="diffeq" data-equation="${secondOrderDifferenceEquation(d)}">` +
    `<var>y</var>[<var>n</var>] = ${num(a1)} <var>y</var>[<var>n</var>−1] ${signed(-a2, '<var>y</var>[<var>n</var>−2]')} ` +
    `${signed(b0, `<var>x</var>[<var>n</var>−${delay}]`)}</p></section>`;

  const details =
    `<p class="details-line">Best first-order fit: τ = ${tau.toFixed(3)} s, delay ${(c.D1 * 1000).toFixed(0)} ms</p>`;

  const bounds = outlierBounds();
  const poor = trials.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'poor').length;
  const degenerate = trials.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'degenerate').length;
  const notes: string[] = [];
  const trialsFit = (n: number) => `${n} trial${n === 1 ? ' fits' : 's fit'}`;
  if (poor > 0) notes.push(`${trialsFit(poor)} more than 3× worse than the median`);
  if (degenerate > 0) notes.push(`${trialsFit(degenerate)} more than 3× better than the median, likely too little movement to measure`);
  const flagged = poor + degenerate;
  const flag =
    notes.length > 0
      ? `<p class="flag">Relative to step size, ${notes.join('; ')}. ` +
        `${flagged === 1 ? "It's" : "They're"} marked ⚠ in Trials; untick ${flagged === 1 ? 'it' : 'one'} to see how much it moves the model.</p>`
      : '';

  readoutEl.innerHTML =
    `<div class="readout-row"><div class="tiles">${tiles}</div>` +
    `<div class="readout-text">${verdict}${continuous}${discrete}${details}${flag}</div></div>`;
}

/** Trial i's lead-in, trimmed to a tenth of that trial's own length. */
function leadOf(i: number) {
  const lead = leadIns[i];
  if (!lead) return undefined;
  const k = Math.max(2, Math.ceil(trials[i].trial.xn.length * LEAD_FRACTION));
  return { xn: lead.xn.subarray(-k), yn: lead.yn.subarray(-k) };
}

function renderFilmstrip() {
  if (trials.length === 0) {
    filmstripEl.innerHTML = '<p class="empty">Each completed step becomes a trial here.</p>';
    return;
  }

  const bounds = outlierBounds();

  // A rebuild still happens when trials arrive mid-run, and it can land while
  // someone is working through the strip, so put focus back where it was.
  const focused = document.activeElement as HTMLElement | null;
  const focusedCard = focused?.closest('.trial-card');
  const focusedIndex = focusedCard ? [...filmstripEl.children].indexOf(focusedCard) : -1;
  const focusedWasCheckbox = focused?.classList.contains('trial-include') ?? false;

  filmstripEl.innerHTML = '';

  trials.forEach((t, i) => {
    const { zeta } = dampingMetrics(t.continuous);
    const kind = outlierKindOf(t, bounds);
    const pct = errorPctOf(t);

    // The card holds two SIBLING controls: a checkbox that includes the trial
    // in the model, and a button that inspects it. They used to be one button
    // with the checkbox nested inside, which is invalid -- a button may not
    // contain interactive content -- and left the two fighting over clicks
    // and tab order.
    const card = document.createElement('div');
    card.className = 'trial-card';
    card.dataset.excluded = String(excluded.has(i));
    card.dataset.outlier = kind ?? '';

    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'trial-inspect';
    inspect.setAttribute('aria-pressed', String(i === inspected));
    inspect.innerHTML =
      `<span class="name">Trial ${i + 1}${kind ? ' ⚠' : ''}</span>` +
      `<canvas></canvas>` +
      `<span class="trial-stats"><span>ζ ${zeta.toFixed(2)}</span>` +
      `<span>${Number.isFinite(pct) ? `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}% err` : '—'}</span></span>`;
    inspect.title =
      `RMS ${t.fit2Rms.toFixed(1)} px on a ${t.stepSize.toFixed(0)} px step` +
      (kind === 'poor' ? ' — fits far worse than the other trials' : '') +
      (kind === 'degenerate' ? ' — fits far better than is plausible; little to measure here' : '');
    // Update in place rather than rebuilding the strip. A rebuild replaces the
    // very node being operated, which drops keyboard focus to the body -- so
    // excluding three trials in a row meant tabbing back in three times.
    inspect.addEventListener('click', () => {
      inspected = i;
      followLatest = i === trials.length - 1;
      for (const other of filmstripEl.querySelectorAll('.trial-inspect')) {
        other.setAttribute('aria-pressed', String(other === inspect));
      }
      renderPlots();
    });

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'trial-include';
    box.checked = !excluded.has(i);
    box.setAttribute('aria-label', `Include trial ${i + 1} in the model`);
    box.addEventListener('change', () => {
      if (box.checked) excluded.delete(i);
      else excluded.add(i);
      // Only this card's dimming and the summary above change: the outlier
      // marks come from outlierBounds(), which reads every trial regardless of
      // what is excluded. So no rebuild, and focus stays on the checkbox.
      card.dataset.excluded = String(excluded.has(i));
      pushModelToSimulation();
      renderReadout();
    });

    card.append(inspect, box);
    filmstripEl.appendChild(card);
    plotTrialSparkline(inspect.querySelector('canvas') as HTMLCanvasElement, t.trial.xn, t.trial.yn, leadOf(i));
  });

  if (focusedIndex >= 0) {
    const card = filmstripEl.children[focusedIndex] as HTMLElement | undefined;
    const target = card?.querySelector<HTMLElement>(focusedWasCheckbox ? '.trial-include' : '.trial-inspect');
    target?.focus();
  }
}

/** The trial the detail plots currently show, so they are not redrawn for nothing. */
let plottedTrial: TrialAnalysis | null = null;

/**
 * @param force redraw even if the same trial is already plotted -- needed
 *              after a theme change, which the canvases cannot inherit.
 */
function renderPlots(force = false) {
  const t = trials[inspected];
  if (!t) {
    // Canvases keep their last drawing, so returning early here is what left
    // a previous run's plots on screen under a "Trial Details" heading after
    // a run that produced no trials at all.
    trialDetailHeading.textContent = 'Trial details';
    if (plottedTrial) {
      clearPlot(stepGraph);
      clearPlot(freqGraph);
      clearPlot(poleGraph);
      plottedTrial = null;
    }
    poleReadout.textContent = '';
    poleResetBtn.hidden = true;
    return;
  }
  if (t === plottedTrial && !force) return;
  // A different trial starts from its own fit: a pole dragged on one trial
  // means nothing for the next.
  if (t !== plottedTrial) dragged = null;
  plottedTrial = t;
  trialDetailHeading.textContent = `Trial ${inspected + 1} details`;

  // Measured response: |H[k]| of the DFT of this trial's deconvolved h[n].
  // Computed once per trial -- a drag redraws many times a second and only
  // the model curves move.
  const Hk = dft(t.hn);
  const n = Hk.real.length;
  plottedSpectrum = new Float64Array(n);
  for (let i = 0; i < n; i++) plottedSpectrum[i] = magnitudeOfComplex(Hk.real[i], Hk.imag[i]);
  drawDetail();
}

/**
 * The pole pair being shown, when it has been dragged off the fit. Exploration
 * only: it redraws this trial's plots and never touches the identified model.
 */
let dragged: { p1: number; p2: number } | null = null;
let plottedSpectrum = new Float64Array();

/** Redraws the inspected trial's three plots for the current pole pair. */
function drawDetail() {
  const t = plottedTrial;
  if (!t) return;
  const fit = { p1: t.discrete.P21, p2: t.discrete.P22 };
  const pole = dragged ?? fit;
  const D = t.discrete.D2;
  const n = plottedSpectrum.length;

  plotFrequencyResponse(freqGraph, {
    sampled: plottedSpectrum,
    firstOrder: firstOrderMagnitudeResponse(t.discrete.P11, n),
    secondOrder: secondOrderMagnitudeResponse(pole.p1, pole.p2, n),
    secondOrderLabel: dragged ? '2nd-order (dragged)' : undefined,
  });
  plotPoleLocations(poleGraph, [pole], dragged ? fit : undefined);

  const model = simulateSecondOrder(t.trial.xn, pole.p1, pole.p2, D);
  // Led in from just before the step, as the thumbnails are, so the plot
  // shows the step and not just its aftermath. Before the step the models
  // sit at rest on the old target level, which is 0 in the trial's frame.
  const lead = leadOf(inspected);
  const k = lead ? lead.xn.length : 0;
  const withLead = (head: Float64Array | null, body: Float64Array) => {
    const out = new Float64Array(k + body.length);
    if (head) out.set(head);
    out.set(body, k);
    return out;
  };
  plotStepResponse(stepGraph, {
    target: withLead(lead?.xn ?? null, t.trial.xn),
    measured: withLead(lead?.yn ?? null, t.trial.yn),
    model: withLead(null, model),
    fit: dragged ? withLead(null, simulateSecondOrder(t.trial.xn, fit.p1, fit.p2, D)) : undefined,
    samplePeriodMs: analysisSamplePeriodMs,
    stepIndex: k,
  });

  // What the pole MEANS, and what it costs: the error is lowest at the fit,
  // which is the whole point of identification, and dragging lets you see it.
  const c = discretePoleToContinuous(pole.p1, pole.p2, analysisSamplePeriodMs / 1000);
  const { wn, zeta, overshoot } = dampingMetrics({ P11: 0, D1: 0, P21: c.cr, P22: c.ci, D2: 0 });
  let sq = 0;
  for (let i = 0; i < model.length; i++) sq += (t.trial.yn[i] - model[i]) ** 2;
  const errPct = t.stepSize > 0 ? (Math.sqrt(sq / model.length) / t.stepSize) * 100 : NaN;
  const errText = Number.isFinite(errPct) ? `${errPct < 10 ? errPct.toFixed(1) : errPct.toFixed(0)}% err` : '';
  poleReadout.textContent =
    `ζ ${zeta.toFixed(2)} · ωn ${wn.toFixed(2)} rad/s · ${overshoot.toFixed(0)}% overshoot` + (errText ? ` · ${errText}` : '');
  poleResetBtn.hidden = !dragged;
}

/** Keeps a pole pair strictly inside the unit circle, and on or above the axis. */
function clampPole(p1: number, p2: number) {
  const r = Math.hypot(p1, p2);
  const max = 0.995;
  if (r > max) {
    p1 *= max / r;
    p2 *= max / r;
  }
  return { p1, p2: Math.max(0, p2) };
}

/** The z-plane point under a pointer, folded onto the upper half-plane. */
function poleAt(e: PointerEvent) {
  const rect = poleGraph.getBoundingClientRect();
  const { cx, cy, r } = poleGeometry(rect.width, rect.height);
  return clampPole((e.clientX - rect.left - cx) / r, Math.abs(cy - (e.clientY - rect.top)) / r);
}

// Press anywhere on the plot to pick the pair up: the conjugate is its mirror,
// so a press below the axis grabs the same pair. Jumping to the press, rather
// than requiring a hit on the marker, makes it usable with a finger.
poleGraph.addEventListener('pointerdown', (e) => {
  if (!plottedTrial) return;
  poleGraph.setPointerCapture(e.pointerId);
  poleGraph.dataset.dragging = 'true';
  dragged = poleAt(e);
  drawDetail();
});
poleGraph.addEventListener('pointermove', (e) => {
  if (poleGraph.dataset.dragging !== 'true') return;
  dragged = poleAt(e);
  drawDetail();
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  poleGraph.addEventListener(type, () => (poleGraph.dataset.dragging = 'false'));
}
poleGraph.addEventListener('keydown', (e) => {
  if (!plottedTrial) return;
  if (e.key === 'Escape') {
    if (!dragged) return;
    dragged = null;
    drawDetail();
    e.preventDefault();
    return;
  }
  const step = e.shiftKey ? 0.05 : 0.01;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  const move = moves[e.key];
  if (!move) return;
  // Arrow keys would otherwise scroll the card, and the space bar is left
  // alone for starting and stopping runs.
  e.preventDefault();
  const from = dragged ?? { p1: plottedTrial.discrete.P21, p2: plottedTrial.discrete.P22 };
  dragged = clampPole(from.p1 + move[0], from.p2 + move[1]);
  drawDetail();
});
poleResetBtn.addEventListener('click', () => {
  dragged = null;
  drawDetail();
});

// A canvas's backing store is sized when it is drawn, so a plot that is not
// redrawn after a resize is stretched, soft and off its own pointer mapping.
// One frame's worth of resizes is batched into a single redraw.
let resizeFrame = 0;
const plotResizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawDetail);
});
for (const canvas of [stepGraph, freqGraph, poleGraph]) plotResizeObserver.observe(canvas);

/** Shows which system the simulation and the ghost trace play back. */
function renderSimModelInfo() {
  const model: SimulationModel = experiment.getSimulationModel();
  const { wn, zeta } = dampingOf(model);
  const character = zeta < 1 ? 'underdamped' : zeta === 1 ? 'critically damped' : 'overdamped';
  const overshoot = zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const source = identifiedYet ? 'your identified model' : 'built-in demo model; record a run to replace it';
  simModelInfo.textContent =
    `Model in use: ${source} — ωn ${wn.toFixed(2)} rad/s, ζ ${zeta.toFixed(2)} (${character}, ${overshoot.toFixed(0)}% overshoot)`;
}

function displaySamples(xs: Float64Array, ys: Float64Array) {
  const lines = ['n\tx[n]\ty[n]', '======================='];
  for (let i = 0; i < xs.length; i++) {
    lines.push(`${i}\t${xs[i].toFixed(3)}\t${ys[i].toFixed(3)}`);
  }
  samplesOut.value = lines.join('\n');
}

/* --------------------------------------------------------------- controls */

function startRecording() {
  if (experiment.isActive()) return;
  // Record is about to be hidden. Leaving focus on it would both strand the
  // focus ring on a hidden element and swallow the space bar, which the
  // keydown handler ignores while a button has focus -- so the one key that
  // stops a run would stop working the moment you started one with a click.
  (document.activeElement as HTMLElement | null)?.blur();
  // The space bar and a touch start runs without going near the buttons.
  dismissFlash();
  runMode = currentConfig().simulationMode;
  plotSource = runMode;
  armReset(currentConfig().samplePeriodMs, runMode);
  experiment.begin();
}

// A touch on Record holds a recording just as a touch on the plot does. It has
// to start on the PRESS: the click only arrives when the finger lifts, so a
// run started from it began at the very moment it should have ended, and then
// had no finger left on the glass to stop it.
let touchPressedRecord = false;
recordBtn.addEventListener('pointerdown', (e) => {
  touchPressedRecord = e.pointerType === 'touch';
  if (touchPressedRecord) experiment.holdToRecord(e);
});
// A held press is a long press, and Chrome answers those with a context menu.
for (const el of [recordBtn, graphCanvas]) el.addEventListener('contextmenu', (e) => e.preventDefault());
recordBtn.addEventListener('click', () => {
  // The click that trails a touch hold would otherwise start a second run.
  if (touchPressedRecord) {
    touchPressedRecord = false;
    return;
  }
  startRecording();
});

if (touchFirst) {
  setGuide('Hold Record or the plot to record; lift to stop', 'Replay shows the last run again with the model overlaid');
  $<HTMLParagraphElement>('trialDetailNote').textContent = 'Tap a trial to see its details';
}

// Replay plays back the run that is already on screen -- your target, your
// response, and the identified model's response to the same target. It is a
// playback, so nothing is recorded and the analysis is left alone.
replayBtn.addEventListener('click', () => {
  // aria-disabled does not block clicks the way disabled does, so refuse here.
  if (replayBtn.getAttribute('aria-disabled') === 'true') return;
  if (!lastSamples || experiment.isActive()) return;
  plotSource = analysisSource;
  experiment.startReplay(lastSamples.xs, lastSamples.ys);
});

settingsBtn.addEventListener('click', () => settingsDialog.showModal());
dataBtn.addEventListener('click', () => dataDialog.showModal());

/**
 * Click the backdrop to dismiss. A click on a dialog's ::backdrop is reported
 * against the dialog element itself, so the target check alone nearly does
 * it -- the rect test covers the dialog's own padding box, where the target
 * is also the dialog but the click is genuinely inside it.
 */
function closeOnBackdropClick(dialog: HTMLDialogElement) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
}

closeOnBackdropClick(settingsDialog);
closeOnBackdropClick(dataDialog);

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
  if (el instanceof HTMLButtonElement || el instanceof HTMLDetailsElement) return;
  // Space must not start a run behind an open modal.
  if (settingsDialog.open || dataDialog.open) return;
  e.preventDefault();
  // The space bar is an explicit instruction, unlike a press on the plot, so
  // it stops straight away instead of asking.
  if (experiment.isActive()) {
    experiment.stop();
  } else {
    startRecording();
  }
});

paceGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-pace]') as HTMLButtonElement | null;
  if (!btn) return;
  for (const b of paceGroup.querySelectorAll('button')) b.setAttribute('aria-checked', String(b === btn));
  trialPeriodInput.value = btn.dataset.pace!;
  experiment.updateConfig(currentConfig());
  saveSettings();
});

[trialPeriodInput, samplePeriodInput, simulationModeSelect, discretePointsCheckbox, showModelCheckbox].forEach((el) =>
  el.addEventListener('change', () => {
    experiment.updateConfig(currentConfig());
    syncPaceButtons();
    syncLegend();
    saveSettings();
  }),
);

function syncPaceButtons() {
  const ms = String(currentConfig().trialPeriodMs);
  for (const b of paceGroup.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.getAttribute('data-pace') === ms));
  }
}

/** Repaint everything a CSS colour change cannot reach: the canvases. */
function repaintForTheme() {
  experiment.refreshTheme();
  renderReadout();
  renderFilmstrip();
  renderPlots(true);
}

resetSettingsBtn.addEventListener('click', () => {
  trialPeriodInput.value = String(DEFAULT_SETTINGS.trialPeriodMs);
  samplePeriodInput.value = String(DEFAULT_SETTINGS.samplePeriodMs);
  simulationModeSelect.value = DEFAULT_SETTINGS.simulationMode;
  showModelCheckbox.checked = DEFAULT_SETTINGS.showModel;
  discretePointsCheckbox.checked = DEFAULT_SETTINGS.discretePoints;
  applyTheme(DEFAULT_SETTINGS.theme);

  experiment.updateConfig(currentConfig());
  syncPaceButtons();
  syncLegend();
  repaintForTheme();

  // Forget the stored settings outright rather than storing the defaults, so
  // a later change of default is picked up instead of being overridden by a
  // saved copy of the old one.
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing stored, nothing to forget */
  }
});

themeGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-theme]') as HTMLButtonElement | null;
  if (!btn) return;
  applyTheme(btn.dataset.theme as ThemeChoice);
  repaintForTheme();
  saveSettings();
});

// Under 'system' the page has no data-theme, so an OS flip restyles the CSS
// but leaves the canvases painted in the old palette until they are redrawn.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice === 'system') repaintForTheme();
});


// Export: the samples on show, as a download in the data file format.
saveDataBtn.addEventListener('click', () => {
  if (!lastSamples) return;
  const blob = new Blob([formatAllSamplesBlock(lastSamples.xs, lastSamples.ys)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `Pursuit Tracking Data ${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

loadDataBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const { xs, ys } = parseRecording(text);
    lastSamples = { xs, ys };
    displaySamples(xs, ys);
    saveDataBtn.disabled = false;
    clearAnalysis(currentConfig().samplePeriodMs, 'none');
    plotSource = 'none';
    syncLegend();
    syncAnalysis();
    updateActionAvailability();
    statusEl.textContent = `Loaded ${xs.length} samples from ${file.name}`;
    setGuide(touchFirst ? 'Hold Record or the plot to record; lift to stop' : RECORD_AGAIN, 'Replay shows this recording with the model overlaid');
  } catch (err) {
    statusEl.textContent = (err as Error).message;
  }
});

syncPaceButtons();
syncLegend();
renderSimModelInfo();
renderResults();
// Otherwise Replay starts life dimmed with no tooltip to explain why: the
// availability pass only runs on a state change, and none has happened yet.
updateActionAvailability();
