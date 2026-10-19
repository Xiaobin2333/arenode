import { state } from '../state/index.js';
import { $ } from '../core/dom.js';

export function renderPager(selector, pagination, key) {
  const container = $(selector); if (!container) return;
  const page = Number(pagination?.page || 1); const pages = Number(pagination?.pages || 1); const total = Number(pagination?.total || 0);
  container.replaceChildren();
  const summary = document.createElement('span'); summary.textContent = `第 ${page} / ${pages} 页，共 ${total} 条`;
  const actions = document.createElement('div');
  for (const [label, target] of [['上一页', page - 1], ['下一页', page + 1]]) {
    const button = document.createElement('button'); button.className = 'secondary'; button.type = 'button'; button.textContent = label;
    button.dataset.pagerKey = key; button.dataset.page = target; button.disabled = target < 1 || target > pages; actions.append(button);
  }
  container.append(summary, actions); state.pageInfo[key] = pagination || { page, pages, total };
}
