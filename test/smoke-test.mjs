// End-to-end smoke test of the production build: serves it to a real
// browser, feeds it the reference recording through the file
// picker, runs the analysis, and checks the rendered model matches the
// numbers the engine produces headlessly. Catches UI wiring bugs that the
// Node-side validation can't see.
//
//   node test/smoke-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();
const dataPath = join(root, 'test/data/reference-data.txt');

const EXPECTED_MEAN_2ND_ORDER = 'y[n]-(1.7908)y[n-1]+(0.9446)y[n-2]=(0.1538)x[n-7.8]';

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(app.url);
await page.waitForTimeout(300);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

// 1. page loaded without script errors
if (consoleErrors.length) fail(`console errors on load: ${consoleErrors.join(' | ')}`);

// 2. the canvas exists and the analyze button starts disabled
const analyzeDisabled = await page.locator('#analyzeBtn').isDisabled();
if (!analyzeDisabled) fail('analyze button should start disabled with no data loaded');

// 3. load the real recording through the file picker
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(500);

const hint = await page.locator('#graphHint').textContent();
if (!/Loaded 437 samples/.test(hint ?? '')) fail(`unexpected load hint: ${hint}`);

const samplesText = await page.locator('#samplesOut').inputValue();
if (!samplesText.startsWith('n\tx[n]\ty[n]')) fail('samples pane did not populate');

// 4. run the analysis
await page.locator('#analyzeBtn').click();
await page.waitForTimeout(1500);

const dialogOpen = await page.locator('#analyzeDialog').evaluate((d) => d.open);
if (!dialogOpen) fail('analysis dialog did not open');

const rows = await page.locator('#resultsTable tbody tr').count();
if (rows !== 12) fail(`expected 10 trial rows + mean + median, got ${rows}`);

const meanRow = await page.locator('#resultsTable tbody tr').nth(10).textContent();
if (!meanRow?.includes(EXPECTED_MEAN_2ND_ORDER)) {
  fail(`mean second-order model mismatch.\n  expected to contain: ${EXPECTED_MEAN_2ND_ORDER}\n  got: ${meanRow}`);
}

const tf = await page.locator('#continuousTf').textContent();
if (!/natural frequency/.test(tf ?? '') || !/damping ratio/.test(tf ?? '')) {
  fail(`continuous transfer function panel did not render: ${tf}`);
}

// Units guard. The continuous poles and the delays must share one time unit
// (seconds / rad/s).
const tau = Number((tf ?? '').match(/time constant τ = ([-\d.]+) s/)?.[1]);
const wn = Number((tf ?? '').match(/natural frequency ωn = ([-\d.]+) rad\/s/)?.[1]);
if (!(tau > 0.01 && tau < 10)) fail(`first-order time constant ${tau} s is not physically plausible (unit mismatch?)`);
if (!(wn > 0.1 && wn < 100)) fail(`natural frequency ${wn} rad/s is not physically plausible (unit mismatch?)`);

// 5. the plots actually drew something (non-blank canvases)
const canvasHasInk = (selector) =>
  page.locator(selector).evaluate((c) => {
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) return true;
    }
    return false;
  });
if (!(await canvasHasInk('#freqGraph'))) fail('frequency response canvas is blank');
if (!(await canvasHasInk('#poleGraph'))) fail('pole plot canvas is blank');

if (consoleErrors.length) fail(`console errors during run: ${consoleErrors.join(' | ')}`);

await browser.close();
await app.close();

if (process.exitCode) {
  console.error('\nSmoke test FAILED');
} else {
  console.log('Smoke test passed:');
  console.log('  - page loads clean with no console errors');
  console.log('  - 437 samples loaded through the file picker');
  console.log('  - 10 trials + mean row rendered');
  console.log(`  - mean model matches engine output: ${EXPECTED_MEAN_2ND_ORDER}`);
  console.log('  - continuous H(s) panel and both plots rendered');
}
