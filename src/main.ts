import './style.css';
import {
  TrackingExperiment,
  dampingOf,
  type ExperimentConfig,
  type ExperimentState,
  type SimulationMode,
  type SimulationModel,
} from './ui/experiment';
import { plotFrequencyResponse, plotPoleLocations, plotTrialSparkline } from './ui/plotting';
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
const stageHint = $<HTMLParagraphElement>('stageHint');
const stageStop = $<HTMLDivElement>('stageStop');
const stopBtn = $<HTMLButtonElement>('stopBtn');
const recordBtn = $<HTMLButtonElement>('recordBtn');
const simulateBtn = $<HTMLButtonElement>('simulateBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const dataDialog = $<HTMLDialogElement>('dataDialog');
const dataBtn = $<HTMLButtonElement>('dataBtn');
const themeBtn = $<HTMLButtonElement>('themeBtn');
const paceGroup = $<HTMLDivElement>('paceGroup');
const legendModel = document.querySelector('.legend-model') as HTMLLIElement;

const readoutEl = $<HTMLDivElement>('readout');
const readoutSource = $<HTMLParagraphElement>('readoutSource');
const filmstripEl = $<HTMLDivElement>('filmstrip');
const inspectedLabel = $<HTMLSpanElement>('inspectedTrial');
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

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/* ------------------------------------------------------------ persistence */

const STORE_KEY = 'tracking-lab.settings';

interface StoredSettings {
  trialPeriodMs?: number;
  samplePeriodMs?: number;
  simulationMode?: string;
  showModel?: boolean;
  discretePoints?: boolean;
  theme?: 'light' | 'dark';
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
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'light' || theme === 'dark') stored.theme = theme;
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
  // Dark is the default, not the OS's preference: index.html ships with the
  // attribute already set so there is no flash of light before this runs, and
  // a stored choice overrides it either way.
  const theme = s.theme ?? 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  themeBtn.textContent = theme === 'dark' ? 'Light' : 'Dark';
  themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
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
  onGraphPress: promptToStop,
  onEnd: ({ xs, ys }) => {
    lastSamples = { xs, ys };
    displaySamples(xs, ys);
    saveDataBtn.disabled = xs.length === 0;
    syncAnalysis();
    // The 'finished' state is emitted BEFORE this callback, so the render that
    // went with it still saw the previous recording -- or none at all. Re-check
    // now that there is something to replay.
    updateActionAvailability();
  },
});

/**
 * How long the Stop prompt waits before withdrawing itself. Long enough to
 * read and act on, short enough that a misclick doesn't leave the plot dimmed
 * for the rest of a run.
 */
const STOP_PROMPT_MS = 4000;
let stopPromptHandle: ReturnType<typeof setTimeout> | null = null;
let stopFadeHandle: ReturnType<typeof setTimeout> | null = null;

/** A press on a running plot offers a Stop instead of taking one. */
function promptToStop() {
  if (!experiment.isActive()) return;
  if (!stageStop.hidden && stageStop.dataset.fading !== 'true') {
    // Pressed again while the prompt is up -- treat that as dismissing it.
    hideStopPrompt();
    return;
  }
  clearStopTimers();
  stageStop.hidden = false;
  stageStop.dataset.fading = 'false';
  stopBtn.focus();
  stopPromptHandle = setTimeout(() => {
    stageStop.dataset.fading = 'true';
    stopFadeHandle = setTimeout(() => {
      stageStop.hidden = true;
      stageStop.dataset.fading = 'false';
    }, 350);
  }, STOP_PROMPT_MS);
}

function clearStopTimers() {
  if (stopPromptHandle) clearTimeout(stopPromptHandle);
  if (stopFadeHandle) clearTimeout(stopFadeHandle);
  stopPromptHandle = stopFadeHandle = null;
}

function hideStopPrompt() {
  clearStopTimers();
  stageStop.hidden = true;
  stageStop.dataset.fading = 'false';
}

/* ------------------------------------------------------------ live state */

function renderState(state: ExperimentState) {
  const recording = state.phase === 'recording';
  const replaying = state.phase === 'replaying';
  const running = recording || replaying;

  // The actions are the plot's resting state; while something is running the
  // plot is the thing to look at, so they get out of the way.
  stageActions.hidden = running;
  stageHint.hidden = running;
  statusEl.dataset.recording = String(recording);
  updateActionAvailability();
  // A replay always draws the model line, whatever the recording-time setting.
  legendModel.hidden = !(replaying || (showModelCheckbox.checked && simulationModeSelect.value === 'none'));

  if (recording) {
    const secs = Math.floor(state.elapsedMs / 1000);
    statusEl.textContent = `Recording · ${state.steps} step${state.steps === 1 ? '' : 's'} · ${secs}s`;
  } else if (replaying) {
    statusEl.textContent = `Replaying with the model · ${Math.round(state.progress * 100)}%`;
  } else if (state.phase === 'finished') {
    if (state.samples > 0) statusEl.textContent = `Stopped · ${state.samples} samples`;
    stageHint.textContent = 'Record again, or Simulate to replay that run with the model beside it.';
    hideStopPrompt();
  } else {
    statusEl.textContent = 'Ready';
  }
}

/** Simulate needs something to replay, and nothing may run over a live run. */
function updateActionAvailability() {
  simulateBtn.disabled = experiment.isActive() || !lastSamples || lastSamples.xs.length < 2;
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
  const { xs, ys } = experiment.isActive() ? experiment.getSamples() : lastSamples ?? { xs: new Float64Array(), ys: new Float64Array() };
  if (xs.length === 0) return;

  const raw = parseTrials(xs, ys);
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

function resetAnalysis(samplePeriodMs: number) {
  trials = [];
  excluded.clear();
  inspected = 0;
  analysisSamplePeriodMs = samplePeriodMs;
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
    inspect.addEventListener('click', () => {
      inspected = i;
      renderFilmstrip();
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
      pushModelToSimulation();
      renderResults();
    });

    card.append(inspect, box);
    filmstripEl.appendChild(card);
    plotTrialSparkline(inspect.querySelector('canvas') as HTMLCanvasElement, t.trial.xn, t.trial.yn);
  });
}

function renderPlots() {
  const t = trials[inspected];
  if (!t) {
    inspectedLabel.textContent = '—';
    return;
  }
  inspectedLabel.textContent = String(inspected + 1);

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
  hideStopPrompt();
  // Record is about to be hidden. Leaving focus on it would both strand the
  // focus ring on a hidden element and swallow the space bar, which the
  // keydown handler ignores while a button has focus -- so the one key that
  // stops a run would stop working the moment you started one with a click.
  (document.activeElement as HTMLElement | null)?.blur();
  resetAnalysis(currentConfig().samplePeriodMs);
  experiment.begin();
}

recordBtn.addEventListener('click', startRecording);

// Simulate replays the run that is already on screen -- your target, your
// response, and the identified model's response to the same target. It is a
// playback, so nothing is recorded and the analysis is left alone.
simulateBtn.addEventListener('click', () => {
  if (!lastSamples || experiment.isActive()) return;
  hideStopPrompt();
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

// Same for the Stop prompt: anything other than Stop itself puts it away and
// leaves the run going -- the dimmed plot, or anywhere else on the page.
stageStop.addEventListener('click', (e) => {
  if (e.target !== stopBtn) hideStopPrompt();
});

document.addEventListener(
  'pointerdown',
  (e) => {
    if (stageStop.hidden) return;
    if (e.target === stopBtn || stageStop.contains(e.target as Node)) return;
    hideStopPrompt();
  },
  true,
);

stopBtn.addEventListener('click', () => {
  experiment.stop();
  hideStopPrompt();
});

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
    hideStopPrompt();
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

themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  themeBtn.textContent = dark ? 'Dark' : 'Light';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to dark theme' : 'Switch to light theme');
  experiment.refreshTheme();
  renderResults();
  saveSettings();
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
    resetAnalysis(currentConfig().samplePeriodMs);
    syncAnalysis();
    updateActionAvailability();
    statusEl.textContent = `Loaded ${xs.length} samples from ${file.name}`;
    stageHint.textContent = 'Simulate replays this recording with the model beside it.';
  } catch (err) {
    statusEl.textContent = (err as Error).message;
  }
});

syncPaceButtons();
legendModel.hidden = !(showModelCheckbox.checked && simulationModeSelect.value === 'none');
renderSimModelInfo();
renderResults();
