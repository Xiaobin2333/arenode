import { state } from '../../state/index.js';
import { confirmAction, showRecords } from '../../components/dialog.js';
import { fillSelect } from '../../components/form-controls.js';
import { renderPager } from '../../components/pager.js';
import { statusBadge } from '../../components/status-badge.js';
import { copyText, toast } from '../../components/toast.js';
import { $, $$, nextDate, queryPath } from '../../core/dom.js';
import { GIB, financeTypeLabel, formatBytes, formatDate, formatLimit, formatMoney, orderAmountLabel, orderNetAmountCents } from '../../core/format.js';
import { api, handleError } from '../../services/api-client.js';
import { openOrderDetail, renderAdminOverview, summaryBlock } from '../../views/admin-view.js';
import { loadBilling } from '../../views/billing-view.js';
import { catalogToggleButton, resourceStatus } from '../../views/security-view.js';
import { SITE_PROFILE_LABELS } from '../../views/site-detail-view.js';

export function setAdminBillingTab(tab) {
  $$('#adminBillingTabs button').forEach(item => item.classList.toggle('active', item.dataset.billingTab === tab));
  $$('.billing-admin-pane').forEach(pane => pane.classList.toggle('active', pane.dataset.billingPane === tab));
  const titles = { plans: '套餐目录', groups: '套餐分组', upgrades: '增值项管理', traffic: '流量包管理', codes: '权益兑换码', wallets: '客户余额', recharge: '余额充值码', subscriptions: '客户套餐', orders: '订单记录', reports: '财务报表', usage: '客户用量' };
  const section = tab === 'usage' ? 'operations' : ['wallets', 'recharge', 'orders', 'reports'].includes(tab) ? 'finance' : 'package';
  $$('[data-admin-billing-summary]').forEach(summary => summary.classList.toggle('hidden', summary.dataset.adminBillingSummary !== section));
  $('#billing-admin > .section-head h3').textContent = titles[tab] || '套餐管理';
  $('#billing-admin > .section-head p').textContent = section === 'finance' ? '管理客户余额、充值码和即时支付订单' : section === 'operations' ? '查看客户资源消耗并执行套餐限额' : '维护套餐商品、权益与客户订阅';
}

function renderAdminBilling() {
  const data = state.billingAdmin; const totals = state.adminOverview;
  $('#adminBillingPlans').textContent = totals?.plans.total ?? data.plans.length;
  $('#adminBillingSubscriptions').textContent = totals?.subscriptions.active ?? data.subscriptions.filter(item => item.status === 'active').length;
  $('#adminBillingCodes').textContent = data.codes.filter(item => item.status === 'active').length;
  $('#adminBillingOverLimit').textContent = totals?.overLimitCustomers ?? data.usage.filter(item => item.billing?.overLimit).length;
  const paidOrders = data.orders.filter(item => item.status === 'paid');
  $('#adminFinanceBalance').textContent = formatMoney(totals?.walletLiabilityCents ?? data.wallets.reduce((sum, item) => sum + Number(item.balanceCents || 0), 0));
  $('#adminFinanceRechargeCodes').textContent = totals?.availableRechargeCodes ?? data.rechargeCodes.filter(item => item.status === 'active' && item.usedCount < item.maxUses).length;
  $('#adminFinancePaidOrders').textContent = totals?.orders.paid ?? paidOrders.length;
  $('#adminFinanceRevenue').textContent = formatMoney(totals?.orders.paidAmountCents ?? paidOrders.reduce((sum, item) => sum + orderNetAmountCents(item), 0));
  $('#adminUsageCustomers').textContent = totals?.customers.total ?? data.users.length;
  $('#adminUsageSites').textContent = totals?.sites ?? data.users.reduce((sum, item) => sum + Number(item.siteCount || 0), 0);
  $('#adminUsageSubscriptions').textContent = totals?.subscriptions.active ?? data.subscriptions.filter(item => item.status === 'active').length;
  $('#adminUsageOverLimit').textContent = totals?.overLimitCustomers ?? data.usage.filter(item => item.billing?.overLimit).length;
  $('#adminPlanTable').replaceChildren(...data.plans.map(plan => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${resourceStatus(plan)}</td><td class="right"><span class="row-actions"><button data-edit-plan="${plan.id}">配置</button>${catalogToggleButton('plan', plan)}<button class="danger" data-delete-plan="${plan.id}">删除</button></span></td>`;
    const collisionPolicy = plan.purchaseMode === 'once' ? (plan.destroyCollisionCode ? '撞车销码' : '撞车保留') : '可叠加';
    $('td:first-child strong', tr).textContent = plan.name; $('td:first-child small', tr).textContent = `${plan.code} · ${SITE_PROFILE_LABELS[plan.siteProfile] || SITE_PROFILE_LABELS.web} · ${plan.purchaseMode === 'once' ? `仅一次 / ${collisionPolicy}` : collisionPolicy} · ${plan.renewalMode === 'off' ? '禁续费' : plan.renewalMode === 'window' ? `到期前${plan.renewalWindowDays}天续` : '可续费'}`; $('td:nth-child(2) strong', tr).textContent = plan.upstreamName || '未绑定'; $('td:nth-child(2) small', tr).textContent = plan.upstreamPackageName || plan.upstreamPackageId || '-'; tr.children[2].textContent = formatMoney(plan.priceCents); tr.children[3].textContent = formatLimit(plan.domainLimit); tr.children[4].textContent = formatBytes(plan.trafficLimitBytes); tr.children[5].textContent = formatLimit(plan.portLimit); return tr;
  }));
  $('#adminGroupTable').replaceChildren(...data.groups.map(group => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong></td><td></td><td></td><td>${resourceStatus(group)}</td><td class="right"><span class="row-actions"><button data-edit-group="${group.id}">配置</button>${catalogToggleButton('group', group)}</span></td>`;
    $('strong', tr).textContent = group.name; tr.children[1].textContent = group.description || '-'; tr.children[2].textContent = group.sort; return tr;
  }));
  $('#adminUpgradeTable').replaceChildren(...data.upgrades.map(upgrade => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td class="right"><span class="row-actions"><button data-edit-upgrade="${upgrade.id}">配置</button>${catalogToggleButton('upgrade', upgrade)}</span></td>`;
    $('strong', tr).textContent = upgrade.name; $('small', tr).textContent = upgrade.enabled ? '启用' : '停用'; tr.children[1].textContent = formatMoney(upgrade.price_cents); tr.children[2].textContent = `+${upgrade.domain_increment}`; tr.children[3].textContent = `+${formatBytes(upgrade.traffic_increment_bytes)}`; tr.children[4].textContent = `+${upgrade.port_increment}`; return tr;
  }));
  $('#adminTrafficTable').replaceChildren(...data.trafficPackages.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td>${resourceStatus(item)}</td><td class="right"><span class="row-actions"><button data-edit-traffic="${item.id}">配置</button>${catalogToggleButton('traffic', item)}</span></td>`;
    $('strong', tr).textContent = item.name; $('small', tr).textContent = item.description || ''; tr.children[1].textContent = formatBytes(item.traffic_bytes); tr.children[2].textContent = formatMoney(item.price_cents); tr.children[3].textContent = `${item.duration_days} 天`; return tr;
  }));
  $('#adminRedemptionTable').replaceChildren(...data.codes.map(code => {
    const canDisable = ['active', 'scheduled'].includes(code.status);
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${resourceStatus(code)}</td><td class="right"><span class="row-actions"><button data-code-uses="${code.id}">记录</button>${canDisable ? `<button class="danger" data-disable-code="${code.id}">停用</button>` : ''}</span></td>`;
    $('strong', tr).textContent = `****-${code.suffix}`; $('small', tr).textContent = code.status === 'destroyed' ? `${code.label || `兑换码 #${code.id}`} · ${code.destroyedByUsername || '未知客户'}撞车` : (code.label || `兑换码 #${code.id}`); tr.children[1].textContent = code.productName || '历史商品'; tr.children[2].textContent = `x${code.amount}`; tr.children[3].textContent = `${code.usedCount} / ${code.maxUses}`; tr.children[4].textContent = code.destroyedAt ? formatDate(code.destroyedAt) : (code.expiresAt ? formatDate(code.expiresAt) : '长期有效'); return tr;
  }));
  $('#adminWalletTable').replaceChildren(...data.wallets.map(wallet => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td><strong></strong></td><td class="right"><button data-adjust-wallet="${wallet.userId}">调整余额</button></td>`;
    $('td:first-child strong', tr).textContent = wallet.username; $('td:first-child small', tr).textContent = `客户 #${wallet.userId}`;
    tr.children[1].textContent = wallet.email || '-'; $('td:nth-child(3) strong', tr).textContent = formatMoney(wallet.balanceCents); return tr;
  }));
  $('#adminRechargeCodeTable').replaceChildren(...data.rechargeCodes.map(code => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${resourceStatus(code)}</td><td class="right"><span class="row-actions"><button data-recharge-uses="${code.id}">记录</button><button class="danger" data-disable-recharge="${code.id}">停用</button></span></td>`;
    $('strong', tr).textContent = `****-${code.suffix}`; $('small', tr).textContent = code.label || `充值码 #${code.id}`;
    tr.children[1].textContent = code.batchName || '-'; tr.children[2].textContent = formatMoney(code.amountCents); tr.children[3].textContent = `${code.usedCount} / ${code.maxUses}`; tr.children[4].textContent = code.expiresAt ? formatDate(code.expiresAt) : '长期有效'; return tr;
  }));
  $('#rechargeBatchTable').replaceChildren(...data.rechargeBatches.map(batch => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td>';
    $('strong', tr).textContent = batch.name; $('small', tr).textContent = `批次 #${batch.id}`; tr.children[1].textContent = formatMoney(batch.amountCents); tr.children[2].textContent = batch.codeCount;
    tr.children[3].textContent = `${batch.usedCount} / ${batch.totalUses}`; tr.children[4].textContent = batch.expiresAt ? formatDate(batch.expiresAt) : '长期有效'; return tr;
  }));
  $('#adminSubscriptionTable').replaceChildren(...data.subscriptions.map(sub => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong></td><td><strong></strong><small></small></td><td></td><td>${statusBadge(sub.status)}</td><td></td><td class="right"><button class="danger" data-cancel-subscription="${sub.id}">取消</button></td>`;
    $('td:first-child strong', tr).textContent = sub.username; $('td:nth-child(2) strong', tr).textContent = sub.planName; $('td:nth-child(2) small', tr).textContent = `#${sub.id}`;
    tr.children[2].textContent = `${sub.siteCount} 站点 / ${sub.streamCount} 转发`; tr.children[4].textContent = `${formatDate(sub.startsAt)} 至 ${formatDate(sub.endsAt)}`; return tr;
  }));
  $('#adminOrderTable').replaceChildren(...data.orders.map(order => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong>#${order.id}</strong></td><td></td><td></td><td></td><td>${statusBadge(order.status)}</td><td></td><td class="right"><button data-order-detail="${order.id}">详情</button></td>`;
    tr.children[1].textContent = order.username; tr.children[2].textContent = order.productName || ({ plan: '套餐', plan_change: '套餐升降配', renewal: '套餐续费', upgrade: '增值项', traffic: '流量包' })[order.type] || order.type;
    tr.children[3].textContent = orderAmountLabel(order); if (orderNetAmountCents(order) < 0) tr.children[3].className = 'success-text';
    tr.children[5].textContent = formatDate(order.createdAt); return tr;
  }));
  $('#adminUsageTable').replaceChildren(...data.usage.map(item => {
    const b = item.billing; const tr = document.createElement('tr'); tr.innerHTML = `<td><strong></strong></td><td></td><td></td><td></td><td></td><td>${b.overLimit ? '<span class="badge off">已超限</span>' : '<span class="badge active">正常</span>'}</td>`;
    $('strong', tr).textContent = item.username; tr.children[1].textContent = b.plan?.name || '未分配'; tr.children[2].textContent = `${formatLimit(b.usage.domains)} / ${formatLimit(b.limits.domains)}`; tr.children[3].textContent = `${formatBytes(b.usage.trafficBytes)} / ${formatBytes(b.limits.trafficBytes)}`; tr.children[4].textContent = `${formatLimit(b.usage.ports)} / ${formatLimit(b.limits.ports)}`; return tr;
  }));
  $('#financeReportSummary').replaceChildren(
    summaryBlock('客户余额合计', formatMoney(data.finance.walletLiabilityCents)),
    summaryBlock('期间入账', formatMoney(data.finance.creditCents)),
    summaryBlock('期间支出', formatMoney(data.finance.debitCents)),
    summaryBlock('净变动', `${Number(data.finance.netChangeCents) >= 0 ? '+' : '-'}${formatMoney(Math.abs(Number(data.finance.netChangeCents || 0)))}`),
    summaryBlock('交易笔数', `${data.finance.transactionCount || 0} 笔`),
  );
  if (!$('#financeFrom').value) $('#financeFrom').value = data.finance.from || '';
  if (!$('#financeTo').value) $('#financeTo').value = data.finance.to || '';
  $('#financeReportTable').replaceChildren(...data.finance.breakdown.map(item => { const tr = document.createElement('tr'); tr.innerHTML = '<td></td><td></td><td></td><td><strong></strong></td>';
    tr.children[0].textContent = item.direction === 'credit' ? '入账' : '支出'; tr.children[1].textContent = financeTypeLabel(item.referenceType); tr.children[2].textContent = item.count; $('strong', tr).textContent = formatMoney(item.amountCents); return tr; }));
  const financeTransactions = data.finance.transactions || [];
  $('#financeTransactionTable').replaceChildren(...financeTransactions.map(item => {
    const tr = document.createElement('tr'); const credit = item.direction === 'credit';
    tr.innerHTML = '<td></td><td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td></td>';
    tr.children[0].textContent = formatDate(item.createdAt); $('td:nth-child(2) strong', tr).textContent = item.username || `客户 #${item.userId}`;
    $('td:nth-child(2) small', tr).textContent = `客户 #${item.userId}`; tr.children[2].textContent = financeTypeLabel(item.referenceType);
    tr.children[3].textContent = item.description || '-'; tr.children[4].textContent = `${credit ? '+' : '-'}${formatMoney(item.amountCents)}`;
    tr.children[4].className = credit ? 'success-text' : 'danger-text'; tr.children[5].textContent = formatMoney(item.balanceAfterCents);
    tr.children[6].textContent = item.referenceId ? `${item.referenceType} #${item.referenceId}` : '-'; return tr;
  }));
  $('#financeTransactionsEmpty').classList.toggle('hidden', financeTransactions.length !== 0);
  renderPager('#redemptionPager', data.pagination?.codes, 'codes');
  renderPager('#walletsPager', data.pagination?.wallets, 'wallets');
  renderPager('#rechargePager', data.pagination?.rechargeCodes, 'rechargeCodes');
  renderPager('#rechargeBatchPager', data.pagination?.rechargeBatches, 'rechargeBatches');
  renderPager('#subscriptionsPager', data.pagination?.subscriptions, 'subscriptions');
  renderPager('#ordersPager', data.pagination?.orders, 'orders');
  renderPager('#usagePager', data.pagination?.usage, 'usage');
  renderAdminOverview();
}

function billingListFilters(key) {
  if (key === 'codes') return { q: $('#redemptionSearch')?.value.trim() || '', status: $('#redemptionStatus')?.value || '' };
  if (key === 'wallets') return { q: $('#walletSearch')?.value.trim() || '' };
  if (key === 'rechargeCodes') return { q: $('#rechargeSearch')?.value.trim() || '', status: $('#rechargeStatus')?.value || '' };
  if (key === 'subscriptions') return { q: $('#subscriptionSearch')?.value.trim() || '', status: $('#subscriptionStatus')?.value || '' };
  if (key === 'orders') return { q: $('#orderSearch')?.value.trim() || '', status: $('#orderStatus')?.value || '' };
  if (key === 'usage') return { q: $('#usageSearch')?.value.trim() || '' };
  return {};
}

const billingListSpec = {
  codes: ['/api/admin/billing/redemption-codes', 'codes'], wallets: ['/api/admin/billing/wallets', 'wallets'],
  rechargeCodes: ['/api/admin/billing/recharge-codes', 'codes'], rechargeBatches: ['/api/admin/billing/recharge-code-batches', 'batches'],
  subscriptions: ['/api/admin/billing/subscriptions', 'subscriptions'], orders: ['/api/admin/billing/orders', 'orders'], usage: ['/api/admin/billing/usage', 'users'],
};

export async function loadBillingPage(key, page = state.pageInfo[key]?.page || 1) {
  const [path, responseKey] = billingListSpec[key]; const result = await api(queryPath(path, billingListFilters(key), page));
  state.billingAdmin[key] = result[responseKey]; state.billingAdmin.pagination[key] = result.pagination; renderAdminBilling();
}

export async function loadBillingAdmin() {
  const [plans, groups, upgrades, traffic, codes, subscriptions, orders, usage, users, wallets, rechargeCodes, rechargeBatches, finance, overview, upstreams] = await Promise.all([
    api('/api/admin/billing/plans'), api('/api/admin/billing/groups'), api('/api/admin/billing/upgrades'), api('/api/admin/billing/traffic-packages'),
    api(queryPath('/api/admin/billing/redemption-codes', billingListFilters('codes'), state.pageInfo.codes?.page || 1)),
    api(queryPath('/api/admin/billing/subscriptions', billingListFilters('subscriptions'), state.pageInfo.subscriptions?.page || 1)),
    api(queryPath('/api/admin/billing/orders', billingListFilters('orders'), state.pageInfo.orders?.page || 1)),
    api(queryPath('/api/admin/billing/usage', billingListFilters('usage'), state.pageInfo.usage?.page || 1)),
    api('/api/admin/customers?pageSize=100'),
    api(queryPath('/api/admin/billing/wallets', billingListFilters('wallets'), state.pageInfo.wallets?.page || 1)),
    api(queryPath('/api/admin/billing/recharge-codes', billingListFilters('rechargeCodes'), state.pageInfo.rechargeCodes?.page || 1)),
    api(queryPath('/api/admin/billing/recharge-code-batches', {}, state.pageInfo.rechargeBatches?.page || 1)),
    api('/api/admin/billing/finance/summary'), api('/api/admin/overview'), api('/api/admin/upstreams'),
  ]);
  state.upstreams = upstreams.upstreams;
  state.users = users.customers;
  state.adminOverview = overview.overview;
  state.billingAdmin = { plans: plans.plans, groups: groups.groups, upgrades: upgrades.upgrades, trafficPackages: traffic.trafficPackages, codes: codes.codes, subscriptions: subscriptions.subscriptions, orders: orders.orders, usage: usage.users, users: users.customers, wallets: wallets.wallets, rechargeCodes: rechargeCodes.codes, rechargeBatches: rechargeBatches.batches, finance,
    pagination: { codes: codes.pagination, subscriptions: subscriptions.pagination, orders: orders.pagination, usage: usage.pagination, wallets: wallets.pagination, rechargeCodes: rechargeCodes.pagination, rechargeBatches: rechargeBatches.pagination } };
  renderAdminBilling();
}

function openPlanDialog(plan = null) {
  const form = $('#planForm'); form.reset(); const data = state.billingAdmin;
  fillSelect(form.elements.groupId, data.groups, group => group.name, true);
  const mappings = state.upstreams.filter(item => item.status === 'active').flatMap(account => account.packages.filter(item => item.enabled).map(item => ({ id: `${account.id}:${item.packageId}`, label: `${account.name} / ${item.name} (#${item.packageId})` })));
  if (plan?.upstreamId && plan?.upstreamPackageId) {
    const currentId = `${plan.upstreamId}:${plan.upstreamPackageId}`;
    if (!mappings.some(item => item.id === currentId)) {
      mappings.unshift({ id: currentId, label: `${plan.upstreamName || '上游'} / ${plan.upstreamPackageName || plan.upstreamPackageId}（当前绑定）` });
    }
  }
  fillSelect(form.elements.upstreamMapping, mappings, item => item.label);
  form.elements.id.value = plan?.id || ''; form.elements.code.value = plan?.code || ''; form.elements.name.value = plan?.name || ''; form.elements.price.value = plan ? plan.priceCents / 100 : ''; form.elements.durationDays.value = plan?.durationDays || 30; form.elements.siteProfile.value = plan?.siteProfile || 'web'; form.elements.domainLimit.value = plan?.domainLimit ?? ''; form.elements.trafficGiB.value = plan?.trafficLimitBytes === null ? '' : Number(plan?.trafficLimitBytes || 0) / GIB; form.elements.portLimit.value = plan?.portLimit ?? ''; form.elements.groupId.value = plan?.groupId ?? ''; form.elements.description.value = plan?.description || ''; form.elements.enabled.checked = plan ? plan.enabled : true; form.elements.purchaseMode.value = plan?.purchaseMode === 'once' ? 'once' : 'stack'; form.elements.maxPurchaseQty.value = plan?.maxPurchaseQty || 1; form.elements.destroyCollisionCode.checked = plan ? plan.destroyCollisionCode !== false : true; form.elements.renewalMode.value = plan?.renewalMode === 'off' || plan?.renewalMode === 'window' ? plan.renewalMode : 'anytime'; form.elements.renewalWindowDays.value = plan?.renewalWindowDays || 7;
  form.elements.upstreamMapping.value = plan?.upstreamId && plan?.upstreamPackageId ? `${plan.upstreamId}:${plan.upstreamPackageId}` : '';
  updatePlanCollisionControl();
  $('#planDialogTitle').textContent = plan ? `配置 ${plan.name}` : '新建套餐'; $('#planDialog').showModal();
}

function updatePlanCollisionControl() {
  const form = $('#planForm'); const enabled = form.elements.purchaseMode.value === 'once';
  form.elements.destroyCollisionCode.disabled = !enabled;
  $('#destroyCollisionCodeRow').classList.toggle('disabled', !enabled);
}

function openCatalogDialog(type, item = null) {
  const form = $(`#${type}Form`); form.reset(); form.elements.id.value = item?.id || '';
  if (type === 'group') { form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.sort.value = item?.sort || 0; form.elements.enabled.checked = item ? Boolean(item.enabled) : true; }
  if (type === 'upgrade') { form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.price.value = item ? item.price_cents / 100 : ''; form.elements.domainIncrement.value = item?.domain_increment || 0; form.elements.trafficGiB.value = Number(item?.traffic_increment_bytes || 0) / GIB; form.elements.portIncrement.value = item?.port_increment || 0; form.elements.enabled.checked = item ? Boolean(item.enabled) : true; }
  if (type === 'traffic') { form.elements.name.value = item?.name || ''; form.elements.description.value = item?.description || ''; form.elements.price.value = item ? item.price_cents / 100 : ''; form.elements.trafficGiB.value = Number(item?.traffic_bytes || 0) / GIB || ''; form.elements.durationDays.value = item?.duration_days || 30; form.elements.enabled.checked = item ? Boolean(item.enabled) : true; }
  $(`#${type}DialogTitle`).textContent = `${item ? '配置' : '新建'}${type === 'group' ? '分组' : type === 'upgrade' ? '增值项' : '流量包'}`; $(`#${type}Dialog`).showModal();
}

export function openSubscriptionDialog(userId = null) {
  const form = $('#subscriptionForm'); form.reset();
  fillSelect(form.elements.userId, state.users.filter(user => user.role === 'user'), user => user.username);
  fillSelect(form.elements.planId, state.billingAdmin.plans.filter(plan => plan.enabled), plan => `${plan.name} · ${formatMoney(plan.priceCents)}`);
  if (userId) form.elements.userId.value = userId; $('#subscriptionDialog').showModal();
}

function updateRedemptionProducts() {
  const form = $('#redemptionForm'); const type = form.elements.type.value; const rows = type === 'plan' ? state.billingAdmin.plans.filter(item => item.enabled) : type === 'upgrade' ? state.billingAdmin.upgrades.filter(item => item.enabled) : state.billingAdmin.trafficPackages.filter(item => item.enabled);
  fillSelect(form.elements.productId, rows, item => item.name);
}

$('#planCatalogTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-buy-plan]'); if (!button) return;
  const plan = state.billingPlans.find(item => item.id === Number(button.dataset.buyPlan));
  const owned = (state.me.billing?.subscriptions || []).find(item => Number(item.plan?.id) === Number(plan.id));
  const maxQty = Math.max(1, Number(plan.maxPurchaseQty || 1));
  const qtyInput = button.closest('tr')?.querySelector(`[data-plan-qty="${plan.id}"]`);
  const qty = Math.min(maxQty, Math.max(1, Number.parseInt(qtyInput?.value || '1', 10) || 1));
  if (qtyInput) qtyInput.value = qty;
  const payCents = Number(plan.priceCents) * qty;
  const days = Number(plan.durationDays) * qty;
  const balanceAfter = state.wallet.balanceCents - payCents;
  const message = owned
    ? `${plan.name} × ${qty} 份，将在当前到期时间上延长 ${days} 天，支付 ${formatMoney(payCents)}。支付后余额 ${formatMoney(balanceAfter)}。`
    : `${plan.name} × ${qty} 份 · ${days} 天 · 支付 ${formatMoney(payCents)}。支付后余额 ${formatMoney(balanceAfter)}，套餐立即生效。`;
  if (!await confirmAction({ title: owned ? '确认叠加时长' : '确认购买套餐', message, confirmLabel: '余额支付' })) return;
  try { await api('/api/cdnfly/v1/user-packages', { method: 'POST', body: JSON.stringify({ planId: plan.id, amount: qty }) }); await loadBilling(); toast(qty > 1 ? `支付成功，已开通 ${qty} 个周期` : '支付成功，套餐已生效'); } catch (error) { handleError(error); }
});

$('#addonCatalogTable').addEventListener('click', async event => {
  const upgrade = event.target.closest('[data-buy-upgrade]'); const traffic = event.target.closest('[data-buy-traffic]'); if (!upgrade && !traffic) return;
  const subscriptionId = Number($('#addonSubscriptionSelect').value); if (!subscriptionId) return toast('请选择有效套餐', true);
  try {
    const item = upgrade ? state.billingUpgrades.find(row => row.id === Number(upgrade.dataset.buyUpgrade)) : state.billingTraffic.find(row => row.id === Number(traffic.dataset.buyTraffic));
    if (!await confirmAction({ title: '确认购买权益', message: `${item.name} · 目标套餐 #${subscriptionId} · 支付 ${formatMoney(item.price_cents)}。支付后余额 ${formatMoney(state.wallet.balanceCents - Number(item.price_cents))}。`, confirmLabel: '余额支付' })) return;
    if (upgrade) await api(`/api/cdnfly/v1/user-package/${subscriptionId}/upgrades`, { method: 'POST', body: JSON.stringify({ upgradeId: Number(upgrade.dataset.buyUpgrade), amount: 1 }) });
    else await api('/api/cdnfly/v1/user-traffic-packages', { method: 'POST', body: JSON.stringify({ trafficPackageId: Number(traffic.dataset.buyTraffic), subscriptionId }) });
    await loadBilling(); toast('支付成功，权益已生效');
  } catch (error) { handleError(error); }
});

$('#adminBillingTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-billing-tab]'); if (!button) return;
  setAdminBillingTab(button.dataset.billingTab);
});

$('#newPlanButton').addEventListener('click', () => openPlanDialog());

$('#planForm').elements.purchaseMode.addEventListener('change', updatePlanCollisionControl);

$('#newGroupButton').addEventListener('click', () => openCatalogDialog('group'));

$('#newUpgradeButton').addEventListener('click', () => openCatalogDialog('upgrade'));

$('#newTrafficButton').addEventListener('click', () => openCatalogDialog('traffic'));

$('#newSubscriptionButton').addEventListener('click', () => openSubscriptionDialog());

$('#newRedemptionButton').addEventListener('click', () => { $('#redemptionForm').reset(); updateRedemptionProducts(); $('#redemptionDialog').showModal(); });

$('#newRechargeCodeButton').addEventListener('click', () => { $('#rechargeCodeAdminForm').reset(); $('#rechargeCodeDialog').showModal(); });

$('#redemptionForm').elements.type.addEventListener('change', updateRedemptionProducts);

$('#redemptionForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = { type: form.elements.type.value, productId: Number(form.elements.productId.value), count: Number(form.elements.count.value), maxUses: Number(form.elements.maxUses.value), amount: Number(form.elements.amount.value), label: form.elements.label.value.trim() };
  if (form.elements.expiresAt.value) body.expiresAt = new Date(form.elements.expiresAt.value).toISOString();
  try { const result = await api('/api/admin/billing/redemption-codes', { method: 'POST', body: JSON.stringify(body) }); $('#redemptionDialog').close(); $('#generatedCodesTitle').textContent = '权益兑换码已生成'; $('#generatedCodes').value = result.codes.map(item => item.code).join('\n'); $('#generatedCodesDialog').showModal(); await loadBillingAdmin(); } catch (error) { handleError(error); }
});

$('#rechargeCodeAdminForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = { amountCents: Math.round(Number(form.elements.amount.value) * 100), count: Number(form.elements.count.value), maxUses: Number(form.elements.maxUses.value), label: form.elements.label.value.trim() };
  if (form.elements.expiresAt.value) body.expiresAt = new Date(form.elements.expiresAt.value).toISOString();
  try { const result = await api('/api/admin/billing/recharge-codes', { method: 'POST', body: JSON.stringify(body) }); $('#rechargeCodeDialog').close(); $('#generatedCodesTitle').textContent = '余额充值码已生成'; $('#generatedCodes').value = result.codes.map(item => item.code).join('\n'); $('#generatedCodesDialog').showModal(); await loadBillingAdmin(); } catch (error) { handleError(error); }
});

$('#walletAdjustForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const amountCents = Math.round(Number(form.elements.amount.value) * 100);
  const wallet = state.billingAdmin.wallets.find(item => item.userId === Number(form.elements.userId.value)); const next = Number(wallet.balanceCents) + amountCents;
  if (!await confirmAction({ title: '确认调整余额', message: `${wallet.username}：${formatMoney(wallet.balanceCents)} ${amountCents > 0 ? '+' : '-'} ${formatMoney(Math.abs(amountCents))} = ${formatMoney(next)}。原因：${form.elements.description.value.trim()}`, confirmLabel: '确认调整', danger: amountCents < 0 })) return;
  try { await api(`/api/admin/billing/wallets/${form.elements.userId.value}/adjust`, { method: 'POST', body: JSON.stringify({ amountCents, description: form.elements.description.value.trim() }) }); $('#walletAdjustDialog').close(); await loadBillingAdmin(); toast('客户余额已调整'); } catch (error) { handleError(error); }
});

$('#copyGeneratedCodes').addEventListener('click', () => copyText($('#generatedCodes').value, '兑换码已复制').catch(() => toast('复制失败，请手动选择兑换码', true)));

$('#planForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value; const nullableInt = value => value === '' ? null : Number(value);
  const mapping = form.elements.upstreamMapping.value; const separator = mapping.indexOf(':');
  const body = { code: form.elements.code.value.trim(), name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), priceCents: Math.round(Number(form.elements.price.value) * 100), durationDays: Number(form.elements.durationDays.value), siteProfile: form.elements.siteProfile.value, domainLimit: nullableInt(form.elements.domainLimit.value), trafficLimitBytes: form.elements.trafficGiB.value === '' ? null : Math.round(Number(form.elements.trafficGiB.value) * GIB), portLimit: nullableInt(form.elements.portLimit.value), groupId: form.elements.groupId.value === '' ? null : Number(form.elements.groupId.value), upstreamId: Number(mapping.slice(0, separator)), upstreamPackageId: mapping.slice(separator + 1), enabled: form.elements.enabled.checked, purchaseMode: form.elements.purchaseMode.value, maxPurchaseQty: Number(form.elements.maxPurchaseQty.value || 1), destroyCollisionCode: form.elements.destroyCollisionCode.checked, renewalMode: form.elements.renewalMode.value, renewalWindowDays: Number(form.elements.renewalWindowDays.value || 7) };
  try { await api(`/api/admin/billing/plans${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#planDialog').close(); await loadBillingAdmin(); toast('套餐已保存'); } catch (error) { handleError(error); }
});

async function saveCatalogForm(type, form) {
  const id = form.elements.id.value; let path; let body;
  if (type === 'group') { path = 'groups'; body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), sort: Number(form.elements.sort.value), enabled: form.elements.enabled.checked }; }
  if (type === 'upgrade') { path = 'upgrades'; body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), priceCents: Math.round(Number(form.elements.price.value) * 100), domainIncrement: Number(form.elements.domainIncrement.value), trafficIncrementBytes: Math.round(Number(form.elements.trafficGiB.value) * GIB), portIncrement: Number(form.elements.portIncrement.value), enabled: form.elements.enabled.checked }; }
  if (type === 'traffic') { path = 'traffic-packages'; body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), priceCents: Math.round(Number(form.elements.price.value) * 100), trafficBytes: Math.round(Number(form.elements.trafficGiB.value) * GIB), durationDays: Number(form.elements.durationDays.value), enabled: form.elements.enabled.checked }; }
  await api(`/api/admin/billing/${path}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $(`#${type}Dialog`).close(); await loadBillingAdmin(); toast('目录项已保存');
}

for (const type of ['group', 'upgrade', 'traffic']) $(`#${type}Form`).addEventListener('submit', event => { event.preventDefault(); saveCatalogForm(type, event.currentTarget).catch(handleError); });

$('#subscriptionForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const body = { userId: Number(form.elements.userId.value), planId: Number(form.elements.planId.value) };
  if (form.elements.startsAt.value) body.startsAt = new Date(form.elements.startsAt.value).toISOString();
  if (form.elements.endsAt.value) body.endsAt = new Date(form.elements.endsAt.value).toISOString();
  try { await api('/api/admin/billing/subscriptions', { method: 'POST', body: JSON.stringify(body) }); $('#subscriptionDialog').close(); await loadBillingAdmin(); toast('套餐已分配'); } catch (error) { handleError(error); }
});

$('#billing-admin').addEventListener('click', async event => {
  const editPlan = event.target.closest('[data-edit-plan]'); const enablePlan = event.target.closest('[data-enable-plan]'); const disablePlan = event.target.closest('[data-disable-plan]'); const deletePlan = event.target.closest('[data-delete-plan]'); const editGroup = event.target.closest('[data-edit-group]'); const enableGroup = event.target.closest('[data-enable-group]'); const disableGroup = event.target.closest('[data-disable-group]'); const editUpgrade = event.target.closest('[data-edit-upgrade]'); const enableUpgrade = event.target.closest('[data-enable-upgrade]'); const disableUpgrade = event.target.closest('[data-disable-upgrade]'); const editTraffic = event.target.closest('[data-edit-traffic]'); const enableTraffic = event.target.closest('[data-enable-traffic]'); const disableTraffic = event.target.closest('[data-disable-traffic]'); const disableCode = event.target.closest('[data-disable-code]'); const codeUses = event.target.closest('[data-code-uses]'); const cancelSubscription = event.target.closest('[data-cancel-subscription]'); const adjustWallet = event.target.closest('[data-adjust-wallet]'); const disableRecharge = event.target.closest('[data-disable-recharge]'); const rechargeUses = event.target.closest('[data-recharge-uses]'); const orderDetail = event.target.closest('[data-order-detail]');
  if (editPlan) return openPlanDialog(state.billingAdmin.plans.find(item => item.id === Number(editPlan.dataset.editPlan)));
  if (editGroup) return openCatalogDialog('group', state.billingAdmin.groups.find(item => item.id === Number(editGroup.dataset.editGroup)));
  if (editUpgrade) return openCatalogDialog('upgrade', state.billingAdmin.upgrades.find(item => item.id === Number(editUpgrade.dataset.editUpgrade)));
  if (editTraffic) return openCatalogDialog('traffic', state.billingAdmin.trafficPackages.find(item => item.id === Number(editTraffic.dataset.editTraffic)));
  if (adjustWallet) { const wallet = state.billingAdmin.wallets.find(item => item.userId === Number(adjustWallet.dataset.adjustWallet)); const form = $('#walletAdjustForm'); form.reset(); form.elements.userId.value = wallet.userId; $('#walletAdjustTitle').textContent = `调整 ${wallet.username} 的余额`; return $('#walletAdjustDialog').showModal(); }
  if (orderDetail) return openOrderDetail(Number(orderDetail.dataset.orderDetail)).catch(handleError);
  try {
    let path; let message; let enable = false;
    if (enablePlan) { path = `plans/${enablePlan.dataset.enablePlan}`; message = '套餐已启用'; enable = true; }
    if (disablePlan) { path = `plans/${disablePlan.dataset.disablePlan}`; message = '套餐已停用'; }
    if (deletePlan) {
      if (!await confirmAction({ title: '确认删除套餐', message: '将从目录里彻底删除该套餐。有客户订阅或兑换码引用时会拒绝删除。停用请用旁边的停用按钮。', confirmLabel: '确认删除', danger: true })) return;
      await api(`/api/admin/billing/plans/${deletePlan.dataset.deletePlan}?purge=1`, { method: 'DELETE' });
      await loadBillingAdmin();
      return toast('套餐已删除');
    }
    if (enableGroup) { path = `groups/${enableGroup.dataset.enableGroup}`; message = '分组已启用'; enable = true; }
    if (disableGroup) { path = `groups/${disableGroup.dataset.disableGroup}`; message = '分组已停用'; }
    if (enableUpgrade) { path = `upgrades/${enableUpgrade.dataset.enableUpgrade}`; message = '增值项已启用'; enable = true; }
    if (disableUpgrade) { path = `upgrades/${disableUpgrade.dataset.disableUpgrade}`; message = '增值项已停用'; }
    if (enableTraffic) { path = `traffic-packages/${enableTraffic.dataset.enableTraffic}`; message = '流量包已启用'; enable = true; }
    if (disableTraffic) { path = `traffic-packages/${disableTraffic.dataset.disableTraffic}`; message = '流量包已停用'; }
    if (disableCode) { path = `redemption-codes/${disableCode.dataset.disableCode}`; message = '兑换码已停用'; }
    if (disableRecharge) { path = `recharge-codes/${disableRecharge.dataset.disableRecharge}`; message = '充值码已停用'; }
    if (cancelSubscription) { path = `subscriptions/${cancelSubscription.dataset.cancelSubscription}`; message = '用户套餐已取消'; }
    if (path) {
      if (enable) {
        await api(`/api/admin/billing/${path}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
        await loadBillingAdmin();
        return toast(message);
      }
      if (!await confirmAction({ title: '确认停用', message: '历史交易和审计记录会保留，停用后的目录项或兑换码不能继续购买或使用。需要恢复时点启用。', confirmLabel: '确认停用', danger: true })) return;
      await api(`/api/admin/billing/${path}`, { method: 'DELETE' });
      await loadBillingAdmin();
      return toast(message);
    }
    if (codeUses) { const result = await api(`/api/admin/billing/redemption-codes/${codeUses.dataset.codeUses}/uses`); return showRecords('权益兑换记录', result.uses.map(item => ({ title: item.kind === 'collision' ? `${item.username || '未知客户'} · 撞车销毁` : `${item.username} · 订单 #${item.orderId}`, detail: formatDate(item.redeemedAt) })), '该兑换码暂无使用记录'); }
    if (rechargeUses) { const result = await api(`/api/admin/billing/recharge-codes/${rechargeUses.dataset.rechargeUses}/uses`); return showRecords('余额充值记录', result.uses.map(item => ({ title: `${item.username} · ${formatMoney(item.amountCents)}`, detail: formatDate(item.redeemedAt) })), '该充值码暂无使用记录'); }
  } catch (error) { handleError(error); }
});

$('#refundOrderButton').addEventListener('click', async event => { const id = event.currentTarget.dataset.orderId; if (!await confirmAction({ title: '全额退款', message: `确认将订单 #${id} 的 ${formatMoney(state.currentOrder?.amountCents)} 原路退回客户余额？对应权益会一并回滚。`, confirmLabel: '确认退款', danger: true })) return; try { await api(`/api/admin/billing/orders/${id}/refund`, { method: 'POST', body: '{}' }); $('#orderDetailDialog').close(); await loadBillingAdmin(); toast('订单已退款，权益已回滚'); } catch (error) { handleError(error); } });

$('#refreshFinanceReport').addEventListener('click', async () => {
  const filters = { from: $('#financeFrom').value, to: nextDate($('#financeTo').value) }; const params = new URLSearchParams(filters); for (const [key, value] of [...params]) if (!value) params.delete(key);
  try { state.billingAdmin.finance = await api(`/api/admin/billing/finance/summary${params.size ? `?${params}` : ''}`); renderAdminBilling(); toast('财务报表已刷新'); } catch (error) { handleError(error); }
});

$('#enforceBilling').addEventListener('click', async () => {
  try { const result = await api('/api/admin/billing/enforce', { method: 'POST', body: '{}' }); await loadBillingAdmin(); const failed = result.results.filter(item => item.error).length; toast(failed ? `额度执行完成，${failed} 个客户失败` : '额度与用量已同步'); } catch (error) { handleError(error); }
});

const billingFilterBindings = [
  ['#redemptionSearch', 'input', 'codes'], ['#redemptionStatus', 'change', 'codes'],
  ['#walletSearch', 'input', 'wallets'], ['#rechargeSearch', 'input', 'rechargeCodes'], ['#rechargeStatus', 'change', 'rechargeCodes'],
  ['#subscriptionSearch', 'input', 'subscriptions'], ['#subscriptionStatus', 'change', 'subscriptions'],
  ['#orderSearch', 'input', 'orders'], ['#orderStatus', 'change', 'orders'], ['#usageSearch', 'input', 'usage'],
];

const billingFilterTimers = new Map();

for (const [selector, eventName, key] of billingFilterBindings) $(selector).addEventListener(eventName, () => {
  clearTimeout(billingFilterTimers.get(key));
  billingFilterTimers.set(key, setTimeout(() => loadBillingPage(key, 1).catch(handleError), eventName === 'input' ? 250 : 0));
});
