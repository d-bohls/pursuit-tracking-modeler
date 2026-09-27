// End-to-end smoke test of the production build: serves it to a real
// browser, feeds it the reference recording through the file
// picker, and checks the rendered model matches the numbers the engine
// produces headlessly.
//
// With --iphone it runs in WebKit as an iPhone, the engine behind iOS Safari.
//
//   node test/smoke-test.mjs [--iphone]

import { chromium, webkit, devices } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();
const dataPath = join(root, 'test/data/reference-data.txt');

// The UI reports the MEDIAN model; this is the engine's string for it.
const EXPECTED_MEDIAN_2ND_ORDER = 'y[n]-(1.7880)y[n-1]+(0.9406)y[n-2]=(0.1526)x[n-7.5]';

const onIPhone = process.argv.includes('--iphone');
const browser = await (onIPhone ? webkit : chromium).launch();
const page = await browser.newPage(onIPhone ? devices['iPhone 13'] : {});

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

// The Sessions list, and one session's samples, each in a modal.
const openData = async () => {
  await page.locator('#sessionsBtn').click();
  await page.waitForTimeout(200);
};
const closeData = async () => {
  await page.locator('#sessionsDialog button[value="close"]').click();
  await page.waitForTimeout(200);
};

// 2. the empty state is honest: nothing kept, no step responses, no model
await openData();
if ((await page.locator('#sessionList .session-row').count()) !== 0) fail('sessions listed before any data');
await closeData();
if ((await page.locator('.response-card').count()) !== 0) fail('response cards present before any data');
if (!/Record a few step responses/.test((await page.locator('#readout').textContent()) ?? '')) {
  fail('readout did not show its empty state');
}

// 3. load the real recording through the file picker
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(2500);

const status = await page.locator('#status').textContent();
if (!/Loaded 437 samples/.test(status ?? '')) fail(`unexpected load status: ${status}`);

await openData();
await page.locator('#sessionList .session-data').first().click();
await page.waitForTimeout(200);
const samplesText = await page.locator('#samplesOut').inputValue();
if (!samplesText.startsWith('n\tx[n]\ty[n]')) fail('samples view did not populate');
if (!/437 samples · one every 100 ms/.test((await page.locator('#samplesMeta').textContent()) ?? '')) {
  fail(`samples view summary is wrong: "${await page.locator('#samplesMeta').textContent()}"`);
}
if (await page.locator('#saveDataBtn').isDisabled()) fail('export should be available in the samples view');
await page.locator('#samplesDialog button[value="close"]').click();
await page.waitForTimeout(200);
if (!(await page.locator('#sessionsDialog').isVisible())) fail('closing the samples view should return to the list');
await closeData();

// 4. one card per step response, and the summary model matches the engine
const cards = await page.locator('.response-card').count();
if (cards !== 10) fail(`expected 10 response cards, got ${cards}`);

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
// (seconds / rad/s). Getting this wrong is a silent 1000x error whose only
// visible symptom is physically absurd numbers, so assert plausibility:
// human tracking sits around tau ~ 0.1-1 s and wn ~ 1-20 rad/s.
const wn = Number(tiles.find((t) => /rad\/s/.test(t))?.replace(/[^\d.]/g, ''));
const tau = Number(details.match(/τ = ([-\d.]+) s/)?.[1]);
if (!(wn > 0.1 && wn < 100)) fail(`natural frequency ${wn} rad/s is not physically plausible (unit mismatch?)`);
if (!(tau > 0.01 && tau < 10)) fail(`first-order time constant ${tau} s is not physically plausible (unit mismatch?)`);

// 6. excluding a step response re-derives the summary from what is left, and putting
// it back restores the original model exactly
const before = await modelOf();
await page.locator('.response-card input').first().uncheck();
await page.waitForTimeout(300);
const excluded = await modelOf();
if (excluded === before) fail('excluding a response did not change the identified model');
if (!/1 excluded/.test((await page.locator('#readoutSource').textContent()) ?? '')) {
  fail('readout did not report the excluded response');
}
await page.locator('.response-card input').first().check();
await page.waitForTimeout(300);
if ((await modelOf()) !== before) {
  fail('re-including the response did not restore the model');
}

// 7. the plots actually drew something (non-blank canvases)
// .first(): the sparkline selector matches every step response card, and a bare
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
if (!(await canvasHasInk('.response-card canvas'))) fail('response sparkline is blank');
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

// 7c. a replay runs at the speed it was RECORDED at, not at today's setting.
// The reference file is 100 ms per sample; with Settings at 50 ms, pacing by the
// setting played it at double speed.
await page.locator('#settingsBtn').click();
await page.locator('#samplePeriod').fill('50');
await page.locator('#samplePeriod').dispatchEvent('change');
await page.locator('#settingsDialog button[value="close"]').click();
await page.locator('#replayBtn').click();
await page.waitForTimeout(2200);
const replayPct = Number(((await page.locator('#status').textContent()) ?? '').match(/Replaying · (\d+)%/)?.[1]);
await page.keyboard.press('Space');
await page.waitForTimeout(300);
// ~2.2 s of a 43.7 s recording is ~5%; paced at 50 ms it would read ~10%.
if (!(replayPct >= 3 && replayPct <= 7)) fail(`replay ran at the wrong speed: ${replayPct}% after 2.2 s`);
await page.locator('#settingsBtn').click();
await page.locator('#samplePeriod').fill('100');
await page.locator('#samplePeriod').dispatchEvent('change');
await page.locator('#settingsDialog button[value="close"]').click();

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

// The step interval slider: a number under it jumps there, the arrow keys
// step by half seconds, and the value survives a reload.
await page.locator('#settingsBtn').click();
await page.locator('#paceGroup button[data-pace="7000"]').click();
await page.locator('#stepPeriod').press('ArrowRight');
const paceShown = await page.locator('#stepPeriodOut').textContent();
const paceActive = await page.locator('#paceGroup button[data-active="true"]').count();
await page.locator('#settingsDialog button[value="close"]').click();
if (paceShown !== '7.5 s') fail(`slider readout after 7 then ArrowRight: ${paceShown}, expected 7.5 s`);
if (paceActive !== 0) fail(`a number is highlighted at 7.5 s, between numbers`);
await page.reload();
await page.locator('#settingsBtn').click();
const paceKept = await page.locator('#stepPeriod').inputValue();
await page.locator('#settingsDialog button[value="close"]').click();
if (paceKept !== '7.5') fail(`step interval after reload: ${paceKept}, expected 7.5`);

if (consoleErrors.length) fail(`console errors during run: ${consoleErrors.join(' | ')}`);

// On iOS a finger held on the plot is a recording, so a long press must not
// select its text. (The tap highlight and callout are iOS-only properties
// that desktop WebKit does not implement, so they cannot be checked here.)
if (onIPhone) {
  const select = await page.locator('#stage').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-user-select'));
  if (select !== 'none') fail(`plot text is selectable on a long press: ${select}`);
}


await browser.close();
await app.close();

if (process.exitCode) {
  console.error('\nSmoke test FAILED');
} else {
  console.log(`Smoke test passed${onIPhone ? ' (WebKit, iPhone)' : ''}:`);
  console.log('  - page loads clean with no console errors');
  console.log('  - empty state renders before any data');
  console.log('  - 437 samples loaded through the file picker');
  console.log('  - 10 response cards rendered');
  console.log(`  - median model matches engine output: ${EXPECTED_MEDIAN_2ND_ORDER}`);
  console.log('  - excluding and restoring a response re-derives the model');
  console.log('  - step, frequency, pole and sparkline canvases drew, and follow the theme');
  console.log('  - moving the pole off the fit raises the error, and Escape restores it');
  console.log('  - the step interval slider sets, steps and remembers its value');
}
