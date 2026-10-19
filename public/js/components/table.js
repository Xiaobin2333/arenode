import { $$ } from '../core/dom.js';

function labelTableCells(table) {
  const labels = $$('thead th', table).map(cell => cell.textContent.trim());
  for (const row of $$('tbody tr', table)) $$('td', row).forEach((cell, index) => { cell.dataset.label = labels[index] || ''; });
}

const tableObserver = new MutationObserver(records => {
  const tables = new Set(records.map(record => record.target.closest?.('table')).filter(Boolean));
  tables.forEach(labelTableCells);
});

$$('table tbody').forEach(body => tableObserver.observe(body, { childList: true }));

export function emptyTableRow(columns, message) {
  const row = document.createElement('tr'); const cell = document.createElement('td');
  cell.colSpan = columns; cell.className = 'table-empty'; cell.textContent = message; row.append(cell); return row;
}
