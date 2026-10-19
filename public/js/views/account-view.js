import { state } from '../state/index.js';
import { confirmAction } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import { resetTurnstile, startCooldown, turnstileToken } from '../components/turnstile.js';
import { $ } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { showLogin } from '../features/auth/index.js';
import { api, handleError } from '../services/api-client.js';

export function renderAccountProfile() {
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

export function setAccountSection(section = 'profile') {
  state.accountSection = section;
  const apiMode = section === 'api-keys' && state.me?.user.role === 'user';
  $('#accountPageTitle').textContent = apiMode ? 'API 密钥' : '个人资料';
  $('#accountPageSubtitle').textContent = apiMode ? '创建和撤销用于自动化调用 API 的访问密钥' : '管理个人资料、登录凭据与账户安全';
  for (const selector of ['.profile-panel', '.account-settings-grid', '.account-wide', '.danger-zone']) {
    const element = $(selector, $('#account')); if (element) element.classList.toggle('hidden', apiMode);
  }
  $('#apiKeyPanel')?.classList.toggle('hidden', !apiMode);
}

export async function loadAccountSecurity() {
  const customer = state.me.user.role === 'user';
  $('#account').classList.toggle('customer-account', customer);
  $('#account').classList.toggle('administrator-account', !customer);
  const [mfa, sessions, closure, apiKeyResult] = await Promise.all([api('/api/account/mfa'), api('/api/account/sessions'), customer ? api('/api/account/closure') : Promise.resolve(null), customer ? api('/api/cdnfly/v1/api-key').catch(() => ({ data: { items: [] } })) : Promise.resolve({ data: { items: [] } })]); state.mfa = mfa; state.accountClosure = closure; state.apiKeys = apiKeyResult?.data?.items || [];
  $('#mfaStatus').className = `badge ${mfa.enabled ? 'active' : 'off'}`; $('#mfaStatus').textContent = mfa.enabled ? '已启用' : '未启用';
  $('#mfaDescription').textContent = mfa.enabled ? `剩余 ${mfa.recoveryCodesRemaining} 枚恢复码` : '用户和管理员均可独立配置'; $('#configureMfaButton').textContent = mfa.enabled ? '解绑 MFA' : '配置 MFA';
  $('#sessionTable').replaceChildren(...sessions.sessions.slice(0, 10).map(session => { const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td><strong></strong><small></small></td><td></td><td></td><td class="right"><button class="danger">撤销</button></td>';
    $('strong', tr).textContent = session.current ? '当前设备' : '登录设备'; $('small', tr).textContent = session.userAgent || '未知客户端'; $('strong', tr.children[1]).textContent = session.lastIp || '待设备再次访问'; $('small', tr.children[1]).textContent = `登录时：${session.ip || '-'}`; tr.children[2].textContent = formatDate(session.lastSeenAt); tr.children[3].textContent = formatDate(session.expiresAt); $('button', tr).dataset.revokeSession = session.id; return tr; }));
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
