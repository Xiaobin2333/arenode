import { state } from '../state/index.js';
import { loadOperations } from '../../operations.js';
import { api } from '../services/api-client.js';
import { toast } from '../components/toast.js';
import { loadBillingAdmin, setAdminBillingTab } from '../features/billing/admin-billing.js';
import { setMonitorContext } from '../features/monitor/index.js';
import { loadRecoveryAdmin } from '../features/recovery/index.js';
import { setUserConfigType } from '../features/user-configs/index.js';
import { handleError } from '../services/api-client.js';
import { loadAccountSecurity, renderAccountProfile, setAccountSection } from '../views/account-view.js';
import { loadAdminSites, loadAdminStreams, loadAdministrators, loadAudit, loadInvitations, loadRuntimeSettings, loadSystemHealth, loadUpstreams, loadUsers, renderAdminOverview } from '../views/admin-view.js';
import { loadBilling, setTenantBillingPane } from '../views/billing-view.js';
import { loadDataPane, syncDataPageContext, syncStreamPaneContext } from '../views/data-view.js';
import { drawTrafficCharts } from '../views/overview-view.js';
import { loadResources, syncResourcePageContext } from '../views/security-view.js';
import { $, $$ } from './dom.js';
import { renderAnnouncement, syncWorkbenchLayout } from './layout.js';
import { loadViewState } from './view-loader.js';

export function showView(name, activeButton = null) {
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
  const names = { overview: '控制台', 'tenant-dashboard': '数据大屏', sites: '网站列表', security: '安全策略', data: '转发与数据', billing: '套餐中心', 'admin-overview': '管理控制台', users: '客户管理', 'admin-sites': '站点管理', 'admin-streams': '四层转发', 'recovery-admin': '灾后恢复', 'billing-admin': '套餐与交易', upstreams: '上游管理', administrators: '管理员', invitations: '邀请码', audit: '审计日志', 'system-health': '系统状态', 'runtime-settings': '运行参数', account: '账户设置' };
  const title = selected?.dataset.title || names[name];
  $('#pageTitle').textContent = title;
  $('#breadcrumb').textContent = `${state.me?.user.role === 'admin' ? '运营后台' : '用户中心'} / ${title}`;
  renderAnnouncement();
  $('.sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'instant' });
  const loaders = {
    'backups-admin': () => loadOperations('backup', api, toast),
    'inspection-admin': () => loadOperations('inspection', api, toast),
    users: loadUsers, audit: loadAudit, upstreams: loadUpstreams, 'system-health': loadSystemHealth, 'runtime-settings': loadRuntimeSettings,
    administrators: loadAdministrators, invitations: loadInvitations,
    security: loadResources, data: loadDataPane,
    billing: loadBilling, 'billing-admin': loadBillingAdmin, 'admin-sites': loadAdminSites, 'admin-streams': loadAdminStreams, 'recovery-admin': loadRecoveryAdmin,
  };
  if (loaders[name]) loadViewState(name, loaders[name]);
  if (['overview', 'tenant-dashboard'].includes(name)) requestAnimationFrame(drawTrafficCharts);
  if (name === 'admin-overview') renderAdminOverview();
  if (name === 'account') { setAccountSection(selected?.dataset.accountSection || 'profile'); renderAccountProfile(); loadAccountSecurity().catch(handleError); }
}

export function navigateFromButton(button) {
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

export function navigateToUserConfigs(type, activeButton = null) {
  state.dataTab = 'configs';
  $$('#dataTabs button').forEach(item => item.classList.toggle('active', item.dataset.dataTab === 'configs'));
  $$('.data-pane', $('#data')).forEach(pane => pane.classList.toggle('active', pane.id === 'dataConfigs'));
  setUserConfigType(type); syncDataPageContext(); showView('data', activeButton);
  const title = `${({ site: '网站', stream: '四层转发', cert: '证书' })[type] || '用户'}默认设置`;
  $('#pageTitle').textContent = title; $('#breadcrumb').textContent = `用户中心 / ${title}`;
}

$('#nav').addEventListener('click', event => {
  const toggle = event.target.closest('[data-nav-toggle]');
  if (toggle) {
    const cluster = toggle.closest('.nav-cluster'); cluster.classList.toggle('open');
    saveNavState(cluster.closest('.tenant-nav, .admin-nav'));
    return;
  }
  const button = event.target.closest('[data-view]');
  if (button) {
    navigateFromButton(button);
    // 移动端导航后自动收起抽屉
    if (window.matchMedia('(max-width: 1024px)').matches) $('.sidebar').classList.remove('open');
  }
});

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
