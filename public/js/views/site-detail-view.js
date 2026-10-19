import { state } from '../state/index.js';
import { fillResourceOptions } from '../components/form-controls.js';
import { toast } from '../components/toast.js';
import { $, $$ } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { navigateFromButton, navigateToUserConfigs, showView } from '../core/router.js';
import { api, handleError } from '../services/api-client.js';
import { fillSubscriptionSelect, refreshTenantBillingState } from './billing-view.js';
import { extractItems, resourceNames, syncResourcePageContext } from './security-view.js';
import { badge, loadSites } from './sites-view.js';

const DEFAULT_SSL_CIPHERS = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';

export const SITE_PROFILE_LABELS = { web: '普通网站', openai: 'OpenAI API', anthropic: 'Anthropic API', gemini: 'Gemini API', azure_openai: 'Azure OpenAI API', cohere: 'Cohere API', china_ai: '国内 AI API', mixed_ai: 'AI API 全协议' };

export function enabledValue(value) { return [1, true, '1', 'true', 'on'].includes(value); }

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

export function openSiteDetail(site) {
  state.currentSiteConfig = {}; state.siteCertificates = []; state.siteAcls = []; state.siteCcRules = []; renderSiteDetail(site, {}); activateSiteSection('siteBasic'); showView('site-detail', $('.tenant-nav [data-view="sites"]'));
  $('#pageTitle').textContent = '网站管理'; $('#breadcrumb').textContent = `站点管理 / ${site.domain}`;
}

export async function refreshSiteDetail() {
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
