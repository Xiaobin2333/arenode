import { state } from '../state/index.js';
import { collectMonitorPoints, formatMonitorBandwidth, formatMonitorChartLabel } from '../../monitor-utils.js';
import { siteLifecycle } from '../../resource-status.js?v=arenode';
import { $ } from '../core/dom.js';
import { formatBytes, formatDate, formatLimit } from '../core/format.js';
import { loadServiceStatus } from '../core/service-status.js';
import { api, handleError } from '../services/api-client.js';
import { renderAccountProfile } from './account-view.js';
import { quotaPercent, quotaSummaryRow } from './billing-view.js';
import { extractItems } from './security-view.js';
import { siteRow } from './sites-view.js';

export function renderOverview() {
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

export const collectTrafficPoints = collectMonitorPoints;

// 画布无法使用 CSS 变量，改由 getComputedStyle 读取当前主题令牌
const themeValue = (name, fallback) => {
  try { const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return value || fallback; } catch { return fallback; }
};

export function drawTrafficChart(canvasSelector, emptySelector, sourcePoints = state.trafficPoints) {
  const canvas = $(canvasSelector); if (!canvas) return;
  const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d'); context.scale(ratio, ratio);
  const width = rect.width; const height = rect.height; const pad = { left: 54, right: 18, top: 18, bottom: 34 };
  context.clearRect(0, 0, width, height); context.font = '11px system-ui, sans-serif'; context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + (height - pad.top - pad.bottom) * index / 4;
    context.strokeStyle = themeValue('--chart-grid', '#e8eef6'); context.setLineDash([4, 4]); context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
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
  context.fillStyle = themeValue('--chart-label', '#8c9ab0'); context.textAlign = 'right';
  for (let index = 0; index <= 4; index += 1) context.fillText(axisValue(maximum * (4 - index) / 4), pad.left - 9, pad.top + (height - pad.top - pad.bottom) * index / 4 + 4);
  const innerWidth = width - pad.left - pad.right; const innerHeight = height - pad.top - pad.bottom;
  const coords = points.map((point, index) => ({ x: pad.left + (points.length === 1 ? innerWidth / 2 : innerWidth * index / (points.length - 1)), y: pad.top + innerHeight * (1 - point.value / maximum), point }));
  const gradient = context.createLinearGradient(0, pad.top, 0, height - pad.bottom); gradient.addColorStop(0, themeValue('--chart-fill-from', 'rgba(22,119,255,.22)')); gradient.addColorStop(1, themeValue('--chart-fill-to', 'rgba(22,119,255,0)'));
  context.beginPath(); context.moveTo(coords[0].x, height - pad.bottom); coords.forEach(item => context.lineTo(item.x, item.y)); context.lineTo(coords.at(-1).x, height - pad.bottom); context.closePath(); context.fillStyle = gradient; context.fill();
  context.beginPath(); coords.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y)); context.strokeStyle = themeValue('--accent', '#1677ff'); context.lineWidth = 2; context.stroke();
  context.fillStyle = themeValue('--chart-label', '#718097'); context.textAlign = 'center'; const labels = [coords[0], coords[Math.floor((coords.length - 1) / 2)], coords.at(-1)];
  for (const item of labels) context.fillText(formatMonitorChartLabel(item.point.label), item.x, height - 10);
}

export function drawTrafficCharts() {
  drawTrafficChart('#trafficChart', '#chartEmpty');
  drawTrafficChart('#dataOverviewChart', '#dataOverviewEmpty');
}

// 主题切换后按新令牌重绘画布图表
window.addEventListener('arenode:themechange', () => {
  if (['overview', 'tenant-dashboard'].includes(state.currentView)) drawTrafficCharts();
});

export async function loadOverviewData() {
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
  await Promise.all([orders, monitor]);
  loadServiceStatus().catch(() => {});
  const updated = `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())}`;
  $('#trafficChartUpdated').textContent = updated; $('#dataOverviewUpdated').textContent = updated;
  renderOverview(); drawTrafficCharts();
}

$('#refreshTenantDashboard').addEventListener('click', () => loadOverviewData().catch(handleError));

let chartResizeTimer;

window.addEventListener('resize', () => { clearTimeout(chartResizeTimer); chartResizeTimer = setTimeout(() => { if (['overview', 'tenant-dashboard'].includes(state.currentView)) drawTrafficCharts(); }, 120); });
