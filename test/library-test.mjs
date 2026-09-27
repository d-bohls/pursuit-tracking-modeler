// The recording library: runs are kept across reloads, an import is not
// duplicated, notes and unticked trials stay with their recording, a new run
// is added beside the old ones, any of them reopens, and delete asks twice.
//
//   node test/library-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await serve();
const dataPath = join(root, 'test/data/reference-data.txt');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let failed = false;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  failed = true;
};
const status = async () => (await page.locator('#status').textContent()) ?? '';
const rows = () => page.locator('#libraryList .rec');
const openList = async () => {
  await page.locator('#dataBtn').click();
  await page.waitForTimeout(300);
};
const closeList = async () => {
  await page.locator('#dataDialog button[value="close"]').click();
  await page.waitForTimeout(150);
};
const unticked = () =>
  page.locator('.trial-include').evaluateAll((boxes) => boxes.map((b, i) => (b.checked ? 0 : i + 1)).filter(Boolean));

await page.goto(app.url);
await page.waitForTimeout(400);

// 1. a fresh browser has nothing to restore
await openList();
if ((await rows().count()) !== 0) fail('library not empty in a fresh browser');
if (await page.locator('#libraryEmpty').isHidden()) fail('empty library shows no explanation');
await closeList();

// 2. an import is kept, and importing it again does not duplicate it
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(2500);
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(1500);
if (!/already in your recordings/.test(await status())) fail(`second import not recognised: "${await status()}"`);
await openList();
if ((await rows().count()) !== 1) fail(`expected 1 recording after importing twice, got ${await rows().count()}`);

// 3. a note and an unticked trial stay with the recording across a reload
await page.locator('.rec-note').first().fill('mouse, evening');
await page.locator('.rec-note').first().press('Enter');
if (!(await page.locator('#dataDialog').isVisible())) fail('Enter in a note closed the dialog');
await closeList();
await page.locator('.trial-include').nth(1).uncheck();
await page.waitForTimeout(400);
await page.reload();
await page.waitForTimeout(2500);
if (!/^Reopened mouse, evening/.test(await status())) fail(`not restored after reload: "${await status()}"`);
if ((await page.locator('.trial-card').count()) !== 10) fail('restored recording lost its trials');
if (JSON.stringify(await unticked()) !== '[2]') fail(`unticked trials not restored: ${JSON.stringify(await unticked())}`);
await openList();
if ((await page.locator('.rec-note').first().inputValue()) !== 'mouse, evening') fail('note not restored');
if (!/Trials · mouse, evening/.test((await page.locator('.trials-title').textContent()) ?? '')) {
  fail(`Trials heading does not name the recording: "${await page.locator('.trials-title').textContent()}"`);
}
await closeList();

// 4. a new run is kept beside it, as the open one
await page.locator('#settingsBtn').click();
await page.locator('#paceGroup button[data-pace="2000"]').click();
await page.locator('#settingsDialog button[value="close"]').click();
const plot = await page.locator('#graph').boundingBox();
await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
await page.locator('#recordBtn').click();
for (let i = 0; i < 16; i++) {
  await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height * (0.3 + 0.4 * Math.random()));
  await page.waitForTimeout(400);
}
await page.keyboard.press('Space');
await page.waitForTimeout(800);
await openList();
if ((await rows().count()) !== 2) fail(`expected 2 recordings after a run, got ${await rows().count()}`);
const current = await rows().evaluateAll((lis) => lis.map((li) => li.getAttribute('aria-current')));
if (JSON.stringify(current) !== '["true","false"]') fail(`newest run should be the open one: ${JSON.stringify(current)}`);
if (!/^Today/.test((await rows().first().locator('.rec-when').textContent()) ?? '')) fail('row is not dated today');
if ((await rows().first().locator('.rec-who').textContent()) !== 'You') fail('a run of yours is not labelled "You"');
// No note yet, so the heading falls back to when it was recorded.
if (!/^Trials · Today/.test((await page.locator('.trials-title').textContent()) ?? '')) {
  fail(`an unnamed run is not headed by its time: "${await page.locator('.trials-title').textContent()}"`);
}

// 5. the older one reopens with its own unticked trial
await rows().nth(1).locator('.rec-open').click();
await page.waitForTimeout(1500);
if (!/^Opened the recording/.test(await status())) fail(`did not open: "${await status()}"`);
if ((await page.locator('.trial-card').count()) !== 10) fail('reopened recording has the wrong trials');
if (JSON.stringify(await unticked()) !== '[2]') fail('reopened recording lost its unticked trial');
// Opening selects in place: the list stays up, with the selection moved.
if (!(await page.locator('#dataDialog').isVisible())) fail('opening a recording closed the list');
const moved = await rows().evaluateAll((lis) => lis.map((li) => li.getAttribute('aria-current')));
if (JSON.stringify(moved) !== '["false","true"]') fail(`selection did not move to the opened row: ${JSON.stringify(moved)}`);
await closeList();

// 5b. a reload reopens the recording that was open -- the older one -- not the newest
await page.reload();
await page.waitForTimeout(2500);
if (!/^Reopened mouse, evening/.test(await status())) fail(`reload did not reopen the selected recording: "${await status()}"`);
if ((await page.locator('.trial-card').count()) !== 10) fail('reload reopened the wrong recording');

// 6. delete takes two presses
await openList();
const del = rows().first().locator('.rec-delete');
await del.click();
if ((await rows().count()) !== 2) fail('one press deleted a recording');
await del.click();
await page.waitForTimeout(400);
if ((await rows().count()) !== 1) fail(`two presses did not delete: ${await rows().count()} left`);
await closeList();

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
await app.close();

if (failed) {
  console.error('\nLibrary test FAILED');
  process.exitCode = 1;
} else {
  console.log('Library test passed: runs are kept, restored, reopened and deleted, with their notes and unticked trials.');
}
