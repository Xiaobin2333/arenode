import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/app.js';
import { BillingService } from '../src/billing.js';
import { UpstreamService } from '../src/upstreams.js';
import { CdnflyClient, CdnflyError } from '../src/cdnfly.js';
import { tenantProxyInternals } from '../src/tenant-proxy.js';

const config = {
  appOrigin: 'http://127.0.0.1', sessionHours: 24, settingsEncryptionKey: 'multi-upstream-test-key',
  cdnflyCacheTtlSeconds: 30, cdnflyMonitorCacheTtlSeconds: 8, cdnflyRequestsPerMinute: 300,
  upstreamTimeoutMs: 1000, allowRegistration: false,
};

async function fixture() {
  const db = createDatabase();
  const add = db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)');
  const superAdmin = Number(add.run('rootadmin', hashPassword('root-password'), 'admin', 0).lastInsertRowid);
  const admin = Number(add.run('staffadmin', hashPassword('staff-password'), 'admin', 0).lastInsertRowid);
  const alice = Number(add.run('alice', hashPassword('alice-password'), 'user', 20).lastInsertRowid);
  db.prepare("INSERT INTO admin_profiles (user_id,role_key) VALUES (?, 'super_admin')").run(superAdmin);
  db.prepare("INSERT INTO admin_profiles (user_id,role_key) VALUES (?, 'admin')").run(admin);
  db.prepare('INSERT INTO wallets (user_id,balance_cents) VALUES (?,100000)').run(alice);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url); const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ host: parsed.host, path: `${parsed.pathname}${parsed.search}`, method: init.method || 'GET', body,
      apiKey: init.headers?.['api-key'], apiSecret: init.headers?.['api-secret'] });
    if (body?.domain === 'fail.example.com') throw new Error('simulated upstream outage');
    if (init.method === 'GET' && parsed.pathname.endsWith('/v1/monitor/site/access-log')) {
      return Response.json({ code: 0, data: { items: [{ id: 'same-document', host: parsed.searchParams.get('host'), source: parsed.host }] } });
    }
    if (init.method === 'GET' && parsed.pathname.includes('/v1/monitor/site/access-log/')) {
      return Response.json({ code: 0, data: { id: parsed.pathname.split('/').at(-1), source: parsed.host } });
    }
    if (init.method === 'GET' && parsed.pathname.endsWith('/v1/packages')) {
      return Response.json({ code: 0, data: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `公开目录套餐 ${index + 1}` })) });
    }
    if (init.method === 'GET' && parsed.pathname.endsWith('/v1/user-packages')) {
      return Response.json({ code: 0, count: 1, data: parsed.host === 'east.example'
        ? [{ id: 'east:owned', name: '华东账号套餐', package: 1, package_name: '公开目录套餐 1' }]
        : [{ id: 'global:owned', user_package_name: '海外账号套餐', package: 2, package_name: '公开目录套餐 2' }] });
    }
    if (init.method === 'POST' && parsed.pathname.endsWith('/v1/sites')) return Response.json({ code: 0, data: { id: '42' } });
    if (init.method === 'POST' && /\/v1\/(certs|site-groups)$/.test(parsed.pathname)) return Response.json({ code: 0, data: '7' });
    if (init.method === 'GET' && parsed.pathname.endsWith('/v1/sites')) return Response.json({ code: 0, data: [] });
    return Response.json({ code: 0, data: true });
  };
  const upstreams = await new UpstreamService(db, config, null, { fetchImpl }).initialize();
  const upstreamA = (await upstreams.create({ name: '华东上游', baseUrl: 'https://east.example/api', cnameSuffix: 'east.cdn.example', apiKey: 'east-key', apiSecret: 'east-secret' }, superAdmin)).id;
  const upstreamB = (await upstreams.create({ name: '海外上游', baseUrl: 'https://global.example/api', apiKey: 'global-key', apiSecret: 'global-secret' }, superAdmin)).id;
  await upstreams.savePackage(upstreamA, { packageId: 'east:pro', name: '华东专业版' });
  await upstreams.savePackage(upstreamB, { packageId: 'global:pro', name: '海外专业版' });
  const legacy = { health: async () => true, request: async () => [], updateSite: async () => true };
  const billing = await new BillingService(db, legacy, { upstreams }).initialize();
  const trial = db.prepare("SELECT * FROM plans WHERE code='trial'").get();
  const standard = db.prepare("SELECT * FROM plans WHERE code='standard'").get();
  db.prepare('UPDATE plans SET upstream_id=?,upstream_package_id=? WHERE id=?').run(upstreamA, 'east:pro', trial.id);
  db.prepare('UPDATE plans SET upstream_id=?,upstream_package_id=? WHERE id=?').run(upstreamB, 'global:pro', standard.id);
  const subA = await billing.assignPlan(alice, trial.id);
  const subB = await billing.assignPlan(alice, standard.id);
  const server = http.createServer(createApp({ db, cdnfly: legacy, upstreams, config, billing }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, upstreams, billing, calls,
    ids: { superAdmin, admin, alice, upstreamA, upstreamB, subA, subB, trial: trial.id, standard: standard.id } };
}

async function request(f, path, { cookie, method = 'GET', body } = {}) {
  return fetch(`${f.base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

async function login(f, username, password) {
  const response = await request(f, '/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('上游目录不回传凭据且只有超级管理员可以修改', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const superCookie = await login(f, 'rootadmin', 'root-password'); const adminCookie = await login(f, 'staffadmin', 'staff-password');
  const listed = await (await request(f, '/api/admin/upstreams', { cookie: adminCookie })).json();
  assert.equal(listed.upstreams.length, 2);
  assert.equal(listed.upstreams.every(row => row.credentialConfigured), true);
  assert.equal(listed.upstreams.find(row => row.id === f.ids.upstreamA).cnameSuffix, 'east.cdn.example');
  assert.equal(JSON.stringify(listed).includes('east-key'), false);
  assert.equal(JSON.stringify(listed).includes('east-secret'), false);
  assert.equal((await request(f, '/api/admin/upstreams', { cookie: adminCookie, method: 'POST', body: {
    name: '越权上游', baseUrl: 'https://blocked.example/api', apiKey: 'key', apiSecret: 'secret',
  } })).status, 403);
  assert.equal((await request(f, `/api/admin/upstreams/${f.ids.upstreamA}`, { cookie: superCookie, method: 'PUT', body: { name: '华东主上游' } })).status, 200);
});

test('仅从用户套餐接口读取账号实际持有的套餐并拒绝公开目录套餐', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const superCookie = await login(f, 'rootadmin', 'root-password'); const adminCookie = await login(f, 'staffadmin', 'staff-password');
  assert.equal((await request(f, `/api/admin/upstreams/${f.ids.upstreamA}/available-packages`, { cookie: adminCookie })).status, 403);
  const response = await request(f, `/api/admin/upstreams/${f.ids.upstreamA}/available-packages`, { cookie: superCookie });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).packages, [
    { packageId: 'east:owned', name: '华东账号套餐', description: '' },
  ]);
  assert.equal(f.calls.some(call => call.path.startsWith('/v1/packages')), false);
  assert.equal(f.calls.some(call => call.path.endsWith('/v1/user-packages?limit=0')), true);
  assert.equal((await request(f, `/api/admin/upstreams/${f.ids.upstreamA}/packages`, {
    cookie: superCookie, method: 'POST', body: { packageId: '1', name: '公开目录套餐 1' },
  })).status, 409);
  const saved = await request(f, `/api/admin/upstreams/${f.ids.upstreamA}/packages`, {
    cookie: superCookie, method: 'POST', body: { packageId: 'east:owned', name: '' },
  });
  assert.equal(saved.status, 201);
  assert.equal(f.db.prepare('SELECT name FROM upstream_packages WHERE upstream_id=? AND package_id=?').get(f.ids.upstreamA, 'east:owned').name, '华东账号套餐');
});

test('网站分组只保存在客户站内且不路由到任何上游', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const cookie = await login(f, 'alice', 'alice-password');
  const before = f.calls.length;
  const response = await request(f, '/api/cdnfly/v1/site-groups', { cookie, method: 'POST', body: {
    name: 'East group', des: '限定到华东上游', subscriptionId: f.ids.subA,
  } });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const localId = Number(result.data);
  const mapping = f.db.prepare('SELECT user_id,name,description FROM customer_site_groups WHERE id=?').get(localId);
  assert.deepEqual(mapping, { user_id: f.ids.alice, name: 'East group', description: '限定到华东上游' });
  assert.equal(f.calls.length, before);
});

test('多上游客户创建网站必须明确选择套餐且不会提前写入上游', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const cookie = await login(f, 'alice', 'alice-password');
  const response = await request(f, '/api/sites', { cookie, method: 'POST', body: {
    domain: 'missing-subscription.example.com', origin: '1.1.1.1',
  } });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /套餐/);
  assert.equal(f.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).length, 0);
});

test('客户套餐冻结上游映射且网站始终路由到所属账号', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const cookie = await login(f, 'alice', 'alice-password');
  f.db.prepare('UPDATE plans SET upstream_id=?,upstream_package_id=? WHERE id=?').run(f.ids.upstreamB, 'global:pro', f.ids.trial);
  const frozen = f.db.prepare('SELECT upstream_id,upstream_package_id FROM subscriptions WHERE id=?').get(f.ids.subA);
  assert.deepEqual({ upstreamId: Number(frozen.upstream_id), packageId: frozen.upstream_package_id }, { upstreamId: f.ids.upstreamA, packageId: 'east:pro' });

  for (const [subscriptionId, domain] of [[f.ids.subA, 'east.example.com'], [f.ids.subB, 'global.example.com']]) {
    const response = await request(f, '/api/sites', { cookie, method: 'POST', body: { subscriptionId, domain, origin: '192.0.2.10' } });
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
  }
  const rows = f.db.prepare('SELECT domain,upstream_id,upstream_account_id FROM sites ORDER BY id').all();
  assert.deepEqual(rows.map(row => [row.domain, row.upstream_id, Number(row.upstream_account_id)]), [
    ['east.example.com', '42', f.ids.upstreamA], ['global.example.com', '42', f.ids.upstreamB],
  ]);
  const creates = f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/v1/sites'));
  assert.deepEqual(creates.map(call => [call.host, call.body.user_package]), [['east.example', 'east:pro'], ['global.example', 'global:pro']]);
});

test('同一上游资源 ID 按账号隔离且跨上游关联会被拒绝', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const first = await tenantProxyInternals.saveResource(f.db, 'certs', '7', f.ids.alice, null, false, f.ids.upstreamA);
  const second = await tenantProxyInternals.saveResource(f.db, 'certs', '7', f.ids.alice, null, false, f.ids.upstreamB);
  assert.notEqual(first, second);
  await assert.rejects(
    tenantProxyInternals.translateReferences(f.db, { cert_id: first }, f.ids.alice, f.ids.upstreamB),
    error => error.status === 409 && /同一 CDN 服务/.test(error.message),
  );
});

test('相同日志文档 ID 本地化后按所属上游读取详情', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const cookie = await login(f, 'alice', 'alice-password');
  const siteIds = [];
  for (const [subscriptionId, domain] of [[f.ids.subA, 'east-log.example.com'], [f.ids.subB, 'global-log.example.com']]) {
    const response = await request(f, '/api/sites', { cookie, method: 'POST', body: { subscriptionId, domain, origin: '192.0.2.40' } });
    siteIds.push((await response.json()).site.id);
  }
  const documents = [];
  for (const siteId of siteIds) {
    const response = await request(f, `/api/cdnfly/v1/monitor/site/access-log?site_id=${siteId}`, { cookie });
    documents.push((await response.json()).data.items[0]);
  }
  assert.notEqual(documents[0].id, documents[1].id);
  const first = await (await request(f, `/api/cdnfly/v1/monitor/site/access-log/${documents[0].id}`, { cookie })).json();
  const second = await (await request(f, `/api/cdnfly/v1/monitor/site/access-log/${documents[1].id}`, { cookie })).json();
  assert.equal(first.data.source, 'east.example');
  assert.equal(second.data.source, 'global.example');
  assert.equal(first.data.id, 'same-document');
  assert.equal(second.data.id, 'same-document');
});

test('跨上游网站迁移在任何上游写入前被拒绝', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const cookie = await login(f, 'alice', 'alice-password');
  const created = await request(f, '/api/sites', { cookie, method: 'POST', body: { subscriptionId: f.ids.subA, domain: 'move.example.com', origin: '192.0.2.20' } });
  const siteId = (await created.json()).site.id; const writesBefore = f.calls.filter(call => ['PUT', 'POST', 'DELETE'].includes(call.method)).length;
  const moved = await request(f, `/api/cdnfly/v1/sites/${siteId}`, { cookie, method: 'PUT', body: { subscriptionId: f.ids.subB, gzip_enable: 1 } });
  assert.equal(moved.status, 409);
  assert.equal(f.calls.filter(call => ['PUT', 'POST', 'DELETE'].includes(call.method)).length, writesBefore);
  assert.equal(f.db.prepare('SELECT subscription_id FROM sites WHERE id=?').get(siteId).subscription_id, f.ids.subA);
});

test('上游创建失败不会遗留本地网站且生效订阅阻止停用账号', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const cookie = await login(f, 'alice', 'alice-password'); const superCookie = await login(f, 'rootadmin', 'root-password');
  const failed = await request(f, '/api/sites', { cookie, method: 'POST', body: { subscriptionId: f.ids.subA, domain: 'fail.example.com', origin: '192.0.2.30' } });
  assert.equal(failed.status, 502);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sites WHERE domain='fail.example.com'").get().count, 0);
  const disabled = await request(f, `/api/admin/upstreams/${f.ids.upstreamA}`, { cookie: superCookie, method: 'PUT', body: { status: 'disabled' } });
  assert.equal(disabled.status, 409);
  assert.equal(f.db.prepare('SELECT status FROM upstream_accounts WHERE id=?').get(f.ids.upstreamA).status, 'active');
});

test('缓存与请求预算按上游账号隔离', async () => {
  const cache = {
    values: new Map(), budgets: new Map(),
    async getOrSet(namespace, key, _ttl, loader) { const full = `${namespace}:${key}`; if (!this.values.has(full)) this.values.set(full, await loader()); return structuredClone(this.values.get(full)); },
    async invalidate() { this.values.clear(); },
    async rateLimit(_scope, identity, limit) { const count = (this.budgets.get(identity) || 0) + 1; this.budgets.set(identity, count); return { allowed: count <= limit }; },
  };
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return Response.json({ code: 0, data: { source: new URL(url).host } }); };
  const base = { upstreamTimeoutMs: 1000, cdnflyCacheTtlSeconds: 30, cdnflyMonitorCacheTtlSeconds: 8, cdnflyRequestsPerMinute: 2,
    cdnflyApiKey: 'key', cdnflyApiSecret: 'secret', cdnflyUserPackageId: 'pkg' };
  const east = new CdnflyClient({ ...base, cdnflyBaseUrl: 'https://east.example/api', cdnflyAccountId: 1 }, fetchImpl, cache);
  const global = new CdnflyClient({ ...base, cdnflyBaseUrl: 'https://global.example/api', cdnflyAccountId: 2 }, fetchImpl, cache);
  assert.notDeepEqual(await east.request('GET', '/v1/sites'), await global.request('GET', '/v1/sites'));
  assert.equal(calls.length, 2);
  await east.request('POST', '/v1/jobs', {});
  await assert.rejects(east.request('POST', '/v1/jobs', {}), error => error instanceof CdnflyError && error.status === 429);
  await global.request('POST', '/v1/jobs', {});
});
