// Touch drives a run by holding Record: press to start, lift to stop; a touch
// on the idle plot starts nothing, and a swipe there scrolls. This drives it
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

// 2. a hold on the plot itself, away from the buttons, starts nothing
{
  const top = { x: plot.x - 120, y: plot.y - 80 };
  const { during } = await hold(top, lower, 800);
  console.log(`hold on plot:    during "${during}"`);
  if (/^Recording/.test(during)) fail('a held press on the idle plot started a recording');
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

// 5. at rest, a vertical swipe that starts on the plot scrolls the page
{
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const from = await centreOf('#graph');
  await touch('touchStart', [{ x: from.x, y: from.y + 60, id: 1 }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: from.x, y: from.y + 60 - i * 15, id: 1 }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(500);
  const scrolled = await page.evaluate(() => window.scrollY);
  console.log(`swipe on the resting plot: scrolled ${scrolled}px, status "${await status()}"`);
  if (scrolled < 50) fail(`a swipe on the resting plot did not scroll the page (${scrolled}px)`);
  if (/^Recording/.test(await status())) fail('a swipe on the resting plot started a recording');
}

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
await app.close();

if (failed) {
  console.error('\nTouch test FAILED');
  process.exitCode = 1;
} else {
  console.log('\nTouch test passed: holds on Record record and lifts stop them, the plot alone starts nothing, taps stop replays, swipes at rest scroll.');
}
