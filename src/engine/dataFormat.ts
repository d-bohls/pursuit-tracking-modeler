// Reads and writes the "All Samples" data file format
// (test/data/reference-data.txt is one), so exported sessions can be imported
// again. Only the raw xs/ys are read; any other sections in a file are
// ignored.

export interface RawSamples {
  xs: Float64Array;
  ys: Float64Array;
}

/**
 * Parses the tab-separated `n / x[n] / y[n]` table shown in the Samples pane.
 * That pane is selectable text, so this is the format you get by copying a
 * recording straight out of the running app -- worth supporting, since before
 * the Save button existed it was the only way to rescue a run.
 */
export function parseSamplesTable(text: string): RawSamples {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/[\t,;]+|\s{2,}|\s+/).filter((c) => c.length > 0);
    if (cols.length < 3) continue;
    const [n, x, y] = cols.map(Number);
    if (!Number.isFinite(n) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0) throw new Error('No "n  x[n]  y[n]" rows found in this file.');
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

/** Reads either supported format, choosing by content. */
export function parseRecording(text: string): RawSamples {
  return /All Samples/.test(text) ? parseAllSamplesBlock(text) : parseSamplesTable(text);
}

export function parseAllSamplesBlock(fileText: string): RawSamples {
  const match = fileText.match(/=+\s*All Samples\s*=+\s*xs=\[([^\]]*)\];\s*ys=\[([^\]]*)\];/);
  if (!match) {
    throw new Error('Could not find an "All Samples" block in this file.');
  }
  const parseList = (s: string) =>
    Float64Array.from(
      s
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
        .map(Number),
    );
  return { xs: parseList(match[1]), ys: parseList(match[2]) };
}

/** Writes a file compatible with parseAllSamplesBlock, for exporting a new recording. */
export function formatAllSamplesBlock(xs: Float64Array, ys: Float64Array): string {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const fmt = (arr: Float64Array) => Array.from(arr, round).join(',');
  return `\n============= All Samples =============\n\nxs=[${fmt(xs)}];\n\nys=[${fmt(ys)}];\n`;
}
