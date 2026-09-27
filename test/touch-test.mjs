// Touch drives a run by holding: press to start, lift to stop. This drives it
// with REAL touches (Chrome's Input.dispatchTouchEvent), because synthetic
// PointerEvents cannot take pointer capture and so cannot exercise the path.
//
// A run started on the button's click would start on the LIFT, which should
// end it, leaving nothing on the glass to stop it; this checks the press
// starts it.
//
//   node test/touch-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(app.url);
await page.waitForTimeout(300);
const cdp = await context.newCDPSession(page);

let failed = false;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  failed = true;
};
const status = async () => (await page.locator('#status').textContent()) ?? '';
const centreOf = async (selector) => {
  const b = await page.locator(selector).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

/** Holds a finger at `from`, drags it to `to`, holds, then lifts. */
async function hold(from, to, ms) {
  await touch('touchStart', [{ x: from.x, y: from.y, id: 1 }]);
  await page.waitForTimeout(200);
  await touch('touchMove', [{ x: to.x, y: to.y, id: 1 }]);
  await page.waitForTimeout(ms);
  const during = await status();
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  return { during, after: await status() };
}

const plot = await centreOf('#graph');
const lower = { x: plot.x, y: plot.y + 60 };

// 1. hold on the Record button, slide onto the plot, lift
{
  const { during, after } = await hold(await centreOf('#recordBtn'), lower, 1500);
  console.log(`hold on Record:  during "${during}"  after "${after}"`);
  if (!/^Recording/.test(during)) fail(`a held press on Record did not record: "${during}"`);
  if (!/^Stopped/.test(after)) fail(`lifting after a press on Record did not stop the run: "${after}"`);
  await page.waitForTimeout(3500); // let the finish message clear
}

// 2. hold on the plot itself, away from the buttons
{
  const top = { x: plot.x - 120, y: plot.y - 80 };
  const { during, after } = await hold(top, lower, 1500);
  console.log(`hold on plot:    during "${during}"  after "${after}"`);
  if (!/^Recording/.test(during)) fail(`a held press on the plot did not record: "${during}"`);
  if (!/^Stopped/.test(after)) fail(`lifting from the plot did not stop the run: "${after}"`);
}

// 3. the trailing click of a touch on Record must not start a second run
await page.waitForTimeout(800);
if (/^Recording/.test(await status())) fail('a second run started after the lift');

// 4. a tap stops a replay. Needs step responses to replay, so load the reference data.
await page.locator('#fileInput').setInputFiles(join(root, 'test/data/reference-data.txt'));
await page.waitForTimeout(2500);
await page.locator('#replayBtn').tap();
await page.waitForTimeout(600);
const replaying = await status();
await page.touchscreen.tap(plot.x - 120, plot.y - 80);
await page.waitForTimeout(400);
const afterTap = await status();
console.log(`tap during replay: "${replaying}" -> "${afterTap}"`);
if (!/^Replaying/.test(replaying)) fail(`Replay did not start: "${replaying}"`);
if (/^Replaying/.test(afterTap)) fail('a tap on the plot did not stop the replay');

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
await app.close();

if (failed) {
  console.error('\nTouch test FAILED');
  process.exitCode = 1;
} else {
  console.log('\nTouch test passed: holds record from Record or the plot, lifts stop them, taps stop replays.');
}
