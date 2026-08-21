export function pagination(url, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || String(defaultSize), 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paged(items, total, page, pageSize, key = 'items') {
  return { [key]: items, pagination: { page, pageSize, total: Number(total), pages: Math.max(1, Math.ceil(Number(total) / pageSize)) } };
}

export function searchLike(value) {
  return `%${String(value || '').trim().replace(/[\\%_]/g, character => `\\${character}`)}%`;
}
