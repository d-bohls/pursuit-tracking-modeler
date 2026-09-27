// End-to-end smoke test of the production build: serves it to a real
// browser, feeds it the reference recording through the file
// picker, and checks the rendered model matches the numbers the engine
// produces headlessly. Catches UI wiring bugs that the Node-side validation
// can't see.
//
//   node test/smoke-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();
const dataPath = join(root, 'test/data/reference-data.txt');

// The UI reports the MEDIAN model -- see SIM_SOURCE in src/main.ts. This is
// the string `npm run validate` prints for the same recording.
const EXPECTED_MEDIAN_2ND_ORDER = 'y[n]-(1.7880)y[n-1]+(0.9406)y[n-2]=(0.1526)x[n-7.5]';

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

// Save and the sample dump live in the Recorded data modal now.
const openData = async () => {
  await page.locator('#dataBtn').click();
  await page.waitForTimeout(200);
};
const closeData = async () => {
  await page.locator('#dataDialog button[value="close"]').click();
  await page.waitForTimeout(200);
};

// 2. the empty state is honest: nothing to save, no trials, no model
await openData();
if (!(await page.locator('#saveDataBtn').isDisabled())) {
  fail('save button should start disabled with no recording');
}
await closeData();
if ((await page.locator('.trial-card').count()) !== 0) fail('trial cards present before any data');
if (!/Record a few steps/.test((await page.locator('#readout').textContent()) ?? '')) {
  fail('readout did not show its empty state');
}

// 3. load the real recording through the file picker
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(2500);

const status = await page.locator('#status').textContent();
if (!/Loaded 437 samples/.test(status ?? '')) fail(`unexpected load status: ${status}`);

await openData();
const samplesText = await page.locator('#samplesOut').inputValue();
if (!samplesText.startsWith('n\tx[n]\ty[n]')) fail('samples pane did not populate');
if (await page.locator('#saveDataBtn').isDisabled()) fail('save should be enabled once data is loaded');
await closeData();

// 4. one card per trial, and the summary model matches the engine
const cards = await page.locator('.trial-card').count();
if (cards !== 10) fail(`expected 10 trial cards, got ${cards}`);

// The display typesets the equation, so hold it to the engine string it carries.
const modelOf = () => page.locator('.diffeq').getAttribute('data-equation');
const equation = (await modelOf()) ?? '';
const details = (await page.locator('.details-line').textContent()) ?? '';
if (equation !== EXPECTED_MEDIAN_2ND_ORDER) {
  fail(`median second-order model mismatch.\n  expected: ${EXPECTED_MEDIAN_2ND_ORDER}\n  got: ${equation}`);
}

// 5. the headline readout rendered, in units a human can read
const tiles = await page.locator('.tile-value').allTextContents();
if (tiles.length !== 4) fail(`expected 4 readout tiles, got ${tiles.length}`);

// Units guard. The continuous poles and the delays must share one time unit
// (seconds / rad/s).
const wn = Number(tiles.find((t) => /rad\/s/.test(t))?.replace(/[^\d.]/g, ''));
const tau = Number(details.match(/τ = ([-\d.]+) s/)?.[1]);
if (!(wn > 0.1 && wn < 100)) fail(`natural frequency ${wn} rad/s is not physically plausible (unit mismatch?)`);
if (!(tau > 0.01 && tau < 10)) fail(`first-order time constant ${tau} s is not physically plausible (unit mismatch?)`);

// 6. excluding a trial re-derives the summary from what is left, and putting
// it back restores the original model exactly
const before = await modelOf();
await page.locator('.trial-card input').first().uncheck();
await page.waitForTimeout(300);
const excluded = await modelOf();
if (excluded === before) fail('excluding a trial did not change the identified model');
if (!/1 excluded/.test((await page.locator('#readoutSource').textContent()) ?? '')) {
  fail('readout did not report the excluded trial');
}
await page.locator('.trial-card input').first().check();
await page.waitForTimeout(300);
if ((await modelOf()) !== before) {
  fail('re-including the trial did not restore the model');
}

// 7. the plots actually drew something (non-blank canvases)
// .first(): the sparkline selector matches every trial card, and a bare
// locator with more than one match is a strict-mode error.
const canvasHasInk = (selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((c) => {
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const [r0, g0, b0] = [data[0], data[1], data[2]];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0) return true;
    }
    return false;
  });
if (!(await canvasHasInk('#freqGraph'))) fail('frequency response canvas is blank');
if (!(await canvasHasInk('#poleGraph'))) fail('pole plot canvas is blank');
if (!(await canvasHasInk('.trial-card canvas'))) fail('trial sparkline is blank');
if (!(await canvasHasInk('#stepGraph'))) fail('step response canvas is blank');

// 7b. dragging the pole is exploration: moving it off the fit makes the fit
// worse (that is what "best fit" means), and Escape puts it back exactly.
const errOf = async () => Number(((await page.locator('#poleReadout').textContent()) ?? '').match(/([\d.]+)% err/)?.[1]);
const atFit = await errOf();
await page.locator('#poleGraph').focus();
await page.keyboard.press('Shift+ArrowLeft');
await page.keyboard.press('Shift+ArrowLeft');
const moved = await errOf();
if (!(moved > atFit)) fail(`moving the pole off the fit did not raise the error (${atFit}% -> ${moved}%)`);
if (await page.locator('#poleResetBtn').isHidden()) fail('"Back to the fit" did not appear after moving the pole');
await page.keyboard.press('Escape');
if ((await errOf()) !== atFit) fail('Escape did not return the pole to the fit');
if ((await modelOf()) !== before) fail('dragging the pole changed the identified model');

// 8. dark mode repaints the canvases too -- they cannot inherit CSS colours
const surfaceOf = (selector) =>
  page.locator(selector).evaluate((c) => {
    const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  });
// Compare the two pinned themes against each other rather than against the
// default, which follows the OS and so differs between machines.
await page.locator('#settingsBtn').click();
await page.waitForTimeout(200);
await page.locator('#themeGroup button[data-theme="light"]').click();
await page.waitForTimeout(400);
const lightSurface = await surfaceOf('#freqGraph');
await page.locator('#themeGroup button[data-theme="dark"]').click();
await page.waitForTimeout(400);
const darkSurface = await surfaceOf('#freqGraph');
await page.locator('#settingsDialog button[value="close"]').click();
if (lightSurface === darkSurface) fail(`plot surface did not follow the theme (both ${lightSurface})`);

if (consoleErrors.length) fail(`console errors during run: ${consoleErrors.join(' | ')}`);

await browser.close();
await app.close();

if (process.exitCode) {
  console.error('\nSmoke test FAILED');
} else {
  console.log('Smoke test passed:');
  console.log('  - page loads clean with no console errors');
  console.log('  - empty state renders before any data');
  console.log('  - 437 samples loaded through the file picker');
  console.log('  - 10 trial cards rendered');
  console.log(`  - median model matches engine output: ${EXPECTED_MEDIAN_2ND_ORDER}`);
  console.log('  - excluding and restoring a trial re-derives the model');
  console.log('  - step, frequency, pole and sparkline canvases drew, and follow the theme');
  console.log('  - moving the pole off the fit raises the error, and Escape restores it');
}
