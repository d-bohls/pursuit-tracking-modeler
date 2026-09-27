// The open session's name in the heading over its step responses, and
// renaming it in place.

import { $ } from './dom';
import { sessionName } from './labels';
import { getSession, updateSession, type Session } from './sessions';
import { safely } from './sessionsView';

const sessionNameEl = $<HTMLSpanElement>('sessionName');
const sessionSepEl = $<HTMLSpanElement>('sessionSep');
const sessionNameInput = $<HTMLInputElement>('sessionNameInput');

let currentId: () => number | null = () => null;

/** Tells the heading which session is open, so a rename lands on the right one. */
export function connectSessionTitle(openSessionId: () => number | null) {
  currentId = openSessionId;
}

/**
 * Shows which session the step responses belong to, in the heading over the step responses. An empty
 * name leaves it as plain "Session": nothing is kept yet, or the
 * step responses on screen belong to a run still in progress.
 */
export function setSessionName(name: string) {
  cancelRename();
  sessionSepEl.hidden = sessionNameEl.hidden = !name;
  sessionNameEl.textContent = name;
  sessionNameEl.title = name ? `${name} — click to rename` : '';
  sessionNameEl.parentElement!.title = name ? `Session · ${name}` : '';
}

/*
 * Renaming in place: the name in the heading turns into a field. What you
 * type is the session's note -- the same one the Sessions list edits --
 * and clearing it falls back to the file name or the time, shown as the
 * placeholder so you can see what you would get.
 */
let renaming: { id: number; session: Session } | null = null;

async function startRename() {
  const id = currentId();
  if (id === null || renaming) return;
  const session = await safely(() => getSession(id));
  if (!session || id !== currentId()) return;
  renaming = { id, session };
  sessionNameInput.value = session.note;
  sessionNameInput.placeholder = sessionName({ ...session, note: '' });
  sessionNameEl.hidden = true;
  sessionNameInput.hidden = false;
  sessionNameInput.focus();
  sessionNameInput.select();
}

function endRename() {
  renaming = null;
  sessionNameInput.hidden = true;
  sessionNameEl.hidden = sessionNameEl.textContent === '';
}

function cancelRename() {
  if (renaming) endRename();
}

function commitRename() {
  if (!renaming) return;
  const { id, session } = renaming;
  endRename();
  const note = sessionNameInput.value.trim();
  if (note === session.note) return;
  session.note = note;
  void safely(() => updateSession(id, { note }));
  if (id === currentId()) setSessionName(sessionName(session));
}

sessionNameEl.addEventListener('click', () => void startRename());
sessionNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    // Space would otherwise reach the page's handler and start a run.
    e.stopPropagation();
    void startRename();
  }
});
sessionNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRename();
    sessionNameEl.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelRename();
    sessionNameEl.focus();
  }
});
sessionNameInput.addEventListener('blur', commitRename);
