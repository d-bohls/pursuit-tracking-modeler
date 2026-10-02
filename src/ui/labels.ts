// The words and numbers the interface shows, worked out in one place so the
// plot, the readout and the Sessions list say things the same way.

import { dampingCharacter } from '../engine/analysis';
import { locale, T } from '../i18n';
import type { SimulationMode } from './experiment';
import type { Session, SessionSummary } from './sessions';

export function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export const modelName = (m: SimulationMode) => (m === 'first' ? T.firstOrderModel : T.secondOrderModel);

/** How a model's own run is named wherever a person's would be. */
export const selfTestLabel = (m: SimulationMode) =>
  `${modelName(m).replace(/^./, (c) => c.toUpperCase())}${T.selfTestSuffix}`;

export const responseCount = (n: number) => T.stepResponses(n);

/** "underdamped", "critically damped" or "overdamped", in the current language. */
export const dampingName = (zeta: number) => T.damped[dampingCharacter(zeta)];

/**
 * Running time to a tenth of a second, switching to m:ss.s past a minute.
 * The tenth is why onSampleTick emits state: a whole-second reading updated
 * only on step response ticks looks stopped between steps.
 */
export function elapsed(ms: number): string {
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const mins = Math.floor(total / 60);
  return `${mins}:${(total - mins * 60).toFixed(1).padStart(4, '0')}`;
}

/** "Today · 14:32", "Yesterday · 09:05", "Sep 3 · 18:40". */
export function whenLabel(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Built from the calendar, not today minus 24 h: across a daylight-saving
  // change a day is 23 or 25 hours long.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (day === today) return T.today(time);
  if (day === yesterday) return T.yesterday(time);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString(locale(), opts)} · ${time}`;
}

/** Your note if you wrote one, else the file it came from, else when it was made. */
export function sessionName(session: { note: string; fileName?: string; createdAt: number }): string {
  return session.note.trim() || session.fileName || whenLabel(session.createdAt);
}

export function whoLabel(session: Session): string {
  if (session.fileName) return session.fileName;
  return session.source === 'none' ? T.you : selfTestLabel(session.source);
}

export function statsLabel(s: SessionSummary | null): string {
  if (!s) return '';
  const n = s.responses;
  const count = T.steps(n);
  if (s.included === 0) return `${count} · ${T.allExcludedShort}`;
  return `${count} · ζ ${s.zeta.toFixed(2)} · ${T.msDelay(s.delayMs.toFixed(0))}`;
}
