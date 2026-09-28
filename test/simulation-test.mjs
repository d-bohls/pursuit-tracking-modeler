// Verifies that the self-test simulates the system that was actually
// identified.
//
// A simulation stuck on the built-in demo pole (0.8, 0.2 -- zeta 0.62, ~8%
// overshoot) would still look plausible and fail nothing else, so this checks
// that the identified model is what gets played.
//
//   node test/simulation-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();
const dataPath = join(root, 'test/data/reference-data.txt');

// zeta of the built-in demo pole, and of the model the reference recording yields.
const DEMO_ZETA = 0.6185;
const IDENTIFIED_ZETA = 0.0767; // median of the step responses under output-error identification

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${app.url}?selftest`);

let failed = false;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  failed = true;
};
const zetaFromUi = async () =>
  Number((await page.locator('#simModelInfo').textContent())?.match(/ζ ([\d.]+)/)?.[1]);

// 1. before identification: the demo model, and it should say so
const before = await zetaFromUi();
const beforeText = (await page.locator('#simModelInfo').textContent()) ?? '';
console.log(`before identification: ζ = ${before}`);
if (Math.abs(before - DEMO_ZETA) > 0.01) fail(`expected the demo pole ζ≈${DEMO_ZETA}, got ${before}`);
if (!/demo model/.test(beforeText)) fail(`readout should say it is the demo model: "${beforeText}"`);

// 2. identify from the real recording. Identification runs automatically on
// load now -- there is no analyze button to press and no dialog to dismiss.
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(2500);

const after = await zetaFromUi();
const afterText = (await page.locator('#simModelInfo').textContent()) ?? '';
console.log(`after  identification: ζ = ${after}`);
if (Math.abs(after - IDENTIFIED_ZETA) > 0.01) {
  fail(`simulation should now use the identified model (ζ≈${IDENTIFIED_ZETA}), got ${after}`);
}
if (Math.abs(after - before) < 0.05) {
  fail(`ζ barely moved (${before} -> ${after}) -- the simulation is probably still on the demo pole`);
}
if (!/the identified model/.test(afterText)) fail(`readout should say it switched: "${afterText}"`);

// 2b. adjusting the Model card's pole changes what the simulation -- and so
// Replay and the self-test -- plays back, and Escape puts the fit back.
const readoutZeta = async () =>
  Number((await page.locator('.tile', { hasText: 'Damping' }).locator('.tile-value').textContent())?.trim());
await page.locator('.model-card .response-inspect').click();
await page.locator('#poleGraph').focus();
await page.keyboard.press('Shift+ArrowLeft');
await page.keyboard.press('Shift+ArrowLeft');
const adjustedZeta = await zetaFromUi();
console.log(`after adjusting the pole: ζ = ${adjustedZeta}`);
if (Math.abs(adjustedZeta - after) < 0.005) fail(`adjusting the pole did not change the simulated model (ζ ${after} -> ${adjustedZeta})`);
if (Math.abs(adjustedZeta - (await readoutZeta())) > 0.006) {
  fail(`the simulation (ζ ${adjustedZeta}) does not play the adjusted model the readout shows (ζ ${await readoutZeta()})`);
}
await page.keyboard.press('Escape');
if (Math.abs((await zetaFromUi()) - IDENTIFIED_ZETA) > 0.01) fail('Escape did not return the simulation to the fitted model');

// 3. and the simulated run should visibly overshoot, since ζ=0.36 means ~29%
// The run controls live on the plot now, and the mode lives in Settings.
await page.locator('#settingsBtn').click();
// Fast pace: steps come at a random 1.5-2.5 s, so the 9 s run below always
// completes several step responses. At Normal pace (3-5 s) it sometimes got none.
await page.locator('#paceGroup button[data-pace="2000"]').click();
// The mode is a self-test now, tucked inside the Diagnostic self-test disclosure.
await page.locator('#advancedSettings summary').click();
await page.selectOption('#simulationMode', 'second');
await page.locator('#settingsDialog button[value="close"]').click();
await page.locator('#recordBtn').click();
await page.waitForTimeout(9000);
await page.keyboard.press('Space');
await page.waitForTimeout(500);

// A model-driven run must be labelled as the model's, never as yours.
const heading = (await page.locator('#readoutHeading').textContent()) ?? '';
const statusLine = (await page.locator('#status').textContent()) ?? '';
if (!/Second-order model · self-test/.test(heading)) fail(`model run presented as: "${heading}"`);
if (!/^Model run stopped/.test(statusLine)) fail(`model run status reads: "${statusLine}"`);
const legend = (await page.locator('#legendYou').textContent()) ?? '';
if (legend === 'You') fail(`the legend captions the model run's trace "You"`);

// Measure overshoot directly from the recorded samples: for each step of the
// target, how far past it did the simulated response travel? The samples are
// in the newest session's Data view.
await page.locator('#sessionsBtn').click();
await page.waitForTimeout(300);
await page.locator('#sessionList .session-data').first().click();
await page.waitForTimeout(200);
const overshoot = await page.locator('#samplesOut').evaluate((el) => {
  const rows = el.value
    .split('\n')
    .slice(2)
    .map((l) => l.split('\t').map(Number))
    .filter((r) => r.length >= 3 && r.every((v) => Number.isFinite(v)));
  let worst = 0;
  for (let i = 1; i < rows.length; i++) {
    const [, x, y] = rows[i];
    const prevX = rows[i - 1][1];
    if (x !== prevX) {
      // a step: look ahead for the peak excursion relative to the step size
      const step = x - prevX;
      let peak = 0;
      for (let j = i; j < Math.min(i + 40, rows.length); j++) {
        if (rows[j][1] !== x) break;
        const past = (rows[j][2] - x) / step; // >0 means overshot the new target
        if (past > peak) peak = past;
      }
      if (peak > worst) worst = peak;
    }
  }
  return worst * 100;
});

console.log(`simulated peak overshoot: ${overshoot.toFixed(1)}%  (ζ=${IDENTIFIED_ZETA} predicts ~79%)`);
if (overshoot < 55) {
  fail(`simulated response only overshot ${overshoot.toFixed(1)}% -- far less springy than the identified ζ predicts`);
}

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
await app.close();

if (failed) {
  console.error('\nSimulation test FAILED');
  process.exitCode = 1;
} else {
  console.log('\nSimulation test passed: identification updates the simulated system, and it rings.');
}
