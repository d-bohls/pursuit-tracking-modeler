import './style.css';
import {
  TrackingExperiment,
  MAX_RESPONSES,
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
  plotResponseSparkline,
  poleGeometry,
} from './ui/plotting';
import { simulateSecondOrder } from './engine/curveFit';
import {
  addSession,
  deleteSession,
  findByHash,
  getSession,
  hashSamples,
  listSessions,
  updateSession,
  type Session,
  type SessionSummary,
} from './ui/sessions';
import { discretePairToContinuous, pairProduct } from './engine/poleConversion';
import {
  analyzeStepResponse,
  aggregateResponses,
  secondOrderDifferenceEquation,
  dampingMetrics,
  dampingCharacter,
  firstOrderMagnitudeResponse,
  secondOrderMagnitudeResponse,
  type StepResponseAnalysis,
} from './engine/analysis';
import { splitStepResponses, padResponses, responseLeadIns } from './engine/stepResponses';
import { dft } from './engine/dsp';
import { magnitudeOfComplex } from './engine/complex';
import { parseSessionFile, formatAllSamplesBlock } from './engine/dataFormat';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const graphCanvas = $<HTMLCanvasElement>('graph');
const stepGraph = $<HTMLCanvasElement>('stepGraph');
const poleReadout = $<HTMLParagraphElement>('poleReadout');
const poleResetBtn = $<HTMLButtonElement>('poleResetBtn');
const detailLegend = $<HTMLUListElement>('detailLegend');
const keyModel = $<HTMLSpanElement>('keyModel');
const keyFit = $<HTMLLIElement>('keyFit');
const legendYou = $<HTMLSpanElement>('legendYou');
const statusEl = $<HTMLParagraphElement>('status');
const stageActions = $<HTMLDivElement>('stageActions');
const stageEl = $<HTMLElement>('stage');
const stageChrome = document.querySelector('.stage-chrome') as HTMLDivElement;
const stageGuide = $<HTMLUListElement>('stageGuide');
const stageFlash = $<HTMLParagraphElement>('stageFlash');
const recordBtn = $<HTMLButtonElement>('recordBtn');
const replayBtn = $<HTMLButtonElement>('replayBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const SETTINGS_TITLE = settingsBtn.title;
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const sessionsDialog = $<HTMLDialogElement>('sessionsDialog');
const sessionsBtn = $<HTMLButtonElement>('sessionsBtn');
const themeGroup = $<HTMLDivElement>('themeGroup');
const paceGroup = $<HTMLDivElement>('paceGroup');
const resetSettingsBtn = $<HTMLButtonElement>('resetSettingsBtn');
const legendModel = document.querySelector('.legend-model') as HTMLLIElement;

const readoutEl = $<HTMLDivElement>('readout');
const readoutSource = $<HTMLParagraphElement>('readoutSource');
const readoutHeading = $<HTMLHeadingElement>('readoutHeading');
const filmstripEl = $<HTMLDivElement>('filmstrip');
const responseDetailHeading = $<HTMLHeadingElement>('responseDetailHeading');
const freqGraph = $<HTMLCanvasElement>('freqGraph');
const poleGraph = $<HTMLCanvasElement>('poleGraph');

const saveDataBtn = $<HTMLButtonElement>('saveDataBtn');
const loadDataBtn = $<HTMLButtonElement>('loadDataBtn');
const fileInput = $<HTMLInputElement>('fileInput');
const samplesOut = $<HTMLTextAreaElement>('samplesOut');
const samplesDialog = $<HTMLDialogElement>('samplesDialog');
const samplesTitle = $<HTMLHeadingElement>('samplesTitle');
const samplesMeta = $<HTMLParagraphElement>('samplesMeta');
const sessionList = $<HTMLUListElement>('sessionList');
const sessionsEmpty = $<HTMLParagraphElement>('sessionsEmpty');
const sessionsUnavailable = $<HTMLParagraphElement>('sessionsUnavailable');
const simModelInfo = $<HTMLParagraphElement>('simModelInfo');

const stepPeriodInput = $<HTMLInputElement>('stepPeriod');
const stepPeriodOut = $<HTMLOutputElement>('stepPeriodOut');
const samplePeriodInput = $<HTMLInputElement>('samplePeriod');
const simulationModeSelect = $<HTMLSelectElement>('simulationMode');
const discretePointsCheckbox = $<HTMLInputElement>('discretePoints');

/** The model the simulation and the readout report. See the note in analysis.ts. */
const SIM_SOURCE: 'mean' | 'median' = 'median';

/**
 * Identified step responses for the session on screen, in recording order. Built up
 * incrementally while recording (one step response identified per step, ~13 ms) and
 * all at once when a data file is loaded.
 */
let responses: StepResponseAnalysis[] = [];
/** The stored session on screen, which notes and unticked step responses are saved to. */
let currentSessionId: number | null = null;
const sessionNameEl = $<HTMLSpanElement>('sessionName');
const sessionSepEl = $<HTMLSpanElement>('sessionSep');
const sessionNameInput = $<HTMLInputElement>('sessionNameInput');

/**
 * Which recording is open, remembered so a reload reopens THAT one rather
 * than whichever is newest. Browser storage: losing it only means the newest
 * is reopened instead, so a failure is ignored.
 */
const OPEN_KEY = 'pursuit-tracking-modeler.openSession';
function rememberOpen(id: number | null) {
  try {
    if (id === null) localStorage.removeItem(OPEN_KEY);
    else localStorage.setItem(OPEN_KEY, String(id));
  } catch {
    /* the newest is reopened instead */
  }
}
function rememberedOpen(): number | null {
  try {
    const id = Number(localStorage.getItem(OPEN_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Shows which session the step responses belong to, in the heading over the step responses. An empty
 * name leaves it as plain "Session": nothing is kept yet, or the
 * step responses on screen belong to a run still in progress.
 */
function setSessionName(name: string) {
  cancelRename();
  sessionSepEl.hidden = sessionNameEl.hidden = !name;
  sessionNameEl.textContent = name;
  sessionNameEl.title = name ? `${name} — click to rename` : '';
  sessionNameEl.parentElement!.title = name ? `Session · ${name}` : '';
}

/*
 * Renaming in place: the name in the heading turns into a field. What you
 * type is the session's note -- the same one the Sessions list edits --
 * and clearing it falls back to the file name or the time, shown as the
 * placeholder so you can see what you would get.
 */
let renaming: { id: number; session: Session } | null = null;

async function startRename() {
  const id = currentSessionId;
  if (id === null || renaming) return;
  const session = await safely(() => getSession(id));
  if (!session || id !== currentSessionId) return;
  renaming = { id, session };
  sessionNameInput.value = session.note;
  sessionNameInput.placeholder = sessionName({ ...session, note: '' });
  sessionNameEl.hidden = true;
  sessionNameInput.hidden = false;
  sessionNameInput.focus();
  sessionNameInput.select();
}

function endRename() {
  renaming = null;
  sessionNameInput.hidden = true;
  sessionNameEl.hidden = sessionNameEl.textContent === '';
}

function cancelRename() {
  if (renaming) endRename();
}

function commitRename() {
  if (!renaming) return;
  const { id, session } = renaming;
  endRename();
  const note = sessionNameInput.value.trim();
  if (note === session.note) return;
  session.note = note;
  void safely(() => updateSession(id, { note }));
  if (id === currentSessionId) setSessionName(sessionName(session));
}

sessionNameEl.addEventListener('click', () => void startRename());
sessionNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    // Space would otherwise reach the page's handler and start a run.
    e.stopPropagation();
    void startRename();
  }
});
sessionNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRename();
    sessionNameEl.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelRename();
    sessionNameEl.focus();
  }
});
sessionNameInput.addEventListener('blur', commitRename);

/** Your note if you wrote one, else the file it came from, else when it was made. */
function sessionName(session: { note: string; fileName?: string; createdAt: number }): string {
  return session.note.trim() || session.fileName || whenLabel(session.createdAt);
}

/** A few samples from before each step response's step, so its thumbnail shows the step. */
let leadIns: ReturnType<typeof responseLeadIns> = [];
/** The lead-in is this fraction of the step response, and at least two samples. */
const LEAD_FRACTION = 0.1;
/** Step responses the operator has taken out of the model. */
const excluded = new Set<number>();
let inspected = 0;
/**
 * While a run is live, the newest step response is selected as it arrives. Picking an
 * earlier one pins it, so step responses landing mid-inspection do not yank it away;
 * picking the newest again resumes following.
 */
let followLatest = true;
/** The samples on screen, and the period they were recorded at -- which paces a replay. */
let lastSamples: { xs: Float64Array; ys: Float64Array; samplePeriodMs: number } | null = null;
let identifiedYet = false;
/** The sample period the step responses on screen were identified at. */
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

const STORE_KEY = 'pursuit-tracking-modeler.settings';

/** 'system' follows the OS; the other two pin the page regardless of it. */
type ThemeChoice = 'light' | 'dark' | 'system';
let themeChoice: ThemeChoice = 'system';

/** What the controls read with nothing stored, and what Reset restores. */
const DEFAULT_SETTINGS = {
  stepPeriodMs: 4000,
  samplePeriodMs: 100,
  simulationMode: 'none',
  discretePoints: false,
  theme: 'system' as ThemeChoice,
};

interface StoredSettings {
  stepPeriodMs?: number;
  samplePeriodMs?: number;
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
      stepPeriodMs: currentConfig().stepPeriodMs,
      samplePeriodMs: currentConfig().samplePeriodMs,
      discretePoints: discretePointsCheckbox.checked,
    };
    stored.theme = themeChoice;
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    /* nothing to do -- the app works fine without a memory */
  }
}

// The self-test lets a model do the tracking. It is for testing the pipeline,
// not for use, so its controls only appear when the page is opened with
// ?selftest.
$<HTMLDetailsElement>('advancedSettings').hidden = !new URLSearchParams(location.search).has('selftest');

/** Applies stored settings to the controls, before anything reads them. */
function applyStoredSettings() {
  const s = readSettings();
  if (typeof s.stepPeriodMs === 'number') stepPeriodInput.value = String(clamp(s.stepPeriodMs, 1000, 10000) / 1000);
  if (typeof s.samplePeriodMs === 'number') samplePeriodInput.value = String(clamp(s.samplePeriodMs, 50, 500));
  // The self-test mode is deliberately NOT restored. Left on a model, it
  // would make the next visit's Record a model run -- every session starts
  // with you tracking, and a self-test is something you choose each time.
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
    // The slider is in seconds, like the scale marked under it.
    stepPeriodMs: clamp(Math.round((Number(stepPeriodInput.value) || 4) * 1000), 1000, 10000),
    samplePeriodMs: clamp(Number(samplePeriodInput.value) || 100, 50, 500),
    scrollPeriodMs: 50,
    simulationMode: simulationModeSelect.value as SimulationMode,
    discretePoints: discretePointsCheckbox.checked,
  };
}

const experiment = new TrackingExperiment(graphCanvas, currentConfig(), {
  onState: renderState,
  onStep: scheduleSync,
  onGraphPress: stopRun,
  onTouchStart: startRecording,
  onEnd: ({ xs, ys }) => {
    // A run that captured nothing must not replace the session that was
    // already loaded. Starting it cleared the step responses, so rebuild them from the
    // recording that is being kept -- otherwise the app is left holding data
    // with no analysis of it.
    // Decide from THIS run's samples, not from pendingReset: a run can end
    // between its last step response closing and the sync that would have noticed,
    // and that run has still earned its keep.
    const produced = splitStepResponses(xs, ys).length > 0;
    if (produced) {
      if (pendingReset) clearAnalysis(pendingSamplePeriodMs, pendingSource);
      lastSamples = { xs, ys, samplePeriodMs: analysisSamplePeriodMs };
    } else {
      // Nothing analysable: throw the run away and keep what was on screen.
      pendingReset = false;
    }
    syncAnalysis();
    if (produced) void keepSession(xs, ys, runMode, analysisSamplePeriodMs);
    statusEl.textContent = produced
      ? `${runMode === 'none' ? 'Stopped' : 'Model run stopped'} · ${xs.length} samples · ${responseCount(responses.length)}`
      : xs.length < 2
        ? 'Stopped · nothing recorded'
        : 'Stopped · no complete step responses';
    // The 'finished' state is emitted BEFORE this callback, so the render that
    // went with it still saw the previous recording -- or none at all. Re-check
    // now that there is something to replay.
    updateActionAvailability();
    renderGuide('finished');
    // Announced from here rather than from renderState: only now are the
    // finished run's step responses counted, and onEnd fires for recordings only, so
    // a replay never claims to have recorded anything.
    if (produced) flash(`${runMode === 'none' ? 'Session recorded' : 'Model run finished'} · ${responseCount(responses.length)}`);
    else if (xs.length < 2) flash('Nothing recorded');
    // Only claim to have kept something when there was something to keep.
    else flash(lastSamples ? 'No complete step responses · previous session kept' : 'No complete step responses');
  },
});

/**
 * Centres the message in the gap between the bottom of the legend/status
 * row and the top of the button column. Measured rather than set as a
 * percentage: the column's top edge moves with the plot's height, and at 25%
 * a short plot put the message across the top button.
 */
function placeFlash() {
  const stage = stageEl.getBoundingClientRect();
  const above = stageChrome.getBoundingClientRect().bottom;
  const below = recordBtn.getBoundingClientRect().top;
  if (stageActions.hidden || below <= above) {
    stageFlash.style.top = '';
    return;
  }
  stageFlash.style.top = `${(above + below) / 2 - stage.top}px`;
}

/** The end-of-run result, across the plot, until something moves on from it. */
function flash(message: string) {
  stageFlash.textContent = message;
  stageFlash.hidden = false;
  placeFlash();
}
/**
 * At rest the help sits centred in the gap between the bottom of Replay and
 * the bottom of the plot. While a run is going the buttons are gone and the
 * stylesheet keeps it at the foot of the plot.
 */
function placeGuide() {
  if (stageActions.hidden) {
    stageGuide.style.top = stageGuide.style.bottom = stageGuide.style.transform = '';
    return;
  }
  const stage = stageEl.getBoundingClientRect();
  const above = replayBtn.getBoundingClientRect().bottom;
  stageGuide.style.top = `${(above + stage.bottom) / 2 - stage.top}px`;
  stageGuide.style.bottom = 'auto';
  stageGuide.style.transform = 'translate(-50%, -50%)';
}

// Both follow the layout: the gaps they are centred in move whenever the plot
// changes size.
new ResizeObserver(() => {
  if (!stageFlash.hidden) placeFlash();
  placeGuide();
}).observe(stageEl);

/**
 * Takes the message down. It is news about the run that just ended, so it
 * stays until something moves on from that run: a button is reached for, a
 * run starts, or another session is opened in its place.
 */
function dismissFlash() {
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
  renderGuide(state.phase);
  statusEl.dataset.recording = String(recording);
  updateActionAvailability();
  syncLegend();

  if (recording) {
    // `steps` counts target jumps, and the step response under way is the one that
    // began at the last jump -- so after three jumps you are recording the
    // third step response, and before the first there is nothing yet. The run stops
    // itself at the limit, so say what the limit is; the closing step starts
    // no new step response, so the count stops there.
    const which = state.steps === 0 ? 'no steps yet' : `step ${Math.min(state.steps, MAX_RESPONSES)} of ${MAX_RESPONSES}`;
    const who = runMode === 'none' ? 'Recording' : `Model run (${runMode === 'first' ? 'first' : 'second'}-order)`;
    statusEl.textContent = `${who} · ${which} · ${elapsed(state.elapsedMs)}`;
  } else if (replaying) {
    // "with the model" was redundant -- the legend names the model line right
    // beside this -- and it was what pushed the label into an ellipsis.
    statusEl.textContent = `Replaying · ${Math.round(state.progress * 100)}% · ${elapsed(state.elapsedMs)}`;
  } else if (state.phase === 'finished') {
    // A finished RECORDING gets its line from onEnd instead, which runs a
    // moment later and is the only place the run's step responses have been counted.
    if (previousPhase === 'replaying') statusEl.textContent = 'Replay finished';
  } else {
    statusEl.textContent = 'Ready';
  }

  previousPhase = state.phase;
}

/**
 * Running time to a tenth of a second, switching to m:ss.s past a minute.
 * The tenth is why onSampleTick emits state: a whole-second reading updated
 * only on step response ticks looks stopped between steps.
 */
function elapsed(ms: number): string {
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const mins = Math.floor(total / 60);
  return `${mins}:${(total - mins * 60).toFixed(1).padStart(4, '0')}`;
}

const responseCount = (n: number) => `${n} step response${n === 1 ? '' : 's'}`;

/**
 * True where the primary input cannot hover and is coarse -- a touchscreen.
 * The copy follows this, while the BEHAVIOUR follows each event's own
 * pointerType, so a hybrid machine reads touch wording and still works with
 * its mouse. Live, not read once: it used to be fixed at load, so switching
 * a browser into device mode kept telling a finger to press Space.
 */
const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
let touchFirst = touchQuery.matches;
touchQuery.addEventListener('change', () => {
  touchFirst = touchQuery.matches;
  renderGuide(experiment.getPhase());
  renderResponseCount();
});

/** Fills a list with one item per line of text. */
function setList(list: HTMLUListElement, items: string[]) {
  list.innerHTML = '';
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

/**
 * The plot's one line of help. At rest it says what the buttons do; while a
 * run is going, what to do and how to stop. Worked out from the state each
 * time rather than set piecemeal, so it can never describe a moment that has
 * passed -- or a keyboard to someone holding a phone.
 */
function renderGuide(phase: ExperimentState['phase']) {
  let items: string[];
  if (phase === 'recording' && runMode !== 'none') {
    // Nothing for the hand to do: the model is the one tracking.
    items = [
      `The ${modelName(runMode)} is tracking the target, not you`,
      touchFirst ? 'Tap the plot to stop the run' : 'Click the plot or press the Space bar to stop',
    ];
  } else if (phase === 'recording') {
    items = [
      touchFirst
        ? "Slide your finger up and down to match the target's height"
        : "Move your pointer up and down to match the target's height",
      touchFirst ? 'Lift your finger to stop recording' : 'Click the plot or press the Space bar to stop',
    ];
  } else if (phase === 'replaying') {
    items = [touchFirst ? 'Tap the plot to stop the replay' : 'Click the plot or press the Space bar to stop'];
  } else {
    // In the order of the buttons: Record -- what to do, then how to start
    // and stop -- then Replay. The same every time, sessions or not.
    items = [
      `When recording, follow the target's height with your ${touchFirst ? 'finger' : 'pointer'}`,
      touchFirst
        ? 'Hold the record button or the plot to record; lift to stop'
        : 'Space bar also starts and stops recording',
      'Replay this session with your model overlaid',
    ];
  }
  setList(stageGuide, items);
  placeGuide();
}

/**
 * The model's legend entry follows what is actually DRAWN. It used to follow
 * the mode instead, so the moment a replay ended the entry vanished while its
 * dashed line was still sitting on the plot.
 */
function syncLegend() {
  legendYou.textContent = plotSource === 'none' ? 'You' : 'Model (tracking)';
  legendModel.hidden = !(experiment.hasModelTrace() || experiment.getPhase() === 'replaying');
}

/** Replay needs something to replay, and nothing may run over a live run. */
function updateActionAvailability() {
  const running = experiment.isActive();
  const hasRun = !!lastSamples && lastSamples.xs.length >= 2;
  replayBtn.setAttribute('aria-disabled', String(running || !hasRun));
  // The settings would change the sampling under a run that is using it.
  // aria-disabled, like Replay, so the tooltip saying why still shows.
  settingsBtn.setAttribute('aria-disabled', String(running));
  settingsBtn.title = running ? 'Available when this run stops' : SETTINGS_TITLE;
  replayBtn.title = !hasRun
    ? 'Nothing to replay yet — record a session first, or open one from Sessions'
    : running
      ? 'Available when this run stops'
      : "Replay this session with the model's response to the same steps overlaid";
}

/**
 * A step response only becomes visible to splitStepResponses once a sample lands at the NEW
 * target value, so give the sampler a couple of ticks before re-splitting.
 */
function scheduleSync() {
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = setTimeout(syncAnalysis, currentConfig().samplePeriodMs * 2);
}

/**
 * Identifies whatever step responses have completed but not yet been identified, then
 * redraws. Cheap enough to run mid-recording: each new step response costs one fit
 * (~13 ms), rather than re-identifying the whole recording every time.
 */
function syncAnalysis() {
  const live = experiment.isActive() && pendingReset;
  const { xs, ys } = experiment.isActive() ? experiment.getSamples() : lastSamples ?? { xs: new Float64Array(), ys: new Float64Array() };
  if (xs.length === 0) return;

  const raw = splitStepResponses(xs, ys);

  // The previous run stays on screen until this one has something to replace
  // it WITH. Pressing Record used to blank the readout instantly, so a run
  // that turned out to be a misfire took the last good analysis with it.
  if (live && raw.length > 0) clearAnalysis(pendingSamplePeriodMs, pendingSource);

  if (raw.length <= responses.length) {
    renderResults();
    return;
  }

  leadIns = responseLeadIns(xs, ys, LEAD_FRACTION);
  const padded = padResponses(raw, 10);
  for (let i = responses.length; i < raw.length; i++) {
    responses.push(analyzeStepResponse(raw[i], padded[i], analysisSamplePeriodMs));
  }
  identifiedYet = true;
  if (experiment.isActive() && followLatest) inspected = responses.length - 1;
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
  responses = [];
  leadIns = [];
  excluded.clear();
  currentSessionId = null;
  setSessionName('');
  inspected = 0;
  followLatest = true;
  analysisSamplePeriodMs = samplePeriodMs;
  analysisSource = source;
  pendingReset = false;
}

/**
 * Arms a reset for the next run without performing it. syncAnalysis carries
 * it out the moment that run produces its first step response, which is the first
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

function includedResponses(): StepResponseAnalysis[] {
  return responses.filter((_, i) => !excluded.has(i));
}

/**
 * Fit error as a percentage of the step that provoked it.
 *
 * Raw pixels are not comparable between step responses: the step size is drawn from
 * LOGICAL_HEIGHT/15 .. LOGICAL_HEIGHT/5, a 3x range, so the same pixel error
 * is a good fit on a big step and a bad one on a small step. On the reference
 * recording step response 3 (9.1 px on a 39 px step) reads as better than step response 2
 * (11.0 px on 77 px) in pixels and far worse -- 23% against 14% -- once the
 * step is accounted for. A step response with no step to speak of has no scale to be
 * judged against at all.
 */
function errorPctOf(t: StepResponseAnalysis): number {
  return t.stepSize > 0 ? (t.fit2Rms / t.stepSize) * 100 : Infinity;
}

interface OutlierBounds {
  /** Fit far worse than its peers -- it did not measure the same system. */
  high: number;
  /**
   * Fit far BETTER than its peers, which is just as suspect: a human tracking
   * a step does not produce a 0.3% fit. It means the step response holds almost no
   * dynamics for the model to get wrong, so it contributes a confident number
   * about nothing. The reference recording has exactly one, 40x below the rest.
   */
  low: number;
}

function outlierBounds(): OutlierBounds {
  if (responses.length === 0) return { high: Infinity, low: 0 };
  const sorted = responses.map(errorPctOf).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { high: median * 3, low: median / 3 };
}

function outlierKindOf(t: StepResponseAnalysis, bounds: OutlierBounds): 'poor' | 'degenerate' | null {
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
  const included = includedResponses();
  if (included.length === 0) return;
  const agg = aggregateResponses(included, analysisSamplePeriodMs);
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
  const byModel = analysisSource !== 'none' && responses.length > 0;
  readoutHeading.textContent = byModel
    ? `${modelName(analysisSource).replace(/^./, (c) => c.toUpperCase())} · self-test`
    : 'Your model';
  readoutHeading.parentElement!.parentElement!.dataset.source = byModel ? 'model' : 'you';

  const included = includedResponses();
  if (included.length === 0) {
    readoutSource.textContent = responses.length === 0 ? '' : 'All step responses excluded';
    readoutEl.innerHTML =
      responses.length === 0
        ? '<p class="empty">Record a few step responses and your identified model appears here, updating as each step interval completes.</p>'
        : '<p class="empty">Tick at least one step response to identify a model.</p>';
    return;
  }

  const agg = aggregateResponses(included, analysisSamplePeriodMs);
  const c = SIM_SOURCE === 'median' ? agg.medianContinuous : agg.averageContinuous;
  const d = SIM_SOURCE === 'median' ? agg.medianDiscrete : agg.averageDiscrete;
  const { wn, zeta, overshoot } = dampingMetrics(c);
  const character = dampingCharacter(zeta);
  const tau = c.P11 === 0 ? Infinity : -1 / c.P11;

  const excludedCount = responses.length - included.length;
  readoutSource.textContent =
    `${SIM_SOURCE === 'median' ? 'Median' : 'Average'} of ${included.length} step response${included.length === 1 ? '' : 's'}` +
    (excludedCount > 0 ? ` · ${excludedCount} excluded` : '');

  // The lede is what the numbers MEAN about the person. 2% settling time of a
  // second-order system. It runs away as zeta -> 0, and a "settles in 740 s" note
  // is worse than no note at all, so a barely damped fit says so instead of quoting
  // a number nobody should believe. Overdamped, the response settles at the pace of
  // its SLOWER real pole, ωn(ζ - √(ζ²-1)), not at ζωn, which would flatter it.
  const decay = zeta > 1 ? wn * (zeta - Math.sqrt(zeta * zeta - 1)) : zeta * wn;
  const settlingS = decay > 0 ? 4 / decay : Infinity;
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
  const a2 = pairProduct(d.P21, d.P22);
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
  const poor = responses.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'poor').length;
  const degenerate = responses.filter((t, i) => !excluded.has(i) && outlierKindOf(t, bounds) === 'degenerate').length;
  const notes: string[] = [];
  const responsesFit = (n: number) => `${n} step response${n === 1 ? ' fits' : 's fit'}`;
  if (poor > 0) notes.push(`${responsesFit(poor)} more than 3× worse than the median`);
  if (degenerate > 0) notes.push(`${responsesFit(degenerate)} more than 3× better than the median, likely too little movement to measure`);
  const flagged = poor + degenerate;
  const flag =
    notes.length > 0
      ? `<p class="flag">Relative to step size, ${notes.join('; ')}. ` +
        `${flagged === 1 ? "It's" : "They're"} marked ⚠ in Session; untick ${flagged === 1 ? 'it' : 'one'} to see how much it moves the model.</p>`
      : '';

  readoutEl.innerHTML =
    `<div class="readout-row"><div class="tiles-box"><div class="tiles">${tiles}</div></div>` +
    `<div class="readout-text">${verdict}${continuous}${discrete}${details}${flag}</div></div>`;
}

/** Step response i's lead-in: the samples just before its step. */
function leadOf(i: number) {
  return leadIns[i];
}

const responseCountNote = $<HTMLParagraphElement>('responseCountNote');
const responseDetail = $<HTMLDivElement>('responseDetail');

/**
 * The count lives in the details note rather than a label of its own: the
 * strip scrolls sideways, so on a narrow screen it is the only way to know how
 * many step responses there are.
 */
function renderResponseCount() {
  const n = responses.length;
  responseCountNote.textContent =
    n === 0 ? '' : n === 1 ? '1 step response' : `${n} step responses, ${touchFirst ? 'tap' : 'select'} one to see details`;
  // Nothing to untick or inspect yet.
  responseCountNote.parentElement!.hidden = responseDetail.hidden = n === 0;
}

function renderFilmstrip() {
  renderResponseCount();
  if (responses.length === 0) {
    filmstripEl.innerHTML = '<p class="empty">Step responses appear here as you record, one per step.</p>';
    return;
  }

  const bounds = outlierBounds();

  // A rebuild still happens when step responses arrive mid-run, and it can land while
  // someone is working through the strip, so put focus back where it was.
  const focused = document.activeElement as HTMLElement | null;
  const focusedCard = focused?.closest('.response-card');
  const focusedIndex = focusedCard ? [...filmstripEl.children].indexOf(focusedCard) : -1;
  const focusedWasCheckbox = focused?.classList.contains('response-include') ?? false;

  filmstripEl.innerHTML = '';

  responses.forEach((t, i) => {
    const { zeta } = dampingMetrics(t.continuous);
    const kind = outlierKindOf(t, bounds);
    const pct = errorPctOf(t);

    // The card holds two SIBLING controls: a checkbox that includes the step response
    // in the model, and a button that inspects it. They used to be one button
    // with the checkbox nested inside, which is invalid -- a button may not
    // contain interactive content -- and left the two fighting over clicks
    // and tab order.
    const card = document.createElement('div');
    card.className = 'response-card';
    card.dataset.excluded = String(excluded.has(i));
    card.dataset.outlier = kind ?? '';

    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'response-inspect';
    inspect.setAttribute('aria-pressed', String(i === inspected));
    inspect.innerHTML =
      `<span class="name">Step ${i + 1}${kind ? ' ⚠' : ''}</span>` +
      `<canvas></canvas>` +
      `<span class="response-stats"><span>ζ ${zeta.toFixed(2)}</span>` +
      `<span>${Number.isFinite(pct) ? `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}% err` : '—'}</span></span>`;
    inspect.title =
      `RMS ${t.fit2Rms.toFixed(1)} px on a ${t.stepSize.toFixed(0)} px step` +
      (kind === 'poor' ? ' — fits far worse than the other step responses' : '') +
      (kind === 'degenerate' ? ' — fits far better than is plausible; little to measure here' : '');
    // Update in place rather than rebuilding the strip. A rebuild replaces the
    // very node being operated, which drops keyboard focus to the body -- so
    // excluding three step responses in a row meant tabbing back in three times.
    inspect.addEventListener('click', () => {
      inspected = i;
      followLatest = i === responses.length - 1;
      for (const other of filmstripEl.querySelectorAll('.response-inspect')) {
        other.setAttribute('aria-pressed', String(other === inspect));
      }
      renderPlots();
    });

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'response-include';
    box.checked = !excluded.has(i);
    box.setAttribute('aria-label', `Include step ${i + 1} in the model`);
    box.addEventListener('change', () => {
      if (box.checked) excluded.delete(i);
      else excluded.add(i);
      // Only this card's dimming and the summary above change: the outlier
      // marks come from outlierBounds(), which reads every step response regardless of
      // what is excluded. So no rebuild, and focus stays on the checkbox.
      card.dataset.excluded = String(excluded.has(i));
      pushModelToSimulation();
      renderReadout();
      persistAnalysis();
    });

    card.append(inspect, box);
    filmstripEl.appendChild(card);
    plotResponseSparkline(inspect.querySelector('canvas') as HTMLCanvasElement, t.response.xn, t.response.yn, leadOf(i));
  });

  if (focusedIndex >= 0) {
    const card = filmstripEl.children[focusedIndex] as HTMLElement | undefined;
    const target = card?.querySelector<HTMLElement>(focusedWasCheckbox ? '.response-include' : '.response-inspect');
    target?.focus();
  }
}

/** The step response the detail plots currently show, so they are not redrawn for nothing. */
let plottedResponse: StepResponseAnalysis | null = null;

/**
 * @param force redraw even if the same step response is already plotted -- needed
 *              after a theme change, which the canvases cannot inherit.
 */
function renderPlots(force = false) {
  const t = responses[inspected];
  if (!t) {
    // Canvases keep their last drawing, so returning early here is what left
    // a previous run's plots on screen under a "Step details" heading after
    // a run that produced no step responses at all.
    responseDetailHeading.textContent = 'Step details';
    if (plottedResponse) {
      clearPlot(stepGraph);
      clearPlot(freqGraph);
      clearPlot(poleGraph);
      plottedResponse = null;
    }
    poleReadout.textContent = '';
    poleResetBtn.hidden = true;
    detailLegend.hidden = true;
    return;
  }
  if (t === plottedResponse && !force) return;
  // A different step response starts from its own fit: a pole dragged on one step response
  // means nothing for the next.
  if (t !== plottedResponse) dragged = null;
  plottedResponse = t;
  responseDetailHeading.textContent = `Step ${inspected + 1} details`;

  // Measured response: |H[k]| of the DFT of this step response's deconvolved h[n].
  // Computed once per step response -- a drag redraws many times a second and only
  // the model curves move.
  const Hk = dft(t.hn);
  const n = Hk.real.length;
  plottedSpectrum = new Float64Array(n);
  for (let i = 0; i < n; i++) plottedSpectrum[i] = magnitudeOfComplex(Hk.real[i], Hk.imag[i]);
  drawDetail();
}

/**
 * The pole pair being shown, when it has been dragged off the fit. Exploration
 * only: it redraws this step response's plots and never touches the identified model.
 */
let dragged: { p1: number; p2: number } | null = null;
let plottedSpectrum = new Float64Array();

/** Redraws the inspected step response's three plots for the current pole pair. */
function drawDetail() {
  const t = plottedResponse;
  if (!t) return;
  const fit = { p1: t.discrete.P21, p2: t.discrete.P22 };
  const pole = dragged ?? fit;
  const D = t.discrete.D2;
  const n = plottedSpectrum.length;

  plotFrequencyResponse(freqGraph, {
    sampled: plottedSpectrum,
    firstOrder: firstOrderMagnitudeResponse(t.discrete.P11, n),
    secondOrder: secondOrderMagnitudeResponse(pole.p1, pole.p2, n),
  });
  plotPoleLocations(poleGraph, [pole], dragged ? fit : undefined);

  const model = simulateSecondOrder(t.response.xn, pole.p1, pole.p2, D);
  // Led in from just before the step, as the thumbnails are, so the plot
  // shows the step and not just its aftermath. Before the step the models
  // sit at rest on the old target level, which is 0 in the step response's frame.
  const lead = leadOf(inspected);
  const k = lead ? lead.xn.length : 0;
  const withLead = (head: Float64Array | null, body: Float64Array) => {
    const out = new Float64Array(k + body.length);
    if (head) out.set(head);
    out.set(body, k);
    return out;
  };
  plotStepResponse(stepGraph, {
    target: withLead(lead?.xn ?? null, t.response.xn),
    measured: withLead(lead?.yn ?? null, t.response.yn),
    model: withLead(null, model),
    fit: dragged ? withLead(null, simulateSecondOrder(t.response.xn, fit.p1, fit.p2, D)) : undefined,
    samplePeriodMs: analysisSamplePeriodMs,
    stepIndex: k,
  });

  // What the pole MEANS, and what it costs: the error is lowest at the fit,
  // which is the whole point of identification, and dragging lets you see it.
  const c = discretePairToContinuous(pole.p1, pole.p2, analysisSamplePeriodMs / 1000);
  const { wn, zeta, overshoot } = dampingMetrics({ P11: 0, D1: 0, P21: c.cr, P22: c.ci, D2: 0 });
  let sq = 0;
  for (let i = 0; i < model.length; i++) sq += (t.response.yn[i] - model[i]) ** 2;
  const errPct = t.stepSize > 0 ? (Math.sqrt(sq / model.length) / t.stepSize) * 100 : NaN;
  const errText = Number.isFinite(errPct) ? `${errPct < 10 ? errPct.toFixed(1) : errPct.toFixed(0)}% err` : '';
  poleReadout.textContent =
    `ζ ${zeta.toFixed(2)} ${dampingCharacter(zeta)} · ωn ${wn.toFixed(2)} rad/s · ${overshoot.toFixed(0)}% overshoot` +
    (errText ? ` · ${errText}` : '');
  poleResetBtn.hidden = !dragged;
  detailLegend.hidden = false;
  keyModel.textContent = dragged ? 'Dragged model' : 'Model';
  keyFit.hidden = !dragged;
}

const POLE_MAX = 0.995;
/** Real poles stay positive: a pole at or below 0 has no continuous equivalent. */
const POLE_MIN = 0.005;

/**
 * Keeps a pair stable and meaningful. A complex pair (p2 >= 0) stays inside
 * the unit circle; a real pair (p2 < 0) keeps both poles on (0, 1).
 */
function clampPole(p1: number, p2: number) {
  if (p2 >= 0) {
    const r = Math.hypot(p1, p2);
    if (r > POLE_MAX) {
      p1 *= POLE_MAX / r;
      p2 *= POLE_MAX / r;
    }
    return { p1, p2 };
  }
  const c = Math.min(POLE_MAX, Math.max(POLE_MIN, p1));
  const h = Math.min(-p2, c - POLE_MIN, POLE_MAX - c);
  return { p1: c, p2: -h };
}

/** Within this many pixels of the real axis, a press means the axis itself. */
const AXIS_SNAP_PX = 6;

/**
 * How the current drag moves the pair. 'pair': the pointer IS a complex pole
 * (its mirror follows), snapping to a double pole -- critical damping -- on
 * the axis, which is otherwise impossible to hit exactly. 'split': one real
 * pole slides along the axis while the other stays put -- overdamped.
 */
let dragMode: { kind: 'pair' } | { kind: 'split'; fixed: number } = { kind: 'pair' };

/** The z-plane point under a pointer, and whether it is on the real axis. */
function zAt(e: PointerEvent) {
  const rect = poleGraph.getBoundingClientRect();
  const { cx, cy, r } = poleGeometry(rect.width, rect.height);
  const dy = Math.abs(cy - (e.clientY - rect.top));
  return { re: (e.clientX - rect.left - cx) / r, im: dy / r, onAxis: dy <= AXIS_SNAP_PX };
}

function poleAt(e: PointerEvent) {
  const z = zAt(e);
  if (dragMode.kind === 'split') {
    const moving = Math.min(POLE_MAX, Math.max(POLE_MIN, z.re));
    return clampPole((moving + dragMode.fixed) / 2, -Math.abs(moving - dragMode.fixed) / 2);
  }
  return clampPole(z.re, z.onAxis ? 0 : z.im);
}

// Press anywhere on the plot to pick the pair up: the conjugate is its mirror,
// so a press below the axis grabs the same pair. Jumping to the press, rather
// than requiring a hit on the marker, makes it usable with a finger. A press
// ON the axis when the pair is already real grabs the nearer real pole
// instead, and splits the pair.
poleGraph.addEventListener('pointerdown', (e) => {
  if (!plottedResponse) return;
  poleGraph.setPointerCapture(e.pointerId);
  poleGraph.dataset.dragging = 'true';
  const current = dragged ?? { p1: plottedResponse.discrete.P21, p2: plottedResponse.discrete.P22 };
  const z = zAt(e);
  if (z.onAxis && current.p2 <= 0) {
    const hi = current.p1 - current.p2;
    const lo = current.p1 + current.p2;
    dragMode = { kind: 'split', fixed: Math.abs(z.re - hi) < Math.abs(z.re - lo) ? lo : hi };
  } else {
    dragMode = { kind: 'pair' };
  }
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
  if (!plottedResponse) return;
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
  const from = dragged ?? { p1: plottedResponse.discrete.P21, p2: plottedResponse.discrete.P22 };
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
  const character = dampingCharacter(zeta);
  const overshoot = zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const source = identifiedYet ? 'your identified model' : 'built-in demo model; record a run to replace it';
  simModelInfo.textContent =
    `Model in use: ${source} — ωn ${wn.toFixed(2)} rad/s, ζ ${zeta.toFixed(2)} (${character}, ${overshoot.toFixed(0)}% overshoot)`;
}

/** What the Samples dialog is showing, which is what its Export saves. */
interface SamplesView {
  xs: Float64Array;
  ys: Float64Array;
  samplePeriodMs: number;
  name: string;
  createdAt: number;
}
let samplesShown: SamplesView | null = null;

/** Opens one session's samples, over the Sessions list. */
function openSamples(view: SamplesView) {
  samplesShown = view;
  samplesTitle.textContent = `Samples · ${view.name}`;
  const seconds = (view.xs.length * view.samplePeriodMs) / 1000;
  samplesMeta.textContent = `${view.xs.length} samples · one every ${view.samplePeriodMs} ms · ${seconds.toFixed(1)} s`;
  const lines = ['n\tx[n]\ty[n]', '======================='];
  for (let i = 0; i < view.xs.length; i++) {
    lines.push(`${i}\t${view.xs[i].toFixed(3)}\t${view.ys[i].toFixed(3)}`);
  }
  samplesOut.value = lines.join('\n');
  samplesDialog.showModal();
  // Replacing the text keeps the old scroll position; a new session starts at n = 0.
  samplesOut.scrollTop = 0;
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
recordBtn.addEventListener('click', (e) => {
  // The click that trails a touch hold would otherwise start a second run.
  // It often never arrives -- the pointer was captured to the plot, so the
  // click lands there -- which leaves the flag set; a keyboard click
  // (detail 0) is never that trailing click, so it always records.
  const trailing = touchPressedRecord && e.detail !== 0;
  touchPressedRecord = false;
  if (!trailing) startRecording();
});

// Replay plays back the run that is already on screen -- your target, your
// response, and the identified model's response to the same target. It is a
// playback, so nothing is recorded and the analysis is left alone.
replayBtn.addEventListener('click', () => {
  // aria-disabled does not block clicks the way disabled does, so refuse here
  // -- and say why, since the tooltip that explains it never shows on touch.
  if (replayBtn.getAttribute('aria-disabled') === 'true') {
    statusEl.textContent = replayBtn.title;
    return;
  }
  if (!lastSamples || experiment.isActive()) return;
  plotSource = analysisSource;
  experiment.startReplay(lastSamples.xs, lastSamples.ys, lastSamples.samplePeriodMs);
});

settingsBtn.addEventListener('click', () => {
  if (settingsBtn.getAttribute('aria-disabled') === 'true') {
    statusEl.textContent = settingsBtn.title;
    return;
  }
  settingsDialog.showModal();
});
sessionsBtn.addEventListener('click', () => {
  void renderSessions();
  sessionsDialog.showModal();
});

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
closeOnBackdropClick(sessionsDialog);
closeOnBackdropClick(samplesDialog);

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
  if (el instanceof HTMLButtonElement || el instanceof HTMLDetailsElement) return;
  // Space must not start a run behind an open modal.
  if (settingsDialog.open || sessionsDialog.open || samplesDialog.open) return;
  e.preventDefault();
  // The space bar is an explicit instruction, unlike a press on the plot, so
  // it stops straight away instead of asking.
  if (experiment.isActive()) {
    experiment.stop();
  } else {
    startRecording();
  }
});

// The scale's labels under the slider are shortcuts to their positions. They
// are skipped by Tab: the slider itself is the control, and its arrow keys
// reach every value.
paceGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-pace]') as HTMLButtonElement | null;
  if (!btn) return;
  stepPeriodInput.value = String(Number(btn.dataset.pace) / 1000);
  experiment.updateConfig(currentConfig());
  syncPaceButtons();
  saveSettings();
});
// The readout follows the thumb while it is dragged; the setting is applied on
// release, by the change listener below.
stepPeriodInput.addEventListener('input', syncPaceButtons);

[stepPeriodInput, samplePeriodInput, simulationModeSelect, discretePointsCheckbox].forEach((el) =>
  el.addEventListener('change', () => {
    experiment.updateConfig(currentConfig());
    syncPaceButtons();
    syncLegend();
    saveSettings();
  }),
);

/** The slider's readout, and the label it sits on, if any. */
function syncPaceButtons() {
  const ms = currentConfig().stepPeriodMs;
  stepPeriodOut.textContent = `${ms / 1000} s`;
  for (const mark of paceGroup.querySelectorAll<HTMLElement>('[data-pace]')) {
    mark.dataset.active = String(mark.dataset.pace === String(ms));
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
  stepPeriodInput.value = String(DEFAULT_SETTINGS.stepPeriodMs / 1000);
  samplePeriodInput.value = String(DEFAULT_SETTINGS.samplePeriodMs);
  simulationModeSelect.value = DEFAULT_SETTINGS.simulationMode;
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
  if (!samplesShown) return;
  const blob = new Blob([formatAllSamplesBlock(samplesShown.xs, samplesShown.ys)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date(samplesShown.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
  // A live run owns the analysis: importing now would identify the run's
  // samples and file them under the imported name.
  if (experiment.isActive()) {
    fileInput.value = '';
    statusEl.textContent = 'Stop the run before importing a session';
    return;
  }
  const text = await file.text();
  // Cleared so choosing the same file again still fires 'change'.
  fileInput.value = '';
  let parsed: { xs: Float64Array; ys: Float64Array };
  try {
    parsed = parseSessionFile(text);
  } catch (err) {
    statusEl.textContent = (err as Error).message;
    return;
  }
  const { xs, ys } = parsed;
  const existing = await safely(() => findByHash(hashSamples(xs, ys)));
  if (existing) {
    showSession(existing, `Loaded ${xs.length} samples from ${file.name} · already in your sessions`);
    if (sessionsDialog.open) void renderSessions();
  } else {
    showSamples(xs, ys, currentConfig().samplePeriodMs, 'none', []);
    statusEl.textContent = `Loaded ${xs.length} samples from ${file.name}`;
    // Re-renders the list itself once the new row exists.
    await keepSession(xs, ys, 'none', analysisSamplePeriodMs, file.name);
  }
});

/* --------------------------------------------------------------- sessions */

/** Runs a session-store call, and on failure says so once instead of breaking the app. */
async function safely<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    sessionsUnavailable.hidden = false;
    return undefined;
  }
}

/** What a list row shows, from the analysis on screen. */
function summarize(): SessionSummary {
  const included = includedResponses();
  if (included.length === 0) return { responses: responses.length, included: 0, zeta: NaN, wn: NaN, delayMs: NaN };
  const agg = aggregateResponses(included, analysisSamplePeriodMs);
  const c = SIM_SOURCE === 'median' ? agg.medianContinuous : agg.averageContinuous;
  const { wn, zeta } = dampingMetrics(c);
  return { responses: responses.length, included: included.length, zeta, wn, delayMs: c.D2 * 1000 };
}

/** Stores the analysis on screen as a new session and makes it the open one. */
async function keepSession(
  xs: Float64Array,
  ys: Float64Array,
  source: SimulationMode,
  samplePeriodMs: number,
  fileName?: string,
) {
  const createdAt = Date.now();
  const id = await safely(() =>
    addSession({
      createdAt,
      source,
      fileName,
      samplePeriodMs,
      xs,
      ys,
      excluded: [...excluded],
      note: '',
      summary: summarize(),
      hash: hashSamples(xs, ys),
    }),
  );
  if (id === undefined) return;
  currentSessionId = id;
  rememberOpen(id);
  setSessionName(sessionName({ note: '', fileName, createdAt }));
  if (sessionsDialog.open) void renderSessions();
}

/** Saves the unticked step responses, and the summary they change, to the open session. */
function persistAnalysis() {
  if (currentSessionId === null) return;
  void safely(() => updateSession(currentSessionId!, { excluded: [...excluded], summary: summarize() }));
}

/** Puts samples on screen and identifies them, as an import or an opened recording. */
function showSamples(xs: Float64Array, ys: Float64Array, samplePeriodMs: number, source: SimulationMode, exclude: number[]) {
  dismissFlash();
  lastSamples = { xs, ys, samplePeriodMs };
  clearAnalysis(samplePeriodMs, source);
  // After clearAnalysis, which empties it, and before the step responses are drawn.
  for (const i of exclude) excluded.add(i);
  plotSource = source;
  syncLegend();
  syncAnalysis();
  updateActionAvailability();
  renderGuide(experiment.getPhase());
}

function showSession(session: Session, status: string) {
  showSamples(session.xs, session.ys, session.samplePeriodMs, session.source, session.excluded);
  currentSessionId = session.id;
  rememberOpen(session.id);
  setSessionName(sessionName(session));
  statusEl.textContent = status;
}

/** "Today · 14:32", "Yesterday · 09:05", "Sep 3 · 18:40". */
function whenLabel(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Built from the calendar, not today minus 24 h: across a daylight-saving
  // change a day is 23 or 25 hours long.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (day === today) return `Today · ${time}`;
  if (day === yesterday) return `Yesterday · ${time}`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString(undefined, opts)} · ${time}`;
}

function whoLabel(session: Session): string {
  if (session.fileName) return session.fileName;
  return session.source === 'none' ? 'You' : `${modelName(session.source).replace(/^./, (c) => c.toUpperCase())} · self-test`;
}

function statsLabel(s: SessionSummary | null): string {
  if (!s) return '';
  const n = s.responses;
  const count = `${n} step${n === 1 ? '' : 's'}`;
  if (s.included === 0) return `${count} · all excluded`;
  return `${count} · ζ ${s.zeta.toFixed(2)} · ${s.delayMs.toFixed(0)} ms delay`;
}

/** A small button for a row in the Sessions list. */
function rowButton(cls: string, text: string, label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${cls} ghost`;
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The run on screen when nothing stores it -- the session store is unavailable, or
 * its session was deleted -- so its samples can still be read and exported.
 */
function unsavedRow(): HTMLLIElement | null {
  if (!lastSamples || currentSessionId !== null || experiment.isActive()) return null;
  const shown = lastSamples;
  const li = document.createElement('li');
  li.className = 'session-row';
  li.dataset.unsaved = 'true';
  li.setAttribute('aria-current', 'true');
  const info = document.createElement('div');
  info.className = 'session-open';
  for (const [cls, text] of [
    ['session-when', 'On screen · not kept'],
    ['session-who', plotSource === 'none' ? 'You' : `${modelName(plotSource)} · self-test`],
    ['session-stats', statsLabel(summarize())],
  ]) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    info.appendChild(span);
  }
  const data = rowButton('session-data', 'Data', 'Samples of the session on screen', () =>
    openSamples({ ...shown, name: 'the session on screen', createdAt: Date.now() }),
  );
  li.append(info, data);
  return li;
}

async function renderSessions() {
  const all = await safely(listSessions);
  sessionList.innerHTML = '';
  const unsaved = unsavedRow();
  if (unsaved) sessionList.appendChild(unsaved);
  sessionsEmpty.hidden = !!unsaved || (all?.length ?? 0) > 0;
  if (!all) return;
  for (const session of all) {
    const li = document.createElement('li');
    li.className = 'session-row';
    li.setAttribute('aria-current', String(session.id === currentSessionId));

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'session-open';
    openBtn.title = 'Open this session';
    for (const [cls, text] of [
      ['session-when', whenLabel(session.createdAt)],
      ['session-who', whoLabel(session)],
      ['session-stats', statsLabel(session.summary)],
    ]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      openBtn.appendChild(span);
    }
    openBtn.addEventListener('click', () => {
      if (experiment.isActive()) return;
      showSession(session, `Opened the session from ${whenLabel(session.createdAt)}`);
      // The dialog stays open, so recordings can be stepped through; only the
      // selection moves. The run that was on screen unsaved is gone now.
      for (const row of sessionList.children) {
        row.setAttribute('aria-current', String(row === li));
      }
      sessionList.querySelector('[data-unsaved]')?.remove();
    });

    // Saved as you type, a moment after you stop; no Save button to forget.
    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'session-note';
    note.value = session.note;
    note.placeholder = 'Add a note: mouse, trackpad, tired…';
    note.setAttribute('aria-label', `Note for the session from ${whenLabel(session.createdAt)}`);
    let noteTimer: ReturnType<typeof setTimeout> | undefined;
    const saveNote = () => {
      clearTimeout(noteTimer);
      session.note = note.value;
      if (session.id === currentSessionId) setSessionName(sessionName(session));
      void safely(() => updateSession(session.id, { note: note.value }));
    };
    note.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(saveNote, 400);
    });
    note.addEventListener('change', saveNote);
    // Enter would submit the dialog's form and close it mid-thought.
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveNote();
        note.blur();
      }
    });

    // Two presses: the first arms it, the second deletes. Deleting cannot be
    // undone, and a list of similar rows is an easy place to misclick.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'session-delete ghost';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete the session from ${whenLabel(session.createdAt)}`);
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== 'true') {
        del.dataset.confirm = 'true';
        del.textContent = 'Delete?';
        return;
      }
      await safely(() => deleteSession(session.id));
      // The run stays on screen; it is just no longer kept.
      if (session.id === currentSessionId) {
        currentSessionId = null;
        rememberOpen(null);
        setSessionName('');
      }
      void renderSessions();
    });
    del.addEventListener('blur', () => {
      del.dataset.confirm = 'false';
      del.textContent = 'Delete';
    });

    const data = rowButton('session-data', 'Data', `Samples of the session from ${whenLabel(session.createdAt)}`, () =>
      openSamples({ ...session, name: sessionName(session) }),
    );

    li.append(openBtn, data, del, note);
    sessionList.appendChild(li);
  }
}

/**
 * Reopens the session that was open when the page was last left, so a
 * reload picks up where you were. If that one has since been deleted, the
 * newest is the best guess.
 */
async function restoreLatest() {
  const id = rememberedOpen();
  const session = (id !== null ? await safely(() => getSession(id)) : undefined) ?? (await safely(listSessions))?.[0];
  // A run or an import may have started while the session store was being read.
  if (!session || lastSamples || experiment.isActive()) return;
  showSession(session, `Reopened ${sessionName(session)}`);
}

syncPaceButtons();
syncLegend();
renderSimModelInfo();
renderResults();
// Otherwise Replay starts life dimmed with no tooltip to explain why: the
// availability pass only runs on a state change, and none has happened yet.
updateActionAvailability();
renderGuide('idle');
void restoreLatest();
