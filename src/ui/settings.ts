// The Settings dialog: its controls, the theme, and remembering both between
// visits.

import type { ExperimentConfig, SimulationMode } from './experiment';
import { $ } from './dom';
import { clamp } from './labels';

const stepPeriodInput = $<HTMLInputElement>('stepPeriod');
const stepPeriodOut = $<HTMLOutputElement>('stepPeriodOut');
const paceGroup = $<HTMLDivElement>('paceGroup');
const samplePeriodInput = $<HTMLInputElement>('samplePeriod');
const simulationModeSelect = $<HTMLSelectElement>('simulationMode');
const discretePointsCheckbox = $<HTMLInputElement>('discretePoints');
const themeGroup = $<HTMLDivElement>('themeGroup');
const resetSettingsBtn = $<HTMLButtonElement>('resetSettingsBtn');

const STORE_KEY = 'pursuit-tracking-modeler.settings';

/** 'system' follows the OS; the other two pin the page regardless of it. */
type ThemeChoice = 'light' | 'dark' | 'system';
let themeChoice: ThemeChoice = 'system';

/** What the controls read with nothing stored, and what Reset restores. */
const DEFAULT_SETTINGS = {
  stepPeriodMs: 4000,
  samplePeriodMs: 100,
  simulationMode: 'none',
  discretePoints: false,
  theme: 'system' as ThemeChoice,
};

interface StoredSettings {
  stepPeriodMs?: number;
  samplePeriodMs?: number;
  discretePoints?: boolean;
  theme?: ThemeChoice;
}

/**
 * Settings survive a reload. Every read and write is guarded: localStorage
 * throws outright in some privacy modes, and a page that cannot remember your
 * sample period should still run.
 */
function readSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredSettings) : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    const stored: StoredSettings = {
      stepPeriodMs: currentConfig().stepPeriodMs,
      samplePeriodMs: currentConfig().samplePeriodMs,
      discretePoints: discretePointsCheckbox.checked,
      theme: themeChoice,
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    /* nothing to do -- the app works fine without a memory */
  }
}

/**
 * 'light' and 'dark' pin the page with data-theme. 'system' removes the
 * attribute and lets the prefers-color-scheme block in style.css decide,
 * which is why that block has to stay even though dark is the default.
 */
function applyTheme(choice: ThemeChoice) {
  themeChoice = choice;
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  for (const b of themeGroup.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.getAttribute('data-theme') === choice));
  }
}

/** The slider's readout, and the number under it that it sits on, if any. */
function syncPaceMarks() {
  const ms = currentConfig().stepPeriodMs;
  stepPeriodOut.textContent = `${ms / 1000} s`;
  for (const mark of paceGroup.querySelectorAll<HTMLElement>('[data-pace]')) {
    mark.dataset.active = String(mark.dataset.pace === String(ms));
  }
}

export function currentConfig(): ExperimentConfig {
  return {
    // The slider is in seconds, like the scale marked under it.
    stepPeriodMs: clamp(Math.round((Number(stepPeriodInput.value) || 4) * 1000), 1000, 10000),
    samplePeriodMs: clamp(Number(samplePeriodInput.value) || 100, 50, 500),
    scrollPeriodMs: 50,
    simulationMode: simulationModeSelect.value as SimulationMode,
    discretePoints: discretePointsCheckbox.checked,
  };
}

// The self-test lets a model do the tracking. It is for testing the pipeline,
// not for use, so its controls only appear when the page is opened with
// ?selftest.
$<HTMLDetailsElement>('advancedSettings').hidden = !new URLSearchParams(location.search).has('selftest');

// Stored settings go into the controls as this module loads, before anything
// reads them.
{
  const s = readSettings();
  if (typeof s.stepPeriodMs === 'number') stepPeriodInput.value = String(clamp(s.stepPeriodMs, 1000, 10000) / 1000);
  if (typeof s.samplePeriodMs === 'number') samplePeriodInput.value = String(clamp(s.samplePeriodMs, 50, 500));
  // The self-test mode is deliberately NOT restored. Left on a model, it
  // would make the next visit's Record a model run -- every session starts
  // with you tracking, and a self-test is something you choose each time.
  if (typeof s.discretePoints === 'boolean') discretePointsCheckbox.checked = s.discretePoints;
  // Default to the OS preference. index.html therefore ships with NO
  // data-theme, so the prefers-color-scheme block styles the very first paint
  // and there is no flash before this runs.
  applyTheme(s.theme ?? DEFAULT_SETTINGS.theme);
  syncPaceMarks();
}

/**
 * Hooks the controls up to the app.
 * @param onChange a setting that affects the run changed; currentConfig() has it.
 * @param onRepaint the theme changed, which the canvases cannot pick up from CSS.
 */
export function connectSettings(onChange: () => void, onRepaint: () => void) {
  // The numbers under the slider are shortcuts to their positions. They are
  // skipped by Tab: the slider itself is the control, and its arrow keys
  // reach every value.
  paceGroup.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-pace]') as HTMLButtonElement | null;
    if (!btn) return;
    stepPeriodInput.value = String(Number(btn.dataset.pace) / 1000);
    syncPaceMarks();
    onChange();
    saveSettings();
  });
  // The readout follows the thumb while it is dragged; the setting is applied
  // on release, by the change listener below.
  stepPeriodInput.addEventListener('input', syncPaceMarks);

  for (const el of [stepPeriodInput, samplePeriodInput, simulationModeSelect, discretePointsCheckbox]) {
    el.addEventListener('change', () => {
      syncPaceMarks();
      onChange();
      saveSettings();
    });
  }

  resetSettingsBtn.addEventListener('click', () => {
    stepPeriodInput.value = String(DEFAULT_SETTINGS.stepPeriodMs / 1000);
    samplePeriodInput.value = String(DEFAULT_SETTINGS.samplePeriodMs);
    simulationModeSelect.value = DEFAULT_SETTINGS.simulationMode;
    discretePointsCheckbox.checked = DEFAULT_SETTINGS.discretePoints;
    applyTheme(DEFAULT_SETTINGS.theme);
    syncPaceMarks();
    onChange();
    onRepaint();
    // Forget the stored settings outright rather than storing the defaults, so
    // a later change of default is picked up instead of being overridden by a
    // saved copy of the old one.
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* nothing stored, nothing to forget */
    }
  });

  themeGroup.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-theme]') as HTMLButtonElement | null;
    if (!btn) return;
    applyTheme(btn.dataset.theme as ThemeChoice);
    onRepaint();
    saveSettings();
  });

  // Under 'system' the page has no data-theme, so an OS flip restyles the CSS
  // but leaves the canvases painted in the old palette until they are redrawn.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeChoice === 'system') onRepaint();
  });
}
