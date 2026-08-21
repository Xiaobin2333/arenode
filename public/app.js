import { resourceEnabled, resourceLifecycle, siteLifecycle } from './resource-status.js?v=arenode';
import { collectMonitorPoints, formatMonitorBandwidth, formatMonitorChartLabel, formatMonitorTime, normalizeMonitorItems } from './monitor-utils.js';

const DEFAULT_SSL_CIPHERS = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';

const state = { me: null, authConfig: null, runtimeSettings: null, capabilities: { wafRules: true, attackLogs: true }, wallet: { balanceCents: 0, availableBalanceCents: 0, totalRechargeCents: 0, totalSpentCents: 0, transactions: [] }, sites: [], siteGroups: [], currentSite: null, currentSiteConfig: null, siteCertificates: [], siteAcls: [], siteCcRules: [], siteCnameChecks: new Map(), streams: [], streamItems: [], streamGroups: [], currentStream: null, userConfigs: [], configType: 'site', logKind: 'op', localLogs: [], auditLogs: [], monitorItems: [], monitorPoints: [], monitorContext: 'site', monitorMode: 'basic', monitorRequestId: 0, jobItems: [], users: [], adminSites: [], adminStreams: [], adminStreamCustomers: [], currentAdminStream: null, upstreams: [], resources: [], editingResource: null, billingPlans: [], billingOrders: [], billingUpgrades: [], billingTraffic: [], redemptions: [], billingAdmin: {}, adminOverview: null, administrators: [], registrationInvites: [], mfa: null, accountClosure: null, apiKeys: [], currentOrder: null, planChangeQuote: null, planChangeRequest: null, trafficPoints: [], streamCount: 0, jobCount: null, resourceKind: 'site-groups', editResourceKind: 'site-groups', resourceFilter: 'all', dataTab: 'streams', streamKind: 'streams', billingTarget: 'current', accountSection: 'profile', currentSiteSection: 'siteBasic', currentView: 'overview', selectedSites: new Set(), selectedResources: new Set(), selectedStreams: new Set(), ccMatchers: [], ccFilters: [], dnsApis: [], dnsAuthKeys: [], pageInfo: {} };
let serviceStatusTimer = null;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function queryPath(path, values = {}, page = 1) {
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== null && value !== undefined) params.set(key, value);
  return `${path}?${params}`;
}

function nextDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10);
}

function renderPager(selector, pagination, key) {
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

function labelTableCells(table) {
  const labels = $$('thead th', table).map(cell => cell.textContent.trim());
  for (const row of $$('tbody tr', table)) $$('td', row).forEach((cell, index) => { cell.dataset.label = labels[index] || ''; });
}
const tableObserver = new MutationObserver(records => {
  const tables = new Set(records.map(record => record.target.closest?.('table')).filter(Boolean));
  tables.forEach(labelTableCells);
});
$$('table tbody').forEach(body => tableObserver.observe(body, { childList: true }));

let actionMenuSequence = 0;
function actionMenu(content) {
  const id = `action-popover-${++actionMenuSequence}`;
  return `<span class="action-menu"><button type="button" class="action-menu-trigger" popovertarget="${id}" aria-haspopup="menu" aria-expanded="false">更多</button><div id="${id}" class="action-popover" popover="auto" role="menu">${content}</div></span>`;
}

function positionActionPopover(popover) {
  const trigger = document.querySelector(`[popovertarget="${CSS.escape(popover.id)}"]`); if (!trigger) return;
  const anchor = trigger.getBoundingClientRect(); const menu = popover.getBoundingClientRect(); const edge = 8;
  const viewportWidth = window.visualViewport?.width || window.innerWidth; const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const left = Math.max(edge, Math.min(anchor.right - menu.width, viewportWidth - menu.width - edge));
  const below = anchor.bottom + 6; const top = below + menu.height <= viewportHeight - edge ? below : Math.max(edge, anchor.top - menu.height - 6);
  popover.style.left = `${Math.round(left)}px`; popover.style.top = `${Math.round(top)}px`;
  trigger.setAttribute('aria-expanded', 'true');
}

function closeActionPopovers() {
  for (const popover of $$('.action-popover:popover-open')) popover.hidePopover();
}

document.addEventListener('toggle', event => {
  const popover = event.target.closest?.('.action-popover'); if (!popover) return;
  const trigger = document.querySelector(`[popovertarget="${CSS.escape(popover.id)}"]`);
  if (event.newState === 'open') requestAnimationFrame(() => positionActionPopover(popover));
  else trigger?.setAttribute('aria-expanded', 'false');
}, true);
document.addEventListener('click', event => {
  const action = event.target.closest('.action-popover button'); const popover = action?.closest('.action-popover');
  if (popover?.matches(':popover-open')) popover.hidePopover();
});
window.addEventListener('scroll', closeActionPopovers, true);

function syncWorkbenchLayout() {
  const compact = window.matchMedia('(max-width: 900px)').matches;
  for (const layout of $$('.workbench-layout')) {
    const rail = $('.workbench-rail', layout); const main = $('.workbench-main, .data-workbench-main', layout);
    if (!rail || !main) continue;
    if (layout.classList.contains('data-workbench')) {
      layout.style.width = '100%'; layout.style.gridTemplateColumns = 'minmax(0, 1fr)';
      rail.hidden = true; rail.style.setProperty('display', 'none', 'important');
      main.style.width = '100%'; main.style.minWidth = '0'; main.style.gridColumn = '1';
      continue;
    }
    const contextRailVisible = rail.id !== 'resourceContextRail' || ['certs', 'dnsapis'].includes(state.resourceKind);
    layout.style.width = '100%'; layout.style.gridTemplateColumns = contextRailVisible && !compact ? '220px minmax(0, 1fr)' : 'minmax(0, 1fr)';
    rail.hidden = !contextRailVisible; rail.classList.toggle('hidden', !contextRailVisible); rail.style.setProperty('display', contextRailVisible ? 'grid' : 'none', 'important'); rail.style.gridColumn = '1';
    main.style.width = '100%'; main.style.minWidth = '0'; main.style.gridColumn = compact ? '1' : '2';
    if (!contextRailVisible) main.style.gridColumn = '1';
  }
}
window.addEventListener('resize', () => { syncWorkbenchLayout(); closeActionPopovers(); });

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({ error: '服务器响应无效' }));
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status, data });
  return data;
}

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 2800);
}

async function loadViewState(name, task) {
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

let confirmResolver = null;
function confirmAction({ title = '确认操作', message, confirmLabel = '确认', danger = false } = {}) {
  if (confirmResolver) confirmResolver(false);
  const dialog = $('#confirmDialog'); $('#confirmDialogTitle').textContent = title;
  const body = $('#confirmDialogBody'); body.replaceChildren();
  const paragraph = document.createElement('p'); paragraph.textContent = message || '确认继续执行此操作？'; body.append(paragraph);
  const accept = $('#confirmDialogAccept'); accept.textContent = confirmLabel; accept.className = danger ? 'danger-button' : 'primary';
  dialog.showModal();
  return new Promise(resolve => { confirmResolver = resolve; });
}

$$('[data-confirm-value]').forEach(button => button.addEventListener('click', () => {
  const accepted = button.dataset.confirmValue === 'true'; $('#confirmDialog').close();
  const resolve = confirmResolver; confirmResolver = null; resolve?.(accepted);
}));
$('#dismissAnnouncement').addEventListener('click', () => {
  const dialog = $('#announcementDialog'); if (dialog.dataset.dismissible === 'true') localStorage.setItem(dialog.dataset.storageKey, 'dismissed'); dialog.close();
});
$('#closeAppAnnouncement').addEventListener('click', event => {
  const banner = event.currentTarget.closest('#appAnnouncement'); if (banner.dataset.storageKey) localStorage.setItem(banner.dataset.storageKey, 'dismissed'); banner.classList.add('hidden');
});

function showRecords(title, records, emptyText = '暂无记录') {
  $('#recordDialogTitle').textContent = title; const body = $('#recordDialogBody'); body.replaceChildren();
  if (!records.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = emptyText; body.append(empty); }
  else for (const record of records) { const item = document.createElement('div'); item.className = 'record-item';
    const strong = document.createElement('strong'); strong.textContent = record.title; const small = document.createElement('small'); small.textContent = record.detail || '';
    item.append(strong, small); body.append(item); }
  $('#recordDialog').showModal();
}

function emptyTableRow(columns, message) {
  const row = document.createElement('tr'); const cell = document.createElement('td');
  cell.colSpan = columns; cell.className = 'table-empty'; cell.textContent = message; row.append(cell); return row;
}

const turnstileWidgets = new Map();
const turnstileTokens = new Map();
let turnstileLoader = null;
let renderedTurnstileSiteKey = '';

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.defer = true;
    script.addEventListener('load', () => resolve(window.turnstile));
    script.addEventListener('error', () => reject(new Error('Turnstile 加载失败，请检查网络')));
    document.head.append(script);
  });
  return turnstileLoader;
}

async function configureTurnstile(settings) {
  const slots = $$('.turnstile-slot[data-turnstile]');
  slots.forEach(slot => slot.classList.toggle('hidden', !settings.turnstileEnabled));
  if (!settings.turnstileEnabled) { turnstileTokens.clear(); return; }
  const client = await loadTurnstileScript();
  if (renderedTurnstileSiteKey && renderedTurnstileSiteKey !== settings.turnstileSiteKey) {
    for (const widgetId of turnstileWidgets.values()) client.remove(widgetId);
    turnstileWidgets.clear(); turnstileTokens.clear(); slots.forEach(slot => { slot.replaceChildren(); });
  }
  renderedTurnstileSiteKey = settings.turnstileSiteKey;
  for (const slot of slots) {
    const purpose = slot.dataset.turnstile;
    if (turnstileWidgets.has(purpose)) continue;
    const widgetId = client.render(slot, {
      sitekey: settings.turnstileSiteKey,
      theme: 'light',
      callback: token => turnstileTokens.set(purpose, token),
      'expired-callback': () => turnstileTokens.delete(purpose),
      'error-callback': () => turnstileTokens.delete(purpose),
    });
    turnstileWidgets.set(purpose, widgetId);
  }
}

function turnstileToken(purpose) {
  if (!state.authConfig?.turnstileEnabled) return '';
  const token = turnstileTokens.get(purpose);
  if (!token) throw new Error('请先完成人机验证');
  return token;
}

function resetTurnstile(purpose) {
  turnstileTokens.delete(purpose);
  const widgetId = turnstileWidgets.get(purpose);
  if (widgetId !== undefined && window.turnstile) window.turnstile.reset(widgetId);
}

function startCooldown(button, seconds, label) {
  clearInterval(button.cooldownTimer); let remaining = Number(seconds || state.authConfig?.emailCodeCooldownSeconds || 60);
  button.disabled = true; button.textContent = `${remaining} 秒后可重发`;
  button.cooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { clearInterval(button.cooldownTimer); button.disabled = false; button.textContent = label; }
    else button.textContent = `${remaining} 秒后可重发`;
  }, 1000);
}

function formatDate(value) {
  if (!value) return '-';
  const text = String(value).trim();
  if (!text || text === '-' || text === '0') return '-';
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const GIB = 1024 ** 3;
const formatMoney = cents => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const orderNetAmountCents = order => order.type === 'plan_change' && Number(order.balanceAdjustmentCents) > 0
  ? -Number(order.amountCents || 0) : Number(order.amountCents || 0);
const orderAmountLabel = order => orderNetAmountCents(order) < 0 ? `退款 ${formatMoney(Math.abs(orderNetAmountCents(order)))}` : formatMoney(order.amountCents);

function announcementHomeVisible() {
  if (!state.me) return true;
  return state.me.user.role === 'admin' ? state.currentView === 'admin-overview' : state.currentView === 'overview';
}

function renderAnnouncement(settings = state.authConfig) {
  const banner = state.me ? $('#appAnnouncement') : $('#publicAnnouncement'); const dialog = $('#announcementDialog');
  for (const item of [$('#appAnnouncement'), $('#publicAnnouncement')]) item?.classList.add('hidden');
  if (!settings?.announcementEnabled || !announcementHomeVisible()) {
    if (dialog?.open) dialog.close();
    return;
  }
  const severity = settings.announcementSeverity || 'info';
  const storageKey = `announcement:${settings.announcementVersion || settings.announcementTitle}`;
  if (settings.announcementDismissible && localStorage.getItem(storageKey) === 'dismissed') return;
  if (settings.announcementMode === 'banner' && banner) {
    banner.className = `${state.me ? 'app-announcement' : 'public-announcement'} announcement-${severity}`;
    $('strong', banner).textContent = settings.announcementTitle; $('p', banner).textContent = settings.announcementBody;
    banner.dataset.storageKey = storageKey;
    $('#closeAppAnnouncement')?.classList.toggle('hidden', !settings.announcementDismissible);
  }
  if (settings.announcementMode === 'modal' && dialog) {
    dialog.dataset.storageKey = storageKey; dialog.dataset.dismissible = String(Boolean(settings.announcementDismissible));
    $('#announcementDialogTitle').textContent = settings.announcementTitle; $('#announcementDialogBody').textContent = settings.announcementBody;
    $('[data-close="announcementDialog"]').classList.toggle('hidden', !settings.announcementDismissible);
    queueMicrotask(() => { if (announcementHomeVisible() && !dialog.open) dialog.showModal(); });
  }
}

function applyPublicSettings(settings) {
  if (!settings) return;
  state.authConfig = settings;
  $$('[data-site-name]').forEach(element => { element.textContent = settings.siteName || 'Arenode'; });
  $$('[data-site-subtitle]').forEach(element => { element.textContent = settings.siteSubtitle || ''; });
  document.title = `${settings.siteName || 'Arenode'} 控制台`;
  $('#showRegister').classList.toggle('hidden', !settings.registrationEnabled);
  $('#inviteCodeField').classList.toggle('hidden', !settings.inviteOnly);
  $('#registerForm').elements.inviteCode.required = Boolean(settings.inviteOnly);
  $('#legalConsentField').classList.toggle('hidden', !settings.legalConsentRequired);
  $('#registerForm').elements.legalConsent.required = Boolean(settings.legalConsentRequired);
  renderAnnouncement(settings);
}
function formatBytes(value) {
  if (value === null || value === undefined) return '不限';
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '-';
  if (Math.abs(bytes) < 1024) return `${bytes.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} B`;
  if (Math.abs(bytes) < 1024 ** 2) return `${(bytes / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} KiB`;
  if (Math.abs(bytes) < GIB) return `${(bytes / 1024 ** 2).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} MiB`;
  return `${(bytes / GIB).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} GiB`;
}
const formatLimit = value => value === null || value === undefined ? '不限' : Number(value).toLocaleString('zh-CN');
const financeTypeLabels = {
  'recharge-code': '充值码入账', 'admin-adjustment': '管理员余额调整', order: '订单支付',
  'order-refund': '订单退款', recharge: '余额充值', refund: '退款', redemption: '权益兑换',
};
const financeTypeLabel = value => financeTypeLabels[value] || value || '其他';
function statusBadge(status) {
  const labels = { active: '生效中', suspended: '已暂停', pending: '等待客户', open: '处理中', resolved: '已解决', closed: '已关闭', paid: '已支付', cancelled: '已取消', refunded: '已退款', expired: '已到期' };
  const tone = ['active', 'paid', 'resolved'].includes(status) ? 'active' : ['pending', 'open'].includes(status) ? 'pending' : 'off';
  return `<span class="badge ${tone}">${labels[status] || status || '-'}</span>`;
}

function badge(site) {
  const lifecycle = siteLifecycle(site);
  return `<span class="badge ${lifecycle.tone}">${lifecycle.label}</span>`;
}

function siteRow(site, actions = true) {
  const tr = document.createElement('tr');
  if (!actions) {
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td>${badge(site)}</td><td>${formatDate(site.createdAt)}</td>`;
    $('td strong', tr).textContent = site.domain;
    $('td small', tr).textContent = site.cname || '等待 CDN 服务分配 CNAME';
    tr.children[1].textContent = site.origin;
    return tr;
  }
  const wafAction = state.capabilities.wafRules === false ? '' : `<button type="button" data-waf="${site.id}">WAF 防护</button>`;
  const moreActions = `${wafAction}<button type="button" data-toggle="${site.id}">${site.enabled ? '停用网站' : '启用网站'}</button><button type="button" class="danger" data-delete="${site.id}">删除网站</button>`;
  const httpsEnabled = Boolean(site.httpsEnabled ?? site.https_enabled ?? site.https_enabled_at);
  const ports = site.listenPorts || site.httpPorts || site.http_ports || 'HTTP:80';
  tr.innerHTML = `<td class="select-cell"><input type="checkbox" data-select-site="${site.id}" aria-label="选择网站"></td><td><span class="id-chip">#${site.id}</span></td><td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td><span class="cname-cell"></span></td><td>${badge(site)}</td><td class="right"><span class="row-actions"><button class="manage-button" data-manage="${site.id}">管理</button>${actionMenu(moreActions)}</span></td>`;
  $('[data-select-site]', tr).checked = state.selectedSites.has(site.id);
  const domainCell = tr.children[2]; $('strong', domainCell).textContent = site.domain; $('small', domainCell).textContent = formatDate(site.createdAt);
  tr.children[3].textContent = ports;
  tr.children[4].textContent = site.origin || '-';
  tr.children[5].innerHTML = httpsEnabled ? '<span class="badge active">已启用</span>' : '<span class="badge off">未启用</span>';
  tr.children[6].textContent = site.planName || '未绑定';
  $('.cname-cell', tr).textContent = site.cname || '等待 CDN 服务分配';
  return tr;
}

function tenantSubscriptions() {
  return (state.me?.billing?.subscriptions || []).filter(item => ['active', 'suspended'].includes(item.subscription?.status));
}

function fillSubscriptionSelect(select, selectedId = null, subscriptions = tenantSubscriptions()) {
  const usable = subscriptions.filter(item => item.plan?.upstreamId && item.plan?.upstreamPackageId);
  select.replaceChildren(...usable.map(item => {
    const option = document.createElement('option'); option.value = item.subscription.id;
    option.textContent = `${item.plan.name} · #${item.subscription.id} · ${item.resources?.sites || 0} 站点`;
    return option;
  }));
  if (selectedId !== null && selectedId !== undefined) select.value = String(selectedId);
}

async function refreshTenantBillingState() {
  state.me = await api('/api/me');
  renderTenantBilling();
  renderAccountProfile();
  renderOverview();
}

function quotaPercent(used, limit) {
  if (limit === null || limit === undefined) return 0;
  if (Number(limit) === 0) return Number(used) > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Number(used || 0) / Number(limit) * 100));
}

function quotaSummaryRow(label, used, limit, formatter, tone) {
  const percent = quotaPercent(used, limit);
  const row = document.createElement('div'); row.className = 'quota-summary-row';
  row.innerHTML = `<header><span></span><strong></strong></header><div class="quota-track"><i class="${tone}"></i></div>`;
  $('header span', row).textContent = label;
  $('header strong', row).textContent = `${formatter(used)} / ${formatter(limit)}`;
  $('.quota-track i', row).style.width = limit === null || limit === undefined ? '100%' : `${percent}%`;
  return row;
}

function renderAccountProfile() {
  if (!state.me) return;
  const { user, billing } = state.me; const initial = user.username[0].toUpperCase();
  $('#profileInitial').textContent = initial; $('#profileName').textContent = user.username; $('#profileUsername').textContent = user.username;
  $('#profileEmail').textContent = user.email || '-';
  $('#profileIdentity').textContent = user.role === 'admin' ? '平台管理员账户' : '客户账户';
  $('#profileRole').textContent = user.role === 'admin' ? (user.adminRole === 'super_admin' ? '超级管理员' : '管理员') : '客户';
  $('#profileCreatedAt').textContent = formatDate(user.createdAt); $('#profilePlan').textContent = billing?.plan?.name || (user.role === 'admin' ? '平台管理账户' : '未分配');
  $('#emailSecurityState').textContent = user.emailVerified ? '已验证' : '未验证';
  $('#emailSecurityState').className = `badge ${user.emailVerified ? 'active' : 'off'}`;
  $('#emailChangeDescription').textContent = user.email ? `当前邮箱：${user.email}` : '账户尚未绑定邮箱';
}

function renderOverview() {
  if (!state.me || state.me.user.role === 'admin') return;
  const billing = state.me.billing || { plan: null, subscription: null, usage: {}, limits: {}, reasons: [] };
  const usage = billing.usage || {}; const limits = billing.limits || {};
  const hour = new Date().getHours(); const greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
  const active = state.sites.filter(site => siteLifecycle(site).state === 'active').length;
  const issues = state.sites.filter(site => siteLifecycle(site).state !== 'active').length;
  const resourcePercent = Math.max(quotaPercent(usage.domains, limits.domains), quotaPercent(usage.trafficBytes, limits.trafficBytes), quotaPercent(usage.ports, limits.ports));
  const planState = billing.subscription?.status === 'active' ? '生效中' : billing.subscription?.status === 'suspended' ? '已暂停' : '待开通';
  $('#greetingText').textContent = greeting; $('#welcomeName').textContent = state.me.user.username; $('#welcomeSites').textContent = `${state.sites.length} 个`;
  $('#welcomePlan').textContent = billing.plan?.name || '未分配'; $('#welcomePlanState').textContent = planState;
  $('#accountPlan').textContent = billing.plan?.name || '未分配'; $('#accountPlanEnd').textContent = billing.subscription ? formatDate(billing.subscription.endsAt) : '-';
  const resourceState = !billing.subscription ? '未开通' : billing.overLimit ? '已超限' : '正常';
  $('#accountResourceState').textContent = resourceState; $('#accountResourceState').classList.toggle('success-text', Boolean(billing.subscription && !billing.overLimit)); $('#accountResourceState').classList.toggle('danger-text', Boolean(billing.subscription && billing.overLimit));
  $('#metricSites').textContent = state.sites.length; $('#metricActive').textContent = active;
  $('#metricQuota').textContent = `${formatLimit(usage.domains || 0)} / ${formatLimit(limits.domains)}`; $('#metricPorts').textContent = `${formatLimit(usage.ports || 0)} / ${formatLimit(limits.ports)}`;
  $('#attentionLatest').textContent = state.sites[0]?.domain || '暂无'; $('#attentionUsage').textContent = `${Math.round(resourcePercent)}%`;
  $('#attentionIssues').textContent = `${issues} 个`; $('#attentionOrders').textContent = `${state.billingOrders.filter(order => order.status === 'pending').length} 笔`;
  $('#overviewQuotaSummary').replaceChildren(
    quotaSummaryRow('加速域名', usage.domains || 0, limits.domains, formatLimit, 'blue'),
    quotaSummaryRow('本月流量', usage.trafficBytes || 0, limits.trafficBytes, formatBytes, 'green'),
    quotaSummaryRow('HTTP / 转发端口', usage.ports || 0, limits.ports, formatLimit, 'amber'),
  );
  const httpsSites = state.sites.filter(site => Boolean(site.httpsEnabled ?? site.https_enabled ?? site.https_enabled_at)).length;
  $('#siteSummaryTotal').textContent = state.sites.length; $('#siteSummaryActive').textContent = active; $('#siteSummaryHttps').textContent = httpsSites; $('#siteSummaryPaused').textContent = state.sites.length - active;
  $('#dataSummarySites').textContent = state.sites.length; $('#dataSummaryStreams').textContent = state.streamCount; $('#dataSummaryJobs').textContent = state.jobCount ?? '-';
  $('#dataSummaryPorts').textContent = `${formatLimit(usage.ports || 0)} / ${formatLimit(limits.ports)}`;
  $('#screenSites').textContent = state.sites.length; $('#screenActive').textContent = active; $('#screenTraffic').textContent = formatBytes(usage.trafficBytes || 0);
  $('#screenPorts').textContent = `${formatLimit(usage.ports || 0)} / ${formatLimit(limits.ports)}`; $('#screenPlan').textContent = billing.plan?.name || '未分配';
  $('#screenPlanEnd').textContent = billing.subscription ? formatDate(billing.subscription.endsAt) : '-';
  $('#screenQuotaSummary').replaceChildren(
    quotaSummaryRow('加速域名', usage.domains || 0, limits.domains, formatLimit, 'blue'),
    quotaSummaryRow('本月流量', usage.trafficBytes || 0, limits.trafficBytes, formatBytes, 'green'),
    quotaSummaryRow('HTTP / 转发端口', usage.ports || 0, limits.ports, formatLimit, 'amber'),
  );
  $('#screenSiteTable').replaceChildren(...state.sites.slice(0, 8).map(site => siteRow(site, false)));
  $('#screenSitesEmpty').classList.toggle('hidden', state.sites.length !== 0);
  renderAccountProfile();
}

const collectTrafficPoints = collectMonitorPoints;

function drawTrafficChart(canvasSelector, emptySelector, sourcePoints = state.trafficPoints) {
  const canvas = $(canvasSelector); if (!canvas) return;
  const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d'); context.scale(ratio, ratio);
  const width = rect.width; const height = rect.height; const pad = { left: 54, right: 18, top: 18, bottom: 34 };
  context.clearRect(0, 0, width, height); context.font = '11px system-ui, sans-serif'; context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + (height - pad.top - pad.bottom) * index / 4;
    context.strokeStyle = '#e8eef6'; context.setLineDash([4, 4]); context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
  }
  const points = sourcePoints.filter(point => Number.isFinite(point.value)); $(emptySelector).classList.toggle('hidden', points.length !== 0);
  if (!points.length) return;
  const maximum = Math.max(...points.map(point => point.value), 1); context.setLineDash([]);
  const monitorMetric = canvasSelector === '#monitorChart' ? ($('#monitorForm')?.elements.metric.value || '') : 'traffic';
  const axisValue = value => {
    if (monitorMetric.includes('traffic')) return formatBytes(value);
    if (monitorMetric.includes('bandwidth')) return formatMonitorBandwidth(value);
    if (monitorMetric.includes('resp-time')) return `${(value * 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ms`;
    return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  };
  context.fillStyle = '#8c9ab0'; context.textAlign = 'right';
  for (let index = 0; index <= 4; index += 1) context.fillText(axisValue(maximum * (4 - index) / 4), pad.left - 9, pad.top + (height - pad.top - pad.bottom) * index / 4 + 4);
  const innerWidth = width - pad.left - pad.right; const innerHeight = height - pad.top - pad.bottom;
  const coords = points.map((point, index) => ({ x: pad.left + (points.length === 1 ? innerWidth / 2 : innerWidth * index / (points.length - 1)), y: pad.top + innerHeight * (1 - point.value / maximum), point }));
  const gradient = context.createLinearGradient(0, pad.top, 0, height - pad.bottom); gradient.addColorStop(0, 'rgba(22,119,255,.22)'); gradient.addColorStop(1, 'rgba(22,119,255,0)');
  context.beginPath(); context.moveTo(coords[0].x, height - pad.bottom); coords.forEach(item => context.lineTo(item.x, item.y)); context.lineTo(coords.at(-1).x, height - pad.bottom); context.closePath(); context.fillStyle = gradient; context.fill();
  context.beginPath(); coords.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y)); context.strokeStyle = '#1677ff'; context.lineWidth = 2; context.stroke();
  context.fillStyle = '#718097'; context.textAlign = 'center'; const labels = [coords[0], coords[Math.floor((coords.length - 1) / 2)], coords.at(-1)];
  for (const item of labels) context.fillText(formatMonitorChartLabel(item.point.label), item.x, height - 10);
}

function drawTrafficCharts() {
  drawTrafficChart('#trafficChart', '#chartEmpty');
  drawTrafficChart('#dataOverviewChart', '#dataOverviewEmpty');
}

async function loadOverviewData() {
  if (!state.me || state.me.user.role !== 'user') return;
  const orders = api('/api/cdnfly/v1/orders').then(response => { state.billingOrders = extractItems(response.data); }).catch(() => { state.billingOrders = []; });
  let monitor = Promise.resolve();
  if (state.sites.length) {
    const end = new Date(); const start = new Date(end.getTime() - 24 * 60 * 60_000);
    const local = value => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const query = new URLSearchParams({ type: 'traffic', start: local(start), end: local(end) });
    monitor = api(`/api/cdnfly/v1/monitor/site/overview?${query}`).then(response => {
      state.trafficPoints = collectTrafficPoints(response.data);
      for (const selector of ['#chartEmpty', '#dataOverviewEmpty']) $(selector).textContent = '当前 24 小时暂无流量数据';
    }).catch(() => {
      state.trafficPoints = [];
      for (const selector of ['#chartEmpty', '#dataOverviewEmpty']) $(selector).textContent = '流量趋势暂时无法加载';
    });
  } else state.trafficPoints = [];
  await Promise.all([orders, monitor, loadServiceStatus()]);
  const updated = `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())}`;
  $('#trafficChartUpdated').textContent = updated; $('#dataOverviewUpdated').textContent = updated;
  renderOverview(); drawTrafficCharts();
}

async function loadServiceStatus() {
  const top = $('#apiStatus'); const overview = $('#welcomeServiceStatus');
  if (!top || !state.me) return;
  top.className = 'pending'; top.innerHTML = '<i></i>检测中'; overview.textContent = '检测中';
  try {
    const endpoint = state.me.user.role === 'admin' ? '/api/admin/health' : '/api/service-status';
    const result = await api(endpoint); const status = result.status || (result.ok ? 'healthy' : 'unhealthy');
    const healthy = status === 'healthy'; const degraded = status === 'degraded';
    top.className = healthy ? 'healthy' : degraded ? 'warning' : 'error'; top.innerHTML = `<i></i>${healthy ? '正常' : degraded ? '部分降级' : '部分异常'}`;
    overview.textContent = healthy ? '服务正常' : degraded ? '部分降级' : '部分异常'; overview.className = healthy ? 'success-text' : degraded ? 'warning-text' : 'danger-text';
  } catch {
    top.className = 'pending'; top.innerHTML = '<i></i>状态未知'; overview.textContent = '状态未知'; overview.className = '';
  }
  if (!serviceStatusTimer) serviceStatusTimer = setInterval(() => { if (state.me) loadServiceStatus().catch(() => {}); }, 30_000);
}

function renderSites() {
  const query = ($('#siteSearch')?.value || '').trim().toLowerCase();
  const type = $('#siteSearchType')?.value || 'all';
  const filtered = state.sites.filter(site => {
    const fields = { domain: site.domain || '', origin: site.origin || '', cname: site.cname || '' };
    return type === 'all' ? Object.values(fields).some(value => value.toLowerCase().includes(query)) : fields[type].toLowerCase().includes(query);
  });
  const availableIds = new Set(state.sites.map(site => site.id));
  for (const id of state.selectedSites) if (!availableIds.has(id)) state.selectedSites.delete(id);
  const table = $('#siteTable'); table.replaceChildren(...filtered.map(site => siteRow(site)));
  $('#recentSites').replaceChildren(...state.sites.slice(0, 5).map(site => siteRow(site, false)));
  $('#siteCount').textContent = `${filtered.length} 个网站`;
  $('#sitesEmpty').classList.toggle('hidden', filtered.length !== 0);
  $('#overviewEmpty').classList.toggle('hidden', state.sites.length !== 0);
  updateSiteSelectionControls(filtered);
  renderOverview();
}

function updateSiteSelectionControls(visible = state.sites) {
  const selected = state.selectedSites.size;
  const selectable = visible.map(site => site.id);
  const all = $('#selectAllSites');
  if (all) {
    all.checked = selectable.length > 0 && selectable.every(id => state.selectedSites.has(id));
    all.indeterminate = selectable.some(id => state.selectedSites.has(id)) && !all.checked;
  }
  for (const selector of ['#siteBulkEdit', '#siteBulkEnable', '#siteBulkDisable', '#siteBulkDelete', '#siteApplyCert']) $(selector).disabled = selected === 0;
  const label = $('#siteSelectionCount');
  label.textContent = `已选择 ${selected} 项`; label.classList.toggle('hidden', selected === 0);
}

async function loadSites() {
  const [sites, groups] = await Promise.all([
    api('/api/sites'),
    api('/api/cdnfly/v1/site-groups').catch(() => ({ data: [] })),
  ]);
  state.sites = sites.sites;
  state.siteGroups = extractItems(groups.data);
  fillSiteGroupSelects();
  renderSites();
}

function fillSiteGroupSelects() {
  for (const select of [$('#siteForm')?.elements.groupId, $('#siteDetailForm')?.elements.groupId]) {
    if (!select) continue;
    const current = select.value;
    fillResourceOptions(select, state.siteGroups, current, '不分组');
  }
}

function setAdminBillingTab(tab) {
  $$('#adminBillingTabs button').forEach(item => item.classList.toggle('active', item.dataset.billingTab === tab));
  $$('.billing-admin-pane').forEach(pane => pane.classList.toggle('active', pane.dataset.billingPane === tab));
  const titles = { plans: '套餐目录', groups: '套餐分组', upgrades: '增值项管理', traffic: '流量包管理', codes: '权益兑换码', wallets: '客户余额', recharge: '余额充值码', subscriptions: '客户套餐', orders: '订单记录', reports: '财务报表', usage: '客户用量' };
  const section = tab === 'usage' ? 'operations' : ['wallets', 'recharge', 'orders', 'reports'].includes(tab) ? 'finance' : 'package';
  $$('[data-admin-billing-summary]').forEach(summary => summary.classList.toggle('hidden', summary.dataset.adminBillingSummary !== section));
  $('#billing-admin > .section-head h3').textContent = titles[tab] || '套餐管理';
  $('#billing-admin > .section-head p').textContent = section === 'finance' ? '管理客户余额、充值码和即时支付订单' : section === 'operations' ? '查看客户资源消耗并执行套餐限额' : '维护套餐商品、权益与客户订阅';
}

function setTenantBillingPane(target = 'current') {
  if (target === 'orders') target = 'wallet';
  state.billingTarget = target;
  $$('.tenant-billing-pane').forEach(pane => pane.classList.toggle('hidden', !pane.dataset.tenantBillingPane.split(',').includes(target)));
  $('#billingWarning').style.display = ['current', 'usage'].includes(target) ? '' : 'none';
  const descriptions = {
    current: '查看当前套餐、兑换权益和可购买套餐',
    addons: '购买当前套餐可使用的增值项与流量包',
    usage: '查看本计费周期的域名、流量和端口用量',
    wallet: '查看余额、充值、消费订单和兑换记录',
  };
  const titles = { current: '我的套餐', addons: '流量包', usage: '用量查询', wallet: '余额中心' };
  $('#billingPageTitle').textContent = titles[target] || titles.current;
  $('#billingPageSubtitle').textContent = descriptions[target] || descriptions.current;
}

function setAccountSection(section = 'profile') {
  state.accountSection = section;
  const apiMode = section === 'api-keys' && state.me?.user.role === 'user';
  $('#accountPageTitle').textContent = apiMode ? 'API 密钥' : '个人资料';
  $('#accountPageSubtitle').textContent = apiMode ? '创建和撤销用于自动化调用 API 的访问密钥' : '管理个人资料、登录凭据与账户安全';
  for (const selector of ['.profile-panel', '.account-settings-grid', '.account-wide', '.danger-zone']) {
    const element = $(selector, $('#account')); if (element) element.classList.toggle('hidden', apiMode);
  }
  $('#apiKeyPanel')?.classList.toggle('hidden', !apiMode);
}

function replaceMetricLabel(selector, label) {
  const element = $(selector); if (element?.firstChild) element.firstChild.textContent = label;
}

function syncDataPageContext(button = null) {
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

function showView(name, activeButton = null) {
  state.currentView = name;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === name));
  if (name === 'sites') {
    $('#siteAnalysisPane').classList.add('hidden'); $('#siteListPane').classList.remove('hidden');
    $$('[data-site-workbench], #siteAnalysisEntry').forEach(item => item.classList.toggle('active', item.dataset.siteWorkbench === 'list'));
  }
  syncWorkbenchLayout();
  const selected = activeButton || $(`#nav [data-view="${name}"]`);
  $$('#nav [data-view]').forEach(button => button.classList.toggle('active', button === selected));
  $$('.nav-cluster').forEach(cluster => cluster.classList.toggle('active-parent', Boolean(selected && cluster.contains(selected))));
  if (selected) selected.closest('.nav-cluster')?.classList.add('open');
  const names = { overview: '控制台', 'tenant-dashboard': '数据大屏', sites: '网站列表', security: '安全策略', data: '转发与数据', billing: '套餐中心', 'admin-overview': '管理控制台', users: '客户管理', 'admin-sites': '站点管理', 'admin-streams': '四层转发', 'billing-admin': '套餐与交易', upstreams: '上游管理', administrators: '管理员', invitations: '邀请码', audit: '审计日志', 'system-health': '系统状态', 'runtime-settings': '运行参数', account: '账户设置' };
  const title = selected?.dataset.title || names[name];
  $('#pageTitle').textContent = title;
  $('#breadcrumb').textContent = `${state.me?.user.role === 'admin' ? '运营后台' : '用户中心'} / ${title}`;
  renderAnnouncement();
  $('.sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'instant' });
  const loaders = {
    users: loadUsers, audit: loadAudit, upstreams: loadUpstreams, 'system-health': loadSystemHealth, 'runtime-settings': loadRuntimeSettings,
    administrators: loadAdministrators, invitations: loadInvitations,
    security: loadResources, data: loadDataPane,
    billing: loadBilling, 'billing-admin': loadBillingAdmin, 'admin-sites': loadAdminSites, 'admin-streams': loadAdminStreams,
  };
  if (loaders[name]) loadViewState(name, loaders[name]);
  if (['overview', 'tenant-dashboard'].includes(name)) requestAnimationFrame(drawTrafficCharts);
  if (name === 'admin-overview') renderAdminOverview();
  if (name === 'account') { setAccountSection(selected?.dataset.accountSection || 'profile'); renderAccountProfile(); loadAccountSecurity().catch(handleError); }
}

function navigateFromButton(button) {
  if (button.dataset.kind) {
    state.resourceKind = button.dataset.kind;
  }
  if (button.dataset.dataTab) {
    state.dataTab = button.dataset.dataTab;
    $$('#dataTabs button').forEach(item => item.classList.toggle('active', item.dataset.dataTab === state.dataTab));
    $$('.data-pane', $('#data')).forEach(pane => pane.classList.toggle('active', pane.id === `data${state.dataTab[0].toUpperCase()}${state.dataTab.slice(1)}`));
  }
  if (button.dataset.streamKind) {
    state.streamKind = button.dataset.streamKind;
    state.selectedStreams.clear();
    $$('[data-stream-kind]', $('#data')).forEach(item => item.classList.toggle('active', item.dataset.streamKind === state.streamKind));
    syncStreamPaneContext();
  }
  if (button.dataset.monitorEndpoint) {
    setMonitorContext(button.dataset.monitorContext || state.monitorContext, button.dataset.monitorEndpoint, { autoQuery: false });
  } else if (button.dataset.monitorContext) {
    setMonitorContext(button.dataset.monitorContext, null, { autoQuery: false });
  }
  if (button.dataset.configType) {
    setUserConfigType(button.dataset.configType);
  }
  if (button.dataset.adminBillingTab) setAdminBillingTab(button.dataset.adminBillingTab);
  if (button.dataset.billingTarget) setTenantBillingPane(button.dataset.billingTarget);
  if (button.dataset.view === 'account') setAccountSection(button.dataset.accountSection || 'profile');
  if (button.dataset.view === 'security') {
    syncResourcePageContext();
  }
  if (button.dataset.view === 'data') {
    syncDataPageContext(button);
  }
  if (button.dataset.view === 'billing') setTenantBillingPane(button.dataset.billingTarget || state.billingTarget);
  showView(button.dataset.view, button);
}

function navigateToUserConfigs(type, activeButton = null) {
  state.dataTab = 'configs';
  $$('#dataTabs button').forEach(item => item.classList.toggle('active', item.dataset.dataTab === 'configs'));
  $$('.data-pane', $('#data')).forEach(pane => pane.classList.toggle('active', pane.id === 'dataConfigs'));
  setUserConfigType(type); syncDataPageContext(); showView('data', activeButton);
  const title = `${({ site: '网站', stream: '四层转发', cert: '证书' })[type] || '用户'}默认设置`;
  $('#pageTitle').textContent = title; $('#breadcrumb').textContent = `用户中心 / ${title}`;
}

async function userDefaultValues(type, groupId = 0) {
  const response = await api(`/api/cdnfly/v1/user-configs?type=${encodeURIComponent(type)}&limit=0`);
  const rows = extractItems(response.data).filter(item => item.enable && (item.scope_name === 'global'
    || (item.scope_name === 'group' && Number(item.scope_id) === Number(groupId))));
  rows.sort((a, b) => Number(a.scope_name === 'group') - Number(b.scope_name === 'group'));
  return Object.fromEntries(rows.map(item => [item.name, item.value]));
}

async function applySiteDialogDefaults() {
  const form = $('#siteForm');
  if (form.elements.siteId.value) return;
  const defaults = await userDefaultValues('site', Number(form.elements.groupId.value || 0));
  if (defaults.backend_protocol) form.elements.backendProtocol.value = defaults.backend_protocol;
  if (defaults.websocket_enable !== undefined) form.elements.websocket.checked = enabledValue(defaults.websocket_enable);
  if (defaults.gzip_enable !== undefined) form.elements.gzip.checked = enabledValue(defaults.gzip_enable);
}

async function openSiteDialog(site = null) {
  const form = $('#siteForm'); form.reset();
  form.siteId.value = site?.id || '';
  form.domain.value = site?.domain || '';
  form.domain.disabled = Boolean(site);
  form.origin.value = site?.origin || '';
  form.backendProtocol.value = site?.backendProtocol || 'http';
  form.backendHost.value = site?.backendHost || site?.domain || '';
  form.websocket.checked = Boolean(site?.websocket);
  form.gzip.checked = Boolean(site?.gzip);
  fillResourceOptions(form.elements.groupId, state.siteGroups, site?.groupId, '不分组');
  fillSubscriptionSelect(form.elements.subscriptionId, site?.subscriptionId);
  if (!site) await applySiteDialogDefaults();
  $('#siteDialogTitle').textContent = site ? `配置 ${site.domain}` : '添加网站';
  $('#siteDialog').showModal();
}

function enabledValue(value) { return [1, true, '1', 'true', 'on'].includes(value); }

function setTlsProtocols(form, value, name = 'sslProtocol') {
  const selected = new Set((Array.isArray(value) ? value : String(value || 'TLSv1.2 TLSv1.3').split(/[\s,]+/)).filter(Boolean));
  const inputs = $$(`input[name="${name}"]`, form);
  inputs.forEach(input => { input.checked = selected.has(input.value); });
  if (!inputs.some(input => input.checked)) inputs.forEach(input => { input.checked = true; });
}

function selectedTlsProtocols(form, name = 'sslProtocol') {
  return $$(`input[name="${name}"]:checked`, form).map(input => input.value);
}

function extractSiteCname(upstream, fallback = '') {
  const previous = normalizeSiteCname(fallback);
  const complete = value => {
    const normalized = normalizeSiteCname(value);
    return normalized && normalized.includes('.') && !/^\d+(?:\.\d+)*$/.test(normalized) ? normalized : '';
  };
  const prefer = value => {
    const normalized = complete(value);
    return previous && normalized && previous !== normalized && previous.endsWith(`.${normalized}`) ? previous : normalized;
  };
  const visit = value => {
    if (typeof value === 'string') return prefer(value) || previous;
    if (!value || typeof value !== 'object') return '';
    const suffix = complete(value.cname_domain ?? value.cnameDomain ?? value.cname_suffix ?? value.cnameSuffix);
    const hostname = normalizeSiteCname(value.cname_hostname ?? value.cnameHostname);
    for (const key of ['cname_full', 'cnameFull', 'cname_fqdn', 'cnameFqdn', 'cname_record', 'cnameRecord', 'cname_target', 'cnameTarget']) {
      if (complete(value[key])) return prefer(value[key]);
    }
    if (typeof value.cname === 'string') {
      const rawCname = normalizeSiteCname(value.cname);
      const candidate = complete(rawCname);
      if (candidate && !(hostname && suffix && candidate === suffix)) return prefer(candidate);
      if (rawCname && suffix && rawCname !== suffix) return `${rawCname}.${suffix}`;
    }
    if (value.cname && typeof value.cname === 'object') {
      const nested = value.cname;
      const host = normalizeSiteCname(nested.hostname ?? nested.host ?? nested.cname_hostname ?? nested.cnameHostname ?? nested.target);
      const domain = complete(nested.domain ?? nested.suffix ?? nested.cname_domain ?? nested.cnameDomain) || suffix;
      if (complete(host)) return prefer(host);
      if (host && domain) return `${host}.${domain}`;
    }
    if (complete(hostname)) return prefer(hostname);
    if (hostname && suffix) return `${hostname}.${suffix}`;
    for (const key of ['data', 'result', 'site', 'item', 'record', 'payload']) {
      const found = visit(value[key]);
      if (found) return found;
    }
    return previous;
  };
  return visit(upstream) || previous;
}

function normalizeSiteCname(value) {
  const text = String(value || '').trim().replace(/\.$/, '').replace(/\/$/, '');
  if (!text) return '';
  try { return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname.replace(/\.$/, ''); }
  catch { return text.split('/')[0].replace(/\.$/, ''); }
}

function addSiteBackendRow(value = {}) {
  const row = document.createElement('div'); row.className = 'rule-row site-backend-row'; row.originalValue = value;
  row.innerHTML = '<label>源站地址<input data-field="addr" required placeholder="IP 或域名"></label><label>权重<input data-field="weight" type="number" min="1" max="1000" value="1"></label><label>状态<select data-field="state"><option value="up">上线</option><option value="down">下线</option><option value="backup">备用</option></select></label><button type="button" class="icon-button danger" data-remove-site-row aria-label="删除源站">×</button>';
  const stateValue = String(value.state ?? 'up').toLowerCase(); const normalizedState = ['backup', 'standby'].includes(stateValue) ? 'backup' : ['down', 'offline', 'disabled', '0', 'false'].includes(stateValue) ? 'down' : 'up';
  $('[data-field="addr"]', row).value = value.addr || ''; $('[data-field="weight"]', row).value = value.weight || 1; $('[data-field="state"]', row).value = normalizedState;
  $('#siteBackendList').append(row);
}

const siteCacheUnitAliases = new Map([
  ['s', 's'], ['second', 's'], ['seconds', 's'],
  ['m', 'm'], ['minute', 'm'], ['minutes', 'm'],
  ['h', 'h'], ['hour', 'h'], ['hours', 'h'],
  ['d', 'd'], ['day', 'd'], ['days', 'd'],
]);

function normalizeSiteCacheUnit(value) {
  return siteCacheUnitAliases.get(String(value || '').trim().toLowerCase()) || 'h';
}

function normalizeSiteCacheType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'dir' || type === 'prefix' || type === 'all') return 'dir';
  if (type === 'full_path' || type === 'fullpath') return 'full_path';
  return 'suffix';
}

function addSiteCacheRuleRow(value = {}) {
  const row = document.createElement('div'); row.className = 'config-rule-card site-cache-row'; row.originalValue = value;
  row.innerHTML = '<div class="cache-rule-main"><label>类型<select data-field="type"><option value="suffix">后缀名</option><option value="dir">目录</option><option value="full_path">完整路径</option></select></label><label>内容<input data-field="content" placeholder="css|js|png 或 /static/"></label><label>有效期<input data-field="expire" type="number" min="0" value="1"></label><label>单位<select data-field="unit"><option value="s">秒</option><option value="m">分钟</option><option value="h">小时</option><option value="d">天</option></select></label><label class="switch-inline"><span>忽略参数</span><input data-field="ignore_arg" type="checkbox"></label><label class="switch-inline"><span>强制缓存</span><input data-field="force_cache" type="checkbox"></label><button type="button" class="icon-button danger" data-remove-site-row aria-label="删除缓存规则">×</button></div><div class="cache-exclusion"><div class="cache-exclusion-head"><span>不缓存条件</span><button type="button" class="secondary" data-add-no-cache>＋ 添加条件</button></div><div class="cache-exclusion-list"></div></div>';
  $('[data-field="type"]', row).value = normalizeSiteCacheType(value.type); $('[data-field="content"]', row).value = value.content || (value.type === 'all' ? '/' : ''); $('[data-field="expire"]', row).value = value.expire ?? 1; $('[data-field="unit"]', row).value = normalizeSiteCacheUnit(value.unit); $('[data-field="ignore_arg"]', row).checked = enabledValue(value.ignore_arg); $('[data-field="force_cache"]', row).checked = Boolean(String(value.proxy_ignore_headers || '').trim());
  (Array.isArray(value.no_cache) ? value.no_cache : []).forEach(condition => addSiteNoCacheRow(row, condition));
  $('#siteCacheRuleList').append(row);
}

function addSiteNoCacheRow(cacheRow, value = {}) {
  const row = document.createElement('div'); row.className = 'cache-exclusion-row'; row.originalValue = value;
  row.innerHTML = '<label>变量<input data-field="variable" placeholder="$request_uri"></label><label>匹配字符串<input data-field="string" placeholder="/api/"></label><button type="button" class="icon-button danger" data-remove-no-cache aria-label="删除不缓存条件">×</button>';
  $('[data-field="variable"]', row).value = value.variable || ''; $('[data-field="string"]', row).value = value.string || '';
  $('.cache-exclusion-list', cacheRow).append(row);
}

function addSiteHeaderRow(containerId, value = {}) {
  const row = document.createElement('div'); row.className = 'rule-row site-header-row'; row.originalValue = value;
  row.innerHTML = '<label>Header 名称<input data-field="name" placeholder="X-Header-Name"></label><label>Header 值<input data-field="value" placeholder="Header value"></label><button type="button" class="icon-button danger" data-remove-site-row aria-label="删除 Header">×</button>';
  $('[data-field="name"]', row).value = value.name || ''; $('[data-field="value"]', row).value = value.value || '';
  $(`#${containerId}`).append(row);
}

function addSiteRewriteRow(value = {}) {
  const row = document.createElement('div'); row.className = 'rule-row site-rewrite-row'; row.originalValue = value;
  row.innerHTML = '<label>域名端口<input data-field="host" placeholder=".*"></label><label>匹配 URL<input data-field="match" placeholder="(.*)"></label><label>转向到<input data-field="redirect" placeholder="https://example.com$1"></label><label>状态码<select data-field="code"><option value="301">301</option><option value="302">302</option><option value="307">307</option><option value="308">308</option></select></label><button type="button" class="icon-button danger" data-remove-site-row aria-label="删除 URL 转向">×</button>';
  $('[data-field="host"]', row).value = value.host || '.*'; $('[data-field="match"]', row).value = value.match || '(.*)'; $('[data-field="redirect"]', row).value = value.redirect || ''; $('[data-field="code"]', row).value = String(value.code || '301');
  $('#siteRewriteList').append(row);
}

const siteSectionDetails = {
  siteBasic: '基础设置', siteHttp: 'HTTP 设置', siteOrigin: '回源设置', siteHttps: 'HTTPS 设置',
  siteCache: '缓存设置', siteSecurity: '安全配置', siteAccess: '访问控制', siteAdvanced: '高级配置',
};

function activateSiteSection(sectionId = 'siteBasic') {
  if (!siteSectionDetails[sectionId]) sectionId = 'siteBasic';
  state.currentSiteSection = sectionId;
  $$('[data-site-section]').forEach(button => { const active = button.dataset.siteSection === sectionId; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
  $$('.detail-section', $('#siteDetailForm')).forEach(section => section.classList.toggle('active', section.id === sectionId));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSiteDetail(site, config = state.currentSiteConfig || {}) {
  state.currentSite = site; state.currentSiteConfig = config; const form = $('#siteDetailForm');
  const https = config.https_listen || {}; const http = config.http_listen || {}; const hotlink = config.hotlink || {}; const cors = config.cors || {}; const health = config.health_check || {}; const ccSwitch = config.cc_switch || {};
  const cname = extractSiteCname(config, site.cname);
  $('#detailSiteId').textContent = `ID: ${site.id}`; $('#detailSiteDomain').textContent = site.domain; $('#detailSiteCname').textContent = cname || '等待 CDN 服务分配 CNAME';
  $('#detailSiteCreated').textContent = formatDate(site.createdAt); $('#detailSitePlan').textContent = site.planName || '未绑定';
  const backends = Array.isArray(config.backend) && config.backend.length ? config.backend : (site.origin ? [{ addr: site.origin, weight: 1, state: 'up' }] : []);
  const httpsEnabled = enabledValue(https.ok ?? https.enable ?? Boolean(https.cert));
  $('#detailSiteOriginSummary').textContent = backends.length ? `${backends.length} 个` : '未配置';
  $('#detailSiteHttps').textContent = httpsEnabled ? `已启用 · ${https.port || '443'}` : '未启用';
  $('#detailSiteState').outerHTML = badge(site).replace('<span', '<b id="detailSiteState"').replace('</span>', '</b>');
  form.elements.domain.value = site.domain; form.elements.cname.value = cname;
  fillResourceOptions(form.elements.groupId, state.siteGroups, site.groupId, '不分组');
  form.elements.backendProtocol.value = config.backend_protocol || site.backendProtocol || 'http'; form.elements.balanceWay.value = config.balance_way || 'rr'; form.elements.backendHttpPort.value = config.backend_http_port || '80'; form.elements.backendHttpsPort.value = config.backend_https_port || '443'; form.elements.backendHost.value = config.backend_host || site.backendHost || site.domain;
  form.elements.proxyTimeout.value = config.proxy_timeout || ''; form.elements.proxyHttpVersion.value = String(config.proxy_http_version || '1.1'); setTlsProtocols(form, config.proxy_ssl_protocols, 'proxySslProtocol');
  form.elements.backendPortMapping.checked = enabledValue(config.backend_port_mapping); form.elements.keepalive.checked = enabledValue(config.ups_keepalive); form.elements.keepaliveConnections.value = config.ups_keepalive_conn ?? ''; form.elements.keepaliveTimeout.value = config.ups_keepalive_timeout ?? '';
  form.elements.enabled.checked = Boolean(site.enabled); form.elements.websocket.checked = Boolean(site.websocket); form.elements.gzip.checked = Boolean(site.gzip);
  fillSubscriptionSelect(form.elements.subscriptionId, site.subscriptionId);
  $('#siteBackendList').replaceChildren(); backends.forEach(addSiteBackendRow); if (!backends.length) addSiteBackendRow();
  fillResourceOptions(form.elements.httpsCert, state.siteCertificates, https.cert, '不使用证书');
  form.elements.httpPorts.value = http.port || '80'; form.elements.httpsPorts.value = https.port || '443'; setTlsProtocols(form, https.ssl_protocols); form.elements.forceSslPort.value = https.force_ssl_port || '443'; form.elements.sslCiphers.value = https.ssl_ciphers || DEFAULT_SSL_CIPHERS;
  form.elements.httpEnabled.checked = http.enable === undefined ? true : enabledValue(http.enable); form.elements.httpsEnabled.checked = httpsEnabled; form.elements.forceSsl.checked = enabledValue(https.force_ssl_enable); form.elements.http2.checked = enabledValue(https.http2); form.elements.http3.checked = enabledValue(https.http3); form.elements.hsts.checked = enabledValue(https.hsts); form.elements.ocspStapling.checked = enabledValue(https.ocsp_stapling); form.elements.sslPreferServerCiphers.checked = enabledValue(https.ssl_prefer_server_ciphers);
  $('#siteCacheRuleList').replaceChildren(); (Array.isArray(config.proxy_cache) ? config.proxy_cache : []).forEach(addSiteCacheRuleRow);
  fillResourceOptions(form.elements.ccDefaultRule, state.siteCcRules, config.cc_default_rule, '不绑定'); fillResourceOptions(form.elements.ccSwitchRule, state.siteCcRules, ccSwitch.rule, '不绑定'); fillResourceOptions(form.elements.acl, state.siteAcls, config.acl?.id ?? config.acl, '不绑定');
  form.elements.ccSwitchEnabled.checked = enabledValue(ccSwitch.enable); form.elements.ccSwitchThreshold.value = ccSwitch.switch ?? ''; form.elements.blockProxy.checked = enabledValue(config.block_proxy);
  form.elements.blackIp.value = config.black_ip || ''; form.elements.whiteIp.value = config.white_ip || ''; form.elements.blockRegion.value = config.block_region || '';
  form.elements.hotlinkEnabled.checked = enabledValue(hotlink.enable); form.elements.hotlinkDomains.value = hotlink.domain || ''; form.elements.hotlinkAllowEmpty.checked = enabledValue(hotlink.allow_empty); form.elements.hotlinkScopeContent.value = hotlink.scope_content || '';
  form.elements.corsEnabled.checked = enabledValue(cors.enable); form.elements.corsOrigin.value = cors.allow_origin || ''; form.elements.corsMethods.value = cors.allow_methods || ''; form.elements.corsHeaders.value = cors.allow_headers || ''; form.elements.corsExposeHeaders.value = cors.expose_headers || ''; form.elements.corsMaxAge.value = cors.max_age || '1728000'; form.elements.corsCredentials.checked = enabledValue(cors.allow_credentials);
  form.elements.websocket.checked = enabledValue(config.websocket_enable ?? site.websocket); form.elements.gzip.checked = enabledValue(config.gzip_enable ?? site.gzip); form.elements.gzipTypes.value = config.gzip_types || ''; form.elements.ipv6.checked = enabledValue(config.enable_ipv6); form.elements.range.checked = enabledValue(config.range);
  const postSizeLimit = String(config.post_size_limit ?? ''); const postSizeMatch = postSizeLimit.match(/^([0-9]+(?:\.[0-9]+)?)([BKMG])$/i);
  form.elements.postSizeLimit.value = postSizeMatch ? postSizeMatch[1] : postSizeLimit; form.elements.postSizeUnit.value = postSizeMatch ? postSizeMatch[2].toUpperCase() : 'M';
  form.elements.spiderToSip.value = config.spider_to_sip || ''; form.elements.recvRealTime.checked = enabledValue(config.recv_real_time); form.elements.sendRealTime.checked = enabledValue(config.send_real_time); form.elements.acmeProxyToOrigin.checked = enabledValue(config.acme_proxy_to_orgin);
  for (const code of ['403', '404', '500', '502', '504']) form.elements[`page${code}`].value = config[`page_${code}`] || '';
  form.elements.healthEnabled.checked = enabledValue(health.enable); form.elements.healthProtocol.value = health.protocol || 'http'; form.elements.healthHost.value = health.host || form.elements.backendHost.value; form.elements.healthPath.value = health.path || '/'; form.elements.healthStatusCode.value = health.status_code || '200 301 302'; form.elements.healthInterval.value = health.interval ?? 5;
  $('#siteRequestHeaderList').replaceChildren(); (Array.isArray(config.req_header) ? config.req_header : []).forEach(value => addSiteHeaderRow('siteRequestHeaderList', value));
  $('#siteResponseHeaderList').replaceChildren(); (Array.isArray(config.resp_header) ? config.resp_header : []).forEach(value => addSiteHeaderRow('siteResponseHeaderList', value));
  $('#siteRewriteList').replaceChildren(); (Array.isArray(config.url_rewrite) ? config.url_rewrite : []).forEach(addSiteRewriteRow);
}

function openSiteDetail(site) {
  state.currentSiteConfig = {}; state.siteCertificates = []; state.siteAcls = []; state.siteCcRules = []; renderSiteDetail(site, {}); activateSiteSection('siteBasic'); showView('site-detail', $('.tenant-nav [data-view="sites"]'));
  $('#pageTitle').textContent = '网站管理'; $('#breadcrumb').textContent = `站点管理 / ${site.domain}`;
}

async function refreshSiteDetail() {
  const [response, certResponse, aclResponse, ccResponse] = await Promise.all([
    api(`/api/cdnfly/v1/sites/${state.currentSite.id}`),
    api('/api/cdnfly/v1/certs').catch(() => ({ data: [] })),
    api('/api/cdnfly/v1/acls').catch(() => ({ data: [] })),
    api('/api/cdnfly/v1/cc-rules').catch(() => ({ data: [] })),
  ]);
  const upstream = response.data || {}; state.siteCertificates = extractItems(certResponse.data); state.siteAcls = extractItems(aclResponse.data); state.siteCcRules = extractItems(ccResponse.data);
  const site = { ...state.currentSite, domain: upstream.domain || state.currentSite.domain, cname: extractSiteCname(upstream, state.currentSite.cname),
    origin: upstream.backend?.[0]?.addr || state.currentSite.origin, backendProtocol: upstream.backend_protocol || state.currentSite.backendProtocol,
    backendHost: upstream.backend_host || state.currentSite.backendHost, websocket: enabledValue(upstream.websocket_enable ?? state.currentSite.websocket),
    gzip: enabledValue(upstream.gzip_enable ?? state.currentSite.gzip), enabled: upstream.enable === undefined ? state.currentSite.enabled : enabledValue(upstream.enable),
    subscriptionId: upstream.subscription_id || state.currentSite.subscriptionId, planName: upstream.plan_name || state.currentSite.planName,
    groupId: upstream.group_id ?? state.currentSite.groupId };
  renderSiteDetail(site, upstream);
}

async function loadUsers(page = state.pageInfo.customers?.page || 1) {
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

function renderQuotaItem(label, used, limit, formatter) {
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

function renderTenantBilling() {
  const billing = state.me.billing || { plan: null, subscription: null, limits: {}, usage: {}, reasons: [] };
  const subscriptions = billing.subscriptions || [];
  $('#walletBalance').textContent = formatMoney(state.wallet.availableBalanceCents ?? state.wallet.balanceCents);
  $('#walletRecharge').textContent = formatMoney(state.wallet.totalRechargeCents);
  $('#walletSpent').textContent = formatMoney(state.wallet.totalSpentCents);
  $('#walletTransactionTable').replaceChildren(...state.wallet.transactions.map(transaction => {
    const tr = document.createElement('tr'); const credit = transaction.direction === 'credit';
    tr.innerHTML = '<td></td><td><strong></strong></td><td></td><td></td><td></td>';
    tr.children[0].textContent = formatDate(transaction.createdAt); $('strong', tr).textContent = transaction.description || '余额变动';
    tr.children[2].textContent = credit ? '入账' : '支出'; tr.children[3].textContent = `${credit ? '+' : '-'}${formatMoney(transaction.amountCents)}`;
    tr.children[3].className = credit ? 'success-text' : 'danger-text'; tr.children[4].textContent = formatMoney(transaction.balanceAfterCents); return tr;
  }));
  $('#walletTransactionsEmpty').classList.toggle('hidden', state.wallet.transactions.length !== 0);
  $('#currentPlanName').textContent = subscriptions.length > 1 ? '全部套餐资源汇总' : billing.plan?.name || '未分配套餐';
  $('#currentPlanPeriod').textContent = subscriptions.length > 1 ? `共 ${subscriptions.length} 个有效套餐实例，资源分别计费` : billing.subscription ? `${formatDate(billing.subscription.startsAt)} 至 ${formatDate(billing.subscription.endsAt)}` : '购买套餐后即可分配资源';
  $('#currentPlanStatus').outerHTML = billing.subscription ? statusBadge(billing.subscription.status) : '<span id="currentPlanStatus" class="badge off">未生效</span>';
  const currentStatus = $('.billing-current .panel-head .badge'); if (currentStatus) currentStatus.id = 'currentPlanStatus';
  $('#quotaGrid').replaceChildren(
    renderQuotaItem('加速域名', billing.usage.domains || 0, billing.limits.domains, formatLimit),
    renderQuotaItem('月流量', billing.usage.trafficBytes || 0, billing.limits.trafficBytes, formatBytes),
    renderQuotaItem('HTTP / 转发端口', billing.usage.ports || 0, billing.limits.ports, formatLimit),
  );
  const warning = $('#billingWarning'); warning.classList.toggle('hidden', !subscriptions.length || !billing.overLimit);
  warning.textContent = subscriptions.length && billing.overLimit ? `资源已超限：${billing.reasons.join('；')}。本账户正在运行的网站与四层转发将保持暂停，额度恢复后自动恢复。` : '';

  $('#subscriptionCards').replaceChildren(...subscriptions.map(item => {
    const card = document.createElement('article'); card.className = 'subscription-card';
    card.innerHTML = `<header><div><h4></h4><small></small></div>${statusBadge(item.subscription.status)}</header><dl><dt>有效期</dt><dd></dd><dt>绑定资源</dt><dd></dd><dt>加速域名</dt><dd></dd><dt>月流量</dt><dd></dd><dt>HTTP / 转发端口</dt><dd></dd></dl><footer><label class="auto-renew-toggle"><input type="checkbox" data-auto-renew="${item.subscription.id}"><span>自动续费</span></label><div class="subscription-actions"><button class="secondary" data-change-subscription="${item.subscription.id}">升降配</button><button class="secondary" data-renew-subscription="${item.subscription.id}">立即续费</button></div></footer>`;
    $('h4', card).textContent = item.plan.name; $('header small', card).textContent = `套餐实例 #${item.subscription.id}`;
    const values = $$('dd', card); values[0].textContent = `${formatDate(item.subscription.startsAt)} 至 ${formatDate(item.subscription.endsAt)}`;
    values[1].textContent = `${item.resources.sites} 个网站 / ${item.resources.streams} 个转发`;
    values[2].textContent = `${formatLimit(item.usage.domains)} / ${formatLimit(item.limits.domains)}`;
    values[3].textContent = `${formatBytes(item.usage.trafficBytes)} / ${formatBytes(item.limits.trafficBytes)}`;
    values[4].textContent = `${formatLimit(item.usage.ports)} / ${formatLimit(item.limits.ports)}`;
    $('[data-auto-renew]', card).checked = Boolean(item.subscription.autoRenew);
    return card;
  }));
  if (!subscriptions.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.innerHTML = '<span>¥</span><h4>暂无有效套餐</h4><p>购买套餐或使用兑换码后即可分配网站和转发</p>';
    $('#subscriptionCards').replaceChildren(empty);
  }

  const addonSelect = $('#addonSubscriptionSelect'); const selectedAddon = addonSelect.value;
  fillSubscriptionSelect(addonSelect, selectedAddon || billing.subscription?.id, subscriptions);
  $('#subscriptionUsageTable').replaceChildren(...subscriptions.map(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${item.overLimit ? '<span class="badge off">已超限</span>' : statusBadge(item.subscription.status)}</td>`;
    $('strong', tr).textContent = item.plan.name; $('small', tr).textContent = `#${item.subscription.id}`;
    tr.children[1].textContent = `${item.resources.sites} 站点 / ${item.resources.streams} 转发`;
    tr.children[2].textContent = `${formatLimit(item.usage.domains)} / ${formatLimit(item.limits.domains)}`;
    tr.children[3].textContent = `${formatBytes(item.usage.trafficBytes)} / ${formatBytes(item.limits.trafficBytes)}`;
    tr.children[4].textContent = `${formatLimit(item.usage.ports)} / ${formatLimit(item.limits.ports)}`;
    return tr;
  }));

  $('#planCatalogTable').replaceChildren(...state.billingPlans.map(plan => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td class="right"><button class="primary" data-buy-plan="${plan.id}">购买</button></td>`;
    $('strong', tr).textContent = plan.name; $('small', tr).textContent = plan.description || plan.code;
    tr.children[1].textContent = `${formatMoney(plan.priceCents)} / ${plan.durationDays} 天`;
    tr.children[2].textContent = formatLimit(plan.domainLimit); tr.children[3].textContent = formatBytes(plan.trafficLimitBytes); tr.children[4].textContent = formatLimit(plan.portLimit);
    return tr;
  }));
  $('#tenantOrderTable').replaceChildren(...state.billingOrders.map(order => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong>#${order.id}</strong></td><td></td><td></td><td>${statusBadge(order.status)}</td><td></td>`;
    tr.children[1].textContent = ({ plan: '套餐', plan_change: '套餐升降配', upgrade: '增值项', traffic: '流量包', recharge: '充值' })[order.type] || order.type;
    tr.children[2].textContent = order.type === 'plan_change' && Number(order.balanceAdjustmentCents) > 0
      ? `+${formatMoney(order.balanceAdjustmentCents)}` : formatMoney(order.amountCents);
    if (order.type === 'plan_change' && Number(order.balanceAdjustmentCents) > 0) tr.children[2].className = 'success-text';
    tr.children[4].textContent = formatDate(order.createdAt); return tr;
  }));
  const subscriptionId = addonSelect.value;
  const addons = [
    ...state.billingUpgrades.map(item => ({ ...item, catalogType: 'upgrade', effect: `域名 +${item.domain_increment} / 流量 +${formatBytes(item.traffic_increment_bytes)} / 端口 +${item.port_increment}` })),
    ...state.billingTraffic.map(item => ({ ...item, catalogType: 'traffic', effect: `${formatBytes(item.traffic_bytes)}，有效 ${item.duration_days} 天` })),
  ];
  $('#addonCatalogTable').replaceChildren(...addons.map(item => {
    const tr = document.createElement('tr'); const action = subscriptionId ? `<button class="primary" data-buy-${item.catalogType}="${item.id}">购买</button>` : '<span class="status-text">请先开通套餐</span>';
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td class="right">${action}</td>`;
    $('strong', tr).textContent = item.name; $('small', tr).textContent = item.description || ''; tr.children[1].textContent = item.catalogType === 'upgrade' ? '增值项' : '流量包'; tr.children[2].textContent = item.effect; tr.children[3].textContent = formatMoney(item.price_cents); return tr;
  }));
  $('#redemptionHistoryTable').replaceChildren(...state.redemptions.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td>';
    $('strong', tr).textContent = item.productName || '历史商品'; $('small', tr).textContent = item.label || ''; tr.children[1].textContent = ({ plan: '套餐', upgrade: '增值项', traffic: '流量包' })[item.type]; tr.children[2].textContent = `****-${item.suffix}`; tr.children[3].textContent = `#${item.orderId}`; tr.children[4].textContent = formatDate(item.redeemedAt); return tr;
  }));
}

function compatiblePlanChangeTargets(subscriptionItem) {
  const current = subscriptionItem.plan;
  return state.billingPlans.filter(plan => Number(plan.id) !== Number(current.id)
    && String(plan.upstreamId ?? '') === String(current.upstreamId ?? '')
    && String(plan.upstreamPackageId ?? '') === String(current.upstreamPackageId ?? ''));
}

async function refreshPlanChangeQuote() {
  const form = $('#planChangeForm'); const subscriptionId = Number(form.elements.subscriptionId.value); const packageId = Number(form.elements.package.value);
  const requestToken = Symbol('plan-change-quote'); state.planChangeRequest = requestToken; state.planChangeQuote = null;
  $('#planChangeSubmit').disabled = true; $('#planChangeQuoteStatus').textContent = '正在计算差价...';
  for (const selector of ['#planChangeRemainDays', '#planChangeCurrentPrice', '#planChangeNewPrice', '#planChangeDiffPrice', '#planChangeBalance']) $(selector).textContent = '-';
  try {
    const response = await api(`/api/cdnfly/v1/user-packages/${subscriptionId}?to_package=${packageId}`);
    if (state.planChangeRequest !== requestToken || !$('#planChangeDialog').open) return;
    const quote = response.data; const diffCents = Number(quote.diff_price_cents); state.planChangeQuote = quote;
    $('#planChangeRemainDays').textContent = `${quote.remain_days} 天`;
    $('#planChangeCurrentPrice').textContent = formatMoney(quote.curr_price_cents);
    $('#planChangeNewPrice').textContent = formatMoney(quote.new_price_cents);
    $('#planChangeDiffPrice').textContent = diffCents > 0 ? `补款 ${formatMoney(diffCents)}` : diffCents < 0 ? `退款 ${formatMoney(Math.abs(diffCents))}` : '无需补款';
    $('#planChangeDiffPrice').className = diffCents < 0 ? 'success-text' : diffCents > 0 ? 'danger-text' : '';
    $('#planChangeBalance').textContent = formatMoney(Number(state.wallet.balanceCents) - diffCents);
    $('#planChangeQuoteStatus').textContent = `${quote.to_package_name} · 到期时间保持不变`;
    $('#planChangeSubmit').disabled = diffCents > Number(state.wallet.balanceCents);
    if ($('#planChangeSubmit').disabled) $('#planChangeQuoteStatus').textContent = '账户余额不足，无法完成本次升配';
  } catch (error) {
    if (state.planChangeRequest === requestToken) $('#planChangeQuoteStatus').textContent = error.message || '差价计算失败';
    throw error;
  }
}

function openPlanChangeDialog(subscriptionId) {
  const item = tenantSubscriptions().find(row => Number(row.subscription.id) === Number(subscriptionId));
  if (!item) return toast('用户套餐不存在或未生效', true);
  const targets = compatiblePlanChangeTargets(item);
  if (!targets.length) return toast('暂无兼容的升降配套餐', true);
  const form = $('#planChangeForm'); form.elements.subscriptionId.value = item.subscription.id;
  form.elements.currentPlan.value = `${item.plan.name} · ${formatMoney(item.plan.priceCents)} / ${item.plan.durationDays} 天`;
  form.elements.package.replaceChildren(...targets.map(plan => {
    const option = document.createElement('option'); option.value = plan.id;
    option.textContent = `${plan.name} · ${formatMoney(plan.priceCents)} / ${plan.durationDays} 天`;
    return option;
  }));
  $('#planChangeTitle').textContent = `${item.plan.name} 升降配`;
  $('#planChangeDialog').showModal(); refreshPlanChangeQuote().catch(handleError);
}

async function loadBilling() {
  const [me, plans, orders, upgrades, traffic, redemptions, wallet] = await Promise.all([api('/api/me'), api('/api/cdnfly/v1/packages'), api('/api/cdnfly/v1/orders'), api('/api/cdnfly/v1/package-ups'), api('/api/cdnfly/v1/traffic-packages'), api('/api/billing/redemptions'), api('/api/billing/wallet')]);
  state.me = me; state.billingPlans = extractItems(plans.data); state.billingOrders = extractItems(orders.data); state.billingUpgrades = extractItems(upgrades.data); state.billingTraffic = extractItems(traffic.data); state.redemptions = redemptions.redemptions; state.wallet = wallet; renderTenantBilling(); renderSites(); renderAccountProfile();
  setTenantBillingPane(state.billingTarget);
}

function renderAdminBilling() {
  const data = state.billingAdmin; const totals = state.adminOverview;
  $('#adminBillingPlans').textContent = totals?.plans.total ?? data.plans.length;
  $('#adminBillingSubscriptions').textContent = totals?.subscriptions.active ?? data.subscriptions.filter(item => item.status === 'active').length;
  $('#adminBillingCodes').textContent = data.codes.filter(item => item.status === 'active').length;
  $('#adminBillingOverLimit').textContent = totals?.overLimitCustomers ?? data.usage.filter(item => item.billing?.overLimit).length;
  const paidOrders = data.orders.filter(item => item.status === 'paid');
  $('#adminFinanceBalance').textContent = formatMoney(totals?.walletLiabilityCents ?? data.wallets.reduce((sum, item) => sum + Number(item.balanceCents || 0), 0));
  $('#adminFinanceRechargeCodes').textContent = totals?.availableRechargeCodes ?? data.rechargeCodes.filter(item => item.status === 'active' && item.usedCount < item.maxUses).length;
  $('#adminFinancePaidOrders').textContent = totals?.orders.paid ?? paidOrders.length;
  $('#adminFinanceRevenue').textContent = formatMoney(totals?.orders.paidAmountCents ?? paidOrders.reduce((sum, item) => sum + orderNetAmountCents(item), 0));
  $('#adminUsageCustomers').textContent = totals?.customers.total ?? data.users.length;
  $('#adminUsageSites').textContent = totals?.sites ?? data.users.reduce((sum, item) => sum + Number(item.siteCount || 0), 0);
  $('#adminUsageSubscriptions').textContent = totals?.subscriptions.active ?? data.subscriptions.filter(item => item.status === 'active').length;
  $('#adminUsageOverLimit').textContent = totals?.overLimitCustomers ?? data.usage.filter(item => item.billing?.overLimit).length;
  $('#adminPlanTable').replaceChildren(...data.plans.map(plan => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${resourceStatus(plan)}</td><td class="right"><span class="row-actions"><button data-edit-plan="${plan.id}">配置</button><button class="danger" data-disable-plan="${plan.id}">停用</button></span></td>`;
    $('td:first-child strong', tr).textContent = plan.name; $('td:first-child small', tr).textContent = plan.code; $('td:nth-child(2) strong', tr).textContent = plan.upstreamName || '未绑定'; $('td:nth-child(2) small', tr).textContent = plan.upstreamPackageName || plan.upstreamPackageId || '-'; tr.children[2].textContent = formatMoney(plan.priceCents); tr.children[3].textContent = formatLimit(plan.domainLimit); tr.children[4].textContent = formatBytes(plan.trafficLimitBytes); tr.children[5].textContent = formatLimit(plan.portLimit); return tr;
  }));
  $('#adminGroupTable').replaceChildren(...data.groups.map(group => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong></td><td></td><td></td><td>${resourceStatus(group)}</td><td class="right"><span class="row-actions"><button data-edit-group="${group.id}">配置</button><button class="danger" data-disable-group="${group.id}">停用</button></span></td>`;
    $('strong', tr).textContent = group.name; tr.children[1].textContent = group.description || '-'; tr.children[2].textContent = group.sort; return tr;
  }));
  $('#adminUpgradeTable').replaceChildren(...data.upgrades.map(upgrade => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td class="right"><span class="row-actions"><button data-edit-upgrade="${upgrade.id}">配置</button><button class="danger" data-disable-upgrade="${upgrade.id}">停用</button></span></td>`;
    $('strong', tr).textContent = upgrade.name; $('small', tr).textContent = upgrade.enabled ? '启用' : '停用'; tr.children[1].textContent = formatMoney(upgrade.price_cents); tr.children[2].textContent = `+${upgrade.domain_increment}`; tr.children[3].textContent = `+${formatBytes(upgrade.traffic_increment_bytes)}`; tr.children[4].textContent = `+${upgrade.port_increment}`; return tr;
  }));
  $('#adminTrafficTable').replaceChildren(...data.trafficPackages.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td>${resourceStatus(item)}</td><td class="right"><span class="row-actions"><button data-edit-traffic="${item.id}">配置</button><button class="danger" data-disable-traffic="${item.id}">停用</button></span></td>`;
    $('strong', tr).textContent = item.name; $('small', tr).textContent = item.description || ''; tr.children[1].textContent = formatBytes(item.traffic_bytes); tr.children[2].textContent = formatMoney(item.price_cents); tr.children[3].textContent = `${item.duration_days} 天`; return tr;
  }));
  $('#adminRedemptionTable').replaceChildren(...data.codes.map(code => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${resourceStatus(code)}</td><td class="right"><span class="row-actions"><button data-code-uses="${code.id}">记录</button><button class="danger" data-disable-code="${code.id}">停用</button></span></td>`;
    $('strong', tr).textContent = `****-${code.suffix}`; $('small', tr).textContent = code.label || `兑换码 #${code.id}`; tr.children[1].textContent = code.productName || '历史商品'; tr.children[2].textContent = `x${code.amount}`; tr.children[3].textContent = `${code.usedCount} / ${code.maxUses}`; tr.children[4].textContent = code.expiresAt ? formatDate(code.expiresAt) : '长期有效'; return tr;
  }));
  $('#adminWalletTable').replaceChildren(...data.wallets.map(wallet => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td><strong></strong></td><td class="right"><button data-adjust-wallet="${wallet.userId}">调整余额</button></td>`;
    $('td:first-child strong', tr).textContent = wallet.username; $('td:first-child small', tr).textContent = `客户 #${wallet.userId}`;
    tr.children[1].textContent = wallet.email || '-'; $('td:nth-child(3) strong', tr).textContent = formatMoney(wallet.balanceCents); return tr;
  }));
  $('#adminRechargeCodeTable').replaceChildren(...data.rechargeCodes.map(code => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${resourceStatus(code)}</td><td class="right"><span class="row-actions"><button data-recharge-uses="${code.id}">记录</button><button class="danger" data-disable-recharge="${code.id}">停用</button></span></td>`;
    $('strong', tr).textContent = `****-${code.suffix}`; $('small', tr).textContent = code.label || `充值码 #${code.id}`;
    tr.children[1].textContent = code.batchName || '-'; tr.children[2].textContent = formatMoney(code.amountCents); tr.children[3].textContent = `${code.usedCount} / ${code.maxUses}`; tr.children[4].textContent = code.expiresAt ? formatDate(code.expiresAt) : '长期有效'; return tr;
  }));
  $('#rechargeBatchTable').replaceChildren(...data.rechargeBatches.map(batch => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td>';
    $('strong', tr).textContent = batch.name; $('small', tr).textContent = `批次 #${batch.id}`; tr.children[1].textContent = formatMoney(batch.amountCents); tr.children[2].textContent = batch.codeCount;
    tr.children[3].textContent = `${batch.usedCount} / ${batch.totalUses}`; tr.children[4].textContent = batch.expiresAt ? formatDate(batch.expiresAt) : '长期有效'; return tr;
  }));
  $('#adminSubscriptionTable').replaceChildren(...data.subscriptions.map(sub => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong></td><td><strong></strong><small></small></td><td></td><td>${statusBadge(sub.status)}</td><td></td><td class="right"><button class="danger" data-cancel-subscription="${sub.id}">取消</button></td>`;
    $('td:first-child strong', tr).textContent = sub.username; $('td:nth-child(2) strong', tr).textContent = sub.planName; $('td:nth-child(2) small', tr).textContent = `#${sub.id}`;
    tr.children[2].textContent = `${sub.siteCount} 站点 / ${sub.streamCount} 转发`; tr.children[4].textContent = `${formatDate(sub.startsAt)} 至 ${formatDate(sub.endsAt)}`; return tr;
  }));
  $('#adminOrderTable').replaceChildren(...data.orders.map(order => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong>#${order.id}</strong></td><td></td><td></td><td></td><td>${statusBadge(order.status)}</td><td></td><td class="right"><button data-order-detail="${order.id}">详情</button></td>`;
    tr.children[1].textContent = order.username; tr.children[2].textContent = order.productName || ({ plan: '套餐', plan_change: '套餐升降配', renewal: '套餐续费', upgrade: '增值项', traffic: '流量包' })[order.type] || order.type;
    tr.children[3].textContent = orderAmountLabel(order); if (orderNetAmountCents(order) < 0) tr.children[3].className = 'success-text';
    tr.children[5].textContent = formatDate(order.createdAt); return tr;
  }));
  $('#adminUsageTable').replaceChildren(...data.usage.map(item => {
    const b = item.billing; const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong></td><td></td><td></td><td></td><td></td><td>${b.overLimit ? '<span class="badge off">已超限</span>' : '<span class="badge active">正常</span>'}</td>`;
    $('strong', tr).textContent = item.username; tr.children[1].textContent = b.plan?.name || '未分配'; tr.children[2].textContent = `${formatLimit(b.usage.domains)} / ${formatLimit(b.limits.domains)}`; tr.children[3].textContent = `${formatBytes(b.usage.trafficBytes)} / ${formatBytes(b.limits.trafficBytes)}`; tr.children[4].textContent = `${formatLimit(b.usage.ports)} / ${formatLimit(b.limits.ports)}`; return tr;
  }));
  $('#financeReportSummary').replaceChildren(
    summaryBlock('客户余额合计', formatMoney(data.finance.walletLiabilityCents)),
    summaryBlock('期间入账', formatMoney(data.finance.creditCents)),
    summaryBlock('期间支出', formatMoney(data.finance.debitCents)),
    summaryBlock('净变动', `${Number(data.finance.netChangeCents) >= 0 ? '+' : '-'}${formatMoney(Math.abs(Number(data.finance.netChangeCents || 0)))}`),
    summaryBlock('交易笔数', `${data.finance.transactionCount || 0} 笔`),
  );
  if (!$('#financeFrom').value) $('#financeFrom').value = data.finance.from || '';
  if (!$('#financeTo').value) $('#financeTo').value = data.finance.to || '';
  $('#financeReportTable').replaceChildren(...data.finance.breakdown.map(item => { const tr = document.createElement('tr'); tr.innerHTML = '<td></td><td></td><td></td><td><strong></strong></td>';
    tr.children[0].textContent = item.direction === 'credit' ? '入账' : '支出'; tr.children[1].textContent = financeTypeLabel(item.referenceType); tr.children[2].textContent = item.count; $('strong', tr).textContent = formatMoney(item.amountCents); return tr; }));
  const financeTransactions = data.finance.transactions || [];
  $('#financeTransactionTable').replaceChildren(...financeTransactions.map(item => {
    const tr = document.createElement('tr'); const credit = item.direction === 'credit';
    tr.innerHTML = '<td></td><td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td></td>';
    tr.children[0].textContent = formatDate(item.createdAt); $('td:nth-child(2) strong', tr).textContent = item.username || `客户 #${item.userId}`;
    $('td:nth-child(2) small', tr).textContent = `客户 #${item.userId}`; tr.children[2].textContent = financeTypeLabel(item.referenceType);
    tr.children[3].textContent = item.description || '-'; tr.children[4].textContent = `${credit ? '+' : '-'}${formatMoney(item.amountCents)}`;
    tr.children[4].className = credit ? 'success-text' : 'danger-text'; tr.children[5].textContent = formatMoney(item.balanceAfterCents);
    tr.children[6].textContent = item.referenceId ? `${item.referenceType} #${item.referenceId}` : '-'; return tr;
  }));
  $('#financeTransactionsEmpty').classList.toggle('hidden', financeTransactions.length !== 0);
  renderPager('#redemptionPager', data.pagination?.codes, 'codes');
  renderPager('#walletsPager', data.pagination?.wallets, 'wallets');
  renderPager('#rechargePager', data.pagination?.rechargeCodes, 'rechargeCodes');
  renderPager('#rechargeBatchPager', data.pagination?.rechargeBatches, 'rechargeBatches');
  renderPager('#subscriptionsPager', data.pagination?.subscriptions, 'subscriptions');
  renderPager('#ordersPager', data.pagination?.orders, 'orders');
  renderPager('#usagePager', data.pagination?.usage, 'usage');
  renderAdminOverview();
}

function renderAdminOverview() {
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

function summaryBlock(label, value) {
  const block = document.createElement('div'); block.innerHTML = '<span></span><strong></strong>';
  $('span', block).textContent = label; $('strong', block).textContent = value; return block;
}

function billingListFilters(key) {
  if (key === 'codes') return { q: $('#redemptionSearch')?.value.trim() || '', status: $('#redemptionStatus')?.value || '' };
  if (key === 'wallets') return { q: $('#walletSearch')?.value.trim() || '' };
  if (key === 'rechargeCodes') return { q: $('#rechargeSearch')?.value.trim() || '', status: $('#rechargeStatus')?.value || '' };
  if (key === 'subscriptions') return { q: $('#subscriptionSearch')?.value.trim() || '', status: $('#subscriptionStatus')?.value || '' };
  if (key === 'orders') return { q: $('#orderSearch')?.value.trim() || '', status: $('#orderStatus')?.value || '' };
  if (key === 'usage') return { q: $('#usageSearch')?.value.trim() || '' };
  return {};
}

const billingListSpec = {
  codes: ['/api/admin/billing/redemption-codes', 'codes'], wallets: ['/api/admin/billing/wallets', 'wallets'],
  rechargeCodes: ['/api/admin/billing/recharge-codes', 'codes'], rechargeBatches: ['/api/admin/billing/recharge-code-batches', 'batches'],
  subscriptions: ['/api/admin/billing/subscriptions', 'subscriptions'], orders: ['/api/admin/billing/orders', 'orders'], usage: ['/api/admin/billing/usage', 'users'],
};

async function loadBillingPage(key, page = state.pageInfo[key]?.page || 1) {
  const [path, responseKey] = billingListSpec[key]; const result = await api(queryPath(path, billingListFilters(key), page));
  state.billingAdmin[key] = result[responseKey]; state.billingAdmin.pagination[key] = result.pagination; renderAdminBilling();
}

async function loadBillingAdmin() {
  const [plans, groups, upgrades, traffic, codes, subscriptions, orders, usage, users, wallets, rechargeCodes, rechargeBatches, finance, overview, upstreams] = await Promise.all([
    api('/api/admin/billing/plans'), api('/api/admin/billing/groups'), api('/api/admin/billing/upgrades'), api('/api/admin/billing/traffic-packages'),
    api(queryPath('/api/admin/billing/redemption-codes', billingListFilters('codes'), state.pageInfo.codes?.page || 1)),
    api(queryPath('/api/admin/billing/subscriptions', billingListFilters('subscriptions'), state.pageInfo.subscriptions?.page || 1)),
    api(queryPath('/api/admin/billing/orders', billingListFilters('orders'), state.pageInfo.orders?.page || 1)),
    api(queryPath('/api/admin/billing/usage', billingListFilters('usage'), state.pageInfo.usage?.page || 1)),
    api('/api/admin/customers?pageSize=100'),
    api(queryPath('/api/admin/billing/wallets', billingListFilters('wallets'), state.pageInfo.wallets?.page || 1)),
    api(queryPath('/api/admin/billing/recharge-codes', billingListFilters('rechargeCodes'), state.pageInfo.rechargeCodes?.page || 1)),
    api(queryPath('/api/admin/billing/recharge-code-batches', {}, state.pageInfo.rechargeBatches?.page || 1)),
    api('/api/admin/billing/finance/summary'), api('/api/admin/overview'), api('/api/admin/upstreams'),
  ]);
  state.upstreams = upstreams.upstreams;
  state.users = users.customers;
  state.adminOverview = overview.overview;
  state.billingAdmin = { plans: plans.plans, groups: groups.groups, upgrades: upgrades.upgrades, trafficPackages: traffic.trafficPackages, codes: codes.codes, subscriptions: subscriptions.subscriptions, orders: orders.orders, usage: usage.users, users: users.customers, wallets: wallets.wallets, rechargeCodes: rechargeCodes.codes, rechargeBatches: rechargeBatches.batches, finance,
    pagination: { codes: codes.pagination, subscriptions: subscriptions.pagination, orders: orders.pagination, usage: usage.pagination, wallets: wallets.pagination, rechargeCodes: rechargeCodes.pagination, rechargeBatches: rechargeBatches.pagination } };
  renderAdminBilling();
}

function fillSelect(select, rows, label, includeBlank = false) {
  const options = rows.map(row => { const option = document.createElement('option'); option.value = row.id; option.textContent = label(row); return option; });
  if (includeBlank) { const blank = document.createElement('option'); blank.value = ''; blank.textContent = '不分组'; options.unshift(blank); }
  select.replaceChildren(...options);
}

function openPlanDialog(plan = null) {
  const form = $('#planForm'); form.reset(); const data = state.billingAdmin;
  fillSelect(form.elements.groupId, data.groups, group => group.name, true);
  const mappings = state.upstreams.filter(item => item.status === 'active').flatMap(account => account.packages.filter(item => item.enabled).map(item => ({ id: `${account.id}:${item.packageId}`, label: `${account.name} / ${item.name} (#${item.packageId})` })));
  fillSelect(form.elements.upstreamMapping, mappings, item => item.label);
  form.elements.id.value = plan?.id || ''; form.elements.code.value = plan?.code || ''; form.elements.name.value = plan?.name || ''; form.elements.price.value = plan ? plan.priceCents / 100 : ''; form.elements.durationDays.value = plan?.durationDays || 30; form.elements.domainLimit.value = plan?.domainLimit ?? ''; form.elements.trafficGiB.value = plan?.trafficLimitBytes === null ? '' : Number(plan?.trafficLimitBytes || 0) / GIB; form.elements.portLimit.value = plan?.portLimit ?? ''; form.elements.groupId.value = plan?.groupId ?? ''; form.elements.description.value = plan?.description || ''; form.elements.enabled.checked = plan ? plan.enabled : true;
  form.elements.upstreamMapping.value = plan?.upstreamId && plan?.upstreamPackageId ? `${plan.upstreamId}:${plan.upstreamPackageId}` : '';
  $('#planDialogTitle').textContent = plan ? `配置 ${plan.name}` : '新建套餐'; $('#planDialog').showModal();
}

function openCatalogDialog(type, item = null) {
  const form = $(`#${type}Form`); form.reset(); form.elements.id.value = item?.id || '';
  if (type === 'group') { form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.sort.value = item?.sort || 0; form.elements.enabled.checked = item ? Boolean(item.enabled) : true; }
  if (type === 'upgrade') { form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.price.value = item ? item.price_cents / 100 : ''; form.elements.domainIncrement.value = item?.domain_increment || 0; form.elements.trafficGiB.value = Number(item?.traffic_increment_bytes || 0) / GIB; form.elements.portIncrement.value = item?.port_increment || 0; form.elements.enabled.checked = item ? Boolean(item.enabled) : true; }
  if (type === 'traffic') { form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.price.value = item ? item.price_cents / 100 : ''; form.elements.trafficGiB.value = Number(item?.traffic_bytes || 0) / GIB || ''; form.elements.durationDays.value = item?.duration_days || 30; form.elements.enabled.checked = item ? Boolean(item.enabled) : true; }
  $(`#${type}DialogTitle`).textContent = `${item ? '配置' : '新建'}${type === 'group' ? '分组' : type === 'upgrade' ? '增值项' : '流量包'}`; $(`#${type}Dialog`).showModal();
}

function openSubscriptionDialog(userId = null) {
  const form = $('#subscriptionForm'); form.reset();
  fillSelect(form.elements.userId, state.users.filter(user => user.role === 'user'), user => user.username);
  fillSelect(form.elements.planId, state.billingAdmin.plans.filter(plan => plan.enabled), plan => `${plan.name} · ${formatMoney(plan.priceCents)}`);
  if (userId) form.elements.userId.value = userId; $('#subscriptionDialog').showModal();
}

function updateRedemptionProducts() {
  const form = $('#redemptionForm'); const type = form.elements.type.value; const rows = type === 'plan' ? state.billingAdmin.plans.filter(item => item.enabled) : type === 'upgrade' ? state.billingAdmin.upgrades.filter(item => item.enabled) : state.billingAdmin.trafficPackages.filter(item => item.enabled);
  fillSelect(form.elements.productId, rows, item => item.name);
}

async function loadAdminSites(page = state.pageInfo.adminSites?.page || 1) {
  const query = $('#adminSiteSearch').value.trim(); const response = await api(queryPath('/api/admin/sites', { q: query }, page)); state.adminSites = response.sites;
  $('#adminSiteCount').textContent = `${response.pagination?.total ?? state.adminSites.length} 个站点`;
  $('#adminSiteTable').replaceChildren(...state.adminSites.map(site => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td>${badge(site)}</td><td></td><td class="right"><span class="row-actions"><button data-admin-toggle="${site.id}">${site.enabled ? '停用' : '启用'}</button><button class="danger" data-admin-delete="${site.id}">删除</button></span></td>`;
    $('strong', tr).textContent = site.domain; $('small', tr).textContent = site.cname || `站点 #${site.id}`; tr.children[1].textContent = site.username; tr.children[2].textContent = site.planName || '未绑定'; tr.children[3].textContent = site.origin; tr.children[5].textContent = formatDate(site.createdAt); return tr;
  }));
  renderPager('#adminSitesPager', response.pagination, 'adminSites');
  renderAdminOverview();
}

async function loadAdminStreams(page = state.pageInfo.adminStreams?.page || 1) {
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

async function loadAdminOverview() {
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

function auditEntityLabel(log) {
  const entity = String(log.action || '').split('.').slice(0, -1).join('.').replace(/^admin\./, '');
  return auditActionEntityLabels[entity] || auditEntityLabels[log.resourceType || log.resource_type] || log.resourceType || log.resource_type || '资源';
}

function auditActionLabel(log) {
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

function auditDetailRecords(log) {
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

async function loadAudit(page = state.pageInfo.audit?.page || 1) {
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

async function loadUpstreams() {
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

async function loadSystemHealth() {
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

async function loadRuntimeSettings() {
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

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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

async function loadAdministrators() {
  if (state.me.user.adminRole !== 'super_admin') return;
  const result = await api('/api/admin/administrators'); state.administrators = result.administrators;
  $('#administratorTable').replaceChildren(...state.administrators.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td class="right"><span class="row-actions"><button data-edit-administrator>配置</button><button class="danger" data-disable-administrator>停用</button></span></td>';
    $('strong', tr).textContent = item.username; $('small', tr).textContent = `#${item.id}`; tr.children[1].textContent = item.email || '-'; tr.children[2].textContent = item.adminRole === 'super_admin' ? '超级管理员' : '管理员';
    tr.children[3].innerHTML = item.status === 'active' ? '<span class="badge active">正常</span>' : '<span class="badge off">已停用</span>'; tr.children[4].textContent = formatDate(item.lastLoginAt);
    $('[data-edit-administrator]', tr).dataset.editAdministrator = item.id; $('[data-disable-administrator]', tr).dataset.disableAdministrator = item.id; return tr;
  }));
}

async function loadInvitations(page = 1) {
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

async function loadAccountSecurity() {
  const customer = state.me.user.role === 'user';
  $('#account').classList.toggle('customer-account', customer);
  $('#account').classList.toggle('administrator-account', !customer);
  const [mfa, sessions, closure, apiKeyResult] = await Promise.all([api('/api/account/mfa'), api('/api/account/sessions'), customer ? api('/api/account/closure') : Promise.resolve(null), customer ? api('/api/cdnfly/v1/api-key').catch(() => ({ data: { items: [] } })) : Promise.resolve({ data: { items: [] } })]); state.mfa = mfa; state.accountClosure = closure; state.apiKeys = apiKeyResult?.data?.items || [];
  $('#mfaStatus').className = `badge ${mfa.enabled ? 'active' : 'off'}`; $('#mfaStatus').textContent = mfa.enabled ? '已启用' : '未启用';
  $('#mfaDescription').textContent = mfa.enabled ? `剩余 ${mfa.recoveryCodesRemaining} 枚恢复码` : '用户和管理员均可独立配置'; $('#configureMfaButton').textContent = mfa.enabled ? '解绑 MFA' : '配置 MFA';
  $('#sessionTable').replaceChildren(...sessions.sessions.slice(0, 10).map(session => { const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td class="right"><button class="danger">撤销</button></td>';
    $('strong', tr).textContent = session.current ? '当前设备' : '登录设备'; $('small', tr).textContent = session.userAgent || '未知客户端'; tr.children[1].textContent = session.ip || '-'; tr.children[2].textContent = formatDate(session.lastSeenAt); tr.children[3].textContent = formatDate(session.expiresAt); $('button', tr).dataset.revokeSession = session.id; return tr; }));
  if (customer) {
    $('#closeAccountMfaField').classList.toggle('hidden', !mfa.enabled); $('#closeAccountForm').elements.mfaCode.required = Boolean(mfa.enabled);
    renderAccountClosure(closure);
    const verification = Boolean(state.authConfig?.emailVerificationEnabled);
    $('#emailChangeDescription').textContent = verification ? `仅支持平台允许的邮箱域名，验证码将发送到新邮箱。当前邮箱：${state.me.user.email || '未绑定'}` : '仅支持平台允许的邮箱域名，验证当前密码后直接更换并重新登录';
    $('#emailChangeTurnstile').classList.toggle('hidden', !verification || !state.authConfig?.turnstileEnabled);
    renderApiKeys();
  }
}

function renderApiKeys() {
  const table = $('#apiKeyTable'); if (!table) return;
  const rows = state.apiKeys.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong></td><td></td><td></td><td></td><td></td><td class="right"><button class="danger" type="button">撤销</button></td>';
    $('strong', tr).textContent = item.name; tr.children[1].textContent = item.keyPrefix; tr.children[2].textContent = formatDate(item.createdAt); tr.children[3].textContent = item.lastUsedAt ? formatDate(item.lastUsedAt) : '尚未使用';
    tr.children[4].innerHTML = item.revokedAt ? '<span class="badge off">已撤销</span>' : '<span class="badge active">生效中</span>';
    if (item.revokedAt) $('button', tr).disabled = true;
    $('button', tr).dataset.revokeApiKey = item.id; return tr;
  });
  table.replaceChildren(...rows); $('#apiKeyEmpty')?.classList.toggle('hidden', rows.length !== 0);
}

function renderAccountClosure(status) {
  if (!status) return;
  const list = $('#accountClosureStatus'); const items = status.blockers.length ? status.blockers.map(item => item.message) : ['余额为零', '没有生效套餐', '没有网站或 CDN 服务资源'];
  list.replaceChildren(...items.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  $('#accountClosureBadge').className = `badge ${status.eligible ? 'active' : 'pending'}`; $('#accountClosureBadge').textContent = status.eligible ? '可以注销' : '暂不可注销';
  $('button[type="submit"]', $('#closeAccountForm')).disabled = !status.eligible;
}

const resourceNames = {
  'site-groups': '网站分组', domains: '域名', certs: '证书', dnsapis: 'DNS API',
  acls: 'ACL', 'cc-filters': 'CC 过滤器', 'cc-matchs': 'CC 匹配器', 'cc-rules': 'CC 规则', 'waf-rules': 'WAF 规则',
  streams: '四层转发', 'stream-groups': '四层转发分组',
};

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'list', 'rows', 'data', 'result']) {
    const found = extractItems(data[key]);
    if (found.length || Array.isArray(data[key])) return found;
  }
  return [];
}

function resourceStatus(resource) {
  const lifecycle = resourceLifecycle(resource, state.resourceKind);
  return `<span class="badge ${lifecycle.tone}">${lifecycle.label}</span>`;
}

const resourcePageConfigs = {
  'site-groups': ['SITE GROUPS', '网站分组', '按业务对网站进行分类和筛选。', '分组数量', '可用分组', '管理方式', '分组管理'],
  domains: ['DOMAIN MANAGEMENT', '域名管理', '查看已接入域名及解析状态。', '域名数量', '解析正常', '解析方式', 'DNS 解析'],
  certs: ['CERTIFICATE MANAGEMENT', '证书管理', '申请、上传、下载和维护 HTTPS 证书。', '证书数量', '可用证书', '签发方式', '自动 / 上传'],
  dnsapis: ['DNS API', 'DNS API 管理', '管理自动签发证书所需的 DNS 服务商授权。', '配置数量', '可用配置', '服务商', '凭据保护'],
  acls: ['ACCESS CONTROL', 'ACL 访问控制', '按请求属性组合允许或拒绝规则，控制站点访问边界。', 'ACL 数量', '启用 ACL', '默认动作', '允许 / 拒绝'],
  'cc-rules': ['CC PROTECTION', 'CC 防护规则', '管理请求匹配、访问控制和处置规则。', '规则数量', '启用规则', '规则类型', '组合规则'],
  'cc-matchs': ['REQUEST MATCHERS', '请求匹配器', '按请求属性组合条件，为防护规则提供精确匹配。', '匹配器', '启用项', '匹配方式', '条件组合'],
  'cc-filters': ['REQUEST FILTERS', '访问过滤器', '配置频率限制、验证方式和命中后的处置动作。', '过滤器', '启用项', '处置方式', '分级控制'],
  'waf-rules': ['WAF RULES', 'WAF 规则', '管理网站可用的应用防护规则和规则订阅。', '规则数量', '可用规则', '更新方式', '规则订阅'],
};

function resourceIsEnabled(resource) {
  return resourceEnabled(resource);
}

function syncResourcePageContext() {
  const config = resourcePageConfigs[state.resourceKind] || resourcePageConfigs['site-groups'];
  $('#resourceKicker').textContent = config[0]; $('#resourceHeroTitle').textContent = config[1]; $('#resourceHeroDescription').textContent = config[2];
  $('#resourceMetricLabelOne').firstChild.textContent = config[3]; $('#resourceMetricLabelTwo').firstChild.textContent = config[4];
  $('#resourceMetricLabelThree').firstChild.textContent = config[5]; $('#resourceMetricThree').textContent = config[6];
  const title = resourceNames[state.resourceKind] || '安全策略'; $('#securityPageTitle').textContent = title;
  $('#securityPageSubtitle').textContent = config[2];
  const ccKind = ['cc-rules', 'cc-matchs', 'cc-filters'].includes(state.resourceKind);
  $('#ccResourceTabs').classList.toggle('hidden', !ccKind);
  $$('#ccResourceTabs [data-resource-kind]').forEach(button => button.classList.toggle('active', button.dataset.resourceKind === state.resourceKind));
  const contextVisible = ['certs', 'dnsapis'].includes(state.resourceKind);
  $('#resourceContextRail').classList.toggle('hidden', !contextVisible);
  $$('[data-resource-context]').forEach(button => button.classList.toggle('active', button.dataset.resourceContext === state.resourceKind));
  syncWorkbenchLayout();
}

function renderResources() {
  syncResourcePageContext();
  const certificateColumns = state.resourceKind === 'certs';
  $('#resourceDescriptionHeader').textContent = certificateColumns ? '域名' : '说明';
  $('#resourceCreatedHeader').classList.toggle('hidden', !certificateColumns);
  $('#resourceExpiresHeader').classList.toggle('hidden', !certificateColumns);
  $('#resourceAutoRenewHeader').classList.toggle('hidden', !certificateColumns);
  const query = ($('#resourceSearch')?.value || '').trim().toLowerCase();
  const filtered = state.resources.filter(resource => {
    const matchesQuery = [resource.id, resource.name, resource.domain, resource.hostname, resource.des, resource.description, resource.type, resource.provider, resource.default_action].some(value => String(value ?? '').toLowerCase().includes(query));
    if (!matchesQuery) return false;
    const lifecycle = resourceLifecycle(resource, state.resourceKind);
    if (state.resourceFilter === 'active') return lifecycle.state === 'active';
    if (state.resourceFilter === 'disabled') return lifecycle.state === 'disabled';
    return true;
  });
  const availableIds = new Set(state.resources.filter(item => !item._shared).map(item => item.id));
  for (const id of state.selectedResources) if (!availableIds.has(id)) state.selectedResources.delete(id);
  const rows = filtered.map(resource => {
    const tr = document.createElement('tr');
    const certificate = state.resourceKind === 'certs';
    const name = resource.name || resource.domain || resource.hostname || `资源 #${resource.id}`;
    const type = state.resourceKind === 'acls'
      ? (resource.default_action === 'reject' ? '默认拒绝' : '默认允许')
      : state.resourceKind === 'certs'
        ? ({ lets: "Let's Encrypt", zerossl: 'ZeroSSL', buypass: 'Buypass', custom: '上传证书' }[resource.type] || resource.type || '-')
      : resource.type || resource.provider || resource.scope || '-';
    let actions = '';
    if (state.resourceKind === 'domains') actions = `<button class="manage-button" data-sync-resource="${resource.id}">同步 DNS</button>`;
    else if (!resource._shared) {
      const certificateReady = certificate && resourceLifecycle(resource, 'certs').state === 'active';
      const certificateActions = certificate
        ? `<button type="button" data-download-resource="${resource.id}"${certificateReady ? '' : ' disabled title="证书签发完成后才可下载"'}>下载证书</button><button type="button" data-toggle-resource="${resource.id}">${resourceIsEnabled(resource) ? '停用证书' : '启用证书'}</button>` : '';
      const deleteLabel = certificate ? '删除证书' : '删除资源';
      const deleteDisabled = certificate && resourceIsEnabled(resource) ? ' disabled title="请先停用证书"' : '';
      const moreActions = `${certificateActions}<button type="button" class="danger" data-delete-resource="${resource.id}"${deleteDisabled}>${deleteLabel}</button>`;
      actions = `<button class="manage-button" data-edit-resource="${resource.id}">管理</button>${actionMenu(moreActions)}`;
    }
    else actions = '<span class="count-label">仅可查看</span>';
    const createdAt = resource.create_at2 ?? resource.created_at ?? resource.createdAt ?? resource.create_time ?? resource.createTime;
    const expiresAt = resource.expire_time2 ?? resource.expire_time ?? resource.expires_at ?? resource.expiresAt ?? resource.end_time;
    const certificateDate = value => value ? formatDate(value) : '上游未返回';
    const certColumnClass = certificate ? 'resource-cert-column' : 'resource-cert-column hidden';
    tr.innerHTML = `<td class="select-cell"><input type="checkbox" ${resource._shared ? 'disabled' : `data-select-resource="${resource.id}"`} aria-label="选择资源"></td><td><span class="id-chip">#${resource.id}</span></td><td><strong></strong></td><td></td><td><span class="resource-description"></span></td><td class="${certColumnClass}">${certificateDate(createdAt)}</td><td class="${certColumnClass}">${certificateDate(expiresAt)}</td><td class="${certColumnClass}">${enabledValue(resource.auto_renew) ? '已开启' : '未开启'}</td><td>${resourceStatus(resource)}</td><td class="right"><span class="row-actions">${actions}</span></td>`;
    const select = $('[data-select-resource]', tr); if (select) select.checked = state.selectedResources.has(resource.id);
    $('td strong', tr).textContent = name;
    tr.children[3].textContent = type;
    const description = state.resourceKind === 'certs'
      ? resource.domain || '-'
      : resource.des || resource.description || resource.cname || '-';
    $('.resource-description', tr).textContent = description;
    return tr;
  });
  $('#resourceTable').replaceChildren(...rows);
  $('#resourceCount').textContent = `${filtered.length} 项`;
  $('#resourcesEmpty').classList.toggle('hidden', rows.length !== 0);
  $('#newResourceButton').classList.toggle('hidden', state.resourceKind === 'domains');
  const enabled = state.resources.filter(resource => !resource._shared && resourceLifecycle(resource, state.resourceKind).state === 'active').length;
  $('#resourceMetricOne').textContent = state.resources.length; $('#resourceMetricTwo').textContent = enabled;
  const toggleKind = ['certs', 'acls', 'cc-filters', 'cc-matchs', 'cc-rules', 'waf-rules'].includes(state.resourceKind);
  $('#resourceBulkEnable').classList.toggle('hidden', !toggleKind); $('#resourceBulkDisable').classList.toggle('hidden', !toggleKind);
  updateResourceSelectionControls(filtered);
}

function updateResourceSelectionControls(visible = state.resources) {
  const selectable = visible.filter(item => !item._shared).map(item => item.id); const selected = state.selectedResources.size;
  const all = $('#selectAllResources');
  all.checked = selectable.length > 0 && selectable.every(id => state.selectedResources.has(id));
  all.indeterminate = selectable.some(id => state.selectedResources.has(id)) && !all.checked;
  $('#resourceBulkEnable').disabled = selected === 0; $('#resourceBulkDisable').disabled = selected === 0; $('#resourceBulkDelete').disabled = selected === 0;
  const label = $('#resourceSelectionCount'); label.textContent = `已选择 ${selected} 项`; label.classList.toggle('hidden', selected === 0);
}

async function loadResources() {
  const response = await api(`/api/cdnfly/v1/${state.resourceKind}`);
  state.resources = extractItems(response.data);
  renderResources();
}

const DNS_CREDENTIALS = {
  CloudFlare: [['CF_Key', 'Key', true], ['CF_Email', 'Email', false]],
  'DNSPod.cn': [['DP_Id', 'ID', false], ['DP_Key', 'Token', true]],
  'DNSPod.com': [['DPI_Id', 'ID', false], ['DPI_Key', 'Token', true]],
  'GoDaddy.com': [['GD_Key', 'Key', true], ['GD_Secret', 'Secret', true]],
  Aliyun: [['Ali_Key', 'Access Key ID', false], ['Ali_Secret', 'Access Key Secret', true]],
  'cloudns.net': [['CLOUDNS_SUB_AUTH_ID', 'Sub Auth ID', false], ['CLOUDNS_AUTH_PASSWORD', 'Auth Password', true]],
  'Name.com': [['Namecom_Username', 'Username', false], ['Namecom_Token', 'Token', true]],
  Namecheap: [['NAMECHEAP_USERNAME', 'Username', false], ['NAMECHEAP_API_KEY', 'API Key', true], ['NAMECHEAP_SOURCEIP', 'Source IP', false]],
  'jdcloud.com': [['JD_ACCESS_KEY_ID', 'Access Key ID', false], ['JD_ACCESS_KEY_SECRET', 'Access Key Secret', true]],
  'DNS.LA': [['LA_Ak', 'App ID', false], ['LA_Sk', 'API 密钥', true]],
  'Namesilo.com': [['Namesilo_Key', 'Key', true]],
  '51DNS.COM': [['dns_com_key', 'API Key', true], ['dns_com_secret', 'API Secret', true]],
  'huaweicloud.com': [['huaweicloud_access_key_id', 'Access Key ID', false], ['huaweicloud_serect_access_key', 'Secret Access Key', true]],
};

function fillResourceOptions(select, items, selected, emptyLabel = null) {
  const options = [];
  if (emptyLabel !== null) { const empty = document.createElement('option'); empty.value = ''; empty.textContent = emptyLabel; options.push(empty); }
  for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name || item.domain || `#${item.id}`; options.push(option); }
  select.replaceChildren(...options); if (selected !== undefined && selected !== null) select.value = String(selected);
}

function updateCertificateFields() {
  const form = $('#resourceForm');
  const custom = form.elements.certType.value === 'custom';
  $$('[data-cert-auto]').forEach(field => field.classList.toggle('hidden', custom));
  $('[data-cert-custom]').classList.toggle('hidden', !custom);
  form.elements.certDomain.required = !custom;
  const replacingAutoCertificate = Boolean(state.editingResource && state.editingResource.type !== 'custom');
  form.elements.certKey.required = custom && (!state.editingResource || replacingAutoCertificate);
  form.elements.certBody.required = custom && (!state.editingResource || replacingAutoCertificate);
  form.elements.dnsapi.required = !custom && form.elements.certDomain.value.split(/[\s,]+/).some(domain => domain.startsWith('*.'));
}

function updateDnsCredentialFields(keys = null, placeholder = '') {
  const form = $('#resourceForm');
  const configured = DNS_CREDENTIALS[form.elements.dnsProvider.value] || [];
  const configuredByKey = new Map(configured.map(item => [item[0], item]));
  const definitions = keys?.length
    ? keys.map(key => configuredByKey.get(key) || [key, key, true])
    : configured;
  state.dnsAuthKeys = definitions.map(item => item[0]);
  $('#dnsCredentialFields').replaceChildren(...definitions.map(([key, label, sensitive]) => {
    const wrapper = document.createElement('label');
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input');
    input.dataset.dnsCredential = key;
    input.name = `dnsCredential_${key}`;
    input.type = sensitive ? 'password' : 'text';
    input.autocomplete = sensitive ? 'new-password' : 'off';
    input.placeholder = placeholder;
    wrapper.append(title, input);
    return wrapper;
  }));
}

function updateFilterFields() {
  const rateOnly = $('#resourceForm').elements.filterType.value === 'req_rate';
  $('[data-rate-only]').classList.toggle('hidden', !rateOnly);
}

const MATCH_ITEMS = ['count404', 'uniq_ua', 'header', 'ip', 'host', 'req_uri', 'req_method', 'uri', 'user_agent', 'referer', 'country_iso_code', 'asnumber', 'province', 'city', 'isp', 'protocol', 'accept_language', 'tls_fp', 'uniq_tls_fp', 'server_port'];
const MATCH_OPERATORS = ['>', '=', '!=', '!contain', 'contain', 'prefix', 'suffix', 'regex', '!regex', 'exists', '!exists', 'ip_range', '!ip_range'];
const ACL_MATCH_ITEMS = [
  ['ip', '客户端 IP'], ['host', 'Host'], ['req_uri', '请求 URI'], ['uri', 'URI（不含参数）'], ['req_method', '请求方法'],
  ['header', '请求 Header'], ['accept_language', 'Accept-Language'], ['user_agent', 'User-Agent'], ['referer', 'Referer'],
  ['country_iso_code', '国家代码'], ['province', '省份'], ['city', '城市'], ['isp', 'ISP'], ['asnumber', 'AS 编号'],
  ['protocol', '协议'], ['tls_fp', 'TLS 指纹'], ['uniq_tls_fp', 'TLS 指纹数量'], ['server_port', '服务端口'],
  ['uniq_ua', 'UA 数量'], ['count404', '404 数量'],
];
const ACL_OPERATORS = [
  ['=', '等于'], ['!=', '不等于'], ['>', '大于'], ['contain', '包含'], ['!contain', '不包含'], ['prefix', '前缀'],
  ['suffix', '后缀'], ['regex', '正则匹配'], ['!regex', '正则不匹配'], ['exists', '存在'], ['!exists', '不存在'],
  ['ip_range', 'IP 范围内'], ['!ip_range', 'IP 范围外'],
];

function fillLabeledOptions(select, entries, selected) {
  select.replaceChildren(...entries.map(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === selected; return option;
  }));
}

function addAclCondition(rule, value = {}) {
  const row = document.createElement('div'); row.className = 'rule-row acl-condition';
  row.innerHTML = '<label>匹配项<select data-field="item"></select></label><label>操作符<select data-field="op"></select></label><label class="acl-values">比较值<textarea data-field="value" rows="2" maxlength="32768" placeholder="多个 IP/CIDR 可分行填写；存在/不存在可留空"></textarea></label><button type="button" class="icon-button danger" data-remove-acl-condition aria-label="删除条件">×</button>';
  fillLabeledOptions($('[data-field="item"]', row), ACL_MATCH_ITEMS, value.item || value.match_item || 'ip');
  fillLabeledOptions($('[data-field="op"]', row), ACL_OPERATORS, value.op || value.operator || 'ip_range');
  $('[data-field="value"]', row).value = Array.isArray(value.value) ? value.value.join('\n') : (value.value ?? '');
  $('.acl-condition-list', rule).append(row);
}

function syncAclRuleRow(rule) {
  const redirecting = $('[data-field="action"]', rule).value === '302';
  $('[data-acl-rule-redirect]', rule).classList.toggle('hidden', !redirecting);
  $('[data-field="acl_url"]', rule).required = redirecting;
}

function addAclRule(value = {}) {
  const rule = document.createElement('section'); rule.className = 'acl-rule';
  rule.innerHTML = '<div class="acl-rule-head"><strong>ACL 规则</strong><span><button type="button" class="secondary" data-add-acl-condition>＋ 添加条件</button><button type="button" class="icon-button danger" data-remove-acl-rule aria-label="删除规则">×</button></span></div><div class="acl-rule-meta"><label>命中动作<select data-field="action"><option value="allow">允许</option><option value="403">403 拒绝</option><option value="302">302 跳转</option></select></label><label data-acl-rule-redirect class="hidden">跳转 URL<input data-field="acl_url" type="url" maxlength="2048" placeholder="https://www.example.com/denied"></label></div><div class="acl-condition-list"></div>';
  const rawAction = String(value.acl_action ?? value.action ?? '403');
  const action = rawAction === 'allow' ? 'allow' : String(value.acl_code || (rawAction === '302' ? '302' : '403'));
  $('[data-field="action"]', rule).value = action;
  $('[data-field="acl_url"]', rule).value = value.acl_url || value.redirect_url || '';
  const matchers = Array.isArray(value.acl_matcher) ? value.acl_matcher : (value.match_item || value.item ? [value] : [{}]);
  $('#aclMatchers').append(rule); matchers.forEach(matcher => addAclCondition(rule, matcher)); syncAclRuleRow(rule);
}

function validateAclUrl(value, message) {
  let url;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('跳转 URL 只支持 HTTP 或 HTTPS');
}

function updateAclFields() {
  const form = $('#resourceForm'); const rejecting = form.elements.aclDefaultAction.value === 'reject';
  const redirecting = rejecting && form.elements.aclRejectCode.value === '302';
  $('#aclRejectField').classList.toggle('hidden', !rejecting); $('#aclRedirectField').classList.toggle('hidden', !redirecting);
  form.elements.aclRedirectUrl.required = redirecting;
}

function addMatcherCondition(value = {}) {
  const row = document.createElement('div'); row.className = 'rule-row matcher-condition';
  row.innerHTML = '<label>匹配项<select data-field="item"></select></label><label>条件<select data-field="op"></select></label><label>比较值<input data-field="value"></label><button type="button" class="icon-button danger" data-remove-rule aria-label="删除条件">×</button>';
  const fill = (select, values, selected) => select.replaceChildren(...values.map(item => { const option = document.createElement('option'); option.value = item; option.textContent = item; option.selected = item === selected; return option; }));
  fill($('[data-field="item"]', row), MATCH_ITEMS, value.item || 'ip'); fill($('[data-field="op"]', row), MATCH_OPERATORS, value.op || 'ip_range');
  $('[data-field="value"]', row).value = value.value || ''; $('#matcherConditions').append(row);
}

function addRuleAction(value = {}) {
  const row = document.createElement('div'); row.className = 'rule-row cc-rule-action';
  row.innerHTML = '<label>匹配器<select data-field="matcher"></select></label><label>过滤器<select data-field="filter1"></select></label><label>命中动作<select data-field="action"><option value="block">拦截</option><option value="log">仅记录</option></select></label><label>后续处理<select data-field="mode"><option value="break">停止判断</option><option value="continue">继续判断</option></select></label><button type="button" class="icon-button danger" data-remove-rule aria-label="删除执行项">×</button>';
  fillResourceOptions($('[data-field="matcher"]', row), state.ccMatchers, value.matcher);
  fillResourceOptions($('[data-field="filter1"]', row), state.ccFilters, value.filter1);
  $('[data-field="action"]', row).value = value.action || 'block'; $('[data-field="mode"]', row).value = value.mode || 'break';
  $('#ruleActions').append(row);
}

async function openResourceDialog(resource = null, kind = state.resourceKind) {
  state.editResourceKind = kind; state.editingResource = resource;
  const form = $('#resourceForm'); form.reset();
  form.elements.resourceId.value = resource?.id || '';
  form.elements.name.value = resource?.name || resource?.des || (kind === 'streams' ? '四层转发' : '');
  form.elements.description.value = resource?.des || resource?.description || '';
  const subscriptionField = $('[data-resource-subscription]');
  const needsSubscription = !['domains', 'streams'].includes(kind);
  if (needsSubscription && !tenantSubscriptions().length) await refreshTenantBillingState();
  subscriptionField.classList.toggle('hidden', !needsSubscription);
  form.elements.resourceSubscriptionId.required = needsSubscription;
  if (needsSubscription) {
    fillSubscriptionSelect(form.elements.resourceSubscriptionId, resource?.subscription_id);
    if (!form.elements.resourceSubscriptionId.options.length) throw new Error('本账户没有可用的 CDN 套餐');
  }
  $$('[data-resource-fields]').forEach(group => {
    const visible = ['base', kind].includes(group.dataset.resourceFields);
    group.classList.toggle('hidden', !visible);
    $$('input, select, textarea, button', group).forEach(control => { control.disabled = !visible; });
  });
  if (needsSubscription) form.elements.resourceSubscriptionId.disabled = Boolean(resource);
  $('#matcherConditions').replaceChildren(); $('#ruleActions').replaceChildren(); $('#aclMatchers').replaceChildren();
  if (kind === 'certs') {
    state.dnsApis = extractItems((await api('/api/cdnfly/v1/dnsapis')).data);
    const defaults = resource ? {} : await userDefaultValues('cert');
    const defaultDnsApi = defaults.dnsapi && /^\d+$/.test(defaults.dnsapi) ? Number(defaults.dnsapi) : '';
    fillResourceOptions(form.elements.dnsapi, state.dnsApis, resource?.dnsapi ?? defaultDnsApi, '不使用');
    const nestedCert = resource?.cert && typeof resource.cert === 'object' ? resource.cert : null;
    form.elements.certType.value = resource?.type || defaults.provider || defaults.cert_default_type || 'lets'; form.elements.certDomain.value = resource?.domain || '';
    form.elements.certAutoRenew.checked = resource ? enabledValue(resource.auto_renew) : defaults.auto_renew === undefined || enabledValue(defaults.auto_renew);
    form.elements.certKey.value = '';
    form.elements.certKey.placeholder = resource?.key_configured || nestedCert?.key_configured ? '私钥已保存，留空表示不修改' : '-----BEGIN PRIVATE KEY-----';
    form.elements.certBody.value = typeof resource?.cert === 'string' ? resource.cert : (nestedCert?.body || nestedCert?.cert || '');
    updateCertificateFields();
  }
  if (kind === 'dnsapis') {
    const provider = resource?.type || 'CloudFlare';
    if (![...form.elements.dnsProvider.options].some(option => option.value === provider)) form.elements.dnsProvider.add(new Option(provider, provider));
    form.elements.dnsProvider.value = provider;
    const placeholder = resource?.auth_configured ? '已保存，留空表示不修改' : '';
    updateDnsCredentialFields(resource?.auth_keys, placeholder);
  }
  if (kind === 'acls') {
    form.elements.aclDefaultAction.value = resource?.default_action || 'allow';
    form.elements.aclRejectCode.value = String(resource?.reject_code || 403);
    form.elements.aclRedirectUrl.value = resource?.redirect_url || '';
    form.elements.aclEnabled.checked = resource ? resourceIsEnabled(resource) : true;
    const rules = resource?.data?.length ? resource.data : (resource?.matcher?.length ? resource.matcher : [{}]);
    rules.forEach(addAclRule);
    updateAclFields();
  }
  if (kind === 'cc-filters') {
    form.elements.filterType.value = resource?.type || 'req_rate'; form.elements.withinSecond.value = resource?.within_second || 60;
    form.elements.maxRequest.value = resource?.max_req || 100; form.elements.maxRequestPerUri.value = resource?.max_req_per_uri || 20;
    form.elements.filterEnabled.checked = ![0, false].includes(resource?.enable);
    updateFilterFields();
  }
  if (kind === 'cc-matchs') {
    form.elements.matcherEnabled.checked = ![0, false].includes(resource?.enable);
    (resource?.data?.length ? resource.data : [{}]).forEach(addMatcherCondition);
  }
  if (kind === 'cc-rules') {
    const [matchers, filters] = await Promise.all([api('/api/cdnfly/v1/cc-matchs'), api('/api/cdnfly/v1/cc-filters')]);
    state.ccMatchers = extractItems(matchers.data); state.ccFilters = extractItems(filters.data);
    if (!state.ccMatchers.length || !state.ccFilters.length) throw new Error('请先创建可用的 CC 匹配器和过滤器');
    form.elements.ruleSort.value = resource?.sort ?? 100; form.elements.ruleEnabled.checked = ![0, false].includes(resource?.enable);
    (resource?.data?.length ? resource.data : [{}]).forEach(addRuleAction);
  }
  if (kind === 'waf-rules') {
    form.elements.wafLibraryEnabled.checked = ![0, false].includes(resource?.enable);
    form.elements.wafSubscribeEnabled.checked = resource ? enabledValue(resource.subscribe_enable) : true;
    form.elements.wafSubscribeUrl.value = resource?.subscribe_url || '';
    form.elements.wafSubscribeInterval.value = resource?.subscribe_interval_minutes || 60;
  }
  if (kind === 'streams') {
    state.streamGroups = extractItems((await api('/api/cdnfly/v1/stream-groups')).data);
    const defaults = resource ? {} : await userDefaultValues('stream');
    const listen = resource?.listen?.[0] || {}; const backend = resource?.backend?.[0] || {};
    fillSubscriptionSelect(form.elements.subscriptionId, resource?.subscription_id);
    fillResourceOptions(form.elements.streamGroup, state.streamGroups, resource?.groups, '不分组');
    form.elements.streamListenPort.value = listen.port || 8443; form.elements.streamProtocol.value = listen.protocol || defaults.listen_protocol || 'tcp';
    form.elements.streamBackendAddr.value = backend.addr || ''; form.elements.streamBackendPort.value = resource?.backend_port || 443;
    form.elements.streamBalance.value = resource?.balance_way || defaults.balance_way || 'rr'; form.elements.streamEnabled.checked = ![0, false].includes(resource?.enable);
  }
  $('#resourceDialogTitle').textContent = `${resource?.id ? '配置' : '新建'}${resourceNames[kind]}`;
  $('#resourceDialog').showModal();
}

function collectRuleRows(container) {
  return $$('.rule-row', container).map(row => Object.fromEntries($$('[data-field]', row).map(field => [field.dataset.field, field.value.trim()])));
}

function resourceFormBody(form) {
  const kind = state.editResourceKind;
  const name = form.elements.name.value.trim(); const des = form.elements.description.value.trim();
  if (!name) throw new Error('请填写资源名称');
  const subscriptionId = Number(form.elements.resourceSubscriptionId.value);
  if (kind === 'site-groups') return { name, des, subscriptionId };
  if (kind === 'stream-groups') return { name, des, subscriptionId: Number(form.elements.resourceSubscriptionId.value) };
  if (kind === 'certs') {
    const type = form.elements.certType.value;
    const body = { name, des, type, subscriptionId };
    if (type === 'custom') {
      const key = form.elements.certKey.value.trim(); const cert = form.elements.certBody.value.trim();
      if ((!state.editingResource || state.editingResource.type !== 'custom') && (!key || !cert)) throw new Error('上传证书必须填写私钥和证书正文');
      if (state.editingResource) {
        const nested = state.editingResource.cert && typeof state.editingResource.cert === 'object' ? state.editingResource.cert : null;
        const existingCert = typeof state.editingResource.cert === 'string' ? state.editingResource.cert : (nested?.body || nested?.cert || '');
        const changed = cert !== existingCert;
        if ((key || changed) && (!key || !cert)) throw new Error('替换上传证书时必须同时填写私钥和证书正文');
        if (key && cert) { body.key = key; body.cert = cert; }
      } else {
        body.key = key; body.cert = cert;
      }
      if (body.key && !/^-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----$/.test(body.key)) throw new Error('证书私钥 PEM 格式无效');
      if (body.cert && !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(body.cert)) throw new Error('证书正文 PEM 格式无效');
    } else {
      body.domain = form.elements.certDomain.value.trim();
      body.auto_renew = form.elements.certAutoRenew.checked ? 1 : 0;
      if (!body.domain) throw new Error('自动签发证书必须填写域名');
      if (form.elements.dnsapi.value) body.dnsapi = Number(form.elements.dnsapi.value);
      if (body.domain.split(/[\s,]+/).some(domain => domain.startsWith('*.')) && !body.dnsapi) throw new Error('通配符证书必须选择 DNS API');
    }
    return body;
  }
  if (kind === 'dnsapis') {
    const provider = form.elements.dnsProvider.value;
    const credentials = $$('[data-dns-credential]', form).map(input => [input.dataset.dnsCredential, input.value.trim()]);
    const values = credentials.map(([, value]) => value);
    const providerChanged = !state.editingResource || provider !== state.editingResource.type;
    if (providerChanged && values.some(value => !value)) throw new Error('请完整填写 DNS API 凭据');
    if (values.some(Boolean) && values.some(value => !value)) throw new Error('请完整填写全部 DNS API 凭据');
    const body = { name, des, type: provider, subscriptionId };
    if (values.length && values.every(Boolean)) body.auth = Object.fromEntries(credentials);
    return body;
  }
  if (kind === 'acls') {
    const data = $$('.acl-rule', $('#aclMatchers')).map(rule => {
      const aclMatcher = $$('.acl-condition', rule).map(row => {
        const item = $('[data-field="item"]', row).value;
        const op = $('[data-field="op"]', row).value;
        const value = $('[data-field="value"]', row).value.split('\n').map(part => part.trim()).filter(Boolean).join('\n');
        if (!['exists', '!exists'].includes(op) && !value) throw new Error('请填写每个 ACL 条件的比较值');
        return { item, op, value };
      });
      if (!aclMatcher.length) throw new Error('每条 ACL 规则至少需要一个匹配条件');
      const selectedAction = $('[data-field="action"]', rule).value;
      const aclAction = selectedAction === 'allow' ? 'allow' : 'reject';
      const result = { acl_action: aclAction, acl_matcher: aclMatcher };
      if (aclAction === 'reject') {
        result.acl_code = selectedAction === '302' ? '302' : '403';
        result.acl_url = $('[data-field="acl_url"]', rule).value.trim();
        if (result.acl_code === '302') validateAclUrl(result.acl_url, '请填写有效的规则跳转 URL');
        else result.acl_url = '';
      }
      return result;
    });
    if (!data.length) throw new Error('ACL 至少需要一条规则');
    const defaultAction = form.elements.aclDefaultAction.value;
    const rejectCode = ['302', '403'].includes(form.elements.aclRejectCode.value) ? form.elements.aclRejectCode.value : '403';
    const redirectUrl = form.elements.aclRedirectUrl.value.trim();
    if (defaultAction === 'reject' && rejectCode === '302') validateAclUrl(redirectUrl, '请填写有效的默认跳转 URL');
    return { name, des, default_action: defaultAction,
      reject_code: rejectCode, redirect_url: defaultAction === 'reject' && rejectCode === '302' ? redirectUrl : '',
      enable: form.elements.aclEnabled.checked ? 1 : 0, data, subscriptionId };
  }
  if (kind === 'cc-filters') {
    const body = {
      name, des, type: form.elements.filterType.value,
      within_second: Number(form.elements.withinSecond.value), max_req: Number(form.elements.maxRequest.value),
      enable: form.elements.filterEnabled.checked ? 1 : 0,
    };
    if (body.type === 'req_rate') body.max_req_per_uri = Number(form.elements.maxRequestPerUri.value);
    body.subscriptionId = subscriptionId;
    return body;
  }
  if (kind === 'cc-matchs') {
    const data = collectRuleRows($('#matcherConditions'));
    if (!data.length) throw new Error('至少添加一个匹配条件');
    for (const condition of data) if (!condition.value && !['exists', '!exists'].includes(condition.op)) throw new Error('请填写每个匹配条件的比较值');
    return { name, des, data, enable: form.elements.matcherEnabled.checked ? 1 : 0, subscriptionId };
  }
  if (kind === 'cc-rules') {
    const data = collectRuleRows($('#ruleActions')).map(item => ({
      action: item.action, mode: item.mode, matcher: Number(item.matcher), filter1: Number(item.filter1), filter2: null, state: true,
    }));
    if (!data.length) throw new Error('至少添加一个 CC 规则执行项');
    return { name, des, sort: Number(form.elements.ruleSort.value), data, enable: form.elements.ruleEnabled.checked ? 1 : 0, is_show: 1, subscriptionId };
  }
  if (kind === 'waf-rules') {
    const subscribe = form.elements.wafSubscribeEnabled.checked; const subscribeUrl = form.elements.wafSubscribeUrl.value.trim();
    if (subscribe && !subscribeUrl) throw new Error('启用远程订阅时必须填写订阅 URL');
    if (!state.editingResource && !subscribe) throw new Error('新建规则库需要配置可同步的远程订阅');
    return { name, des, scope: 'user', subscriptionId, enable: form.elements.wafLibraryEnabled.checked ? 1 : 0,
      subscribe_enable: subscribe ? 1 : 0, subscribe_url: subscribeUrl,
      subscribe_interval_minutes: Number(form.elements.wafSubscribeInterval.value || 60), data: state.editingResource?.data || [] };
  }
  if (kind === 'streams') return {
    subscriptionId: Number(form.elements.subscriptionId.value), des: name,
    ...(form.elements.streamGroup.value ? { groups: form.elements.streamGroup.value } : {}),
    listen: [{ port: Number(form.elements.streamListenPort.value), protocol: form.elements.streamProtocol.value }],
    backend_port: Number(form.elements.streamBackendPort.value),
    backend: [{ addr: form.elements.streamBackendAddr.value.trim(), weight: 1, state: 'up' }],
    balance_way: form.elements.streamBalance.value, enable: form.elements.streamEnabled.checked ? 1 : 0,
  };
  throw new Error('该资源类型不支持编辑');
}

async function openWafDialog(site) {
  if (state.capabilities.wafRules === false) throw new Error('当前 CDN 服务未提供 WAF 规则库功能');
  const [rulesResponse, currentResponse] = await Promise.all([
    api('/api/cdnfly/v1/waf-rules'), api(`/api/cdnfly/v1/sites/${site.id}/waf-rules`),
  ]);
  const rules = extractItems(rulesResponse.data);
  const selected = new Set(extractItems(currentResponse.data).map(item => Number(item.rule_id ?? item.id)));
  $('#wafForm').elements.siteId.value = site.id;
  $('#wafDialogTitle').textContent = `${site.domain} · WAF 规则`;
  $('#wafRuleList').replaceChildren(...rules.map(rule => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${rule.id}" ${selected.has(Number(rule.id)) ? 'checked' : ''}><span><strong></strong><small></small></span>`;
    $('strong', label).textContent = rule.name || `规则 #${rule.id}`;
    $('small', label).textContent = rule._shared ? '系统共享规则' : '账户规则';
    return label;
  }));
  $('#wafDialog').showModal();
}

function populateSiteSelects() {
  for (const select of [$('#monitorForm').elements.siteId, $('#jobForm').elements.siteId]) {
    const current = select.value;
    select.replaceChildren(...state.sites.map(site => {
      const option = document.createElement('option'); option.value = site.id; option.textContent = site.domain; return option;
    }));
    if (state.sites.some(site => String(site.id) === current)) select.value = current;
  }
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

function streamListeners(resource = {}) {
  return (resource.listen || []).map(item => `${item.port}/${String(item.protocol || 'tcp').toUpperCase()}`).join(', ');
}

function streamBackends(resource = {}) {
  return (resource.backend || []).map(item => {
    const addr = String(item.addr || '').trim(); const port = item.port ?? resource.backend_port ?? resource.backendPort;
    if (!addr) return ''; return port ? `${addr}:${port}` : addr;
  }).filter(Boolean).join(', ');
}

function streamSyncLabel(resource = {}) {
  if (resource.syncUnavailable || resource.sync_unavailable) return '服务状态未知';
  if (resource.syncWarning || resource.sync_warning) return '最近同步状态';
  const stateValue = String(resource.sync_state ?? resource.syncState ?? resource.stream_state ?? resource.state ?? '').toLowerCase();
  if (['200', 'done', 'synced', 'success', 'active', 'running', 'ok', 'online'].includes(stateValue)) return '已同步';
  if (['failed', 'error', 'offline'].includes(stateValue)) return '同步异常';
  if (['syncing', 'pending', 'provisioning'].includes(stateValue)) return '同步中';
  return stateValue || '等待状态更新';
}

function streamSyncBadge(resource = {}) {
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

function syncStreamPaneContext() {
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

async function loadDataStreams() {
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

function setDefaultMonitorDates() {
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

function setMonitorContext(context = 'site', preferredEndpoint = null, { autoQuery = true } = {}) {
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

function resetMonitorResults() {
  state.monitorRequestId += 1;
  state.monitorItems = []; state.monitorPoints = [];
  setMonitorTableHeaders(state.monitorEndpoint === 'access-log' ? accessLogHeaders : ['时间 / 资源', '数值 / 状态', '范围 / 地址', '详情'], state.monitorEndpoint === 'access-log');
  $('#monitorTable').replaceChildren(); $('#monitorCount').textContent = '0 项'; $('#monitorEmpty').classList.remove('hidden');
  $('#monitorCharts').classList.add('hidden'); $('#monitorSummary').replaceChildren();
  const canvas = $('#monitorChart'); const context = canvas?.getContext('2d'); if (context) context.clearRect(0, 0, canvas.width, canvas.height);
  $('#monitorChartEmpty').classList.remove('hidden');
}

function monitorFormCanQuery() {
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

async function queryMonitor(form) {
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

async function loadLocalLogs() {
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
    detailSection('登录设备', (result.sessions || []).slice(0, 6).map(item => [item.ip || '未知 IP', `${item.user_agent || '未知客户端'} · ${formatDate(item.last_seen_at)}`])),
    detailSection('最近审计', (result.recentAudit || []).slice(0, 6).map(item => [auditActionLabel(item), `${auditEntityLabel(item)}${item.resource_id ? ` #${item.resource_id}` : ''} · ${formatDate(item.created_at)}`])),
  );
  $('#customerDetailDialog').showModal();
}

async function openOrderDetail(id) {
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

async function loadDataPane() {
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

const USER_CONFIG_CATALOG = {
  site: [
    ['http_listen.port', 'HTTP 监听端口', 'text', '80 8080'], ['https_listen.port', 'HTTPS 监听端口', 'text', '443 8443'],
    ['https_listen.hsts', 'HSTS', 'toggle'], ['https_listen.http2', 'HTTP/2', 'toggle'], ['https_listen.http3', 'HTTP/3', 'toggle'], ['https_listen.force_ssl_enable', '强制 HTTPS', 'toggle'],
    ['backend_protocol', '回源协议', 'select', [['follow', '跟随访问协议'], ['http', 'HTTP'], ['https', 'HTTPS']]],
    ['backend_http_port', 'HTTP 回源端口', 'number', '80'], ['backend_https_port', 'HTTPS 回源端口', 'number', '443'], ['proxy_timeout', '回源超时（秒）', 'number', '30'],
    ['balance_way', '负载方式', 'select', [['rr', '轮询'], ['ip_hash', 'IP Hash'], ['url_hash', 'URL Hash'], ['least_conn', '最少连接'], ['random', '随机']]],
    ['gzip_enable', 'Gzip 压缩', 'toggle'], ['websocket_enable', 'WebSocket', 'toggle'], ['block_proxy', '屏蔽透明代理', 'toggle'],
    ['recv_real_time', '实时接收数据', 'toggle'], ['send_real_time', '实时发送数据', 'toggle'], ['enable_ipv6', 'IPv6 访问', 'toggle'],
    ['black_ip', 'IP 黑名单', 'textarea', '每行一个 IP 或网段'], ['white_ip', 'IP 白名单', 'textarea', '每行一个 IP 或网段'], ['spider_to_sip', '搜索引擎专用回源 IP', 'text', '192.0.2.10'],
  ],
  stream: [
    ['proxy_protocol', 'Proxy Protocol', 'toggle'],
    ['listen_protocol', '监听协议', 'select', [['tcp', 'TCP'], ['udp', 'UDP']]],
    ['balance_way', '负载方式', 'select', [['rr', '轮询'], ['ip_hash', '源 IP Hash'], ['least_conn', '最少连接']]],
  ],
  cert: [
    ['provider', '默认签发机构', 'select', [['lets', "Let's Encrypt"], ['zerossl', 'ZeroSSL'], ['buypass', 'Buypass']]],
    ['dnsapi', '默认 DNS API', 'dnsapi'], ['auto_renew', '自动续签', 'toggle'],
  ],
};

function userConfigDefinition(type = state.configType, name = $('#userConfigForm')?.elements.name.value) {
  return (USER_CONFIG_CATALOG[type] || []).find(item => item[0] === name) || USER_CONFIG_CATALOG[type]?.[0];
}

function renderUserConfigValue(value = '') {
  const definition = userConfigDefinition(); if (!definition) return;
  const [, , kind, options] = definition; let input;
  if (kind === 'toggle') {
    input = document.createElement('select'); input.name = 'value';
    input.append(new Option('启用', '1'), new Option('停用', '0')); input.value = ['1', 1, true, 'true', 'on'].includes(value) ? '1' : '0';
  } else if (kind === 'select') {
    input = document.createElement('select'); input.name = 'value'; input.append(...options.map(([optionValue, label]) => new Option(label, optionValue)));
    if (value !== '') input.value = String(value);
  } else if (kind === 'dnsapi') {
    input = document.createElement('select'); input.name = 'value'; input.append(new Option('不指定', ''), ...state.dnsApis.map(item => new Option(item.name || item.domain || `DNS API #${item.id}`, item.id)));
    input.value = String(value || '');
  } else if (kind === 'textarea') {
    input = document.createElement('textarea'); input.name = 'value'; input.rows = 4; input.placeholder = options || ''; input.value = String(value || '');
  } else {
    input = document.createElement('input'); input.name = 'value'; input.type = kind === 'number' ? 'number' : 'text'; input.placeholder = options || ''; input.value = String(value || '');
    if (kind === 'number') { input.min = '0'; input.step = '1'; }
  }
  input.required = kind !== 'dnsapi'; $('#userConfigValueMount').replaceChildren(input);
}

function populateUserConfigScope(selected = '') {
  const form = $('#userConfigForm'); const groups = state.configType === 'site' ? state.siteGroups : state.configType === 'stream' ? state.streamGroups : [];
  form.elements.scopeId.replaceChildren(new Option('请选择分组', ''), ...groups.map(item => new Option(item.name || `分组 #${item.id}`, item.id)));
  form.elements.scopeId.value = String(selected || '');
  const groupOption = [...form.elements.scopeName.options].find(option => option.value === 'group');
  groupOption.hidden = state.configType === 'cert'; groupOption.disabled = state.configType === 'cert';
  if (state.configType === 'cert' && form.elements.scopeName.value === 'group') form.elements.scopeName.value = 'global';
  $('#userConfigScopeField').classList.toggle('hidden', form.elements.scopeName.value !== 'group');
}

function setUserConfigType(type = 'site', { preserveForm = false } = {}) {
  if (!USER_CONFIG_CATALOG[type]) type = 'site'; state.configType = type;
  const form = $('#userConfigForm'); form.elements.type.value = type;
  $$('#userConfigTypeTabs [data-config-type]').forEach(button => button.classList.toggle('active', button.dataset.configType === type));
  $('#userConfigPanelTitle').textContent = `${({ site: '网站', stream: '四层转发', cert: '证书' })[type]}默认设置`;
  const previousName = preserveForm ? form.elements.name.value : '';
  form.elements.name.replaceChildren(...USER_CONFIG_CATALOG[type].map(([name, label]) => new Option(label, name)));
  if (previousName && USER_CONFIG_CATALOG[type].some(item => item[0] === previousName)) form.elements.name.value = previousName;
  populateUserConfigScope(preserveForm ? form.elements.scopeId.value : '');
  renderUserConfigValue(preserveForm ? form.elements.value?.value || '' : '');
  renderUserConfigs();
}

function renderUserConfigs() {
  const items = state.userConfigs.filter(item => item.type === state.configType);
  $('#userConfigTable').replaceChildren(...items.map(item => {
    const definition = userConfigDefinition(item.type, item.name); const label = definition?.[1] || item.name;
    const tr = document.createElement('tr'); tr.innerHTML = '<td></td><td><strong></strong><small></small></td><td></td><td></td><td><small></small></td><td></td><td class="right"><button type="button" data-edit-user-config></button><button type="button" class="danger" data-delete-user-config>删除</button></td>';
    tr.children[0].textContent = `#${item.id}`; $('strong', tr).textContent = label; $('td:nth-child(2) small', tr).textContent = item.name;
    tr.children[2].textContent = ({ site: '网站', stream: '四层转发', cert: '证书' })[item.type] || item.type;
    tr.children[3].textContent = item.scope_name === 'group' ? (item.site_group_name || item.stream_group_name || `分组 #${item.scope_id}`) : '全部资源';
    $('td:nth-child(5) small', tr).textContent = definition?.[2] === 'toggle' ? (String(item.value) === '1' ? '启用' : '停用') : String(item.value || '未指定').slice(0, 100);
    tr.children[5].innerHTML = item.enable ? '<span class="badge active">启用</span>' : '<span class="badge off">停用</span>';
    $('[data-edit-user-config]', tr).textContent = '编辑'; $('[data-edit-user-config]', tr).dataset.editUserConfig = item.id; $('[data-delete-user-config]', tr).dataset.deleteUserConfig = item.id; return tr;
  }));
  $('#userConfigsEmpty').classList.toggle('hidden', items.length !== 0);
  $('#dataSummaryStreams').textContent = state.userConfigs.length; $('#dataSummarySites').textContent = items.length; $('#dataSummaryJobs').textContent = items.filter(item => item.enable).length; $('#dataSummaryPorts').textContent = state.configType === 'cert' ? '本账户' : '全部 / 分组';
}

async function loadUserConfigs() {
  const [configs, siteGroups, streamGroups, dnsApis] = await Promise.all([
    api('/api/cdnfly/v1/user-configs?limit=100'), api('/api/cdnfly/v1/site-groups'), api('/api/cdnfly/v1/stream-groups'), api('/api/cdnfly/v1/dnsapis').catch(() => ({ data: [] })),
  ]);
  state.userConfigs = extractItems(configs.data); state.siteGroups = extractItems(siteGroups.data); state.streamGroups = extractItems(streamGroups.data); state.dnsApis = extractItems(dnsApis.data);
  setUserConfigType(state.configType);
}

function handleError(error) {
  if (error.status === 401) return showLogin();
  toast(error.message, true);
}

function showLogin() {
  clearInterval(serviceStatusTimer); serviceStatusTimer = null;
  state.me = null; state.capabilities = { wafRules: true, attackLogs: true }; $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
  for (const item of [$('#appAnnouncement'), $('#publicAnnouncement')]) item?.classList.add('hidden');
  if ($('#announcementDialog')?.open) $('#announcementDialog').close();
  resetTurnstile('login');
  showAuthForm('loginForm');
  api('/api/auth/config').then(settings => { applyPublicSettings(settings); return configureTurnstile(settings); }).catch(() => {});
}

function showAuthForm(id) {
  for (const form of [$('#loginForm'), $('#mfaLoginForm'), $('#registerForm'), $('#forgotForm')]) form.classList.toggle('hidden', form.id !== id);
}

async function showApp() {
  state.me = await api('/api/me');
  const settings = await api('/api/auth/config'); applyPublicSettings(settings); await configureTurnstile(settings);
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#accountName').textContent = state.me.user.username; $('#accountInitial').textContent = state.me.user.username[0].toUpperCase();
  $('#accountRole').textContent = state.me.user.role === 'admin' ? (state.me.user.adminRole === 'super_admin' ? '超级管理员' : '管理员') : '客户';
  renderAccountProfile();
  $$('.nav-cluster').forEach(cluster => cluster.classList.remove('open', 'active-parent'));
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', state.me.user.role !== 'admin'));
  $$('.customer-only').forEach(el => el.classList.toggle('hidden', state.me.user.role === 'admin'));
  const superAdmin = state.me.user.role === 'admin' && state.me.user.adminRole === 'super_admin';
  for (const view of ['administrators', 'invitations', 'runtime-settings', 'upstreams']) {
    $$(`[data-view="${view}"]`).forEach(element => element.classList.toggle('hidden', !superAdmin));
    $(`#${view}`)?.classList.toggle('restricted-view', !superAdmin);
  }
  if (state.me.user.role === 'admin') {
    await loadAdminOverview();
    navigateFromButton($('.admin-nav [data-view="admin-overview"]'));
    loadServiceStatus().catch(() => {});
  } else {
    try { state.capabilities = (await api('/api/cdnfly/v1/capabilities')).data || { wafRules: true, attackLogs: true }; }
    catch { state.capabilities = { wafRules: true, attackLogs: true }; }
    const wafSupported = state.capabilities.wafRules !== false;
    $$('[data-kind="waf-rules"]').forEach(element => element.classList.toggle('hidden', !wafSupported));
    $('#detailSiteWaf')?.classList.toggle('hidden', !wafSupported);
    const attackLogsSupported = state.capabilities.attackLogs !== false;
    $$('[data-monitor-endpoint="attack-log"]').forEach(element => element.classList.toggle('hidden', !attackLogsSupported));
    for (const value of ['attack-log', 'attack-stats']) {
      const option = $(`#monitorForm option[value="${value}"]`);
      if (option) { option.hidden = !attackLogsSupported; option.disabled = !attackLogsSupported; }
    }
    await loadSites(); navigateFromButton($('.tenant-nav [data-view="overview"]')); await loadOverviewData();
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('button[type=submit]', event.currentTarget); button.disabled = true;
  try {
    const form = new FormData(event.currentTarget); const body = Object.fromEntries(form);
    body.turnstileToken = turnstileToken('login');
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
    if (result.mfaRequired) {
      const mfaForm = $('#mfaLoginForm'); mfaForm.reset(); mfaForm.elements.challengeToken.value = result.challengeToken;
      showAuthForm('mfaLoginForm'); mfaForm.elements.code.focus(); return;
    }
    await showApp();
  } catch (error) { handleError(error); resetTurnstile('login'); } finally { button.disabled = false; }
});

function resetRegisterFlow() {
  const form = $('#registerForm'); const verificationRequired = Boolean(state.authConfig?.emailVerificationEnabled);
  form.dataset.stage = verificationRequired ? 'request' : 'direct';
  $$('input', $('#registerCredentials')).forEach(input => { input.readOnly = false; });
  $('#registerCodeField').classList.add('hidden'); form.elements.code.required = false; form.elements.code.value = '';
  $('#registerSubmit').classList.remove('hidden'); $('#registerSubmit').disabled = verificationRequired;
  clearInterval($('#registerSendCode').cooldownTimer); $('#registerSendCode').disabled = false; $('#registerSendCode').textContent = '发送验证码'; $('#registerSendCode').classList.toggle('hidden', !verificationRequired); $('#registerRestart').classList.add('hidden');
  $('#registerHint').textContent = verificationRequired ? '请使用平台支持的邮箱完成验证，注册后可使用余额购买套餐' : '请使用平台支持的邮箱创建账号，注册后可使用余额购买套餐';
}

function resetForgotFlow() {
  const form = $('#forgotForm'); form.dataset.stage = 'request'; form.elements.email.readOnly = false;
  $('#forgotResetFields').classList.add('hidden'); $$('input', $('#forgotResetFields')).forEach(input => { input.required = false; input.value = ''; });
  $('#forgotSubmit').classList.remove('hidden'); $('#forgotSubmit').disabled = true; clearInterval($('#forgotSendCode').cooldownTimer); $('#forgotSendCode').disabled = false; $('#forgotSendCode').textContent = '发送验证码'; $('#forgotRestart').classList.add('hidden');
  $('#forgotHint').textContent = '通过已验证邮箱接收验证码';
}

async function sendRegistrationCode(form) {
  for (const input of $$('input', $('#registerCredentials'))) if (!input.reportValidity()) return;
  if (form.elements.password.value !== form.elements.confirmPassword.value) throw new Error('两次输入的密码不一致');
  const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({
    username: form.elements.username.value, email: form.elements.email.value, password: form.elements.password.value,
    inviteCode: form.elements.inviteCode.value, termsAccepted: form.elements.legalConsent.checked, privacyAccepted: form.elements.legalConsent.checked,
    turnstileToken: turnstileToken('register'),
  }) });
  resetTurnstile('register'); form.dataset.stage = 'verify';
  $$('input', $('#registerCredentials')).forEach(input => { input.readOnly = true; });
  $('#registerCodeField').classList.remove('hidden'); form.elements.code.required = true;
  $('#registerSubmit').classList.remove('hidden'); $('#registerSubmit').disabled = false; $('#registerRestart').classList.remove('hidden');
  $('#registerHint').textContent = `验证码已发送至 ${result.email}`;
  if (result.devCode) { form.elements.code.value = result.devCode; toast(`开发验证码：${result.devCode}`); }
  startCooldown($('#registerSendCode'), state.authConfig?.emailCodeCooldownSeconds, '重新发送');
}

async function registerDirectly(form) {
  for (const input of $$('input', $('#registerCredentials'))) if (!input.reportValidity()) return false;
  if (form.elements.password.value !== form.elements.confirmPassword.value) throw new Error('两次输入的密码不一致');
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({
    username: form.elements.username.value, email: form.elements.email.value, password: form.elements.password.value,
    inviteCode: form.elements.inviteCode.value, termsAccepted: form.elements.legalConsent.checked, privacyAccepted: form.elements.legalConsent.checked,
    turnstileToken: turnstileToken('register'),
  }) });
  return true;
}

function finishRegistration(form) {
  const username = form.elements.username.value;
  form.reset(); resetRegisterFlow(); showAuthForm('loginForm'); $('#loginForm').elements.username.value = username; toast('注册成功，请登录');
}

async function sendPasswordResetCode(form) {
  if (!form.elements.email.reportValidity()) return;
  const result = await api('/api/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value, turnstileToken: turnstileToken('forgot') }) });
  resetTurnstile('forgot'); form.dataset.stage = 'verify'; form.elements.email.readOnly = true;
  $('#forgotResetFields').classList.remove('hidden'); $$('input', $('#forgotResetFields')).forEach(input => { input.required = true; });
  $('#forgotSubmit').classList.remove('hidden'); $('#forgotSubmit').disabled = false; $('#forgotRestart').classList.remove('hidden');
  $('#forgotHint').textContent = '若邮箱已绑定账号，验证码已发送';
  if (result.devCode) { form.elements.code.value = result.devCode; toast(`开发验证码：${result.devCode}`); }
  startCooldown($('#forgotSendCode'), state.authConfig?.emailCodeCooldownSeconds, '重新发送');
}

$('#showRegister').addEventListener('click', () => { resetRegisterFlow(); showAuthForm('registerForm'); });
$('#showForgot').addEventListener('click', () => { resetForgotFlow(); showAuthForm('forgotForm'); });
$('#showLogin').addEventListener('click', () => showAuthForm('loginForm'));
$('#forgotBackLogin').addEventListener('click', () => showAuthForm('loginForm'));
$('#mfaBackLogin').addEventListener('click', () => { $('#mfaLoginForm').reset(); showAuthForm('loginForm'); });
$('#registerRestart').addEventListener('click', resetRegisterFlow);
$('#forgotRestart').addEventListener('click', resetForgotFlow);
$('#registerSendCode').addEventListener('click', async () => { try { await sendRegistrationCode($('#registerForm')); } catch (error) { resetTurnstile('register'); handleError(error); if (error.data?.retryAfter) startCooldown($('#registerSendCode'), error.data.retryAfter, '重新发送'); } });
$('#forgotSendCode').addEventListener('click', async () => { try { await sendPasswordResetCode($('#forgotForm')); } catch (error) { resetTurnstile('forgot'); handleError(error); if (error.data?.retryAfter) startCooldown($('#forgotSendCode'), error.data.retryAfter, '重新发送'); } });
$('#mfaLoginForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try { await api('/api/auth/login/mfa', { method: 'POST', body: JSON.stringify({ challengeToken: form.elements.challengeToken.value, code: form.elements.code.value }) }); await showApp(); }
  catch (error) { handleError(error); if ([401, 429].includes(error.status) && /失效|次数/.test(error.message)) showAuthForm('loginForm'); }
  finally { button.disabled = false; }
});

$$('.password-toggle').forEach(button => button.addEventListener('click', () => {
  const input = $('input', button.closest('.password-row')); const showing = input.type === 'text'; input.type = showing ? 'password' : 'text';
  button.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
}));
$$('[data-legal]').forEach(button => button.addEventListener('click', () => {
  const kind = button.dataset.legal; const settings = state.authConfig || {};
  $('#legalDialogTitle').textContent = kind === 'terms' ? settings.termsTitle || '服务条款' : settings.privacyTitle || '隐私政策';
  $('#legalDialogBody').textContent = kind === 'terms' ? settings.termsBody || '' : settings.privacyBody || '';
  $('#legalDialog').showModal();
}));
$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    if (form.dataset.stage === 'request') return await sendRegistrationCode(form);
    if (form.dataset.stage === 'direct') {
      if (await registerDirectly(form)) finishRegistration(form);
      return;
    }
    await api('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value, code: form.elements.code.value }) });
    finishRegistration(form);
  } catch (error) { handleError(error); if (form.dataset.stage !== 'verify') resetTurnstile('register'); } finally { button.disabled = false; }
});

$('#forgotForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    if (form.dataset.stage !== 'verify') return await sendPasswordResetCode(form);
    if (form.elements.newPassword.value !== form.elements.confirmPassword.value) throw new Error('两次输入的新密码不一致');
    await api('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value, code: form.elements.code.value, newPassword: form.elements.newPassword.value }) });
    const email = form.elements.email.value; form.reset(); resetForgotFlow(); showAuthForm('loginForm'); $('#loginForm').elements.username.value = email; toast('密码已重置，请登录');
  } catch (error) { handleError(error); if (form.dataset.stage !== 'verify') resetTurnstile('forgot'); } finally { button.disabled = false; }
});

$('#logoutButton').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => null); showLogin(); });
$('#menuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#nav').addEventListener('click', event => {
  const toggle = event.target.closest('[data-nav-toggle]');
  if (toggle) {
    const cluster = toggle.closest('.nav-cluster'); cluster.classList.toggle('open');
    saveNavState(cluster.closest('.tenant-nav, .admin-nav'));
    return;
  }
  const button = event.target.closest('[data-view]'); if (button) navigateFromButton(button);
});
$('#resourceContextRail').addEventListener('click', event => {
  const button = event.target.closest('[data-resource-context]'); if (!button) return;
  if (button.dataset.resourceContext === 'cert-defaults') {
    const target = $('.tenant-nav [data-view="security"][data-kind="certs"]');
    navigateToUserConfigs('cert', target);
    return;
  }
  state.resourceKind = button.dataset.resourceContext;
  syncResourcePageContext(); loadResources().catch(handleError);
});
document.addEventListener('click', event => { const retry = event.target.closest('[data-retry-view]'); if (retry) showView(retry.dataset.retryView); });

function navStorageKey(nav) { return nav?.classList.contains('admin-nav') ? 'cdnfly-admin-nav' : 'cdnfly-tenant-nav'; }
function saveNavState(nav) {
  if (!nav) return;
  try { localStorage.setItem(navStorageKey(nav), JSON.stringify($$('.nav-cluster', nav).map((item, index) => item.classList.contains('open') ? index : null).filter(index => index !== null))); } catch {}
}
function restoreNavState(nav) {
  if (!nav) return;
  try {
    const openClusters = new Set(JSON.parse(localStorage.getItem(navStorageKey(nav)) || '[]'));
    $$('.nav-cluster', nav).forEach((cluster, index) => cluster.classList.toggle('open', openClusters.has(index)));
  } catch {}
}
function filterNavigation(nav, query) {
  const normalized = query.trim().toLowerCase();
  $$('.nav-direct', nav).forEach(button => button.classList.toggle('nav-filter-hidden', Boolean(normalized) && !button.textContent.toLowerCase().includes(normalized)));
  $$('.nav-cluster', nav).forEach(cluster => {
    const parentMatches = $('[data-nav-toggle]', cluster).textContent.toLowerCase().includes(normalized);
    let childMatches = false;
    $$('[data-view]', cluster).forEach(button => {
      const matches = !normalized || parentMatches || button.textContent.toLowerCase().includes(normalized);
      button.classList.toggle('nav-filter-hidden', !matches);
      childMatches ||= matches;
    });
    const matches = !normalized || parentMatches || childMatches;
    cluster.classList.toggle('nav-filter-hidden', !matches);
    if (normalized && matches) cluster.classList.add('open');
  });
  if (!normalized) restoreNavState(nav);
}
function setupNavSearch(input, nav) {
  restoreNavState(nav);
  input.addEventListener('input', () => filterNavigation(nav, input.value));
  input.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    input.value = ''; filterNavigation(nav, ''); input.focus();
  });
}
setupNavSearch($('#tenantNavSearch'), $('.tenant-nav'));
setupNavSearch($('#adminNavSearch'), $('.admin-nav'));
$$('[data-view-link]').forEach(button => button.addEventListener('click', () => {
  const scope = state.me?.user.role === 'admin' ? '.admin-nav' : '.tenant-nav';
  const billingTarget = button.dataset.billingTarget ? `[data-billing-target="${button.dataset.billingTarget}"]` : '';
  const target = $(`${scope} [data-view="${button.dataset.viewLink}"]${billingTarget}`); if (target) navigateFromButton(target); else showView(button.dataset.viewLink);
}));
$$('[data-admin-dashboard-link]').forEach(button => button.addEventListener('click', () => {
  const target = $(`.admin-nav [data-admin-billing-tab="${button.dataset.adminDashboardLink}"]`); if (target) navigateFromButton(target);
}));
$('#refreshTenantDashboard').addEventListener('click', () => loadOverviewData().catch(handleError));
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
$('#configureMfaButton').addEventListener('click', () => {
  const form = $('#mfaForm'); form.reset(); const enabled = Boolean(state.mfa?.enabled); form.dataset.stage = enabled ? 'disable' : 'setup';
  $('#mfaDialogTitle').textContent = enabled ? '解绑动态验证' : '配置动态验证'; $('#mfaSetupFields').classList.toggle('hidden', enabled); $('#mfaConfirmFields').classList.add('hidden'); $('#mfaDisableFields').classList.toggle('hidden', !enabled);
  $('#mfaSubmitButton').textContent = enabled ? '确认解绑' : '生成密钥'; $('#mfaSubmitButton').className = enabled ? 'danger-button' : 'primary'; $('#mfaDialog').showModal();
});
$('#mfaForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#mfaSubmitButton'); button.disabled = true;
  try {
    if (form.dataset.stage === 'setup') {
      const result = await api('/api/account/mfa/setup', { method: 'POST', body: JSON.stringify({ currentPassword: form.elements.currentPassword.value }) });
      form.dataset.stage = 'confirm'; form.elements.secret.value = result.secret; form.elements.recoveryCodes.value = result.recoveryCodes.join('\n'); form.elements.code.value = '';
      $('#mfaSetupFields').classList.add('hidden'); $('#mfaConfirmFields').classList.remove('hidden'); button.textContent = '确认启用'; form.elements.code.focus(); return;
    }
    if (form.dataset.stage === 'confirm') { await api('/api/account/mfa/confirm', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value }) }); $('#mfaDialog').close(); await loadAccountSecurity(); return toast('MFA 已启用，请妥善保存恢复码'); }
    await api('/api/account/mfa', { method: 'DELETE', body: JSON.stringify({ currentPassword: form.elements.disablePassword.value, code: form.elements.disableCode.value }) }); $('#mfaDialog').close(); await loadAccountSecurity(); toast('MFA 已解绑');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});
$('#refreshSessions').addEventListener('click', () => loadAccountSecurity().catch(handleError));
$('#sessionTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-revoke-session]'); if (!button) return;
  if (!await confirmAction({ title: '撤销登录设备', message: '撤销后，该设备需要重新登录。', confirmLabel: '撤销会话', danger: true })) return;
  try { const result = await api(`/api/account/sessions/${button.dataset.revokeSession}`, { method: 'DELETE' }); if (result.current) return showLogin(); await loadAccountSecurity(); toast('登录设备已撤销'); } catch (error) { handleError(error); }
});
$('#createApiKey')?.addEventListener('click', () => {
  const form = $('#apiKeyForm'); form.reset(); form.elements.name.value = '自动化调用'; $('#apiKeyDialog').showModal();
  requestAnimationFrame(() => form.elements.name.focus());
});
$('#apiKeyForm')?.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type="submit"]', form); const name = form.elements.name.value.trim();
  if (!name) return form.elements.name.focus();
  button.disabled = true;
  try {
    const result = await api('/api/cdnfly/v1/api-key', { method: 'POST', body: JSON.stringify({ name }) });
    $('#apiKeyDialog').close();
    $('#generatedCodesTitle').textContent = 'API Key 已生成'; $('#generatedCodesNotice').textContent = '完整 API Key 只在本次显示，请立即复制并妥善保存。后台列表仅显示密钥前缀。'; $('#generatedCodesLabel').firstChild.textContent = 'API Key'; $('#generatedCodes').value = result.data.key; $('#generatedCodesDialog').showModal();
    await loadAccountSecurity();
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});
$('#apiKeyTable')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-revoke-api-key]'); if (!button) return;
  if (!await confirmAction({ title: '撤销 API Key', message: '撤销后使用该密钥的自动化请求将立即失效。', confirmLabel: '撤销密钥', danger: true })) return;
  try { await api(`/api/cdnfly/v1/api-key/${button.dataset.revokeApiKey}`, { method: 'DELETE' }); await loadAccountSecurity(); toast('API Key 已撤销'); } catch (error) { handleError(error); }
});
$('#newAdministratorButton').addEventListener('click', () => openAdministratorDialog());
$('#administratorTable').addEventListener('click', async event => { const edit = event.target.closest('[data-edit-administrator]'); const disable = event.target.closest('[data-disable-administrator]'); if (edit) return openAdministratorDialog(state.administrators.find(item => item.id === Number(edit.dataset.editAdministrator))); if (!disable) return; const item = state.administrators.find(row => row.id === Number(disable.dataset.disableAdministrator)); if (!await confirmAction({ title: '停用管理员', message: `确认停用 ${item.username}？该账号的全部会话将被撤销。`, confirmLabel: '停用', danger: true })) return; try { await api(`/api/admin/administrators/${item.id}`, { method: 'DELETE' }); await loadAdministrators(); toast('管理员已停用'); } catch (error) { handleError(error); } });
$('#administratorForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value; const body = { username: form.elements.username.value, email: form.elements.email.value, adminRole: form.elements.adminRole.value, ...(form.elements.password.value ? { password: form.elements.password.value } : {}), ...(id ? { status: form.elements.status.checked ? 'active' : 'disabled' } : {}) }; try { await api(`/api/admin/administrators${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#administratorDialog').close(); await loadAdministrators(); toast('管理员已保存'); } catch (error) { handleError(error); } });
$('#newInviteButton').addEventListener('click', () => { $('#inviteForm').reset(); $('#inviteDialog').showModal(); });
$('#inviteForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form)); body.count = Number(body.count); body.maxUses = Number(body.maxUses); if (body.expiresAt) body.expiresAt = new Date(body.expiresAt).toISOString(); try { const result = await api('/api/admin/security/invites', { method: 'POST', body: JSON.stringify(body) }); $('#inviteDialog').close(); $('#generatedCodesTitle').textContent = '注册邀请码已生成'; $('#generatedCodes').value = result.codes.map(item => item.code).join('\n'); $('#generatedCodesDialog').showModal(); await loadInvitations(); } catch (error) { handleError(error); } });
$('#invitations').addEventListener('click', async event => { const invite = event.target.closest('[data-disable-invite]'); if (!invite) return; if (!await confirmAction({ title: '停用邀请码', message: '停用后该邀请码将不能继续注册，历史使用记录会保留。', confirmLabel: '停用', danger: true })) return; try { await api(`/api/admin/security/invites/${invite.dataset.disableInvite}`, { method: 'DELETE' }); await loadInvitations(); toast('邀请码已停用'); } catch (error) { handleError(error); } });
$$('[data-action="new-site"]').forEach(button => button.addEventListener('click', () => openSiteDialog().catch(handleError)));
$('#siteForm').elements.groupId.addEventListener('change', () => applySiteDialogDefaults().catch(handleError));
$$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#siteSearch').addEventListener('input', renderSites);
$('#siteSearchType').addEventListener('change', renderSites);
$('#refreshSites').addEventListener('click', () => loadSites().catch(handleError));
$('#selectAllSites').addEventListener('change', event => {
  const query = ($('#siteSearch').value || '').trim().toLowerCase(); const type = $('#siteSearchType').value;
  const visible = state.sites.filter(site => {
    const fields = { domain: site.domain || '', origin: site.origin || '', cname: site.cname || '' };
    return type === 'all' ? Object.values(fields).some(value => value.toLowerCase().includes(query)) : fields[type].toLowerCase().includes(query);
  });
  visible.forEach(site => event.currentTarget.checked ? state.selectedSites.add(site.id) : state.selectedSites.delete(site.id)); renderSites();
});

async function bulkUpdateSites(enabled) {
  const sites = state.sites.filter(site => state.selectedSites.has(site.id) && site.enabled !== enabled);
  if (!sites.length) return toast(enabled ? '所选网站均已启用' : '所选网站均已停用');
  if (!await confirmAction({ title: enabled ? '批量启用网站' : '批量停用网站', message: `确认${enabled ? '启用' : '停用'}选中的 ${sites.length} 个网站？`, confirmLabel: enabled ? '批量启用' : '批量停用', danger: !enabled })) return;
  for (const site of sites) await api(`/api/sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
  state.selectedSites.clear(); await loadSites(); toast(`已${enabled ? '启用' : '停用'} ${sites.length} 个网站`);
}

$('#siteBulkEnable').addEventListener('click', () => bulkUpdateSites(true).catch(handleError));
$('#siteBulkDisable').addEventListener('click', () => bulkUpdateSites(false).catch(handleError));
$('#siteBulkDelete').addEventListener('click', async () => {
  const sites = state.sites.filter(site => state.selectedSites.has(site.id));
  if (sites.some(site => site.enabled)) return toast('批量删除前请先停用所选网站', true);
  if (!await confirmAction({ title: '批量删除网站', message: `确认删除选中的 ${sites.length} 个网站？此操作会同步删除 CDN 服务资源。`, confirmLabel: '批量删除', danger: true })) return;
  try { for (const site of sites) await api(`/api/sites/${site.id}`, { method: 'DELETE' }); state.selectedSites.clear(); await loadSites(); toast(`已删除 ${sites.length} 个网站`); } catch (error) { handleError(error); }
});
$('#siteApplyCert').addEventListener('click', () => {
  if (!state.selectedSites.size) return toast('请先选择要申请证书的网站', true);
  const target = $('.tenant-nav [data-view="security"][data-kind="certs"]'); navigateFromButton(target); openResourceDialog(null, 'certs').catch(handleError);
});

function siteCnameTargets() {
  const targets = new Map();
  for (const site of state.sites) {
    for (const rawDomain of String(site.domain || '').split(',')) {
      const domain = rawDomain.trim(); if (!domain) continue;
      const key = domain.toLowerCase();
      if (!targets.has(key)) targets.set(key, { domain, expected: site.cname || '' });
    }
  }
  return [...targets.values()];
}

function renderSiteAnalysisTable() {
  const query = ($('#siteAnalysisSearch')?.value || '').trim().toLowerCase();
  const targets = siteCnameTargets().filter(target => !query || `${target.domain} ${target.expected}`.toLowerCase().includes(query));
  const rows = targets.map(target => {
    const result = state.siteCnameChecks.get(target.domain.toLowerCase());
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong></td><td></td><td></td><td></td><td class="right"></td>';
    $('strong', tr).textContent = target.domain; tr.children[1].textContent = result?.expected || target.expected || '-';
    tr.children[2].textContent = result?.error || result?.resolved?.join(' → ') || (result?.loading ? '检测中...' : '-');
    tr.children[3].innerHTML = result?.loading
      ? '<span class="badge pending">检测中</span>'
      : result?.error ? '<span class="badge off">检测失败</span>'
        : result ? `<span class="badge ${result.ok ? 'active' : 'off'}">${result.ok ? '已通过' : '未通过'}</span>`
          : '<span class="badge pending">未检测</span>';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = '检测'; button.dataset.checkSiteCname = target.domain; button.disabled = Boolean(result?.loading); tr.lastElementChild.append(button);
    return tr;
  });
  $('#siteAnalysisTable').replaceChildren(...rows); $('#siteAnalysisEmpty').classList.toggle('hidden', rows.length !== 0);
  $('#siteAnalysisCount').textContent = `${rows.length} 个域名`;
  $('#checkAllSiteCnames').disabled = rows.length === 0 || [...state.siteCnameChecks.values()].some(item => item.loading);
}

async function checkSiteAnalysisDomains(domains) {
  const unique = [...new Set(domains.map(domain => domain.trim()).filter(Boolean))]; if (!unique.length) return;
  unique.forEach(domain => state.siteCnameChecks.set(domain.toLowerCase(), { loading: true })); renderSiteAnalysisTable();
  try {
    const response = await api('/api/cdnfly/v1/cname-check', { method: 'POST', body: JSON.stringify(unique.length === 1 ? { domain: unique[0] } : unique) });
    const results = Array.isArray(response.data?.items) ? response.data.items : [response.data];
    for (const result of results) state.siteCnameChecks.set(String(result.domain || '').toLowerCase(), result);
  } catch (error) {
    unique.forEach(domain => state.siteCnameChecks.set(domain.toLowerCase(), { error: error.message || '检测失败' })); handleError(error);
  } finally { renderSiteAnalysisTable(); }
}

$('#siteAnalysisEntry').addEventListener('click', () => {
  state.siteCnameChecks = new Map(); $('#siteListPane').classList.add('hidden'); $('#siteAnalysisPane').classList.remove('hidden');
  $$('[data-site-workbench], #siteAnalysisEntry').forEach(item => item.classList.toggle('active', item.id === 'siteAnalysisEntry'));
  renderSiteAnalysisTable();
});
$('#siteAnalysisSearch').addEventListener('input', renderSiteAnalysisTable);
$('#checkAllSiteCnames').addEventListener('click', () => checkSiteAnalysisDomains(siteCnameTargets().map(item => item.domain)));
$('#siteAnalysisTable').addEventListener('click', event => {
  const button = event.target.closest('[data-check-site-cname]'); if (button) checkSiteAnalysisDomains([button.dataset.checkSiteCname]);
});

$('#siteForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const body = {
    subscriptionId: Number(values.subscriptionId),
    groupId: values.groupId ? Number(values.groupId) : null,
    origin: values.origin,
    backendProtocol: values.backendProtocol,
    backendHost: values.backendHost || values.domain || state.sites.find(site => site.id === Number(values.siteId))?.domain,
    websocket: form.websocket.checked,
    gzip: form.gzip.checked,
  };
  try {
    if (values.siteId) await api(`/api/sites/${values.siteId}`, { method: 'PUT', body: JSON.stringify(body) });
    else { body.domain = values.domain; await api('/api/sites', { method: 'POST', body: JSON.stringify(body) }); }
    $('#siteDialog').close(); await Promise.all([loadSites(), refreshTenantBillingState()]); toast(values.siteId ? '网站配置已保存' : '网站创建成功');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#siteTable').addEventListener('click', async event => {
  const manage = event.target.closest('[data-manage]'); const waf = event.target.closest('[data-waf]'); const toggle = event.target.closest('[data-toggle]'); const remove = event.target.closest('[data-delete]');
  if (manage) { openSiteDetail(state.sites.find(site => site.id === Number(manage.dataset.manage))); return refreshSiteDetail().catch(handleError); }
  if (waf) return openWafDialog(state.sites.find(site => site.id === Number(waf.dataset.waf))).catch(handleError);
  try {
    if (toggle) {
      const site = state.sites.find(item => item.id === Number(toggle.dataset.toggle));
      await api(`/api/sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !site.enabled }) });
      await loadSites(); toast(site.enabled ? '网站已停用' : '网站已启用');
    }
    if (remove) {
      const site = state.sites.find(item => item.id === Number(remove.dataset.delete));
      if (site.enabled) return toast('请先停用网站再删除', true);
      if (!await confirmAction({ title: '删除网站', message: `确认删除 ${site.domain}？此操作会同步从 CDN 服务删除该网站，且无法撤销。`, confirmLabel: '删除网站', danger: true })) return;
      await api(`/api/sites/${site.id}`, { method: 'DELETE' }); await loadSites(); toast('网站已删除');
    }
  } catch (error) { handleError(error); }
});
$('#siteTable').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-select-site]'); if (!checkbox) return;
  const id = Number(checkbox.dataset.selectSite); checkbox.checked ? state.selectedSites.add(id) : state.selectedSites.delete(id); updateSiteSelectionControls();
});

$('#backToSites').addEventListener('click', () => navigateFromButton($('.tenant-nav [data-view="sites"]')));
$('#cancelSiteDetail').addEventListener('click', () => renderSiteDetail(state.currentSite, state.currentSiteConfig));
$('#syncSiteDetail').addEventListener('click', async () => { try { await refreshSiteDetail(); toast('网站配置已同步'); } catch (error) { handleError(error); } });
$('#checkSiteCname').addEventListener('click', async event => {
  const button = event.currentTarget; const domain = state.currentSite?.domain?.split(',')[0]?.trim();
  if (!domain) return toast('当前网站没有可检查的域名', true);
  button.disabled = true;
  try {
    const result = await api('/api/cdnfly/v1/cname-check', { method: 'POST', body: JSON.stringify({ domain }) });
    const data = result.data || {}; const value = data.success ?? data.ok ?? data.valid ?? (typeof data.result === 'boolean' ? data.result : undefined);
    const actual = Array.isArray(data.resolved) && data.resolved.length ? data.resolved.join('、') : '未解析到 CNAME';
    const expected = data.expected || state.currentSite?.cname || '尚未生成目标';
    toast(value === true ? `CNAME 解析检查通过：${actual}` : value === false ? `CNAME 解析未通过：当前 ${actual}，目标 ${expected}` : 'CNAME 检查已返回，请核对 DNS 记录', value === false);
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});
$('#detailSiteWaf')?.addEventListener('click', () => openWafDialog(state.currentSite).catch(handleError));
$('#detailSiteMonitor')?.addEventListener('click', () => {
  const target = $('.tenant-nav [data-view="data"][data-data-tab="monitor"]'); navigateFromButton(target);
  requestAnimationFrame(() => { const select = $('#monitorForm')?.elements.siteId; if (select) select.value = String(state.currentSite.id); });
});
$('#addSiteBackend').addEventListener('click', () => addSiteBackendRow());
$('#addSiteCacheRule').addEventListener('click', () => addSiteCacheRuleRow());
$('#addSiteRequestHeader').addEventListener('click', () => addSiteHeaderRow('siteRequestHeaderList'));
$('#addSiteResponseHeader').addEventListener('click', () => addSiteHeaderRow('siteResponseHeaderList'));
$('#addSiteRewrite').addEventListener('click', () => addSiteRewriteRow());
for (const container of [$('#siteBackendList'), $('#siteCacheRuleList'), $('#siteRequestHeaderList'), $('#siteResponseHeaderList'), $('#siteRewriteList')]) container.addEventListener('click', event => {
  if (container.id === 'siteCacheRuleList') {
    const cacheRow = event.target.closest('.site-cache-row');
    if (event.target.closest('[data-add-no-cache]')) { addSiteNoCacheRow(cacheRow); return; }
    const removeCondition = event.target.closest('[data-remove-no-cache]');
    if (removeCondition) { removeCondition.closest('.cache-exclusion-row').remove(); return; }
  }
  const remove = event.target.closest('[data-remove-site-row]'); if (!remove) return;
  const row = remove.closest('.rule-row, .config-rule-card');
  if (container.id === 'siteBackendList' && $$('.rule-row', container).length === 1) return toast('至少保留一个源站', true);
  row.remove();
});
$$('[data-site-section]').forEach(button => button.addEventListener('click', () => activateSiteSection(button.dataset.siteSection)));
$$('[data-site-workbench]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.siteWorkbench === 'list') {
    $('#siteAnalysisPane').classList.add('hidden'); $('#siteListPane').classList.remove('hidden');
    $$('[data-site-workbench], #siteAnalysisEntry').forEach(item => item.classList.toggle('active', item === button));
    return;
  }
  if (button.dataset.siteWorkbench === 'defaults') {
    const target = $('.tenant-nav [data-view="sites"]');
    return navigateToUserConfigs('site', target);
  }
  const routes = { groups: 'site-groups', dns: 'dnsapis' }; const kind = routes[button.dataset.siteWorkbench];
  if (!kind) return;
  $$('[data-site-workbench]').forEach(item => item.classList.toggle('active', item === button));
  const target = $('.tenant-nav [data-view="security"][data-kind="' + kind + '"]');
  state.resourceKind = kind;
  if (target) return navigateFromButton(target);
  syncResourcePageContext();
  const source = $('.tenant-nav [data-view="sites"]');
  showView('security', source);
  const title = button.querySelector('strong')?.textContent || resourceNames[kind];
  $('#pageTitle').textContent = title; $('#breadcrumb').textContent = `用户中心 / ${title}`;
}));
$('#siteDetailForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    const normalizePorts = value => value.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
    const validPorts = value => !value || value.split(' ').every(port => Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535);
    const current = state.currentSiteConfig || {};
    let body;
    if (state.currentSiteSection === 'siteBasic') {
      body = { group_id: form.elements.groupId.value ? Number(form.elements.groupId.value) : 0,
        subscriptionId: Number(form.elements.subscriptionId.value), enable: form.elements.enabled.checked ? 1 : 0 };
    } else if (state.currentSiteSection === 'siteHttp') {
      const httpPorts = normalizePorts(form.elements.httpPorts.value);
      if (!validPorts(httpPorts)) throw new Error('HTTP 监听端口必须是 1 到 65535 的数字，多个端口使用空格分隔');
      body = { http_listen: { ...(current.http_listen || {}), port: httpPorts, enable: form.elements.httpEnabled.checked ? 1 : 0 } };
    } else if (state.currentSiteSection === 'siteOrigin') {
      const backends = $$('.site-backend-row', $('#siteBackendList')).map(row => ({ ...row.originalValue,
        addr: $('[data-field="addr"]', row).value.trim(), weight: Number($('[data-field="weight"]', row).value), state: $('[data-field="state"]', row).value }));
      if (!backends.length || backends.some(item => !item.addr || !Number.isInteger(item.weight) || item.weight < 1)) throw new Error('请完整填写有效的源站地址和权重');
      if (!backends.some(item => item.state === 'up')) throw new Error('至少保留一个在线源站');
      for (const [label, value] of [['HTTP 回源端口', form.elements.backendHttpPort.value], ['HTTPS 回源端口', form.elements.backendHttpsPort.value]]) {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${label}必须是 1 到 65535 的数字`);
      }
      const proxySslProtocols = selectedTlsProtocols(form, 'proxySslProtocol');
      if (form.elements.backendProtocol.value === 'https' && !proxySslProtocols.length) throw new Error('HTTPS 回源时请至少选择一个回源 SSL 协议');
      body = { backend: backends, backend_protocol: form.elements.backendProtocol.value, balance_way: form.elements.balanceWay.value,
        backend_http_port: form.elements.backendHttpPort.value.trim(), backend_https_port: form.elements.backendHttpsPort.value.trim(), backend_host: form.elements.backendHost.value.trim(),
        proxy_timeout: form.elements.proxyTimeout.value ? Number(form.elements.proxyTimeout.value) : '', proxy_http_version: form.elements.proxyHttpVersion.value,
        proxy_ssl_protocols: proxySslProtocols.join(' '), backend_port_mapping: form.elements.backendPortMapping.checked ? 1 : 0,
        ups_keepalive: form.elements.keepalive.checked ? 1 : 0, ups_keepalive_conn: Number(form.elements.keepaliveConnections.value || 0), ups_keepalive_timeout: Number(form.elements.keepaliveTimeout.value || 0),
        range: form.elements.range.checked ? 1 : 0,
        health_check: { ...(current.health_check || {}), enable: form.elements.healthEnabled.checked ? 1 : 0, protocol: form.elements.healthProtocol.value,
          host: form.elements.healthHost.value.trim(), path: form.elements.healthPath.value.trim() || '/', status_code: form.elements.healthStatusCode.value.trim() || '200 301 302', interval: Number(form.elements.healthInterval.value || 0) } };
    } else if (state.currentSiteSection === 'siteHttps') {
      const httpsPorts = normalizePorts(form.elements.httpsPorts.value); const sslProtocols = selectedTlsProtocols(form);
      if (!validPorts(httpsPorts)) throw new Error('HTTPS 监听端口必须是 1 到 65535 的数字，多个端口使用空格分隔');
      if (form.elements.httpsEnabled.checked && !sslProtocols.length) throw new Error('启用 HTTPS 时请至少选择一个 TLS 协议');
      if (form.elements.httpsEnabled.checked && !form.elements.httpsCert.value) throw new Error('启用 HTTPS 时请选择证书');
      const currentHttps = current.https_listen || {}; const currentHttpsEnabled = enabledValue(currentHttps.ok ?? currentHttps.enable ?? Boolean(currentHttps.cert));
      const httpsListen = { ...currentHttps, ok: form.elements.httpsEnabled.checked ? 1 : 0, port: httpsPorts,
        hsts: form.elements.hsts.checked ? 1 : 0, http2: form.elements.http2.checked ? 1 : 0, http3: form.elements.http3.checked ? 1 : 0,
        ocsp_stapling: form.elements.ocspStapling.checked ? 1 : 0, force_ssl_enable: form.elements.forceSsl.checked ? 1 : 0,
        force_ssl_port: form.elements.forceSslPort.value.trim(), ssl_protocols: sslProtocols.join(' '),
        ssl_ciphers: form.elements.sslCiphers.value.trim() || DEFAULT_SSL_CIPHERS, ssl_prefer_server_ciphers: form.elements.sslPreferServerCiphers.checked ? 'on' : 'off' };
      if (form.elements.httpsEnabled.checked) httpsListen.cert = Number(form.elements.httpsCert.value);
      else if (currentHttpsEnabled) httpsListen.cert = currentHttps.cert;
      body = form.elements.httpsEnabled.checked || currentHttpsEnabled ? { https_listen: httpsListen } : {};
    } else if (state.currentSiteSection === 'siteCache') {
      body = { proxy_cache: $$('.site-cache-row', $('#siteCacheRuleList')).map(row => {
        const type = $('[data-field="type"]', row).value; const content = $('[data-field="content"]', row).value.trim(); const expire = Number($('[data-field="expire"]', row).value);
        if (!content) throw new Error('缓存规则必须填写匹配内容');
        if (!Number.isFinite(expire) || expire < 0) throw new Error('缓存有效期必须是大于或等于 0 的数字');
        const noCache = $$('.cache-exclusion-row', row).map(condition => {
          const variable = $('[data-field="variable"]', condition).value.trim(); const string = $('[data-field="string"]', condition).value.trim();
          if (!variable || !string) throw new Error('不缓存条件的变量和匹配字符串必须同时填写');
          return { ...condition.originalValue, variable, string };
        });
        return { ...row.originalValue, type, content, expire, unit: normalizeSiteCacheUnit($('[data-field="unit"]', row).value),
          ignore_arg: $('[data-field="ignore_arg"]', row).checked ? 1 : 0,
          proxy_ignore_headers: $('[data-field="force_cache"]', row).checked ? (row.originalValue?.proxy_ignore_headers || 'X-Accel-Expires Expires Cache-Control Set-Cookie') : '', no_cache: noCache };
      }) };
    } else if (state.currentSiteSection === 'siteSecurity') {
      const ccDefaultRule = form.elements.ccDefaultRule.value ? Number(form.elements.ccDefaultRule.value) : null;
      const ccSwitchRule = form.elements.ccSwitchRule.value ? Number(form.elements.ccSwitchRule.value) : null;
      if (form.elements.ccSwitchEnabled.checked && (!ccSwitchRule || !form.elements.ccSwitchThreshold.value)) throw new Error('开启自动提升防护时必须选择规则并填写触发 QPS');
      const ccSwitch = ccSwitchRule ? { ...(current.cc_switch || {}), rule: ccSwitchRule, switch: Number(form.elements.ccSwitchThreshold.value || 0), enable: form.elements.ccSwitchEnabled.checked ? 1 : 0 }
        : current.cc_switch?.rule && !form.elements.ccSwitchEnabled.checked ? { ...current.cc_switch, enable: 0 } : null;
      body = { ...(ccDefaultRule ? { cc_default_rule: ccDefaultRule } : {}), ...(ccSwitch ? { cc_switch: ccSwitch } : {}),
        block_proxy: form.elements.blockProxy.checked ? 1 : 0, black_ip: form.elements.blackIp.value.trim(), white_ip: form.elements.whiteIp.value.trim(), block_region: form.elements.blockRegion.value.trim() };
    } else if (state.currentSiteSection === 'siteAccess') {
      body = { acl: form.elements.acl.value ? Number(form.elements.acl.value) : null,
        hotlink: { ...(current.hotlink || {}), enable: form.elements.hotlinkEnabled.checked ? 1 : 0, domain: form.elements.hotlinkDomains.value.trim(),
          allow_empty: form.elements.hotlinkAllowEmpty.checked ? 1 : 0, scope_type: current.hotlink?.scope_type || 'suffix', scope_content: form.elements.hotlinkScopeContent.value.trim() },
        cors: { ...(current.cors || {}), enable: form.elements.corsEnabled.checked ? 1 : 0, allow_origin: form.elements.corsOrigin.value.trim(),
          allow_methods: form.elements.corsMethods.value.trim(), allow_headers: form.elements.corsHeaders.value.trim(),
          expose_headers: form.elements.corsExposeHeaders.value.trim(), allow_credentials: form.elements.corsCredentials.checked ? 1 : 0, max_age: String(form.elements.corsMaxAge.value || '0') } };
    } else {
      const headersFrom = container => $$('.site-header-row', container).map(row => {
        const name = $('[data-field="name"]', row).value.trim(); const value = $('[data-field="value"]', row).value.trim();
        if (!name || !value) throw new Error('请求头和响应头必须同时填写名称和值');
        return { ...row.originalValue, name, value };
      });
      const rewrites = $$('.site-rewrite-row', $('#siteRewriteList')).map(row => {
        const host = $('[data-field="host"]', row).value.trim(); const match = $('[data-field="match"]', row).value.trim(); const redirect = $('[data-field="redirect"]', row).value.trim();
        if (!host || !match || !redirect) throw new Error('URL 转向必须完整填写域名端口、匹配 URL 和目标 URL');
        return { ...row.originalValue, host, match, redirect, code: $('[data-field="code"]', row).value };
      });
      body = { websocket_enable: form.elements.websocket.checked ? 1 : 0, gzip_enable: form.elements.gzip.checked ? 1 : 0, gzip_types: form.elements.gzipTypes.value.trim(),
        enable_ipv6: form.elements.ipv6.checked ? 1 : 0, recv_real_time: form.elements.recvRealTime.checked ? 1 : 0,
        send_real_time: form.elements.sendRealTime.checked ? 1 : 0, acme_proxy_to_orgin: form.elements.acmeProxyToOrigin.checked ? 1 : 0,
        spider_to_sip: form.elements.spiderToSip.value.trim(), post_size_limit: form.elements.postSizeLimit.value ? `${form.elements.postSizeLimit.value}${form.elements.postSizeUnit.value}` : '',
        page_403: form.elements.page403.value.trim(), page_404: form.elements.page404.value.trim(), page_500: form.elements.page500.value.trim(),
        page_502: form.elements.page502.value.trim(), page_504: form.elements.page504.value.trim(),
        req_header: headersFrom($('#siteRequestHeaderList')), resp_header: headersFrom($('#siteResponseHeaderList')), url_rewrite: rewrites };
    }
    const currentId = state.currentSite.id;
    await api(`/api/cdnfly/v1/sites/${currentId}`, { method: 'PUT', body: JSON.stringify(body) });
    await Promise.all([loadSites(), refreshTenantBillingState()]); state.currentSite = state.sites.find(item => item.id === currentId) || state.currentSite;
    await refreshSiteDetail(); toast('网站配置已保存');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

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

$('#refreshBilling').addEventListener('click', () => loadBilling().catch(handleError));
$('#planCatalogTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-buy-plan]'); if (!button) return;
  const plan = state.billingPlans.find(item => item.id === Number(button.dataset.buyPlan));
  const balanceAfter = state.wallet.balanceCents - Number(plan.priceCents);
  if (!await confirmAction({ title: '确认购买套餐', message: `${plan.name} · ${plan.durationDays} 天 · 支付 ${formatMoney(plan.priceCents)}。支付后余额 ${formatMoney(balanceAfter)}，套餐立即生效。`, confirmLabel: '余额支付' })) return;
  try { await api('/api/cdnfly/v1/user-packages', { method: 'POST', body: JSON.stringify({ planId: plan.id }) }); await loadBilling(); toast('支付成功，套餐已生效'); } catch (error) { handleError(error); }
});
$('#addonCatalogTable').addEventListener('click', async event => {
  const upgrade = event.target.closest('[data-buy-upgrade]'); const traffic = event.target.closest('[data-buy-traffic]'); if (!upgrade && !traffic) return;
  const subscriptionId = Number($('#addonSubscriptionSelect').value); if (!subscriptionId) return toast('请选择有效套餐', true);
  try {
    const item = upgrade ? state.billingUpgrades.find(row => row.id === Number(upgrade.dataset.buyUpgrade)) : state.billingTraffic.find(row => row.id === Number(traffic.dataset.buyTraffic));
    if (!await confirmAction({ title: '确认购买权益', message: `${item.name} · 目标套餐 #${subscriptionId} · 支付 ${formatMoney(item.price_cents)}。支付后余额 ${formatMoney(state.wallet.balanceCents - Number(item.price_cents))}。`, confirmLabel: '余额支付' })) return;
    if (upgrade) await api(`/api/cdnfly/v1/user-package/${subscriptionId}/upgrades`, { method: 'POST', body: JSON.stringify({ upgradeId: Number(upgrade.dataset.buyUpgrade), amount: 1 }) });
    else await api('/api/cdnfly/v1/user-traffic-packages', { method: 'POST', body: JSON.stringify({ trafficPackageId: Number(traffic.dataset.buyTraffic), subscriptionId }) });
    await loadBilling(); toast('支付成功，权益已生效');
  } catch (error) { handleError(error); }
});
$('#subscriptionCards').addEventListener('change', async event => {
  const input = event.target.closest('[data-auto-renew]'); if (!input) return;
  try { await api(`/api/cdnfly/v1/user-packages/${input.dataset.autoRenew}`, { method: 'PUT', body: JSON.stringify({ autoRenew: input.checked }) }); await loadBilling(); toast(input.checked ? '已开启自动续费' : '已关闭自动续费'); }
  catch (error) { input.checked = !input.checked; handleError(error); }
});
$('#subscriptionCards').addEventListener('click', async event => {
  const changeButton = event.target.closest('[data-change-subscription]');
  if (changeButton) return openPlanChangeDialog(Number(changeButton.dataset.changeSubscription));
  const button = event.target.closest('[data-renew-subscription]'); if (!button) return; const item = tenantSubscriptions().find(row => row.subscription.id === Number(button.dataset.renewSubscription));
  if (!item) return; if (!await confirmAction({ title: '确认续费', message: `${item.plan.name} 将在当前到期时间基础上延长 ${item.plan.durationDays} 天，并从余额支付 ${formatMoney(item.plan.priceCents)}。`, confirmLabel: '立即续费' })) return;
  try { await api(`/api/cdnfly/v1/user-packages/${item.subscription.id}/renew`, { method: 'POST', body: '{}' }); await loadBilling(); toast('套餐续费成功'); } catch (error) { handleError(error); }
});
$('#planChangeForm').elements.package.addEventListener('change', () => refreshPlanChangeQuote().catch(handleError));
$('#planChangeForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#planChangeSubmit');
  if (!state.planChangeQuote) return;
  button.disabled = true;
  try {
    const diffCents = Number(state.planChangeQuote.diff_price_cents);
    await api('/api/cdnfly/v1/user-packages', { method: 'PUT', body: JSON.stringify({ id: Number(form.elements.subscriptionId.value), package: Number(form.elements.package.value) }) });
    $('#planChangeDialog').close(); await loadBilling();
    toast(diffCents > 0 ? '升配成功，差价已扣除' : diffCents < 0 ? '降配成功，差价已退回余额' : '套餐已变更');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});
$('#redeemForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try { await api('/api/billing/redeem', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value }) }); form.reset(); await loadBilling(); toast('兑换成功，权益已生效'); } catch (error) { handleError(error); } finally { button.disabled = false; }
});
$('#rechargeCodeForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try { const result = await api('/api/billing/recharge-code', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value }) }); form.reset(); await loadBilling(); toast(`充值成功，到账 ${formatMoney(result.amountCents)}`); } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#adminBillingTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-billing-tab]'); if (!button) return;
  setAdminBillingTab(button.dataset.billingTab);
});
$('#newPlanButton').addEventListener('click', () => openPlanDialog());
$('#newGroupButton').addEventListener('click', () => openCatalogDialog('group'));
$('#newUpgradeButton').addEventListener('click', () => openCatalogDialog('upgrade'));
$('#newTrafficButton').addEventListener('click', () => openCatalogDialog('traffic'));
$('#newSubscriptionButton').addEventListener('click', () => openSubscriptionDialog());
$('#newRedemptionButton').addEventListener('click', () => { $('#redemptionForm').reset(); updateRedemptionProducts(); $('#redemptionDialog').showModal(); });
$('#newRechargeCodeButton').addEventListener('click', () => { $('#rechargeCodeAdminForm').reset(); $('#rechargeCodeDialog').showModal(); });
$('#redemptionForm').elements.type.addEventListener('change', updateRedemptionProducts);
$('#redemptionForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = { type: form.elements.type.value, productId: Number(form.elements.productId.value), count: Number(form.elements.count.value), maxUses: Number(form.elements.maxUses.value), amount: Number(form.elements.amount.value), label: form.elements.label.value.trim() };
  if (form.elements.expiresAt.value) body.expiresAt = new Date(form.elements.expiresAt.value).toISOString();
  try { const result = await api('/api/admin/billing/redemption-codes', { method: 'POST', body: JSON.stringify(body) }); $('#redemptionDialog').close(); $('#generatedCodesTitle').textContent = '权益兑换码已生成'; $('#generatedCodes').value = result.codes.map(item => item.code).join('\n'); $('#generatedCodesDialog').showModal(); await loadBillingAdmin(); } catch (error) { handleError(error); }
});
$('#rechargeCodeAdminForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = { amountCents: Math.round(Number(form.elements.amount.value) * 100), count: Number(form.elements.count.value), maxUses: Number(form.elements.maxUses.value), label: form.elements.label.value.trim() };
  if (form.elements.expiresAt.value) body.expiresAt = new Date(form.elements.expiresAt.value).toISOString();
  try { const result = await api('/api/admin/billing/recharge-codes', { method: 'POST', body: JSON.stringify(body) }); $('#rechargeCodeDialog').close(); $('#generatedCodesTitle').textContent = '余额充值码已生成'; $('#generatedCodes').value = result.codes.map(item => item.code).join('\n'); $('#generatedCodesDialog').showModal(); await loadBillingAdmin(); } catch (error) { handleError(error); }
});
$('#walletAdjustForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const amountCents = Math.round(Number(form.elements.amount.value) * 100);
  const wallet = state.billingAdmin.wallets.find(item => item.userId === Number(form.elements.userId.value)); const next = Number(wallet.balanceCents) + amountCents;
  if (!await confirmAction({ title: '确认调整余额', message: `${wallet.username}：${formatMoney(wallet.balanceCents)} ${amountCents > 0 ? '+' : '-'} ${formatMoney(Math.abs(amountCents))} = ${formatMoney(next)}。原因：${form.elements.description.value.trim()}`, confirmLabel: '确认调整', danger: amountCents < 0 })) return;
  try { await api(`/api/admin/billing/wallets/${form.elements.userId.value}/adjust`, { method: 'POST', body: JSON.stringify({ amountCents, description: form.elements.description.value.trim() }) }); $('#walletAdjustDialog').close(); await loadBillingAdmin(); toast('客户余额已调整'); } catch (error) { handleError(error); }
});
$('#copyGeneratedCodes').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#generatedCodes').value); toast('兑换码已复制'); } catch { toast('浏览器不允许自动复制，请手动选择', true); } });

$('#planForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value; const nullableInt = value => value === '' ? null : Number(value);
  const mapping = form.elements.upstreamMapping.value; const separator = mapping.indexOf(':');
  const body = { code: form.elements.code.value.trim(), name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), priceCents: Math.round(Number(form.elements.price.value) * 100), durationDays: Number(form.elements.durationDays.value), domainLimit: nullableInt(form.elements.domainLimit.value), trafficLimitBytes: form.elements.trafficGiB.value === '' ? null : Math.round(Number(form.elements.trafficGiB.value) * GIB), portLimit: nullableInt(form.elements.portLimit.value), groupId: form.elements.groupId.value === '' ? null : Number(form.elements.groupId.value), upstreamId: Number(mapping.slice(0, separator)), upstreamPackageId: mapping.slice(separator + 1), enabled: form.elements.enabled.checked };
  try { await api(`/api/admin/billing/plans${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#planDialog').close(); await loadBillingAdmin(); toast('套餐已保存'); } catch (error) { handleError(error); }
});

async function saveCatalogForm(type, form) {
  const id = form.elements.id.value; let path; let body;
  if (type === 'group') { path = 'groups'; body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), sort: Number(form.elements.sort.value), enabled: form.elements.enabled.checked }; }
  if (type === 'upgrade') { path = 'upgrades'; body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), priceCents: Math.round(Number(form.elements.price.value) * 100), domainIncrement: Number(form.elements.domainIncrement.value), trafficIncrementBytes: Math.round(Number(form.elements.trafficGiB.value) * GIB), portIncrement: Number(form.elements.portIncrement.value), enabled: form.elements.enabled.checked }; }
  if (type === 'traffic') { path = 'traffic-packages'; body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), priceCents: Math.round(Number(form.elements.price.value) * 100), trafficBytes: Math.round(Number(form.elements.trafficGiB.value) * GIB), durationDays: Number(form.elements.durationDays.value), enabled: form.elements.enabled.checked }; }
  await api(`/api/admin/billing/${path}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $(`#${type}Dialog`).close(); await loadBillingAdmin(); toast('目录项已保存');
}
for (const type of ['group', 'upgrade', 'traffic']) $(`#${type}Form`).addEventListener('submit', event => { event.preventDefault(); saveCatalogForm(type, event.currentTarget).catch(handleError); });

$('#subscriptionForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = { userId: Number(form.elements.userId.value), planId: Number(form.elements.planId.value) };
  if (form.elements.startsAt.value) body.startsAt = new Date(form.elements.startsAt.value).toISOString();
  if (form.elements.endsAt.value) body.endsAt = new Date(form.elements.endsAt.value).toISOString();
  try { await api('/api/admin/billing/subscriptions', { method: 'POST', body: JSON.stringify(body) }); $('#subscriptionDialog').close(); await loadBillingAdmin(); toast('套餐已分配'); } catch (error) { handleError(error); }
});

$('#billing-admin').addEventListener('click', async event => {
  const editPlan = event.target.closest('[data-edit-plan]'); const disablePlan = event.target.closest('[data-disable-plan]'); const editGroup = event.target.closest('[data-edit-group]'); const disableGroup = event.target.closest('[data-disable-group]'); const editUpgrade = event.target.closest('[data-edit-upgrade]'); const disableUpgrade = event.target.closest('[data-disable-upgrade]'); const editTraffic = event.target.closest('[data-edit-traffic]'); const disableTraffic = event.target.closest('[data-disable-traffic]'); const disableCode = event.target.closest('[data-disable-code]'); const codeUses = event.target.closest('[data-code-uses]'); const cancelSubscription = event.target.closest('[data-cancel-subscription]'); const adjustWallet = event.target.closest('[data-adjust-wallet]'); const disableRecharge = event.target.closest('[data-disable-recharge]'); const rechargeUses = event.target.closest('[data-recharge-uses]'); const orderDetail = event.target.closest('[data-order-detail]');
  if (editPlan) return openPlanDialog(state.billingAdmin.plans.find(item => item.id === Number(editPlan.dataset.editPlan)));
  if (editGroup) return openCatalogDialog('group', state.billingAdmin.groups.find(item => item.id === Number(editGroup.dataset.editGroup)));
  if (editUpgrade) return openCatalogDialog('upgrade', state.billingAdmin.upgrades.find(item => item.id === Number(editUpgrade.dataset.editUpgrade)));
  if (editTraffic) return openCatalogDialog('traffic', state.billingAdmin.trafficPackages.find(item => item.id === Number(editTraffic.dataset.editTraffic)));
  if (adjustWallet) { const wallet = state.billingAdmin.wallets.find(item => item.userId === Number(adjustWallet.dataset.adjustWallet)); const form = $('#walletAdjustForm'); form.reset(); form.elements.userId.value = wallet.userId; $('#walletAdjustTitle').textContent = `调整 ${wallet.username} 的余额`; return $('#walletAdjustDialog').showModal(); }
  if (orderDetail) return openOrderDetail(Number(orderDetail.dataset.orderDetail)).catch(handleError);
  try {
    let path; let message;
    if (disablePlan) { path = `plans/${disablePlan.dataset.disablePlan}`; message = '套餐已停用'; }
    if (disableGroup) { path = `groups/${disableGroup.dataset.disableGroup}`; message = '分组已停用'; }
    if (disableUpgrade) { path = `upgrades/${disableUpgrade.dataset.disableUpgrade}`; message = '增值项已停用'; }
    if (disableTraffic) { path = `traffic-packages/${disableTraffic.dataset.disableTraffic}`; message = '流量包已停用'; }
    if (disableCode) { path = `redemption-codes/${disableCode.dataset.disableCode}`; message = '兑换码已停用'; }
    if (disableRecharge) { path = `recharge-codes/${disableRecharge.dataset.disableRecharge}`; message = '充值码已停用'; }
    if (cancelSubscription) { path = `subscriptions/${cancelSubscription.dataset.cancelSubscription}`; message = '用户套餐已取消'; }
    if (path) { if (!await confirmAction({ title: '确认停用', message: '历史交易和审计记录会保留，停用后的目录项或兑换码不能继续使用。', confirmLabel: '确认停用', danger: true })) return; await api(`/api/admin/billing/${path}`, { method: 'DELETE' }); await loadBillingAdmin(); return toast(message); }
    if (codeUses) { const result = await api(`/api/admin/billing/redemption-codes/${codeUses.dataset.codeUses}/uses`); return showRecords('权益兑换记录', result.uses.map(item => ({ title: `${item.username} · 订单 #${item.orderId}`, detail: formatDate(item.redeemedAt) })), '该兑换码暂无使用记录'); }
    if (rechargeUses) { const result = await api(`/api/admin/billing/recharge-codes/${rechargeUses.dataset.rechargeUses}/uses`); return showRecords('余额充值记录', result.uses.map(item => ({ title: `${item.username} · ${formatMoney(item.amountCents)}`, detail: formatDate(item.redeemedAt) })), '该充值码暂无使用记录'); }
  } catch (error) { handleError(error); }
});
$('#refundOrderButton').addEventListener('click', async event => { const id = event.currentTarget.dataset.orderId; if (!await confirmAction({ title: '全额退款', message: `确认将订单 #${id} 的 ${formatMoney(state.currentOrder?.amountCents)} 原路退回客户余额？对应权益会一并回滚。`, confirmLabel: '确认退款', danger: true })) return; try { await api(`/api/admin/billing/orders/${id}/refund`, { method: 'POST', body: '{}' }); $('#orderDetailDialog').close(); await loadBillingAdmin(); toast('订单已退款，权益已回滚'); } catch (error) { handleError(error); } });
$('#refreshFinanceReport').addEventListener('click', async () => {
  const filters = { from: $('#financeFrom').value, to: nextDate($('#financeTo').value) }; const params = new URLSearchParams(filters); for (const [key, value] of [...params]) if (!value) params.delete(key);
  try { state.billingAdmin.finance = await api(`/api/admin/billing/finance/summary${params.size ? `?${params}` : ''}`); renderAdminBilling(); toast('财务报表已刷新'); } catch (error) { handleError(error); }
});

$('#enforceBilling').addEventListener('click', async () => {
  try { const result = await api('/api/admin/billing/enforce', { method: 'POST', body: '{}' }); await loadBillingAdmin(); const failed = result.results.filter(item => item.error).length; toast(failed ? `额度执行完成，${failed} 个客户失败` : '额度与用量已同步'); } catch (error) { handleError(error); }
});

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

const billingFilterBindings = [
  ['#redemptionSearch', 'input', 'codes'], ['#redemptionStatus', 'change', 'codes'],
  ['#walletSearch', 'input', 'wallets'], ['#rechargeSearch', 'input', 'rechargeCodes'], ['#rechargeStatus', 'change', 'rechargeCodes'],
  ['#subscriptionSearch', 'input', 'subscriptions'], ['#subscriptionStatus', 'change', 'subscriptions'],
  ['#orderSearch', 'input', 'orders'], ['#orderStatus', 'change', 'orders'], ['#usageSearch', 'input', 'usage'],
];
const billingFilterTimers = new Map();
for (const [selector, eventName, key] of billingFilterBindings) $(selector).addEventListener(eventName, () => {
  clearTimeout(billingFilterTimers.get(key));
  billingFilterTimers.set(key, setTimeout(() => loadBillingPage(key, 1).catch(handleError), eventName === 'input' ? 250 : 0));
});

document.addEventListener('click', event => {
  const button = event.target.closest('[data-pager-key]'); if (!button || button.disabled) return;
  const page = Number(button.dataset.page); const key = button.dataset.pagerKey;
  const loaders = {
    customers: () => loadUsers(page), adminSites: () => loadAdminSites(page), adminStreams: () => loadAdminStreams(page), audit: () => loadAudit(page),
    invites: () => loadInvitations(page),
    codes: () => loadBillingPage('codes', page), wallets: () => loadBillingPage('wallets', page),
    rechargeCodes: () => loadBillingPage('rechargeCodes', page), rechargeBatches: () => loadBillingPage('rechargeBatches', page),
    subscriptions: () => loadBillingPage('subscriptions', page), orders: () => loadBillingPage('orders', page), usage: () => loadBillingPage('usage', page),
  };
  loaders[key]?.().catch(handleError);
});
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

$('#passwordForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { if (form.elements.newPassword.value !== form.elements.confirmPassword.value) throw new Error('两次输入的新密码不一致'); await api('/api/account/password', { method: 'PUT', body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value }) }); form.reset(); showLogin(); toast('密码已修改，请重新登录'); } catch (error) { handleError(error); }
});

$('#emailChangeForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#emailChangeRequest'); button.disabled = true;
  try {
    const result = await api('/api/account/email/change/request', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value, currentPassword: form.elements.currentPassword.value, turnstileToken: state.authConfig?.emailVerificationEnabled ? turnstileToken('email-change') : '' }) });
    resetTurnstile('email-change');
    if (result.relogin) { showLogin(); return toast('邮箱已更换，请使用新邮箱重新登录'); }
    form.dataset.stage = 'verify'; form.elements.email.readOnly = true; form.elements.currentPassword.readOnly = true;
    $('#emailChangeVerifyFields').classList.remove('hidden'); form.elements.code.required = true;
    if (result.devCode) form.elements.code.value = result.devCode;
    startCooldown(button, state.authConfig?.emailCodeCooldownSeconds, '重新发送'); toast('验证码已发送到新邮箱');
  } catch (error) { resetTurnstile('email-change'); handleError(error); if (error.data?.retryAfter) startCooldown(button, error.data.retryAfter, '重新发送'); }
  finally { if (form.dataset.stage !== 'verify') button.disabled = false; }
});
$('#confirmEmailChange').addEventListener('click', async event => {
  const form = $('#emailChangeForm'); event.currentTarget.disabled = true;
  try { await api('/api/account/email/change/confirm', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value }) }); showLogin(); toast('邮箱已验证并更换，请重新登录'); }
  catch (error) { handleError(error); } finally { event.currentTarget.disabled = false; }
});
$('#closeAccountForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  if (!await confirmAction({ title: '确认注销账号', message: '账号会立即停用并退出登录，用户名和历史交易记录将继续保留。', confirmLabel: '确认注销', danger: true })) return;
  const button = $('button[type="submit"]', form); button.disabled = true;
  try { await api('/api/account', { method: 'DELETE', body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, mfaCode: form.elements.mfaCode.value }) }); showLogin(); toast('账号已注销'); }
  catch (error) { if (error.data?.detail) renderAccountClosure(error.data.detail); handleError(error); }
  finally { button.disabled = !state.accountClosure?.eligible; }
});

$('#ccResourceTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-resource-kind]'); if (!button) return;
  state.resourceKind = button.dataset.resourceKind; state.resourceFilter = 'all'; state.selectedResources.clear();
  $$('[data-resource-subtab]').forEach(item => item.classList.toggle('active', item.dataset.resourceSubtab === 'all'));
  syncResourcePageContext();
  loadResources().catch(handleError);
});
$('#newResourceButton').addEventListener('click', () => openResourceDialog().catch(handleError));
$('#refreshResources').addEventListener('click', () => loadResources().catch(handleError));
$('#resourceSearch').addEventListener('input', renderResources);
$$('[data-resource-subtab]').forEach(button => button.addEventListener('click', () => {
  state.resourceFilter = button.dataset.resourceSubtab; $$('[data-resource-subtab]').forEach(item => item.classList.toggle('active', item === button)); renderResources();
}));
$('#selectAllResources').addEventListener('change', event => {
  $$('[data-select-resource]', $('#resourceTable')).forEach(input => { input.checked = event.currentTarget.checked; const id = Number(input.dataset.selectResource); input.checked ? state.selectedResources.add(id) : state.selectedResources.delete(id); });
  updateResourceSelectionControls();
});

async function bulkUpdateResources(enable) {
  const resources = state.resources.filter(item => state.selectedResources.has(item.id) && !item._shared);
  if (!resources.length) return;
  const label = state.resourceKind === 'certs' ? '证书' : '资源';
  if (!await confirmAction({ title: `批量${enable ? '启用' : '停用'}${label}`, message: `确认${enable ? '启用' : '停用'}选中的 ${resources.length} 项${label}？`, confirmLabel: `批量${enable ? '启用' : '停用'}`, danger: !enable })) return;
  for (const resource of resources) await api(`/api/cdnfly/v1/${state.resourceKind}/${resource.id}`, { method: 'PUT', body: JSON.stringify({ enable: enable ? 1 : 0 }) });
  state.selectedResources.clear(); await loadResources(); toast(`已${enable ? '启用' : '停用'} ${resources.length} 项${label}`);
}
$('#resourceBulkEnable').addEventListener('click', () => bulkUpdateResources(true).catch(handleError));
$('#resourceBulkDisable').addEventListener('click', () => bulkUpdateResources(false).catch(handleError));
$('#resourceBulkDelete').addEventListener('click', async () => {
  const resources = state.resources.filter(item => state.selectedResources.has(item.id) && !item._shared);
  if (!resources.length) return;
  if (state.resourceKind === 'certs' && resources.some(resourceIsEnabled)) return toast('请先停用所选证书，再执行删除操作', true);
  const certificate = state.resourceKind === 'certs';
  if (!await confirmAction({ title: certificate ? '批量删除证书' : '批量删除资源', message: certificate ? `确认删除选中的 ${resources.length} 张证书？删除后无法恢复。` : `确认删除选中的 ${resources.length} 项资源？关联配置可能同时失效。`, confirmLabel: certificate ? '批量删除证书' : '批量删除', danger: true })) return;
  try { for (const resource of resources) await api(`/api/cdnfly/v1/${state.resourceKind}/${resource.id}`, { method: 'DELETE' }); state.selectedResources.clear(); await loadResources(); toast(`已删除 ${resources.length} 项资源`); } catch (error) { handleError(error); }
});
$('#resourceForm').elements.certType.addEventListener('change', updateCertificateFields);
$('#resourceForm').elements.certDomain.addEventListener('input', updateCertificateFields);
$('#resourceForm').elements.dnsProvider.addEventListener('change', () => updateDnsCredentialFields());
$('#resourceForm').elements.filterType.addEventListener('change', updateFilterFields);
$('#resourceForm').elements.aclDefaultAction.addEventListener('change', updateAclFields);
$('#resourceForm').elements.aclRejectCode.addEventListener('change', updateAclFields);
$('#resourceForm').elements.streamGroup.addEventListener('change', async event => {
  const form = $('#resourceForm');
  if (form.elements.resourceId.value || state.editResourceKind !== 'streams') return;
  try {
    const defaults = await userDefaultValues('stream', Number(event.target.value || 0));
    if (defaults.listen_protocol) form.elements.streamProtocol.value = defaults.listen_protocol;
    if (defaults.balance_way) form.elements.streamBalance.value = defaults.balance_way;
  } catch (error) { handleError(error); }
});
$('#aclMatchers').addEventListener('change', event => { if (event.target.matches('[data-field="action"]')) syncAclRuleRow(event.target.closest('.acl-rule')); });
$('#addAclMatcher').addEventListener('click', () => addAclRule());
$('#addMatcherCondition').addEventListener('click', () => addMatcherCondition());
$('#addRuleAction').addEventListener('click', () => addRuleAction());
$('#aclMatchers').addEventListener('click', event => {
  const rule = event.target.closest('.acl-rule');
  if (event.target.closest('[data-add-acl-condition]')) addAclCondition(rule);
  else if (event.target.closest('[data-remove-acl-condition]')) event.target.closest('.acl-condition').remove();
  else if (event.target.closest('[data-remove-acl-rule]')) rule.remove();
});
for (const builder of [$('#matcherConditions'), $('#ruleActions')]) builder.addEventListener('click', event => event.target.closest('[data-remove-rule]')?.closest('.rule-row')?.remove());
$('#resourceForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    const body = resourceFormBody(form);
    const id = form.elements.resourceId.value;
    await api(`/api/cdnfly/v1/${state.editResourceKind}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('#resourceDialog').close();
    if (state.currentView === 'data') await loadDataStreams(); else await loadResources();
    if (state.editResourceKind === 'streams') await refreshTenantBillingState();
    toast('资源已保存');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});
$('#resourceTable').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-resource]');
  const remove = event.target.closest('[data-delete-resource]');
  const toggle = event.target.closest('[data-toggle-resource]');
  const download = event.target.closest('[data-download-resource]');
  const sync = event.target.closest('[data-sync-resource]');
  try {
    if (edit) {
      const response = await api(`/api/cdnfly/v1/${state.resourceKind}/${edit.dataset.editResource}`);
      return await openResourceDialog(response.data);
    }
    if (toggle) {
      const resource = state.resources.find(item => item.id === Number(toggle.dataset.toggleResource));
      const enable = !resourceIsEnabled(resource);
      if (!await confirmAction({ title: enable ? '启用证书' : '停用证书', message: `确认${enable ? '启用' : '停用'} ${resource?.name || `证书 #${toggle.dataset.toggleResource}`}？`, confirmLabel: enable ? '启用' : '停用', danger: !enable })) return;
      await api(`/api/cdnfly/v1/certs/${toggle.dataset.toggleResource}`, { method: 'PUT', body: JSON.stringify({ enable: enable ? 1 : 0 }) });
      await loadResources(); return toast(`证书已${enable ? '启用' : '停用'}`);
    }
    if (remove) {
      const resource = state.resources.find(item => item.id === Number(remove.dataset.deleteResource));
      if (state.resourceKind === 'certs' && resourceIsEnabled(resource)) return toast('请先停用证书，再执行删除操作', true);
      const certificate = state.resourceKind === 'certs';
      if (!await confirmAction({ title: certificate ? '删除证书' : '删除安全资源', message: `确认删除 ${resource?.name || `资源 #${remove.dataset.deleteResource}`}？${certificate ? '删除后无法恢复。' : ''}`, confirmLabel: certificate ? '删除证书' : '删除资源', danger: true })) return;
      await api(`/api/cdnfly/v1/${state.resourceKind}/${remove.dataset.deleteResource}`, { method: 'DELETE' });
      await loadResources(); return toast(certificate ? '证书已删除' : '资源已删除');
    }
    if (sync) {
      await api('/api/cdnfly/v1/domains', { method: 'POST', body: JSON.stringify([{ id: Number(sync.dataset.syncResource) }]) });
      return toast('DNS 同步任务已提交');
    }
    if (download) {
      const response = await fetch(`/api/cdnfly/v1/certs/${download.dataset.downloadResource}?action=download`);
      if (!response.ok) throw new Error((await response.json()).error || '证书下载失败');
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `certificate-${download.dataset.downloadResource}.tar.gz`; anchor.click(); URL.revokeObjectURL(url);
    }
  } catch (error) {
    if (remove) remove.disabled = false;
    handleError(error);
  }
});
$('#resourceTable').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-select-resource]'); if (!checkbox) return;
  const id = Number(checkbox.dataset.selectResource); checkbox.checked ? state.selectedResources.add(id) : state.selectedResources.delete(id); updateResourceSelectionControls();
});
$('#wafForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const selected = $$('input:checked', $('#wafRuleList'));
  const body = selected.map((input, index) => ({ type: 'library', rule_id: Number(input.value), sort: index + 1, enable: 1 }));
  try {
    await api(`/api/cdnfly/v1/sites/${form.elements.siteId.value}/waf-rules`, { method: 'PUT', body: JSON.stringify(body) });
    $('#wafDialog').close(); toast('WAF 规则配置已保存');
  } catch (error) { handleError(error); }
});

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
$('#userConfigForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value; const body = { name: form.elements.name.value.trim(), value: form.elements.value.value, type: form.elements.type.value, scope_name: form.elements.scopeName.value, scope_id: Number(form.elements.scopeId.value || 0), enable: form.elements.enabled.checked ? 1 : 0 };
  try { await api(`/api/cdnfly/v1/user-configs${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); resetUserConfigForm(); await loadUserConfigs(); toast('默认设置已保存'); } catch (error) { handleError(error); }
});
$('#userConfigForm').elements.scopeName.addEventListener('change', event => $('#userConfigScopeField').classList.toggle('hidden', event.target.value !== 'group'));
$('#userConfigForm').elements.name.addEventListener('change', () => renderUserConfigValue());
$('#userConfigTypeTabs').addEventListener('click', event => { const button = event.target.closest('[data-config-type]'); if (button) { resetUserConfigForm(button.dataset.configType); renderUserConfigs(); } });
function resetUserConfigForm(type = state.configType) {
  const form = $('#userConfigForm'); form.reset(); form.elements.id.value = ''; form.elements.enabled.checked = true; $('#cancelUserConfig').classList.add('hidden'); setUserConfigType(type);
}
$('#cancelUserConfig').addEventListener('click', () => resetUserConfigForm());
$('#userConfigTable').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-user-config]'); const remove = event.target.closest('[data-delete-user-config]');
  if (edit) {
    const item = state.userConfigs.find(row => row.id === Number(edit.dataset.editUserConfig)); const form = $('#userConfigForm'); setUserConfigType(item.type);
    form.elements.id.value = item.id; form.elements.name.value = item.name; renderUserConfigValue(item.value); form.elements.scopeName.value = item.scope_name || 'global'; populateUserConfigScope(item.scope_id || '');
    form.elements.enabled.checked = Boolean(item.enable); $('#userConfigScopeField').classList.toggle('hidden', form.elements.scopeName.value !== 'group'); $('#cancelUserConfig').classList.remove('hidden'); form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (remove) { if (!await confirmAction({ title: '删除默认设置', message: '确认删除此默认配置？', confirmLabel: '删除设置', danger: true })) return; try { await api(`/api/cdnfly/v1/user-configs/${remove.dataset.deleteUserConfig}`, { method: 'DELETE' }); await loadUserConfigs(); toast('默认设置已删除'); } catch (error) { handleError(error); } }
});

function updateSystemClock() {
  $('#systemClock').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}
let chartResizeTimer;
window.addEventListener('resize', () => { clearTimeout(chartResizeTimer); chartResizeTimer = setTimeout(() => { if (['overview', 'tenant-dashboard'].includes(state.currentView)) drawTrafficCharts(); }, 120); });
updateSystemClock(); setInterval(updateSystemClock, 1000);

async function bootstrap() {
  try {
    const settings = await api('/api/auth/config'); applyPublicSettings(settings);
    await configureTurnstile(settings);
  } catch (error) { toast(error.message || '登录配置加载失败', true); }
  try {
    const session = await api('/api/auth/session');
    if (session.authenticated) await showApp(); else showLogin();
  } catch { showLogin(); }
}
bootstrap();
