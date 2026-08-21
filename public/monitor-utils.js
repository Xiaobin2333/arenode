const MONITOR_COLLECTION_KEYS = ['items', 'rows', 'list', 'data', 'result', 'values', 'points', 'series'];
const MONITOR_TIME_ZONE = 'Asia/Shanghai';

function isPointPair(value) {
  return Array.isArray(value)
    && value.length >= 2
    && ['string', 'number'].includes(typeof value[0])
    && value[1] !== null
    && value[1] !== undefined
    && value[1] !== ''
    && Number.isFinite(Number(value[1]));
}

function unwrapMonitorCollection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  for (const key of MONITOR_COLLECTION_KEYS) {
    if (Object.hasOwn(value, key)) return unwrapMonitorCollection(value[key]);
  }
  return value;
}

export function normalizeMonitorItems(data) {
  const value = unwrapMonitorCollection(data);
  if (isPointPair(value)) return [{ time: value[0], value: Number(value[1]) }];
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (isPointPair(item)) return [{ time: item[0], value: Number(item[1]) }];
      if (item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.value)) {
        const seriesName = item.name ?? item.title ?? item.res ?? '';
        const points = item.value.filter(isPointPair).map(point => ({ ...item, name: seriesName, series: seriesName, time: point[0], value: Number(point[1]) }));
        if (points.length || item.value.length === 0) return points;
      }
      return item && typeof item === 'object' ? [item] : [];
    });
  }
  if (!value || typeof value !== 'object') return [];
  const ignored = new Set(['count', 'total', 'page', 'page_size', 'pageSize']);
  return Object.entries(value).filter(([name]) => !ignored.has(name)).map(([name, item]) => ({ name, value: item }));
}

function pointValue(item) {
  return item?.value ?? item?.traffic ?? item?.bandwidth ?? item?.count ?? item?.qps ?? item?.req ?? item?.up_recv;
}

export function collectMonitorPoints(data) {
  const points = normalizeMonitorItems(data).flatMap((item, index) => {
    const value = Number(pointValue(item));
    if (!Number.isFinite(value)) return [];
    const label = item.time ?? item.date ?? item.timestamp ?? item['@timestamp'] ?? item.name ?? item.title ?? item.res ?? item.port ?? index;
    return [{ label: String(label), value }];
  });
  const aggregated = new Map();
  for (const point of points) aggregated.set(point.label, (aggregated.get(point.label) || 0) + point.value);
  return [...aggregated].map(([label, value]) => ({ label, value })).sort((left, right) => {
    const a = Number(left.label); const b = Number(right.label);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
  });
}

function parseMonitorDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d{10,16}$/.test(text)) {
    const timestamp = Number(text);
    const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const nginx = text.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/);
  if (nginx) {
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const month = months[nginx[2]];
    if (month) {
      const iso = `${nginx[3]}-${month}-${nginx[1].padStart(2, '0')}T${nginx[4]}:${nginx[5]}:${nginx[6]}${nginx[7]}:${nginx[8]}`;
      const date = new Date(iso);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMonitorTime(value) {
  if (value === null || value === undefined || value === '') return '-';
  const date = parseMonitorDate(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: MONITOR_TIME_ZONE,
  }).format(date);
}

export function formatMonitorChartLabel(value) {
  const date = parseMonitorDate(value);
  if (!date) return String(value ?? '-');
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: MONITOR_TIME_ZONE,
  }).format(date);
}

export function formatMonitorBandwidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  const units = ['bit/s', 'Kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s']; let amount = numeric; let index = 0;
  while (Math.abs(amount) >= 1000 && index < units.length - 1) { amount /= 1000; index += 1; }
  return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${units[index]}`;
}
