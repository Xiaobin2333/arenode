import { $, $$ } from '../core/dom.js';

let confirmResolver = null;

export function confirmAction({ title = '确认操作', message, confirmLabel = '确认', danger = false } = {}) {
  if (confirmResolver) confirmResolver(false);
  const dialog = $('#confirmDialog'); $('#confirmDialogTitle').textContent = title;
  const body = $('#confirmDialogBody'); body.replaceChildren();
  const paragraph = document.createElement('p'); paragraph.textContent = message || '确认继续执行此操作？'; body.append(paragraph);
  const accept = $('#confirmDialogAccept'); accept.textContent = confirmLabel; accept.className = danger ? 'danger-button' : 'primary';
  dialog.showModal();
  return new Promise(resolve => { confirmResolver = resolve; });
}

$$('[data-confirm-value]').forEach(button => button.addEventListener('click', () => {
  const accepted = button.dataset.confirmValue === 'true'; $('#confirmDialog').close();
  const resolve = confirmResolver; confirmResolver = null; resolve?.(accepted);
}));

export function showRecords(title, records, emptyText = '暂无记录') {
  $('#recordDialogTitle').textContent = title; const body = $('#recordDialogBody'); body.replaceChildren();
  if (!records.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = emptyText; body.append(empty); }
  else for (const record of records) { const item = document.createElement('div'); item.className = 'record-item';
    const strong = document.createElement('strong'); strong.textContent = record.title; const small = document.createElement('small'); small.textContent = record.detail || '';
    item.append(strong, small); body.append(item); }
  $('#recordDialog').showModal();
}

$$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
