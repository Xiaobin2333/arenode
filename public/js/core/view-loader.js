import { handleError } from '../services/api-client.js';
import { $ } from './dom.js';
import { showView } from './router.js';

export async function loadViewState(name, task) {
  const view = $(`#${name}`); if (!view) return;
  const token = Symbol(name); view.loadToken = token; view.classList.add('loading'); $('.view-error', view)?.remove();
  try { await task(); }
  catch (error) {
    const banner = document.createElement('div'); banner.className = 'view-error';
    const message = document.createElement('span'); message.textContent = error.message || '数据加载失败';
    const retry = document.createElement('button'); retry.className = 'secondary'; retry.type = 'button'; retry.textContent = '重试'; retry.dataset.retryView = name;
    banner.append(message, retry); view.prepend(banner); handleError(error);
  } finally { if (view.loadToken === token) view.classList.remove('loading'); }
}

document.addEventListener('click', event => { const retry = event.target.closest('[data-retry-view]'); if (retry) showView(retry.dataset.retryView); });
