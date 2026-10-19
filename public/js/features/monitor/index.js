import { state } from '../../state/index.js';
import { formatMonitorBandwidth, formatMonitorTime, normalizeMonitorItems } from '../../../monitor-utils.js';
import { showRecords } from '../../components/dialog.js';
import { $, $$ } from '../../core/dom.js';
import { formatBytes } from '../../core/format.js';
import { navigateFromButton } from '../../core/router.js';
import { api, handleError } from '../../services/api-client.js';
import { loadLocalLogs, syncDataPageContext } from '../../views/data-view.js';
import { collectTrafficPoints, drawTrafficChart } from '../../views/overview-view.js';

export function setDefaultMonitorDates() {
  const form = $('#monitorForm');
  const end = new Date(); const start = new Date(end); start.setHours(0, 0, 0, 0);
  const local = date => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  form.elements.start.value = local(start); form.elements.end.value = local(end);
  $$('[data-monitor-hours], [data-monitor-minutes], [data-monitor-today]').forEach(button => button.classList.toggle('active', button.hasAttribute('data-monitor-today')));
}

const monitorMetricOptions = {
  basic: [['traffic', '流量'], ['bandwidth', '带宽'], ['req', '请求数'], ['qps', 'QPS']],
  quality: [['status-4xx', '4xx 状态码'], ['status-5xx', '5xx 状态码'], ['req-cache-status', '请求缓存状态'], ['byte-cache-status', '流量缓存状态']],
  origin: [['backend-bandwidth', '回源带宽'], ['backend-traffic', '回源流量'], ['backend-resp-time', '回源响应时间']],
};

const monitorTopOptions = [
  ['top-ip', '客户端 IP'], ['top-country', '国家 / 地区'], ['top-province', '省份'],
  ['top-isp', '运营商'], ['top-url', 'URL'], ['top-domain', '域名'],
  ['top-tls-fp', 'TLS 指纹'], ['top-referer', '来源页面'],
];

const accessLogHeaders = ['时间', '域名', '端口', '协议', '方法', 'URI', '状态码', '客户端 IP', 'TLS 指纹', '地理位置', '运营商', '源地址', '内容类型', '来源', '浏览器', '回源耗时', '返回字节', '缓存命中', '操作'];

export function setMonitorContext(context = 'site', preferredEndpoint = null, { autoQuery = true } = {}) {
  state.monitorContext = ['site', 'logs', 'audit'].includes(context) ? context : 'site';
  const candidates = $$('[data-monitor-mode]', $('#monitorRail')).filter(button => {
    const visible = button.dataset.monitorContextItem === state.monitorContext
      && !(button.dataset.endpoint === 'attack-log' && state.capabilities.attackLogs === false);
    button.classList.toggle('hidden', !visible); return visible;
  });
  const endpointCandidates = preferredEndpoint ? candidates.filter(button => button.dataset.endpoint === preferredEndpoint) : [];
  let active = endpointCandidates.find(button => button.dataset.monitorMode === state.monitorMode)
    || endpointCandidates[0]
    || candidates.find(button => button.dataset.monitorMode === state.monitorMode)
    || candidates[0];
  if (!active) return;
  state.monitorMode = active.dataset.monitorMode;
  candidates.forEach(button => button.classList.toggle('active', button === active));
  state.monitorEndpoint = active.dataset.endpoint;
  resetMonitorResults();
  const localLogKind = active.dataset.localLogKind;
  $('#monitorQueryPanel').classList.toggle('hidden', Boolean(localLogKind));
  $('#monitorCharts').classList.add('hidden');
  $('#monitorResults').classList.toggle('hidden', Boolean(localLogKind));
  $('#localLogPanel').classList.toggle('hidden', !localLogKind);
  if (localLogKind) {
    state.logKind = localLogKind;
    syncDataPageContext({ dataset: { monitorEndpoint: active.dataset.endpoint } });
    loadLocalLogs().catch(handleError);
    return;
  }
  const form = $('#monitorForm'); form.elements.endpoint.value = active.dataset.endpoint; syncMonitorFields();
  if (active.dataset.metric && [...form.elements.metric.options].some(option => option.value === active.dataset.metric)) form.elements.metric.value = active.dataset.metric;
  syncDataPageContext({ dataset: { monitorEndpoint: active.dataset.endpoint } });
  if (autoQuery && monitorFormCanQuery()) queryMonitor(form).catch(handleError);
}

function syncMonitorFields() {
  const form = $('#monitorForm');
  const endpoint = form.elements.endpoint.value;
  const field = $('#monitorMetricField');
  const select = form.elements.metric;
  const isTop = ['top', 'stream-top'].includes(endpoint);
  const stream = endpoint.startsWith('stream-');
  const visible = isTop || ['realtime', 'stream-realtime', 'usage'].includes(endpoint);
  field.classList.toggle('hidden', !visible);
  $('#monitorSiteField').classList.toggle('hidden', stream);
  $('#monitorStreamField').classList.toggle('hidden', !stream);
  form.elements.siteId.required = !stream;
  $('#monitorMetricLabel').textContent = isTop ? '排行维度' : '指标';
  const options = isTop ? (endpoint === 'stream-top' ? [['top-ports', '监听端口']] : monitorTopOptions)
    : endpoint === 'stream-realtime' ? [['stream-bandwidth', '带宽'], ['stream-traffic', '流量'], ['stream-req', '请求数'], ['stream-qps', 'QPS']]
      : endpoint === 'realtime' ? (monitorMetricOptions[state.monitorMode] || monitorMetricOptions.basic)
        : monitorMetricOptions.basic;
  const current = select.value;
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
  }));
  if (options.some(([value]) => value === current)) select.value = current;
  const range = Number(new Date(form.elements.end.value) - new Date(form.elements.start.value));
  $$('[data-monitor-minutes]').forEach(button => button.classList.toggle('hidden', !isTop));
  $$('[data-monitor-hours]').forEach(button => button.classList.toggle('hidden', isTop && Number(button.dataset.monitorHours) !== 1));
  $('[data-monitor-today]').classList.toggle('hidden', isTop);
  if (isTop && (!Number.isFinite(range) || range > 60 * 60_000)) setMonitorRange(60, 'minutes');
}

function formatMonitorValue(item) {
  const value = item.value ?? item.traffic ?? item.bandwidth ?? item.status ?? item.count ?? item.qps;
  if (value === null || value === undefined || value === '') return '-';
  const numeric = Number(value); if (!Number.isFinite(numeric)) return String(value);
  const metric = $('#monitorForm').elements.metric.value;
  if (metric.includes('traffic') || item.traffic !== undefined) return formatBytes(numeric);
  if (metric.includes('bandwidth') || item.bandwidth !== undefined) return formatMonitorBandwidth(numeric);
  if (metric.includes('resp-time')) return `${(numeric * 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ms`;
  return numeric.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function setMonitorTableHeaders(labels, accessLog = false) {
  const head = $('#monitorTableHead');
  head.replaceChildren(...labels.map(label => {
    const th = document.createElement('th'); th.textContent = label; return th;
  }));
  $('#monitorResultTable').classList.toggle('access-log-table', accessLog);
}

export function resetMonitorResults() {
  state.monitorRequestId += 1;
  state.monitorItems = []; state.monitorPoints = [];
  setMonitorTableHeaders(state.monitorEndpoint === 'access-log' ? accessLogHeaders : ['时间 / 资源', '数值 / 状态', '范围 / 地址', '详情'], state.monitorEndpoint === 'access-log');
  $('#monitorTable').replaceChildren(); $('#monitorCount').textContent = '0 项'; $('#monitorEmpty').classList.remove('hidden');
  $('#monitorCharts').classList.add('hidden'); $('#monitorSummary').replaceChildren();
  const canvas = $('#monitorChart'); const context = canvas?.getContext('2d'); if (context) context.clearRect(0, 0, canvas.width, canvas.height);
  $('#monitorChartEmpty').classList.remove('hidden');
}

export function monitorFormCanQuery() {
  const form = $('#monitorForm'); const endpoint = form.elements.endpoint.value;
  if (!form.elements.start.value || !form.elements.end.value) return false;
  return endpoint.startsWith('stream-') || Boolean(form.elements.siteId.value);
}

function monitorDocumentId(item) {
  return item.id ?? item._id ?? item.document_id;
}

function renderAccessLogRow(item, index) {
  const tr = document.createElement('tr');
  tr.replaceChildren(...Array.from({ length: 19 }, () => document.createElement('td')));
  tr.children[5].className = 'access-uri'; tr.children[8].className = 'access-fingerprint';
  for (const position of [12, 13, 14]) tr.children[position].className = 'access-truncate';
  tr.lastElementChild.className = 'right';
  tr.children[0].textContent = formatMonitorTime(item.time ?? item.timestamp ?? item['@timestamp']);
  tr.children[1].textContent = item.host || item.host2 || item.domain || '-';
  tr.children[2].textContent = item.server_port ?? item.port ?? '-';
  tr.children[3].textContent = String(item.protocol || '-').toUpperCase();
  const method = String(item.method || item.req_method || '-').toUpperCase();
  tr.children[4].innerHTML = `<span class="request-method request-method-${method.toLowerCase()}"></span>`;
  $('span', tr.children[4]).textContent = method;
  const uri = String(item.req_uri || item.request_uri || item.uri || '-'); tr.children[5].textContent = uri; tr.children[5].title = uri;
  const status = Number(item.status ?? item.status_code); const statusText = Number.isFinite(status) ? String(status) : '-';
  tr.children[6].innerHTML = '<span class="http-status"></span>'; $('span', tr.children[6]).textContent = statusText;
  $('span', tr.children[6]).classList.add(Number.isFinite(status) && status >= 500 ? 'status-error' : Number.isFinite(status) && status >= 400 ? 'status-warning' : 'status-success');
  tr.children[7].textContent = item.addr || item.client_ip || item.ip || '-';
  const fingerprint = String(item.tls_fp || item.tls_fingerprint || '-'); tr.children[8].textContent = fingerprint; tr.children[8].title = fingerprint;
  tr.children[9].textContent = [item.country || item.country_name, item.province, item.city].filter(Boolean).join(' / ') || '-';
  tr.children[10].textContent = item.isp || '-';
  tr.children[11].textContent = item.sip || '-';
  tr.children[12].textContent = item.content_type || '-';
  tr.children[13].textContent = item.referer || item.http_referer || '-';
  tr.children[14].textContent = item.user_agent || item.http_user_agent || '-';
  for (const position of [12, 13, 14]) tr.children[position].title = tr.children[position].textContent;
  tr.children[15].textContent = item.up_resp_time ?? '-';
  tr.children[16].textContent = item.bytes_sent === undefined || item.bytes_sent === null ? '-' : formatBytes(item.bytes_sent);
  tr.children[17].textContent = item.cache_status || '-';
  const documentId = monitorDocumentId(item);
  if (documentId !== undefined && documentId !== null) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '查看详情';
    button.dataset.monitorDocument = documentId; button.dataset.monitorIndex = String(index); tr.lastElementChild.append(button);
  } else tr.lastElementChild.textContent = '-';
  return tr;
}

function renderMonitorData(data) {
  const items = normalizeMonitorItems(data); state.monitorItems = items;
  const accessLog = state.monitorEndpoint === 'access-log';
  setMonitorTableHeaders(accessLog
    ? accessLogHeaders
    : ['时间 / 资源', '数值 / 状态', '范围 / 地址', '详情'], accessLog);
  const rows = accessLog ? items.map(renderAccessLogRow) : items.map((item, index) => {
    const tr = document.createElement('tr');
    const rawTime = item.time ?? item.date ?? item.timestamp ?? item['@timestamp'];
    const label = rawTime ?? item.name ?? item.title ?? item.res ?? '-';
    const scope = item.series || item.host || item.domain || item.ip || item.client_ip || item.addr || '-';
    tr.innerHTML = '<td></td><td></td><td></td><td><small></small></td>';
    tr.children[0].textContent = rawTime === undefined ? String(label) : formatMonitorTime(rawTime);
    tr.children[1].textContent = formatMonitorValue(item); tr.children[2].textContent = String(scope);
    const detail = $('small', tr); detail.textContent = '-';
    const documentId = monitorDocumentId(item);
    if (state.monitorEndpoint === 'attack-log' && documentId !== undefined && documentId !== null) {
      detail.textContent = '';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '查看详情'; button.dataset.monitorDocument = documentId; button.dataset.monitorIndex = String(index); tr.lastElementChild.append(button);
    }
    return tr;
  });
  $('#monitorTable').replaceChildren(...rows); $('#monitorCount').textContent = `${rows.length} 项`;
  $('#monitorEmpty').classList.toggle('hidden', rows.length !== 0);
  const values = items.map(item => Number(item.value ?? item.traffic ?? item.bandwidth ?? item.count ?? item.qps)).filter(Number.isFinite);
  $('#dataSummaryStreams').textContent = values.length ? Math.max(...values).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-';
  $('#dataSummarySites').textContent = rows.length; $('#dataSummaryJobs').textContent = state.sites.length;
  $('#dataSummaryPorts').textContent = $('#monitorForm').elements.metric.selectedOptions[0]?.textContent || '日志';
  renderMonitorVisuals(data, items);
}

function renderMonitorVisuals(data, items) {
  const chartEndpoint = ['realtime', 'stream-realtime', 'stream-top', 'top', 'usage', 'attack-stats'].includes(state.monitorEndpoint);
  const points = chartEndpoint ? collectTrafficPoints(data) : [];
  state.monitorPoints = points;
  $('#monitorCharts').classList.toggle('hidden', !chartEndpoint);
  if (chartEndpoint) requestAnimationFrame(() => drawTrafficChart('#monitorChart', '#monitorChartEmpty', state.monitorPoints));
  const values = items.map(item => Number(item.value ?? item.traffic ?? item.bandwidth ?? item.count ?? item.qps)).filter(Number.isFinite);
  const total = values.reduce((sum, value) => sum + value, 0); const maximum = values.length ? Math.max(...values) : 0;
  const metricLabel = $('#monitorForm').elements.metric.selectedOptions[0]?.textContent || '查询数据';
  $('#monitorChartTitle').textContent = `${metricLabel}趋势`; $('#monitorChartUnit').textContent = metricLabel;
  const summaries = [['结果记录', `${items.length} 项`], ['数据点', `${points.length} 个`], ['合计', values.length ? total.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-'], ['峰值', values.length ? maximum.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-']];
  $('#monitorSummary').replaceChildren(...summaries.map(([label, value]) => { const item = document.createElement('div'); item.innerHTML = '<span></span><strong></strong>'; $('span', item).textContent = label; $('strong', item).textContent = value; return item; }));
}

export async function queryMonitor(form) {
  const values = Object.fromEntries(new FormData(form));
  state.monitorEndpoint = values.endpoint;
  const requestId = ++state.monitorRequestId;
  const startAt = new Date(values.start); const endAt = new Date(values.end);
  if (!values.start || !values.end || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) throw new Error('请选择有效的开始和结束时间');
  if (startAt >= endAt) throw new Error('结束时间必须晚于开始时间');
  const ranking = ['top', 'stream-top'].includes(values.endpoint);
  const rankingMinutes = Math.ceil((endAt - startAt) / 60_000);
  if (ranking && rankingMinutes > 60) throw new Error('数据排行时间范围不能超过 1 小时');
  const time = value => value.replace('T', ' ') + ':00';
  const base = new URLSearchParams({ ...(values.siteId ? { site_id: values.siteId } : {}), ...(values.port ? { port: values.port } : {}), start: time(values.start), end: time(values.end) });
  let path;
  if (values.endpoint === 'realtime') { base.set('type', values.metric); path = '/monitor/site/realtime'; }
  else if (values.endpoint === 'stream-realtime') { base.set('type', values.metric); path = '/monitor/stream/realtime'; }
  else if (values.endpoint === 'stream-top') {
    base.set('type', 'top-ports'); base.set('recent_time', rankingMinutes <= 10 ? '10m' : rankingMinutes <= 30 ? '30m' : '60m');
    base.delete('start'); base.delete('end'); path = '/monitor/stream/top';
  }
  else if (values.endpoint === 'access-log') { base.set('limit', '100'); base.set('page', '1'); path = '/monitor/site/access-log'; }
  else if (values.endpoint === 'attack-log') path = '/monitor/site/attack-log';
  else if (values.endpoint === 'attack-stats') path = '/monitor/site/attack-log/stats';
  else if (values.endpoint === 'top') {
    base.set('type', values.metric); base.set('recent_time', rankingMinutes <= 10 ? '10m' : rankingMinutes <= 30 ? '30m' : '60m');
    base.delete('start'); base.delete('end'); path = '/monitor/site/top';
  }
  else if (values.endpoint === 'blackip') { base.delete('start'); base.delete('end'); path = '/monitor/site/blackip'; }
  else if (values.endpoint === 'history-blackip') path = '/monitor/site/history-blackip';
  else {
    base.set('type', values.metric); base.set('cate', 'site'); base.set('res', values.siteId);
    base.set('start', values.start.slice(0, 10)); base.set('end', values.end.slice(0, 10)); path = '/monitor/usage';
  }
  $('#monitorCount').textContent = '查询中';
  try {
    const response = await api(`/api/cdnfly/v1${path}?${base}`);
    if (requestId !== state.monitorRequestId) return;
    renderMonitorData(response.data);
  } catch (error) {
    if (requestId !== state.monitorRequestId) return;
    $('#monitorCount').textContent = '查询失败';
    throw error;
  }
}

$('#monitorTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-monitor-document]'); if (!button) return;
  const kind = state.monitorEndpoint === 'attack-log' ? 'attack-log' : 'access-log';
  try {
    const response = await api(`/api/cdnfly/v1/monitor/site/${kind}/${encodeURIComponent(button.dataset.monitorDocument)}`);
    const source = { ...(state.monitorItems[Number(button.dataset.monitorIndex)] || {}), ...(response.data || {}) };
    const labels = { '@timestamp': '访问时间', timestamp: '访问时间戳', time: '访问时间', host: '域名', host2: '原始域名', domain: '域名', server_port: '服务端口', protocol: '协议',
      client_ip: '客户端 IP', addr: '客户端 IP', ip: '客户端 IP', tls_fp: 'TLS 指纹', tls_fingerprint: 'TLS 指纹',
      country: '国家 / 地区', country_name: '国家 / 地区', province: '省份', city: '城市', method: '请求方法', req_method: '请求方法',
      uri: '请求 URI', req_uri: '请求 URI', request_uri: '请求 URI', status: '状态码', status_code: '状态码', cache_status: '缓存状态', bytes: '响应流量',
      bytes_sent: '响应字节', body_bytes_sent: '响应流量', up_recv: '回源接收字节', up_resp_time: '回源响应时间', user_agent: 'User-Agent', http_user_agent: 'User-Agent', referer: 'Referer', http_referer: 'Referer',
      sip: '源地址', content_type: '内容类型', isp: '运营商', nid: '节点 ID', l1_cache_status: 'L1 缓存状态', l2_cache_status: 'L2 缓存状态', l2_ip: 'L2 IP',
      lat: '纬度', lng: '经度', req_header: '请求头', req_body: '请求正文', resp_header: '响应头' };
    const records = Object.entries(source).flatMap(([key, raw]) => {
      if (['id', '_id'].includes(key) || raw === '' || raw === null || raw === undefined) return [];
      let value = raw;
      if (typeof value === 'string' && /^[\[{]/.test(value.trim())) { try { value = JSON.parse(value); } catch {} }
      return [{ title: labels[key] || key, detail: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value) }];
    });
    showRecords(`${kind === 'attack-log' ? '拦截日志' : '访问日志'}详情`, records);
  } catch (error) { handleError(error); }
});

$('#detailSiteMonitor')?.addEventListener('click', () => {
  const target = $('.tenant-nav [data-view="data"][data-data-tab="monitor"]'); navigateFromButton(target);
  requestAnimationFrame(() => { const select = $('#monitorForm')?.elements.siteId; if (select) select.value = String(state.currentSite.id); });
});

$('#monitorForm').addEventListener('submit', event => { event.preventDefault(); queryMonitor(event.currentTarget).catch(handleError); });

$('#monitorForm').elements.endpoint.addEventListener('change', event => {
  setMonitorContext(state.monitorContext, event.target.value);
});

$('#monitorRail').addEventListener('click', event => {
  const button = event.target.closest('[data-monitor-mode]'); if (!button) return;
  state.monitorMode = button.dataset.monitorMode; setMonitorContext(button.dataset.monitorContextItem, button.dataset.endpoint);
});

function setMonitorRange(amount = null, unit = 'hours') {
  const form = $('#monitorForm'); const end = new Date(); const start = new Date(end);
  if (amount === null) start.setHours(0, 0, 0, 0);
  else start.setTime(end.getTime() - Number(amount) * (unit === 'minutes' ? 60_000 : 60 * 60_000));
  const local = date => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  form.elements.start.value = local(start); form.elements.end.value = local(end);
  $$('[data-monitor-hours], [data-monitor-minutes], [data-monitor-today]').forEach(button => button.classList.toggle('active', amount === null
    ? button.hasAttribute('data-monitor-today')
    : unit === 'minutes' ? Number(button.dataset.monitorMinutes) === Number(amount) : Number(button.dataset.monitorHours) === Number(amount)));
}

$$('[data-monitor-hours]').forEach(button => button.addEventListener('click', () => setMonitorRange(button.dataset.monitorHours, 'hours')));

$$('[data-monitor-minutes]').forEach(button => button.addEventListener('click', () => setMonitorRange(button.dataset.monitorMinutes, 'minutes')));

$('[data-monitor-today]').addEventListener('click', () => setMonitorRange(null));

syncMonitorFields();
