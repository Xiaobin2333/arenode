import { state } from '../../state/index.js';
import { copyText, toast } from '../../components/toast.js';
import { $ } from '../../core/dom.js';
import { formatDate } from '../../core/format.js';
import { api, handleError } from '../../services/api-client.js';
import { loadBilling } from '../../views/billing-view.js';
import { badge, loadSites } from '../../views/sites-view.js';

function renderRecoveryStatus() {
  const status = state.recoveryStatus;
  const badge = $('#recoveryActivationStatus'); const hint = $('#recoveryClaimHint');
  if (!badge || !hint) return;
  const active = Boolean(status?.activated && ['active', 'suspended'].includes(status.activation?.status));
  badge.textContent = active ? `已激活 · ${status.claimedDomains || 0}/15 个域名` : status?.activated ? '已到期' : '尚未激活';
  badge.className = `badge ${active ? 'active' : 'off'}`;
  hint.textContent = active
    ? `恢复套餐到期：${formatDate(status.activation.endsAt)}。已认领 ${status.claimedDomains || 0}/15 个域名；同一账号不能再次激活。`
    : '一份恢复套餐最多 15 个域名、15 个端口，流量不限；同一账号只能激活一次。';
}

export async function loadRecoveryStatus() {
  try {
    state.recoveryStatus = await api('/api/recovery/status');
  } catch {
    state.recoveryStatus = null;
  }
  renderRecoveryStatus();
}

function renderRecoveryAdmin() {
  const rows = state.recoveryAdminSites || [];
  $('#recoveryAdminCount').textContent = `${rows.length} 个站点`;
  $('#recoveryAdminTable').replaceChildren(...rows.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong></td><td></td><td></td><td></td><td></td>';
    $('strong', tr).textContent = item.domain; tr.children[1].innerHTML = item.status === 'claimed' ? '<span class="badge active">已认领</span>' : item.status === 'revoked' ? '<span class="badge off">已撤销</span>' : '<span class="badge pending">待认领</span>';
    tr.children[2].textContent = item.username || '-'; tr.children[3].textContent = `#${item.upstreamSiteId}`; tr.children[4].textContent = item.claimedAt ? formatDate(item.claimedAt) : '-'; return tr;
  }));
  $('#recoveryAdminEmpty').classList.toggle('hidden', rows.length !== 0);
}

export async function loadRecoveryAdmin() {
  const result = await api('/api/admin/recovery/sites'); state.recoveryAdminSites = result.sites || []; renderRecoveryAdmin();
}

function renderAdditionalRecoveryRecords(names = []) {
  let container = $('#recoveryAdditionalRecords');
  if (!container) {
    container = document.createElement('div'); container.id = 'recoveryAdditionalRecords';
    $('#recoveryClaimResult').append(container);
  }
  container.replaceChildren(...names.map(name => {
    const row = document.createElement('div'); row.className = 'recovery-record-row';
    const label = document.createElement('span'); label.textContent = '其他域名';
    const code = document.createElement('code'); code.textContent = name;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = '复制记录名';
    button.addEventListener('click', () => copyText(name, 'TXT 记录名已复制').catch(() => toast('复制失败，请手动选择记录名', true)));
    row.append(label, code, button); return row;
  }));
}

$('#recoveryClaimForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    const result = await api('/api/recovery/claims', { method: 'POST', body: JSON.stringify({ domain: form.elements.domain.value.trim() }) });
    if (result.claimed) {
      state.recoveryClaim = null; $('#recoveryClaimResult').classList.add('hidden'); $('#recoveryVerifyButton').classList.add('hidden');
      await loadRecoveryStatus(); toast('该站点已由当前账号认领'); return;
    }
    state.recoveryClaim = result.claim;
    renderAdditionalRecoveryRecords();
    $('#recoveryRecordName').textContent = result.claim.record.name;
    $('#recoveryRecordValue').textContent = result.claim.record.value;
    $('#recoveryRecordExpires').textContent = formatDate(result.claim.expiresAt);
    $('#recoveryClaimResult').classList.remove('hidden');
    $('#recoveryVerifyButton').classList.remove('hidden');
    toast('验证记录已生成');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#recoveryVerifyButton').addEventListener('click', async event => {
  if (!state.recoveryClaim) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await api(`/api/recovery/claims/${state.recoveryClaim.id}/verify`, { method: 'POST', body: '{}' });
    state.recoveryClaim = null; $('#recoveryVerifyButton').classList.add('hidden'); $('#recoveryClaimResult').classList.add('hidden');
    await Promise.all([loadBilling(), loadSites()]); toast(result.activated ? '认领成功，恢复套餐已激活' : '认领成功，站点已加入恢复套餐');
  } catch (error) {
    if (error.data?.additionalRecordNames) renderAdditionalRecoveryRecords(error.data.additionalRecordNames);
    handleError(error);
  } finally { button.disabled = false; }
});

$('#refreshRecoveryAdmin').addEventListener('click', () => loadRecoveryAdmin().catch(handleError));

$('#recoveryImportForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try {
    const result = await api('/api/admin/recovery/sites/import', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    $('#recoveryImportResult').textContent = `已读取 ${result.seen} 个上游站点，导入 ${result.imported} 个，跳过 ${result.skipped} 个。`;
    await loadRecoveryAdmin(); toast('恢复站点已导入');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#copyRecoveryRecordName').addEventListener('click', () => copyText($('#recoveryRecordName').textContent, 'TXT 记录名已复制').catch(() => toast('复制失败，请手动选择记录名', true)));

$('#copyRecoveryRecordValue').addEventListener('click', () => copyText($('#recoveryRecordValue').textContent, 'TXT 内容已复制').catch(() => toast('复制失败，请手动选择 TXT 内容', true)));
