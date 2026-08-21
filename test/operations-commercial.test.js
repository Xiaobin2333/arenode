import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { BillingService } from '../src/billing.js';
import { hashPassword } from '../src/security.js';

async function fixture() {
  const db = createDatabase();
  const add = db.prepare('INSERT INTO users (username,email,email_verified_at,password_hash,role,site_limit) VALUES (?,?,?,?,?,?)');
  const admin = Number(add.run('admin', 'admin@example.com', new Date().toISOString(), hashPassword('admin-password'), 'admin', 0).lastInsertRowid);
  db.prepare('INSERT INTO admin_profiles (user_id,role_key) VALUES (?,?)').run(admin, 'super_admin');
  const customers = [];
  for (let index = 1; index <= 25; index += 1) {
    const id = Number(add.run(`customer${String(index).padStart(2, '0')}`, `customer${index}@example.com`, new Date().toISOString(), hashPassword('customer-password'), 'user', 1).lastInsertRowid);
    db.prepare('INSERT INTO wallets (user_id,balance_cents) VALUES (?,?)').run(id, index * 100);
    customers.push(id);
  }
  const mailer = { available: true, sendText: async () => true };
  const cdnfly = { packageId: 1, health: async () => true, request: async () => [], updateSite: async () => true };
  const billing = await new BillingService(db, cdnfly).initialize();
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 1, settingsEncryptionKey: 'operations-test-key' };
  const server = http.createServer(createApp({ db, cdnfly, config, billing, mailer }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { db, server, billing, base: `http://127.0.0.1:${server.address().port}`, ids: { admin, customers } };
}

async function request(f, path, { cookie, method = 'GET', body } = {}) {
  return fetch(`${f.base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function login(f, username, password = 'customer-password') {
  const response = await request(f, '/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('后台聚合统计独立于当前分页，客户和权益码支持服务端分页筛选', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const adminCookie = await login(f, 'admin', 'admin-password');
  const page = await request(f, '/api/admin/customers?page=2&pageSize=10', { cookie: adminCookie });
  const pageData = await page.json();
  assert.equal(pageData.customers.length, 10);
  assert.deepEqual(pageData.pagination, { page: 2, pageSize: 10, total: 25, pages: 3 });
  const filtered = await (await request(f, '/api/admin/customers?q=customer25&status=active', { cookie: adminCookie })).json();
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.customers[0].username, 'customer25');
  const overviewResponse = await request(f, '/api/admin/overview', { cookie: adminCookie }); const overview = await overviewResponse.json();
  assert.equal(overviewResponse.status, 200, JSON.stringify(overview));
  assert.equal(overview.overview.customers.total, 25);
  assert.equal(overview.overview.walletLiabilityCents, 32_500);

  const plan = f.db.prepare("SELECT id FROM plans WHERE code='trial'").get();
  const created = await request(f, '/api/admin/billing/redemption-codes', { cookie: adminCookie, method: 'POST', body: { type: 'plan', productId: plan.id, count: 25, label: '夏季活动' } });
  assert.equal(created.status, 201);
  const codesResponse = await request(f, '/api/admin/billing/redemption-codes?page=2&pageSize=10&q=夏季&status=active', { cookie: adminCookie }); const codes = await codesResponse.json();
  assert.equal(codesResponse.status, 200, JSON.stringify(codes));
  assert.equal(codes.codes.length, 10);
  assert.deepEqual(codes.pagination, { page: 2, pageSize: 10, total: 25, pages: 3 });
  assert.equal(codes.codes.some(item => item.code || item.codeHash), false);
});

test('已移除的通知和工单接口不可访问', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const customerCookie = await login(f, 'customer01'); const adminCookie = await login(f, 'admin', 'admin-password');
  assert.equal((await request(f, '/api/notifications', { cookie: customerCookie })).status, 404);
  assert.equal((await request(f, '/api/notification-preferences', { cookie: customerCookie })).status, 404);
  assert.equal((await request(f, '/api/support/tickets', { cookie: customerCookie })).status, 404);
  assert.equal((await request(f, '/api/admin/notifications/deliveries', { cookie: adminCookie })).status, 404);
  assert.equal((await request(f, '/api/admin/support/tickets', { cookie: adminCookie })).status, 404);
});
