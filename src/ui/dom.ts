// Small DOM helpers shared by the UI modules.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Fills a list with one item per line of text. */
export function setList(list: HTMLUListElement, items: string[]) {
  list.innerHTML = '';
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

/**
 * Click the backdrop to dismiss. A click on a dialog's ::backdrop is reported
 * against the dialog element itself, so the target check alone nearly does
 * it -- the rect test covers the dialog's own padding box, where the target
 * is also the dialog but the click is genuinely inside it.
 */
export function closeOnBackdropClick(dialog: HTMLDialogElement) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
}
