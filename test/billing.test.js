import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { BillingService } from '../src/billing.js';
import { createApp } from '../src/app.js';
import { tenantProxyInternals } from '../src/tenant-proxy.js';

async function fixture() {
  const db = createDatabase();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, ?, ?)');
  const admin = Number(add.run('admin', hashPassword('admin-password'), 'admin', 0).lastInsertRowid);
  const alice = Number(add.run('alice', hashPassword('alice-password'), 'user', 99).lastInsertRowid);
  const bob = Number(add.run('bob', hashPassword('bobby-password'), 'user', 99).lastInsertRowid);
  const calls = [];
  const cdnfly = {
    packageId: 88, groupNamespace: 'TEST-BILLING',
    calls,
    updateSite: async (id, input) => { calls.push(['site', id, input]); return true; },
    request: async (method, path, body) => { calls.push(['request', method, path, body]); if (path.startsWith('/v1/monitor/usage')) return []; return true; },
    createSite: async () => ({ id: 'new' }), getSite: async () => ({}), deleteSite: async () => true, health: async () => true,
  };
  const billing = await new BillingService(db, cdnfly).initialize();
  const trial = db.prepare("SELECT id FROM plans WHERE code='trial'").get();
  await billing.assignPlan(alice, trial.id); await billing.assignPlan(bob, trial.id);
  await billing.ensureResourceAssignments();
  db.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, ?), (?, ?)').run(alice, 100000, bob, 100000);
  return { db, cdnfly, billing, ids: { admin, alice, bob } };
}

test('默认套餐与图片中的三项资源限制一致', async () => {
  const f = await fixture();
  const plans = f.db.prepare('SELECT code, price_cents, domain_limit, traffic_limit_bytes, port_limit FROM plans ORDER BY sort').all();
  assert.equal(plans.length, 6);
  assert.deepEqual(plans.map(row => row.domain_limit), [1, 3, 8, 15, 30, null]);
  assert.deepEqual(plans.map(row => row.port_limit), [0, 0, 3, 8, 15, null]);
  assert.deepEqual(plans.map(row => row.price_cents), [300, 500, 2800, 4800, 6800, 9800]);
  assert.equal(plans[0].traffic_limit_bytes, 10 * 1024 ** 3);
  assert.equal(plans[5].traffic_limit_bytes, null);
  f.db.close();
});

test('非标准网站端口与四层端口使用同一额度池，80/443 不计入', async () => {
  const f = await fixture();
  f.db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state) VALUES (?, 'site-a', 'a.example.com', '192.0.2.1', 'active')`).run(f.ids.alice);
  await f.billing.syncSitePorts(1, { http_listen: { enable: 1, port: '80 8080' }, https_listen: { ok: 1, port: '443 8443' } });
  const stream = await tenantProxyInternals.saveResource(f.db, 'streams', 'stream-a', f.ids.alice);
  f.db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, ?)').run(stream, 9443);
  assert.equal((await f.billing.usage(f.ids.alice)).ports, 3);
  f.db.close();
});

test('超出端口额度自动暂停网站与四层转发，升级后恢复', async () => {
  const f = await fixture();
  f.db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, enabled, state) VALUES (?, 'site-a', 'a.example.com', '192.0.2.1', 1, 'active')`).run(f.ids.alice);
  const stream = await tenantProxyInternals.saveResource(f.db, 'streams', 'stream-a', f.ids.alice);
  f.db.prepare('UPDATE tenant_resources SET enabled = 1 WHERE id = ?').run(stream);
  f.db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, 8443)').run(stream);
  const suspended = await f.billing.enforceUser(f.ids.alice);
  assert.equal(suspended.overLimit, true);
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id = 1').get().enabled, 0);
  assert.equal(f.db.prepare('SELECT enabled FROM tenant_resources WHERE id = ?').get(stream).enabled, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM quota_suspensions WHERE restored_at IS NULL').get().count, 2);
  const standard = f.db.prepare("SELECT id FROM plans WHERE code = 'standard'").get();
  await f.billing.assignPlan(f.ids.alice, standard.id);
  const restored = await f.billing.enforceUser(f.ids.alice);
  assert.equal(restored.overLimit, false);
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id = 1').get().enabled, 1);
  assert.equal(f.db.prepare('SELECT enabled FROM tenant_resources WHERE id = ?').get(stream).enabled, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM quota_suspensions WHERE restored_at IS NULL').get().count, 0);
  f.db.close();
});

test('月流量超额触发暂停且新增域名会被额度检查拒绝', async () => {
  const f = await fixture();
  f.db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, enabled, state) VALUES (?, 'site-a', 'a.example.com', '192.0.2.1', 1, 'active')`).run(f.ids.alice);
  const period = new Date().toISOString().slice(0, 7);
  f.db.prepare('INSERT INTO monthly_usage (user_id, period, traffic_bytes) VALUES (?, ?, ?)').run(f.ids.alice, period, 11 * 1024 ** 3);
  await f.billing.enforceUser(f.ids.alice);
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id = 1').get().enabled, 0);
  await assert.rejects(f.billing.assertProjected(f.ids.alice, { domains: 1 }), /域名额度不足|流量已超额/);
  f.db.close();
});

async function startApi(f) {
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 88 };
  const server = http.createServer(createApp({ db: f.db, cdnfly: f.cdnfly, config, billing: f.billing }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return response.headers.get('set-cookie').split(';')[0];
}
function request(base, path, cookie, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('用户余额支付套餐后立即生效且管理员确认接口停用', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password'); const userCookie = await login(api.base, 'alice', 'alice-password');
  const created = await request(api.base, '/api/admin/billing/plans', adminCookie, 'POST', { code: 'custom', name: '自定义版', priceCents: 1200, durationDays: 30, domainLimit: 5, trafficLimitBytes: 50 * 1024 ** 3, portLimit: 2, enabled: true });
  assert.equal(created.status, 201);
  const planId = (await created.json()).plan.id;
  const orderResult = await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId });
  assert.equal(orderResult.status, 201);
  const purchased = (await orderResult.json()).data; const orderId = purchased.orderId;
  assert.equal(purchased.status, 'paid');
  assert.equal((await f.billing.activeSubscription(f.ids.alice)).plan_id, planId);
  const paid = await request(api.base, `/api/admin/billing/orders/${orderId}`, adminCookie, 'PUT', { status: 'paid' });
  assert.equal(paid.status, 405);
});

test('套餐交易按客户账号隔离且套餐不能分配给管理员', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password');
  const aliceCookie = await login(api.base, 'alice', 'alice-password');
  const bobCookie = await login(api.base, 'bob', 'bobby-password');
  const trial = f.db.prepare("SELECT id FROM plans WHERE code='trial'").get();
  const orderResponse = await request(api.base, '/api/cdnfly/v1/user-packages', aliceCookie, 'POST', { planId: trial.id });
  const orderData = await orderResponse.json();
  const aliceSubscription = orderData.data.id; const aliceOrder = orderData.data.orderId;
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-packages/${aliceSubscription}`, bobCookie)).status, 404);
  assert.equal((await request(api.base, `/api/cdnfly/v1/orders/${aliceOrder}`, bobCookie)).status, 404);
  assert.equal((await request(api.base, '/api/admin/billing/subscriptions', adminCookie, 'POST', { userId: f.ids.admin, planId: trial.id })).status, 404);
});

test('管理员可完整维护套餐分组、增值项和流量包', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const cookie = await login(api.base, 'admin', 'admin-password');
  const group = await request(api.base, '/api/admin/billing/groups', cookie, 'POST', { name: '企业套餐', sort: 20 });
  const groupId = (await group.json()).id; assert.equal(group.status, 201);
  assert.equal((await request(api.base, `/api/admin/billing/groups/${groupId}`, cookie, 'PUT', { name: '企业客户套餐', enabled: true })).status, 200);
  const upgrade = await request(api.base, '/api/admin/billing/upgrades', cookie, 'POST', { name: '端口扩容', priceCents: 500, portIncrement: 2 });
  const upgradeId = (await upgrade.json()).id; assert.equal((await request(api.base, `/api/admin/billing/upgrades/${upgradeId}`, cookie, 'PUT', { portIncrement: 3 })).status, 200);
  const traffic = await request(api.base, '/api/admin/billing/traffic-packages', cookie, 'POST', { name: '100G 流量包', trafficBytes: 100 * 1024 ** 3, priceCents: 1000, durationDays: 30 });
  const trafficId = (await traffic.json()).id; assert.equal((await request(api.base, `/api/admin/billing/traffic-packages/${trafficId}`, cookie, 'DELETE')).status, 200);
  assert.equal(f.db.prepare('SELECT enabled FROM traffic_packages WHERE id=?').get(trafficId).enabled, 0);
});

test('租户不能免费改动已购增值权益，目录停用不撤销历史权益', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const cookie = await login(api.base, 'alice', 'alice-password');
  const subscription = await f.billing.activeSubscription(f.ids.alice);
  const upgradeId = Number(f.db.prepare(`INSERT INTO plan_upgrades (name, price_cents, port_increment) VALUES ('端口扩容', 500, 2)`).run().lastInsertRowid);
  f.db.prepare('INSERT INTO subscription_upgrades (subscription_id, upgrade_id, amount) VALUES (?, ?, 1)').run(subscription.id, upgradeId);
  f.db.prepare('UPDATE plan_upgrades SET enabled=0 WHERE id=?').run(upgradeId);
  assert.equal((await f.billing.entitlement(f.ids.alice)).portLimit, 2);
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-package/${subscription.id}/upgrades`, cookie, 'PUT', { upgradeId, amount: 99 })).status, 403);
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-package/${subscription.id}/upgrades/${upgradeId}`, cookie, 'DELETE')).status, 403);
  assert.equal((await f.billing.entitlement(f.ids.alice)).portLimit, 2);
});

test('官方计费目录、流量用量和未接入支付接口具有明确契约', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const cookie = await login(api.base, 'alice', 'alice-password');
  const subscription = await f.billing.activeSubscription(f.ids.alice);
  const upgradeId = Number(f.db.prepare("INSERT INTO plan_upgrades (name,price_cents,port_increment) VALUES ('测试增值项',100,1)").run().lastInsertRowid);
  const trafficId = Number(f.db.prepare("INSERT INTO traffic_packages (name,traffic_bytes,price_cents,duration_days) VALUES ('测试流量包',1024,100,30)").run().lastInsertRowid);

  for (const path of ['/package-groups', '/packages', '/package-ups', '/traffic-packages', '/user-packages', '/user-traffic-packages', '/orders', '/order-count']) {
    const response = await request(api.base, `/api/cdnfly/v1${path}`, cookie);
    const responseBody = await response.clone().text();
    assert.equal(response.status, 200, `${path}: ${responseBody}`);
  }
  const groupId = f.db.prepare('SELECT id FROM package_groups ORDER BY id LIMIT 1').get().id;
  const planId = f.db.prepare('SELECT id FROM plans ORDER BY id LIMIT 1').get().id;
  for (const path of [`/package-groups/${groupId}`, `/packages/${planId}`, `/package-ups/${upgradeId}`, `/traffic-packages/${trafficId}`, `/user-packages/${subscription.id}`]) {
    const response = await request(api.base, `/api/cdnfly/v1${path}`, cookie);
    assert.equal(response.status, 200, path);
  }
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-package/${subscription.id}/usage`, cookie)).status, 200);
  const trafficUsage = await request(api.base, '/api/cdnfly/v1/user-traffic-package-usage', cookie);
  assert.equal(trafficUsage.status, 200);
  assert.equal(Array.isArray((await trafficUsage.json()).data), true);

  const walletBefore = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  const orderCountBefore = f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(f.ids.alice).count;
  assert.equal((await request(api.base, '/api/cdnfly/v1/alipay-preorder', cookie, 'POST', { amount: 100 })).status, 501);
  assert.equal((await request(api.base, '/api/cdnfly/v1/wxpay-preorder', cookie, 'POST', { amount: 100 })).status, 501);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, walletBefore);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(f.ids.alice).count, orderCountBefore);
});

test('余额不足时套餐订单与订阅均不落库', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); }); const userCookie = await login(api.base, 'alice', 'alice-password');
  f.db.prepare('UPDATE wallets SET balance_cents=0 WHERE user_id=?').run(f.ids.alice);
  const plan = f.db.prepare("SELECT id FROM plans WHERE code='experience'").get();
  const beforeOrders = f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(f.ids.alice).count;
  const beforeSubscriptions = f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=?').get(f.ids.alice).count;
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: plan.id })).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(f.ids.alice).count, beforeOrders);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=?').get(f.ids.alice).count, beforeSubscriptions);
});

test('自动续费只扣款一次，重复执行返回幂等结果', async () => {
  const f = await fixture();
  const subscription = await f.billing.activeSubscription(f.ids.alice);
  f.db.prepare("UPDATE subscriptions SET ends_at=?, auto_renew=1 WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), subscription.id);
  const before = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  const first = await f.billing.renewSubscription(subscription.id, { automatic: true });
  const second = await f.billing.renewSubscription(subscription.id, { automatic: true });
  assert.equal(first.renewed, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.orderId, first.orderId);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM orders WHERE subscription_id=? AND type='renewal'").get(subscription.id).count, 1);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, before - 300);
  f.db.close();
});

test('自动续费余额不足进入宽限期，宽限期结束后套餐到期', async () => {
  const f = await fixture();
  const subscription = await f.billing.activeSubscription(f.ids.alice);
  f.db.prepare('UPDATE wallets SET balance_cents=0 WHERE user_id=?').run(f.ids.alice);
  f.db.prepare("UPDATE subscriptions SET ends_at=?, auto_renew=1 WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), subscription.id);
  const failed = await f.billing.renewSubscription(subscription.id, { automatic: true });
  assert.equal(failed.reason, 'insufficient_balance');
  assert.ok(new Date(failed.graceEndsAt) > new Date());
  assert.equal(f.db.prepare('SELECT renewal_failed_at IS NOT NULL AS failed FROM subscriptions WHERE id=?').get(subscription.id).failed, true);
  f.db.prepare('UPDATE subscriptions SET grace_ends_at=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), subscription.id);
  await f.billing.processLifecycle();
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscription.id).status, 'expired');
  f.db.close();
});

test('管理员全额退款恢复余额并回滚套餐权益，重复退款被拒绝', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password'); const userCookie = await login(api.base, 'alice', 'alice-password');
  const plan = f.db.prepare("SELECT id,price_cents FROM plans WHERE code='experience'").get();
  const before = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  const purchase = await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: plan.id });
  const purchased = (await purchase.json()).data;
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, before - plan.price_cents);
  const refunded = await request(api.base, `/api/admin/billing/orders/${purchased.orderId}/refund`, adminCookie, 'POST', {});
  assert.equal(refunded.status, 200);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, before);
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(purchased.id).status, 'cancelled');
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE id=?').get(purchased.orderId).status, 'refunded');
  assert.equal((await request(api.base, `/api/admin/billing/orders/${purchased.orderId}/refund`, adminCookie, 'POST', {})).status, 409);
});

test('套餐绑定网站或其他资源时拒绝退款且不改变订单、套餐和余额', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password'); const userCookie = await login(api.base, 'alice', 'alice-password');
  const plan = f.db.prepare("SELECT id,price_cents FROM plans WHERE code='experience'").get();
  const before = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  const purchased = (await (await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: plan.id })).json()).data;
  const siteId = Number(f.db.prepare(`INSERT INTO sites (owner_id,subscription_id,upstream_id,domain,origin,state)
    VALUES (?,?,?,'refund-site.example.com','192.0.2.10','active')`).run(f.ids.alice, purchased.id, 'refund-site').lastInsertRowid);
  assert.equal((await request(api.base, `/api/admin/billing/orders/${purchased.orderId}/refund`, adminCookie, 'POST', {})).status, 409);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, before - plan.price_cents);
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE id=?').get(purchased.orderId).status, 'paid');
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(purchased.id).status, 'active');

  f.db.prepare('DELETE FROM sites WHERE id=?').run(siteId);
  const resourceId = await tenantProxyInternals.saveResource(f.db, 'streams', 'refund-stream', f.ids.alice);
  f.db.prepare('UPDATE tenant_resources SET subscription_id=? WHERE id=?').run(purchased.id, resourceId);
  assert.equal((await request(api.base, `/api/admin/billing/orders/${purchased.orderId}/refund`, adminCookie, 'POST', {})).status, 409);
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE id=?').get(purchased.orderId).status, 'paid');

  f.db.prepare('DELETE FROM tenant_resources WHERE id=?').run(resourceId);
  assert.equal((await request(api.base, `/api/admin/billing/orders/${purchased.orderId}/refund`, adminCookie, 'POST', {})).status, 200);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, before);
});

test('计费任务健康状态覆盖未启动、首次运行、失败、过期、超时和正常', async () => {
  const f = await fixture(); const now = Date.now();
  assert.equal(f.billing.schedulerHealth(now).ok, false);
  f.billing.scheduler.startedAt = new Date(now).toISOString(); f.billing.scheduler.intervalMs = 60_000;
  assert.equal(f.billing.schedulerHealth(now).pending, true);
  f.billing.scheduler.lastRunAt = new Date(now).toISOString(); f.billing.scheduler.lastRunOk = false; f.billing.scheduler.lastRunError = '测试失败';
  assert.equal(f.billing.schedulerHealth(now).error, '测试失败');
  f.billing.scheduler.lastRunOk = true; f.billing.scheduler.lastRunAt = new Date(now - 16 * 60_000).toISOString();
  assert.match(f.billing.schedulerHealth(now).error, /长时间未运行/);
  f.billing.scheduler.lastRunAt = new Date(now).toISOString(); f.billing.scheduler.runningSince = new Date(now - 16 * 60_000).toISOString();
  assert.match(f.billing.schedulerHealth(now).error, /执行超时/);
  f.billing.scheduler.runningSince = null; assert.equal(f.billing.schedulerHealth(now).ok, true);
  f.db.close();
});

test('同一租户可持有多个套餐并分别绑定网站', async () => {
  const f = await fixture();
  const first = await f.billing.activeSubscription(f.ids.alice);
  const standard = f.db.prepare("SELECT id FROM plans WHERE code='standard'").get();
  const secondId = await f.billing.assignPlan(f.ids.alice, standard.id);
  f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, state)
    VALUES (?, ?, 'site-first', 'first.example.com', '192.0.2.1', 'active')`).run(f.ids.alice, first.id);
  f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, state)
    VALUES (?, ?, 'site-second', 'second.example.com', '192.0.2.2', 'active')`).run(f.ids.alice, secondId);
  const snapshot = await f.billing.snapshot(f.ids.alice);
  assert.equal(snapshot.subscriptions.length, 2);
  assert.deepEqual(snapshot.subscriptions.map(item => item.resources.sites).sort(), [1, 1]);
  assert.equal(snapshot.subscriptions.find(item => item.subscription.id === first.id).usage.domains, 1);
  assert.equal(snapshot.subscriptions.find(item => item.subscription.id === secondId).usage.domains, 1);
  f.db.close();
});

test('单个套餐超限只暂停绑定到该套餐的网站和转发', async () => {
  const f = await fixture();
  const limited = await f.billing.activeSubscription(f.ids.alice);
  const standard = f.db.prepare("SELECT id FROM plans WHERE code='standard'").get();
  const healthyId = await f.billing.assignPlan(f.ids.alice, standard.id);
  f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, enabled, state)
    VALUES (?, ?, 'site-limited', 'one.example.com,two.example.com', '192.0.2.1', 1, 'active')`).run(f.ids.alice, limited.id);
  f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, enabled, state)
    VALUES (?, ?, 'site-healthy', 'healthy.example.com', '192.0.2.2', 1, 'active')`).run(f.ids.alice, healthyId);
  const limitedStream = await tenantProxyInternals.saveResource(f.db, 'streams', 'stream-limited', f.ids.alice);
  const healthyStream = await tenantProxyInternals.saveResource(f.db, 'streams', 'stream-healthy', f.ids.alice);
  f.db.prepare('UPDATE tenant_resources SET subscription_id=?, enabled=1 WHERE id=?').run(limited.id, limitedStream);
  f.db.prepare('UPDATE tenant_resources SET subscription_id=?, enabled=1 WHERE id=?').run(healthyId, healthyStream);
  f.db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, 8443)').run(limitedStream);
  f.db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, 9443)').run(healthyStream);
  await f.billing.enforceUser(f.ids.alice, { syncTraffic: false });
  assert.equal(f.db.prepare("SELECT enabled FROM sites WHERE upstream_id='site-limited'").get().enabled, 0);
  assert.equal(f.db.prepare("SELECT enabled FROM sites WHERE upstream_id='site-healthy'").get().enabled, 1);
  assert.equal(f.db.prepare('SELECT enabled FROM tenant_resources WHERE id=?').get(limitedStream).enabled, 0);
  assert.equal(f.db.prepare('SELECT enabled FROM tenant_resources WHERE id=?').get(healthyStream).enabled, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM quota_suspensions WHERE subscription_id=? AND restored_at IS NULL').get(healthyId).count, 0);
  f.db.close();
});

test('租户不能绑定其他租户套餐且绑定资源时不能取消套餐', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password'); const aliceCookie = await login(api.base, 'alice', 'alice-password');
  const aliceSubscription = await f.billing.activeSubscription(f.ids.alice); const bobSubscription = await f.billing.activeSubscription(f.ids.bob);
  const foreignSite = await request(api.base, '/api/sites', aliceCookie, 'POST', { subscriptionId: bobSubscription.id, domain: 'foreign.example.com', origin: '192.0.2.9' });
  assert.equal(foreignSite.status, 404);
  const foreignStream = await request(api.base, '/api/cdnfly/v1/streams', aliceCookie, 'POST', { subscriptionId: bobSubscription.id, listen: [{ port: 8443, protocol: 'tcp' }], backend_port: 443, backend: [{ addr: '192.0.2.10' }] });
  assert.equal(foreignStream.status, 404);
  f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, state)
    VALUES (?, ?, 'bound-site', 'bound.example.com', '192.0.2.3', 'active')`).run(f.ids.alice, aliceSubscription.id);
  assert.equal((await request(api.base, `/api/admin/billing/subscriptions/${aliceSubscription.id}`, adminCookie, 'DELETE')).status, 409);
});

test('四层转发可在本租户套餐间迁移但不能被其他租户修改', async t => {
  const f = await fixture();
  let upstreamConfig = { id: 'stream-new', des: '迁移测试', listen: [{ port: 8443, protocol: 'tcp' }], backend_port: 443, backend: [{ addr: '192.0.2.30' }], enable: 1 };
  f.cdnfly.request = async (method, path, body) => {
    f.cdnfly.calls.push(['request', method, path, body]);
    if (method === 'POST' && path === '/v1/streams') return 'stream-new';
    if (method === 'GET' && path === '/v1/streams/stream-new') return upstreamConfig;
    if (method === 'PUT' && path === '/v1/streams/stream-new') { upstreamConfig = { ...upstreamConfig, ...body }; return true; }
    return true;
  };
  const secondId = await f.billing.assignPlan(f.ids.alice, f.db.prepare("SELECT id FROM plans WHERE code='standard'").get().id);
  const targetId = await f.billing.assignPlan(f.ids.alice, f.db.prepare("SELECT id FROM plans WHERE code='basic'").get().id);
  const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const aliceCookie = await login(api.base, 'alice', 'alice-password'); const bobCookie = await login(api.base, 'bob', 'bobby-password');
  const created = await request(api.base, '/api/cdnfly/v1/streams', aliceCookie, 'POST', { subscriptionId: secondId, des: '迁移测试', listen: [{ port: 8443, protocol: 'tcp' }], backend_port: 443, backend: [{ addr: '192.0.2.30' }], enable: 1 });
  assert.equal(created.status, 201); const localId = Number((await created.json()).data);
  assert.equal((await request(api.base, `/api/cdnfly/v1/streams/${localId}`, aliceCookie, 'PUT', { subscriptionId: targetId, listen: [{ port: 8443, protocol: 'tcp' }] })).status, 200);
  assert.equal((await request(api.base, `/api/cdnfly/v1/streams/${localId}`, bobCookie, 'PUT', { subscriptionId: (await f.billing.activeSubscription(f.ids.bob)).id })).status, 404);
  assert.equal(f.db.prepare('SELECT subscription_id FROM tenant_resources WHERE id=?').get(localId).subscription_id, targetId);
});

test('网站迁移套餐后立即复检并恢复旧套餐状态', async t => {
  const f = await fixture(); const limited = await f.billing.activeSubscription(f.ids.alice);
  const targetId = await f.billing.assignPlan(f.ids.alice, f.db.prepare("SELECT id FROM plans WHERE code='standard'").get().id);
  const siteId = Number(f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, enabled, state)
    VALUES (?, ?, 'migrate-site', 'one.example.com', '192.0.2.40', 1, 'active')`).run(f.ids.alice, limited.id).lastInsertRowid);
  f.db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_id, domain, origin, enabled, state)
    VALUES (?, ?, 'remaining-site', 'two.example.com', '192.0.2.41', 1, 'active')`).run(f.ids.alice, limited.id);
  await f.billing.enforceUser(f.ids.alice, { syncTraffic: false });
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(limited.id).status, 'suspended');
  const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); }); const cookie = await login(api.base, 'alice', 'alice-password');
  const moved = await request(api.base, `/api/sites/${siteId}`, cookie, 'PUT', { subscriptionId: targetId, enabled: true });
  assert.equal(moved.status, 200);
  assert.equal(f.db.prepare('SELECT subscription_id FROM sites WHERE id=?').get(siteId).subscription_id, targetId);
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(limited.id).status, 'active');
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id=?').get(siteId).enabled, 1);
  assert.equal(f.db.prepare("SELECT enabled FROM sites WHERE upstream_id='remaining-site'").get().enabled, 1);
});

test('套餐升配报价扣除按剩余天数折算的差价且重复提交幂等', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const cookie = await login(api.base, 'alice', 'alice-password'); const subscription = await f.billing.activeSubscription(f.ids.alice);
  const target = f.db.prepare("SELECT * FROM plans WHERE code='standard'").get();
  const beforeBalance = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  const beforeEndsAt = f.db.prepare('SELECT ends_at FROM subscriptions WHERE id=?').get(subscription.id).ends_at;

  const quoteResponse = await request(api.base, `/api/cdnfly/v1/user-packages/${subscription.id}?to_package=${target.id}`, cookie);
  assert.equal(quoteResponse.status, 200);
  const quote = (await quoteResponse.json()).data;
  assert.equal(quote.period, '30d'); assert.equal(quote.remain_days, 30);
  assert.equal(quote.curr_price_cents, 300); assert.equal(quote.new_price_cents, 2800); assert.equal(quote.diff_price_cents, 2500);
  assert.equal(quote.curr_price, 3); assert.equal(quote.new_price, 28); assert.equal(quote.diff_price, 25);

  const changedResponse = await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: subscription.id, package: target.id });
  assert.equal(changedResponse.status, 200); const changed = (await changedResponse.json()).data;
  assert.equal(changed.idempotent, false); assert.equal(changed.diff_price_cents, 2500);
  assert.equal(f.db.prepare('SELECT plan_id FROM subscriptions WHERE id=?').get(subscription.id).plan_id, target.id);
  assert.equal(new Date(f.db.prepare('SELECT ends_at FROM subscriptions WHERE id=?').get(subscription.id).ends_at).toISOString(), new Date(beforeEndsAt).toISOString());
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, beforeBalance - 2500);
  const order = f.db.prepare("SELECT * FROM orders WHERE subscription_id=? AND type='plan_change'").get(subscription.id);
  assert.equal(order.amount_cents, 2500); assert.equal(order.channel, 'balance'); assert.equal(order.status, 'paid');
  assert.equal(JSON.parse(order.metadata).walletDeltaCents, -2500);

  const beforeOrderCount = f.db.prepare("SELECT COUNT(*) AS count FROM orders WHERE subscription_id=? AND type='plan_change'").get(subscription.id).count;
  const repeated = await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: subscription.id, package: target.id });
  assert.equal(repeated.status, 200); assert.equal((await repeated.json()).data.idempotent, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM orders WHERE subscription_id=? AND type='plan_change'").get(subscription.id).count, beforeOrderCount);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, beforeBalance - 2500);
});

test('套餐降配在同一事务内退款并保留原到期时间', async t => {
  const f = await fixture(); const standard = f.db.prepare("SELECT * FROM plans WHERE code='standard'").get();
  const trial = f.db.prepare("SELECT * FROM plans WHERE code='trial'").get(); const subscriptionId = await f.billing.assignPlan(f.ids.alice, standard.id);
  const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); }); const cookie = await login(api.base, 'alice', 'alice-password');
  const beforeBalance = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  const beforeEndsAt = f.db.prepare('SELECT ends_at FROM subscriptions WHERE id=?').get(subscriptionId).ends_at;
  const response = await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: subscriptionId, package: trial.id });
  assert.equal(response.status, 200); const changed = (await response.json()).data;
  assert.equal(changed.diff_price_cents, -2500); assert.equal(changed.balanceCents, beforeBalance + 2500);
  assert.equal(f.db.prepare('SELECT plan_id FROM subscriptions WHERE id=?').get(subscriptionId).plan_id, trial.id);
  assert.equal(new Date(f.db.prepare('SELECT ends_at FROM subscriptions WHERE id=?').get(subscriptionId).ends_at).toISOString(), new Date(beforeEndsAt).toISOString());
  const order = f.db.prepare("SELECT * FROM orders WHERE subscription_id=? AND type='plan_change'").get(subscriptionId);
  assert.equal(order.amount_cents, 2500); assert.equal(order.channel, 'balance_refund');
  const walletTransaction = f.db.prepare("SELECT * FROM wallet_transactions WHERE reference_type='order-refund' AND reference_id=?").get(String(order.id));
  assert.equal(walletTransaction.direction, 'credit'); assert.equal(walletTransaction.amount_cents, 2500);
  const adminCookie = await login(api.base, 'admin', 'admin-password');
  const overview = await request(api.base, '/api/admin/overview', adminCookie);
  assert.equal((await overview.json()).overview.orders.paidAmountCents, -2500);
  const detail = await request(api.base, `/api/admin/billing/orders/${order.id}`, adminCookie);
  const detailOrder = (await detail.json()).order;
  assert.equal(detailOrder.balanceAdjustmentCents, 2500); assert.equal(detailOrder.transactionId, walletTransaction.id);
});

test('套餐升配余额不足时订单、钱包和套餐全部回滚', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const cookie = await login(api.base, 'alice', 'alice-password'); const subscription = await f.billing.activeSubscription(f.ids.alice);
  const target = f.db.prepare("SELECT * FROM plans WHERE code='standard'").get();
  f.db.prepare('UPDATE wallets SET balance_cents=2499 WHERE user_id=?').run(f.ids.alice);
  const beforeOrders = f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(f.ids.alice).count;
  const beforeTransactions = f.db.prepare('SELECT COUNT(*) AS count FROM wallet_transactions WHERE user_id=?').get(f.ids.alice).count;
  const response = await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: subscription.id, package: target.id });
  assert.equal(response.status, 409);
  assert.equal(f.db.prepare('SELECT plan_id FROM subscriptions WHERE id=?').get(subscription.id).plan_id, subscription.plan_id);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, 2499);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(f.ids.alice).count, beforeOrders);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wallet_transactions WHERE user_id=?').get(f.ids.alice).count, beforeTransactions);
});

test('套餐升降配拒绝跨上游映射和其他租户套餐实例', async t => {
  const f = await fixture(); const upstreamId = Number(f.db.prepare(`INSERT INTO upstream_accounts
    (name,base_url,api_key_encrypted,api_secret_encrypted,status) VALUES ('mapping-test','https://upstream.example','key','secret','active')`).run().lastInsertRowid);
  const current = await f.billing.activeSubscription(f.ids.alice); const target = f.db.prepare("SELECT * FROM plans WHERE code='standard'").get();
  f.db.prepare('UPDATE plans SET upstream_id=?, upstream_package_id=? WHERE id=?').run(upstreamId, 'package-a', current.plan_id);
  f.db.prepare('UPDATE subscriptions SET upstream_id=?, upstream_package_id=? WHERE id=?').run(upstreamId, 'package-a', current.id);
  f.db.prepare('UPDATE plans SET upstream_id=?, upstream_package_id=? WHERE id=?').run(upstreamId, 'package-b', target.id);
  const bobSubscription = await f.billing.activeSubscription(f.ids.bob);
  const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); }); const cookie = await login(api.base, 'alice', 'alice-password');
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-packages/${current.id}?to_package=${target.id}`, cookie)).status, 409);
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: current.id, package: target.id })).status, 409);
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-packages/${bobSubscription.id}?to_package=${current.plan_id}`, cookie)).status, 404);
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: bobSubscription.id, package: current.plan_id })).status, 404);
  assert.equal(f.db.prepare('SELECT plan_id FROM subscriptions WHERE id=?').get(current.id).plan_id, current.plan_id);
});

test('套餐升降配完成后立即恢复或暂停超限资源', async t => {
  const f = await fixture(); const subscription = await f.billing.activeSubscription(f.ids.alice);
  const standard = f.db.prepare("SELECT * FROM plans WHERE code='standard'").get(); const trial = f.db.prepare("SELECT * FROM plans WHERE code='trial'").get();
  const siteId = Number(f.db.prepare(`INSERT INTO sites (owner_id,subscription_id,upstream_id,domain,origin,enabled,state)
    VALUES (?,?,?,'one.example.com,two.example.com','192.0.2.50',1,'active')`).run(f.ids.alice, subscription.id, 'plan-change-site').lastInsertRowid);
  await f.billing.enforceUser(f.ids.alice, { syncTraffic: false });
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id=?').get(siteId).enabled, 0);
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscription.id).status, 'suspended');
  const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); }); const cookie = await login(api.base, 'alice', 'alice-password');
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: subscription.id, package: standard.id })).status, 200);
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id=?').get(siteId).enabled, 1);
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscription.id).status, 'active');
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'PUT', { id: subscription.id, package: trial.id })).status, 200);
  assert.equal(f.db.prepare('SELECT enabled FROM sites WHERE id=?').get(siteId).enabled, 0);
  assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscription.id).status, 'suspended');
});

test('默认重复购买同一套餐只叠加时长，不新开实例', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const cookie = await login(api.base, 'alice', 'alice-password');
  const trial = f.db.prepare("SELECT * FROM plans WHERE code='trial'").get();
  const existing = await f.billing.activeSubscription(f.ids.alice);
  const beforeEnds = new Date(existing.ends_at).getTime();
  const beforeCount = f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=? AND plan_id=?').get(f.ids.alice, trial.id).count;
  const bought = await request(api.base, '/api/cdnfly/v1/user-packages', cookie, 'POST', { planId: trial.id });
  assert.equal(bought.status, 201);
  const payload = await bought.json();
  assert.equal(payload.data.id, existing.id);
  assert.equal(f.db.prepare("SELECT type FROM orders WHERE id=?").get(payload.data.orderId).type, 'renewal');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=? AND plan_id=?').get(f.ids.alice, trial.id).count, beforeCount);
  const afterEnds = new Date(f.db.prepare('SELECT ends_at FROM subscriptions WHERE id=?').get(existing.id).ends_at).getTime();
  assert.ok(afterEnds - beforeEnds >= trial.duration_days * 86400_000 - 2000);
});

test('限购一次的套餐拒绝客户重复购买和后台再分配', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password');
  const userCookie = await login(api.base, 'alice', 'alice-password');
  const trial = f.db.prepare("SELECT * FROM plans WHERE code='trial'").get();
  f.db.prepare("UPDATE plans SET purchase_mode='once' WHERE id=?").run(trial.id);
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: trial.id })).status, 409);
  assert.equal((await request(api.base, '/api/admin/billing/subscriptions', adminCookie, 'POST', { userId: f.ids.alice, planId: trial.id })).status, 409);
  const listed = await (await request(api.base, '/api/cdnfly/v1/packages', userCookie)).json();
  assert.equal(listed.data.items.find(item => item.id === trial.id).purchaseMode, 'once');
});

test('首次购买可按后台上限选择数量，超额被拒绝且金额按时长倍数扣款', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password');
  const userCookie = await login(api.base, 'alice', 'alice-password');
  const created = await request(api.base, '/api/admin/billing/plans', adminCookie, 'POST', {
    code: 'qtyplan', name: '数量套餐', priceCents: 1000, durationDays: 30, domainLimit: 2, trafficLimitBytes: 10 * 1024 ** 3,
    portLimit: 1, enabled: true, purchaseMode: 'stack', maxPurchaseQty: 3,
  });
  assert.equal(created.status, 201);
  const plan = (await created.json()).plan;
  assert.equal(plan.maxPurchaseQty, 3);
  const before = f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents;
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: plan.id, amount: 4 })).status, 409);
  const bought = await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: plan.id, amount: 3 });
  assert.equal(bought.status, 201);
  const payload = await bought.json();
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(f.ids.alice).balance_cents, before - 3000);
  assert.equal(f.db.prepare('SELECT amount_cents FROM orders WHERE id=?').get(payload.data.orderId).amount_cents, 3000);
  const sub = f.db.prepare('SELECT starts_at, ends_at FROM subscriptions WHERE id=?').get(payload.data.id);
  assert.ok(new Date(sub.ends_at) - new Date(sub.starts_at) >= 90 * 86400_000 - 2000);
});

test('禁止续费的套餐拒绝叠加、自动续费和开启自动续费', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password');
  const userCookie = await login(api.base, 'alice', 'alice-password');
  const trial = f.db.prepare("SELECT * FROM plans WHERE code='trial'").get();
  const saved = await request(api.base, `/api/admin/billing/plans/${trial.id}`, adminCookie, 'PUT', { renewalMode: 'off' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).plan.renewalMode, 'off');
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: trial.id })).status, 409);
  const existing = await f.billing.activeSubscription(f.ids.alice);
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-packages/${existing.id}`, userCookie, 'PUT', { autoRenew: true })).status, 409);
  assert.equal((await request(api.base, `/api/cdnfly/v1/user-packages/${existing.id}/renew`, userCookie, 'POST', {})).status, 409);
});

test('到期前窗口套餐只在剩余天数进入窗口后才允许叠加', async t => {
  const f = await fixture(); const api = await startApi(f); t.after(() => { api.server.close(); f.db.close(); });
  const adminCookie = await login(api.base, 'admin', 'admin-password');
  const userCookie = await login(api.base, 'alice', 'alice-password');
  const trial = f.db.prepare("SELECT * FROM plans WHERE code='trial'").get();
  const existing = await f.billing.activeSubscription(f.ids.alice);
  assert.equal((await request(api.base, `/api/admin/billing/plans/${trial.id}`, adminCookie, 'PUT', { renewalMode: 'window', renewalWindowDays: 3 })).status, 200);
  assert.equal((await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: trial.id })).status, 409);
  f.db.prepare("UPDATE subscriptions SET ends_at=? WHERE id=?").run(new Date(Date.now() + 2 * 86400_000).toISOString(), existing.id);
  const bought = await request(api.base, '/api/cdnfly/v1/user-packages', userCookie, 'POST', { planId: trial.id });
  assert.equal(bought.status, 201);
  assert.equal(f.db.prepare("SELECT type FROM orders WHERE id=?").get((await bought.json()).data.orderId).type, 'renewal');
});
