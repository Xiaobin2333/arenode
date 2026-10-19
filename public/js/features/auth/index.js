import { state } from '../../state/index.js';
import { toast } from '../../components/toast.js';
import { configureTurnstile, resetTurnstile, startCooldown, turnstileToken } from '../../components/turnstile.js';
import { $, $$ } from '../../core/dom.js';
import { applyPublicSettings } from '../../core/layout.js';
import { navigateFromButton } from '../../core/router.js';
import { clearRecalledServiceStatus, loadServiceStatus, stopServiceStatusTimer } from '../../core/service-status.js';
import { api, handleError } from '../../services/api-client.js';
import { renderAccountProfile } from '../../views/account-view.js';
import { loadAdminOverview } from '../../views/admin-view.js';
import { loadOverviewData } from '../../views/overview-view.js';
import { loadSites } from '../../views/sites-view.js';
import { initLoginArtFx } from './login-art.js?v=login-pointer-20261020';

function hideBootSplash() {
  $('#bootSplash')?.classList.add('hidden');
}

export function showLogin() {
  stopServiceStatusTimer();
  clearRecalledServiceStatus();
  state.me = null; state.capabilities = { wafRules: true, attackLogs: true }; $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
  hideBootSplash();
  for (const item of [$('#appAnnouncement'), $('#publicAnnouncement')]) item?.classList.add('hidden');
  if ($('#announcementDialog')?.open) $('#announcementDialog').close();
  resetTurnstile('login');
  showAuthForm('loginForm');
  api('/api/auth/config').then(settings => { applyPublicSettings(settings); return configureTurnstile(settings); }).catch(() => {});
}

function showAuthForm(id) {
  for (const form of [$('#loginForm'), $('#mfaLoginForm'), $('#registerForm'), $('#forgotForm')]) form.classList.toggle('hidden', form.id !== id);
}

export async function showApp() {
  state.me = state.me || await api('/api/me');
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  // 进入首页特效：外壳淡入 + 侧栏/顶栏/内容依次入场（reduced-motion 时由 CSS 关闭）
  const appView = $('#appView');
  appView.classList.remove('app-entering');
  void appView.offsetWidth;
  appView.classList.add('app-entering');
  setTimeout(() => appView.classList.remove('app-entering'), 1000);
  hideBootSplash();
  if (!state.authConfig) {
    try { const settings = await api('/api/auth/config'); applyPublicSettings(settings); } catch {}
  }
  $('#accountName').textContent = state.me.user.username; $('#accountInitial').textContent = state.me.user.username[0].toUpperCase();
  $('#accountRole').textContent = state.me.user.role === 'admin' ? (state.me.user.adminRole === 'super_admin' ? '超级管理员' : '管理员') : '客户';
  renderAccountProfile();
  $$('.nav-cluster').forEach(cluster => cluster.classList.remove('open', 'active-parent'));
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', state.me.user.role !== 'admin'));
  $$('.customer-only').forEach(el => el.classList.toggle('hidden', state.me.user.role === 'admin'));
  const superAdmin = state.me.user.role === 'admin' && state.me.user.adminRole === 'super_admin';
  for (const view of ['administrators', 'invitations', 'runtime-settings', 'upstreams', 'backups-admin', 'inspection-admin']) {
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

// 登录页右侧花朵鼠标互动（视差倾斜 + 探照灯 + 粒子涟漪）；reduced-motion 或加载失败时自动降级为静态点阵
initLoginArtFx();
