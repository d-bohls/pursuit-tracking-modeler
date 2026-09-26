
export interface FrequencyPlotSeries {
  /** |H[k]| of the DFT of the deconvolved impulse response. */
  sampled: Float64Array;
  /** Magnitude response of the fitted first-order model. */
  firstOrder: Float64Array;
  /** Magnitude response of the fitted second-order model. */
  secondOrder: Float64Array;
}

const COLOR_SAMPLED = '#1b4fa0';
const COLOR_FIRST = '#222222';
const COLOR_SECOND = '#c0392b';

export function plotFrequencyResponse(canvas: HTMLCanvasElement, series: FrequencyPlotSeries) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const n = series.sampled.length;
  if (n < 2) return;

  let yMax = 1;
  for (let i = 0; i < n; i++) {
    if (series.sampled[i] > yMax) yMax = series.sampled[i];
    if (series.secondOrder[i] > yMax) yMax = series.secondOrder[i];
  }
  yMax *= 1.2;

  const marginL = 48;
  const marginB = 30;
  const marginT = 12;
  const marginR = 12;
  const plotW = width - marginL - marginR;
  const plotH = height - marginB - marginT;

  const xAt = (k: number) => marginL + (k / (n - 1)) * plotW;
  const yAt = (v: number) => marginT + plotH - (Math.min(v, yMax) / yMax) * plotH;

  // gridline at |H| = 1 (unity gain) -- the line a well-tracked step sits on
  ctx.strokeStyle = '#e2e2e2';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginL, yAt(1));
  ctx.lineTo(width - marginR, yAt(1));
  ctx.stroke();

  ctx.strokeStyle = '#888';
  ctx.beginPath();
  ctx.moveTo(marginL, marginT);
  ctx.lineTo(marginL, marginT + plotH);
  ctx.lineTo(width - marginR, marginT + plotH);
  ctx.stroke();

  ctx.fillStyle = '#555';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('0', marginL - 3, height - marginB + 14);
  ctx.fillText('π', marginL + plotW / 2 - 3, height - marginB + 14);
  ctx.fillText('2π', width - marginR - 10, height - marginB + 14);
  ctx.fillText('ω (rad/sample)', marginL + plotW / 2 - 38, height - marginB + 26);
  ctx.fillText(yMax.toFixed(2), 6, marginT + 8);
  ctx.fillText('1.00', 6, yAt(1) + 3);
  ctx.fillText('0', 6, marginT + plotH + 3);

  const drawSeries = (data: Float64Array, color: string, lineWidth: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
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
  };

  drawSeries(series.sampled, COLOR_SAMPLED, 1.5);
  drawSeries(series.firstOrder, COLOR_FIRST, 1.2);
  drawSeries(series.secondOrder, COLOR_SECOND, 1.5);

  // legend, top-right so it stays clear of the low-frequency peak
  const legend: Array<[string, string]> = [
    ['Sampled response', COLOR_SAMPLED],
    ['1st-order model', COLOR_FIRST],
    ['2nd-order model', COLOR_SECOND],
  ];
  ctx.font = '11px system-ui, sans-serif';
  let ly = marginT + 12;
  const lx = width - marginR - 130;
  for (const [label, color] of legend) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx, ly - 4);
    ctx.lineTo(lx + 18, ly - 4);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.fillText(label, lx + 24, ly);
    ly += 15;
  }
}

export function plotPoleLocations(canvas: HTMLCanvasElement, poles: Array<{ p1: number; p2: number }>) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - 24;

  ctx.strokeStyle = '#bbb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r - 10, cy);
  ctx.lineTo(cx + r + 10, cy);
  ctx.moveTo(cx, cy - r - 10);
  ctx.lineTo(cx, cy + r + 10);
  ctx.stroke();

  ctx.fillStyle = '#777';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('unit circle', cx - r, cy - r - 6);

  for (const { p1, p2 } of poles) {
    ctx.strokeStyle = COLOR_SECOND;
    ctx.lineWidth = 2;
    for (const y of [cy - p2 * r, cy + p2 * r]) {
      const x = cx + p1 * r;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
    }
  }
}
