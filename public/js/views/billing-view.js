import { state } from '../state/index.js';
import { confirmAction } from '../components/dialog.js';
import { statusBadge } from '../components/status-badge.js';
import { toast } from '../components/toast.js';
import { $, $$ } from '../core/dom.js';
import { formatBytes, formatDate, formatLimit, formatMoney, remainingDays } from '../core/format.js';
import { loadRecoveryStatus } from '../features/recovery/index.js';
import { api, handleError } from '../services/api-client.js';
import { renderAccountProfile } from './account-view.js';
import { renderQuotaItem } from './admin-view.js';
import { renderOverview } from './overview-view.js';
import { extractItems } from './security-view.js';
import { renderSites } from './sites-view.js';

export function tenantSubscriptions() {
  return (state.me?.billing?.subscriptions || []).filter(item => ['active', 'suspended'].includes(item.subscription?.status));
}

export function fillSubscriptionSelect(select, selectedId = null, subscriptions = tenantSubscriptions()) {
  const usable = subscriptions.filter(item => item.plan?.upstreamId && item.plan?.upstreamPackageId);
  select.replaceChildren(...usable.map(item => {
    const option = document.createElement('option'); option.value = item.subscription.id;
    option.textContent = `${item.plan.name} · #${item.subscription.id} · ${item.resources?.sites || 0} 站点`;
    return option;
  }));
  if (selectedId !== null && selectedId !== undefined) select.value = String(selectedId);
}

export async function refreshTenantBillingState() {
  state.me = await api('/api/me');
  renderTenantBilling();
  renderAccountProfile();
  renderOverview();
}

export function quotaPercent(used, limit) {
  if (limit === null || limit === undefined) return 0;
  if (Number(limit) === 0) return Number(used) > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Number(used || 0) / Number(limit) * 100));
}

export function quotaSummaryRow(label, used, limit, formatter, tone) {
  const percent = quotaPercent(used, limit);
  const row = document.createElement('div'); row.className = 'quota-summary-row';
  row.innerHTML = `<header><span></span><strong></strong></header><div class="quota-track"><i class="${tone}"></i></div>`;
  $('header span', row).textContent = label;
  $('header strong', row).textContent = `${formatter(used)} / ${formatter(limit)}`;
  $('.quota-track i', row).style.width = limit === null || limit === undefined ? '100%' : `${percent}%`;
  return row;
}

export function setTenantBillingPane(target = 'current') {
  if (target === 'orders') target = 'wallet';
  state.billingTarget = target;
  $$('.tenant-billing-pane').forEach(pane => pane.classList.toggle('hidden', !pane.dataset.tenantBillingPane.split(',').includes(target)));
  $('#billingWarning').style.display = ['current', 'usage'].includes(target) ? '' : 'none';
  const descriptions = {
    current: '查看当前套餐、兑换权益和可购买套餐',
    addons: '购买当前套餐可使用的增值项与流量包',
    usage: '查看本计费周期的域名、流量和端口用量',
    wallet: '查看余额、充值、消费订单和兑换记录',
  };
  const titles = { current: '我的套餐', addons: '流量包', usage: '用量查询', wallet: '余额中心' };
  $('#billingPageTitle').textContent = titles[target] || titles.current;
  $('#billingPageSubtitle').textContent = descriptions[target] || descriptions.current;
}

function renderTenantBilling() {
  const billing = state.me.billing || { plan: null, subscription: null, limits: {}, usage: {}, reasons: [] };
  const subscriptions = billing.subscriptions || [];
  $('#walletBalance').textContent = formatMoney(state.wallet.availableBalanceCents ?? state.wallet.balanceCents);
  $('#walletRecharge').textContent = formatMoney(state.wallet.totalRechargeCents);
  $('#walletSpent').textContent = formatMoney(state.wallet.totalSpentCents);
  $('#walletTransactionTable').replaceChildren(...state.wallet.transactions.map(transaction => {
    const tr = document.createElement('tr'); const credit = transaction.direction === 'credit';
    tr.innerHTML = '<td></td><td><strong></strong></td><td></td><td></td><td></td>';
    tr.children[0].textContent = formatDate(transaction.createdAt); $('strong', tr).textContent = transaction.description || '余额变动';
    tr.children[2].textContent = credit ? '入账' : '支出'; tr.children[3].textContent = `${credit ? '+' : '-'}${formatMoney(transaction.amountCents)}`;
    tr.children[3].className = credit ? 'success-text' : 'danger-text'; tr.children[4].textContent = formatMoney(transaction.balanceAfterCents); return tr;
  }));
  $('#walletTransactionsEmpty').classList.toggle('hidden', state.wallet.transactions.length !== 0);
  $('#currentPlanName').textContent = subscriptions.length > 1 ? '全部套餐资源汇总' : billing.plan?.name || '未分配套餐';
  $('#currentPlanPeriod').textContent = subscriptions.length > 1 ? `共 ${subscriptions.length} 个有效套餐实例，资源分别计费` : billing.subscription ? `${formatDate(billing.subscription.startsAt)} 至 ${formatDate(billing.subscription.endsAt)}` : '购买套餐后即可分配资源';
  $('#currentPlanStatus').outerHTML = billing.subscription ? statusBadge(billing.subscription.status) : '<span id="currentPlanStatus" class="badge off">未生效</span>';
  const currentStatus = $('.billing-current .panel-head .badge'); if (currentStatus) currentStatus.id = 'currentPlanStatus';
  $('#quotaGrid').replaceChildren(
    renderQuotaItem('加速域名', billing.usage.domains || 0, billing.limits.domains, formatLimit),
    renderQuotaItem('月流量', billing.usage.trafficBytes || 0, billing.limits.trafficBytes, formatBytes),
    renderQuotaItem('HTTP / 转发端口', billing.usage.ports || 0, billing.limits.ports, formatLimit),
  );
  const warning = $('#billingWarning'); warning.classList.toggle('hidden', !subscriptions.length || !billing.overLimit);
  warning.textContent = subscriptions.length && billing.overLimit ? `资源已超限：${billing.reasons.join('；')}。本账户正在运行的网站与四层转发将保持暂停，额度恢复后自动恢复。` : '';

  $('#subscriptionCards').replaceChildren(...subscriptions.map(item => {
    const card = document.createElement('article'); card.className = 'subscription-card';
    const renewOff = item.plan?.renewalMode === 'off';
    const windowBlocked = item.plan?.renewalMode === 'window' && remainingDays(item) > Number(item.plan.renewalWindowDays || 7);
    card.innerHTML = `<header><div><h4></h4><small></small></div>${statusBadge(item.subscription.status)}</header><dl><dt>有效期</dt><dd></dd><dt>绑定资源</dt><dd></dd><dt>加速域名</dt><dd></dd><dt>月流量</dt><dd></dd><dt>HTTP / 转发端口</dt><dd></dd></dl><footer>${renewOff ? '<span class="status-text">该套餐禁止续费</span>' : `<label class="auto-renew-toggle"><input type="checkbox" data-auto-renew="${item.subscription.id}"><span>自动续费</span></label>`}<div class="subscription-actions"><button class="secondary" data-change-subscription="${item.subscription.id}">升降配</button>${renewOff || windowBlocked ? '' : `<button class="secondary" data-renew-subscription="${item.subscription.id}">立即续费</button>`}</div></footer>`;
    $('h4', card).textContent = item.plan.name; $('header small', card).textContent = `套餐实例 #${item.subscription.id}`;
    const values = $$('dd', card); values[0].textContent = `${formatDate(item.subscription.startsAt)} 至 ${formatDate(item.subscription.endsAt)}`;
    values[1].textContent = `${item.resources.sites} 个网站 / ${item.resources.streams} 个转发`;
    values[2].textContent = `${formatLimit(item.usage.domains)} / ${formatLimit(item.limits.domains)}`;
    values[3].textContent = `${formatBytes(item.usage.trafficBytes)} / ${formatBytes(item.limits.trafficBytes)}`;
    values[4].textContent = `${formatLimit(item.usage.ports)} / ${formatLimit(item.limits.ports)}`;
    const autoRenew = $('[data-auto-renew]', card);
    if (autoRenew) autoRenew.checked = Boolean(item.subscription.autoRenew);
    return card;
  }));
  if (!subscriptions.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.innerHTML = '<span>¥</span><h4>暂无有效套餐</h4><p>购买套餐或使用兑换码后即可分配网站和转发</p>';
    $('#subscriptionCards').replaceChildren(empty);
  }

  const addonSelect = $('#addonSubscriptionSelect'); const selectedAddon = addonSelect.value;
  fillSubscriptionSelect(addonSelect, selectedAddon || billing.subscription?.id, subscriptions);
  $('#subscriptionUsageTable').replaceChildren(...subscriptions.map(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td>${item.overLimit ? '<span class="badge off">已超限</span>' : statusBadge(item.subscription.status)}</td>`;
    $('strong', tr).textContent = item.plan.name; $('small', tr).textContent = `#${item.subscription.id}`;
    tr.children[1].textContent = `${item.resources.sites} 站点 / ${item.resources.streams} 转发`;
    tr.children[2].textContent = `${formatLimit(item.usage.domains)} / ${formatLimit(item.limits.domains)}`;
    tr.children[3].textContent = `${formatBytes(item.usage.trafficBytes)} / ${formatBytes(item.limits.trafficBytes)}`;
    tr.children[4].textContent = `${formatLimit(item.usage.ports)} / ${formatLimit(item.limits.ports)}`;
    return tr;
  }));

  const ownedByPlan = new Map((subscriptions || []).map(item => [Number(item.plan?.id), item]));
  $('#planCatalogTable').replaceChildren(...state.billingPlans.map(plan => {
    const owned = ownedByPlan.get(Number(plan.id));
    const onceOwned = plan.purchaseMode === 'once' && owned;
    const renewalBlocked = owned && (plan.renewalMode === 'off' || (plan.renewalMode === 'window' && remainingDays(owned) > Number(plan.renewalWindowDays || 7)));
    const maxQty = Math.max(1, Number(plan.maxPurchaseQty || 1));
    const qtyControl = onceOwned || renewalBlocked || maxQty <= 1 ? '' : `<input class="qty-input" type="number" min="1" max="${maxQty}" value="1" data-plan-qty="${plan.id}" aria-label="购买数量">`;
    const action = onceOwned
      ? '<span class="status-text">已持有</span>'
      : renewalBlocked
        ? `<span class="status-text">${plan.renewalMode === 'off' ? '禁止续费' : `到期前 ${plan.renewalWindowDays} 天可续`}</span>`
        : `${qtyControl}<button class="primary" data-buy-plan="${plan.id}">${owned ? '叠加时长' : '购买'}</button>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td><td class="right"><span class="row-actions">${action}</span></td>`;
    $('strong', tr).textContent = plan.name; $('small', tr).textContent = `${plan.description || plan.code} · ${plan.purchaseMode === 'once' ? '限购一次' : '重复购买叠加时长'}`;
    tr.children[1].textContent = `${formatMoney(plan.priceCents)} / ${plan.durationDays} 天`;
    tr.children[2].textContent = formatLimit(plan.domainLimit); tr.children[3].textContent = formatBytes(plan.trafficLimitBytes); tr.children[4].textContent = formatLimit(plan.portLimit);
    return tr;
  }));
  $('#tenantOrderTable').replaceChildren(...state.billingOrders.map(order => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td><strong>#${order.id}</strong></td><td></td><td></td><td>${statusBadge(order.status)}</td><td></td>`;
    tr.children[1].textContent = ({ plan: '套餐', plan_change: '套餐升降配', upgrade: '增值项', traffic: '流量包', recharge: '充值' })[order.type] || order.type;
    tr.children[2].textContent = order.type === 'plan_change' && Number(order.balanceAdjustmentCents) > 0
      ? `+${formatMoney(order.balanceAdjustmentCents)}` : formatMoney(order.amountCents);
    if (order.type === 'plan_change' && Number(order.balanceAdjustmentCents) > 0) tr.children[2].className = 'success-text';
    tr.children[4].textContent = formatDate(order.createdAt); return tr;
  }));
  const subscriptionId = addonSelect.value;
  const addons = [
    ...state.billingUpgrades.map(item => ({ ...item, catalogType: 'upgrade', effect: `域名 +${item.domain_increment} / 流量 +${formatBytes(item.traffic_increment_bytes)} / 端口 +${item.port_increment}` })),
    ...state.billingTraffic.map(item => ({ ...item, catalogType: 'traffic', effect: `${formatBytes(item.traffic_bytes)}，有效 ${item.duration_days} 天` })),
  ];
  $('#addonCatalogTable').replaceChildren(...addons.map(item => {
    const tr = document.createElement('tr'); const action = subscriptionId ? `<button class="primary" data-buy-${item.catalogType}="${item.id}">购买</button>` : '<span class="status-text">请先开通套餐</span>';
    tr.innerHTML = `<td><strong></strong><small></small></td><td></td><td></td><td></td><td class="right">${action}</td>`;
    $('strong', tr).textContent = item.name; $('small', tr).textContent = item.description || ''; tr.children[1].textContent = item.catalogType === 'upgrade' ? '增值项' : '流量包'; tr.children[2].textContent = item.effect; tr.children[3].textContent = formatMoney(item.price_cents); return tr;
  }));
  $('#redemptionHistoryTable').replaceChildren(...state.redemptions.map(item => {
    const tr = document.createElement('tr'); tr.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td><td></td><td></td>';
    $('strong', tr).textContent = item.productName || '历史商品'; $('small', tr).textContent = item.label || ''; tr.children[1].textContent = ({ plan: '套餐', upgrade: '增值项', traffic: '流量包' })[item.type]; tr.children[2].textContent = `****-${item.suffix}`; tr.children[3].textContent = `#${item.orderId}`; tr.children[4].textContent = formatDate(item.redeemedAt); return tr;
  }));
}

function compatiblePlanChangeTargets(subscriptionItem) {
  const current = subscriptionItem.plan;
  return state.billingPlans.filter(plan => Number(plan.id) !== Number(current.id)
    && String(plan.upstreamId ?? '') === String(current.upstreamId ?? '')
    && String(plan.upstreamPackageId ?? '') === String(current.upstreamPackageId ?? ''));
}

async function refreshPlanChangeQuote() {
  const form = $('#planChangeForm'); const subscriptionId = Number(form.elements.subscriptionId.value); const packageId = Number(form.elements.package.value);
  const requestToken = Symbol('plan-change-quote'); state.planChangeRequest = requestToken; state.planChangeQuote = null;
  $('#planChangeSubmit').disabled = true; $('#planChangeQuoteStatus').textContent = '正在计算差价...';
  for (const selector of ['#planChangeRemainDays', '#planChangeCurrentPrice', '#planChangeNewPrice', '#planChangeDiffPrice', '#planChangeBalance']) $(selector).textContent = '-';
  try {
    const response = await api(`/api/cdnfly/v1/user-packages/${subscriptionId}?to_package=${packageId}`);
    if (state.planChangeRequest !== requestToken || !$('#planChangeDialog').open) return;
    const quote = response.data; const diffCents = Number(quote.diff_price_cents); state.planChangeQuote = quote;
    $('#planChangeRemainDays').textContent = `${quote.remain_days} 天`;
    $('#planChangeCurrentPrice').textContent = formatMoney(quote.curr_price_cents);
    $('#planChangeNewPrice').textContent = formatMoney(quote.new_price_cents);
    $('#planChangeDiffPrice').textContent = diffCents > 0 ? `补款 ${formatMoney(diffCents)}` : diffCents < 0 ? `退款 ${formatMoney(Math.abs(diffCents))}` : '无需补款';
    $('#planChangeDiffPrice').className = diffCents < 0 ? 'success-text' : diffCents > 0 ? 'danger-text' : '';
    $('#planChangeBalance').textContent = formatMoney(Number(state.wallet.balanceCents) - diffCents);
    $('#planChangeQuoteStatus').textContent = `${quote.to_package_name} · 到期时间保持不变`;
    $('#planChangeSubmit').disabled = diffCents > Number(state.wallet.balanceCents);
    if ($('#planChangeSubmit').disabled) $('#planChangeQuoteStatus').textContent = '账户余额不足，无法完成本次升配';
  } catch (error) {
    if (state.planChangeRequest === requestToken) $('#planChangeQuoteStatus').textContent = error.message || '差价计算失败';
    throw error;
  }
}

function openPlanChangeDialog(subscriptionId) {
  const item = tenantSubscriptions().find(row => Number(row.subscription.id) === Number(subscriptionId));
  if (!item) return toast('用户套餐不存在或未生效', true);
  const targets = compatiblePlanChangeTargets(item);
  if (!targets.length) return toast('暂无兼容的升降配套餐', true);
  const form = $('#planChangeForm'); form.elements.subscriptionId.value = item.subscription.id;
  form.elements.currentPlan.value = `${item.plan.name} · ${formatMoney(item.plan.priceCents)} / ${item.plan.durationDays} 天`;
  form.elements.package.replaceChildren(...targets.map(plan => {
    const option = document.createElement('option'); option.value = plan.id;
    option.textContent = `${plan.name} · ${formatMoney(plan.priceCents)} / ${plan.durationDays} 天`;
    return option;
  }));
  $('#planChangeTitle').textContent = `${item.plan.name} 升降配`;
  $('#planChangeDialog').showModal(); refreshPlanChangeQuote().catch(handleError);
}

export async function loadBilling() {
  const [me, plans, orders, upgrades, traffic, redemptions, wallet] = await Promise.all([api('/api/me'), api('/api/cdnfly/v1/packages'), api('/api/cdnfly/v1/orders'), api('/api/cdnfly/v1/package-ups'), api('/api/cdnfly/v1/traffic-packages'), api('/api/billing/redemptions'), api('/api/billing/wallet')]);
  state.me = me; state.billingPlans = extractItems(plans.data); state.billingOrders = extractItems(orders.data); state.billingUpgrades = extractItems(upgrades.data); state.billingTraffic = extractItems(traffic.data); state.redemptions = redemptions.redemptions; state.wallet = wallet; renderTenantBilling(); renderSites(); renderAccountProfile();
  await loadRecoveryStatus();
  setTenantBillingPane(state.billingTarget);
}

$('#refreshBilling').addEventListener('click', () => loadBilling().catch(handleError));

$('#subscriptionCards').addEventListener('change', async event => {
  const input = event.target.closest('[data-auto-renew]'); if (!input) return;
  try { await api(`/api/cdnfly/v1/user-packages/${input.dataset.autoRenew}`, { method: 'PUT', body: JSON.stringify({ autoRenew: input.checked }) }); await loadBilling(); toast(input.checked ? '已开启自动续费' : '已关闭自动续费'); }
  catch (error) { input.checked = !input.checked; handleError(error); }
});

$('#subscriptionCards').addEventListener('click', async event => {
  const changeButton = event.target.closest('[data-change-subscription]');
  if (changeButton) return openPlanChangeDialog(Number(changeButton.dataset.changeSubscription));
  const button = event.target.closest('[data-renew-subscription]'); if (!button) return; const item = tenantSubscriptions().find(row => row.subscription.id === Number(button.dataset.renewSubscription));
  if (!item) return; if (!await confirmAction({ title: '确认续费', message: `${item.plan.name} 将在当前到期时间基础上延长 ${item.plan.durationDays} 天，并从余额支付 ${formatMoney(item.plan.priceCents)}。`, confirmLabel: '立即续费' })) return;
  try { await api(`/api/cdnfly/v1/user-packages/${item.subscription.id}/renew`, { method: 'POST', body: '{}' }); await loadBilling(); toast('套餐续费成功'); } catch (error) { handleError(error); }
});

$('#planChangeForm').elements.package.addEventListener('change', () => refreshPlanChangeQuote().catch(handleError));

$('#planChangeForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#planChangeSubmit');
  if (!state.planChangeQuote) return;
  button.disabled = true;
  try {
    const diffCents = Number(state.planChangeQuote.diff_price_cents);
    await api('/api/cdnfly/v1/user-packages', { method: 'PUT', body: JSON.stringify({ id: Number(form.elements.subscriptionId.value), package: Number(form.elements.package.value) }) });
    $('#planChangeDialog').close(); await loadBilling();
    toast(diffCents > 0 ? '升配成功，差价已扣除' : diffCents < 0 ? '降配成功，差价已退回余额' : '套餐已变更');
  } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#redeemForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try { await api('/api/billing/redeem', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value }) }); form.reset(); await loadBilling(); toast('兑换成功，权益已生效'); } catch (error) { handleError(error); } finally { button.disabled = false; }
});

$('#rechargeCodeForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('button[type=submit]', form); button.disabled = true;
  try { const result = await api('/api/billing/recharge-code', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value }) }); form.reset(); await loadBilling(); toast(`充值成功，到账 ${formatMoney(result.amountCents)}`); } catch (error) { handleError(error); } finally { button.disabled = false; }
});
