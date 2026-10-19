import { state } from '../state/index.js';
import { siteLifecycle } from '../../resource-status.js?v=arenode';
import { actionMenu } from '../components/action-menu.js';
import { confirmAction } from '../components/dialog.js';
import { fillResourceOptions } from '../components/form-controls.js';
import { toast } from '../components/toast.js';
import { $, $$ } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { navigateFromButton } from '../core/router.js';
import { api, handleError } from '../services/api-client.js';
import { fillSubscriptionSelect, refreshTenantBillingState } from './billing-view.js';
import { renderOverview } from './overview-view.js';
import { extractItems, openResourceDialog, openWafDialog } from './security-view.js';
import { enabledValue, openSiteDetail, refreshSiteDetail } from './site-detail-view.js';

export function badge(site) {
  const lifecycle = siteLifecycle(site);
  return `<span class="badge ${lifecycle.tone}">${lifecycle.label}</span>`;
}

export function siteRow(site, actions = true) {
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

export function renderSites() {
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

export async function loadSites() {
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

export async function userDefaultValues(type, groupId = 0) {
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

$$('[data-action="new-site"]').forEach(button => button.addEventListener('click', () => openSiteDialog().catch(handleError)));

$('#siteForm').elements.groupId.addEventListener('change', () => applySiteDialogDefaults().catch(handleError));

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
