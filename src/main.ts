import './style.css';
import {
  TrackingExperiment,
  MAX_RESPONSES,
  dampingOf,
  type ExperimentState,
  type SimulationMode,
  type SimulationModel,
} from './ui/experiment';
import { plotResponseSparkline } from './ui/plotting';
import {
  addSession,
  findByHash,
  getSession,
  hashSamples,
  listSessions,
  rememberedOpen,
  rememberOpen,
  updateSession,
  type Session,
  type SessionSummary,
} from './ui/sessions';
import {
  analyzeStepResponse,
  aggregateResponses,
  dampingMetrics,
  dampingCharacter,
  jointModel,
  type StepResponseAnalysis,
} from './engine/analysis';
import { simulateSecondOrder } from './engine/curveFit';
import { discretePairToContinuous } from './engine/poleConversion';
import { errorPctOf, outlierBounds, outlierKindOf } from './engine/outliers';
import { splitStepResponses, padResponses, responseLeadIns } from './engine/stepResponses';
import { parseSessionFile } from './engine/dataFormat';
import { $, closeOnBackdropClick } from './ui/dom';
import { elapsed, responseCount, sessionName, whenLabel } from './ui/labels';
import { connectSettings, currentConfig } from './ui/settings';
import { dismissFlash, flash, isTouchFirst, onTouchFirstChange, renderGuide } from './ui/stageHelp';
import { renderReadout as drawReadout } from './ui/readout';
import { onModelPoleChange, showDetail } from './ui/detailPlots';
import { connectSessionTitle, setSessionName } from './ui/sessionTitle';
import { connectSessions, renderSessions, safely } from './ui/sessionsView';

const graphCanvas = $<HTMLCanvasElement>('graph');
const legendYou = $<HTMLSpanElement>('legendYou');
const legendModel = document.querySelector('.legend-model') as HTMLLIElement;
const statusEl = $<HTMLParagraphElement>('status');
const stageActions = $<HTMLDivElement>('stageActions');
const stageEl = $<HTMLElement>('stage');
const recordBtn = $<HTMLButtonElement>('recordBtn');
const replayBtn = $<HTMLButtonElement>('replayBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const SETTINGS_TITLE = settingsBtn.title;
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const sessionsDialog = $<HTMLDialogElement>('sessionsDialog');
const sessionsBtn = $<HTMLButtonElement>('sessionsBtn');
const samplesDialog = $<HTMLDialogElement>('samplesDialog');
const filmstripEl = $<HTMLDivElement>('filmstrip');
const loadDataBtn = $<HTMLButtonElement>('loadDataBtn');
const fileInput = $<HTMLInputElement>('fileInput');
const simModelInfo = $<HTMLParagraphElement>('simModelInfo');

/**
 * Identified step responses for the session on screen, in recording order. Built up
 * incrementally while recording (one step response identified per step, ~13 ms) and
 * all at once when a data file is loaded.
 */
let responses: StepResponseAnalysis[] = [];
/** The stored session on screen, which notes and unticked step responses are saved to. */
let currentSessionId: number | null = null;
/** A few samples from before each step response's step, so its thumbnail shows the step. */
let leadIns: ReturnType<typeof responseLeadIns> = [];
/** The lead-in is this fraction of the step response, and at least two samples. */
const LEAD_FRACTION = 0.1;
/** Step responses the operator has taken out of the model. */
const excluded = new Set<number>();
/**
 * The selected card: a step response's index, or the Model card, which stands
 * for the model built from every included step response. The Model card is
 * selected whenever a step response arrives and whenever a session opens.
 */
let selected: number | 'model' = 'model';
/** The model's pole pair as dragged on the Model card, kept with the session. */
let adjustedPole: { p1: number; p2: number } | null = null;
/**
 * How the session's model comes from its step responses: the median of
 * each one's own fit, or one model fitted to them all. Kept with the session;
 * a new one starts on the median.
 */
let modelFit: 'median' | 'joint' = 'median';
const modelFitGroup = $<HTMLDivElement>('modelFitGroup');
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
    renderGuide('finished', runMode);
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

onTouchFirstChange(() => {
  renderGuide(experiment.getPhase(), runMode);
  renderResponseCount();
});

function renderState(state: ExperimentState) {
  const recording = state.phase === 'recording';
  const replaying = state.phase === 'replaying';
  const running = recording || replaying;

  // The actions are the plot's resting state; while something is running the
  // plot is the thing to look at, so they get out of the way.
  stageActions.hidden = running;
  stageEl.dataset.resting = String(!running);
  renderGuide(state.phase, runMode);
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
 * The model's legend entry follows what is actually DRAWN, not the mode, so
 * it stays while a finished replay's line is still on the plot.
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
  syncModelFitGroup();
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
  // it WITH, so a run that turns out to be a misfire does not take the last
  // good analysis with it.
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
  selected = 'model';
  pushModelToSimulation();
  renderResults();
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
  selected = 'model';
  adjustedPole = null;
  modelFit = 'median';
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

function renderResults() {
  renderReadout();
  renderFilmstrip();
  renderPlots();
}

/**
 * The model: the median of the ticked step responses, with its pole pair
 * moved wherever it has been dragged. It is what the readout reports, and
 * what Replay and the self-test play back.
 */
function currentModel() {
  const fit = fittedModel();
  if (!fit) return null;
  if (!adjustedPole) return { ...fit, adjusted: false };
  const { p1, p2 } = adjustedPole;
  const c = discretePairToContinuous(p1, p2, analysisSamplePeriodMs / 1000);
  return {
    discrete: { ...fit.discrete, P21: p1, P22: p2 },
    continuous: { ...fit.continuous, P21: c.cr, P22: c.ci },
    adjusted: true,
    method: fit.method,
  };
}

/** The last joint fit, and the step responses it was fitted to. */
let jointCache: { from: StepResponseAnalysis[]; periodMs: number; model: ReturnType<typeof jointModel> } | null = null;

/** The model as fitted from the ticked step responses, by the chosen method. */
function fittedModel() {
  const included = includedResponses();
  if (included.length === 0) return null;
  if (modelFit === 'joint') {
    const cached =
      jointCache &&
      jointCache.periodMs === analysisSamplePeriodMs &&
      jointCache.from.length === included.length &&
      jointCache.from.every((t, i) => t === included[i]);
    if (!cached) jointCache = { from: included, periodMs: analysisSamplePeriodMs, model: jointModel(included, analysisSamplePeriodMs) };
    return { ...jointCache!.model, method: 'joint' as const };
  }
  const agg = aggregateResponses(included, analysisSamplePeriodMs);
  return { discrete: agg.medianDiscrete, continuous: agg.medianContinuous, method: 'median' as const };
}

function pushModelToSimulation() {
  const model = currentModel();
  if (!model) return;
  experiment.setSimulationModel({ ...model.continuous });
  renderSimModelInfo();
}

/**
 * The fit switch: only while the Model card is selected, since a step shows
 * its own fit, and fixed during a run, which is still collecting steps.
 */
function syncModelFitGroup() {
  modelFitGroup.hidden = selected !== 'model' || includedResponses().length === 0;
  const running = experiment.isActive();
  for (const b of modelFitGroup.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.fit === modelFit));
    b.disabled = running;
  }
  modelFitGroup.title = running ? 'Available when this run stops' : '';
}

function renderReadout() {
  syncModelFitGroup();
  drawReadout({
    responses,
    excluded,
    samplePeriodMs: analysisSamplePeriodMs,
    source: analysisSource,
    selected,
    model: currentModel(),
  });
}

// Dragging the Model card's pole changes the model itself.
let persistTimer: ReturnType<typeof setTimeout> | undefined;
onModelPoleChange((pole) => {
  adjustedPole = pole;
  pushModelToSimulation();
  fillModelCard();
  renderReadout();
  // A drag reports many positions a second; keep the one it settles on.
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistAnalysis, 300);
});

/** Selects a card: the model container and the detail plots follow it. */
function select(card: number | 'model') {
  selected = card;
  for (const button of filmstripEl.querySelectorAll<HTMLElement>('.response-inspect')) {
    button.setAttribute('aria-pressed', String(button.dataset.card === String(card)));
  }
  renderReadout();
  renderPlots();
  revealSelected();
}

/**
 * Scrolls the strip, and only the strip, until the selected card is in view.
 * scrollIntoView would also scroll the page, yanking it about mid-run.
 */
function revealSelected() {
  const card = filmstripEl.querySelector('.response-inspect[aria-pressed="true"]')?.closest<HTMLElement>('.response-card');
  if (!card) return;
  const strip = filmstripEl.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  if (box.left < strip.left) filmstripEl.scrollLeft -= strip.left - box.left;
  else if (box.right > strip.right) filmstripEl.scrollLeft += box.right - strip.right;
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
    n === 0 ? '' : n === 1 ? '1 step response' : `${n} step responses, ${isTouchFirst() ? 'tap' : 'select'} one to see details`;
  // Nothing to untick or inspect yet.
  responseCountNote.parentElement!.hidden = responseDetail.hidden = n === 0;
}

function renderFilmstrip() {
  renderResponseCount();
  if (responses.length === 0) {
    filmstripEl.innerHTML = '<p class="empty">Step responses appear here as you record, one per step.</p>';
    return;
  }

  const bounds = outlierBounds(responses);

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
    // in the model, and a button that inspects it. A button may not contain
    // interactive content, so they are siblings rather than nested.
    const card = document.createElement('div');
    card.className = 'response-card';
    card.dataset.excluded = String(excluded.has(i));
    card.dataset.outlier = kind ?? '';

    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'response-inspect';
    inspect.dataset.card = String(i);
    inspect.setAttribute('aria-pressed', String(i === selected));
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
    inspect.addEventListener('click', () => select(i));

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
      fillModelCard();
      renderReadout();
      renderPlots();
      persistAnalysis();
    });

    card.append(inspect, box);
    filmstripEl.appendChild(card);
    plotResponseSparkline(inspect.querySelector('canvas') as HTMLCanvasElement, t.response.xn, t.response.yn, leadOf(i));
  });

  // The Model card, always last: the model built from every included step
  // response. It has no checkbox -- it is defined by what is ticked.
  const card = document.createElement('div');
  card.className = 'response-card model-card';
  const inspect = document.createElement('button');
  inspect.type = 'button';
  inspect.className = 'response-inspect';
  inspect.dataset.card = 'model';
  inspect.setAttribute('aria-pressed', String(selected === 'model'));
  inspect.addEventListener('click', () => select('model'));
  card.append(inspect);
  filmstripEl.appendChild(card);
  fillModelCard();
  revealSelected();

  if (focusedIndex >= 0) {
    const card = filmstripEl.children[focusedIndex] as HTMLElement | undefined;
    const target = card?.querySelector<HTMLElement>(focusedWasCheckbox ? '.response-include' : '.response-inspect');
    target?.focus();
  }
}

/** The Model card's thumbnail and numbers, for what is ticked now. */
function fillModelCard() {
  const inspect = filmstripEl.querySelector<HTMLButtonElement>('.model-card .response-inspect');
  if (!inspect) return;
  const included = includedResponses();
  const model = currentModel();
  const d = model?.discrete;
  const zeta = model ? dampingMetrics(model.continuous).zeta : NaN;
  inspect.innerHTML =
    `<span class="name">Model</span><canvas></canvas>` +
    `<span class="response-stats"><span>${d ? `ζ ${zeta.toFixed(2)}` : '—'}</span>` +
    `<span>${included.length} step${included.length === 1 ? '' : 's'}</span></span>`;
  const ticked = `${included.length} ticked step response${included.length === 1 ? '' : 's'}`;
  inspect.title = !d
    ? 'Tick at least one step response to build the model'
    : model!.method === 'joint'
      ? `One model fitted to the ${ticked}`
      : `The median of the fits of the ${ticked}`;
  if (!d) return;
  // The model's response to a unit step, led in from rest like the others.
  const body = Math.max(2, ...included.map((t) => t.response.xn.length));
  const unit = new Float64Array(body).fill(1);
  const lead = Math.max(2, Math.round(body * LEAD_FRACTION));
  plotResponseSparkline(
    inspect.querySelector('canvas') as HTMLCanvasElement,
    unit,
    simulateSecondOrder(unit, d.P21, d.P22, d.D2),
    { xn: new Float64Array(lead), yn: new Float64Array(lead) },
    true,
  );
}

/**
 * @param force redraw even if the same subject is already plotted -- needed
 *              after a theme change, which the canvases cannot inherit.
 */
function renderPlots(force = false) {
  if (responses.length === 0) {
    showDetail(undefined, force);
    return;
  }
  if (selected !== 'model') {
    const i = selected;
    showDetail({ kind: 'step', t: responses[i], index: i, lead: leadOf(i), samplePeriodMs: analysisSamplePeriodMs }, force);
    return;
  }
  const steps = responses.map((t, i) => ({ t, lead: leadOf(i) })).filter((_, i) => !excluded.has(i));
  const fit = fittedModel();
  if (steps.length === 0 || !fit) {
    showDetail(undefined, force, 'Model details');
    return;
  }
  const model = fit.discrete;
  showDetail({ kind: 'model', model, adjusted: adjustedPole, steps, samplePeriodMs: analysisSamplePeriodMs }, force);
}

/** Shows which system the simulation and the ghost trace play back. */
function renderSimModelInfo() {
  const model: SimulationModel = experiment.getSimulationModel();
  const { wn, zeta } = dampingOf(model);
  const character = dampingCharacter(zeta);
  const overshoot = zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const source = identifiedYet ? 'the identified model' : 'built-in demo model; record a run to replace it';
  simModelInfo.textContent =
    `Model in use: ${source} — ωn ${wn.toFixed(2)} rad/s, ζ ${zeta.toFixed(2)} (${character}, ${overshoot.toFixed(0)}% overshoot)`;
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

closeOnBackdropClick(settingsDialog);

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

/** Repaint everything a CSS colour change cannot reach: the canvases. */
function repaintForTheme() {
  experiment.refreshTheme();
  renderReadout();
  renderFilmstrip();
  renderPlots(true);
}

// A printout is ink on white paper whatever the theme on screen, so the page
// is light while it prints -- the canvases repainted to match -- and goes
// back afterwards.
let themeBeforePrint: string | null | undefined;
window.addEventListener('beforeprint', () => {
  // Already printing: keep the theme it will go back to.
  if (themeBeforePrint !== undefined) return;
  themeBeforePrint = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'light');
  repaintForTheme();
});
window.addEventListener('afterprint', () => {
  if (themeBeforePrint === undefined) return;
  if (themeBeforePrint === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', themeBeforePrint);
  themeBeforePrint = undefined;
  repaintForTheme();
});

// Back from the background, the appearance may have changed with nothing
// said about it (iOS turns dark at night while Safari is asleep), so repaint.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') repaintForTheme();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) repaintForTheme();
});

connectSettings(() => {
  experiment.updateConfig(currentConfig());
  syncLegend();
}, repaintForTheme);

modelFitGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-fit]') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  modelFit = btn.dataset.fit === 'joint' ? 'joint' : 'median';
  pushModelToSimulation();
  renderResults();
  persistAnalysis();
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

/** What a list row shows, from the analysis on screen. */
function summarize(): SessionSummary {
  const included = includedResponses();
  const model = currentModel();
  if (!model) return { responses: responses.length, included: 0, zeta: NaN, wn: NaN, delayMs: NaN };
  const c = model.continuous;
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
  void safely(() =>
    updateSession(currentSessionId!, { excluded: [...excluded], adjustedPole, modelFit, summary: summarize() }),
  );
}

/** Puts samples on screen and identifies them, as an import or an opened session. */
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
  renderGuide(experiment.getPhase(), runMode);
}

function showSession(session: Session, status: string) {
  showSamples(session.xs, session.ys, session.samplePeriodMs, session.source, session.excluded);
  // After showSamples, which starts the model as a new session's: the median
  // of the fits, unadjusted.
  if (session.adjustedPole || session.modelFit === 'joint') {
    adjustedPole = session.adjustedPole ?? null;
    modelFit = session.modelFit === 'joint' ? 'joint' : 'median';
    pushModelToSimulation();
    renderResults();
  }
  currentSessionId = session.id;
  rememberOpen(session.id);
  setSessionName(sessionName(session));
  statusEl.textContent = status;
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

connectSessionTitle(() => currentSessionId);
connectSessions({
  currentId: () => currentSessionId,
  isRunning: () => experiment.isActive(),
  unsaved: () =>
    !lastSamples || currentSessionId !== null || experiment.isActive()
      ? null
      : { samples: lastSamples, source: plotSource, summary: summarize() },
  open: (session) => showSession(session, `Opened the session from ${whenLabel(session.createdAt)}`),
  renamed: (session) => {
    if (session.id === currentSessionId) setSessionName(sessionName(session));
  },
  deleted: (id) => {
    if (id !== currentSessionId) return;
    currentSessionId = null;
    rememberOpen(null);
    setSessionName('');
  },
});

syncLegend();
renderSimModelInfo();
renderResults();
// Otherwise Replay starts life dimmed with no tooltip to explain why: the
// availability pass only runs on a state change, and none has happened yet.
updateActionAvailability();
renderGuide('idle', runMode);
void restoreLatest();
