import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { UpstreamService } from '../src/upstreams.js';

const config = {
  settingsEncryptionKey: 'routing-test-encryption-key',
  cdnflyCacheTtlSeconds: 30,
  cdnflyMonitorCacheTtlSeconds: 8,
  cdnflyRequestsPerMinute: 300,
  upstreamTimeoutMs: 1000,
};

test('站点和资源始终使用订阅冻结的上游套餐 ID', async () => {
  const db = createDatabase();
  try {
    const admin = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('routing-admin', hashPassword('routing-admin-password'), 'admin', 0).lastInsertRowid);
    const user = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('routing-user', hashPassword('routing-user-password'), 'user', 10).lastInsertRowid);
    const upstreams = await new UpstreamService(db, config, null, { fetchImpl: async () => { throw new Error('network must not be called'); } }).initialize();
    const account = await upstreams.create({ name: 'routing-upstream', baseUrl: 'https://routing.example/api', cnameSuffix: 'cdndns.vip', apiKey: 'routing-key', apiSecret: 'routing-secret' }, admin);
    const plan = Number(db.prepare(`INSERT INTO plans (code,name,price_cents,duration_days,domain_limit,traffic_limit_bytes,port_limit,enabled,upstream_id,upstream_package_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('routing-plan', 'Routing plan', 0, 30, 10, null, 10, 1, account.id, '16180').lastInsertRowid);
    const subscription = Number(db.prepare(`INSERT INTO subscriptions (user_id,plan_id,status,starts_at,ends_at,upstream_id,upstream_package_id)
      VALUES (?,?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', ?, ?)`).run(user, plan, account.id, '16180').lastInsertRowid);
    const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,subscription_id,upstream_account_id,upstream_id,domain,origin,state)
      VALUES (?,?,?,?,?,?, 'active')`).run(user, subscription, account.id, 'site-98795', 'tenant.example.com', '1.1.1.1').lastInsertRowid);
    const resourceId = Number(db.prepare(`INSERT INTO tenant_resources (owner_id,subscription_id,upstream_account_id,kind,upstream_id)
      VALUES (?,?,?,?,?)`).run(user, subscription, account.id, 'streams', 'stream-52461').lastInsertRowid);
    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
    const resource = db.prepare('SELECT * FROM tenant_resources WHERE id=?').get(resourceId);
    const siteClient = await upstreams.clientForSite(site);
    const resourceClient = await upstreams.clientForResource(resource);
    assert.equal(siteClient.packageId, '16180');
    assert.equal(resourceClient.packageId, '16180');
    assert.equal(siteClient.accountId, account.id);
    assert.equal(resourceClient.accountId, account.id);
    assert.equal(siteClient.cnameSuffix, 'cdndns.vip');
    assert.equal(resourceClient.cnameSuffix, 'cdndns.vip');

    const secondPlan = Number(db.prepare(`INSERT INTO plans (code,name,price_cents,duration_days,domain_limit,traffic_limit_bytes,port_limit,enabled,upstream_id,upstream_package_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('routing-plan-2', 'Routing plan 2', 0, 30, 10, null, 10, 1, account.id, '16181').lastInsertRowid);
    db.prepare(`INSERT INTO subscriptions (user_id,plan_id,status,starts_at,ends_at,upstream_id,upstream_package_id)
      VALUES (?,?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', ?, ?)`).run(user, secondPlan, account.id, '16181');
    const clients = await upstreams.clientsForUser(user);
    assert.deepEqual(clients.map(client => client.packageId), ['16180', '16181']);
  } finally {
    await db.close();
  }
});

test('兼容 CNAME 后缀只补默认上游并拒绝非法配置', async () => {
  const db = createDatabase();
  try {
    const admin = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('cname-admin', hashPassword('cname-admin-password'), 'admin', 0).lastInsertRowid);
    const upstreams = await new UpstreamService(db, config, null, { fetchImpl: async () => { throw new Error('network must not be called'); } }).initialize();
    const primary = await upstreams.create({ name: 'primary-upstream', baseUrl: 'https://primary.example/api', apiKey: 'primary-key', apiSecret: 'primary-secret' }, admin);
    const secondary = await upstreams.create({ name: 'secondary-upstream', baseUrl: 'https://secondary.example/api', apiKey: 'secondary-key', apiSecret: 'secondary-secret', isDefault: false }, admin);
    await new UpstreamService(db, { ...config, cdnflyCnameSuffix: 'cdndns.vip' }, null, { fetchImpl: async () => { throw new Error('network must not be called'); } }).initialize();
    assert.equal(db.prepare('SELECT cname_suffix FROM upstream_accounts WHERE id=?').get(primary.id).cname_suffix, 'cdndns.vip');
    assert.equal(db.prepare('SELECT cname_suffix FROM upstream_accounts WHERE id=?').get(secondary.id).cname_suffix, null);
    await assert.rejects(() => upstreams.update(primary.id, { cnameSuffix: 'https://bad.example/path' }), /CNAME 后缀无效/);
  } finally {
    await db.close();
  }
});
