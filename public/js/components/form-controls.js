export function fillSelect(select, rows, label, includeBlank = false) {
  const options = rows.map(row => { const option = document.createElement('option'); option.value = row.id; option.textContent = label(row); return option; });
  if (includeBlank) { const blank = document.createElement('option'); blank.value = ''; blank.textContent = '不分组'; options.unshift(blank); }
  select.replaceChildren(...options);
}

export function fillResourceOptions(select, items, selected, emptyLabel = null) {
  const options = [];
  if (emptyLabel !== null) { const empty = document.createElement('option'); empty.value = ''; empty.textContent = emptyLabel; options.push(empty); }
  for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name || item.domain || `#${item.id}`; options.push(option); }
  select.replaceChildren(...options); if (selected !== undefined && selected !== null) select.value = String(selected);
}
