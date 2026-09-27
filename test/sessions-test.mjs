// The Sessions list: sessions are kept across reloads, an import is not
// duplicated, notes and unticked step responses stay with their session, a new run
// is added beside the old ones, any of them reopens, and delete asks twice.
//
//   node test/sessions-test.mjs

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
const rows = () => page.locator('#sessionList .session-row');
const openList = async () => {
  await page.locator('#sessionsBtn').click();
  await page.waitForTimeout(300);
};
const closeList = async () => {
  await page.locator('#sessionsDialog button[value="close"]').click();
  await page.waitForTimeout(150);
};
const unticked = () =>
  page.locator('.response-include').evaluateAll((boxes) => boxes.map((b, i) => (b.checked ? 0 : i + 1)).filter(Boolean));

await page.goto(app.url);
await page.waitForTimeout(400);

// 1. a fresh browser has nothing to restore
await openList();
if ((await rows().count()) !== 0) fail('sessions listed in a fresh browser');
if (await page.locator('#sessionsEmpty').isHidden()) fail('empty Sessions list shows no explanation');
await closeList();

// 2. an import is kept, and importing it again does not duplicate it
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(2500);
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(1500);
if (!/already in your sessions/.test(await status())) fail(`second import not recognised: "${await status()}"`);
await openList();
if ((await rows().count()) !== 1) fail(`expected 1 session after importing twice, got ${await rows().count()}`);

// 3. a note and an unticked step response stay with the session across a reload
await page.locator('.session-note').first().fill('mouse, evening');
await page.locator('.session-note').first().press('Enter');
if (!(await page.locator('#sessionsDialog').isVisible())) fail('Enter in a note closed the dialog');
await closeList();
await page.locator('.response-include').nth(1).uncheck();
await page.waitForTimeout(400);
await page.reload();
await page.waitForTimeout(2500);
if (!/^Reopened mouse, evening/.test(await status())) fail(`not restored after reload: "${await status()}"`);
if ((await page.locator('.response-card').count()) !== 10) fail('restored session lost its responses');
if (JSON.stringify(await unticked()) !== '[2]') fail(`unticked responses not restored: ${JSON.stringify(await unticked())}`);
await openList();
if ((await page.locator('.session-note').first().inputValue()) !== 'mouse, evening') fail('note not restored');
if (!/Session · mouse, evening/.test((await page.locator('.session-title').textContent()) ?? '')) {
  fail(`Session heading does not name the session: "${await page.locator('.session-title').textContent()}"`);
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
if ((await rows().count()) !== 2) fail(`expected 2 sessions after a run, got ${await rows().count()}`);
const current = await rows().evaluateAll((lis) => lis.map((li) => li.getAttribute('aria-current')));
if (JSON.stringify(current) !== '["true","false"]') fail(`newest run should be the open one: ${JSON.stringify(current)}`);
if (!/^Today/.test((await rows().first().locator('.session-when').textContent()) ?? '')) fail('row is not dated today');
if ((await rows().first().locator('.session-who').textContent()) !== 'You') fail('a run of yours is not labelled "You"');
// No note yet, so the heading falls back to when it was recorded.
if (!/^Session · Today/.test((await page.locator('.session-title').textContent()) ?? '')) {
  fail(`an unnamed run is not headed by its time: "${await page.locator('.session-title').textContent()}"`);
}
await closeList();

// 4b. renaming it from the heading saves it as the session's note
await page.locator('#sessionName').click();
await page.locator('#sessionNameInput').fill('quick one');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
if ((await page.locator('.session-title').textContent()) !== 'Session · quick one') {
  fail(`rename did not show: "${await page.locator('.session-title').textContent()}"`);
}
await openList();
if ((await rows().first().locator('.session-note').inputValue()) !== 'quick one') fail('rename was not saved as the note');

// 5. the older one reopens with its own unticked step response
await rows().nth(1).locator('.session-open').click();
await page.waitForTimeout(1500);
if (!/^Opened the session/.test(await status())) fail(`did not open: "${await status()}"`);
if ((await page.locator('.response-card').count()) !== 10) fail('reopened session has the wrong responses');
if (JSON.stringify(await unticked()) !== '[2]') fail('reopened session lost its unticked response');
// Opening selects in place: the list stays up, with the selection moved.
if (!(await page.locator('#sessionsDialog').isVisible())) fail('opening a session closed the list');
const moved = await rows().evaluateAll((lis) => lis.map((li) => li.getAttribute('aria-current')));
if (JSON.stringify(moved) !== '["false","true"]') fail(`selection did not move to the opened row: ${JSON.stringify(moved)}`);
await closeList();

// 5b. a reload reopens the session that was open -- the older one -- not the newest
await page.reload();
await page.waitForTimeout(2500);
if (!/^Reopened mouse, evening/.test(await status())) fail(`reload did not reopen the selected session: "${await status()}"`);
if ((await page.locator('.response-card').count()) !== 10) fail('reload reopened the wrong session');

// 6. delete takes two presses
await openList();
const del = rows().first().locator('.session-delete');
await del.click();
if ((await rows().count()) !== 2) fail('one press deleted a session');
await del.click();
await page.waitForTimeout(400);
if ((await rows().count()) !== 1) fail(`two presses did not delete: ${await rows().count()} left`);
await closeList();

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
await app.close();

if (failed) {
  console.error('\nSessions test FAILED');
  process.exitCode = 1;
} else {
  console.log('Sessions test passed: sessions are kept, restored, reopened and deleted, with their notes and unticked step responses.');
}
