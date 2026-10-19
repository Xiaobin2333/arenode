import { state } from '../state/index.js';
import { api } from '../services/api-client.js';
import { $ } from './dom.js';

let serviceStatusTimer = null;

function statusStorageKey() {
  const userId = state.me?.user?.id;
  return userId ? `arenode-service-status:${userId}` : 'arenode-service-status:anonymous';
}

export function stopServiceStatusTimer() {
  clearInterval(serviceStatusTimer); serviceStatusTimer = null;
}

export function paintServiceStatus(status, { unknown = false } = {}) {
  const top = $('#apiStatus'); const overview = $('#welcomeServiceStatus');
  if (!top) return;
  if (unknown) {
    top.className = 'pending'; top.innerHTML = '<i></i>状态未知';
    if (overview) { overview.textContent = '状态未知'; overview.className = ''; }
    return;
  }
  const healthy = status === 'healthy'; const degraded = status === 'degraded';
  const checking = status === 'checking';
  const label = checking ? '检测中' : healthy ? '正常' : degraded ? '部分降级' : '服务异常';
  top.className = checking ? 'pending' : healthy ? 'healthy' : degraded ? 'warning' : 'error';
  top.innerHTML = `<i></i>${label}`;
  if (overview) {
    overview.textContent = checking ? '检测中' : healthy ? '服务正常' : degraded ? '部分降级' : '服务异常';
    overview.className = checking ? '' : healthy ? 'success-text' : degraded ? 'warning-text' : 'danger-text';
  }
}

export function recalledServiceStatus() {
  const userId = state.me?.user?.id ?? null;
  if (state.serviceStatus && state.serviceStatusUserId === userId) return state.serviceStatus;
  try { return sessionStorage.getItem(statusStorageKey()) || null; } catch { return null; }
}

function rememberServiceStatus(status) {
  state.serviceStatus = status;
  state.serviceStatusUserId = state.me?.user?.id ?? null;
  try { sessionStorage.setItem(statusStorageKey(), status); } catch {}
}

export function clearRecalledServiceStatus() {
  state.serviceStatus = null;
  state.serviceStatusUserId = null;
}

export async function loadServiceStatus() {
  const top = $('#apiStatus');
  if (!top || !state.me) return;
  const last = recalledServiceStatus();
  if (last) paintServiceStatus(last);
  else paintServiceStatus('checking');
  try {
    const endpoint = state.me.user.role === 'admin' ? '/api/admin/health' : '/api/service-status';
    const result = await api(endpoint); const status = result.status || (result.ok ? 'healthy' : 'unhealthy');
    rememberServiceStatus(status);
    paintServiceStatus(status);
  } catch {
    // Do not keep showing a stale red/amber state when the probe itself failed.
    paintServiceStatus(null, { unknown: true });
  }
  if (!serviceStatusTimer) serviceStatusTimer = setInterval(() => { if (state.me) loadServiceStatus().catch(() => {}); }, 30_000);
}
