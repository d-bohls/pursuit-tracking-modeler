// Canvas plotting for the analysis panels.
//
// Every plot here sizes its own backing store to the element's real device
// pixels and reads its colours from CSS custom properties, so the same code
// draws correctly on a HiDPI screen, at any layout width, in either theme.

export interface FrequencyPlotSeries {
  /** |H[k]| of the DFT of the deconvolved impulse response, when there is one. */
  sampled?: Float64Array;
  /** Several measured spectra, drawn faintly; each spans 0..2pi at its own length. */
  others?: Float64Array[];
  /** Magnitude response of the fitted first-order model. */
  firstOrder: Float64Array;
  /** Magnitude response of the fitted second-order model. */
  secondOrder: Float64Array;
}

interface Chrome {
  surface: string;
  grid: string;
  axis: string;
  muted: string;
  /** The measurement -- your recorded response. */
  measured: string;
  /** The target, the step every step response responds to. */
  target: string;
  /** The second-order fit, and the identified model everywhere else. */
  second: string;
}

function chromeOf(canvas: HTMLCanvasElement): Chrome {
  const s = getComputedStyle(canvas);
  const read = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    surface: read('--plot-surface', '#ffffff'),
    grid: read('--plot-grid', '#e1e0d9'),
    axis: read('--plot-axis', '#c3c2b7'),
    muted: read('--plot-muted', '#898781'),
    measured: read('--series-you', '#eb6834'),
    target: read('--series-target', '#2a78d6'),
    second: read('--series-model', '#15946a'),
  };
}

/**
 * Sizes the backing store to the element's device pixels and scales the
 * context so everything below can be drawn in CSS pixels.
 */
function prepare(canvas: HTMLCanvasElement, surface: string) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);
  return { ctx, width: w, height: h };
}

/**
 * Blanks a plot. Needed because the canvases keep whatever was last drawn on
 * them: a caller that simply returns early when it has nothing to show leaves
 * the previous step response's plot on screen, claiming to describe data that is gone.
 */
export function clearPlot(canvas: HTMLCanvasElement) {
  prepare(canvas, chromeOf(canvas).surface);
}

/**
 * Overlays the measured frequency response and both fitted models on one
 * axis, over w = 0..2*pi. It is a goodness-of-fit picture, not just a
 * spectrum.
 */
export function plotFrequencyResponse(canvas: HTMLCanvasElement, series: FrequencyPlotSeries) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

  const n = series.secondOrder.length;
  if (n < 2) return;

  // Auto-scale from the sampled and second-order curves
  // (yMax = max(1, peaks) * 1.2). The first-order curve is deliberately left
  // out of the scaling: it can blow up at low frequency for a pole near 1 and
  // would otherwise flatten everything else.
  let yMax = 1;
  for (let i = 0; i < n; i++) {
    if (series.sampled && series.sampled[i] > yMax) yMax = series.sampled[i];
    if (series.secondOrder[i] > yMax) yMax = series.secondOrder[i];
  }
  for (const other of series.others ?? []) for (const v of other) if (v > yMax) yMax = v;
  yMax *= 1.2;

  const marginL = 44;
  const marginB = 34;
  const marginT = 12;
  const marginR = 12;
  const plotW = width - marginL - marginR;
  const plotH = height - marginB - marginT;

  const xAt = (k: number) => marginL + (k / (n - 1)) * plotW;
  const yAt = (v: number) => marginT + plotH - (Math.min(v, yMax) / yMax) * plotH;

  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginL, marginT);
  ctx.lineTo(marginL, marginT + plotH);
  ctx.lineTo(width - marginR, marginT + plotH);
  ctx.stroke();

  ctx.fillStyle = c.muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('0', marginL - 3, height - marginB + 14);
  ctx.fillText('π', marginL + plotW / 2 - 3, height - marginB + 14);
  ctx.fillText('2π', width - marginR - 10, height - marginB + 14);
  ctx.fillText('ω (rad/sample)', marginL + plotW / 2 - 38, height - marginB + 26);
  // The top of the axis sits close to 1 whenever the response barely peaks,
  // and there its label printed on top of the unity label. Unity wins: it is
  // the line a well-tracked step sits on.
  if (yAt(1) - (marginT + 5) > 12) ctx.fillText(yMax.toFixed(2), 6, marginT + 8);
  ctx.fillText('1.00', 6, yAt(1) + 3);
  ctx.fillText('0', 6, marginT + plotH + 3);

  const drawSeries = (data: Float64Array, color: string, lineWidth: number, dash: number[], alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    // Each series spans the axis at its own length, so spectra of step
    // responses of different lengths share it.
    const len = data.length;
    for (let k = 0; k < len; k++) {
      const v = data[k];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = xAt((k / Math.max(1, len - 1)) * (n - 1));
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  // Stacked target, then models, then what was measured, as on every plot:
  // your own data is never hidden under a model.
  // The target: |H| = 1 at every frequency, which is what perfect tracking
  // would give. In the target's blue, so the shared key holds on this plot too.
  ctx.strokeStyle = c.target;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(marginL, yAt(1));
  ctx.lineTo(width - marginR, yAt(1));
  ctx.stroke();

  drawSeries(series.firstOrder, c.muted, 2, [5, 4]);
  drawSeries(series.secondOrder, c.second, 2, []);
  for (const other of series.others ?? []) drawSeries(other, c.measured, 1.25, [], 0.45);
  if (series.sampled) drawSeries(series.sampled, c.measured, 2, []);
}

/**
 * Where the unit circle sits on a pole plot of this size, in CSS pixels.
 * Exported so pointer handling maps a press to z exactly as drawing maps z
 * to pixels.
 */
export function poleGeometry(width: number, height: number) {
  return { cx: width / 2, cy: height / 2, r: Math.min(width, height) / 2 - 16 };
}

/**
 * `ghost` is the fitted pole, drawn faintly while `poles` shows a dragged one,
 * so you can always see how far you have moved from what the data said.
 */
export function plotPoleLocations(
  canvas: HTMLCanvasElement,
  poles: Array<{ p1: number; p2: number }>,
  ghost?: { p1: number; p2: number },
  /** Other pole pairs to show for context, as small dots: each step's own fit. */
  others: Array<{ p1: number; p2: number }> = [],
) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

  const { cx, cy, r } = poleGeometry(width, height);

  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = c.grid;
  ctx.beginPath();
  ctx.moveTo(cx - r - 10, cy);
  ctx.lineTo(cx + r + 10, cy);
  ctx.moveTo(cx, cy - r - 10);
  ctx.lineTo(cx, cy + r + 10);
  ctx.stroke();

  ctx.fillStyle = c.muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('unit circle', cx - r, cy - r - 6);

  // Where a pair's two poles sit: a complex pair mirrored about the real
  // axis, a real pair (p2 < 0) both ON it, either side of p1.
  const points = (p1: number, p2: number): Array<[number, number]> =>
    p2 >= 0
      ? [
          [cx + p1 * r, cy - p2 * r],
          [cx + p1 * r, cy + p2 * r],
        ]
      : [
          [cx + (p1 - p2) * r, cy],
          [cx + (p1 + p2) * r, cy],
        ];

  const cross = (p1: number, p2: number, color: string, alpha: number) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const [x, y] of points(p1, p2)) {
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  ctx.fillStyle = c.measured;
  ctx.globalAlpha = 0.55;
  for (const { p1, p2 } of others) {
    for (const [x, y] of points(p1, p2)) {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  if (ghost) cross(ghost.p1, ghost.p2, c.muted, 0.7);
  for (const { p1, p2 } of poles) {
    // A faint ring says "this can be picked up" without a word of text.
    ctx.fillStyle = c.second;
    ctx.globalAlpha = 0.14;
    for (const [x, y] of points(p1, p2)) {
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    cross(p1, p2, c.second, 1);
  }
}

export interface StepPlotSeries {
  /** The step response's target: the step. */
  target: Float64Array;
  /** What was recorded in response, when one recording is shown. */
  measured?: Float64Array;
  /** Several recordings, drawn faintly; NaN where one has no sample. */
  others?: Float64Array[];
  /** The model's response to the same target. */
  model: Float64Array;
  /** The fitted model's response, drawn faintly while `model` is a dragged one. */
  fit?: Float64Array;
  samplePeriodMs: number;
  /** Samples from before the step at the start of every series; the step is t = 0. */
  stepIndex?: number;
}

/**
 * One step response in the time domain: the step, your response, and the model's
 * response to the very same step. The frequency plot says how well the model
 * fits; this one shows it, in the terms you tracked in.
 */
export function plotStepResponse(canvas: HTMLCanvasElement, series: StepPlotSeries) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

  const n = series.target.length;
  if (n < 2) return;

  const all = [
    series.target,
    series.model,
    ...(series.measured ? [series.measured] : []),
    ...(series.fit ? [series.fit] : []),
    ...(series.others ?? []),
  ];
  let lo = 0;
  let hi = 0;
  for (const data of all) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(data[i])) continue;
      lo = Math.min(lo, data[i]);
      hi = Math.max(hi, data[i]);
    }
  }
  const span = hi - lo || 1;
  lo -= span * 0.08;
  hi += span * 0.08;

  const marginL = 12;
  const marginR = 12;
  const marginT = 12;
  const marginB = 22;
  const plotW = width - marginL - marginR;
  const plotH = height - marginT - marginB;
  const xAt = (i: number) => marginL + (i / (n - 1)) * plotW;
  // Screen coordinates, larger is lower -- the same way up as the live plot.
  const yAt = (v: number) => marginT + ((v - lo) / (hi - lo)) * plotH;

  // The level the target stepped FROM, which every step response is measured against.
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginL, yAt(0));
  ctx.lineTo(width - marginR, yAt(0));
  ctx.stroke();

  // The step itself, marked as on the live plot and the thumbnails. It lands
  // somewhere between the last sample before it and the first after.
  const k = series.stepIndex ?? 0;
  const stepX = k > 0 ? xAt(k - 0.5) : marginL;
  if (k > 0) {
    ctx.strokeStyle = c.axis;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(stepX) + 0.5, marginT);
    ctx.lineTo(Math.round(stepX) + 0.5, marginT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = c.muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('0 s', k > 0 ? stepX - ctx.measureText('0 s').width / 2 : marginL, height - 7);
  const seconds = ((n - 1 - Math.max(0, k - 0.5)) * series.samplePeriodMs) / 1000;
  const end = `${seconds.toFixed(1)} s`;
  ctx.fillText(end, width - marginR - ctx.measureText(end).width, height - 7);

  const line = (data: Float64Array, color: string, lw: number, dash: number[], alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(data[i])) {
        started = false;
        continue;
      }
      if (!started) ctx.moveTo(xAt(i), yAt(data[i]));
      else ctx.lineTo(xAt(i), yAt(data[i]));
      started = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };
  // Target at the bottom, then the model, then what you did on top.
  line(series.target, c.target, 2, []);
  if (series.fit) line(series.fit, c.second, 1.5, [4, 3], 0.6);
  line(series.model, c.second, 2, []);
  for (const other of series.others ?? []) line(other, c.measured, 1.25, [], 0.45);
  if (series.measured) line(series.measured, c.measured, 2, []);
}

/**
 * The thumbnail on a step response card: this step response's step and the response to it,
 * on a shared scale. Small enough to read as a shape rather than a chart --
 * its job is to let you recognise a bad step response at a glance, before reading a
 * single number.
 */
/**
 * `lead` is a few samples from before the step, drawn ahead of the step response so
 * the thumbnail shows the step itself, with a dashed divider where it
 * happened -- the same mark the live plot draws.
 */
export function plotResponseSparkline(
  canvas: HTMLCanvasElement,
  responseXn: Float64Array,
  responseYn: Float64Array,
  lead?: { xn: Float64Array; yn: Float64Array },
  /** Draw the response in the model's colour: it is a model, not a recording. */
  asModel = false,
) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

  const before = lead ? Math.min(lead.xn.length, lead.yn.length) : 0;
  const join = (head: Float64Array | undefined, tail: Float64Array) => {
    const out = new Float64Array(before + tail.length);
    if (head) out.set(head.subarray(head.length - before));
    out.set(tail, before);
    return out;
  };
  const xn = join(lead?.xn, responseXn);
  const yn = join(lead?.yn, responseYn);

  const n = Math.min(xn.length, yn.length);
  if (n < 2) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, xn[i], yn[i]);
    hi = Math.max(hi, xn[i], yn[i]);
  }
  const span = hi - lo || 1;
  const pad = 4;
  const xAt = (i: number) => (i / (n - 1)) * width;
  // Samples are in screen coordinates, where larger is LOWER. Drawn the other
  // way up, every thumbnail was a mirror image of the step you tracked.
  const yAt = (v: number) => pad + ((v - lo) / span) * (height - pad * 2);

  if (before > 0) {
    // Halfway between the last sample before the step and the first after:
    // the step landed somewhere in that interval.
    const x = Math.round(xAt(before - 0.5)) + 0.5;
    ctx.strokeStyle = c.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const line = (data: Float64Array, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i);
      const y = yAt(data[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  line(xn, c.target);
  line(yn, asModel ? c.second : c.measured);
}
