import { state } from '../state/index.js';
import { actionMenu } from '../components/action-menu.js';
import { confirmAction, showRecords } from '../components/dialog.js';
import { fillSelect } from '../components/form-controls.js';
import { renderPager } from '../components/pager.js';
import { statusBadge } from '../components/status-badge.js';
import { emptyTableRow } from '../components/table.js';
import { toast } from '../components/toast.js';
import { configureTurnstile, loadTurnstileScript, resetTurnstile, turnstileToken, turnstileTokens, turnstileWidgets } from '../components/turnstile.js';
import { $, nextDate, queryPath } from '../core/dom.js';
import { formatDate, formatMoney, orderAmountLabel, toLocalInput } from '../core/format.js';
import { applyPublicSettings } from '../core/layout.js';
import { showLogin } from '../features/auth/index.js';
import { loadBillingAdmin, openSubscriptionDialog } from '../features/billing/admin-billing.js';
import { api, handleError } from '../services/api-client.js';
import { fillSubscriptionSelect } from './billing-view.js';
import { streamBackends, streamListeners, streamSyncBadge, streamSyncLabel } from './data-view.js';
import { resourceStatus } from './security-view.js';
import { badge } from './sites-view.js';

export async function loadUsers(page = state.pageInfo.customers?.page || 1) {
  const filters = { q: $('#customerSearch')?.value.trim() || '', status: $('#customerStatus')?.value || '' };
  const data = await api(queryPath('/api/admin/customers', filters, page)); state.users = data.customers;
  const rows = data.customers.map(user => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td><span class="badge ${user.status === 'active' ? 'active' : 'off'}">${user.status === 'active' ? '正常' : '已停用'}</span></td><td>${formatDate(user.createdAt)}</td><td class="right"><span class="row-actions"><button data-customer-detail="${user.id}">详情</button><button data-assign-user="${user.id}">分配套餐</button><button data-reset-user="${user.id}">重置密码</button><button data-status="${user.id}">${user.status === 'active' ? '停用' : '启用'}</button></span></td>`;
    $('td strong', tr).textContent = user.username; $('td small', tr).textContent = `客户 #${user.id}`;
    tr.children[1].textContent = user.billing?.plan?.name || '未分配'; tr.children[2].textContent = `${user.siteCount} / ${user.orderCount}`;
    return tr;
  });
  $('#userTable').replaceChildren(...rows);
  $('#adminCustomerTotal').textContent = state.adminOverview?.customers.total ?? data.pagination?.total ?? data.customers.length;
  $('#adminCustomerActive').textContent = state.adminOverview?.customers.active ?? data.customers.filter(user => user.status === 'active').length;
  $('#adminCustomerPlans').textContent = state.adminOverview?.subscriptions.active ?? data.customers.filter(user => user.billing?.subscription?.status === 'active').length;
  $('#adminCustomerSites').textContent = state.adminOverview?.sites ?? data.customers.reduce((sum, user) => sum + Number(user.siteCount || 0), 0);
  renderPager('#customersPager', data.pagination, 'customers');
  renderAdminOverview();
}

export function renderQuotaItem(label, used, limit, formatter) {
  const finite = limit !== null && limit !== undefined;
  const over = finite && Number(used) > Number(limit);
  const percent = finite ? Math.min(100, Number(limit) === 0 ? (Number(used) ? 100 : 0) : Number(used) / Number(limit) * 100) : 0;
  const item = document.createElement('div'); item.className = `quota-item${over ? ' over' : ''}`;
  item.innerHTML = `<div class="quota-item-head"><span></span><span></span></div><strong></strong><div class="quota-track"><i></i></div>`;
  $('.quota-item-head span:first-child', item).textContent = label;
  $('.quota-item-head span:last-child', item).textContent = finite ? `${Math.round(percent)}%` : '不限';
  $('strong', item).textContent = `${formatter(used)} / ${formatter(limit)}`;
  $('.quota-track i', item).style.width = finite ? `${percent}%` : '100%';
  return item;
}

export function renderAdminOverview() {
  if (!state.me || state.me.user.role !== 'admin') return;
  const billing = state.billingAdmin || {}; const users = state.users || []; const sites = state.adminSites || [];
  const subscriptions = billing.subscriptions || []; const orders = billing.orders || []; const usage = billing.usage || []; const plans = billing.plans || [];
  const totals = state.adminOverview;
  $('#adminOverviewUsers').textContent = totals?.customers.total ?? users.length; $('#adminOverviewSites').textContent = totals?.sites ?? sites.length;
  $('#adminOverviewSubscriptions').textContent = totals?.subscriptions.active ?? subscriptions.filter(item => item.status === 'active').length;
  $('#adminOverviewPending').textContent = totals?.orders.paid ?? orders.filter(item => item.status === 'paid').length;
  const overLimit = totals?.overLimitCustomers ?? usage.filter(item => item.billing?.overLimit).length;
  $('#adminEnforcementState').textContent = overLimit ? `${overLimit} 个客户超限` : '正常';
  $('#adminEnforcementState').classList.toggle('danger-text', overLimit > 0);
  $('#adminRecentUsers').replaceChildren(...users.slice(0, 6).map(user => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td>';
    $('strong', tr).textContent = user.username; $('small', tr).textContent = `#${user.id}`; tr.children[1].textContent = user.billing?.plan?.name || '未分配';
    tr.children[2].textContent = user.siteCount; tr.children[3].innerHTML = user.status === 'active' ? '<span class="badge active">正常</span>' : '<span class="badge off">已停用</span>'; return tr;
  }));
  $('#adminRecentOrders').replaceChildren(...orders.slice(0, 6).map(order => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong>#${order.id}</strong></td><td></td><td></td><td>${statusBadge(order.status)}</td>`;
    tr.children[1].textContent = order.username; tr.children[2].textContent = orderAmountLabel(order); return tr;
  }));
  $('#adminResourceSummary').replaceChildren(
    summaryBlock('正常客户', `${Math.max(0, (totals?.customers.active ?? usage.length) - overLimit)} / ${totals?.customers.total ?? usage.length}`),
    summaryBlock('超限客户', `${overLimit}`),
    summaryBlock('可售套餐', `${totals?.plans.enabled ?? plans.filter(item => item.enabled).length} / ${totals?.plans.total ?? plans.length}`),
  );
}

export function summaryBlock(label, value) {
  const block = document.createElement('div'); block.innerHTML = '<span></span><strong></strong>';
  $('span', block).textContent = label; $('strong', block).textContent = value; return block;
}

export async function loadAdminSites(page = state.pageInfo.adminSites?.page || 1) {
  const query = $('#adminSiteSearch').value.trim(); const response = await api(queryPath('/api/admin/sites', { q: query }, page)); state.adminSites = response.sites;
  $('#adminSiteCount').textContent = `${response.pagination?.total ?? state.adminSites.length} 个站点`;
  $('#adminSiteTable').replaceChildren(...state.adminSites.map(site => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td>${badge(site)}</td><td></td><td class="right"><span class="row-actions"><button data-admin-toggle="${site.id}">${site.enabled ? '停用' : '启用'}</button><button class="danger" data-admin-delete="${site.id}">删除</button></span></td>`;
    $('strong', tr).textContent = site.domain; $('small', tr).textContent = site.cname || `站点 #${site.id}`; tr.children[1].textContent = site.username; tr.children[2].textContent = site.planName || '未绑定'; tr.children[3].textContent = site.origin; tr.children[5].textContent = formatDate(site.createdAt); return tr;
  }));
  renderPager('#adminSitesPager', response.pagination, 'adminSites');
  renderAdminOverview();
}

export async function loadAdminStreams(page = state.pageInfo.adminStreams?.page || 1) {
  const query = $('#adminStreamSearch').value.trim(); const response = await api(queryPath('/api/admin/streams', { q: query }, page));
  state.adminStreams = response.streams;
  const total = response.pagination?.total ?? state.adminStreams.length;
  $('#adminStreamCount').textContent = `${total} 个转发`; $('#adminStreamTotal').textContent = total;
  $('#adminStreamEnabled').textContent = state.adminStreams.filter(item => item.enabled).length;
  $('#adminStreamPorts').textContent = state.adminStreams.reduce((sum, item) => sum + (item.listen?.length || item.ports?.length || 0), 0);
  $('#adminStreamCustomers').textContent = new Set(state.adminStreams.map(item => item.ownerId)).size;
  $('#adminStreamTable').replaceChildren(...state.adminStreams.map(stream => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong></strong><small class="cname-cell"></small></td><td><strong></strong><small></small></td><td></td><td></td><td>${streamSyncBadge(stream)}<small class="sync-state"></small></td><td></td><td class="right"><span class="row-actions"><button class="manage-button" data-admin-stream-edit="${stream.id}">${stream.syncUnavailable ? '查看' : '配置'}</button><button data-admin-stream-toggle="${stream.id}" ${stream.syncUnavailable ? 'disabled title="上游当前不可见该转发"' : ''}>${stream.syncUnavailable ? '不可启用' : stream.enabled ? '停用' : '启用'}</button><button class="danger" data-admin-stream-delete="${stream.id}">删除</button></span></td>`;
    $('td:first-child strong', tr).textContent = stream.name || stream.description || `转发 #${stream.id}`;
    $('td:first-child small', tr).textContent = stream.cname || `本地 #${stream.id} · 上游 #${stream.upstreamId}`;
    $('td:nth-child(2) strong', tr).textContent = stream.username; $('td:nth-child(2) small', tr).textContent = stream.planName || '未绑定套餐';
    tr.children[2].textContent = streamListeners(stream) || '-'; tr.children[3].textContent = streamBackends(stream) || '-';
    $('.sync-state', tr).textContent = stream.syncWarning || (stream.enabled ? '运行中' : '已停用'); tr.children[5].textContent = formatDate(stream.updatedAt);
    return tr;
  }));
  $('#adminStreamsEmpty').classList.toggle('hidden', state.adminStreams.length !== 0);
  renderPager('#adminStreamsPager', response.pagination, 'adminStreams');
}

async function loadAdminStreamCustomers() {
  const response = await api('/api/admin/customers?pageSize=100'); state.adminStreamCustomers = response.customers;
  return state.adminStreamCustomers;
}

function updateAdminStreamSubscriptions(selectedId = null) {
  const form = $('#adminStreamForm'); const customer = state.adminStreamCustomers.find(item => item.id === Number(form.elements.userId.value));
  fillSubscriptionSelect(form.elements.subscriptionId, selectedId, customer?.billing?.subscriptions || []);
  form.elements.subscriptionId.disabled = !form.elements.subscriptionId.options.length;
}

async function openAdminStreamDialog(stream = null) {
  if (!state.adminStreamCustomers.length) await loadAdminStreamCustomers();
  let detail = stream;
  if (stream?.id) detail = (await api(`/api/admin/streams/${stream.id}`)).stream;
  state.currentAdminStream = detail || null;
  const form = $('#adminStreamForm'); form.reset(); form.elements.id.value = detail?.id || '';
  const customers = detail ? state.adminStreamCustomers : state.adminStreamCustomers.filter(item => item.status === 'active');
  fillSelect(form.elements.userId, customers, item => `${item.username} · #${item.id}`);
  if (detail) form.elements.userId.value = String(detail.ownerId);
  form.elements.userId.disabled = Boolean(detail); updateAdminStreamSubscriptions(detail?.subscriptionId);
  const listen = detail?.listen?.[0] || {}; const backend = detail?.backend?.[0] || {};
  form.elements.name.value = detail?.name || detail?.description || '';
  form.elements.listenPort.value = listen.port || 8443; form.elements.protocol.value = String(listen.protocol || 'tcp').toLowerCase();
  form.elements.backendAddr.value = backend.addr || ''; form.elements.backendPort.value = backend.port || detail?.backendPort || 443;
  form.elements.balanceWay.value = detail?.balanceWay || 'rr'; form.elements.enabled.checked = detail ? Boolean(detail.enabled) : true;
  $('#adminStreamDialogTitle').textContent = detail ? `配置 ${detail.name || `转发 #${detail.id}`}` : '为客户新建转发';
  const readonly = $('#adminStreamReadonly'); readonly.classList.toggle('hidden', !detail);
  readonly.replaceChildren(...(detail ? [detailSection('上游同步信息', [
    ['完整 CNAME', detail.cname || '等待上游返回'], ['同步状态', streamSyncLabel(detail)],
    ['同步说明', detail.syncWarning || '上游配置读取正常'], ['本地 / 上游 ID', `#${detail.id} / #${detail.upstreamId}`], ['最近同步', formatDate(detail.updatedAt)],
  ])] : []));
  $('button[type="submit"]', form).disabled = Boolean(detail?.syncUnavailable);
  $('#adminStreamDialog').showModal();
}

export async function loadAdminOverview() {
  await Promise.all([loadUsers(), loadBillingAdmin(), loadAdminSites()]);
  renderAdminOverview();
}

function auditFilters() {
  return { q: $('#auditSearch')?.value.trim() || '', action: $('#auditAction')?.value.trim() || '', from: $('#auditFrom')?.value || '', to: nextDate($('#auditTo')?.value || '') };
}

const auditEntityLabels = {
  session: '登录会话', user: '客户账号', site: '网站', wallet: '客户余额', billing: '套餐与订单',
  redemption: '权益兑换', upstream: '上游账号', security: '安全设置', settings: '系统设置', 'cdnfly-resource': 'CDN 资源',
};

const auditVerbLabels = {
  create: '新建', update: '修改', delete: '删除', disable: '停用', enable: '启用', adjust: '调整',
  success: '成功', failed: '失败', test: '检测', refund: '退款', cancel: '取消', close: '注销', redeem: '兑换',
};

const auditActionLabels = {
  'login.success': '登录成功', 'login.mfa.success': '动态验证登录成功', 'login.mfa.required': '登录需要动态验证',
  'register.success': '注册成功', 'account.close': '注销账号', 'site.create': '新建网站', 'site.update': '修改网站',
  'site.delete': '删除网站', 'wallet.adjust': '调整客户余额', 'wallet.recharge-code': '充值码充值',
  'settings.update': '修改系统设置', 'settings.turnstile.test': '检测人机验证',
};

const auditActionEntityLabels = {
  site: '网站', sites: '网站', stream: '四层转发', streams: '四层转发', 'site-groups': '网站分组',
  'stream-groups': '转发分组', acls: '访问控制', certs: '证书', 'cc-rules': 'CC 规则', 'cc-filters': 'CC 过滤器',
  'cc-matchs': 'CC 匹配器', order: '订单', subscription: '客户套餐', upstream: '上游账号', user: '客户账号',
};

export function auditEntityLabel(log) {
  const entity = String(log.action || '').split('.').slice(0, -1).join('.').replace(/^admin\./, '');
  return auditActionEntityLabels[entity] || auditEntityLabels[log.resourceType || log.resource_type] || log.resourceType || log.resource_type || '资源';
}

export function auditActionLabel(log) {
  if (auditActionLabels[log.action]) return auditActionLabels[log.action];
  const parts = String(log.action || '').split('.'); const verb = parts.at(-1); const entity = parts.slice(0, -1).join('.').replace(/^admin\./, '');
  const entityLabel = auditActionEntityLabels[entity] || auditEntityLabel(log) || entity.replace(/-/g, ' ') || '资源';
  return `${auditVerbLabels[verb] || verb || '操作'}${entityLabel}`;
}

function parseAuditDetail(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return { detail: String(value) }; }
}

export function auditDetailRecords(log) {
  const detail = parseAuditDetail(log.detail);
  const labels = { method: '请求方法', path: '接口路径', changedFields: '修改字段', domain: '域名', username: '账号', siteLimit: '网站额度',
    status: '状态', detail: '详情', amountCents: '金额', description: '说明' };
  const records = [
    { title: '动作', detail: `${auditActionLabel(log)}（${log.action || '-'}）` },
    { title: '操作对象', detail: `${auditEntityLabel(log)}${log.resourceId ? ` #${log.resourceId}` : ''}` },
    { title: '操作者与来源', detail: `${log.username || state.me?.user?.username || '-'} · ${log.ip || '未知 IP'}` },
    { title: '操作时间', detail: formatDate(log.createdAt || log.created_at) },
  ];
  for (const [key, value] of Object.entries(detail)) {
    if (value === '' || value === null || value === undefined) continue;
    records.push({ title: labels[key] || key, detail: Array.isArray(value) ? value.join('、') : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value) });
  }
  if (!Object.keys(detail).length) records.push({ title: '操作详情', detail: '该历史记录创建时未保存请求详情' });
  return records;
}

export async function loadAudit(page = state.pageInfo.audit?.page || 1) {
  const result = await api(queryPath('/api/admin/audit', auditFilters(), page)); const { logs } = result;
  state.auditLogs = logs;
  $('#auditTable').replaceChildren(...logs.map(log => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatDate(log.createdAt)}</td><td></td><td><strong></strong><small></small></td><td></td><td></td><td class="right"><button type="button" data-audit-detail="${log.id}">详情</button></td>`;
    tr.children[1].textContent = log.username; $('strong', tr).textContent = auditActionLabel(log); $('small', tr).textContent = log.action;
    tr.children[3].textContent = `${auditEntityLabel(log)}${log.resourceId ? ` #${log.resourceId}` : ''}`; tr.children[4].textContent = log.ip || '-';
    return tr;
  }));
  renderPager('#auditPager', result.pagination, 'audit');
}

$('#auditTable').addEventListener('click', event => {
  const button = event.target.closest('[data-audit-detail]'); if (!button) return;
  const log = state.auditLogs.find(item => Number(item.id) === Number(button.dataset.auditDetail));
  if (log) showRecords(`审计详情 #${log.id}`, auditDetailRecords(log));
});

function renderUpstreams() {
  const rows = state.upstreams || []; const packages = rows.flatMap(item => item.packages || []);
  $('#upstreamTotal').textContent = rows.length;
  $('#upstreamHealthy').textContent = rows.filter(item => item.status === 'active' && item.lastHealthStatus === 'healthy').length;
  $('#upstreamPackageTotal').textContent = packages.filter(item => item.enabled).length;
  $('#upstreamUnavailable').textContent = rows.filter(item => item.status !== 'active' || item.lastHealthStatus === 'unhealthy').length;
  $('#upstreamEmpty').classList.toggle('hidden', rows.length > 0);
  $('#upstreamTable').replaceChildren(...rows.map(item => {
    const status = item.status === 'active' ? '<span class="badge active">启用</span>' : '<span class="badge off">停用</span>';
    const tr = document.createElement('tr');
    const moreActions = `<button type="button" data-edit-upstream="${item.id}">配置上游</button><button type="button" data-test-upstream="${item.id}">检测连接</button><button type="button" data-add-upstream-package="${item.id}">添加套餐</button>`;
    tr.innerHTML = `<td><strong></strong><small></small></td><td><strong></strong><small></small></td><td><strong></strong><small></small></td><td><strong></strong><small></small></td><td>${status}</td><td><strong></strong><small></small></td><td class="right"><span class="row-actions"><button data-view-upstream-customers="${item.id}">查看归属</button>${actionMenu(moreActions)}</span></td>`;
    $('td:first-child strong', tr).textContent = item.name; $('td:first-child small', tr).textContent = item.isDefault ? `#${item.id} · 默认` : `#${item.id}`;
    $('td:nth-child(2) strong', tr).textContent = item.baseUrl;
    $('td:nth-child(2) small', tr).textContent = item.cnameSuffix ? `CNAME 后缀：${item.cnameSuffix}` : '未配置 CNAME 后缀';
    $('td:nth-child(3) strong', tr).textContent = `${item.packages.filter(pkg => pkg.enabled).length} 个可用`;
    $('td:nth-child(3) small', tr).textContent = item.packages.length ? item.packages.map(pkg => pkg.name).join('、') : '尚未添加套餐';
    if (item.packages.length) { const actions = document.createElement('span'); actions.className = 'row-actions upstream-package-actions'; for (const pkg of item.packages) { const button = document.createElement('button'); button.type = 'button'; button.dataset.editUpstreamPackage = pkg.id; button.dataset.upstreamId = item.id; button.textContent = pkg.name; actions.append(button); } tr.children[2].append(actions); }
    const customers = item.customers || [];
    $('td:nth-child(4) strong', tr).textContent = `${item.customerCount ?? customers.length} 个客户 · ${item.siteCount ?? 0} 个站点`;
    $('td:nth-child(4) small', tr).textContent = `${item.resourceCount ?? 0} 个其他资源；点击“查看归属”查看客户明细`;
    $('td:nth-child(6) strong', tr).textContent = item.lastHealthStatus === 'healthy' ? '连接正常' : item.lastHealthStatus === 'unhealthy' ? '连接异常' : '尚未检测';
    $('td:nth-child(6) small', tr).textContent = item.lastCheckedAt ? formatDate(item.lastCheckedAt) : '-';
    return tr;
  }));
}

export async function loadUpstreams() {
  const result = await api('/api/admin/upstreams'); state.upstreams = result.upstreams; renderUpstreams();
}

function openUpstreamDialog(item = null) {
  const form = $('#upstreamForm'); form.reset(); form.elements.id.value = item?.id || ''; form.elements.name.value = item?.name || '';
  form.elements.baseUrl.value = item?.baseUrl || ''; form.elements.cnameSuffix.value = item?.cnameSuffix || ''; form.elements.requestsPerMinute.value = item?.requestsPerMinute || 300; form.elements.timeoutMs.value = item?.timeoutMs || 15000;
  form.elements.enabled.checked = item ? item.status === 'active' : true; form.elements.isDefault.checked = Boolean(item?.isDefault);
  form.elements.apiKey.required = !item; form.elements.apiSecret.required = !item; $('#upstreamDialogTitle').textContent = item ? `配置 ${item.name}` : '添加上游'; $('#upstreamDialog').showModal();
}

async function openUpstreamPackageDialog(upstream, item = null) {
  const form = $('#upstreamPackageForm'); form.reset(); form.elements.upstreamId.value = upstream.id; form.elements.id.value = item?.id || '';
  form.elements.packageId.disabled = true; form.elements.packageId.replaceChildren(new Option('正在读取账号已购套餐...', ''));
  form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.enabled.checked = item ? item.enabled : true;
  $('#upstreamPackageDialogTitle').textContent = `${item ? '配置' : '添加'} ${upstream.name} 套餐`; $('#upstreamPackageDialog').showModal();
  try {
    const result = await api(`/api/admin/upstreams/${upstream.id}/available-packages`); const packages = result.packages || [];
    if (item && !packages.some(entry => entry.packageId === item.packageId)) packages.unshift({ packageId: item.packageId, name: `${item.name}（当前映射）`, description: item.description || '' });
    form.elements.packageId.replaceChildren(new Option('请选择账号已购套餐', ''), ...packages.map(entry => new Option(`${entry.name} (#${entry.packageId})`, entry.packageId)));
    form.elements.packageId.disabled = false; form.elements.packageId.value = item?.packageId || '';
    form.dataset.availablePackages = JSON.stringify(packages);
  } catch (error) { $('#upstreamPackageDialog').close(); handleError(error); }
}

function renderHealthService(name, service) {
  const badgeElement = $(`#${name}Health`); const detailElement = $(`#${name}HealthDetail`);
  if (service?.skipped) {
    badgeElement.className = 'badge off'; badgeElement.textContent = '未启用';
    detailElement.textContent = service.error || '当前未启用，无需探测';
    return;
  }
  const degraded = Boolean(service?.degraded);
  badgeElement.className = `badge ${service?.ok ? 'active' : degraded ? 'pending' : 'off'}`;
  badgeElement.textContent = service?.ok ? '正常' : degraded ? '降级运行' : '异常';
  detailElement.textContent = service?.ok ? '探针检查通过' : (service?.error || '探针检查失败');
}

export async function loadSystemHealth() {
  const response = await fetch('/api/admin/health', { headers: { accept: 'application/json' } });
  const result = await response.json().catch(() => ({ error: '服务器响应无效' }));
  if (response.status === 401) return showLogin();
  if (response.status === 403) throw Object.assign(new Error(result.error || '无权查看系统状态'), { status: 403 });
  if (!response.ok && response.status !== 207) throw new Error(result.error || '健康检查失败');
  renderHealthService('postgres', result.services?.postgres);
  renderHealthService('redis', result.services?.redis);
  renderHealthService('cdnfly', result.services?.cdnfly);
  renderHealthService('scheduler', result.services?.scheduler);
  renderHealthService('email', result.services?.email);
  if (result.services?.cdnfly?.accounts) $('#cdnflyHealthDetail').textContent = `${result.services.cdnfly.healthy} / ${result.services.cdnfly.total} 个上游连接正常${result.services.cdnfly.error ? ` · ${result.services.cdnfly.error}` : result.services.cdnfly.warning ? ` · ${result.services.cdnfly.warning}` : ''}`;
  if (result.services?.scheduler?.lastRunAt) $('#schedulerHealthDetail').textContent = `最近执行：${formatDate(result.services.scheduler.lastRunAt)}${result.services.scheduler.lastRunError ? ` · ${result.services.scheduler.lastRunError}` : ''}`;
  const degraded = result.status === 'degraded' || Object.values(result.services || {}).some(service => service?.degraded);
  const healthy = result.status === 'healthy' || (!result.status && result.ok);
  $('#platformHealthState').textContent = healthy ? '核心服务正常' : degraded ? '部分能力降级' : '部分服务异常';
  $('#platformHealthState').className = healthy ? 'success-text' : degraded ? 'warning-text' : 'danger-text';
  $('#healthUpstreamCount').textContent = result.upstreamCount ?? (result.packageId ? '1（兼容模式）' : '-');
  $('#healthEmailRequirement').textContent = result.services?.email?.required ? '已启用' : '未启用';
  $('#healthCheckedAt').textContent = result.checkedAt ? formatDate(result.checkedAt) : '-';
}

export async function loadRuntimeSettings() {
  const { settings } = await api('/api/admin/settings'); state.runtimeSettings = settings;
  const form = $('#runtimeSettingsForm');
  for (const name of ['siteName', 'siteSubtitle', 'supportEmail', 'announcementTitle', 'announcementBody', 'announcementSeverity', 'announcementAudience', 'announcementMode', 'turnstileSiteKey', 'emailCodeCooldownSeconds', 'emailCodeHourlyLimit', 'renewalGraceDays', 'allowedEmailDomains', 'termsTitle', 'termsBody', 'privacyTitle', 'privacyBody']) {
    form.elements[name].value = settings[name] ?? '';
  }
  for (const name of ['announcementEnabled', 'announcementDismissible', 'registrationEnabled', 'emailVerificationEnabled', 'turnstileEnabled', 'maintenanceMode', 'inviteOnly', 'legalConsentRequired']) form.elements[name].checked = Boolean(settings[name]);
  form.elements.announcementStartsAt.value = toLocalInput(settings.announcementStartsAt);
  form.elements.announcementEndsAt.value = toLocalInput(settings.announcementEndsAt);
  form.elements.turnstileSecret.value = '';
  const configured = Boolean(settings.turnstileSiteKey && settings.turnstileConfigured); const verified = Boolean(settings.turnstileVerified);
  const status = !configured ? ['off', '未配置'] : settings.turnstileEnabled ? ['active', '已启用'] : verified ? ['active', '已测试'] : ['pending', '待测试'];
  $('#turnstileConfigStatus').className = `badge ${status[0]}`; $('#turnstileConfigStatus').textContent = status[1];
  $('#turnstileTestedAt').textContent = verified && settings.turnstileTestedAt ? `最近测试：${formatDate(settings.turnstileTestedAt)}` : configured ? '密钥已保存，请完成人机验证并测试' : '保存密钥后可进行测试';
  $('#emailServiceStatus').className = `badge ${state.authConfig?.emailServiceAvailable ? 'active' : 'off'}`;
  $('#emailServiceStatus').textContent = state.authConfig?.emailServiceAvailable ? '邮件服务可用' : '邮件服务未配置';
  renderAnnouncementAdminPreview();
  await renderSettingsTurnstile(settings.turnstileSiteKey).catch(error => toast(error.message, true));
}

function renderAnnouncementAdminPreview() {
  const form = $('#runtimeSettingsForm'); if (!form) return;
  const enabled = form.elements.announcementEnabled.checked; const now = new Date();
  const starts = form.elements.announcementStartsAt.value ? new Date(form.elements.announcementStartsAt.value) : null;
  const ends = form.elements.announcementEndsAt.value ? new Date(form.elements.announcementEndsAt.value) : null;
  const status = !enabled ? ['off', '未启用'] : starts && starts > now ? ['pending', '待生效'] : ends && ends <= now ? ['off', '已结束'] : ['active', '展示中'];
  $('#announcementAdminStatus').className = `badge ${status[0]}`; $('#announcementAdminStatus').textContent = status[1];
  const preview = $('#announcementPreview'); preview.className = `announcement-preview full announcement-${form.elements.announcementSeverity.value}`;
  $('strong', preview).textContent = form.elements.announcementTitle.value.trim() || '公告标题';
  $('p', preview).textContent = form.elements.announcementBody.value.trim() || '公告内容将在这里预览';
}

async function renderSettingsTurnstile(siteKey) {
  const slot = $('#turnstileSettingsSlot'); slot.replaceChildren(); turnstileTokens.delete('settings');
  const existing = turnstileWidgets.get('settings'); if (existing !== undefined && window.turnstile) window.turnstile.remove(existing);
  turnstileWidgets.delete('settings');
  if (!siteKey) return;
  const client = await loadTurnstileScript();
  const id = client.render(slot, { sitekey: siteKey, theme: 'light', callback: token => turnstileTokens.set('settings', token),
    'expired-callback': () => turnstileTokens.delete('settings'), 'error-callback': () => turnstileTokens.delete('settings') });
  turnstileWidgets.set('settings', id);
}

export async function loadAdministrators() {
  if (state.me.user.adminRole !== 'super_admin') return;
  const result = await api('/api/admin/administrators'); state.administrators = result.administrators;
  $('#administratorTable').replaceChildren(...state.administrators.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td class="right"><span class="row-actions"><button data-edit-administrator>配置</button><button class="danger" data-disable-administrator>停用</button></span></td>';
    $('strong', tr).textContent = item.username; $('small', tr).textContent = `#${item.id}`; tr.children[1].textContent = item.email || '-'; tr.children[2].textContent = item.adminRole === 'super_admin' ? '超级管理员' : '管理员';
    tr.children[3].innerHTML = item.status === 'active' ? '<span class="badge active">正常</span>' : '<span class="badge off">已停用</span>'; tr.children[4].textContent = formatDate(item.lastLoginAt);
    $('[data-edit-administrator]', tr).dataset.editAdministrator = item.id; $('[data-disable-administrator]', tr).dataset.disableAdministrator = item.id; return tr;
  }));
}

export async function loadInvitations(page = 1) {
  if (state.me.user.adminRole !== 'super_admin') return;
  const result = await api(queryPath('/api/admin/security/invites', {}, page)); state.registrationInvites = result.invites;
  const rows = state.registrationInvites.map(item => { const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong></td><td></td><td></td><td></td><td></td><td class="right"></td>';
    $('strong', tr).textContent = `****-${item.suffix}`; tr.children[1].textContent = item.label || '-'; tr.children[2].textContent = `${item.usedCount} / ${item.maxUses}`; tr.children[3].textContent = item.expiresAt ? formatDate(item.expiresAt) : '长期有效'; tr.children[4].innerHTML = resourceStatus(item);
    if (item.status === 'active') { const button = document.createElement('button'); button.className = 'danger'; button.dataset.disableInvite = item.id; button.textContent = '停用'; tr.children[5].append(button); } else tr.children[5].textContent = '-'; return tr; });
  $('#inviteTable').replaceChildren(...(rows.length ? rows : [emptyTableRow(6, '暂无邀请码')]));
  $('#invitationTotal').textContent = result.summary?.total ?? result.pagination?.total ?? 0;
  $('#invitationActive').textContent = result.summary?.active ?? 0;
  $('#invitationUsed').textContent = `${result.summary?.used ?? 0} 次`;
  $('#invitationMode').textContent = state.authConfig?.inviteOnly ? '仅邀请码' : '无需邀请码';
  renderPager('#invitesPager', result.pagination, 'invites');
}

function detailSection(title, pairs) {
  const section = document.createElement('section'); const heading = document.createElement('h4'); heading.textContent = title; const grid = document.createElement('dl'); grid.className = 'detail-grid';
  for (const [label, value] of pairs) { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value ?? '-'; grid.append(dt, dd); }
  section.append(heading, grid); return section;
}

async function openCustomerDetail(id) {
  const result = await api(`/api/admin/customers/${id}`); const customer = result.customer; const body = $('#customerDetailBody');
  $('#customerDetailTitle').textContent = `${customer.username} · 客户 #${customer.id}`;
  body.replaceChildren(
    detailSection('账号与资金', [['邮箱', customer.email || '-'], ['邮箱状态', customer.emailVerified ? '已验证' : '未验证'], ['账号状态', customer.status === 'active' ? '正常' : '已停用'], ['余额', formatMoney(result.wallet.balanceCents)], ['注册时间', formatDate(customer.createdAt)]]),
    detailSection('资源概览', [['网站', String(result.counts.sites)], ['其他资源', String(result.counts.resources)], ['订单', String(result.counts.orders)], ['有效套餐', String(result.billing?.subscriptions?.length || 0)]]),
    detailSection('最近套餐', (result.subscriptions || []).slice(0, 6).map(item => [`#${item.id} ${item.plan_name}`, `${formatDate(item.starts_at)} 至 ${formatDate(item.ends_at)} · ${item.status}`])),
    detailSection('最近网站', (result.sites || []).slice(0, 6).map(item => [item.domain, `${item.enabled ? '正常' : '已停用'} · ${formatDate(item.created_at)}`])),
    detailSection('最近订单', (result.orders || []).slice(0, 6).map(item => [`订单 #${item.id}`, `${item.product_name || item.type} · ${formatMoney(item.amount_cents)} · ${item.status}`])),
    detailSection('登录设备', (result.sessions || []).slice(0, 6).map(item => [`最近访问 IP：${item.last_ip || '待设备再次访问'}`, `最近访问：${formatDate(item.last_seen_at)} · 登录时 IP：${item.ip || '未知 IP'} · ${item.user_agent || '未知客户端'}`])),
    detailSection('最近审计', (result.recentAudit || []).slice(0, 6).map(item => [auditActionLabel(item), `${auditEntityLabel(item)}${item.resource_id ? ` #${item.resource_id}` : ''} · ${formatDate(item.created_at)}`])),
  );
  $('#customerDetailDialog').showModal();
}

export async function openOrderDetail(id) {
  const result = await api(`/api/admin/billing/orders/${id}`); const order = result.order; state.currentOrder = order; const snapshot = order.productSnapshot || {};
  $('#orderDetailTitle').textContent = `订单 #${order.id}`;
  $('#orderDetailBody').replaceChildren(
    detailSection('订单信息', [['客户', order.username], ['商品', order.productName || order.type], ['类型', order.type], ['状态', order.status], ['支付方式', order.channel === 'balance' ? '账户余额' : order.channel === 'balance_refund' ? '账户余额退款' : order.channel || '-'], ['金额', orderAmountLabel(order)], ['创建时间', formatDate(order.createdAt)], ['支付时间', formatDate(order.paidAt)], ['退款时间', formatDate(order.refundedAt)]]),
    detailSection('购买快照', Object.entries(snapshot).map(([key, value]) => [({ name: '商品名称', priceCents: '价格', durationDays: '周期（天）', domainLimit: '域名额度', trafficLimitBytes: '流量额度', portLimit: '端口额度' })[key] || key, key.toLowerCase().includes('cents') ? formatMoney(value) : String(value ?? '-')])),
    detailSection('关联记录', [['套餐实例', order.subscriptionId ? `#${order.subscriptionId}` : '-'], ['余额流水', order.transactionId ? `#${order.transactionId}` : '-'], ['交易后余额', order.balanceAfterCents === null || order.balanceAfterCents === undefined ? '-' : formatMoney(order.balanceAfterCents)]]),
  );
  $('#refundOrderButton').classList.toggle('hidden', order.status !== 'paid' || !['plan', 'renewal', 'upgrade', 'traffic'].includes(order.type)); $('#refundOrderButton').dataset.orderId = order.id; $('#orderDetailDialog').showModal();
}

function openAdministratorDialog(item = null) {
  const form = $('#administratorForm'); form.reset(); form.elements.id.value = item?.id || ''; form.elements.username.value = item?.username || ''; form.elements.email.value = item?.email || ''; form.elements.adminRole.value = item?.adminRole || 'admin'; form.elements.status.checked = item?.status !== 'disabled';
  form.elements.username.readOnly = Boolean(item); form.elements.email.readOnly = Boolean(item); form.elements.password.required = !item; $('#administratorStatusField').classList.toggle('hidden', !item);
  $('#administratorDialogTitle').textContent = item ? `配置 ${item.username}` : '添加管理员'; $('#administratorDialog').showModal();
}

$('#refreshAdminOverview').addEventListener('click', () => loadAdminOverview().catch(handleError));

$('#refreshSystemHealth').addEventListener('click', () => loadSystemHealth().catch(handleError));

$('#refreshUpstreams').addEventListener('click', () => loadUpstreams().catch(handleError));

$('#newUpstreamButton').addEventListener('click', () => openUpstreamDialog());

$('#upstreamTable').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-upstream]'); const test = event.target.closest('[data-test-upstream]'); const addPackage = event.target.closest('[data-add-upstream-package]'); const editPackage = event.target.closest('[data-edit-upstream-package]'); const viewCustomers = event.target.closest('[data-view-upstream-customers]');
  const upstreamId = Number(edit?.dataset.editUpstream || test?.dataset.testUpstream || addPackage?.dataset.addUpstreamPackage || editPackage?.dataset.upstreamId || viewCustomers?.dataset.viewUpstreamCustomers);
  const upstream = state.upstreams.find(item => item.id === upstreamId); if (!upstream) return;
  if (viewCustomers) {
    const customers = upstream.customers || [];
    return showRecords(`${upstream.name} · 客户归属`, customers.map(customer => ({
      title: customer.username,
      detail: `套餐 ${customer.subscriptionCount || 0} · 网站 ${customer.siteCount || 0} · 其他资源 ${customer.resourceCount || 0}`,
    })), '暂无客户归属');
  }
  if (edit) return openUpstreamDialog(upstream);
  if (addPackage) return openUpstreamPackageDialog(upstream);
  if (editPackage) return openUpstreamPackageDialog(upstream, upstream.packages.find(item => item.id === Number(editPackage.dataset.editUpstreamPackage)));
  if (test) { test.disabled = true; try { await api(`/api/admin/upstreams/${upstream.id}/test`, { method: 'POST', body: '{}' }); toast('上游连接正常'); } catch (error) { handleError(error); } finally { test.disabled = false; await loadUpstreams().catch(handleError); } }
});

$('#upstreamForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const body = { name: form.elements.name.value.trim(), baseUrl: form.elements.baseUrl.value.trim(), cnameSuffix: form.elements.cnameSuffix.value.trim(), requestsPerMinute: Number(form.elements.requestsPerMinute.value), timeoutMs: Number(form.elements.timeoutMs.value), status: form.elements.enabled.checked ? 'active' : 'disabled', isDefault: form.elements.isDefault.checked };
  if (form.elements.apiKey.value) body.apiKey = form.elements.apiKey.value.trim(); if (form.elements.apiSecret.value) body.apiSecret = form.elements.apiSecret.value.trim();
  try { await api(`/api/admin/upstreams${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#upstreamDialog').close(); await loadUpstreams(); toast('上游配置已保存'); } catch (error) { handleError(error); }
});

$('#upstreamPackageForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const upstreamId = form.elements.upstreamId.value; const id = form.elements.id.value;
  const body = { packageId: form.elements.packageId.value.trim(), name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), enabled: form.elements.enabled.checked };
  try { await api(`/api/admin/upstreams/${upstreamId}/packages${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#upstreamPackageDialog').close(); await loadUpstreams(); toast('上游套餐已保存'); } catch (error) { handleError(error); }
});

$('#upstreamPackageForm').elements.packageId.addEventListener('change', event => {
  let packages = []; try { packages = JSON.parse(event.currentTarget.form.dataset.availablePackages || '[]'); } catch {}
  const selected = packages.find(item => item.packageId === event.currentTarget.value); if (!selected) return;
  event.currentTarget.form.elements.name.value = selected.name || ''; event.currentTarget.form.elements.description.value = selected.description || '';
});

$('#runtimeSettingsForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#saveRuntimeSettings'); button.disabled = true;
  try {
    const body = {
      siteName: form.elements.siteName.value, siteSubtitle: form.elements.siteSubtitle.value, supportEmail: form.elements.supportEmail.value,
      announcementEnabled: form.elements.announcementEnabled.checked, announcementTitle: form.elements.announcementTitle.value, announcementBody: form.elements.announcementBody.value,
      announcementSeverity: form.elements.announcementSeverity.value, announcementAudience: form.elements.announcementAudience.value,
      announcementMode: form.elements.announcementMode.value, announcementDismissible: form.elements.announcementDismissible.checked,
      announcementStartsAt: form.elements.announcementStartsAt.value ? new Date(form.elements.announcementStartsAt.value).toISOString() : '', announcementEndsAt: form.elements.announcementEndsAt.value ? new Date(form.elements.announcementEndsAt.value).toISOString() : '',
      registrationEnabled: form.elements.registrationEnabled.checked, inviteOnly: form.elements.inviteOnly.checked, emailVerificationEnabled: form.elements.emailVerificationEnabled.checked,
      emailCodeCooldownSeconds: Number(form.elements.emailCodeCooldownSeconds.value), emailCodeHourlyLimit: Number(form.elements.emailCodeHourlyLimit.value),
      turnstileEnabled: form.elements.turnstileEnabled.checked, turnstileSiteKey: form.elements.turnstileSiteKey.value,
      maintenanceMode: form.elements.maintenanceMode.checked, renewalGraceDays: Number(form.elements.renewalGraceDays.value),
      allowedEmailDomains: form.elements.allowedEmailDomains.value, legalConsentRequired: form.elements.legalConsentRequired.checked,
      termsTitle: form.elements.termsTitle.value, termsBody: form.elements.termsBody.value, privacyTitle: form.elements.privacyTitle.value, privacyBody: form.elements.privacyBody.value,
    };
    if (form.elements.turnstileSecret.value) body.turnstileSecret = form.elements.turnstileSecret.value;
    const result = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) }); state.runtimeSettings = result.settings;
    const publicSettings = await api('/api/auth/config'); applyPublicSettings(publicSettings); await configureTurnstile(publicSettings); await loadRuntimeSettings(); toast('运行参数已保存');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

for (const eventName of ['input', 'change']) $('#runtimeSettingsForm').addEventListener(eventName, event => {
  if (event.target.name?.startsWith('announcement')) renderAnnouncementAdminPreview();
});

$('#testEmailButton').addEventListener('click', async () => {
  try {
    const email = $('#runtimeSettingsForm').elements.testEmail.value;
    const turnstileTokenValue = state.authConfig?.turnstileEnabled ? turnstileToken('settings') : '';
    await api('/api/admin/settings/test-email', { method: 'POST', body: JSON.stringify({ email, turnstileToken: turnstileTokenValue }) });
    resetTurnstile('settings'); toast('测试邮件已发送');
  }
  catch (error) { if (state.authConfig?.turnstileEnabled) resetTurnstile('settings'); handleError(error); }
});

$('#testTurnstileButton').addEventListener('click', async () => {
  try {
    const form = $('#runtimeSettingsForm');
    if (form.elements.turnstileSecret.value || form.elements.turnstileSiteKey.value.trim() !== String(state.runtimeSettings?.turnstileSiteKey || '')) throw new Error('密钥已修改，请先保存设置再进行测试');
    const token = turnstileTokens.get('settings'); if (!token) throw new Error('请先完成下方 Turnstile 测试');
    await api('/api/admin/settings/test-turnstile', { method: 'POST', body: JSON.stringify({ turnstileToken: token }) });
    toast('Turnstile 配置测试通过'); await loadRuntimeSettings();
  }
  catch (error) { handleError(error); }
});

$('#newAdministratorButton').addEventListener('click', () => openAdministratorDialog());

$('#administratorTable').addEventListener('click', async event => { const edit = event.target.closest('[data-edit-administrator]'); const disable = event.target.closest('[data-disable-administrator]'); if (edit) return openAdministratorDialog(state.administrators.find(item => item.id === Number(edit.dataset.editAdministrator))); if (!disable) return; const item = state.administrators.find(row => row.id === Number(disable.dataset.disableAdministrator)); if (!await confirmAction({ title: '停用管理员', message: `确认停用 ${item.username}？该账号的全部会话将被撤销。`, confirmLabel: '停用', danger: true })) return; try { await api(`/api/admin/administrators/${item.id}`, { method: 'DELETE' }); await loadAdministrators(); toast('管理员已停用'); } catch (error) { handleError(error); } });

$('#administratorForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value; const body = { username: form.elements.username.value, email: form.elements.email.value, adminRole: form.elements.adminRole.value, ...(form.elements.password.value ? { password: form.elements.password.value } : {}), ...(id ? { status: form.elements.status.checked ? 'active' : 'disabled' } : {}) }; try { await api(`/api/admin/administrators${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#administratorDialog').close(); await loadAdministrators(); toast('管理员已保存'); } catch (error) { handleError(error); } });

$('#newInviteButton').addEventListener('click', () => { $('#inviteForm').reset(); $('#inviteDialog').showModal(); });

$('#inviteForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form)); body.count = Number(body.count); body.maxUses = Number(body.maxUses); if (body.expiresAt) body.expiresAt = new Date(body.expiresAt).toISOString(); try { const result = await api('/api/admin/security/invites', { method: 'POST', body: JSON.stringify(body) }); $('#inviteDialog').close(); $('#generatedCodesTitle').textContent = '注册邀请码已生成'; $('#generatedCodes').value = result.codes.map(item => item.code).join('\n'); $('#generatedCodesDialog').showModal(); await loadInvitations(); } catch (error) { handleError(error); } });

$('#invitations').addEventListener('click', async event => { const invite = event.target.closest('[data-disable-invite]'); if (!invite) return; if (!await confirmAction({ title: '停用邀请码', message: '停用后该邀请码将不能继续注册，历史使用记录会保留。', confirmLabel: '停用', danger: true })) return; try { await api(`/api/admin/security/invites/${invite.dataset.disableInvite}`, { method: 'DELETE' }); await loadInvitations(); toast('邀请码已停用'); } catch (error) { handleError(error); } });

$('#newUserButton').addEventListener('click', () => { $('#userForm').reset(); $('#userDialog').showModal(); });

$('#userForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    await api('/api/admin/customers', { method: 'POST', body: JSON.stringify(values) }); $('#userDialog').close(); await loadUsers(); toast('客户已创建');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#userTable').addEventListener('click', async event => {
  const detail = event.target.closest('[data-customer-detail]'); const assign = event.target.closest('[data-assign-user]'); const reset = event.target.closest('[data-reset-user]'); const status = event.target.closest('[data-status]');
  try {
    if (detail) return await openCustomerDetail(Number(detail.dataset.customerDetail));
    if (assign) { await loadBillingAdmin(); return openSubscriptionDialog(Number(assign.dataset.assignUser)); }
    if (reset) { const customer = state.users.find(item => item.id === Number(reset.dataset.resetUser)); const form = $('#resetPasswordForm'); form.reset(); form.elements.userId.value = customer.id; $('#resetPasswordTitle').textContent = `重置 ${customer.username} 的密码`; return $('#resetPasswordDialog').showModal(); }
    if (status) {
      const user = state.users.find(item => item.id === Number(status.dataset.status));
      if (user.status === 'active' && !await confirmAction({ title: '停用客户', message: `确认停用 ${user.username}？该客户的全部会话将被撤销。`, confirmLabel: '停用客户', danger: true })) return;
      await api(`/api/admin/customers/${user.id}`, { method: 'PUT', body: JSON.stringify({ status: user.status === 'active' ? 'disabled' : 'active' }) }); await loadUsers(); toast('客户状态已更新');
    }
  } catch (error) { handleError(error); }
});

$('#resetPasswordForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api(`/api/admin/customers/${form.elements.userId.value}/password`, { method: 'PUT', body: JSON.stringify({ password: form.elements.password.value }) }); $('#resetPasswordDialog').close(); toast('客户密码已重置'); } catch (error) { handleError(error); }
});

$('#refreshAudit').addEventListener('click', () => loadAudit(1).catch(handleError));

function updateAdminSiteSubscriptions() {
  const form = $('#adminSiteForm'); const customer = state.users.find(item => item.id === Number(form.elements.userId.value));
  fillSubscriptionSelect(form.elements.subscriptionId, null, customer?.billing?.subscriptions || []);
}

$('#newAdminSiteButton').addEventListener('click', async () => { if (!state.users.length) await loadUsers(); const form = $('#adminSiteForm'); form.reset(); fillSelect(form.elements.userId, state.users.filter(item => item.status === 'active'), item => item.username); updateAdminSiteSubscriptions(); $('#adminSiteDialog').showModal(); });

$('#adminSiteForm').elements.userId.addEventListener('change', updateAdminSiteSubscriptions);

let adminSiteSearchTimer;

$('#adminSiteSearch').addEventListener('input', () => { clearTimeout(adminSiteSearchTimer); adminSiteSearchTimer = setTimeout(() => loadAdminSites(1).catch(handleError), 250); });

let adminStreamSearchTimer;

$('#adminStreamSearch').addEventListener('input', () => { clearTimeout(adminStreamSearchTimer); adminStreamSearchTimer = setTimeout(() => loadAdminStreams(1).catch(handleError), 250); });

let customerSearchTimer;

$('#customerSearch').addEventListener('input', () => { clearTimeout(customerSearchTimer); customerSearchTimer = setTimeout(() => loadUsers(1).catch(handleError), 250); });

$('#customerStatus').addEventListener('change', () => loadUsers(1).catch(handleError));

$('#adminSiteForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form)); body.userId = Number(body.userId); body.subscriptionId = Number(body.subscriptionId);
  try { await api('/api/admin/sites', { method: 'POST', body: JSON.stringify(body) }); $('#adminSiteDialog').close(); await loadAdminSites(); toast('客户站点已创建'); } catch (error) { handleError(error); }
});

$('#adminSiteTable').addEventListener('click', async event => {
  const toggle = event.target.closest('[data-admin-toggle]'); const remove = event.target.closest('[data-admin-delete]'); if (!toggle && !remove) return;
  const site = state.adminSites.find(item => item.id === Number(toggle?.dataset.adminToggle || remove?.dataset.adminDelete));
  try {
    if (toggle) { await api(`/api/admin/sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !site.enabled }) }); await loadAdminSites(); return toast(site.enabled ? '站点已停用' : '站点已启用'); }
    if (site.enabled) return toast('请先停用站点再删除', true); if (!await confirmAction({ title: '删除客户站点', message: `确认删除 ${site.domain}？此操作会同步删除上游网站。`, confirmLabel: '删除站点', danger: true })) return;
    await api(`/api/admin/sites/${site.id}`, { method: 'DELETE' }); await loadAdminSites(); toast('站点已删除');
  } catch (error) { handleError(error); }
});

$('#newAdminStreamButton').addEventListener('click', () => openAdminStreamDialog().catch(handleError));

$('#adminStreamForm').elements.userId.addEventListener('change', () => updateAdminStreamSubscriptions());

$('#adminStreamForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const id = Number(form.elements.id.value || 0);
  if (!form.elements.subscriptionId.value) return handleError(new Error('该客户没有可用的 CDN 套餐'));
  const body = {
    ...(!id ? { userId: Number(form.elements.userId.value) } : {}), subscriptionId: Number(form.elements.subscriptionId.value),
    des: form.elements.name.value.trim(), listen: [{ port: Number(form.elements.listenPort.value), protocol: form.elements.protocol.value }],
    backend_port: Number(form.elements.backendPort.value), backend: [{ addr: form.elements.backendAddr.value.trim(), weight: 1, state: 'up' }],
    balance_way: form.elements.balanceWay.value, enable: form.elements.enabled.checked ? 1 : 0,
  };
  const button = $('button[type="submit"]', form); button.disabled = true;
  try {
    await api(`/api/admin/streams${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('#adminStreamDialog').close(); await loadAdminStreams(); toast(id ? '转发配置已保存' : '客户转发已创建');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#adminStreamTable').addEventListener('click', async event => {
  const edit = event.target.closest('[data-admin-stream-edit]'); const toggle = event.target.closest('[data-admin-stream-toggle]'); const remove = event.target.closest('[data-admin-stream-delete]');
  const id = Number(edit?.dataset.adminStreamEdit || toggle?.dataset.adminStreamToggle || remove?.dataset.adminStreamDelete || 0);
  const stream = state.adminStreams.find(item => item.id === id); if (!stream) return;
  if (edit) return openAdminStreamDialog(stream).catch(handleError);
  try {
    if (toggle) {
      await api(`/api/admin/streams/${stream.id}`, { method: 'PUT', body: JSON.stringify({ enable: stream.enabled ? 0 : 1 }) });
      await loadAdminStreams(); return toast(stream.enabled ? '转发已停用' : '转发已启用');
    }
    if (stream.enabled) return toast('请先停用四层转发，再执行删除操作', true);
    if (!await confirmAction({ title: '删除客户转发', message: `确认删除 ${stream.name || `转发 #${stream.id}`}？删除后无法恢复。`, confirmLabel: '删除转发', danger: true })) return;
    remove.disabled = true;
    await api(`/api/admin/streams/${stream.id}`, { method: 'DELETE' }); await loadAdminStreams(); toast('转发已删除');
  } catch (error) {
    if (remove) remove.disabled = false;
    handleError(error);
  }
});
