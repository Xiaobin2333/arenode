import { $ } from '../core/dom.js';

export function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 2800);
}

export async function copyText(value, successMessage = '内容已复制') {
  const text = String(value ?? '');
  if (!text) throw new Error('没有可复制的内容');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API 不可用');
    await navigator.clipboard.writeText(text);
  } catch (primaryError) {
    const textarea = document.createElement('textarea');
    textarea.value = text; textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed'; textarea.style.opacity = '0';
    document.body.append(textarea); textarea.select();
    const copied = document.execCommand('copy'); textarea.remove();
    if (!copied) throw primaryError;
  }
  toast(successMessage);
}
