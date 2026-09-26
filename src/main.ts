import './style.css';
import {
  TrackingExperiment,
  dampingOf,
  type ExperimentConfig,
  type ExperimentState,
  type SimulationMode,
  type SimulationModel,
} from './ui/experiment';
import { clearPlot, plotFrequencyResponse, plotPoleLocations, plotTrialSparkline } from './ui/plotting';
import {
  analyzeTrial,
  aggregateTrials,
  secondOrderDifferenceEquation,
  dampingMetrics,
  firstOrderMagnitudeResponse,
  secondOrderMagnitudeResponse,
  type TrialAnalysis,
} from './engine/analysis';
import { parseTrials, padTrials } from './engine/trials';
import { dft } from './engine/dsp';
import { magnitudeOfComplex } from './engine/complex';
import { parseRecording, formatAllSamplesBlock } from './engine/dataFormat';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const graphCanvas = $<HTMLCanvasElement>('graph');
const statusEl = $<HTMLParagraphElement>('status');
const stageActions = $<HTMLDivElement>('stageActions');
const stageHint = $<HTMLUListElement>('stageHint');
const runHint = $<HTMLUListElement>('runHint');
const stageFlash = $<HTMLParagraphElement>('stageFlash');
const recordBtn = $<HTMLButtonElement>('recordBtn');
const simulateBtn = $<HTMLButtonElement>('simulateBtn');
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
/** Trials the operator has taken out of the model. */
const excluded = new Set<number>();
let inspected = 0;
let lastSamples: { xs: Float64Array; ys: Float64Array } | null = null;
let identifiedYet = false;
/** The sample period the trials on screen were identified at. */
let analysisSamplePeriodMs = 100;
let syncHandle: ReturnType<typeof setTimeout> | null = null;
/** A run has started but has not yet earned the right to clear the old one. */
let pendingReset = false;
let pendingSamplePeriodMs = 100;

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
  simulationMode?: string;
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
      simulationMode: simulationModeSelect.value,
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
  if (s.simulationMode && ['none', 'first', 'second'].includes(s.simulationMode)) {
    simulationModeSelect.value = s.simulationMode;
  }
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
      if (pendingReset) clearAnalysis(pendingSamplePeriodMs);
      lastSamples = { xs, ys };
      displaySamples(xs, ys);
      saveDataBtn.disabled = false;
    } else {
      // Nothing analysable: throw the run away and keep what was on screen.
      pendingReset = false;
    }
    syncAnalysis();
    statusEl.textContent = produced
      ? `Stopped - ${xs.length} samples - ${trialCount(trials.length)}`
      : xs.length < 2
        ? 'Stopped - nothing recorded'
        : 'Stopped - no complete trials';
    // The 'finished' state is emitted BEFORE this callback, so the render that
    // went with it still saw the previous recording -- or none at all. Re-check
    // now that there is something to replay.
    updateActionAvailability();
    // Announced from here rather than from renderState: only now are the
    // finished run's trials counted, and onEnd fires for recordings only, so
    // a replay never claims to have recorded anything.
    if (produced) flash(`Recording finished · ${trialCount(trials.length)}`);
    else if (xs.length < 2) flash('Nothing recorded');
    else flash('No complete trials · previous recording kept');
  },
});

/** How long the end-of-run message stays up before it starts fading. */
const FLASH_HOLD_MS = 2400;
let flashHoldHandle: ReturnType<typeof setTimeout> | null = null;
let flashHideHandle: ReturnType<typeof setTimeout> | null = null;

/** Says one thing, big, across the plot, then fades itself out. */
function flash(message: string) {
  if (flashHoldHandle) clearTimeout(flashHoldHandle);
  if (flashHideHandle) clearTimeout(flashHideHandle);
  stageFlash.textContent = message;
  stageFlash.hidden = false;
  stageFlash.dataset.fading = 'false';
  flashHoldHandle = setTimeout(() => {
    stageFlash.dataset.fading = 'true';
    // Outlasts the 600ms opacity transition; under prefers-reduced-motion
    // there is no transition and this is simply when it disappears.
    flashHideHandle = setTimeout(() => (stageFlash.hidden = true), 650);
  }, FLASH_HOLD_MS);
}

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
  stageHint.hidden = running;
  runHint.hidden = !running;
  if (recording) {
    setList(runHint, [
      touchFirst
        ? "Slide your finger up and down to match the target's height"
        : "Move your pointer up and down to match the target's height",
      touchFirst ? 'Lift your finger to stop recording' : 'Click anywhere to stop recording',
    ]);
  } else if (replaying) {
    setList(runHint, [touchFirst ? 'Tap to stop the replay' : 'Click anywhere to stop the replay']);
  }
  statusEl.dataset.recording = String(recording);
  updateActionAvailability();
  // A replay always draws the model line, whatever the recording-time setting.
  legendModel.hidden = !(replaying || (showModelCheckbox.checked && simulationModeSelect.value === 'none'));

  if (recording) {
    // `steps` counts target jumps, and the trial under way is the one that
    // began at the last jump -- so after three jumps you are recording the
    // third trial, and before the first there is nothing yet.
    const which = state.steps === 0 ? 'no trials yet' : `${ordinal(state.steps)} trial`;
    statusEl.textContent = `Recording - ${which} - ${elapsed(state.elapsedMs)}`;
  } else if (replaying) {
    // "with the model" was redundant -- the legend names the model line right
    // beside this -- and it was what pushed the label into an ellipsis.
    statusEl.textContent = `Replaying - ${Math.round(state.progress * 100)}% - ${elapsed(state.elapsedMs)}`;
  } else if (state.phase === 'finished') {
    // A finished RECORDING gets its line from onEnd instead, which runs a
    // moment later and is the only place the run's trials have been counted.
    if (previousPhase === 'replaying') statusEl.textContent = 'Replay ended';
    setHint([
      touchFirst ? 'Touch and hold the plot to record again' : 'Record again to start a new run',
      'Simulate replays that run with the model beside it',
    ]);
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

/** 1st, 2nd, 3rd, 4th ... */
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

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

const setHint = (items: string[]) => setList(stageHint, items);

/** Simulate needs something to replay, and nothing may run over a live run. */
function updateActionAvailability() {
  const running = experiment.isActive();
  const hasRun = !!lastSamples && lastSamples.xs.length >= 2;
  simulateBtn.setAttribute('aria-disabled', String(running || !hasRun));
  simulateBtn.title = !hasRun
    ? 'Nothing to replay yet — record a run first, or load a data file from Recorded data'
    : running
      ? 'Wait for the current run to finish'
      : "Replay that run with the identified model's response to the same target beside it";
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
  if (live && raw.length > 0) clearAnalysis(pendingSamplePeriodMs);

  if (raw.length <= trials.length) {
    renderResults();
    return;
  }

  const padded = padTrials(raw, 10);
  for (let i = trials.length; i < raw.length; i++) {
    trials.push(analyzeTrial(raw[i], padded[i], analysisSamplePeriodMs));
  }
  identifiedYet = true;
  pushModelToSimulation();
  renderResults();
}

/** Throws the current analysis away immediately. */
function clearAnalysis(samplePeriodMs: number) {
  // Drop any sync the previous run had queued, so it cannot land on the state
  // this reset is establishing.
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = null;
  trials = [];
  excluded.clear();
  inspected = 0;
  analysisSamplePeriodMs = samplePeriodMs;
  pendingReset = false;
}

/**
 * Arms a reset for the next run without performing it. syncAnalysis carries
 * it out the moment that run produces its first trial, which is the first
 * moment there is anything to show in place of what is on screen.
 */
function armReset(samplePeriodMs: number) {
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = null;
  pendingReset = true;
  pendingSamplePeriodMs = samplePeriodMs;
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
  const included = includedTrials();
  if (included.length === 0) {
    readoutSource.textContent = trials.length === 0 ? 'No trials yet' : 'Every trial excluded';
    readoutEl.innerHTML =
      '<p class="empty">Record a few steps and your identified model appears here, updating as each trial completes.</p>';
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
    `${SIM_SOURCE} of ${included.length} trial${included.length === 1 ? '' : 's'}` +
    (excludedCount > 0 ? ` · ${excludedCount} excluded` : '');

  // The lede is what the numbers MEAN about the person. 2% settling time of a
  // second-order system. It runs away as zeta -> 0, and a "settles in 740 s" note
  // is worse than no note at all, so a barely damped fit says so instead of quoting
  // a number nobody should believe.
  const settlingS = zeta > 0 && wn > 0 ? 4 / (zeta * wn) : Infinity;
  const settlingNote =
    settlingS <= 30 ? `settles in ~${settlingS.toFixed(1)} s` : 'too lightly damped to settle';

  const tiles =
    tile('Reaction delay', (c.D2 * 1000).toFixed(0), ' ms', 'before you move at all') +
    tile('Overshoot', overshoot.toFixed(0), ' %', 'past the target, first swing') +
    tile('Damping ζ', zeta.toFixed(2), '', character) +
    tile('Natural frequency', wn.toFixed(2), ' rad/s', settlingNote);

  const verdict =
    `<p class="verdict">You react after <strong>${(c.D2 * 1000).toFixed(0)} ms</strong>, then close on the target ` +
    `<strong>${character}</strong>${overshoot >= 1 ? `, overshooting by <strong>${overshoot.toFixed(0)}%</strong> before settling` : ''}.</p>`;

  const twoZetaWn = (2 * zeta * wn).toFixed(2);
  const tf =
    `<div class="tf"><span class="tf-lhs">H(s) =</span>` +
    `<span class="frac"><span class="num">${wn.toFixed(2)}<sup>2</sup></span>` +
    `<span class="den">s<sup>2</sup> + ${twoZetaWn}s + ${wn.toFixed(2)}<sup>2</sup></span></span>` +
    `<span class="tf-delay">· e<sup>−${c.D2.toFixed(2)}s</sup></span></div>`;

  const details =
    `<p class="details-line">Discrete: <code>${secondOrderDifferenceEquation(d)}</code><br />` +
    `First-order equivalent: τ = ${tau.toFixed(3)} s, delay ${(c.D1 * 1000).toFixed(0)} ms</p>`;

  const bounds = outlierBounds();
  const poor = trials.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'poor').length;
  const degenerate = trials.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'degenerate').length;
  const notes: string[] = [];
  if (poor > 0) notes.push(`${poor} fit${poor === 1 ? 's' : ''} more than 3× worse than the rest`);
  if (degenerate > 0) {
    notes.push(`${degenerate} fit${degenerate === 1 ? 's' : ''} more than 3× better, which means there was little in ${degenerate === 1 ? 'it' : 'them'} to get wrong`);
  }
  const flag =
    notes.length > 0
      ? `<p class="flag">Measured against the size of each step: ${notes.join('; ')}. ` +
        `They are marked in Trials — untick one to see how much it was pulling this model.</p>`
      : '';

  readoutEl.innerHTML =
    `<div class="readout-row"><div class="tiles">${tiles}</div>` +
    `<div class="readout-text">${verdict}${tf}${details}${flag}</div></div>`;
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
      `<span>${Number.isFinite(pct) ? `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%` : '—'}</span></span>`;
    inspect.title =
      `RMS ${t.fit2Rms.toFixed(1)} px on a ${t.stepSize.toFixed(0)} px step` +
      (kind === 'poor' ? ' — fits far worse than the other trials' : '') +
      (kind === 'degenerate' ? ' — fits far better than is plausible; little to measure here' : '');
    // Update in place rather than rebuilding the strip. A rebuild replaces the
    // very node being operated, which drops keyboard focus to the body -- so
    // excluding three trials in a row meant tabbing back in three times.
    inspect.addEventListener('click', () => {
      inspected = i;
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
    plotTrialSparkline(inspect.querySelector('canvas') as HTMLCanvasElement, t.trial.xn, t.trial.yn);
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
    trialDetailHeading.textContent = 'Trial Details';
    if (plottedTrial) {
      clearPlot(freqGraph);
      clearPlot(poleGraph);
      plottedTrial = null;
    }
    return;
  }
  if (t === plottedTrial && !force) return;
  plottedTrial = t;
  trialDetailHeading.textContent = `Trial ${inspected + 1} Details`;

  // Measured response: |H[k]| of the DFT of this trial's deconvolved h[n].
  const Hk = dft(t.hn);
  const n = Hk.real.length;
  const sampled = new Float64Array(n);
  for (let i = 0; i < n; i++) sampled[i] = magnitudeOfComplex(Hk.real[i], Hk.imag[i]);

  plotFrequencyResponse(freqGraph, {
    sampled,
    firstOrder: firstOrderMagnitudeResponse(t.discrete.P11, n),
    secondOrder: secondOrderMagnitudeResponse(t.discrete.P21, t.discrete.P22, n),
  });
  plotPoleLocations(poleGraph, [{ p1: t.discrete.P21, p2: t.discrete.P22 }]);
}

/** Shows which system the simulation and the ghost trace play back. */
function renderSimModelInfo() {
  const model: SimulationModel = experiment.getSimulationModel();
  const { wn, zeta } = dampingOf(model);
  const character = zeta < 1 ? 'underdamped' : zeta === 1 ? 'critically damped' : 'overdamped';
  const overshoot = zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const source = identifiedYet ? 'your identified model' : 'built-in demo model (records a run to replace it)';
  simModelInfo.textContent =
    `Simulating: ${source} — ωn ${wn.toFixed(2)} rad/s, ζ ${zeta.toFixed(3)} (${character}, ${overshoot.toFixed(0)}% overshoot)`;
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
  armReset(currentConfig().samplePeriodMs);
  experiment.begin();
}

recordBtn.addEventListener('click', startRecording);

if (touchFirst) {
  setHint([
    'Touch and hold the plot to record; lift to stop',
    'Simulate replays your last run with the model beside it',
  ]);
  recordBtn.title = 'Record a new run — or just touch and hold the plot';
}

// Simulate replays the run that is already on screen -- your target, your
// response, and the identified model's response to the same target. It is a
// playback, so nothing is recorded and the analysis is left alone.
simulateBtn.addEventListener('click', () => {
  // aria-disabled does not block clicks the way disabled does, so refuse here.
  if (simulateBtn.getAttribute('aria-disabled') === 'true') return;
  if (!lastSamples || experiment.isActive()) return;
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
    legendModel.hidden = !(showModelCheckbox.checked && simulationModeSelect.value === 'none');
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
  legendModel.hidden = !(showModelCheckbox.checked && simulationModeSelect.value === 'none');
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
    clearAnalysis(currentConfig().samplePeriodMs);
    syncAnalysis();
    updateActionAvailability();
    statusEl.textContent = `Loaded ${xs.length} samples from ${file.name}`;
    setHint(['Simulate replays this recording with the model beside it', 'Record starts a new run of your own']);
  } catch (err) {
    statusEl.textContent = (err as Error).message;
  }
});

syncPaceButtons();
legendModel.hidden = !(showModelCheckbox.checked && simulationModeSelect.value === 'none');
renderSimModelInfo();
renderResults();
// Otherwise Simulate starts life dimmed with no tooltip to explain why: the
// availability pass only runs on a state change, and none has happened yet.
updateActionAvailability();
