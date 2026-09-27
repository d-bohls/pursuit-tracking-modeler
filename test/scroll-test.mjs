// Drives the LIVE tracking experiment in a real browser and measures the
// trace it draws. The analysis can be perfect while the plot is unreadable:
// a canvas scrolled by drawing it onto itself with 'source-over' compositing
// never erases old frames, and the plot accumulates into a smear.
//
// Two properties are asserted, matching the two halves of that failure:
//   1. the trace SCROLLS   -- inked width tracks elapsed time * scroll rate
//   2. the trace is THIN   -- a scrolling trace puts a couple of pixels in
//                             each column; a smear puts hundreds
//
//   node test/scroll-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();

const RUN_MS = 6000;
const VISIBLE_MS = 20_000; // must match VISIBLE_MS in src/ui/experiment.ts
const LEAD_ANCHOR = 0.8; // must match LEAD_ANCHOR in src/ui/experiment.ts

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(app.url);

const box = await page.locator('#graph').boundingBox();
const cx = box.x + box.width / 2;

// Start from the Record button on the plot. Pressing the plot itself no
// longer starts or stops a run -- it offers a Stop prompt instead.
await page.locator('#recordBtn').click();
await page.mouse.move(cx, box.y + box.height / 2);

const started = Date.now();
while (Date.now() - started < RUN_MS) {
  const t = (Date.now() - started) / 1000;
  // Deliberately human-paced: a person tracking a step target moves a few
  // pixels per 50ms scroll tick, not tens. A faster synthetic sweep puts ~16px
  // of legitimate ink in every column and would swamp the smear threshold.
  const y = box.y + box.height / 2 + Math.sin(t * 0.8) * (box.height * 0.18);
  await page.mouse.move(cx, y);
  await page.waitForTimeout(25);
}
const elapsed = Date.now() - started;
await page.keyboard.press('Space'); // explicit stop

// Measure ink: for each column, how many DATA pixels?
//
// "Data pixel" means chromatic -- the series palette is saturated blue /
// orange / aqua, while every piece of chrome (surface, centre line, step response
// dividers) is neutral grey. Thresholding on darkness instead would count the
// full-width centre line in every column and make the scroll check vacuous.
const stats = await page.locator('#graph').evaluate((c) => {
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const perColumn = [];
  for (let x = 0; x < c.width; x++) {
    let n = 0;
    for (let y = 0; y < c.height; y++) {
      const i = (y * c.width + x) * 4;
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      if (max - min > 30) n++;
    }
    perColumn.push(n);
  }
  const inked = perColumn.filter((n) => n > 0);
  const sorted = [...inked].sort((a, b) => a - b);
  return {
    width: c.width,
    height: c.height,
    inkedColumns: inked.length,
    medianDensity: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    maxDensity: inked.length ? Math.max(...inked) : 0,
    firstInkedColumn: perColumn.findIndex((n) => n > 0),
  };
});

await browser.close();
await app.close();

// The pen is pinned at LEAD_ANCHOR and history runs back from it, so the
// inked span grows at one full width per VISIBLE_MS until it fills the
// anchor's share of the canvas -- it never reaches the full width.
const expectedScrolled = Math.min(elapsed / VISIBLE_MS, LEAD_ANCHOR) * stats.width;
let failed = false;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  failed = true;
};

console.log(`ran ${(elapsed / 1000).toFixed(1)}s -> expected ~${Math.round(expectedScrolled)}px of scroll`);
console.log(`inked columns   : ${stats.inkedColumns} of ${stats.width}`);
console.log(`median density  : ${stats.medianDensity} px per inked column`);
console.log(`max density     : ${stats.maxDensity} px`);

// 1. did it actually scroll? allow generous slack for timer scheduling.
if (stats.inkedColumns < expectedScrolled * 0.5) {
  fail(`trace only spans ${stats.inkedColumns}px after ${(elapsed / 1000).toFixed(1)}s; expected ~${Math.round(expectedScrolled)}px. Not scrolling.`);
}

// 2. is it a thin trace rather than a smear? two 1px traces per column, plus
//    antialiasing and the occasional steep segment, should stay well under 20.
if (stats.medianDensity > 20) {
  fail(`median column holds ${stats.medianDensity} inked pixels -- that is a smear, not a trace.`);
}

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);

if (failed) {
  console.error('\nScroll test FAILED');
  process.exitCode = 1;
} else {
  console.log('\nScroll test passed: trace scrolls at the expected rate and stays thin.');
}
