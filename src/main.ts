import './style.css';
import { TrackingExperiment, dampingOf, DEFAULT_SIMULATION_MODEL, type ExperimentConfig, type SimulationMode, type SimulationModel } from './ui/experiment';
import { plotFrequencyResponse, plotPoleLocations } from './ui/plotting';
import { analyzeExperiment, firstOrderDifferenceEquation, secondOrderDifferenceEquation, continuousFirstOrderTf, continuousSecondOrderTf, dampingMetrics, firstOrderMagnitudeResponse, secondOrderMagnitudeResponse, type AnalysisResult } from './engine/analysis';
import { dft } from './engine/dsp';
import { magnitudeOfComplex } from './engine/complex';
import { parseRecording, formatAllSamplesBlock } from './engine/dataFormat';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const graphCanvas = $<HTMLCanvasElement>('graph');
const analyzeBtn = $<HTMLButtonElement>('analyzeBtn');
const loadDataBtn = $<HTMLButtonElement>('loadDataBtn');
const saveDataBtn = $<HTMLButtonElement>('saveDataBtn');
const fileInput = $<HTMLInputElement>('fileInput');
const samplesOut = $<HTMLTextAreaElement>('samplesOut');
const graphHint = $<HTMLParagraphElement>('graphHint');
const simModelInfo = $<HTMLParagraphElement>('simModelInfo');

const trialPeriodInput = $<HTMLInputElement>('trialPeriod');
const samplePeriodInput = $<HTMLInputElement>('samplePeriod');
const simulationModeSelect = $<HTMLSelectElement>('simulationMode');
const discretePointsCheckbox = $<HTMLInputElement>('discretePoints');

const analyzeDialog = $<HTMLDialogElement>('analyzeDialog');
const closeAnalyzeBtn = $<HTMLButtonElement>('closeAnalyze');
const resultsTableBody = document.querySelector('#resultsTable tbody') as HTMLTableSectionElement;
const continuousTf = $<HTMLPreElement>('continuousTf');
const trialSelect = $<HTMLSelectElement>('trialSelect');
const freqGraph = $<HTMLCanvasElement>('freqGraph');
const poleGraph = $<HTMLCanvasElement>('poleGraph');

let lastSamples: { xs: Float64Array; ys: Float64Array } | null = null;
let lastAnalysis: AnalysisResult | null = null;

function currentConfig(): ExperimentConfig {
  return {
    trialPeriodMs: clamp(Number(trialPeriodInput.value) || 4000, 1000, 10000),
    samplePeriodMs: clamp(Number(samplePeriodInput.value) || 100, 50, 500),
    scrollPeriodMs: 50,
    simulationMode: simulationModeSelect.value as SimulationMode,
    discretePoints: discretePointsCheckbox.checked,
  };
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

const experiment = new TrackingExperiment(graphCanvas, currentConfig(), {
  onHint: (text) => (graphHint.textContent = text),
  onEnd: ({ xs, ys }) => {
    lastSamples = { xs, ys };
    displaySamples(xs, ys);
    analyzeBtn.disabled = false;
    saveDataBtn.disabled = xs.length === 0;
  },
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

[trialPeriodInput, samplePeriodInput, simulationModeSelect, discretePointsCheckbox].forEach((el) =>
  el.addEventListener('change', () => experiment.updateConfig(currentConfig())),
);

function displaySamples(xs: Float64Array, ys: Float64Array) {
  const lines = ['n\tx[n]\ty[n]', '======================='];
  for (let i = 0; i < xs.length; i++) {
    lines.push(`${i}\t${xs[i].toFixed(3)}\t${ys[i].toFixed(3)}`);
  }
  samplesOut.value = lines.join('\n');
}

loadDataBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const { xs, ys } = parseRecording(text);
    lastSamples = { xs, ys };
    displaySamples(xs, ys);
    analyzeBtn.disabled = false;
    saveDataBtn.disabled = false;
    graphHint.textContent = `Loaded ${xs.length} samples from ${file.name}.`;
  } catch (err) {
    alert((err as Error).message);
  }
});

analyzeBtn.addEventListener('click', () => {
  if (!lastSamples) return;
  const samplePeriodMs = currentConfig().samplePeriodMs;
  lastAnalysis = analyzeExperiment(lastSamples.xs, lastSamples.ys, samplePeriodMs);

  // Hand the identified system to the simulation modes. Without it the simulation
  // replays the built-in demo pole forever.
  const simSource = SIM_SOURCE === 'median' ? lastAnalysis.medianContinuous : lastAnalysis.averageContinuous;
  experiment.setSimulationModel({
    P11: simSource.P11,
    D1: simSource.D1,
    P21: simSource.P21,
    P22: simSource.P22,
    D2: simSource.D2,
  });
  identifiedYet = true;
  renderSimModelInfo();

  renderAnalysis(lastAnalysis);
  analyzeDialog.showModal();
});

let identifiedYet = false;
const SIM_SOURCE: 'mean' | 'median' = 'median';

/** Shows which system the simulation modes will play back, and how damped it is. */
function renderSimModelInfo() {
  const model: SimulationModel = experiment.getSimulationModel();
  const { wn, zeta } = dampingOf(model);
  const character = zeta < 1 ? 'underdamped' : zeta === 1 ? 'critically damped' : 'overdamped';
  const overshoot = zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const source = identifiedYet ? `your identified model (${SIM_SOURCE} of trials)` : 'built-in demo model (run identification to replace)';
  simModelInfo.textContent =
    `Simulating: ${source} — ωn ${wn.toFixed(2)} rad/s, ζ ${zeta.toFixed(3)} (${character}, ${overshoot.toFixed(0)}% overshoot)`;
}

closeAnalyzeBtn.addEventListener('click', () => analyzeDialog.close());

function renderAnalysis(result: AnalysisResult) {
  resultsTableBody.innerHTML = '';
  trialSelect.innerHTML = '';

  if (result.trials.length === 0) {
    resultsTableBody.innerHTML = '<tr><td colspan="6">There are no trials to analyze. Run the experiment first.</td></tr>';
    return;
  }

  // A trial fitting far worse than its peers is not a measurement of the same
  // thing -- flag it, because a plain mean has no defence against it.
  const errors = result.trials.map((t) => t.fit2Rms);
  const sortedErrors = [...errors].sort((a, b) => a - b);
  const medianError = sortedErrors[Math.floor(sortedErrors.length / 2)];
  const outlierCutoff = medianError * 3;
  let outliers = 0;

  result.trials.forEach((t, i) => {
    const { zeta, overshoot } = dampingMetrics(t.continuous);
    const err = errors[i];
    const isOutlier = err > outlierCutoff;
    if (isOutlier) outliers++;

    const row = document.createElement('tr');
    if (isOutlier) row.className = 'outlier';
    row.innerHTML =
      `<td>${i + 1}${isOutlier ? ' ⚠' : ''}</td>` +
      `<td>${secondOrderDifferenceEquation(t.discrete)}</td>` +
      `<td>${zeta.toFixed(3)}</td>` +
      `<td>${overshoot.toFixed(0)}%</td>` +
      `<td>${t.discrete.D2}</td>` +
      `<td>${err.toFixed(1)} px</td>`;
    resultsTableBody.appendChild(row);

    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Trial ${i + 1}${isOutlier ? ' (poor fit)' : ''}`;
    trialSelect.appendChild(opt);
  });

  const summary = (label: string, d: typeof result.averageDiscrete, c: typeof result.averageContinuous) => {
    const { zeta, overshoot } = dampingMetrics(c);
    const row = document.createElement('tr');
    row.className = 'summary-row';
    row.innerHTML =
      `<td>${label}</td><td>${secondOrderDifferenceEquation(d)}</td>` +
      `<td>${zeta.toFixed(3)}</td><td>${overshoot.toFixed(0)}%</td><td>${d.D2.toFixed(1)}</td><td>—</td>`;
    resultsTableBody.appendChild(row);
  };
  summary('Mean', result.averageDiscrete, result.averageContinuous);
  summary('Median', result.medianDiscrete, result.medianContinuous);

  const meanM = dampingMetrics(result.averageContinuous);
  const medM = dampingMetrics(result.medianContinuous);
  const warn =
    outliers > 0
      ? `\n\n⚠ ${outliers} of ${result.trials.length} trials fit more than 3x worse than the others and are flagged above. ` +
        `They pull the mean: ζ ${meanM.zeta.toFixed(3)} (${meanM.overshoot.toFixed(0)}% overshoot) vs median ` +
        `ζ ${medM.zeta.toFixed(3)} (${medM.overshoot.toFixed(0)}%). The simulation uses the ${SIM_SOURCE} model.`
      : '';

  // Report the model that is actually simulated, not a different one -- the
  // panel used to print the mean while the simulation ran off the median.
  const shown = SIM_SOURCE === 'median' ? result.medianContinuous : result.averageContinuous;
  continuousTf.textContent =
    `Identified from the ${SIM_SOURCE} of ${result.trials.length} trials (this is what Simulation mode plays back):\n\n` +
    `First-order:\n${continuousFirstOrderTf(shown)}\n\n` +
    `Second-order:\n${continuousSecondOrderTf(shown)}` + warn;

  trialSelect.value = '0';
  renderTrialPlots(result, 0);
}

trialSelect.addEventListener('change', () => {
  if (lastAnalysis) renderTrialPlots(lastAnalysis, Number(trialSelect.value));
});

function renderTrialPlots(result: AnalysisResult, index: number) {
  const t = result.trials[index];
  if (!t) return;

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

renderSimModelInfo();
