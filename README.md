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

You can also import a data file
(`test/data/reference-data.txt` is one) instead of running a
live experiment.

## The interface

- **One page.** The plot, the step responses and your model share one
  scrolling page, and the model is re-identified as each step response
  closes, so you can watch ζ settle while you are still tracking. Only
  Sessions and Settings open over it.
- **The plot explains itself.** Record session and Replay sit on the plot,
  with a few lines of help at its foot: what to do while recording, and how
  to start and stop (the Space bar, or on a touchscreen holding the button or
  the plot). A run ends itself after 10 step responses.
- **Step responses are objects, not table rows.** Each step becomes a card
  with a thumbnail of the step and the response to it. Untick one and every
  number re-derives from what is left — outlier rejection is a decision you
  make and see, not a heuristic that happens to you. Pick one to see its step
  response, frequency response and poles; drag the poles to explore.
- **Fit error is measured against the step that provoked it.** Steps are drawn
  from a 3× range of sizes, so raw pixels are not comparable between step
  responses: on the reference recording step 3 (9.1 px on a 39 px step) reads as
  better than step 2 (11.0 px on 77 px) in pixels, and far worse — 23% against
  14% — as a fraction of the step. Step responses are flagged at 3× the median
  in *both* directions: a fit far worse than its peers did not measure the
  same system, and a fit far better is just as suspect. The reference recording has
  one of the latter, at 0.3% where every other step response sits above 10% —
  a step response with almost no dynamics in it, contributing a confident
  number about nothing.
- **The headline is about you**, not about the polynomial: reaction delay,
  overshoot, damping, natural frequency. `H(s)` and `H(z)` are set as actual
  fractions underneath as the supporting evidence.
- **The model can run beside you.** Replay plays the session back with the
  identified model driven by the same target, so you can see where the model
  and the hand disagree. It is never drawn while you record: a line to follow
  would change what is being measured.
- **Sessions are kept.** Every session is saved in the browser (IndexedDB) and
  the open one reopens on reload. Click a session's name to rename it; open,
  export or delete any of them from Sessions.
- Dark mode, HiDPI-correct canvases, pointer (not mouse) input so a phone or
  tablet works, and a data palette validated for colour-vision deficiency.
- On a wide screen the plot is a full-width row with the session and your
  model sharing the space beneath it; both cards use container queries, so
  they lay themselves out by the room they actually have rather than by the
  size of the window. Settings and the theme persist in `localStorage`.

The recording coordinate space is fixed at 493 units (`LOGICAL_HEIGHT`) rather
than following the canvas, so a recording's step sizes and RMS error mean the
same thing at any window size.

## Running it

**Requires Node 22.12 or newer.**

```
npm install
npm run dev         # local dev server with hot reload
npm run build       # production build into dist/
npm run validate    # replay the reference recording through the engine, headless
npm run model-check # verify the 2-pole model against the difference equation
npm run damping-check    # critically damped and overdamped responses are named as such
```

### Troubleshooting

Requires Node 22.12 or later.

### Tests

`npm run smoke-test` drives the production build in a real browser
(Playwright), loads the reference recording through the file picker, runs the
analysis, and asserts the rendered model matches what the engine produces
headlessly — plus a units sanity check.

`npm run scroll-test` runs the **live** experiment, sweeping the mouse at a
human pace, and measures the plot it draws: that the trace scrolls at the
expected rate, and that each column holds a couple of pixels rather than
hundreds. Both halves matter: scrolling a canvas by drawing it onto itself
(`ctx.drawImage(this.canvas, -1, 0)`) composites with `source-over`, under
which transparent pixels leave the destination untouched, so nothing is ever
erased and the plot smears into an unreadable band that creeps far slower
than it should. The plot is redrawn from a history buffer instead, and this
test keeps it that way. Analysis correctness cannot catch this kind of
failure: the numbers stay right while the plot is unreadable.

`npm run simulation-test` checks that identification actually reaches the
simulation: that ζ moves from the demo model's 0.62 to the recording's 0.126,
that the readout says which model is loaded, and that a simulated run
overshoots ~67% as that ζ predicts. A simulation playing some other system
than the identified one would fail nothing else, so this test is what notices.
It opens the page with `?selftest`, which shows the self-test controls in
Settings; they are hidden otherwise.

`npm run touch-test` holds a finger on Record and on the plot, and checks that
lifting it stops the run. `npm run sessions-test` checks that sessions are
kept across reloads, reopen with their notes and unticked step responses, and
can be renamed and deleted.

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
    complex.ts       complex magnitude
    dsp.ts           DFT and deconvolution
    poleConversion.ts  continuous (s) <-> discrete (z) pole mapping
    stepResponses.ts  splitting a recording into step responses, padding
    curveFit.ts       1-pole and 2-pole time-domain curve fitting
    analysis.ts       orchestrates the full pipeline + difference-equation /
                       transfer-function formatting
    dataFormat.ts     reads/writes the "All Samples" text format
  ui/
    experiment.ts     the live canvas-based tracking experiment
    plotting.ts       step-response, frequency-response and pole-plot drawing
    sessions.ts       sessions kept in the browser's IndexedDB
  main.ts             wires the DOM to the engine
test/
  serve.mjs           builds and serves the app for the browser tests
  validate.ts         Node-side validation against the reference recording
  model-check.ts      checks the 2-pole closed form against the difference equation
  damping-check.ts    critical and overdamped responses are named correctly
  smoke-test.mjs      drives the production build in a real browser
  scroll-test.mjs     measures the live experiment's scrolling plot
  simulation-test.mjs verifies simulation replays the identified model
  touch-test.mjs      holding and lifting a finger records and stops
  sessions-test.mjs   sessions are kept, reopened, renamed and deleted
  data/reference-data.txt  a real recording, used by validate and the tests
```

