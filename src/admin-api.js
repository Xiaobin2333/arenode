import { hashPassword, validateUsername, verifyPassword } from './security.js';
import { publicUser } from './db.js';
import { validateSiteInput } from './validation.js';
import { pagination, paged, searchLike } from './http-utils.js';
import { syncSiteCnames, tenantProxyInternals } from './tenant-proxy.js';
import { ensureCustomerUpstreamGroups } from './customer-groups.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

function presentAdminSite(row) {
  return {
    id: row.id, ownerId: row.owner_id, username: row.username, domain: row.domain, origin: row.origin,
    subscriptionId: row.subscription_id, planName: row.plan_name || null,
    groupId: row.local_group_id === null || row.local_group_id === undefined ? null : Number(row.local_group_id),
    enabled: Boolean(row.enabled), backendProtocol: row.backend_protocol, backendHost: row.backend_host,
    websocket: Boolean(row.websocket), gzip: Boolean(row.gzip), state: row.state, cname: row.cname,
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function streamSnapshot(row) {
  if (!row?.snapshot) return {};
  if (typeof row.snapshot === 'object') return row.snapshot;
  try { return JSON.parse(row.snapshot); } catch { return {}; }
}

function presentAdminStream(row, snapshot = streamSnapshot(row)) {
  const listen = Array.isArray(snapshot.listen) ? snapshot.listen : [];
  const backend = Array.isArray(snapshot.backend) ? snapshot.backend : [];
  const hasSnapshot = Object.keys(snapshot || {}).some(key => !['sync_warning', 'sync_unavailable'].includes(key));
  const cname = tenantProxyInternals.extractCompleteCname(snapshot, '') || snapshot.cname || null;
  const enabled = snapshot.enable ?? snapshot.enabled ?? row.enabled ?? false;
  return {
    id: Number(row.id), ownerId: Number(row.owner_id), username: row.username,
    upstreamId: String(row.upstream_id), subscriptionId: row.subscription_id ? Number(row.subscription_id) : null,
    groupId: row.local_group_id === null || row.local_group_id === undefined ? null : Number(row.local_group_id),
    planName: row.plan_name || null, enabled: ![0, false, '0', 'false', 'off', 'disabled'].includes(enabled),
    name: snapshot.name || snapshot.des || `转发 #${row.id}`,
    ports: listen.map(item => Number(item.port)).filter(Number.isInteger),
    listen, backend, backendPort: snapshot.backend_port ?? null, balanceWay: snapshot.balance_way || 'rr',
    cname,
    syncState: snapshot.sync_state || snapshot.stream_state || snapshot.state || null,
    syncWarning: snapshot.sync_warning || (!hasSnapshot ? '上游账号当前不可见该转发，本地没有可用的同步配置' : null),
    syncUnavailable: Boolean(snapshot.sync_unavailable) || !hasSnapshot,
    description: snapshot.des || snapshot.description || '', createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function createVirtualUser(db, billing, body) {
  const username = validateUsername(body.username);
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const passwordHash = body.passwordHash || hashPassword(body.password || '');
  try {
    const id = Number((await db.prepare(`INSERT INTO users (username, email, email_verified_at, password_hash, role, site_limit, terms_accepted_at, privacy_accepted_at)
      VALUES (?, ?, ?, ?, 'user', 0, ?, ?)`)
      .run(username, email, body.emailVerified && email ? new Date().toISOString() : null, passwordHash,
        body.termsAcceptedAt || null, body.privacyAcceptedAt || null)).lastInsertRowid);
    await db.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING').run(id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  } catch (error) {
    if (error.code === '23505' || error.errcode === 2067 || /unique|duplicate/i.test(error.message || '')) throw httpError('用户名或邮箱已存在', 409);
    throw error;
  }
}

export async function handleAdminApi({ req, url, user, db, cdnfly, upstreams = null, billing, readBody }) {
  if (url.pathname === '/api/account/password' && req.method === 'PUT') {
    const body = await readBody(req);
    if (!verifyPassword(body.currentPassword || '', user.password_hash)) throw httpError('当前密码错误', 403);
    if (verifyPassword(body.newPassword || '', user.password_hash)) throw httpError('新密码不能与当前密码相同');
    await db.prepare('UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(body.newPassword || ''), user.id);
    await db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    return { status: 200, data: { ok: true, relogin: true }, action: 'account.password.change', resourceId: user.id };
  }

  if (user.role !== 'admin' || !url.pathname.startsWith('/api/admin/')) return null;

  if (url.pathname === '/api/admin/overview' && req.method === 'GET') {
    const now = new Date().toISOString();
    const [customers, sites, subscriptions, orders, balances, rechargeCodes, plans, overLimit] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active
        FROM users WHERE role='user'`).get(),
      db.prepare('SELECT COUNT(*) AS total FROM sites').get(),
      db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active
        FROM subscriptions`).get(),
      db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS paid,
        COALESCE(SUM(CASE WHEN status='paid' AND channel='balance_refund' THEN -amount_cents
          WHEN status='paid' THEN amount_cents ELSE 0 END),0) AS paid_amount FROM orders`).get(),
      db.prepare('SELECT COALESCE(SUM(balance_cents),0) AS total FROM wallets').get(),
      db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='active' AND used_count<max_uses
        AND (starts_at IS NULL OR starts_at<=?) AND (expires_at IS NULL OR expires_at>?)
        THEN 1 ELSE 0 END),0) AS available FROM recharge_codes`).get(now, now),
      db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END),0) AS enabled FROM plans').get(),
      db.prepare('SELECT COUNT(DISTINCT user_id) AS total FROM quota_suspensions WHERE restored_at IS NULL').get(),
    ]);
    return { status: 200, data: { overview: {
      customers: { total: Number(customers.total), active: Number(customers.active) },
      sites: Number(sites.total), subscriptions: { total: Number(subscriptions.total), active: Number(subscriptions.active) },
      orders: { total: Number(orders.total), paid: Number(orders.paid), paidAmountCents: Number(orders.paid_amount) },
      walletLiabilityCents: Number(balances.total), availableRechargeCodes: Number(rechargeCodes.available),
      plans: { total: Number(plans.total), enabled: Number(plans.enabled) }, overLimitCustomers: Number(overLimit.total),
    } } };
  }

  if (url.pathname === '/api/admin/customers' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url); const clauses = ["u.role='user'"]; const params = [];
    const q = url.searchParams.get('q'); const status = url.searchParams.get('status');
    if (q) { clauses.push('(u.username LIKE ? OR u.email LIKE ?)'); const like = searchLike(q); params.push(like, like); }
    if (status) { clauses.push('u.status=?'); params.push(status); }
    const where = clauses.join(' AND ');
    const total = (await db.prepare(`SELECT COUNT(*) AS count FROM users u WHERE ${where}`).get(...params)).count;
    const rows = await db.prepare(`SELECT u.*, COALESCE(w.balance_cents,0) AS balance_cents
      FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    const customers = await Promise.all(rows.map(async row => {
      const sites = await db.prepare('SELECT COUNT(*) AS count FROM sites WHERE owner_id=?').get(row.id);
      const orders = await db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(row.id);
      return { ...publicUser(row), balanceCents: Number(row.balance_cents || 0), siteCount: Number(sites.count), orderCount: Number(orders.count), billing: billing ? await billing.snapshot(row.id) : null };
    }));
    return { status: 200, data: paged(customers, total, page, pageSize, 'customers') };
  }
  if (url.pathname === '/api/admin/customers' && req.method === 'POST') {
    const body = await readBody(req);
    const customer = await createVirtualUser(db, billing, { ...body, emailVerified: Boolean(body.email) });
    return { status: 201, data: { customer: publicUser(customer) }, action: 'customer.create', resourceId: customer.id };
  }

  const passwordMatch = url.pathname.match(/^\/api\/admin\/customers\/(\d+)\/password$/);
  if (passwordMatch && req.method === 'PUT') {
    const customer = await db.prepare("SELECT * FROM users WHERE id=? AND role='user'").get(Number(passwordMatch[1]));
    if (!customer) throw httpError('客户不存在', 404);
    const password = (await readBody(req)).password;
    await db.prepare('UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(password || ''), customer.id);
    await db.prepare('DELETE FROM sessions WHERE user_id=?').run(customer.id);
    return { status: 200, data: { ok: true }, action: 'customer.password.reset', resourceId: customer.id };
  }

  const customerMatch = url.pathname.match(/^\/api\/admin\/customers\/(\d+)$/);
  if (customerMatch) {
    const customer = await db.prepare("SELECT * FROM users WHERE id=? AND role='user'").get(Number(customerMatch[1]));
    if (!customer) throw httpError('客户不存在', 404);
    if (req.method === 'GET') {
      const counts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM sites WHERE owner_id=?) AS sites,
        (SELECT COUNT(*) FROM tenant_resources WHERE owner_id=?) AS resources,
        (SELECT COUNT(*) FROM orders WHERE user_id=?) AS orders`).get(customer.id, customer.id, customer.id);
      const [wallet, subscriptions, sites, orders, sessions, recentAudit] = await Promise.all([
        db.prepare('SELECT balance_cents,updated_at FROM wallets WHERE user_id=?').get(customer.id),
        db.prepare(`SELECT s.*,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? ORDER BY s.id DESC LIMIT 20`).all(customer.id),
        db.prepare('SELECT id,domain,state,enabled,created_at FROM sites WHERE owner_id=? ORDER BY id DESC LIMIT 20').all(customer.id),
        db.prepare('SELECT id,type,product_name,amount_cents,status,created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 20').all(customer.id),
        db.prepare('SELECT token_hash,ip,user_agent,last_seen_at,created_at,expires_at FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC').all(customer.id),
        db.prepare('SELECT id,action,resource_type,resource_id,ip,created_at FROM audit_logs WHERE actor_id=? ORDER BY id DESC LIMIT 20').all(customer.id),
      ]);
      return { status: 200, data: { customer: publicUser(customer), counts, wallet: { balanceCents: Number(wallet?.balance_cents || 0), updatedAt: wallet?.updated_at },
        billing: billing ? await billing.snapshot(customer.id) : null, subscriptions, sites, orders,
        sessions: sessions.map(row => ({ ...row, token_hash: undefined, id: row.token_hash.slice(0, 16) })), recentAudit } };
    }
    if (req.method === 'PUT') {
      const body = await readBody(req); const status = body.status ?? customer.status;
      if (!['active', 'disabled'].includes(status)) throw httpError('客户状态无效');
      await db.prepare('UPDATE users SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, customer.id);
      if (status === 'disabled') await db.prepare('DELETE FROM sessions WHERE user_id=?').run(customer.id);
      return { status: 200, data: { customer: publicUser(await db.prepare('SELECT * FROM users WHERE id=?').get(customer.id)) }, action: 'customer.update', resourceId: customer.id };
    }
    if (req.method === 'DELETE') {
      await db.prepare("UPDATE users SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(customer.id);
      await db.prepare('DELETE FROM sessions WHERE user_id=?').run(customer.id);
      return { status: 200, data: { ok: true }, action: 'customer.disable', resourceId: customer.id };
    }
  }

  if (url.pathname === '/api/admin/sites' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url); const userId = Number(url.searchParams.get('userId') || 0); const query = String(url.searchParams.get('q') || '').trim();
    const clauses = []; const params = [];
    if (userId) { clauses.push('s.owner_id=?'); params.push(userId); }
    if (query) { clauses.push('(s.domain LIKE ? OR s.origin LIKE ? OR u.username LIKE ?)'); const like = searchLike(query); params.push(like, like, like); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (await db.prepare(`SELECT COUNT(*) AS count FROM sites s JOIN users u ON u.id=s.owner_id ${where}`).get(...params)).count;
    const rows = await db.prepare(`SELECT s.*, u.username, p.name AS plan_name FROM sites s JOIN users u ON u.id=s.owner_id
      LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id
      ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    await syncSiteCnames(db, rows, upstreams, cdnfly);
    return { status: 200, data: paged(rows.map(presentAdminSite), total, page, pageSize, 'sites') };
  }
  if (url.pathname === '/api/admin/sites' && req.method === 'POST') {
    const body = await readBody(req); const owner = await db.prepare("SELECT * FROM users WHERE id=? AND role='user' AND status='active'").get(Number(body.userId));
    if (!owner) throw httpError('客户不存在或已停用', 404);
    const input = validateSiteInput(body); const subscription = billing ? await billing.resolveSubscription(owner.id, body.subscriptionId, { requireExplicit: true }) : null;
    const localGroupId = body.groupId === undefined || body.groupId === null || body.groupId === '' ? null : Number(body.groupId);
    if (localGroupId !== null && (!Number.isInteger(localGroupId)
      || !await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(localGroupId, owner.id))) throw httpError('网站分组不存在', 404);
    if (billing) await billing.assertProjected(owner.id, { domains: 1 }, subscription.id);
    if (await db.prepare('SELECT id FROM sites WHERE domain=?').get(input.domain)) throw httpError('域名已存在', 409);
    const upstreamClient = upstreams && subscription ? await upstreams.clientForSubscription(subscription) : cdnfly;
    const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, owner.id);
    const pending = await db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_account_id, local_group_id, domain, origin, backend_protocol, backend_host, websocket, gzip, enabled, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'provisioning')`).run(owner.id, subscription?.id || null, subscription?.upstream_id || null, localGroupId, input.domain, input.origin, input.backendProtocol || 'http', input.backendHost || input.domain, Number(Boolean(input.websocket)), Number(Boolean(input.gzip)));
    try {
      const upstream = await upstreamClient.createSite({ ...input,
        ...(customerGroups?.site ? { groups: String(customerGroups.site.upstream_group_id) } : {}) });
      await db.prepare("UPDATE sites SET upstream_id=?, state='active', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(upstream.id, pending.lastInsertRowid);
      const createdRows = await db.prepare('SELECT * FROM sites WHERE id=? AND owner_id=?').all(Number(pending.lastInsertRowid), owner.id);
      await syncSiteCnames(db, createdRows, upstreams, cdnfly);
      return { status: 201, data: { site: presentAdminSite(await db.prepare('SELECT s.*, u.username, p.name AS plan_name FROM sites s JOIN users u ON u.id=s.owner_id LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id WHERE s.id=?').get(pending.lastInsertRowid)) }, action: 'admin.site.create', resourceId: pending.lastInsertRowid };
    } catch (error) { await db.prepare('DELETE FROM sites WHERE id=?').run(pending.lastInsertRowid); throw error; }
  }

  const siteMatch = url.pathname.match(/^\/api\/admin\/sites\/(\d+)$/);
  if (siteMatch) {
    const site = await db.prepare('SELECT s.*, u.username, u.status AS owner_status, p.name AS plan_name FROM sites s JOIN users u ON u.id=s.owner_id LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id WHERE s.id=?').get(Number(siteMatch[1]));
    if (!site) throw httpError('站点不存在', 404);
    if (req.method === 'GET') {
      const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
      const detail = site.upstream_id ? await upstreamClient.getSite(site.upstream_id) : null;
      const upstream = detail && typeof detail === 'object' ? { ...detail, groups: site.local_group_id || '' } : detail;
      const cname = await tenantProxyInternals.resolveCompleteCname(upstreamClient, upstream, site.cname, upstream);
      if (cname !== site.cname) {
        await db.prepare('UPDATE sites SET cname=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(cname || null, site.id);
        site.cname = cname || null;
      }
      return { status: 200, data: { site: { ...presentAdminSite(site), cname: cname || site.cname }, upstream } };
    }
    if (req.method === 'PUT') {
      const body = await readBody(req); const input = validateSiteInput(body, true); delete input.domain;
      if (input.enabled && site.owner_status !== 'active') throw httpError('客户已停用，不能启用站点', 409);
      let subscriptionId = site.subscription_id;
      if (billing && body.subscriptionId !== undefined && Number(body.subscriptionId) !== Number(site.subscription_id)) {
        const target = await billing.resolveSubscription(site.owner_id, body.subscriptionId); await billing.assertProjected(site.owner_id, { domains: 1 }, target.id);
        if (Number(target.upstream_id || 0) !== Number(site.upstream_account_id || 0)) throw httpError('网站不能直接迁移到其他上游，请在目标套餐下重新创建', 409);
        subscriptionId = target.id;
      }
      if (billing && input.enabled) await billing.assertProjected(site.owner_id, {}, subscriptionId);
      const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
      let localGroupId = site.local_group_id;
      if (Object.hasOwn(body, 'groupId')) {
        localGroupId = body.groupId === null || body.groupId === '' ? null : Number(body.groupId);
        if (localGroupId !== null && (!Number.isInteger(localGroupId)
          || !await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(localGroupId, site.owner_id))) throw httpError('网站分组不存在', 404);
      }
      const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, site.owner_id);
      await upstreamClient.updateSite(site.upstream_id, { ...input,
        ...(customerGroups?.site ? { groups: String(customerGroups.site.upstream_group_id) } : {}) });
      const nextEnabled = input.enabled === undefined ? site.enabled : Number(input.enabled);
      const nextState = input.enabled === undefined ? site.state : (input.enabled ? 'active' : 'inactive');
      await db.prepare(`UPDATE sites SET origin=COALESCE(?,origin), backend_protocol=COALESCE(?,backend_protocol), backend_host=COALESCE(?,backend_host),
        websocket=COALESCE(?,websocket), gzip=COALESCE(?,gzip), subscription_id=?, local_group_id=?, enabled=?, state=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(input.origin ?? null, input.backendProtocol ?? null, input.backendHost ?? null, input.websocket === undefined ? null : Number(input.websocket), input.gzip === undefined ? null : Number(input.gzip), subscriptionId, localGroupId, nextEnabled, nextState, site.id);
      if (input.enabled !== undefined) await db.prepare('UPDATE quota_suspensions SET restored_at=CURRENT_TIMESTAMP WHERE user_id=? AND resource_kind=\'site\' AND resource_id=? AND restored_at IS NULL').run(site.owner_id, site.id);
      if (billing) await billing.enforceUser(site.owner_id, { syncTraffic: false });
      return { status: 200, data: { site: presentAdminSite(await db.prepare('SELECT s.*, u.username, p.name AS plan_name FROM sites s JOIN users u ON u.id=s.owner_id LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id WHERE s.id=?').get(site.id)) }, action: 'admin.site.update', resourceId: site.id };
    }
    if (req.method === 'DELETE') {
      if (site.enabled) throw httpError('请先停用站点再删除', 409);
      const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
      await upstreamClient.deleteSite(site.upstream_id); await db.prepare('DELETE FROM sites WHERE id=?').run(site.id);
      if (billing) await billing.enforceUser(site.owner_id, { syncTraffic: false });
      return { status: 200, data: { ok: true }, action: 'admin.site.delete', resourceId: site.id };
    }
  }

  if (url.pathname === '/api/admin/streams' && req.method === 'GET') {
    const { page, pageSize, offset } = pagination(url); const clauses = ["r.kind='streams'"]; const params = [];
    const userId = Number(url.searchParams.get('userId') || 0); const query = String(url.searchParams.get('q') || '').trim();
    if (userId) { clauses.push('r.owner_id=?'); params.push(userId); }
    if (query) { clauses.push('(u.username LIKE ? OR r.upstream_id LIKE ? OR CAST(r.id AS TEXT) LIKE ?)'); const like = searchLike(query); params.push(like, like, like); }
    const where = clauses.join(' AND ');
    const total = (await db.prepare(`SELECT COUNT(*) AS count FROM tenant_resources r JOIN users u ON u.id=r.owner_id WHERE ${where}`).get(...params)).count;
    const rows = await db.prepare(`SELECT r.*,u.username,p.name AS plan_name FROM tenant_resources r JOIN users u ON u.id=r.owner_id
      LEFT JOIN subscriptions s ON s.id=r.subscription_id LEFT JOIN plans p ON p.id=s.plan_id WHERE ${where}
      ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return { status: 200, data: paged(rows.map(row => presentAdminStream(row)), total, page, pageSize, 'streams') };
  }

  if (url.pathname === '/api/admin/streams' && req.method === 'POST') {
    const body = await readBody(req); const owner = await db.prepare("SELECT id FROM users WHERE id=? AND role='user' AND status='active'").get(Number(body.userId));
    if (!owner) throw httpError('客户不存在或已停用', 404);
    const result = await tenantProxyInternals.createResources({ db, cdnfly, upstreams, billing, kind: 'streams', user: { id: owner.id, role: 'user' }, body: { ...body, subscriptionId: body.subscriptionId } });
    return { status: 201, data: { ids: result }, action: 'admin.stream.create', resourceId: result };
  }

  const streamMatch = url.pathname.match(/^\/api\/admin\/streams\/(\d+)$/);
  if (streamMatch) {
    const localId = Number(streamMatch[1]);
    const stream = await db.prepare(`SELECT r.*,u.username,u.status AS owner_status,p.name AS plan_name
      FROM tenant_resources r JOIN users u ON u.id=r.owner_id LEFT JOIN subscriptions s ON s.id=r.subscription_id
      LEFT JOIN plans p ON p.id=s.plan_id WHERE r.id=? AND r.kind='streams'`).get(localId);
    if (!stream) throw httpError('四层转发不存在', 404);
    if (req.method === 'GET') {
      const client = upstreams ? await upstreams.clientForResource(stream) : cdnfly;
      const upstream = await tenantProxyInternals.resourceDetail(client, 'streams', stream.upstream_id, stream);
      if (!upstream.sync_warning) await tenantProxyInternals.saveResource(db, 'streams', stream.upstream_id, stream.owner_id, upstream, false, stream.upstream_account_id);
      await tenantProxyInternals.syncStreamPorts(db, localId, upstream);
      const subscriptions = await db.prepare(`SELECT s.id,p.name,s.upstream_id,s.upstream_package_id FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.user_id=? AND s.status IN ('active','suspended') ORDER BY s.id DESC`).all(stream.owner_id);
      const customerUpstream = tenantProxyInternals.exposeResourceRecord('streams', upstream);
      const exposedUpstream = customerUpstream && typeof customerUpstream === 'object' ? { ...customerUpstream, groups: stream.local_group_id || '' } : customerUpstream;
      return { status: 200, data: { stream: presentAdminStream(stream, exposedUpstream), upstream: exposedUpstream, subscriptions } };
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const input = tenantProxyInternals.sanitizeStreamInput(body, { partial: true });
      if (stream.owner_status !== 'active' && input.enable === 1) throw httpError('客户已停用，不能启用转发', 409);
      let targetSubscription = stream.subscription_id;
      if (billing && body.subscriptionId !== undefined && Number(body.subscriptionId) !== Number(stream.subscription_id)) {
        const target = await billing.resolveSubscription(stream.owner_id, body.subscriptionId);
        if (upstreams && Number(target.upstream_id) !== Number(stream.upstream_account_id)) throw httpError('转发不能直接迁移到其他上游，请重新创建', 409);
        const ports = input.listen?.length || Number((await db.prepare('SELECT COUNT(*) AS count FROM stream_ports WHERE resource_id=?').get(localId)).count);
        await billing.assertProjected(stream.owner_id, { ports }, target.id);
        targetSubscription = target.id;
      }
      const client = upstreams ? await upstreams.clientForResource(stream) : cdnfly;
      const translated = await tenantProxyInternals.translateStreamReferences(db, input, stream.owner_id, false, client.accountId);
      delete translated.id; delete translated.user_package;
      const localGroupId = await tenantProxyInternals.resolveLocalStreamGroup(db, stream.owner_id,
        Object.hasOwn(input, 'groups') ? input.groups : undefined, stream.local_group_id);
      const customerGroups = await ensureCustomerUpstreamGroups(db, client, stream.owner_id);
      if (customerGroups?.stream) translated.groups = String(customerGroups.stream.upstream_group_id);
      const upstreamBody = tenantProxyInternals.ownershipPayload('streams', client, stream.owner_id, translated, streamSnapshot(stream));
      const upstream = await client.request('PUT', `/v1/streams/${stream.upstream_id}`, upstreamBody);
      await tenantProxyInternals.saveResource(db, 'streams', stream.upstream_id, stream.owner_id, { ...streamSnapshot(stream), ...translated, ...upstream, groups: translated.groups }, false, stream.upstream_account_id);
      await tenantProxyInternals.markOwnershipPersisted(db, 'streams', stream.id, client, stream.owner_id);
      await db.prepare('UPDATE tenant_resources SET subscription_id=?,local_group_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(targetSubscription, localGroupId, localId);
      await tenantProxyInternals.syncStreamPorts(db, localId, input);
      if (billing) await billing.enforceUser(stream.owner_id, { syncTraffic: false });
      return { status: 200, data: { stream: presentAdminStream(await db.prepare(`SELECT r.*,u.username,p.name AS plan_name FROM tenant_resources r JOIN users u ON u.id=r.owner_id LEFT JOIN subscriptions s ON s.id=r.subscription_id LEFT JOIN plans p ON p.id=s.plan_id WHERE r.id=?`).get(localId), tenantProxyInternals.exposeResourceRecord('streams', { ...streamSnapshot(stream), ...input, ...upstream })) }, action: 'admin.stream.update', resourceId: localId };
    }
    if (req.method === 'DELETE') {
      tenantProxyInternals.requireStoppedResource(stream, '四层转发');
      const client = upstreams ? await upstreams.clientForResource(stream) : cdnfly;
      await tenantProxyInternals.deleteStreamResource(client, stream.upstream_id);
      await db.prepare('DELETE FROM tenant_resources WHERE id=?').run(localId);
      if (billing) await billing.enforceUser(stream.owner_id, { syncTraffic: false });
      return { status: 200, data: { ok: true }, action: 'admin.stream.delete', resourceId: localId };
    }
  }
  return null;
}
