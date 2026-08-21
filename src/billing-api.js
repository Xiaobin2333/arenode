import { billingInternals } from './billing.js';
import { changeBalance } from './wallet.js';
import { pagination, paged, searchLike } from './http-utils.js';
import { normalizeCdnflyUrl } from './compat-path.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function int(value, name, { min = 0, nullable = false } = {}) {
  if (nullable && (value === null || value === '' || value === undefined)) return null;
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < min) throw httpError(`${name} 无效`); return parsed;
}
function bodyList(body) { return Array.isArray(body) ? body : [body]; }
function publicSubscription(row) {
  return { id: row.id, userId: row.user_id, planId: row.plan_id, planName: row.plan_name, status: row.status, startsAt: row.starts_at, endsAt: row.ends_at,
    autoRenew: Boolean(row.auto_renew), graceEndsAt: row.grace_ends_at, renewalFailedAt: row.renewal_failed_at, lastRenewedAt: row.last_renewed_at,
    upstreamId: row.upstream_id ? Number(row.upstream_id) : null, upstreamPackageId: row.upstream_package_id || null,
    upstreamName: row.upstream_name || null, createdAt: row.created_at, siteCount: Number(row.site_count || 0), streamCount: Number(row.stream_count || 0) };
}
function publicOrder(row) {
  let snapshot = null; let metadata = null;
  try { snapshot = row.product_snapshot ? JSON.parse(row.product_snapshot) : null; } catch {}
  try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch {}
  return { id: row.id, userId: row.user_id, type: row.type, productId: row.product_id, productName: row.product_name,
    productSnapshot: snapshot, subscriptionId: row.subscription_id, amountCents: Number(row.amount_cents), status: row.status,
    channel: row.channel, metadata, balanceAdjustmentCents: Number(metadata?.walletDeltaCents || 0),
    paidAt: row.paid_at, refundedAt: row.refunded_at, createdAt: row.created_at };
}
function collection(rows) { return { count: rows.length, items: rows }; }
async function ownSubscription(db, userId, id) {
  return db.prepare(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ? AND s.user_id = ?`).get(Number(id), userId) || null;
}
async function ownTrafficPack(db, userId, id) { return db.prepare('SELECT * FROM user_traffic_packages WHERE id = ? AND user_id = ?').get(Number(id), userId); }

async function createOrder(db, { userId, type, productId = null, subscriptionId = null, amountCents, channel = null, metadata = null, productName = null, productSnapshot = null }) {
  return Number((await db.prepare(`INSERT INTO orders (user_id, type, product_id, subscription_id, amount_cents, channel, metadata, product_name, product_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, type, productId, subscriptionId, amountCents, channel,
      metadata ? JSON.stringify(metadata) : null, productName, productSnapshot ? JSON.stringify(productSnapshot) : null)).lastInsertRowid);
}

async function fulfillOrder(db, order) {
  const metadata = order.metadata ? JSON.parse(order.metadata) : {};
  if (order.type === 'plan') {
    const subscription = await db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').get(order.subscription_id, order.user_id);
    if (!subscription) throw httpError('待激活订阅不存在', 409);
    await db.prepare(`UPDATE subscriptions SET status = 'active', starts_at = ?, ends_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(new Date().toISOString(), new Date(Date.now() + metadata.durationDays * 86400_000).toISOString(), subscription.id);
  } else if (order.type === 'upgrade') {
    await db.prepare(`INSERT INTO subscription_upgrades (subscription_id, upgrade_id, amount) VALUES (?, ?, ?)
      ON CONFLICT(subscription_id, upgrade_id) DO UPDATE
      SET amount = subscription_upgrades.amount + excluded.amount`)
      .run(order.subscription_id, order.product_id, metadata.amount || 1);
  } else if (order.type === 'traffic') {
    const template = await db.prepare('SELECT * FROM traffic_packages WHERE id = ?').get(order.product_id);
    if (!template) throw httpError('流量包模板不存在', 409);
    const start = new Date(); const end = new Date(start.getTime() + template.duration_days * 86400_000);
    const id = Number((await db.prepare(`INSERT INTO user_traffic_packages
      (user_id, subscription_id, traffic_package_id, name, traffic_bytes, starts_at, ends_at, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(order.user_id, order.subscription_id, template.id, template.name, template.traffic_bytes, start.toISOString(), end.toISOString())).lastInsertRowid);
    await db.prepare('UPDATE orders SET metadata=? WHERE id=?').run(JSON.stringify({ ...metadata, trafficPackageInstanceId: id }), order.id);
  }
}

async function purchaseWithBalance(db, billing, { userId, type, productId, subscriptionId = null, amountCents, metadata = null }) {
  let orderId; let targetSubscriptionId = subscriptionId; let balanceCents;
  await db.transaction(async transaction => {
    const wallet = await transaction.prepare('SELECT * FROM wallets WHERE user_id=? FOR UPDATE').get(userId);
    if (!wallet || Number(wallet.balance_cents) < Number(amountCents)) throw httpError('账户余额不足', 409);
    let product;
    if (type === 'plan') {
      const plan = await transaction.prepare('SELECT * FROM plans WHERE id=? AND enabled=1').get(productId);
      if (!plan) throw httpError('套餐不存在或已停用', 404);
      const upstreamCount = Number((await transaction.prepare('SELECT COUNT(*) AS count FROM upstream_accounts').get()).count);
      if (upstreamCount && (!plan.upstream_id || !plan.upstream_package_id)) throw httpError('套餐暂不可购买：尚未绑定上游套餐', 409);
      if (upstreamCount) {
        const upstreamPackage = await transaction.prepare(`SELECT up.id FROM upstream_packages up JOIN upstream_accounts ua ON ua.id=up.upstream_id
          WHERE up.upstream_id=? AND up.package_id=? AND up.enabled=1 AND ua.status='active'`).get(plan.upstream_id, plan.upstream_package_id);
        if (!upstreamPackage) throw httpError('套餐暂不可购买：绑定的上游套餐不可用', 409);
      }
      product = { name: plan.name, priceCents: Number(plan.price_cents), durationDays: Number(plan.duration_days), domainLimit: plan.domain_limit, trafficLimitBytes: plan.traffic_limit_bytes, portLimit: plan.port_limit };
      const start = new Date();
      targetSubscriptionId = Number((await transaction.prepare(`INSERT INTO subscriptions
        (user_id, plan_id, status, starts_at, ends_at, upstream_id, upstream_package_id) VALUES (?, ?, 'pending', ?, ?, ?, ?)`)
        .run(userId, plan.id, start.toISOString(), new Date(start.getTime() + plan.duration_days * 86400_000).toISOString(), plan.upstream_id, plan.upstream_package_id)).lastInsertRowid);
    } else if (type === 'upgrade') {
      const row = await transaction.prepare('SELECT * FROM plan_upgrades WHERE id=? AND enabled=1').get(productId);
      if (!row) throw httpError('增值项不存在或已停用', 404);
      product = { name: row.name, priceCents: Number(row.price_cents), domainIncrement: row.domain_increment, trafficIncrementBytes: row.traffic_increment_bytes, portIncrement: row.port_increment, amount: metadata?.amount || 1 };
    } else if (type === 'traffic') {
      const row = await transaction.prepare('SELECT * FROM traffic_packages WHERE id=? AND enabled=1').get(productId);
      if (!row) throw httpError('流量包不存在或已停用', 404);
      product = { name: row.name, priceCents: Number(row.price_cents), trafficBytes: row.traffic_bytes, durationDays: row.duration_days };
    }
    orderId = await createOrder(transaction, { userId, type, productId, subscriptionId: targetSubscriptionId, amountCents, channel: 'balance', metadata,
      productName: product?.name, productSnapshot: product });
    const changed = await changeBalance(transaction, userId, -Number(amountCents), {
      referenceType: 'order', referenceId: String(orderId), description: `订单 #${orderId} 余额支付`,
    });
    balanceCents = changed.balanceCents;
    const order = await transaction.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    await fulfillOrder(transaction, order);
    await transaction.prepare("UPDATE orders SET status='paid', paid_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(new Date().toISOString(), orderId);
  });
  await billing.updateLegacySiteLimit(userId);
  await billing.enforceUser(userId, { syncTraffic: false });
  return { orderId, subscriptionId: targetSubscriptionId, status: 'paid', balanceCents };
}

const DAY_MS = 86400_000;

function sameUpstreamMapping(subscription, plan) {
  return String(subscription.upstream_id ?? '') === String(plan.upstream_id ?? '')
    && String(subscription.upstream_package_id ?? '') === String(plan.upstream_package_id ?? '');
}

function planChangeQuote(subscription, targetPlan, now = new Date()) {
  if (!['active', 'suspended'].includes(subscription.status)) throw httpError('当前套餐状态不允许升降配', 409);
  const effectiveEnd = new Date(subscription.ends_at);
  if (!Number.isFinite(effectiveEnd.getTime()) || effectiveEnd <= now) throw httpError('当前套餐已到期，不能升降配', 409);
  if (!Number(targetPlan.enabled)) throw httpError('目标套餐不存在或已停用', 404);
  if (!sameUpstreamMapping(subscription, targetPlan)) throw httpError('目标套餐与当前上游套餐不兼容', 409);

  const remainDays = Math.max(1, Math.ceil((effectiveEnd.getTime() - now.getTime()) / DAY_MS));
  const currentDuration = Math.max(1, Number(subscription.duration_days));
  const targetDuration = Math.max(1, Number(targetPlan.duration_days));
  const currentPriceCents = Math.round(Number(subscription.price_cents) * remainDays / currentDuration);
  const newPriceCents = Math.round(Number(targetPlan.price_cents) * remainDays / targetDuration);
  const diffPriceCents = newPriceCents - currentPriceCents;
  return {
    period: `${targetDuration}d`, remainDays, currentPriceCents, newPriceCents, originalNewPriceCents: newPriceCents,
    diffPriceCents, originalDiffPriceCents: diffPriceCents,
  };
}

function publicPlanChangeQuote(quote) {
  const money = value => Number((Number(value) / 100).toFixed(2));
  return {
    period: quote.period,
    curr_price: money(quote.currentPriceCents),
    new_price: money(quote.newPriceCents),
    orgin_new_price: money(quote.originalNewPriceCents),
    remain_days: quote.remainDays,
    diff_price: money(quote.diffPriceCents),
    orgin_diff_price: money(quote.originalDiffPriceCents),
    curr_price_cents: quote.currentPriceCents,
    new_price_cents: quote.newPriceCents,
    orgin_new_price_cents: quote.originalNewPriceCents,
    diff_price_cents: quote.diffPriceCents,
    orgin_diff_price_cents: quote.originalDiffPriceCents,
  };
}

async function quoteSubscriptionPlan(db, userId, subscriptionId, targetPlanId) {
  const subscription = await db.prepare(`SELECT s.*, p.name AS plan_name, p.price_cents, p.duration_days
    FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=? AND s.user_id=?`).get(Number(subscriptionId), userId);
  if (!subscription) throw httpError('用户套餐不存在', 404);
  const targetPlan = await db.prepare('SELECT * FROM plans WHERE id=?').get(Number(targetPlanId));
  if (!targetPlan || !Number(targetPlan.enabled)) throw httpError('目标套餐不存在或已停用', 404);
  return { subscription, targetPlan, quote: planChangeQuote(subscription, targetPlan) };
}

async function changeSubscriptionPlan(db, billing, { userId, subscriptionId, targetPlanId }) {
  let result;
  await db.transaction(async transaction => {
    const subscription = await transaction.prepare(`SELECT s.*, p.name AS plan_name, p.price_cents, p.duration_days,
      p.domain_limit, p.traffic_limit_bytes, p.port_limit
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.id=? AND s.user_id=? FOR UPDATE`).get(Number(subscriptionId), userId);
    if (!subscription) throw httpError('用户套餐不存在', 404);

    if (Number(subscription.plan_id) === Number(targetPlanId)) {
      const existing = await transaction.prepare(`SELECT id, metadata FROM orders
        WHERE user_id=? AND subscription_id=? AND type='plan_change' AND product_id=? AND status='paid'
        ORDER BY id DESC LIMIT 1`).get(userId, subscription.id, Number(targetPlanId));
      let metadata = null; try { metadata = existing?.metadata ? JSON.parse(existing.metadata) : null; } catch {}
      result = { idempotent: true, orderId: existing?.id || null, subscriptionId: subscription.id,
        planId: Number(targetPlanId), balanceCents: Number((await transaction.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(userId))?.balance_cents || 0),
        ...(metadata?.quote || {}) };
      return;
    }

    const targetPlan = await transaction.prepare('SELECT * FROM plans WHERE id=?').get(Number(targetPlanId));
    if (!targetPlan || !Number(targetPlan.enabled)) throw httpError('目标套餐不存在或已停用', 404);
    const quote = planChangeQuote(subscription, targetPlan);
    const wallet = await transaction.prepare('SELECT * FROM wallets WHERE user_id=? FOR UPDATE').get(userId);
    if (quote.diffPriceCents > 0 && (!wallet || Number(wallet.balance_cents) < quote.diffPriceCents)) throw httpError('账户余额不足', 409);

    const now = new Date().toISOString();
    const publicQuote = publicPlanChangeQuote(quote);
    const snapshot = {
      name: targetPlan.name, priceCents: Number(targetPlan.price_cents), durationDays: Number(targetPlan.duration_days),
      domainLimit: targetPlan.domain_limit, trafficLimitBytes: targetPlan.traffic_limit_bytes, portLimit: targetPlan.port_limit,
      previousPlanId: Number(subscription.plan_id), previousPlanName: subscription.plan_name,
    };
    const metadata = {
      fromPlanId: Number(subscription.plan_id), toPlanId: Number(targetPlan.id), previousEndsAt: subscription.ends_at,
      walletDeltaCents: -quote.diffPriceCents, quote: publicQuote,
    };
    const idempotencyKey = `plan-change:${subscription.id}:${subscription.plan_id}:${targetPlan.id}:${new Date(subscription.ends_at).toISOString()}`;
    const orderId = Number((await transaction.prepare(`INSERT INTO orders
      (user_id, type, product_id, subscription_id, amount_cents, status, channel, metadata, product_name, product_snapshot, idempotency_key, paid_at)
      VALUES (?, 'plan_change', ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?)`)
      .run(userId, targetPlan.id, subscription.id, Math.abs(quote.diffPriceCents), quote.diffPriceCents >= 0 ? 'balance' : 'balance_refund',
        JSON.stringify(metadata), targetPlan.name, JSON.stringify(snapshot), idempotencyKey, now)).lastInsertRowid);
    const changed = await changeBalance(transaction, userId, -quote.diffPriceCents, {
      referenceType: quote.diffPriceCents >= 0 ? 'order' : 'order-refund', referenceId: String(orderId),
      description: quote.diffPriceCents >= 0 ? `套餐升配订单 #${orderId}` : `套餐降配退款 #${orderId}`,
    });
    await transaction.prepare(`UPDATE subscriptions SET plan_id=?, upstream_id=?, upstream_package_id=?,
      renewal_failed_at=NULL, grace_ends_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(targetPlan.id, targetPlan.upstream_id, targetPlan.upstream_package_id, subscription.id);
    result = { idempotent: false, orderId, subscriptionId: subscription.id, planId: Number(targetPlan.id),
      balanceCents: changed.balanceCents, ...publicQuote };
  });
  if (!result.idempotent) {
    await billing.updateLegacySiteLimit(userId);
    await billing.enforceUser(userId, { syncTraffic: false });
  }
  return result;
}

async function refundOrder(db, billing, orderId) {
  let result;
  await db.transaction(async transaction => {
    const order = await transaction.prepare('SELECT * FROM orders WHERE id=? FOR UPDATE').get(Number(orderId));
    if (!order) throw httpError('订单不存在', 404);
    if (order.status !== 'paid') throw httpError('只有已支付且未退款的订单可以退款', 409);
    let metadata = {}; try { metadata = order.metadata ? JSON.parse(order.metadata) : {}; } catch {}
    if (order.type === 'plan') {
      const bindings = await transaction.prepare(`SELECT
        (SELECT COUNT(*) FROM sites WHERE subscription_id=?) AS sites,
        (SELECT COUNT(*) FROM tenant_resources WHERE subscription_id=?) AS resources`).get(order.subscription_id, order.subscription_id);
      const siteCount = Number(bindings?.sites || 0); const resourceCount = Number(bindings?.resources || 0);
      if (siteCount || resourceCount) {
        throw httpError(`该套餐仍绑定 ${siteCount} 个网站和 ${resourceCount} 个转发或安全资源，请先迁移或删除绑定资源后再退款`, 409);
      }
      await transaction.prepare("UPDATE subscriptions SET status='cancelled', auto_renew=0, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(order.subscription_id, order.user_id);
    } else if (order.type === 'renewal') {
      if (!metadata.previousEndsAt) throw httpError('该历史续费订单缺少可回滚快照', 409);
      const status = new Date(metadata.previousEndsAt) > new Date() ? 'active' : 'expired';
      await transaction.prepare('UPDATE subscriptions SET ends_at=?, status=?, auto_renew=0, grace_ends_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?')
        .run(metadata.previousEndsAt, status, order.subscription_id, order.user_id);
    } else if (order.type === 'upgrade') {
      const row = await transaction.prepare('SELECT amount FROM subscription_upgrades WHERE subscription_id=? AND upgrade_id=?').get(order.subscription_id, order.product_id);
      const amount = Number(metadata.amount || 1);
      if (!row || Number(row.amount) < amount) throw httpError('增值权益状态已变化，无法自动退款', 409);
      if (Number(row.amount) === amount) await transaction.prepare('DELETE FROM subscription_upgrades WHERE subscription_id=? AND upgrade_id=?').run(order.subscription_id, order.product_id);
      else await transaction.prepare('UPDATE subscription_upgrades SET amount=amount-? WHERE subscription_id=? AND upgrade_id=?').run(amount, order.subscription_id, order.product_id);
    } else if (order.type === 'traffic') {
      if (!metadata.trafficPackageInstanceId) throw httpError('该历史流量包订单缺少可回滚快照', 409);
      await transaction.prepare('UPDATE user_traffic_packages SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(metadata.trafficPackageInstanceId, order.user_id);
    } else {
      throw httpError('该订单类型暂不支持自动退款', 409);
    }
    const changed = await changeBalance(transaction, order.user_id, Number(order.amount_cents), {
      referenceType: 'order-refund', referenceId: String(order.id), description: `订单 #${order.id} 全额退款`,
    });
    await transaction.prepare("UPDATE orders SET status='refunded', refunded_at=CURRENT_TIMESTAMP, refund_transaction_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(changed.transactionId, order.id);
    result = { orderId: order.id, userId: order.user_id, amountCents: Number(order.amount_cents), balanceCents: changed.balanceCents };
  });
  await billing.enforceUser(result.userId, { syncTraffic: false });
  return result;
}

function adminPlanInput(body, current = {}) {
  return {
    groupId: body.groupId === undefined ? (current.group_id ?? null) : int(body.groupId, '套餐分组', { nullable: true }),
    code: String(body.code ?? current.code ?? '').trim(), name: String(body.name ?? current.name ?? '').trim(),
    description: body.description === undefined ? (current.description ?? '') : String(body.description || ''),
    priceCents: body.priceCents === undefined ? current.price_cents : int(body.priceCents, '价格'),
    durationDays: body.durationDays === undefined ? (current.duration_days || 30) : int(body.durationDays, '周期', { min: 1 }),
    domainLimit: body.domainLimit === undefined ? current.domain_limit : int(body.domainLimit, '域名额度', { nullable: true }),
    trafficLimitBytes: body.trafficLimitBytes === undefined ? current.traffic_limit_bytes : int(body.trafficLimitBytes, '流量额度', { nullable: true }),
    portLimit: body.portLimit === undefined ? current.port_limit : int(body.portLimit, '端口额度', { nullable: true }),
    enabled: body.enabled === undefined ? Number(current.enabled ?? 1) : Number(Boolean(body.enabled)),
    sort: body.sort === undefined ? Number(current.sort || 0) : int(body.sort, '排序'),
    upstreamId: body.upstreamId === undefined ? (current.upstream_id ?? null) : int(body.upstreamId, '上游账号', { min: 1, nullable: true }),
    upstreamPackageId: body.upstreamPackageId === undefined ? (current.upstream_package_id ?? null) : String(body.upstreamPackageId || '').trim() || null,
  };
}

async function validatePlanMapping(db, input) {
  const upstreamCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM upstream_accounts').get()).count);
  if (!upstreamCount) return;
  if (!input.upstreamId || !input.upstreamPackageId) throw httpError('平台套餐必须绑定一个可用的上游套餐');
  const row = await db.prepare(`SELECT up.id FROM upstream_packages up JOIN upstream_accounts ua ON ua.id=up.upstream_id
    WHERE up.upstream_id=? AND up.package_id=? AND up.enabled=1 AND ua.status='active'`).get(input.upstreamId, input.upstreamPackageId);
  if (!row) throw httpError('选择的上游套餐不存在或已停用');
}

function adminUpgradeInput(body, current = {}) {
  return {
    name: String(body.name ?? current.name ?? '').trim(),
    description: body.description === undefined ? (current.description ?? '') : String(body.description || ''),
    priceCents: body.priceCents === undefined ? current.price_cents : int(body.priceCents, '价格'),
    domainIncrement: body.domainIncrement === undefined ? (current.domain_increment ?? 0) : int(body.domainIncrement, '域名增量'),
    trafficIncrementBytes: body.trafficIncrementBytes === undefined ? (current.traffic_increment_bytes ?? 0) : int(body.trafficIncrementBytes, '流量增量'),
    portIncrement: body.portIncrement === undefined ? (current.port_increment ?? 0) : int(body.portIncrement, '端口增量'),
    enabled: body.enabled === undefined ? Number(current.enabled ?? 1) : Number(Boolean(body.enabled)),
  };
}

function adminTrafficInput(body, current = {}) {
  return {
    name: String(body.name ?? current.name ?? '').trim(),
    description: body.description === undefined ? (current.description ?? '') : String(body.description || ''),
    trafficBytes: body.trafficBytes === undefined ? current.traffic_bytes : int(body.trafficBytes, '流量', { min: 1 }),
    priceCents: body.priceCents === undefined ? current.price_cents : int(body.priceCents, '价格'),
    durationDays: body.durationDays === undefined ? (current.duration_days ?? 30) : int(body.durationDays, '周期', { min: 1 }),
    enabled: body.enabled === undefined ? Number(current.enabled ?? 1) : Number(Boolean(body.enabled)),
  };
}

export async function handleBillingApi({ req, url, user, db, billing, readBody }) {
  normalizeCdnflyUrl(url);
  const prefix = '/api/cdnfly/v1';
  if (user.role === 'user' && url.pathname.startsWith(prefix)) {
    const path = url.pathname.slice(prefix.length);
    if (path === '/package-groups' && req.method === 'GET') return { compat: true, status: 200, data: collection(await db.prepare('SELECT * FROM package_groups WHERE enabled = 1 ORDER BY sort, id').all()) };
    const group = path.match(/^\/package-groups\/(\d+)$/);
    if (group && req.method === 'GET') { const row = await db.prepare('SELECT * FROM package_groups WHERE id = ? AND enabled = 1').get(Number(group[1])); if (!row) throw httpError('套餐分组不存在', 404); return { compat: true, status: 200, data: row }; }
    if (path === '/packages' && req.method === 'GET') return { compat: true, status: 200, data: collection((await db.prepare('SELECT * FROM plans WHERE enabled = 1 ORDER BY sort, id').all()).map(billingInternals.planPublic)) };
    const planMatch = path.match(/^\/packages\/(\d+)$/);
    if (planMatch && req.method === 'GET') { const row = await db.prepare('SELECT * FROM plans WHERE id = ? AND enabled = 1').get(Number(planMatch[1])); if (!row) throw httpError('套餐不存在', 404); return { compat: true, status: 200, data: billingInternals.planPublic(row) }; }
    if (path === '/package-ups' && req.method === 'GET') return { compat: true, status: 200, data: collection(await db.prepare('SELECT * FROM plan_upgrades WHERE enabled = 1 ORDER BY id').all()) };
    const upgradeDetail = path.match(/^\/package-ups\/(\d+)$/);
    if (upgradeDetail && req.method === 'GET') { const row = await db.prepare('SELECT * FROM plan_upgrades WHERE id = ? AND enabled = 1').get(Number(upgradeDetail[1])); if (!row) throw httpError('增值项不存在', 404); return { compat: true, status: 200, data: row }; }

    if (path === '/user-packages' && req.method === 'GET') {
      const rows = (await db.prepare(`SELECT s.*, p.name AS plan_name,
        COALESCE(site_counts.site_count, 0) AS site_count,
        COALESCE(stream_counts.stream_count, 0) AS stream_count
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        LEFT JOIN (
          SELECT subscription_id, COUNT(*) AS site_count FROM sites GROUP BY subscription_id
        ) site_counts ON site_counts.subscription_id = s.id
        LEFT JOIN (
          SELECT subscription_id, COUNT(*) AS stream_count FROM tenant_resources
          WHERE kind='streams' GROUP BY subscription_id
        ) stream_counts ON stream_counts.subscription_id = s.id
        WHERE s.user_id = ? ORDER BY s.id DESC`).all(user.id)).map(publicSubscription);
      return { compat: true, status: 200, data: collection(rows) };
    }
    if (path === '/user-packages' && req.method === 'POST') {
      const body = await readBody(req); const plan = await db.prepare('SELECT * FROM plans WHERE id = ? AND enabled = 1').get(int(body.planId ?? body.package, '套餐'));
      if (!plan) throw httpError('套餐不存在', 404);
      const purchased = await purchaseWithBalance(db, billing, { userId: user.id, type: 'plan', productId: plan.id, amountCents: Number(plan.price_cents), metadata: { durationDays: plan.duration_days } });
      return { compat: true, status: 201, data: { id: purchased.subscriptionId, ...purchased }, action: 'subscription.purchase', resourceId: purchased.subscriptionId };
    }
    if (path === '/user-packages' && req.method === 'PUT') {
      const body = await readBody(req); const items = bodyList(body);
      const changes = [];
      for (const item of items) {
        const row = await ownSubscription(db, user.id, item.id); if (!row) throw httpError('用户套餐不存在', 404);
        if (item.package !== undefined || item.planId !== undefined) changes.push(await changeSubscriptionPlan(db, billing, {
          userId: user.id, subscriptionId: row.id, targetPlanId: int(item.package ?? item.planId, '目标套餐', { min: 1 }),
        }));
        if (item.autoRenew !== undefined) await db.prepare('UPDATE subscriptions SET auto_renew = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(Boolean(item.autoRenew)), row.id);
      }
      return { compat: true, status: 200, data: changes.length ? (changes.length === 1 ? changes[0] : changes) : true,
        ...(changes.length ? { action: 'subscription.plan-change', resourceId: changes.map(item => item.subscriptionId).join(',') } : {}) };
    }
    const subMatch = path.match(/^\/user-packages\/(\d+)$/);
    if (subMatch) {
      const sub = await ownSubscription(db, user.id, subMatch[1]); if (!sub) throw httpError('用户套餐不存在', 404);
      if (req.method === 'GET') {
        const data = { ...publicSubscription(sub), billing: await billing.subscriptionSnapshot(user.id, sub.id) };
        if (url.searchParams.has('to_package')) {
          const quoted = await quoteSubscriptionPlan(db, user.id, sub.id, int(url.searchParams.get('to_package'), '目标套餐', { min: 1 }));
          Object.assign(data, publicPlanChangeQuote(quoted.quote), { to_package: Number(quoted.targetPlan.id), to_package_name: quoted.targetPlan.name });
        }
        return { compat: true, status: 200, data };
      }
      if (req.method === 'PUT') {
        const body = await readBody(req); let changed = null;
        if (body.package !== undefined || body.planId !== undefined) changed = await changeSubscriptionPlan(db, billing, {
          userId: user.id, subscriptionId: sub.id, targetPlanId: int(body.package ?? body.planId, '目标套餐', { min: 1 }),
        });
        if (body.autoRenew !== undefined) await db.prepare('UPDATE subscriptions SET auto_renew = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(Boolean(body.autoRenew)), sub.id);
        return { compat: true, status: 200, data: changed || true, ...(changed ? { action: 'subscription.plan-change', resourceId: sub.id } : {}) };
      }
      if (req.method === 'DELETE') { const resources = await billing.subscriptionResourceCounts(user.id, sub.id); if (resources.sites || resources.streams) throw httpError('请先迁移该套餐下的网站和转发', 409); await db.prepare("UPDATE subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sub.id); if (sub.status === 'pending') await db.prepare("UPDATE orders SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND subscription_id=? AND status='pending'").run(user.id, sub.id); await billing.enforceUser(user.id); return { compat: true, status: 200, data: true, action: 'subscription.cancel', resourceId: sub.id }; }
    }
    const renewMatch = path.match(/^\/user-packages\/(\d+)\/renew$/);
    if (renewMatch && req.method === 'POST') {
      const sub = await ownSubscription(db, user.id, renewMatch[1]); if (!sub) throw httpError('客户套餐不存在', 404);
      const renewed = await billing.renewSubscription(sub.id, { automatic: false });
      return { compat: true, status: 201, data: renewed, action: 'subscription.renew', resourceId: renewed.orderId };
    }
    const usageMatch = path.match(/^\/user-package\/(\d+)\/usage$/);
    if (usageMatch && req.method === 'GET') { if (!await ownSubscription(db, user.id, usageMatch[1])) throw httpError('用户套餐不存在', 404); return { compat: true, status: 200, data: await billing.subscriptionSnapshot(user.id, Number(usageMatch[1])) }; }
    const upgrades = path.match(/^\/user-package\/(\d+)\/upgrades$/);
    if (upgrades) {
      const sub = await ownSubscription(db, user.id, upgrades[1]); if (!sub) throw httpError('用户套餐不存在', 404);
      if (req.method === 'GET') return { compat: true, status: 200, data: collection(await db.prepare(`SELECT su.amount, u.* FROM subscription_upgrades su JOIN plan_upgrades u ON u.id = su.upgrade_id WHERE su.subscription_id = ?`).all(sub.id)) };
      if (req.method === 'POST') { const body = await readBody(req); const up = await db.prepare('SELECT * FROM plan_upgrades WHERE id = ? AND enabled = 1').get(int(body.upgradeId ?? body.up_id, '增值项')); if (!up) throw httpError('增值项不存在', 404); const amount = int(body.amount ?? 1, '数量', { min: 1 }); const purchased = await purchaseWithBalance(db, billing, { userId: user.id, type: 'upgrade', productId: up.id, subscriptionId: sub.id, amountCents: Number(up.price_cents) * amount, metadata: { amount } }); return { compat: true, status: 201, data: purchased, action: 'upgrade.purchase', resourceId: purchased.orderId }; }
      if (req.method === 'PUT') throw httpError('已购增值项数量只能通过新订单增加', 403);
    }
    const upgradeOne = path.match(/^\/user-package\/(\d+)\/upgrades\/(\d+)$/);
    if (upgradeOne) {
      const sub = await ownSubscription(db, user.id, upgradeOne[1]); if (!sub) throw httpError('用户套餐不存在', 404);
      const up = await db.prepare('SELECT * FROM plan_upgrades WHERE id = ?').get(Number(upgradeOne[2])); if (!up) throw httpError('增值项不存在', 404);
      if (req.method === 'GET') { const days = Math.max(0, (new Date(sub.ends_at) - Date.now()) / 86400_000); return { compat: true, status: 200, data: { priceCents: Math.ceil(up.price_cents * days / 30), remainingDays: Math.ceil(days) } }; }
      if (req.method === 'DELETE') throw httpError('已生效增值权益只能由管理员调整', 403);
    }

    if (path === '/traffic-packages' && req.method === 'GET') return { compat: true, status: 200, data: collection(await db.prepare('SELECT * FROM traffic_packages WHERE enabled = 1 ORDER BY id').all()) };
    const trafficTemplate = path.match(/^\/traffic-packages\/(\d+)$/);
    if (trafficTemplate && req.method === 'GET') { const row = await db.prepare('SELECT * FROM traffic_packages WHERE id = ? AND enabled = 1').get(Number(trafficTemplate[1])); if (!row) throw httpError('流量包不存在', 404); return { compat: true, status: 200, data: row }; }
    if (path === '/user-traffic-packages' && req.method === 'GET') return { compat: true, status: 200, data: collection(await db.prepare('SELECT * FROM user_traffic_packages WHERE user_id = ? ORDER BY id DESC').all(user.id)) };
    if (path === '/user-traffic-packages' && req.method === 'POST') { const body = await readBody(req); const template = await db.prepare('SELECT * FROM traffic_packages WHERE id = ? AND enabled = 1').get(int(body.trafficPackageId ?? body.package, '流量包')); if (!template) throw httpError('流量包不存在', 404); const sub = await ownSubscription(db, user.id, body.subscriptionId ?? body.user_package); if (!sub) throw httpError('用户套餐不存在', 404); const purchased = await purchaseWithBalance(db, billing, { userId: user.id, type: 'traffic', productId: template.id, subscriptionId: sub.id, amountCents: Number(template.price_cents) }); return { compat: true, status: 201, data: purchased, action: 'traffic.purchase', resourceId: purchased.orderId }; }
    if (path === '/user-traffic-packages' && req.method === 'PUT') {
      const body = await readBody(req);
      for (const item of bodyList(body)) if (!await ownTrafficPack(db, user.id, item.id)) throw httpError('已购流量包不存在', 404);
      throw httpError('已购流量包权益不可由客户直接修改', 403);
    }
    const userTraffic = path.match(/^\/user-traffic-packages\/(\d+)$/);
    if (userTraffic) { const row = await ownTrafficPack(db, user.id, userTraffic[1]); if (!row) throw httpError('已购流量包不存在', 404); if (req.method === 'GET') return { compat: true, status: 200, data: row }; if (req.method === 'PUT') throw httpError('已购流量包权益不可由客户直接修改', 403); if (req.method === 'DELETE') throw httpError('仅管理员可删除已购流量包', 403); }
    if (path === '/user-traffic-package-usage' && req.method === 'GET') return { compat: true, status: 200, data: [{ period: new Date().toISOString().slice(0, 7), value: (await billing.usage(user.id)).trafficBytes }] };

    if (path === '/orders' && req.method === 'GET') {
      const { page, pageSize, offset } = pagination(url);
      const total = (await db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(user.id)).count;
      const rows = await db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(user.id, pageSize, offset);
      return { compat: true, status: 200, data: { count: Number(total), items: rows.map(publicOrder), pagination: { page, pageSize, total: Number(total), pages: Math.max(1, Math.ceil(Number(total) / pageSize)) } } };
    }
    const orderDetail = path.match(/^\/orders\/(\d+)$/);
    if (orderDetail && req.method === 'GET') { const row = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(orderDetail[1]), user.id); if (!row) throw httpError('订单不存在', 404); return { compat: true, status: 200, data: publicOrder(row) }; }
    if (path === '/order-count' && req.method === 'GET') {
      const groupBy = String(url.searchParams.get('group_by') || 'day');
      if (!['day', 'month', 'year'].includes(groupBy)) throw httpError('group_by 必须是 day、month 或 year');
      const rows = await db.prepare('SELECT created_at, amount_cents FROM orders WHERE user_id=? ORDER BY created_at').all(user.id);
      const groups = new Map();
      for (const row of rows) {
        const date = new Date(row.created_at); if (!Number.isFinite(date.getTime())) continue;
        const iso = date.toISOString(); const time = groupBy === 'year' ? iso.slice(0, 4) : groupBy === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
        groups.set(time, (groups.get(time) || 0) + Number(row.amount_cents || 0));
      }
      const data = [...groups.entries()].map(([time, cents]) => ({ time, sum: (cents / 100).toFixed(2).replace(/\.?(0+)$/, '') || '0' }));
      return { compat: true, status: 200, data: { count: data.length, data } };
    }
    if (['/alipay-preorder', '/wxpay-preorder'].includes(path) && req.method === 'POST') throw httpError('平台未配置可验证的支付渠道', 501);
    return null;
  }

  const adminPrefix = '/api/admin/billing';
  if (user.role === 'admin' && url.pathname.startsWith(adminPrefix)) {
    const path = url.pathname.slice(adminPrefix.length) || '/';
    if (path === '/plans' && req.method === 'GET') return { status: 200, data: { plans: (await db.prepare(`SELECT p.*,ua.name AS upstream_name,up.name AS upstream_package_name FROM plans p
      LEFT JOIN upstream_accounts ua ON ua.id=p.upstream_id LEFT JOIN upstream_packages up ON up.upstream_id=p.upstream_id AND up.package_id=p.upstream_package_id ORDER BY p.sort,p.id`).all()).map(row => ({ ...billingInternals.planPublic(row), upstreamName: row.upstream_name || null, upstreamPackageName: row.upstream_package_name || null })) } };
    if (path === '/plans' && req.method === 'POST') { const input = adminPlanInput(await readBody(req)); if (!input.code || !input.name) throw httpError('套餐代码和名称必填'); await validatePlanMapping(db, input); const id = (await db.prepare(`INSERT INTO plans (group_id, code, name, description, price_cents, duration_days, domain_limit, traffic_limit_bytes, port_limit, enabled, sort, upstream_id, upstream_package_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.groupId, input.code, input.name, input.description, input.priceCents, input.durationDays, input.domainLimit, input.trafficLimitBytes, input.portLimit, input.enabled, input.sort, input.upstreamId, input.upstreamPackageId)).lastInsertRowid; return { status: 201, data: { plan: billingInternals.planPublic(await db.prepare('SELECT * FROM plans WHERE id = ?').get(id)) }, action: 'plan.create', resourceId: id }; }
    const adminPlan = path.match(/^\/plans\/(\d+)$/);
    if (adminPlan) { const current = await db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(adminPlan[1])); if (!current) throw httpError('套餐不存在', 404); if (req.method === 'PUT') { const i = adminPlanInput(await readBody(req), current); await validatePlanMapping(db, i); await db.prepare(`UPDATE plans SET group_id=?, code=?, name=?, description=?, price_cents=?, duration_days=?, domain_limit=?, traffic_limit_bytes=?, port_limit=?, enabled=?, sort=?, upstream_id=?,upstream_package_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(i.groupId, i.code, i.name, i.description, i.priceCents, i.durationDays, i.domainLimit, i.trafficLimitBytes, i.portLimit, i.enabled, i.sort, i.upstreamId, i.upstreamPackageId, current.id); await billing.enforceAll({ syncTraffic: false }); return { status: 200, data: { plan: billingInternals.planPublic(await db.prepare('SELECT * FROM plans WHERE id = ?').get(current.id)) }, action: 'plan.update', resourceId: current.id }; } if (req.method === 'DELETE') { await db.prepare('UPDATE plans SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(current.id); return { status: 200, data: { ok: true }, action: 'plan.disable', resourceId: current.id }; } }
    if (path === '/groups' && req.method === 'GET') return { status: 200, data: { groups: await db.prepare('SELECT * FROM package_groups ORDER BY sort,id').all() } };
    if (path === '/groups' && req.method === 'POST') { const b = await readBody(req); const name = String(b.name || '').trim(); if (!name) throw httpError('分组名称必填'); const id = (await db.prepare('INSERT INTO package_groups (name, description, sort, enabled) VALUES (?, ?, ?, ?)').run(name, String(b.description || ''), int(b.sort || 0, '排序'), Number(b.enabled !== false))).lastInsertRowid; return { status: 201, data: { id: Number(id) } }; }
    const adminGroup = path.match(/^\/groups\/(\d+)$/);
    if (adminGroup) { const row = await db.prepare('SELECT * FROM package_groups WHERE id = ?').get(Number(adminGroup[1])); if (!row) throw httpError('套餐分组不存在', 404); if (req.method === 'PUT') { const b = await readBody(req); const name = String(b.name ?? row.name).trim(); if (!name) throw httpError('分组名称必填'); await db.prepare('UPDATE package_groups SET name=?, description=?, sort=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, b.description === undefined ? row.description : String(b.description || ''), b.sort === undefined ? row.sort : int(b.sort, '排序'), b.enabled === undefined ? row.enabled : Number(Boolean(b.enabled)), row.id); return { status: 200, data: { group: await db.prepare('SELECT * FROM package_groups WHERE id = ?').get(row.id) }, action: 'package-group.update', resourceId: row.id }; } if (req.method === 'DELETE') { await db.prepare('UPDATE package_groups SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id); return { status: 200, data: { ok: true }, action: 'package-group.disable', resourceId: row.id }; } }
    if (path === '/upgrades' && req.method === 'GET') return { status: 200, data: { upgrades: await db.prepare('SELECT * FROM plan_upgrades ORDER BY id').all() } };
    if (path === '/upgrades' && req.method === 'POST') { const i = adminUpgradeInput(await readBody(req)); if (!i.name) throw httpError('增值项名称必填'); const id = (await db.prepare(`INSERT INTO plan_upgrades (name, description, price_cents, domain_increment, traffic_increment_bytes, port_increment, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(i.name, i.description, i.priceCents, i.domainIncrement, i.trafficIncrementBytes, i.portIncrement, i.enabled)).lastInsertRowid; return { status: 201, data: { id: Number(id) } }; }
    const adminUpgrade = path.match(/^\/upgrades\/(\d+)$/);
    if (adminUpgrade) { const row = await db.prepare('SELECT * FROM plan_upgrades WHERE id = ?').get(Number(adminUpgrade[1])); if (!row) throw httpError('增值项不存在', 404); if (req.method === 'PUT') { const i = adminUpgradeInput(await readBody(req), row); if (!i.name) throw httpError('增值项名称必填'); await db.prepare('UPDATE plan_upgrades SET name=?, description=?, price_cents=?, domain_increment=?, traffic_increment_bytes=?, port_increment=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(i.name, i.description, i.priceCents, i.domainIncrement, i.trafficIncrementBytes, i.portIncrement, i.enabled, row.id); await billing.enforceAll({ syncTraffic: false }); return { status: 200, data: { upgrade: await db.prepare('SELECT * FROM plan_upgrades WHERE id = ?').get(row.id) }, action: 'upgrade.update', resourceId: row.id }; } if (req.method === 'DELETE') { await db.prepare('UPDATE plan_upgrades SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id); await billing.enforceAll({ syncTraffic: false }); return { status: 200, data: { ok: true }, action: 'upgrade.disable', resourceId: row.id }; } }
    if (path === '/traffic-packages' && req.method === 'GET') return { status: 200, data: { trafficPackages: await db.prepare('SELECT * FROM traffic_packages ORDER BY id').all() } };
    if (path === '/traffic-packages' && req.method === 'POST') { const i = adminTrafficInput(await readBody(req)); if (!i.name) throw httpError('流量包名称必填'); const id = (await db.prepare(`INSERT INTO traffic_packages (name, description, traffic_bytes, price_cents, duration_days, enabled) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(i.name, i.description, i.trafficBytes, i.priceCents, i.durationDays, i.enabled)).lastInsertRowid; return { status: 201, data: { id: Number(id) } }; }
    const adminTraffic = path.match(/^\/traffic-packages\/(\d+)$/);
    if (adminTraffic) { const row = await db.prepare('SELECT * FROM traffic_packages WHERE id = ?').get(Number(adminTraffic[1])); if (!row) throw httpError('流量包不存在', 404); if (req.method === 'PUT') { const i = adminTrafficInput(await readBody(req), row); if (!i.name) throw httpError('流量包名称必填'); await db.prepare('UPDATE traffic_packages SET name=?, description=?, traffic_bytes=?, price_cents=?, duration_days=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(i.name, i.description, i.trafficBytes, i.priceCents, i.durationDays, i.enabled, row.id); return { status: 200, data: { trafficPackage: await db.prepare('SELECT * FROM traffic_packages WHERE id = ?').get(row.id) }, action: 'traffic-package.update', resourceId: row.id }; } if (req.method === 'DELETE') { await db.prepare('UPDATE traffic_packages SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id); return { status: 200, data: { ok: true }, action: 'traffic-package.disable', resourceId: row.id }; } }
    if (path === '/subscriptions' && req.method === 'GET') {
      const { page, pageSize, offset } = pagination(url); const clauses = ['1=1']; const params = [];
      const q = url.searchParams.get('q'); const status = url.searchParams.get('status');
      if (q) { clauses.push('(u.username LIKE ? OR p.name LIKE ?)'); const like = searchLike(q); params.push(like, like); }
      if (status) { clauses.push('s.status=?'); params.push(status); }
      const where = clauses.join(' AND ');
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.user_id WHERE ${where}`).get(...params)).count;
      const rows = await db.prepare(`SELECT s.*, p.name AS plan_name, u.username, ua.name AS upstream_name,
        (SELECT COUNT(*) FROM sites st WHERE st.subscription_id=s.id) AS site_count,
        (SELECT COUNT(*) FROM tenant_resources tr WHERE tr.subscription_id=s.id AND tr.kind='streams') AS stream_count
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.user_id LEFT JOIN upstream_accounts ua ON ua.id=s.upstream_id WHERE ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
      return { status: 200, data: paged(rows.map(row => ({ ...publicSubscription(row), username: row.username })), total, page, pageSize, 'subscriptions') };
    }
    if (path === '/subscriptions' && req.method === 'POST') { const b = await readBody(req); const id = await billing.assignPlan(int(b.userId, '用户', { min: 1 }), int(b.planId, '套餐', { min: 1 }), { status: b.status || 'active', startsAt: b.startsAt || new Date(), endsAt: b.endsAt || null }); await billing.enforceUser(Number(b.userId)); return { status: 201, data: { id }, action: 'subscription.assign', resourceId: id }; }
    const adminSubscription = path.match(/^\/subscriptions\/(\d+)$/);
    if (adminSubscription) { const row = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(Number(adminSubscription[1])); if (!row) throw httpError('用户套餐不存在', 404); if (req.method === 'PUT') { const b = await readBody(req); const status = b.status ?? row.status; if (!['active', 'suspended', 'expired', 'cancelled'].includes(status)) throw httpError('套餐状态无效'); const resources = await billing.subscriptionResourceCounts(row.user_id, row.id); if (['expired', 'cancelled'].includes(status) && (resources.sites || resources.streams)) throw httpError('请先迁移该套餐下的网站和转发', 409); const startsAt = b.startsAt === undefined ? row.starts_at : new Date(b.startsAt).toISOString(); const endsAt = b.endsAt === undefined ? row.ends_at : new Date(b.endsAt).toISOString(); if (new Date(endsAt) <= new Date(startsAt)) throw httpError('套餐有效期无效'); await db.prepare('UPDATE subscriptions SET status=?, starts_at=?, ends_at=?, auto_renew=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, startsAt, endsAt, b.autoRenew === undefined ? row.auto_renew : Number(Boolean(b.autoRenew)), row.id); await billing.enforceUser(row.user_id, { syncTraffic: false }); return { status: 200, data: { subscription: publicSubscription(await db.prepare(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?`).get(row.id)) }, action: 'subscription.update', resourceId: row.id }; } if (req.method === 'DELETE') { const resources = await billing.subscriptionResourceCounts(row.user_id, row.id); if (resources.sites || resources.streams) throw httpError('请先迁移该套餐下的网站和转发', 409); await db.prepare("UPDATE subscriptions SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id); await billing.enforceUser(row.user_id, { syncTraffic: false }); return { status: 200, data: { ok: true }, action: 'subscription.cancel', resourceId: row.id }; } }
    const adminOrder = path.match(/^\/orders\/(\d+)$/);
    const adminRefund = path.match(/^\/orders\/(\d+)\/refund$/);
    if (path === '/orders' && req.method === 'GET') {
      const { page, pageSize, offset } = pagination(url); const clauses = ['1=1']; const params = [];
      const q = url.searchParams.get('q'); const status = url.searchParams.get('status'); const type = url.searchParams.get('type');
      if (q) { clauses.push('(u.username LIKE ? OR CAST(o.id AS TEXT) LIKE ?)'); const like = searchLike(q); params.push(like, like); }
      if (status) { clauses.push('o.status=?'); params.push(status); }
      if (type) { clauses.push('o.type=?'); params.push(type); }
      const where = clauses.join(' AND ');
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM orders o JOIN users u ON u.id=o.user_id WHERE ${where}`).get(...params)).count;
      const rows = await db.prepare(`SELECT o.*, u.username FROM orders o JOIN users u ON u.id=o.user_id WHERE ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
      return { status: 200, data: paged(rows.map(row => ({ ...publicOrder(row), username: row.username })), total, page, pageSize, 'orders') };
    }
    if (adminOrder && req.method === 'GET') {
      const row = await db.prepare(`SELECT o.*, u.username, wt.id AS transaction_id, wt.balance_after_cents
        FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN wallet_transactions wt ON wt.reference_type IN ('order','order-refund') AND wt.reference_id=CAST(o.id AS TEXT)
        WHERE o.id=?`).get(Number(adminOrder[1]));
      if (!row) throw httpError('订单不存在', 404);
      return { status: 200, data: { order: { ...publicOrder(row), username: row.username, transactionId: row.transaction_id, balanceAfterCents: row.balance_after_cents } } };
    }
    if (adminRefund && req.method === 'POST') {
      const refunded = await refundOrder(db, billing, adminRefund[1]);
      return { status: 200, data: refunded, action: 'order.refund', resourceId: refunded.orderId };
    }
    if (adminOrder && req.method === 'PUT') {
      throw httpError('订单使用余额即时支付，无需管理员确认', 405);
    }
    if (path === '/enforce' && req.method === 'POST') return { status: 200, data: { results: (await billing.runScheduled({ syncTraffic: true })).value?.enforcement || [] }, action: 'quota.enforce' };
    if (path === '/usage' && req.method === 'GET') {
      const { page, pageSize, offset } = pagination(url); const q = url.searchParams.get('q'); const params = [];
      const where = q ? "role='user' AND username LIKE ?" : "role='user'"; if (q) params.push(searchLike(q));
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM users WHERE ${where}`).get(...params)).count;
      const users = await db.prepare(`SELECT id, username FROM users WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
      return { status: 200, data: paged(await Promise.all(users.map(async row => ({ ...row, billing: await billing.snapshot(row.id) }))), total, page, pageSize, 'users') };
    }
    return null;
  }
  return null;
}
