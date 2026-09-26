# Tracking Lab

## What it does

1. **Live experiment** — a black target line jumps to a random vertical
   position every few seconds (a step input). You track it with the mouse.
   Both positions are recorded at a configurable sample rate.
2. **Analysis** — the recording is split into trials at each step, the
   target/response pair is deconvolved to get an impulse response `h[n]`,
   and `h[n]` is curve-fit (brute-force, coarse-to-fine grid search) to a
   first-order and a second-order discrete-time pole model.
3. **Laplace domain** — the identified discrete poles are converted to their
   continuous-time (`s`-plane) equivalents, and displayed as a standard
   second-order transfer function `H(s) = ωn² / (s² + 2ζωn·s + ωn²)` with its
   natural frequency, damping ratio, and pure time delay.

You can also load a previously recorded `test/data/reference-data.txt` file instead of running a live experiment —
useful for re-analyzing old recordings.

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
    trials.ts        splitting a recording into trials, padding
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

