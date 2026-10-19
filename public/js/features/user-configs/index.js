import { state } from '../../state/index.js';
import { confirmAction } from '../../components/dialog.js';
import { toast } from '../../components/toast.js';
import { $, $$ } from '../../core/dom.js';
import { api, handleError } from '../../services/api-client.js';
import { extractItems } from '../../views/security-view.js';

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

export function setUserConfigType(type = 'site', { preserveForm = false } = {}) {
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

export async function loadUserConfigs() {
  const [configs, siteGroups, streamGroups, dnsApis] = await Promise.all([
    api('/api/cdnfly/v1/user-configs?limit=100'), api('/api/cdnfly/v1/site-groups'), api('/api/cdnfly/v1/stream-groups'), api('/api/cdnfly/v1/dnsapis').catch(() => ({ data: [] })),
  ]);
  state.userConfigs = extractItems(configs.data); state.siteGroups = extractItems(siteGroups.data); state.streamGroups = extractItems(streamGroups.data); state.dnsApis = extractItems(dnsApis.data);
  setUserConfigType(state.configType);
}

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
