# Pursuit Tracking Modeler

Record yourself following a stepping target with your pointer, and get a
model of how you respond: your reaction delay, damping and natural
frequency, as continuous- and discrete-time transfer functions.

## What it does

1. **Live experiment** — a target line jumps to a random vertical position
   every few seconds (a step input). You track it with the pointer. Both
   positions are recorded at a configurable sample rate.
2. **Analysis** — the recording is split into step responses at each step, the
   target/response pair is deconvolved to get an impulse response `h[n]`,
   and the step response is curve-fit (brute-force, coarse-to-fine grid search) to a
   first-order and a second-order discrete-time pole model.
3. **Laplace domain** — the identified discrete poles are converted to their
   continuous-time (`s`-plane) equivalents, and displayed as a standard
   second-order transfer function `H(s) = ωn² / (s² + 2ζωn·s + ωn²)` with its
   natural frequency, damping ratio, and pure time delay.

Identification runs **as you record**: each step response is identified the moment it
closes (~13 ms), so the model on screen firms up step by step instead of
appearing all at once at the end.

You can also load a previously recorded `test/data/reference-data.txt` file instead of running a live experiment —
useful for re-analyzing old recordings.

## The interface

- **No modal.** The plot, the identified model, and the per-response evidence
  share one scrolling page. You can watch ζ settle while you are still
  tracking.
- **The plot states its own affordance.** The instruction list is gone; the
  plot says `Click the plot to start`, then `Recording · N steps · Ms`.
  Space bar works too.
- **Step responses are objects, not table rows.** Each step becomes a card
  with a thumbnail of the step and the response to it. Untick one and every
  number above re-derives from what is left — outlier rejection is a decision
  you make and see, not a heuristic that happens to you.
- **Fit error is measured against the step that provoked it.** Steps are drawn
  from a 3× range of sizes, so raw pixels are not comparable between step responses:
  on the reference recording step response 3 (9.1 px on a 39 px step) reads as better than
  step response 2 (11.0 px on 77 px) in pixels, and far worse — 23% against 14% — as a
  fraction of the step. Step responses are flagged at 3× the median in *both*
  directions: a fit far worse than its peers did not measure the same system,
  and a fit far better is just as suspect. The reference recording has one of the
  latter, at 0.3% where every other step response sits above 10% — a step response with almost
  no dynamics in it, contributing a confident number about nothing.
- **The headline is about you**, not about the polynomial: reaction delay,
  overshoot, damping, natural frequency. `H(s)` is set as an actual fraction
  underneath as the supporting evidence.
- **The model can run beside you.** Replay plays a recorded run back with the
  identified system driven by the same target on its own past, drawn as a
  dashed line — so you can see where the model and the hand disagree. It is
  never drawn while you record: a line to follow would change what is being
  measured.
- Dark mode, HiDPI-correct canvases, a resizable plot, pointer (not mouse)
  input so a tablet works, and a data palette validated for colour-vision
  deficiency.
- On a wide screen the plot is a full-width row with the readout and the
  step responses sharing the space beneath it; both cards use container queries, so
  they lay themselves out by the room they actually have rather than by the
  size of the window. Settings and the theme persist in `localStorage`;
  recordings deliberately do not.

The recording coordinate space is fixed at 493 units (`LOGICAL_HEIGHT`) rather
than following the canvas, so a recording's step sizes and RMS error mean the
same thing at any window size.

## Running it

**Requires Node 18 or newer** (Vite 5 won't run on anything older).

```
npm install
npm run dev         # local dev server with hot reload
npm run build       # production build into dist/
npm run validate    # replay the reference recording through the engine, headless
npm run model-check # verify the 2-pole model against the difference equation
```

### Troubleshooting

If `npm run dev` fails with:

```
SyntaxError: Unexpected token '??='
    at Loader.moduleStrategy (internal/modules/esm/translators.js)
```

your Node is too old — that's Node 14 or earlier choking on the `??=`
operator, which needs Node 15+. Vite itself needs Node 18+. Install the
current LTS from https://nodejs.org (or `winget install OpenJS.NodeJS.LTS`),
open a **new** terminal, confirm with `node --version`, then delete
`node_modules` and re-run `npm install`.

### Tests

`npm run smoke-test` drives the production build in a real browser
(Playwright), loads the reference recording through the file picker, runs the
analysis, and asserts the rendered model matches what the engine produces
headlessly — plus a units sanity check.

`npm run scroll-test` runs the **live** experiment, sweeping the mouse at a
human pace, and measures the plot it draws: that the trace scrolls at the
expected rate, and that each column holds a couple of pixels rather than
hundreds. Both halves matter. The first version of `onScrollTick` scrolled by
drawing the canvas onto *itself* (`ctx.drawImage(this.canvas, -1, 0)`), which
composites with `source-over` — under that rule transparent source pixels
leave the destination untouched, so nothing was ever erased. Every tick
stamped another shifted copy over the last one, and the plot accumulated into
an unreadable smear that crept leftward far slower than 1px/tick. The fix is
the offscreen buffer in `src/ui/experiment.ts`; this test is what keeps it
that way. Note that analysis correctness cannot catch this — the numbers were
right the whole time the plot was unreadable.

`npm run simulation-test` checks that identification actually reaches the
simulation: that ζ moves from the demo model's 0.62 to the recording's 0.126,
that the readout says which model is loaded, and that a simulated run
overshoots ~67% as that ζ predicts.

The browser tests need Playwright, which isn't a default dependency because
of its size:

```
npm install -D playwright && npx playwright install chromium
```

## Project layout

```
src/
  engine/            pure TypeScript, no DOM dependency, unit-testable in Node
    types.ts         shared data types
    complex.ts       complex-number helpers (magnitude/phase)
    dsp.ts           DFT and deconvolution
    poleConversion.ts  continuous (s) <-> discrete (z) pole mapping
    stepResponses.ts  splitting a recording into step responses, padding
    curveFit.ts       1-pole and 2-pole time-domain curve fitting
    analysis.ts       orchestrates the full pipeline + difference-equation /
                       transfer-function formatting
    dataFormat.ts     reads/writes the "All Samples" text format
  ui/
    experiment.ts     the live canvas-based tracking experiment
    plotting.ts       frequency-response and pole-plot canvas drawing
  main.ts             wires the DOM to the engine
test/
  serve.mjs           builds and serves the app for the browser tests
  validate.ts         Node-side validation against a real recording
  model-check.ts      checks the 2-pole closed form against the difference equation
  smoke-test.mjs      drives the production build in a real browser
  scroll-test.mjs     measures the live experiment's scrolling plot
  simulation-test.mjs verifies simulation replays the identified model
```

