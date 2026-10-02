// The Sessions dialog, which lists every kept session, and the Samples dialog
// it opens over itself.

import type { SimulationMode } from './experiment';
import { formatAllSamplesBlock } from '../engine/dataFormat';
import { T } from '../i18n';
import { $, closeOnBackdropClick } from './dom';
import { selfTestLabel, sessionName, statsLabel, whenLabel, whoLabel } from './labels';
import { deleteSession, listSessions, updateSession, type Session, type SessionSummary } from './sessions';

const sessionList = $<HTMLUListElement>('sessionList');
const sessionsEmpty = $<HTMLParagraphElement>('sessionsEmpty');
const sessionsUnavailable = $<HTMLParagraphElement>('sessionsUnavailable');
const samplesDialog = $<HTMLDialogElement>('samplesDialog');
const samplesTitle = $<HTMLHeadingElement>('samplesTitle');
const samplesMeta = $<HTMLParagraphElement>('samplesMeta');
const samplesOut = $<HTMLTextAreaElement>('samplesOut');
const saveDataBtn = $<HTMLButtonElement>('saveDataBtn');

closeOnBackdropClick($<HTMLDialogElement>('sessionsDialog'));
closeOnBackdropClick(samplesDialog);

/** What the list needs to know about, and do to, the rest of the app. */
export interface SessionsContext {
  /** The session on screen, if it is kept. */
  currentId(): number | null;
  isRunning(): boolean;
  /** The run on screen when nothing keeps it, or null. */
  unsaved(): { samples: { xs: Float64Array; ys: Float64Array; samplePeriodMs: number }; source: SimulationMode; summary: SessionSummary } | null;
  /** Put this session on screen. */
  open(session: Session): void;
  /** Its note changed, so its name may have. */
  renamed(session: Session): void;
  /** It is gone from the store; the run stays on screen. */
  deleted(id: number): void;
}

let ctx: SessionsContext;

export function connectSessions(context: SessionsContext) {
  ctx = context;
}

/** Runs a session-store call, and on failure says so once instead of breaking the app. */
export async function safely<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    sessionsUnavailable.hidden = false;
    return undefined;
  }
}

/** What the Samples dialog is showing, which is what its Export saves. */
interface SamplesView {
  xs: Float64Array;
  ys: Float64Array;
  samplePeriodMs: number;
  name: string;
  createdAt: number;
}
let samplesShown: SamplesView | null = null;

/** Opens one session's samples, over the Sessions list. */
function openSamples(view: SamplesView) {
  samplesShown = view;
  samplesTitle.textContent = `${T.samples} · ${view.name}`;
  const seconds = (view.xs.length * view.samplePeriodMs) / 1000;
  samplesMeta.textContent = T.samplesMeta(view.xs.length, view.samplePeriodMs, seconds.toFixed(1));
  const lines = ['n\tx[n]\ty[n]', '======================='];
  for (let i = 0; i < view.xs.length; i++) {
    lines.push(`${i}\t${view.xs[i].toFixed(3)}\t${view.ys[i].toFixed(3)}`);
  }
  samplesOut.value = lines.join('\n');
  samplesDialog.showModal();
  // Replacing the text keeps the old scroll position; a new session starts at n = 0.
  samplesOut.scrollTop = 0;
}

// Export: the samples on show, as a download in the data file format.
saveDataBtn.addEventListener('click', () => {
  if (!samplesShown) return;
  const blob = new Blob([formatAllSamplesBlock(samplesShown.xs, samplesShown.ys)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date(samplesShown.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `Pursuit Tracking Data ${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/** A small button for a row in the Sessions list. */
function rowButton(cls: string, text: string, label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The run on screen when nothing stores it -- the session store is unavailable, or
 * its session was deleted -- so its samples can still be read and exported.
 */
function unsavedRow(): HTMLLIElement | null {
  const unsaved = ctx.unsaved();
  if (!unsaved) return null;
  const shown = unsaved.samples;
  const li = document.createElement('li');
  li.className = 'session-row';
  li.dataset.unsaved = 'true';
  li.setAttribute('aria-current', 'true');
  const info = document.createElement('div');
  info.className = 'session-open';
  for (const [cls, text] of [
    ['session-when', T.onScreenNotKept],
    ['session-who', unsaved.source === 'none' ? T.you : selfTestLabel(unsaved.source)],
    ['session-stats', statsLabel(unsaved.summary)],
  ]) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    info.appendChild(span);
  }
  const data = rowButton('session-data', T.data, T.samplesOnScreen, () =>
    openSamples({ ...shown, name: T.theSessionOnScreen, createdAt: Date.now() }),
  );
  li.append(info, data);
  return li;
}

export async function renderSessions() {
  const all = await safely(listSessions);
  sessionList.innerHTML = '';
  const unsaved = unsavedRow();
  if (unsaved) sessionList.appendChild(unsaved);
  sessionsEmpty.hidden = !!unsaved || (all?.length ?? 0) > 0;
  if (!all) return;
  for (const session of all) {
    const li = document.createElement('li');
    li.className = 'session-row';
    li.setAttribute('aria-current', String(session.id === ctx.currentId()));

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'session-open';
    openBtn.title = T.openSession;
    for (const [cls, text] of [
      ['session-when', whenLabel(session.createdAt)],
      ['session-who', whoLabel(session)],
      ['session-stats', statsLabel(session.summary)],
    ]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      openBtn.appendChild(span);
    }
    openBtn.addEventListener('click', () => {
      if (ctx.isRunning()) return;
      ctx.open(session);
      // The dialog stays open, so sessions can be stepped through; only the
      // selection moves. The run that was on screen unsaved is gone now.
      for (const row of sessionList.children) {
        row.setAttribute('aria-current', String(row === li));
      }
      sessionList.querySelector('[data-unsaved]')?.remove();
    });

    // Saved as you type, a moment after you stop; no Save button to forget.
    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'session-note';
    note.value = session.note;
    note.placeholder = T.notePlaceholder;
    note.setAttribute('aria-label', T.noteFor(whenLabel(session.createdAt)));
    let noteTimer: ReturnType<typeof setTimeout> | undefined;
    const saveNote = () => {
      clearTimeout(noteTimer);
      session.note = note.value;
      ctx.renamed(session);
      void safely(() => updateSession(session.id, { note: note.value }));
    };
    note.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(saveNote, 400);
    });
    note.addEventListener('change', saveNote);
    // Enter would submit the dialog's form and close it mid-thought.
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveNote();
        note.blur();
      }
    });

    // Two presses: the first arms it, the second deletes. Deleting cannot be
    // undone, and a list of similar rows is an easy place to misclick.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'session-delete';
    del.textContent = T.delete;
    del.setAttribute('aria-label', T.deleteSession(whenLabel(session.createdAt)));
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== 'true') {
        del.dataset.confirm = 'true';
        del.textContent = T.deleteConfirm;
        return;
      }
      await safely(() => deleteSession(session.id));
      // The run stays on screen; it is just no longer kept.
      ctx.deleted(session.id);
      void renderSessions();
    });
    del.addEventListener('blur', () => {
      del.dataset.confirm = 'false';
      del.textContent = T.delete;
    });

    const data = rowButton('session-data', T.data, T.samplesOf(whenLabel(session.createdAt)), () =>
      openSamples({ ...session, name: sessionName(session) }),
    );

    li.append(openBtn, data, del, note);
    sessionList.appendChild(li);
  }
}
