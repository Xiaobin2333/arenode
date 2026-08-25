import crypto from 'node:crypto';
import { changeBalance } from './wallet.js';
import { ensureCustomerUpstreamGroups } from './customer-groups.js';

const GIB = 1024 ** 3;

const DEFAULT_PLANS = [
  ['trial', '试用版', 300, 1, 10 * GIB, 0, 10],
  ['experience', '体验版', 500, 3, 30 * GIB, 0, 20],
  ['standard', '普惠版', 2800, 8, 100 * GIB, 3, 30],
  ['basic', '基础版', 4800, 15, 512 * GIB, 8, 40],
  ['advanced', '高级版', 6800, 30, 1024 * GIB, 15, 50],
  ['ultimate', '终极版', 9800, null, null, null, 60],
];

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400_000);
}

function periodKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthRange(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

function domainCount(value) {
  return String(value || '').split(/[\s,]+/).filter(Boolean).length;
}

function purchaseMode(plan) {
  return plan?.purchase_mode === 'once' ? 'once' : 'stack';
}

function maxPurchaseQty(plan) {
  const parsed = Number.parseInt(plan?.max_purchase_qty, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function renewalMode(plan) {
  return plan?.renewal_mode === 'off' || plan?.renewal_mode === 'window' ? plan.renewal_mode : 'anytime';
}

function renewalWindowDays(plan) {
  const parsed = Number.parseInt(plan?.renewal_window_days, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 7;
}

function assertRenewalAllowed(plan, subscription, now = new Date()) {
  const mode = renewalMode(plan);
  if (mode === 'off') throw Object.assign(new Error('该套餐禁止续费'), { status: 409 });
  if (mode === 'window' && subscription?.ends_at) {
    const ends = new Date(subscription.ends_at);
    const windowDays = renewalWindowDays(plan);
    if (Number.isFinite(ends.getTime()) && ends.getTime() - now.getTime() > windowDays * 86400_000) {
      throw Object.assign(new Error(`该套餐仅可在到期前 ${windowDays} 天内续费`), { status: 409 });
    }
  }
}

function stackBaseDate(subscription, now = new Date()) {
  if (!subscription?.ends_at) return now;
  const ends = new Date(subscription.ends_at);
  return Number.isFinite(ends.getTime()) && ends > now ? ends : now;
}

async function livePlanSubscription(db, userId, planId, { forUpdate = false } = {}) {
  const now = new Date().toISOString();
  const lock = forUpdate ? ' FOR UPDATE' : '';
  return await db.prepare(`SELECT * FROM subscriptions
    WHERE user_id=? AND plan_id=? AND status IN ('active', 'suspended', 'pending')
      AND (ends_at > ? OR (grace_ends_at IS NOT NULL AND grace_ends_at > ?))
    ORDER BY ends_at DESC, id DESC LIMIT 1${lock}`).get(userId, planId, now, now) || null;
}

function planPublic(row) {
  if (!row) return null;
  return {
    id: row.id, groupId: row.group_id, code: row.code, name: row.name, description: row.description,
    priceCents: row.price_cents, durationDays: row.duration_days, domainLimit: row.domain_limit,
    trafficLimitBytes: row.traffic_limit_bytes, portLimit: row.port_limit, enabled: Boolean(row.enabled), sort: row.sort,
    purchaseMode: purchaseMode(row), maxPurchaseQty: maxPurchaseQty(row),
    renewalMode: renewalMode(row), renewalWindowDays: renewalWindowDays(row),
    upstreamId: row.upstream_id ? Number(row.upstream_id) : null, upstreamPackageId: row.upstream_package_id || null,
  };
}

function usageRows(data, resourceIds) {
  const rows = Array.isArray(data) ? data : (data?.items || data?.data || data?.rows || []);
  const ids = new Set(resourceIds.map(value => String(value)));
  const identified = rows.filter(row => row?.resource_id !== undefined || row?.resourceId !== undefined
    || row?.site_id !== undefined || row?.stream_id !== undefined || row?.res_id !== undefined);
  return identified.length ? identified.filter(row => ids.has(String(row.resource_id ?? row.resourceId ?? row.site_id ?? row.stream_id ?? row.res_id))) : rows;
}

export async function seedBilling(db) {
  let group = await db.prepare('SELECT * FROM package_groups ORDER BY id LIMIT 1').get();
  if (!group) {
    const id = (await db.prepare(`INSERT INTO package_groups (name, description, sort, enabled) VALUES ('套餐资源', 'CDN 加速套餐', 10, 1)`).run()).lastInsertRowid;
    group = await db.prepare('SELECT * FROM package_groups WHERE id = ?').get(id);
  }
  const existing = Number((await db.prepare('SELECT COUNT(*) AS count FROM plans').get()).count);
  if (existing) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO plans
    (group_id, code, name, price_cents, duration_days, domain_limit, traffic_limit_bytes, port_limit, enabled, sort)
    VALUES (?, ?, ?, ?, 30, ?, ?, ?, 1, ?)`);
  for (const [code, name, price, domains, traffic, ports, sort] of DEFAULT_PLANS) await insert.run(group.id, code, name, price, domains, traffic, ports, sort);
}

export class BillingService {
  constructor(db, cdnfly, { renewalGraceDays = 3, settingsProvider = null, upstreams = null } = {}) {
    this.db = db;
    this.cdnfly = cdnfly;
    this.renewalGraceDays = renewalGraceDays;
    this.settingsProvider = settingsProvider;
    this.upstreams = upstreams;
    this.scheduler = { startedAt: null, lastRunAt: null, lastRunOk: null, lastRunError: null, runningSince: null, intervalMs: null, durationMs: null };
  }

  async initialize() {
    await seedBilling(this.db);
    await this.processLifecycle();
    await this.ensureResourceAssignments();
    return this;
  }

  async ensureDefaultSubscriptions() {
    // Compatibility hook for older callers. New users must never receive an
    // implicit trial; plans require an explicit purchase or assignment.
    return 0;
  }

  async ensureResourceAssignments() {
    const users = await this.db.prepare("SELECT id FROM users WHERE role = 'user'").all();
    for (const user of users) {
      const subscription = await this.activeSubscription(user.id);
      if (!subscription) continue;
      await this.db.prepare('UPDATE sites SET subscription_id = ? WHERE owner_id = ? AND subscription_id IS NULL').run(subscription.id, user.id);
      await this.db.prepare("UPDATE tenant_resources SET subscription_id = ? WHERE owner_id = ? AND kind = 'streams' AND subscription_id IS NULL").run(subscription.id, user.id);
      await this.db.prepare('UPDATE sites SET upstream_account_id=? WHERE owner_id=? AND subscription_id=? AND upstream_account_id IS NULL').run(subscription.upstream_id, user.id, subscription.id);
      await this.db.prepare("UPDATE tenant_resources SET upstream_account_id=? WHERE owner_id=? AND subscription_id=? AND kind='streams' AND upstream_account_id IS NULL").run(subscription.upstream_id, user.id, subscription.id);
      await this.updateLegacySiteLimit(user.id);
    }
  }

  async assignPlan(userId, planId, { status = 'active', startsAt = new Date(), endsAt = null } = {}) {
    const user = await this.db.prepare("SELECT id FROM users WHERE id = ? AND role = 'user'").get(Number(userId));
    if (!user) throw Object.assign(new Error('客户不存在'), { status: 404 });
    const plan = await this.db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(planId));
    if (!plan) throw Object.assign(new Error('套餐不存在'), { status: 404 });
    if (!['active', 'suspended'].includes(status)) throw new Error('套餐状态无效');
    const start = new Date(startsAt);
    if (!Number.isFinite(start.getTime())) throw new Error('套餐有效期无效');
    if (this.upstreams && (!plan.upstream_id || !plan.upstream_package_id)) throw Object.assign(new Error('套餐未绑定可用的上游套餐'), { status: 409 });
    const owned = await livePlanSubscription(this.db, userId, plan.id);
    const mode = purchaseMode(plan);
    if (owned) {
      if (mode === 'once') throw Object.assign(new Error('该套餐每位客户只能持有一份'), { status: 409 });
      assertRenewalAllowed(plan, owned);
      const now = new Date();
      const end = endsAt ? new Date(endsAt) : addDays(stackBaseDate(owned, now), plan.duration_days);
      if (!Number.isFinite(end.getTime()) || end <= now) throw new Error('套餐有效期无效');
      await this.db.prepare(`UPDATE subscriptions SET status=?, ends_at=?, grace_ends_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(status, end.toISOString(), owned.id);
      await this.updateLegacySiteLimit(userId);
      return Number(owned.id);
    }
    const end = endsAt ? new Date(endsAt) : addDays(start, plan.duration_days);
    if (!Number.isFinite(end.getTime()) || end <= start) throw new Error('套餐有效期无效');
    const id = (await this.db.prepare(`INSERT INTO subscriptions
      (user_id, plan_id, status, starts_at, ends_at, upstream_id, upstream_package_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, plan.id, status, start.toISOString(), end.toISOString(), plan.upstream_id, plan.upstream_package_id)).lastInsertRowid;
    await this.updateLegacySiteLimit(userId);
    return Number(id);
  }

  async activeSubscriptions(userId) {
    const now = new Date().toISOString();
    await this.db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('active', 'suspended')
        AND ((auto_renew=0 AND grace_ends_at IS NULL AND ends_at<=?) OR (grace_ends_at IS NOT NULL AND grace_ends_at<=?))`).run(userId, now, now);
    return this.db.prepare(`SELECT s.*, p.group_id, p.code, p.name AS plan_name, p.description AS plan_description,
      p.price_cents, p.duration_days, p.domain_limit, p.traffic_limit_bytes, p.port_limit, p.enabled AS plan_enabled,
      p.purchase_mode, p.max_purchase_qty, p.renewal_mode, p.renewal_window_days
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.status IN ('active', 'suspended') AND s.starts_at <= ?
        AND (s.ends_at > ? OR (s.grace_ends_at IS NOT NULL AND s.grace_ends_at > ?))
      ORDER BY s.id DESC`).all(userId, now, now, now);
  }

  async activeSubscription(userId, subscriptionId = null) {
    const subscriptions = await this.activeSubscriptions(userId);
    return subscriptionId === null || subscriptionId === undefined
      ? (subscriptions[0] || null)
      : (subscriptions.find(item => item.id === Number(subscriptionId)) || null);
  }

  async resolveSubscription(userId, subscriptionId = null, { requireExplicit = false } = {}) {
    const subscriptions = await this.activeSubscriptions(userId);
    if (subscriptionId !== null && subscriptionId !== undefined && subscriptionId !== '') {
      const selected = subscriptions.find(item => item.id === Number(subscriptionId));
      if (!selected) throw Object.assign(new Error('用户套餐不存在或未生效'), { status: 404 });
      return selected;
    }
    if (!subscriptions.length) throw Object.assign(new Error('套餐已到期或未分配'), { status: 409 });
    if (requireExplicit && subscriptions.length > 1) throw Object.assign(new Error('请选择资源所属套餐'), { status: 409 });
    return subscriptions[0];
  }

  async updateLegacySiteLimit(userId) {
    const subscriptions = await this.activeSubscriptions(userId);
    const limit = subscriptions.some(item => item.domain_limit === null) ? 1000000 : subscriptions.reduce((sum, item) => sum + Number(item.domain_limit || 0), 0);
    await this.db.prepare('UPDATE users SET site_limit = ? WHERE id = ?').run(limit, userId);
  }

  async entitlement(userId, subscriptionId = null) {
    const subscription = await this.activeSubscription(userId, subscriptionId);
    if (!subscription) return { subscription: null, domainLimit: 0, trafficLimitBytes: 0, portLimit: 0 };
    const increments = await this.db.prepare(`SELECT COALESCE(SUM(u.domain_increment * su.amount), 0) AS domains,
      COALESCE(SUM(u.traffic_increment_bytes * su.amount), 0) AS traffic,
      COALESCE(SUM(u.port_increment * su.amount), 0) AS ports
      FROM subscription_upgrades su JOIN plan_upgrades u ON u.id = su.upgrade_id
      WHERE su.subscription_id = ?`).get(subscription.id);
    const trafficPacks = (await this.db.prepare(`SELECT COALESCE(SUM(traffic_bytes), 0) AS traffic FROM user_traffic_packages
      WHERE user_id = ? AND subscription_id = ? AND enabled = 1 AND starts_at <= ? AND ends_at > ?`)
      .get(userId, subscription.id, new Date().toISOString(), new Date().toISOString())).traffic;
    const add = (base, extra) => base === null ? null : Number(base) + Number(extra || 0);
    return {
      subscription,
      domainLimit: add(subscription.domain_limit, increments.domains),
      trafficLimitBytes: add(subscription.traffic_limit_bytes, Number(increments.traffic) + Number(trafficPacks)),
      portLimit: add(subscription.port_limit, increments.ports),
    };
  }

  async usage(userId, subscriptionId = null) {
    const primaryId = (await this.activeSubscription(userId))?.id;
    const includeUnassigned = subscriptionId !== null && subscriptionId !== undefined && Number(subscriptionId) === Number(primaryId);
    const filter = subscriptionId === null || subscriptionId === undefined ? 's.owner_id = ?' : `s.owner_id = ? AND (s.subscription_id = ?${includeUnassigned ? ' OR s.subscription_id IS NULL' : ''})`;
    const params = subscriptionId === null || subscriptionId === undefined ? [userId] : [userId, Number(subscriptionId)];
    const domains = (await this.db.prepare(`SELECT s.domain FROM sites s WHERE ${filter}`).all(...params)).reduce((sum, row) => sum + domainCount(row.domain), 0);
    const sitePorts = (await this.db.prepare(`SELECT COUNT(*) AS count FROM site_custom_ports p JOIN sites s ON s.id = p.site_id WHERE ${filter}`).get(...params)).count;
    const resourceFilter = subscriptionId === null || subscriptionId === undefined ? 'r.owner_id = ?' : `r.owner_id = ? AND (r.subscription_id = ?${includeUnassigned ? ' OR r.subscription_id IS NULL' : ''})`;
    const streamPorts = (await this.db.prepare(`SELECT COUNT(*) AS count FROM stream_ports p JOIN tenant_resources r ON r.id = p.resource_id
      WHERE ${resourceFilter} AND r.kind = 'streams'`).get(...params)).count;
    const traffic = subscriptionId === null || subscriptionId === undefined
      ? ((await this.db.prepare('SELECT traffic_bytes FROM monthly_usage WHERE user_id = ? AND period = ?').get(userId, periodKey()))?.traffic_bytes || 0)
      : ((await this.db.prepare('SELECT traffic_bytes FROM subscription_monthly_usage WHERE subscription_id = ? AND period = ?').get(Number(subscriptionId), periodKey()))?.traffic_bytes
        ?? (includeUnassigned ? (await this.db.prepare('SELECT traffic_bytes FROM monthly_usage WHERE user_id = ? AND period = ?').get(userId, periodKey()))?.traffic_bytes : 0) ?? 0);
    return { domains: Number(domains), trafficBytes: Number(traffic), ports: Number(sitePorts) + Number(streamPorts) };
  }

  async snapshot(userId) {
    const subscriptions = await Promise.all((await this.activeSubscriptions(userId)).map(subscription => this.subscriptionSnapshot(userId, subscription.id)));
    const primary = subscriptions[0] || null; const usage = await this.usage(userId);
    const sumLimit = key => subscriptions.some(item => item.limits[key] === null) ? null : subscriptions.reduce((sum, item) => sum + Number(item.limits[key] || 0), 0);
    return {
      plan: primary?.plan || null,
      subscription: primary?.subscription || null,
      subscriptions,
      limits: { domains: sumLimit('domains'), trafficBytes: sumLimit('trafficBytes'), ports: sumLimit('ports') },
      usage,
      overLimit: subscriptions.some(item => item.overLimit) || subscriptions.length === 0,
      reasons: subscriptions.length ? subscriptions.flatMap(item => item.reasons.map(reason => `${item.plan.name}：${reason}`)) : ['套餐已到期或未分配'],
    };
  }

  async subscriptionSnapshot(userId, subscriptionId) {
    const entitlement = await this.entitlement(userId, subscriptionId); const usage = await this.usage(userId, subscriptionId); const reasons = this.reasons(entitlement, usage);
    const subscription = entitlement.subscription;
    if (!subscription) return null;
    const resources = await this.subscriptionResourceCounts(userId, subscription.id);
    return {
      plan: { ...planPublic(subscription), id: subscription.plan_id, name: subscription.plan_name },
      subscription: { id: subscription.id, status: subscription.status, startsAt: subscription.starts_at, endsAt: subscription.ends_at,
        autoRenew: Boolean(subscription.auto_renew), graceEndsAt: subscription.grace_ends_at, renewalFailedAt: subscription.renewal_failed_at },
      limits: { domains: entitlement.domainLimit, trafficBytes: entitlement.trafficLimitBytes, ports: entitlement.portLimit },
      usage, resources, overLimit: reasons.length > 0, reasons,
    };
  }

  async subscriptionResourceCounts(userId, subscriptionId) {
    const includeUnassigned = Number((await this.activeSubscription(userId))?.id) === Number(subscriptionId);
    const sites = (await this.db.prepare(`SELECT COUNT(*) AS count FROM sites WHERE owner_id = ? AND (subscription_id = ?${includeUnassigned ? ' OR subscription_id IS NULL' : ''})`).get(userId, subscriptionId)).count;
    const streams = (await this.db.prepare(`SELECT COUNT(*) AS count FROM tenant_resources WHERE owner_id = ? AND (subscription_id = ?${includeUnassigned ? ' OR subscription_id IS NULL' : ''}) AND kind = 'streams'`).get(userId, subscriptionId)).count;
    return { sites: Number(sites), streams: Number(streams) };
  }

  reasons(entitlement, usage) {
    if (!entitlement.subscription) return ['套餐已到期或未分配'];
    const reasons = [];
    if (entitlement.domainLimit !== null && usage.domains > entitlement.domainLimit) reasons.push('加速域名数超额');
    if (entitlement.trafficLimitBytes !== null && usage.trafficBytes > entitlement.trafficLimitBytes) reasons.push('月流量超额');
    if (entitlement.portLimit !== null && usage.ports > entitlement.portLimit) reasons.push('HTTP / 转发端口超额');
    return reasons;
  }

  async assertProjected(userId, { domains = 0, ports = 0 } = {}, subscriptionId = null) {
    const selected = await this.resolveSubscription(userId, subscriptionId);
    const entitlement = await this.entitlement(userId, selected.id); const usage = await this.usage(userId, selected.id);
    if (!entitlement.subscription) throw Object.assign(new Error('套餐已到期或未分配'), { status: 409 });
    if (entitlement.domainLimit !== null && usage.domains + domains > entitlement.domainLimit) throw Object.assign(new Error('加速域名额度不足'), { status: 409 });
    if (entitlement.portLimit !== null && usage.ports + ports > entitlement.portLimit) throw Object.assign(new Error('HTTP / 转发端口额度不足'), { status: 409 });
    if (entitlement.trafficLimitBytes !== null && usage.trafficBytes > entitlement.trafficLimitBytes) throw Object.assign(new Error('当月流量已超额'), { status: 409 });
    return selected;
  }

  async syncSitePorts(siteId, config) {
    if (!Object.hasOwn(config || {}, 'http_listen') && !Object.hasOwn(config || {}, 'https_listen')) return;
    const ports = [];
    const add = (listen, standard) => {
      if (!listen || Number(listen.enable ?? listen.ok ?? 1) === 0) return;
      for (const port of String(listen.port ?? '').split(/[\s,]+/).map(Number)) if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== standard) ports.push(port);
    };
    add(config?.http_listen, 80); add(config?.https_listen, 443);
    await this.db.prepare('DELETE FROM site_custom_ports WHERE site_id = ?').run(siteId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO site_custom_ports (site_id, port) VALUES (?, ?)');
    for (const port of new Set(ports)) await insert.run(siteId, port);
  }

  async syncTraffic(userId) {
    const { start, end } = monthRange();
    let userTotal = 0;
    for (const subscription of await this.activeSubscriptions(userId)) {
      const cdnfly = this.upstreams ? await this.upstreams.clientForSubscription(subscription) : this.cdnfly;
      const sites = (await this.db.prepare('SELECT upstream_id FROM sites WHERE owner_id = ? AND subscription_id = ? AND upstream_id IS NOT NULL').all(userId, subscription.id)).map(row => row.upstream_id);
      const streams = (await this.db.prepare(`SELECT upstream_id FROM tenant_resources WHERE owner_id = ? AND subscription_id = ? AND kind = 'streams'`).all(userId, subscription.id)).map(row => row.upstream_id);
      let total = 0;
      for (const [cate, resources] of [['site', sites], ['stream', streams]]) {
        if (!resources.length) continue;
        const query = new URLSearchParams({ type: 'traffic', cate, res: resources.join(' '), start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
        const data = await cdnfly.request('GET', `/v1/monitor/usage?${query}`);
        const rows = usageRows(data, resources);
        total += rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
      }
      await this.db.prepare(`INSERT INTO subscription_monthly_usage (subscription_id, period, traffic_bytes, synced_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(subscription_id, period) DO UPDATE SET traffic_bytes = excluded.traffic_bytes, synced_at = CURRENT_TIMESTAMP`)
        .run(subscription.id, periodKey(), Math.max(0, Math.round(total)));
      userTotal += total;
    }
    await this.db.prepare(`INSERT INTO monthly_usage (user_id, period, traffic_bytes, synced_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, period) DO UPDATE SET traffic_bytes = excluded.traffic_bytes, synced_at = CURRENT_TIMESTAMP`)
      .run(userId, periodKey(), Math.max(0, Math.round(userTotal)));
    return userTotal;
  }

  async enforceUser(userId, { syncTraffic = false } = {}) {
    let syncError = null;
    if (syncTraffic) {
      try { await this.syncTraffic(userId); } catch (error) {
        syncError = error.message;
      }
    }
    for (const subscription of await this.activeSubscriptions(userId)) {
      const entitlement = await this.entitlement(userId, subscription.id); const usage = await this.usage(userId, subscription.id); const reasons = this.reasons(entitlement, usage);
      if (reasons.length) await this.suspend(userId, reasons.join('；'), subscription.id);
      else await this.restore(userId, subscription.id);
      await this.db.prepare(`UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(reasons.length ? 'suspended' : 'active', subscription.id);
    }
    await this.updateLegacySiteLimit(userId);
    const current = await this.snapshot(userId);
    return { ...current, ...(syncError ? { syncError } : {}) };
  }

  async suspend(userId, reason, subscriptionId = null) {
    const includeUnassigned = subscriptionId !== null && Number((await this.activeSubscription(userId))?.id) === Number(subscriptionId);
    const siteSql = subscriptionId === null ? 'SELECT * FROM sites WHERE owner_id = ? AND enabled = 1' : `SELECT * FROM sites WHERE owner_id = ? AND (subscription_id = ?${includeUnassigned ? ' OR subscription_id IS NULL' : ''}) AND enabled = 1`;
    const sites = await this.db.prepare(siteSql).all(...(subscriptionId === null ? [userId] : [userId, subscriptionId]));
    for (const site of sites) {
      try {
        const cdnfly = this.upstreams ? await this.upstreams.clientForSite(site) : this.cdnfly;
        const groups = await ensureCustomerUpstreamGroups(this.db, cdnfly, userId);
        await cdnfly.updateSite(site.upstream_id, { enabled: false,
          ...(groups?.site ? { groups: String(groups.site.upstream_group_id) } : {}) });
        await this.db.prepare('UPDATE sites SET enabled = 0, state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('quota_suspended', site.id);
        await this.db.prepare(`INSERT OR IGNORE INTO quota_suspensions (user_id, subscription_id, resource_kind, resource_id, reason) VALUES (?, ?, 'site', ?, ?)`).run(userId, subscriptionId, site.id, reason);
      } catch (error) { console.error(`暂停网站 ${site.id} 失败: ${error.message}`); }
    }
    const streamSql = subscriptionId === null
      ? "SELECT * FROM tenant_resources WHERE owner_id = ? AND kind = 'streams' AND COALESCE(enabled, 1) = 1"
      : `SELECT * FROM tenant_resources WHERE owner_id = ? AND (subscription_id = ?${includeUnassigned ? ' OR subscription_id IS NULL' : ''}) AND kind = 'streams' AND COALESCE(enabled, 1) = 1`;
    const streams = await this.db.prepare(streamSql).all(...(subscriptionId === null ? [userId] : [userId, subscriptionId]));
    for (const stream of streams) {
      try {
        const cdnfly = this.upstreams ? await this.upstreams.clientForResource(stream) : this.cdnfly;
        const groups = await ensureCustomerUpstreamGroups(this.db, cdnfly, userId);
        await cdnfly.request('PUT', `/v1/streams/${stream.upstream_id}`, { enable: 0,
          ...(groups?.stream ? { groups: String(groups.stream.upstream_group_id) } : {}) });
        await this.db.prepare('UPDATE tenant_resources SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stream.id);
        await this.db.prepare(`INSERT OR IGNORE INTO quota_suspensions (user_id, subscription_id, resource_kind, resource_id, reason) VALUES (?, ?, 'stream', ?, ?)`).run(userId, subscriptionId, stream.id, reason);
      } catch (error) { console.error(`暂停四层转发 ${stream.id} 失败: ${error.message}`); }
    }
  }

  async restore(userId, subscriptionId = null) {
    const rows = subscriptionId === null
      ? await this.db.prepare('SELECT * FROM quota_suspensions WHERE user_id = ? AND restored_at IS NULL ORDER BY id').all(userId)
      : await this.db.prepare('SELECT * FROM quota_suspensions WHERE user_id = ? AND subscription_id = ? AND restored_at IS NULL ORDER BY id').all(userId, subscriptionId);
    for (const row of rows) {
      try {
        if (row.resource_kind === 'site') {
          const site = await this.db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(row.resource_id, userId);
          if (site) {
            const cdnfly = this.upstreams ? await this.upstreams.clientForSite(site) : this.cdnfly;
            const groups = await ensureCustomerUpstreamGroups(this.db, cdnfly, userId);
            await cdnfly.updateSite(site.upstream_id, { enabled: true,
              ...(groups?.site ? { groups: String(groups.site.upstream_group_id) } : {}) });
            await this.db.prepare("UPDATE sites SET enabled = 1, state = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(site.id);
          }
        } else {
          const stream = await this.db.prepare("SELECT * FROM tenant_resources WHERE id = ? AND owner_id = ? AND kind = 'streams'").get(row.resource_id, userId);
          if (stream) {
            const cdnfly = this.upstreams ? await this.upstreams.clientForResource(stream) : this.cdnfly;
            const groups = await ensureCustomerUpstreamGroups(this.db, cdnfly, userId);
            await cdnfly.request('PUT', `/v1/streams/${stream.upstream_id}`, { enable: 1,
              ...(groups?.stream ? { groups: String(groups.stream.upstream_group_id) } : {}) });
            await this.db.prepare('UPDATE tenant_resources SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stream.id);
          }
        }
        await this.db.prepare('UPDATE quota_suspensions SET restored_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      } catch (error) {
        console.error(`恢复配额暂停资源 ${row.resource_kind}#${row.resource_id} 失败: ${error.message}`);
      }
    }
  }

  async enforceAll({ syncTraffic = true } = {}) {
    const users = await this.db.prepare("SELECT id FROM users WHERE role = 'user' AND status = 'active'").all();
    const results = [];
    for (const user of users) {
      try { results.push({ userId: user.id, snapshot: await this.enforceUser(user.id, { syncTraffic }) }); }
      catch (error) { results.push({ userId: user.id, error: error.message }); }
    }
    return results;
  }

  async renewSubscription(subscriptionId, { automatic = false } = {}) {
    let result;
    const now = new Date();
    await this.db.transaction(async transaction => {
      const subscription = await transaction.prepare(`SELECT s.*, p.name AS plan_name, p.price_cents, p.duration_days,
        p.domain_limit, p.traffic_limit_bytes, p.port_limit, p.enabled AS plan_enabled,
        p.renewal_mode, p.renewal_window_days
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=? FOR UPDATE`).get(Number(subscriptionId));
      if (!subscription || ['cancelled', 'pending'].includes(subscription.status)) throw Object.assign(new Error('客户套餐不存在或不能续费'), { status: 404 });
      if (!Number(subscription.plan_enabled)) throw Object.assign(new Error('套餐已停止续费'), { status: 409 });
      assertRenewalAllowed(subscription, subscription, now);
      if (automatic && new Date(subscription.ends_at) > now && !subscription.grace_ends_at) {
        const latest = await transaction.prepare("SELECT id FROM orders WHERE subscription_id=? AND type='renewal' AND status='paid' ORDER BY id DESC LIMIT 1").get(subscription.id);
        result = { renewed: true, idempotent: true, orderId: latest?.id || null, subscriptionId: subscription.id,
          userId: subscription.user_id, planName: subscription.plan_name, amountCents: Number(subscription.price_cents), endsAt: subscription.ends_at };
        return;
      }
      const idempotencyKey = automatic ? `auto-renew:${subscription.id}:${new Date(subscription.ends_at).toISOString()}` : `manual-renew:${crypto.randomUUID()}`;
      const existing = await transaction.prepare('SELECT * FROM orders WHERE idempotency_key=?').get(idempotencyKey);
      if (existing) { result = { renewed: existing.status === 'paid', idempotent: true, orderId: existing.id, subscriptionId: subscription.id,
        userId: subscription.user_id, planName: subscription.plan_name, amountCents: Number(subscription.price_cents), endsAt: subscription.ends_at }; return; }
      const wallet = await transaction.prepare('SELECT * FROM wallets WHERE user_id=? FOR UPDATE').get(subscription.user_id);
      if (!wallet || Number(wallet.balance_cents) < Number(subscription.price_cents)) {
        if (!automatic) throw Object.assign(new Error('账户余额不足'), { status: 409 });
        const graceEnds = subscription.grace_ends_at || addDays(new Date(subscription.ends_at), this.renewalGraceDays).toISOString();
        await transaction.prepare('UPDATE subscriptions SET renewal_failed_at=CURRENT_TIMESTAMP, grace_ends_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(graceEnds, subscription.id);
        result = { renewed: false, reason: 'insufficient_balance', subscriptionId: subscription.id, userId: subscription.user_id, graceEndsAt: graceEnds, planName: subscription.plan_name, amountCents: Number(subscription.price_cents) };
        return;
      }
      const base = new Date(subscription.ends_at) > now ? new Date(subscription.ends_at) : now;
      const endsAt = addDays(base, Number(subscription.duration_days)).toISOString();
      const snapshot = { name: subscription.plan_name, priceCents: Number(subscription.price_cents), durationDays: Number(subscription.duration_days),
        domainLimit: subscription.domain_limit, trafficLimitBytes: subscription.traffic_limit_bytes, portLimit: subscription.port_limit };
      const orderId = Number((await transaction.prepare(`INSERT INTO orders
        (user_id, type, product_id, subscription_id, amount_cents, status, channel, metadata, product_name, product_snapshot, idempotency_key, paid_at)
        VALUES (?, 'renewal', ?, ?, ?, 'paid', 'balance', ?, ?, ?, ?, ?)`)
        .run(subscription.user_id, subscription.plan_id, subscription.id, subscription.price_cents, JSON.stringify({ durationDays: subscription.duration_days, previousEndsAt: subscription.ends_at, endsAt }), subscription.plan_name, JSON.stringify(snapshot), idempotencyKey, now.toISOString())).lastInsertRowid);
      const changed = await changeBalance(transaction, subscription.user_id, -Number(subscription.price_cents), {
        referenceType: 'order', referenceId: String(orderId), description: `套餐续费订单 #${orderId}`,
      });
      await transaction.prepare(`UPDATE subscriptions SET status='active', ends_at=?, grace_ends_at=NULL, renewal_failed_at=NULL,
        last_renewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(endsAt, subscription.id);
      result = { renewed: true, orderId, subscriptionId: subscription.id, userId: subscription.user_id, planName: subscription.plan_name,
        amountCents: Number(subscription.price_cents), balanceCents: changed.balanceCents, endsAt };
    });
    if (result.renewed && !result.idempotent) {
      await this.updateLegacySiteLimit(result.userId);
      await this.enforceUser(result.userId, { syncTraffic: false });
    }
    return result;
  }

  async processLifecycle() {
    const now = new Date();
    if (this.settingsProvider) this.renewalGraceDays = Number((await this.settingsProvider()).renewalGraceDays ?? this.renewalGraceDays);
    const subscriptions = await this.db.prepare(`SELECT s.*, p.name AS plan_name, p.price_cents, p.enabled AS plan_enabled,
      p.renewal_mode, p.renewal_window_days
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.user_id
      WHERE s.status IN ('active','suspended') AND u.status='active' ORDER BY s.id`).all();
    const results = [];
    for (const subscription of subscriptions) {
      const endsAt = new Date(subscription.ends_at);
      if (endsAt > now) continue;
      if (subscription.auto_renew && subscription.plan_enabled && renewalMode(subscription) !== 'off') {
        const renewed = await this.renewSubscription(subscription.id, { automatic: true });
        results.push(renewed);
        if (renewed.renewed) continue;
        if (new Date(renewed.graceEndsAt) > now) continue;
      }
      const effectiveEnd = subscription.grace_ends_at ? new Date(subscription.grace_ends_at) : endsAt;
      if (effectiveEnd <= now) {
        await this.db.prepare("UPDATE subscriptions SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(subscription.id);
        results.push({ renewed: false, expired: true, subscriptionId: subscription.id });
      }
    }
    return results;
  }

  async runScheduled({ syncTraffic = true } = {}) {
    const started = Date.now();
    this.scheduler.runningSince = new Date(started).toISOString();
    try {
      const result = await this.db.withAdvisoryLock('cdnfly:billing-lifecycle', async () => {
        const lifecycle = await this.processLifecycle();
        const enforcement = await this.enforceAll({ syncTraffic });
        return { lifecycle, enforcement };
      });
      this.scheduler.lastRunOk = true;
      this.scheduler.lastRunAt = new Date().toISOString();
      this.scheduler.lastRunError = null;
      this.scheduler.durationMs = Date.now() - started;
      return result;
    } catch (error) {
      this.scheduler.lastRunOk = false;
      this.scheduler.lastRunAt = new Date().toISOString();
      this.scheduler.lastRunError = String(error.message || error).slice(0, 500);
      this.scheduler.durationMs = Date.now() - started;
      throw error;
    } finally {
      this.scheduler.runningSince = null;
    }
  }

  schedulerHealth(now = Date.now()) {
    if (!this.scheduler.startedAt) return { ok: false, error: '计费任务未启动', ...this.scheduler };
    if (this.scheduler.runningSince) {
      const runningFor = now - new Date(this.scheduler.runningSince).getTime();
      const timeout = Math.max(Number(this.scheduler.intervalMs || 0) * 2, 15 * 60_000);
      if (runningFor > timeout) return { ok: false, error: '计费任务执行超时', ...this.scheduler };
    }
    if (!this.scheduler.lastRunAt) return { ok: false, pending: true, error: '计费任务尚未完成首次运行', ...this.scheduler };
    if (this.scheduler.lastRunOk !== true) return { ok: false, error: this.scheduler.lastRunError || '计费任务最近一次运行失败', ...this.scheduler };
    const maxAge = Math.max(Number(this.scheduler.intervalMs || 0) * 2 + 60_000, 15 * 60_000);
    if (now - new Date(this.scheduler.lastRunAt).getTime() > maxAge) return { ok: false, error: '计费任务长时间未运行', ...this.scheduler };
    return { ok: true, error: null, ...this.scheduler };
  }

  startScheduler(intervalMs = 5 * 60_000) {
    this.scheduler.startedAt = new Date().toISOString();
    this.scheduler.intervalMs = intervalMs;
    const initial = setTimeout(() => this.runScheduled({ syncTraffic: false }).catch(console.error), 0);
    initial.unref();
    const timer = setInterval(() => this.runScheduled({ syncTraffic: true }).catch(console.error), intervalMs);
    timer.unref();
    return timer;
  }
}

export const billingInternals = { DEFAULT_PLANS, periodKey, monthRange, domainCount, planPublic, purchaseMode, maxPurchaseQty, renewalMode, renewalWindowDays, assertRenewalAllowed, stackBaseDate, livePlanSubscription, addDays };
