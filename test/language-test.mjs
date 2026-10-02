// The interface in Portuguese: switched in Settings, every visible word and
// every tooltip, label and placeholder translated -- in the plot, the
// strip, the model, and the Sessions, Samples and Settings dialogs -- kept
// across a reload, and back to English on request.
//
//   node test/language-test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = await serve();
const dataPath = join(root, 'test/data/reference-data.txt');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = false;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  failed = true;
};

await page.goto(app.url);

const setLanguage = async (lang) => {
  await page.locator('#settingsBtn').click();
  await page.locator(`#langGroup button[data-lang="${lang}"]`).click();
  await page.locator('#settingsDialog button[value="close"]').click();
};

// English words that must not survive a switch to Portuguese. Whole words, so
// "Modelo" does not count as "Model". The app's name stays as it is.
const ENGLISH = /\b(Session|Sessions|Settings|Step|Steps|Model|Target|Record|Replay|Ready|Damping|Overshoot|Natural|Reaction|Median|Joint|fit|Fit|response|responses|Delete|Done|Samples|Import|Export|Theme|Light|Dark|Language|between|Tick|Untick|Measured|Poles|Frequency|underdamped|overdamped|delay|Loaded|Reopened|Today|Yesterday)\b/;

/** Every word a reader can see, or hear from a tooltip or label, outside the app's name. */
const wordsOnScreen = () =>
  page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('h1, textarea, script, style')) continue;
      if (!el.checkVisibility?.() && !el.closest('[role="status"]')) continue;
      const text = n.textContent.trim();
      if (text) out.push(text);
    }
    for (const el of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
      for (const a of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v && !el.closest('#langGroup')) out.push(v);
      }
    }
    return out;
  });
const checkNoEnglish = async (where) => {
  for (const text of await wordsOnScreen()) {
    const m = text.match(ENGLISH);
    if (m && !/reference-data\.txt/.test(text)) fail(`English left ${where}: "${text}" (${m[0]})`);
  }
};

// Before any data: the empty states.
await setLanguage('pt');
await checkNoEnglish('before any data');
await page.locator('#fileInput').setInputFiles(dataPath);
await page.waitForTimeout(1500);

if ((await page.locator('#recordBtn').textContent()) !== 'Gravar sessão') fail('Record is not translated');
if ((await page.locator('#readoutHeading').textContent()) !== 'Modelo mediano') fail('the model heading is not translated');
if ((await page.evaluate(() => document.documentElement.lang)) !== 'pt-BR') fail('the page is not marked pt-BR');
await checkNoEnglish('on the page, Model card selected');

// A step's own model, with its flag.
await page.locator('.response-card:not(.model-card) .response-inspect').first().click();
await page.waitForTimeout(200);
if ((await page.locator('#readoutHeading').textContent()) !== 'Modelo do degrau 1') fail('a step model heading is not translated');
await checkNoEnglish('on the page, a step selected');
await page.locator('.model-card .response-inspect').click();

// The joint fit, an unticked step and an adjusted pole all add wording.
await page.locator('#modelFitGroup button[data-fit="joint"]').click();
await page.locator('.response-card input').nth(1).uncheck();
await page.locator('#poleGraph').focus();
await page.keyboard.press('Shift+ArrowLeft');
await page.waitForTimeout(200);
await checkNoEnglish('with a joint fit, an excluded step and an adjusted pole');
await page.locator('#poleResetBtn').click();
await page.locator('.response-card input').nth(1).check();
await page.locator('#modelFitGroup button[data-fit="median"]').click();

// The dialogs.
await page.locator('#sessionsBtn').click();
await page.waitForTimeout(300);
await checkNoEnglish('in Sessions');
await page.locator('.session-row .session-data').first().click();
await page.waitForTimeout(200);
await checkNoEnglish('in Samples');
await page.locator('#samplesDialog button[value="close"]').click();
await page.locator('#sessionsDialog button[value="close"]').click();
await page.locator('#settingsBtn').click();
await checkNoEnglish('in Settings');
await page.locator('#settingsDialog button[value="close"]').click();

// A run, and the plot's help while it goes.
await page.locator('#recordBtn').click();
await page.waitForTimeout(800);
await checkNoEnglish('while recording');
await page.keyboard.press('Space');
await page.waitForTimeout(500);

// Kept across a reload, and back to English on request.
await page.reload();
await page.waitForTimeout(1200);
if ((await page.locator('#recordBtn').textContent()) !== 'Gravar sessão') fail('Portuguese was not kept across a reload');
await checkNoEnglish('after a reload');
await setLanguage('en');
if ((await page.locator('#recordBtn').textContent()) !== 'Record session') fail('switching back did not restore English');
if ((await page.locator('#readoutHeading').textContent()) !== 'Median model') fail('the model heading did not return to English');

// A link with ?lang=pt opens a first visit in Portuguese, and it sticks.
{
  const fresh = await browser.newPage({ locale: 'en-US' });
  await fresh.goto(`${app.url}?lang=pt`);
  if ((await fresh.locator('#recordBtn').textContent()) !== 'Gravar sessão') fail('?lang=pt did not open the app in Portuguese');
  await fresh.goto(app.url);
  if ((await fresh.locator('#recordBtn').textContent()) !== 'Gravar sessão') fail('the language from the link did not stick');
  await fresh.close();
}

if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
await browser.close();
await app.close();

if (failed) {
  console.error('\nLanguage test FAILED');
  process.exitCode = 1;
} else {
  console.log('Language test passed: everything on screen is in Portuguese once chosen, kept across a reload, and back to English on request.');
}
