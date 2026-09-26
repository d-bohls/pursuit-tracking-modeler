// Canvas plotting for the analysis panels.
//
// Every plot here sizes its own backing store to the element's real device
// pixels and reads its colours from CSS custom properties, so the same code
// draws correctly on a HiDPI screen, at any layout width, in either theme.

export interface FrequencyPlotSeries {
  /** |H[k]| of the DFT of the deconvolved impulse response. */
  sampled: Float64Array;
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
  /** The first-order fit. */
  first: string;
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
    first: read('--series-target', '#2a78d6'),
    second: read('--series-model', '#1baf7a'),
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
 * the previous trial's plot on screen, claiming to describe data that is gone.
 */
export function clearPlot(canvas: HTMLCanvasElement) {
  prepare(canvas, chromeOf(canvas).surface);
}

export function plotFrequencyResponse(canvas: HTMLCanvasElement, series: FrequencyPlotSeries) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

  const n = series.sampled.length;
  if (n < 2) return;

  let yMax = 1;
  for (let i = 0; i < n; i++) {
    if (series.sampled[i] > yMax) yMax = series.sampled[i];
    if (series.secondOrder[i] > yMax) yMax = series.secondOrder[i];
  }
  yMax *= 1.2;

  const marginL = 44;
  const marginB = 34;
  const marginT = 12;
  const marginR = 12;
  const plotW = width - marginL - marginR;
  const plotH = height - marginB - marginT;

  const xAt = (k: number) => marginL + (k / (n - 1)) * plotW;
  const yAt = (v: number) => marginT + plotH - (Math.min(v, yMax) / yMax) * plotH;

  // gridline at |H| = 1 (unity gain) -- the line a well-tracked step sits on
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginL, yAt(1));
  ctx.lineTo(width - marginR, yAt(1));
  ctx.stroke();

  ctx.strokeStyle = c.axis;
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
  ctx.fillText(yMax.toFixed(2), 6, marginT + 8);
  ctx.fillText('1.00', 6, yAt(1) + 3);
  ctx.fillText('0', 6, marginT + plotH + 3);

  const drawSeries = (data: Float64Array, color: string, lineWidth: number, dash: number[]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < n; k++) {
      const v = data[k];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = xAt(k);
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
  };

  drawSeries(series.firstOrder, c.first, 2, [5, 4]);
  drawSeries(series.secondOrder, c.second, 2, []);
  drawSeries(series.sampled, c.measured, 2, []);

  // legend, top-right so it stays clear of the low-frequency peak
  const legend: Array<[string, string, number[]]> = [
    ['Measured', c.measured, []],
    ['2nd-order fit', c.second, []],
    ['1st-order fit', c.first, [5, 4]],
  ];
  ctx.font = '11px system-ui, sans-serif';
  let ly = marginT + 12;
  const lx = width - marginR - 110;
  for (const [label, color, dash] of legend) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(lx, ly - 4);
    ctx.lineTo(lx + 18, ly - 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.muted;
    ctx.fillText(label, lx + 24, ly);
    ly += 15;
  }
}

export function plotPoleLocations(canvas: HTMLCanvasElement, poles: Array<{ p1: number; p2: number }>) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - 24;

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

  for (const { p1, p2 } of poles) {
    ctx.strokeStyle = c.second;
    ctx.lineWidth = 2;
    for (const y of [cy - p2 * r, cy + p2 * r]) {
      const x = cx + p1 * r;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
    }
  }
}

/**
 * The thumbnail on a trial card: this trial's step and the response to it,
 * on a shared scale. Small enough to read as a shape rather than a chart --
 * its job is to let you recognise a bad trial at a glance, before reading a
 * single number.
 */
export function plotTrialSparkline(canvas: HTMLCanvasElement, xn: Float64Array, yn: Float64Array) {
  const c = chromeOf(canvas);
  const { ctx, width, height } = prepare(canvas, c.surface);

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
  const yAt = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);

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

  line(xn, c.first);
  line(yn, c.measured);
}
