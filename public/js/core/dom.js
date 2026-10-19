export const $ = (selector, root = document) => root.querySelector(selector);

export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function queryPath(path, values = {}, page = 1) {
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== null && value !== undefined) params.set(key, value);
  return `${path}?${params}`;
}

export function nextDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10);
}
