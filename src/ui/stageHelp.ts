// What the plot says over itself: the help at its foot, and the message that
// announces the end of a run.

import type { Phase, SimulationMode } from './experiment';
import { $, setList } from './dom';
import { modelName } from './labels';

const stageEl = $<HTMLElement>('stage');
const stageChrome = document.querySelector('.stage-chrome') as HTMLDivElement;
const stageActions = $<HTMLDivElement>('stageActions');
const stageGuide = $<HTMLUListElement>('stageGuide');
const stageFlash = $<HTMLParagraphElement>('stageFlash');
const recordBtn = $<HTMLButtonElement>('recordBtn');
const replayBtn = $<HTMLButtonElement>('replayBtn');

/**
 * True where the primary input cannot hover and is coarse -- a touchscreen.
 * The copy follows this, while the BEHAVIOUR follows each event's own
 * pointerType, so a hybrid machine reads touch wording and still works with
 * its mouse. Live, not read once, so it follows a browser switched into
 * device mode.
 */
const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
export const isTouchFirst = () => touchQuery.matches;
export function onTouchFirstChange(listener: () => void) {
  touchQuery.addEventListener('change', listener);
}

/**
 * Centres the message in the gap between the bottom of the legend/status
 * row and the top of the button column. Measured rather than set as a
 * percentage: the column's top edge moves with the plot's height, and at 25%
 * a short plot put the message across the top button.
 */
function placeFlash() {
  const stage = stageEl.getBoundingClientRect();
  const above = stageChrome.getBoundingClientRect().bottom;
  const below = recordBtn.getBoundingClientRect().top;
  if (stageActions.hidden || below <= above) {
    stageFlash.style.top = '';
    return;
  }
  stageFlash.style.top = `${(above + below) / 2 - stage.top}px`;
}

/** The end-of-run result, across the plot, until something moves on from it. */
export function flash(message: string) {
  stageFlash.textContent = message;
  stageFlash.hidden = false;
  placeFlash();
}

/**
 * Takes the message down. It is news about the run that just ended, so it
 * stays until something moves on from that run: a button is reached for, a
 * run starts, or another session is opened in its place.
 */
export function dismissFlash() {
  stageFlash.hidden = true;
}
// Capture phase, so it runs before a button's own handler opens a dialog or
// starts a run -- and on a press rather than the click, so it goes the moment
// the pointer comes down.
stageActions.addEventListener('pointerdown', dismissFlash, true);
stageActions.addEventListener('click', dismissFlash, true);

/**
 * At rest the help sits centred in the gap between the bottom of Replay and
 * the bottom of the plot. While a run is going the buttons are gone and the
 * stylesheet keeps it at the foot of the plot.
 */
function placeGuide() {
  if (stageActions.hidden) {
    stageGuide.style.top = stageGuide.style.bottom = stageGuide.style.transform = '';
    return;
  }
  const stage = stageEl.getBoundingClientRect();
  const above = replayBtn.getBoundingClientRect().bottom;
  stageGuide.style.top = `${(above + stage.bottom) / 2 - stage.top}px`;
  stageGuide.style.bottom = 'auto';
  stageGuide.style.transform = 'translate(-50%, -50%)';
}

// Both follow the layout: the gaps they are centred in move whenever the plot
// changes size.
new ResizeObserver(() => {
  if (!stageFlash.hidden) placeFlash();
  placeGuide();
}).observe(stageEl);

/**
 * The plot's help. At rest it says what the buttons do; while a run is
 * going, what to do and how to stop. Worked out from the state each time
 * rather than set piecemeal, so it can never describe a moment that has
 * passed -- or a keyboard to someone holding a phone.
 * @param runMode who is tracking in the run under way.
 */
export function renderGuide(phase: Phase, runMode: SimulationMode) {
  const touch = isTouchFirst();
  let items: string[];
  if (phase === 'recording' && runMode !== 'none') {
    // Nothing for the hand to do: the model is the one tracking.
    items = [
      `The ${modelName(runMode)} is tracking the target, not you`,
      touch ? 'Tap the plot to stop the run' : 'Click the plot or press the Space bar to stop',
    ];
  } else if (phase === 'recording') {
    items = [
      touch
        ? "Slide your finger up and down to match the target's height"
        : "Move your pointer up and down to match the target's height",
      touch ? 'Lift your finger to stop recording' : 'Click the plot or press the Space bar to stop',
    ];
  } else if (phase === 'replaying') {
    items = [touch ? 'Tap the plot to stop the replay' : 'Click the plot or press the Space bar to stop'];
  } else {
    // In the order of the buttons: Record -- what to do, then how to start
    // and stop -- then Replay. The same every time, sessions or not.
    items = [
      `When recording, follow the target's height with your ${touch ? 'finger' : 'pointer'}`,
      touch ? 'Hold the record button or the plot to record; lift to stop' : 'Space bar also starts and stops recording',
      'Replay this session with the model overlaid',
    ];
  }
  setList(stageGuide, items);
  placeGuide();
}
