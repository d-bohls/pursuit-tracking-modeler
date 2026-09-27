# Pursuit Tracking Modeler

Record yourself pursuit tracking a stepping target with your pointer, and get a
model of how you respond: your reaction delay, damping and natural
frequency, as continuous- and discrete-time transfer functions.

**Try it: [d-bohls.github.io/pursuit-tracking-modeler](https://d-bohls.github.io/pursuit-tracking-modeler/)**

## What it does

1. **Live experiment.** A target line jumps to a random height every few
   seconds (a step input), and you follow it with the pointer. Both positions
   are recorded at a configurable sample rate.
2. **Analysis.** The recording is split into one step response per step, and
   each is fitted to a first-order and a second-order discrete-time pole
   model by simulating the model against the recorded input.
3. **Laplace domain.** The identified poles are converted to their
   continuous-time equivalents and shown as
   `H(s) = ωn² / (s² + 2ζωn·s + ωn²) · e^(−Ds)`, with natural frequency,
   damping ratio and delay.

## Using it

- **Record session** starts a run on the plot; follow the target until the
  run ends itself after 10 step responses, or stop it with the Space bar or a
  click on the plot. On a touchscreen, hold the button or the plot and lift
  to stop.
- **Replay** plays the session back with your identified model driven by the
  same target, so you can see where the model and your hand disagree.
- Each step becomes a card with a thumbnail. Untick one and every number
  re-derives from the rest; step responses that fit more than 3x worse or
  better than the median are marked ⚠. Pick a card to see its step response,
  frequency response and poles, and drag the poles to explore.
- **Your model** leads with reaction delay, overshoot, damping and natural
  frequency, with `H(s)`, `H(z)` and the difference equation underneath.
- **Sessions** are kept in the browser, and the open one reopens on reload.
  Click a session's name to rename it; open, export, import or delete sessions
  from the Sessions dialog.
- **Settings** hold the theme, the average time between steps and the sample
  period, and are remembered between visits.

## Running it

Requires Node 22.12 or later.

```
npm install
npm run dev         # local dev server with hot reload
npm run build       # production build into dist/
npm test            # every check below
npm run validate    # print the engine's analysis of the reference recording
```

## Tests

`npm test` type-checks the app, then runs:

- `model-check`: the 2-pole closed form matches the difference equation, and
  the fitter recovers known parameters.
- `damping-check`: critically damped and overdamped responses are named as
  such.
- `smoke-test`: loads the reference recording in a real browser and checks the
  rendered model matches the engine, plus the pole editor and Settings.
- `sessions-test`: sessions are kept, restored, reopened, renamed and
  deleted.
- `scroll-test`: the live plot scrolls at the expected rate and stays sharp.
- `simulation-test`: identification reaches the simulation, which rings as
  the identified damping predicts. It opens the page with `?selftest`, which
  shows the self-test controls in Settings; they are hidden otherwise.
- `touch-test`: holding a finger records, and lifting it stops.

The browser tests build the app, serve it locally and drive it with
Playwright's Chromium, installed once with `npx playwright install chromium`.

## Project layout

```
src/
  engine/              pure TypeScript, no DOM
    analysis.ts        the pipeline: identify, aggregate, format
    stepResponses.ts   splitting a recording into step responses
    curveFit.ts        1-pole and 2-pole output-error fitting
    poleConversion.ts  discrete (z) <-> continuous (s) poles
    outliers.ts        which step responses fit implausibly badly or well
    dsp.ts             DFT and deconvolution
    complex.ts         complex magnitude
    dataFormat.ts      the data file format
    types.ts           shared types
  ui/
    experiment.ts      the live tracking plot
    plotting.ts        the detail and thumbnail plots
    detailPlots.ts     the inspected step response, and the pole editor
    readout.ts         the model card
    settings.ts        the Settings dialog and theme
    stageHelp.ts       the help and messages over the live plot
    sessions.ts        sessions stored in IndexedDB
    sessionsView.ts    the Sessions and Samples dialogs
    sessionTitle.ts    the open session's name, and renaming it
    labels.ts          shared wording and formatting
    dom.ts             small DOM helpers
  main.ts              the app's state, wiring the pieces together
test/                  the checks and tests above, and serve.mjs, which
                       builds and serves the app for them
  data/                a real recording, used by the tests
.github/workflows/     CI: npm test on every push, and the Pages deploy
```

## License

[MIT](LICENSE)
