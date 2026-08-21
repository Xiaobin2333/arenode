const ENABLED_VALUES = new Set([1, true, '1', 'true', 'on', 'active', 'enabled']);
const DISABLED_VALUES = new Set([0, false, '0', 'false', 'off', 'disabled', 'inactive']);

const normalized = value => String(value ?? '').trim().toLowerCase();
const validDate = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function resourceEnabled(resource = {}) {
  const value = resource.enable ?? resource.enabled;
  if (DISABLED_VALUES.has(value) || DISABLED_VALUES.has(normalized(value))) return false;
  if (ENABLED_VALUES.has(value) || ENABLED_VALUES.has(normalized(value))) return true;
  return true;
}

const ACTIVE_STATES = new Set(['1', '200', 'active', 'enabled', 'running', 'online', 'ok', 'normal', 'ready', 'success', 'succeeded', 'synced', 'done', 'completed']);
const PENDING_STATES = new Set(['pending', 'process', 'processing', 'provisioning', 'syncing', 'running-task', 'queued', 'waiting', 'updating']);
const FAILED_STATES = new Set(['failed', 'error', 'offline', 'invalid', 'rejected']);
const STOPPED_STATES = new Set(['0', 'disabled', 'inactive', 'stopped', 'stop']);

function lifecycleState(resource = {}) {
  return normalized(resource.sync_state ?? resource.syncState ?? resource.lifecycle_state ?? resource.lifecycleState
    ?? resource.task_state ?? resource.taskState ?? resource.status ?? resource.state);
}

export function certificateLifecycle(resource = {}, now = new Date()) {
  if (!resourceEnabled(resource)) return { state: 'disabled', tone: 'off', label: '禁用' };

  const expiresAt = validDate(resource.expire_time2 ?? resource.expire_time ?? resource.expires_at ?? resource.end_time);
  if (expiresAt && expiresAt <= now) return { state: 'expired', tone: 'off', label: '已过期' };

  const issueState = normalized(resource.issue_state ?? resource.issue_status ?? resource.cert_state);
  const syncState = normalized(resource.sync_state ?? resource.sync_status);
  const startsAt = validDate(resource.start_time ?? resource.starts_at ?? resource.begin_time);
  const taskRunning = ENABLED_VALUES.has(resource.task_enable) || ENABLED_VALUES.has(normalized(resource.task_enable));
  const automatic = ['lets', 'letsencrypt', 'zerossl', 'buypass'].includes(normalized(resource.type));

  if (['pending', 'queued', 'waiting', 'retrying'].includes(issueState)) return { state: 'pending', tone: 'pending', label: '待签发' };
  if (['process', 'processing', 'running', 'issuing', 'renewing'].includes(issueState)) return { state: 'pending', tone: 'pending', label: '签发中' };
  if (['failed', 'error'].includes(issueState)) return { state: 'failed', tone: 'off danger-text', label: taskRunning ? '签发失败，重试中' : '签发失败，已取消' };
  if (syncState === 'pending') return { state: 'pending', tone: 'pending', label: '待同步' };
  if (['process', 'processing', 'syncing'].includes(syncState)) return { state: 'pending', tone: 'pending', label: '同步中' };
  if (FAILED_STATES.has(syncState)) return { state: 'failed', tone: 'off danger-text', label: '同步失败' };
  if (syncState && !ACTIVE_STATES.has(syncState)) return { state: 'pending', tone: 'pending', label: '状态更新中' };
  if (['success', 'succeeded', 'issued', 'valid', 'active', 'done', 'completed'].includes(issueState) || startsAt) {
    return { state: 'active', tone: 'active', label: '正常' };
  }
  // Some CDNFly v6 deployments only return enable for a healthy automatic
  // certificate. Explicit task and issue states above still take precedence.
  if (automatic && resource.enable !== undefined) return { state: 'active', tone: 'active', label: '正常' };
  if (automatic) return { state: 'pending', tone: 'pending', label: '待签发' };
  if (issueState) return { state: 'pending', tone: 'pending', label: '状态更新中' };
  return { state: 'active', tone: 'active', label: '正常' };
}

export function resourceLifecycle(resource = {}, kind = '', now = new Date()) {
  if (resource._shared) return { state: 'readonly', tone: 'pending', label: '系统规则，仅可查看' };
  if (kind === 'certs') return certificateLifecycle(resource, now);
  const status = lifecycleState(resource);
  if (status === 'exhausted' || (Number.isFinite(Number(resource.maxUses)) && Number(resource.usedCount) >= Number(resource.maxUses))) {
    return { state: 'exhausted', tone: 'off', label: '已用完' };
  }
  const expiresAt = validDate(resource.expiresAt ?? resource.expires_at);
  if (status === 'expired' || (expiresAt && expiresAt <= now)) return { state: 'expired', tone: 'off', label: '已过期' };
  const startsAt = validDate(resource.startsAt ?? resource.starts_at);
  if (status === 'scheduled' || (startsAt && startsAt > now)) return { state: 'scheduled', tone: 'pending', label: '未生效' };
  if (STOPPED_STATES.has(status)) return { state: 'disabled', tone: 'off', label: '已停用' };
  if (PENDING_STATES.has(status)) return { state: 'pending', tone: 'pending', label: '处理中' };
  if (FAILED_STATES.has(status)) return { state: 'failed', tone: 'off danger-text', label: '处理失败' };
  if (status === 'suspended') return { state: 'suspended', tone: 'off', label: '已暂停' };
  if (['cancelled', 'canceled'].includes(status)) return { state: 'cancelled', tone: 'off', label: '已取消' };
  if (!resourceEnabled(resource)) return { state: 'disabled', tone: 'off', label: '已停用' };
  if (ACTIVE_STATES.has(status) || resource.enable !== undefined || resource.enabled !== undefined) {
    return { state: 'active', tone: 'active', label: '可用' };
  }
  if (status) return { state: 'pending', tone: 'pending', label: '状态更新中' };
  return { state: 'unknown', tone: 'pending', label: '状态未知' };
}

export function siteLifecycle(site = {}) {
  if (!resourceEnabled(site)) return { state: 'disabled', tone: 'off', label: '已停用' };
  if (site.lastError || site.last_error) return { state: 'failed', tone: 'off danger-text', label: '配置异常' };
  const status = lifecycleState(site);
  if (FAILED_STATES.has(status)) return { state: 'failed', tone: 'off danger-text', label: '配置异常' };
  if (status === 'suspended' || status === 'quota_suspended') return { state: 'suspended', tone: 'off', label: '已暂停' };
  if (PENDING_STATES.has(status)) return { state: 'pending', tone: 'pending', label: '配置中' };
  if (!status || ACTIVE_STATES.has(status)) return { state: 'active', tone: 'active', label: '运行中' };
  return { state: 'pending', tone: 'pending', label: '状态更新中' };
}
