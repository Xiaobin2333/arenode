import { state } from '../state/index.js';
import { actionMenu } from '../components/action-menu.js';
import { confirmAction, showRecords } from '../components/dialog.js';
import { fillResourceOptions } from '../components/form-controls.js';
import { toast } from '../components/toast.js';
import { $, $$ } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { navigateFromButton, showView } from '../core/router.js';
import { monitorFormCanQuery, queryMonitor, resetMonitorResults, setDefaultMonitorDates } from '../features/monitor/index.js';
import { loadUserConfigs } from '../features/user-configs/index.js';
import { api, handleError } from '../services/api-client.js';
import { auditActionLabel, auditDetailRecords, auditEntityLabel } from './admin-view.js';
import { fillSubscriptionSelect, refreshTenantBillingState } from './billing-view.js';
import { extractItems, openResourceDialog, populateSiteSelects, resourceIsEnabled, resourceStatus } from './security-view.js';

function replaceMetricLabel(selector, label) {
  const element = $(selector); if (element?.firstChild) element.firstChild.textContent = label;
}

export function syncDataPageContext(button = null) {
  const endpoint = button?.dataset.monitorEndpoint || $('#monitorForm')?.elements.endpoint.value || 'realtime';
  let config;
  if (state.dataTab === 'streams') config = state.streamKind === 'stream-groups'
    ? ['转发分组', '管理四层转发分组和资源归属', 'FORWARDING GROUPS', '转发分组', '按业务对四层转发进行分类和筛选。', '四层转发', '可用网站', '分组资源', '端口用量']
    : ['转发列表', '管理 TCP/UDP 监听、源站和运行状态', 'LAYER 4 FORWARDING', '四层转发管理', '配置监听端口、源站、负载方式与运行状态。', '四层转发', '可用网站', '处理任务', '端口用量'];
  else if (state.dataTab === 'jobs') config = ['刷新预热', '提交并查看缓存刷新、预热和日志下载任务', 'CACHE OPERATIONS', '缓存刷新与预热', '提交 URL 或目录刷新、缓存预热与日志下载任务。', '任务总数', '可用网站', '处理中', '任务类型'];
  else if (state.dataTab === 'logs') config = [state.logKind === 'login' ? '登录日志' : '操作日志', state.logKind === 'login' ? '查看账户登录结果、时间与来源地址' : '查看账户操作与资源变更记录', 'ACCOUNT LOGS', state.logKind === 'login' ? '登录日志' : '操作日志', '按时间查询账户登录和资源变更记录。', '日志记录', '操作账户', '资源类型', '查询范围'];
  else if (state.dataTab === 'configs') config = ['默认设置', '管理网站、四层转发和证书的新建资源默认值', 'DEFAULT SETTINGS', '资源默认设置', '保存可复用的默认值，并按全部资源或指定分组应用。', '设置数量', '启用设置', '设置类型', '生效范围'];
  else {
    const monitorConfigs = {
      basic: ['基础数据', '查看带宽、流量、请求和 QPS 实时趋势', 'SITE MONITOR', '网站基础数据', '查询网站带宽、流量、请求与 QPS 变化。'],
      quality: ['质量监控', '查看状态码与缓存命中情况', 'QUALITY MONITOR', '网站质量监控', '查询网站 4xx、5xx、请求缓存与流量缓存状态。'],
      origin: ['回源监控', '查看回源带宽、流量和响应时间', 'ORIGIN MONITOR', '网站回源监控', '查询回源带宽、流量与响应耗时变化。'],
      'stream-realtime': ['转发监控', '查看四层转发的带宽、流量和连接趋势', 'STREAM MONITOR', '转发实时观察台', '按监听端口查询 TCP/UDP 转发的实时指标。'],
      'stream-top': ['转发排行', '查看四层转发端口和来源排行', 'STREAM TOP', '转发资源排行台', '按监听端口聚合四层转发资源使用情况。'],
      'attack-log': ['拦截日志', '查询网站的安全拦截与处置记录', 'SECURITY EVENTS', '安全拦截日志', '查询被安全策略命中的请求与来源信息。'],
      'access-log': ['访问日志', '查询网站访问请求记录', 'ACCESS LOGS', '访问日志', '查询网站访问请求、来源与响应状态。'],
      usage: ['用量明细', '按网站和时间查询资源用量', 'USAGE DETAILS', '资源用量明细', '查看流量、带宽、请求与端口用量。'],
      'operation-log': ['操作日志', '查看账户的资源配置与操作记录', 'ACCOUNT LOGS', '操作日志', '按时间查看账户资源变更与操作详情。'],
      'login-log': ['登录日志', '查看账户登录结果、时间与来源地址', 'LOGIN LOGS', '登录日志', '按时间查看账户登录结果与来源信息。'],
    };
    const item = monitorConfigs[endpoint === 'realtime' ? state.monitorMode : endpoint] || monitorConfigs.basic;
    config = [...item, '峰值数据', '结果记录', '可用网站', '查询范围'];
  }
  $('#dataPageTitle').textContent = config[0]; $('#dataPageSubtitle').textContent = config[1];
  $('#dataHeroKicker').textContent = config[2]; $('#dataHeroTitle').textContent = config[3]; $('#dataHeroDescription').textContent = config[4];
  replaceMetricLabel('#dataMetricLabelOne', config[5]); replaceMetricLabel('#dataMetricLabelTwo', config[6]); replaceMetricLabel('#dataMetricLabelThree', config[7]); replaceMetricLabel('#dataMetricLabelFour', config[8]);
}

function streamCname(resource = {}) {
  const complete = value => {
    const text = String(value || '').trim().replace(/\.$/, '');
    return text.includes('.') && !/^\d+(?:\.\d+)*$/.test(text) ? text : '';
  };
  for (const key of ['cname_full', 'cnameFull', 'cname_fqdn', 'cnameFqdn', 'cname_target', 'cnameTarget']) {
    const value = complete(resource[key]); if (value) return value;
  }
  if (typeof resource.cname === 'string' && complete(resource.cname)) return complete(resource.cname);
  const host = String(resource.cname_hostname ?? resource.cnameHostname ?? resource.cname?.hostname ?? resource.cname?.host ?? '').trim().replace(/\.$/, '');
  const domain = complete(resource.cname_domain ?? resource.cnameDomain ?? resource.cname?.domain ?? resource.cname?.suffix);
  return host && domain ? `${host}.${domain}` : '';
}

function streamName(resource = {}) {
  return resource.name || resource.des || resource.description || `转发 #${resource.id}`;
}

export function streamListeners(resource = {}) {
  return (resource.listen || []).map(item => `${item.port}/${String(item.protocol || 'tcp').toUpperCase()}`).join(', ');
}

export function streamBackends(resource = {}) {
  return (resource.backend || []).map(item => {
    const addr = String(item.addr || '').trim(); const port = item.port ?? resource.backend_port ?? resource.backendPort;
    if (!addr) return ''; return port ? `${addr}:${port}` : addr;
  }).filter(Boolean).join(', ');
}

export function streamSyncLabel(resource = {}) {
  if (resource.syncUnavailable || resource.sync_unavailable) return '服务状态未知';
  if (resource.syncWarning || resource.sync_warning) return '最近同步状态';
  const stateValue = String(resource.sync_state ?? resource.syncState ?? resource.stream_state ?? resource.state ?? '').toLowerCase();
  if (['200', 'done', 'synced', 'success', 'active', 'running', 'ok', 'online'].includes(stateValue)) return '已同步';
  if (['failed', 'error', 'offline'].includes(stateValue)) return '同步异常';
  if (['syncing', 'pending', 'provisioning'].includes(stateValue)) return '同步中';
  return stateValue || '等待状态更新';
}

export function streamSyncBadge(resource = {}) {
  const label = streamSyncLabel(resource);
  const className = label === '已同步' ? 'active' : ['同步异常', '服务状态未知'].includes(label) ? 'off' : 'pending';
  return `<span class="badge ${className}">${label}</span>`;
}

function streamRuntimeBadge(resource = {}) {
  if (!resourceIsEnabled(resource)) return '<span class="badge off">已停用</span>';
  const sync = streamSyncLabel(resource);
  if (['同步异常', '服务状态未知'].includes(sync)) return `<span class="badge off danger-text">${sync}</span>`;
  if (sync !== '已同步') return '<span class="badge pending">配置中</span>';
  return '<span class="badge active">运行中</span>';
}

export function syncStreamPaneContext() {
  const groupMode = state.streamKind === 'stream-groups';
  $('#streamPaneTitle').textContent = groupMode ? '分组管理' : '转发列表';
  $('#streamPaneDescription').textContent = groupMode ? '管理四层转发分组' : '管理四层转发规则';
  $('#newStreamResource').textContent = groupMode ? '＋ 新建分组' : '＋ 新建转发';
  $('#streamSearch').placeholder = groupMode ? '搜索分组名称或备注' : '搜索名称、监听或源站';
  $('#streamNameHeading').textContent = groupMode ? '分组名称' : '名称 / 监听';
  $('#streamOriginHeading').textContent = groupMode ? '备注' : '源站';
  $('#streamPlanHeading').textContent = groupMode ? '已归类转发' : '所属套餐';
  $('#selectAllStreams').setAttribute('aria-label', groupMode ? '全选转发分组' : '全选四层转发');
  $('#streamsEmptyTitle').textContent = groupMode ? '暂无转发分组' : '暂无四层转发';
  $('#streamsEmptyDescription').textContent = groupMode ? '新建分组后将在这里显示' : '新建转发后将在这里显示';
}

function streamBelongsToGroup(stream, groupId) {
  const raw = stream.groups ?? stream.group_id ?? stream.groupId;
  if (Array.isArray(raw)) return raw.some(value => Number(value?.id ?? value) === Number(groupId));
  return String(raw ?? '').split(',').some(value => Number(value.trim()) === Number(groupId));
}

function streamRow(resource) {
  const tr = document.createElement('tr');
  const groupMode = state.streamKind === 'stream-groups';
  const name = groupMode ? (resource.name || `分组 #${resource.id}`) : streamName(resource);
  const manage = groupMode ? `<button class="manage-button" data-edit-stream="${resource.id}">管理</button>` : `<button class="manage-button" data-manage-stream="${resource.id}">管理</button>`;
  const edit = groupMode ? '' : `<button type="button" data-edit-stream="${resource.id}">快速配置</button>`;
  const toggle = groupMode ? '' : `<button type="button" data-toggle-stream="${resource.id}">${resourceIsEnabled(resource) ? '停用转发' : '启用转发'}</button>`;
  const deleteDisabled = !groupMode && resourceIsEnabled(resource) ? ' disabled title="请先停用四层转发"' : '';
  const moreActions = `${edit}${toggle}<button type="button" class="danger" data-delete-stream="${resource.id}"${deleteDisabled}>${groupMode ? '删除分组' : '删除转发'}</button>`;
  const status = groupMode ? resourceStatus(resource) : `${streamRuntimeBadge(resource)}<small class="sync-state"></small>`;
  tr.innerHTML = `<td class="select-cell"><input type="checkbox" data-select-stream="${resource.id}" aria-label="选择四层资源"></td><td><span class="id-chip">#${resource.id}</span></td><td><strong></strong><small></small></td><td></td><td></td><td>${status}</td><td class="right"><span class="row-actions">${manage}${actionMenu(moreActions)}</span></td>`;
  $('[data-select-stream]', tr).checked = state.selectedStreams.has(resource.id);
  $('td strong', tr).textContent = name;
  if (groupMode) {
    $('td:nth-child(3) small', tr).textContent = '转发分组';
    tr.children[3].textContent = resource.des || resource.description || '-';
    tr.children[4].textContent = `${state.streams.filter(stream => streamBelongsToGroup(stream, resource.id)).length} 个转发`;
  } else {
    const listens = streamListeners(resource); const cname = streamCname(resource); const origins = streamBackends(resource);
    $('td:nth-child(3) small', tr).textContent = cname ? `${listens || '监听信息待同步'} · CNAME ${cname}` : (listens || '监听信息待同步');
    tr.children[3].textContent = origins || '-'; tr.children[4].textContent = resource.plan_name || '未绑定';
  }
  $('.sync-state', tr)?.replaceChildren(document.createTextNode(streamSyncLabel(resource)));
  return tr;
}

function renderDataStreams() {
  const query = ($('#streamSearch')?.value || '').trim().toLowerCase();
  const filtered = state.streamItems.filter(resource => JSON.stringify([resource.id, resource.name, resource.des, resource.listen, resource.backend]).toLowerCase().includes(query));
  const availableIds = new Set(state.streamItems.map(item => item.id));
  for (const id of state.selectedStreams) if (!availableIds.has(id)) state.selectedStreams.delete(id);
  $('#streamTable').replaceChildren(...filtered.map(streamRow));
  $('#streamsEmpty').classList.toggle('hidden', filtered.length !== 0);
  updateStreamSelectionControls(filtered);
}

function updateStreamSelectionControls(visible = state.streamItems) {
  const ids = visible.map(item => item.id); const selected = state.selectedStreams.size; const all = $('#selectAllStreams');
  all.checked = ids.length > 0 && ids.every(id => state.selectedStreams.has(id)); all.indeterminate = ids.some(id => state.selectedStreams.has(id)) && !all.checked;
  $('#streamBulkEnable').disabled = selected === 0; $('#streamBulkDisable').disabled = selected === 0; $('#streamBulkDelete').disabled = selected === 0;
  const canToggle = state.streamKind === 'streams'; $('#streamBulkEnable').classList.toggle('hidden', !canToggle); $('#streamBulkDisable').classList.toggle('hidden', !canToggle);
  const label = $('#streamSelectionCount'); label.textContent = `已选择 ${selected} 项`; label.classList.toggle('hidden', selected === 0);
}

export async function loadDataStreams() {
  syncStreamPaneContext();
  const groupMode = state.streamKind === 'stream-groups';
  const [response, streamResponse] = await Promise.all([
    api(`/api/cdnfly/v1/${state.streamKind}`),
    groupMode ? api('/api/cdnfly/v1/streams').catch(() => ({ data: [] })) : Promise.resolve(null),
  ]);
  const items = extractItems(response.data);
  if (groupMode) state.streams = extractItems(streamResponse?.data);
  else { state.streams = items; state.streamCount = items.length; $('#dataSummaryStreams').textContent = items.length; }
  state.streamItems = items; renderDataStreams(); syncDataPageContext();
}

function renderStreamDetail(resource) {
  state.currentStream = resource; const form = $('#streamDetailForm'); const listen = resource.listen?.[0] || {}; const backend = resource.backend?.[0] || {};
  $('#detailStreamId').textContent = `ID: ${resource.id}`; $('#detailStreamName').textContent = streamName(resource);
  $('#detailStreamState').outerHTML = streamRuntimeBadge(resource).replace('<span', '<b id="detailStreamState"').replace('</span>', '</b>');
  fillSubscriptionSelect(form.elements.subscriptionId, resource.subscription_id);
  fillResourceOptions(form.elements.groupId, state.streamGroups, resource.groups, '不分组');
  form.elements.description.value = resource.name || resource.des || ''; form.elements.cname.value = streamCname(resource) || '等待 CDN 服务分配';
  form.elements.syncState.value = streamSyncLabel(resource); form.elements.listenPort.value = listen.port || '';
  form.elements.protocol.value = String(listen.protocol || 'tcp').toLowerCase(); form.elements.backendAddr.value = backend.addr || '';
  form.elements.backendPort.value = backend.port || resource.backend_port || ''; form.elements.balanceWay.value = resource.balance_way || 'rr';
  form.elements.enabled.checked = ![0, false, 'disabled', 'off'].includes(resource.enable ?? resource.enabled);
}

async function openStreamDetail(resource) {
  const [response, groups] = await Promise.all([
    api(`/api/cdnfly/v1/streams/${resource.id}`), api('/api/cdnfly/v1/stream-groups'),
  ]);
  state.streamGroups = extractItems(groups.data); renderStreamDetail(response.data);
  showView('stream-detail', $('.tenant-nav [data-stream-kind="streams"]')); $('#pageTitle').textContent = '转发管理';
  $('#breadcrumb').textContent = `四层转发 / ${streamName(state.currentStream)}`;
}

async function refreshStreamDetail() {
  const response = await api(`/api/cdnfly/v1/streams/${state.currentStream.id}`); renderStreamDetail(response.data);
}

async function loadJobs() {
  const response = await api('/api/cdnfly/v1/jobs?limit=100'); const items = extractItems(response.data);
  state.jobItems = items;
  state.jobCount = items.length; $('#dataSummaryJobs').textContent = items.length;
  $('#jobTable').replaceChildren(...items.map(job => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td class="right"></td>';
    const typeLabels = { clean_url: '刷新 URL', clean_dir: '刷新目录', pre_cache_url: '预热 URL', unlock_ip: '解除封禁 IP', clear_white_ip: '清除白名单 IP', down_http_access_log: '下载访问日志' };
    $('strong', tr).textContent = typeLabels[job.type] || job.type || '任务';
    const resultText = job.error || job.message || job.result || job.data?.url || job.data?.host || '';
    $('small', tr).textContent = typeof resultText === 'object' ? JSON.stringify(resultText) : String(resultText || '');
    const rawState = String(job.state || job.status || 'pending').toLowerCase();
    const success = ['done', 'success', 'finished', 'completed'].includes(rawState); const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(rawState);
    const running = ['running', 'processing', 'working'].includes(rawState);
    tr.children[1].innerHTML = `<span class="badge ${success ? 'active' : failed ? 'off danger-text' : 'pending'}">${success ? '已完成' : failed ? '失败' : running ? '执行中' : '等待执行'}</span>`;
    tr.children[2].textContent = formatDate(job.created_at || job.create_at || job.createdAt || job.time); tr.children[3].textContent = `#${job.id}`;
    const detailButton = document.createElement('button'); detailButton.type = 'button'; detailButton.textContent = '结果'; detailButton.dataset.jobDetail = job.id; tr.lastElementChild.append(detailButton);
    if (job.type === 'down_http_access_log' && success) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '下载'; button.dataset.downloadAccessLog = job.id; tr.lastElementChild.append(button);
    }
    return tr;
  }));
  $('#jobsEmpty').classList.toggle('hidden', items.length !== 0);
}

$('#jobTable').addEventListener('click', async event => {
  const detailButton = event.target.closest('[data-job-detail]');
  if (detailButton) {
    const job = state.jobItems.find(item => String(item.id) === detailButton.dataset.jobDetail);
    if (job) showRecords(`任务结果 #${job.id}`, Object.entries(job).filter(([, value]) => value !== '' && value !== null && value !== undefined).map(([key, value]) => ({ title: key, detail: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value) })));
    return;
  }
  const button = event.target.closest('[data-download-access-log]'); if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/cdnfly/v1/monitor/site/download-access-log/${encodeURIComponent(button.dataset.downloadAccessLog)}`);
    if (!response.ok) throw new Error((await response.json()).error || '日志下载失败');
    const blobUrl = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a');
    anchor.href = blobUrl; anchor.download = `access-log-${button.dataset.downloadAccessLog}.log`; anchor.click(); URL.revokeObjectURL(blobUrl);
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

export async function loadLocalLogs() {
  const response = await api(`/api/cdnfly/v1/log/${state.logKind}?limit=100`); const items = extractItems(response.data);
  state.localLogs = items;
  $('#localLogTable').replaceChildren(...items.map(log => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td><strong></strong><small></small></td><td></td><td></td><td class="right"><button type="button" data-local-log-detail>详情</button></td>';
    tr.children[0].textContent = formatDate(log.created_at); $('strong', tr).textContent = auditActionLabel({ action: log.action, resourceType: log.resource_type }); $('small', tr).textContent = log.action;
    tr.children[2].textContent = `${auditEntityLabel(log)}${log.resource_id ? ` #${log.resource_id}` : ''}`; tr.children[3].textContent = log.ip || '-'; $('[data-local-log-detail]', tr).dataset.localLogDetail = log.id; return tr;
  }));
  $('#localLogTitle').textContent = state.logKind === 'login' ? '登录日志' : '操作日志';
  $('#localLogCount').textContent = `${items.length} 项`; $('#localLogsEmpty').classList.toggle('hidden', items.length !== 0);
}

$('#localLogTable').addEventListener('click', event => {
  const button = event.target.closest('[data-local-log-detail]'); if (!button) return;
  const log = state.localLogs.find(item => Number(item.id) === Number(button.dataset.localLogDetail));
  if (log) showRecords(`操作详情 #${log.id}`, auditDetailRecords({ ...log, resourceType: log.resource_type, resourceId: log.resource_id, createdAt: log.created_at, username: state.me?.user?.username }));
});

export async function loadDataPane() {
  populateSiteSelects(); setDefaultMonitorDates(); syncDataPageContext();
  if (state.dataTab === 'streams') return loadDataStreams();
  if (state.dataTab === 'jobs') { await loadJobs(); $('#dataSummaryStreams').textContent = state.jobCount ?? 0; $('#dataSummarySites').textContent = state.sites.length; $('#dataSummaryJobs').textContent = '-'; $('#dataSummaryPorts').textContent = '6 类'; return; }
  if (state.dataTab === 'logs') { await loadLocalLogs(); $('#dataSummaryStreams').textContent = $('#localLogTable').children.length; $('#dataSummarySites').textContent = 1; $('#dataSummaryJobs').textContent = '多类型'; $('#dataSummaryPorts').textContent = '本账户'; }
  if (state.dataTab === 'configs') return loadUserConfigs();
  if (state.dataTab === 'monitor') {
    resetMonitorResults();
    if (monitorFormCanQuery()) await queryMonitor($('#monitorForm'));
  }
}

$('#dataTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-data-tab]'); if (!button) return;
  state.dataTab = button.dataset.dataTab;
  $$('#dataTabs button').forEach(item => item.classList.toggle('active', item === button));
  $$('.data-pane', $('#data')).forEach(pane => pane.classList.toggle('active', pane.id === `data${state.dataTab[0].toUpperCase()}${state.dataTab.slice(1)}`));
  syncDataPageContext(button);
  loadDataPane().catch(handleError);
});

$$('#dataStreams [data-stream-kind]').forEach(button => button.addEventListener('click', () => {
  state.streamKind = button.dataset.streamKind;
  $$('#dataStreams [data-stream-kind]').forEach(item => item.classList.toggle('active', item === button));
  loadDataStreams().catch(handleError);
}));

$('#newStreamResource').addEventListener('click', () => {
  openResourceDialog(null, state.streamKind).catch(handleError);
});

$('#streamSearch').addEventListener('input', renderDataStreams);

$('#selectAllStreams').addEventListener('change', event => {
  $$('[data-select-stream]', $('#streamTable')).forEach(input => { input.checked = event.currentTarget.checked; const id = Number(input.dataset.selectStream); input.checked ? state.selectedStreams.add(id) : state.selectedStreams.delete(id); });
  updateStreamSelectionControls();
});

async function bulkUpdateStreams(enable) {
  const resources = state.streamItems.filter(item => state.selectedStreams.has(item.id));
  if (!resources.length) return;
  const groupMode = state.streamKind === 'stream-groups'; const label = groupMode ? '转发分组' : '四层转发';
  if (!await confirmAction({ title: `批量${enable ? '启用' : '停用'}${label}`, message: `确认${enable ? '启用' : '停用'}选中的 ${resources.length} 项${label}？`, confirmLabel: enable ? '批量启用' : '批量停用', danger: !enable })) return;
  for (const resource of resources) await api(`/api/cdnfly/v1/${state.streamKind}/${resource.id}`, { method: 'PUT', body: JSON.stringify({ enable: enable ? 1 : 0 }) });
  state.selectedStreams.clear(); await loadDataStreams(); if (!groupMode) await refreshTenantBillingState(); toast(`已${enable ? '启用' : '停用'} ${resources.length} 项${label}`);
}

$('#streamBulkEnable').addEventListener('click', () => bulkUpdateStreams(true).catch(handleError));

$('#streamBulkDisable').addEventListener('click', () => bulkUpdateStreams(false).catch(handleError));

$('#streamBulkDelete').addEventListener('click', async () => {
  const resources = state.streamItems.filter(item => state.selectedStreams.has(item.id));
  if (!resources.length) return;
  if (state.streamKind === 'streams' && resources.some(resourceIsEnabled)) return toast('请先停用所选四层转发，再执行删除操作', true);
  const groupMode = state.streamKind === 'stream-groups';
  if (!await confirmAction({ title: groupMode ? '批量删除转发分组' : '批量删除四层转发', message: `确认删除选中的 ${resources.length} 项${groupMode ? '分组' : '四层转发'}？删除后无法恢复。`, confirmLabel: '批量删除', danger: true })) return;
  try { for (const resource of resources) await api(`/api/cdnfly/v1/${state.streamKind}/${resource.id}`, { method: 'DELETE' }); state.selectedStreams.clear(); await loadDataStreams(); if (state.streamKind === 'streams') await refreshTenantBillingState(); toast(`已删除 ${resources.length} 项资源`); } catch (error) { handleError(error); }
});

$('#streamTable').addEventListener('click', async event => {
  const manage = event.target.closest('[data-manage-stream]'); const edit = event.target.closest('[data-edit-stream]'); const toggle = event.target.closest('[data-toggle-stream]'); const remove = event.target.closest('[data-delete-stream]');
  try {
    if (manage) return openStreamDetail(state.streams.find(item => item.id === Number(manage.dataset.manageStream)));
    if (edit) return await openResourceDialog((await api(`/api/cdnfly/v1/${state.streamKind}/${edit.dataset.editStream}`)).data, state.streamKind);
    if (toggle) {
      const resource = state.streamItems.find(item => item.id === Number(toggle.dataset.toggleStream));
      const enable = !resourceIsEnabled(resource);
      if (!await confirmAction({ title: enable ? '启用四层转发' : '停用四层转发', message: `确认${enable ? '启用' : '停用'} ${streamName(resource)}？`, confirmLabel: enable ? '启用' : '停用', danger: !enable })) return;
      await api(`/api/cdnfly/v1/streams/${resource.id}`, { method: 'PUT', body: JSON.stringify({ enable: enable ? 1 : 0 }) });
      await Promise.all([loadDataStreams(), refreshTenantBillingState()]); return toast(`四层转发已${enable ? '启用' : '停用'}`);
    }
    if (remove) {
      const resource = state.streamItems.find(item => item.id === Number(remove.dataset.deleteStream));
      if (state.streamKind === 'streams' && resourceIsEnabled(resource)) return toast('请先停用四层转发，再执行删除操作', true);
      const groupMode = state.streamKind === 'stream-groups';
      if (!await confirmAction({ title: groupMode ? '删除转发分组' : '删除四层转发', message: `确认删除 ${groupMode ? (resource?.name || '此转发分组') : streamName(resource)}？删除后无法恢复。`, confirmLabel: groupMode ? '删除分组' : '删除转发', danger: true })) return;
      remove.disabled = true;
      await api(`/api/cdnfly/v1/${state.streamKind}/${remove.dataset.deleteStream}`, { method: 'DELETE' }); await loadDataStreams();
      if (state.streamKind === 'streams') await refreshTenantBillingState(); toast(groupMode ? '转发分组已删除' : '四层转发已删除');
    }
  } catch (error) {
    if (remove) remove.disabled = false;
    handleError(error);
  }
});

$('#streamTable').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-select-stream]'); if (!checkbox) return;
  const id = Number(checkbox.dataset.selectStream); checkbox.checked ? state.selectedStreams.add(id) : state.selectedStreams.delete(id); updateStreamSelectionControls();
});

$('#backToStreams').addEventListener('click', () => navigateFromButton($('.tenant-nav [data-stream-kind="streams"]')));

$('#cancelStreamDetail').addEventListener('click', () => renderStreamDetail(state.currentStream));

$('#syncStreamDetail').addEventListener('click', async () => { try { await refreshStreamDetail(); toast('转发配置已同步'); } catch (error) { handleError(error); } });

$('#streamDetailForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  const body = {
    subscriptionId: Number(form.elements.subscriptionId.value), des: form.elements.description.value.trim(),
    groups: form.elements.groupId.value,
    listen: [{ port: Number(form.elements.listenPort.value), protocol: form.elements.protocol.value }],
    backend_port: Number(form.elements.backendPort.value), backend: [{ addr: form.elements.backendAddr.value.trim(), weight: 1, state: 'up' }],
    balance_way: form.elements.balanceWay.value, enable: form.elements.enabled.checked ? 1 : 0,
  };
  try {
    await api(`/api/cdnfly/v1/streams/${state.currentStream.id}`, { method: 'PUT', body: JSON.stringify(body) });
    await Promise.all([refreshStreamDetail(), refreshTenantBillingState()]); toast('转发配置已保存');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#newJobButton').addEventListener('click', () => {
  populateSiteSelects(); const form = $('#jobForm'); form.reset();
  const site = state.sites[0]; if (site) form.elements.url.value = `https://${site.domain.split(',')[0].trim()}/`;
  const end = new Date(); const start = new Date(end.getTime() - 60 * 60_000);
  const local = date => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  form.elements.start.value = local(start); form.elements.end.value = local(end); updateJobFields(); $('#jobDialog').showModal();
});

function updateJobFields() {
  const form = $('#jobForm'); const type = form.elements.type.value;
  const accessLog = type === 'down_http_access_log';
  const ipTask = ['unlock_ip', 'clear_white_ip'].includes(type);
  $('#jobUrlField').classList.toggle('hidden', ipTask || accessLog);
  $('#jobIpField').classList.toggle('hidden', !ipTask);
  if (!ipTask && !accessLog && !form.elements.url.value) {
    const site = state.sites.find(item => item.id === Number(form.elements.siteId.value));
    if (site) form.elements.url.value = `https://${site.domain.split(',')[0].trim()}/`;
  }
  form.elements.url.required = !ipTask && !accessLog;
  form.elements.ip.required = ipTask;
  form.elements.start.required = accessLog; form.elements.end.required = accessLog;
  form.elements.start.closest('label').classList.toggle('hidden', !accessLog);
  form.elements.end.closest('label').classList.toggle('hidden', !accessLog);
}

$('#jobForm').elements.type.addEventListener('change', updateJobFields);

$('#jobForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const type = form.elements.type.value;
  const site = state.sites.find(item => item.id === Number(form.elements.siteId.value));
  if (!site) return toast('请选择网站', true);
  let data;
  if (['unlock_ip', 'clear_white_ip'].includes(type)) data = { site_id: site.id, ip: form.elements.ip.value.trim() };
  else if (type === 'down_http_access_log') {
    if (!form.elements.start.value || !form.elements.end.value) return toast('下载访问日志必须选择开始和结束时间', true);
    const start = new Date(form.elements.start.value); const end = new Date(form.elements.end.value);
    if (!(start < end)) return toast('结束时间必须晚于开始时间', true);
    data = { host: site.domain, start: form.elements.start.value.replace('T', ' '), end: form.elements.end.value.replace('T', ' ') };
  } else {
    const target = form.elements.url.value.trim();
    let parsed;
    try { parsed = new URL(target); } catch { return toast('请输入完整的 http:// 或 https:// URL', true); }
    const siteDomains = site.domain.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    if (!['http:', 'https:'].includes(parsed.protocol) || !siteDomains.includes(parsed.hostname.toLowerCase())) return toast('URL 必须属于所选网站', true);
    data = { url: target };
  }
  try {
    await api('/api/cdnfly/v1/jobs', { method: 'POST', body: JSON.stringify({ type, data }) }); $('#jobDialog').close(); await loadJobs(); toast('任务已提交');
  } catch (error) { handleError(error); }
});

$('#refreshLocalLogs').addEventListener('click', () => loadLocalLogs().catch(handleError));
