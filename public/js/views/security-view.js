import { state } from '../state/index.js';
import { resourceEnabled, resourceLifecycle } from '../../resource-status.js?v=arenode';
import { actionMenu } from '../components/action-menu.js';
import { confirmAction } from '../components/dialog.js';
import { fillResourceOptions } from '../components/form-controls.js';
import { toast } from '../components/toast.js';
import { $, $$ } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { syncWorkbenchLayout } from '../core/layout.js';
import { navigateToUserConfigs } from '../core/router.js';
import { api, handleError } from '../services/api-client.js';
import { fillSubscriptionSelect, refreshTenantBillingState, tenantSubscriptions } from './billing-view.js';
import { loadDataStreams } from './data-view.js';
import { enabledValue } from './site-detail-view.js';
import { userDefaultValues } from './sites-view.js';

export const resourceNames = {
  'site-groups': '网站分组', domains: '域名', certs: '证书', dnsapis: 'DNS API',
  acls: 'ACL', 'cc-filters': 'CC 过滤器', 'cc-matchs': 'CC 匹配器', 'cc-rules': 'CC 规则', 'waf-rules': 'WAF 规则',
  streams: '四层转发', 'stream-groups': '四层转发分组',
};

export function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'list', 'rows', 'data', 'result']) {
    const found = extractItems(data[key]);
    if (found.length || Array.isArray(data[key])) return found;
  }
  return [];
}

export function resourceStatus(resource) {
  const lifecycle = resourceLifecycle(resource, state.resourceKind);
  return `<span class="badge ${lifecycle.tone}">${lifecycle.label}</span>`;
}

export function catalogToggleButton(kind, item) {
  if (item.enabled) return `<button class="danger" data-disable-${kind}="${item.id}">停用</button>`;
  return `<button data-enable-${kind}="${item.id}">启用</button>`;
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

export function resourceIsEnabled(resource) {
  return resourceEnabled(resource);
}

export function syncResourcePageContext() {
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

export async function loadResources() {
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

export async function openResourceDialog(resource = null, kind = state.resourceKind) {
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

export async function openWafDialog(site) {
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

export function populateSiteSelects() {
  for (const select of [$('#monitorForm').elements.siteId, $('#jobForm').elements.siteId]) {
    const current = select.value;
    select.replaceChildren(...state.sites.map(site => {
      const option = document.createElement('option'); option.value = site.id; option.textContent = site.domain; return option;
    }));
    if (state.sites.some(site => String(site.id) === current)) select.value = current;
  }
}

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

$('#detailSiteWaf')?.addEventListener('click', () => openWafDialog(state.currentSite).catch(handleError));

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
