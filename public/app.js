import { state } from './js/state/index.js';
import { toast } from './js/components/toast.js';
import { configureTurnstile } from './js/components/turnstile.js';
import { applyPublicSettings } from './js/core/layout.js';
import { paintServiceStatus, recalledServiceStatus } from './js/core/service-status.js';
import { showApp, showLogin } from './js/features/auth/index.js';
import { loadBillingPage } from './js/features/billing/admin-billing.js';
import { api, handleError } from './js/services/api-client.js';
import { loadAdminSites, loadAdminStreams, loadAudit, loadInvitations, loadUsers } from './js/views/admin-view.js';

import './js/components/action-menu.js';
import './js/components/dialog.js';
import './js/components/form-controls.js';
import './js/components/pager.js';
import './js/components/status-badge.js';
import './js/components/table.js';
import './js/core/dom.js';
import './js/core/format.js';
import './js/core/router.js';
import './js/core/view-loader.js';
import './js/features/monitor/index.js';
import './js/features/recovery/index.js';
import './js/features/user-configs/index.js';
import './js/state/admin-state.js';
import './js/state/app-state.js';
import './js/state/auth-state.js';
import './js/state/billing-state.js';
import './js/state/monitor-state.js';
import './js/state/resource-state.js';
import './js/state/site-state.js';
import './js/views/account-view.js';
import './js/views/billing-view.js';
import './js/views/data-view.js';
import './js/views/overview-view.js';
import './js/views/security-view.js';
import './js/views/site-detail-view.js';
import './js/views/sites-view.js';

document.addEventListener('click', event => {
  const button = event.target.closest('[data-pager-key]'); if (!button || button.disabled) return;
  const page = Number(button.dataset.page); const key = button.dataset.pagerKey;
  const loaders = {
    customers: () => loadUsers(page), adminSites: () => loadAdminSites(page), adminStreams: () => loadAdminStreams(page), audit: () => loadAudit(page),
    invites: () => loadInvitations(page),
    codes: () => loadBillingPage('codes', page), wallets: () => loadBillingPage('wallets', page),
    rechargeCodes: () => loadBillingPage('rechargeCodes', page), rechargeBatches: () => loadBillingPage('rechargeBatches', page),
    subscriptions: () => loadBillingPage('subscriptions', page), orders: () => loadBillingPage('orders', page), usage: () => loadBillingPage('usage', page),
  };
  loaders[key]?.().catch(handleError);
});

async function bootstrap() {
  const last = recalledServiceStatus();
  if (last) paintServiceStatus(last);
  try {
    const [settingsResult, meResult] = await Promise.allSettled([api('/api/auth/config'), api('/api/me')]);
    if (settingsResult.status === 'fulfilled') applyPublicSettings(settingsResult.value);
    else toast(settingsResult.reason?.message || '登录配置加载失败', true);
    if (meResult.status === 'fulfilled' && meResult.value?.user) {
      state.me = meResult.value;
      await showApp();
    } else {
      showLogin();
      if (state.authConfig) configureTurnstile(state.authConfig).catch(() => {});
    }
  } catch { showLogin(); }
}

bootstrap();
