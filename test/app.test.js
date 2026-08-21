import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp, appInternals } from '../src/app.js';

async function fixture(overrides = {}) {
  const db = createDatabase();
  const addUser = db.prepare('INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, ?, ?)');
  const admin = Number(addUser.run('admin', hashPassword('admin-password'), 'admin', 0).lastInsertRowid);
  const alice = Number(addUser.run('alice', hashPassword('alice-password'), 'user', 2).lastInsertRowid);
  const bob = Number(addUser.run('bob', hashPassword('bobby-password'), 'user', 2).lastInsertRowid);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state) VALUES (?, 'up-a', 'a.example.com', '192.0.2.1', 'active')`).run(alice);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state) VALUES (?, 'up-b', 'b.example.com', '192.0.2.2', 'active')`).run(bob);
  const calls = [];
  const cdnfly = {
    calls,
    createSite: async input => { calls.push(['create', input]); return { id: 'new-upstream' }; },
    getSite: async id => { calls.push(['get', id]); return { id }; },
    updateSite: async (id, input) => { calls.push(['update', id, input]); },
    deleteSite: async id => { calls.push(['delete', id]); },
    health: async () => true,
  };
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 9, ...overrides };
  const server = http.createServer(createApp({ db, cdnfly, config }));
  return { db, cdnfly, server, ids: { admin, alice, bob } };
}

async function start(instance) {
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  return `http://127.0.0.1:${port}`;
}

async function login(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('上游当前探测全部正常时不会因历史健康快照标记为降级', () => {
  const active = [{ id: 1, lastHealthStatus: 'healthy', lastCheckedAt: new Date().toISOString() }];
  const result = appInternals.summarizeUpstreamHealth(active, [{ ok: true, checkedAt: new Date().toISOString() }]);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
});

test('最近正常的上游在前两次瞬时探测失败时继续显示可用', () => {
  const active = [{ id: 1, lastHealthStatus: 'healthy', lastCheckedAt: new Date().toISOString() }];
  const result = appInternals.summarizeUpstreamHealth(active, [{
    ok: false, degraded: true, transient: true, lastKnownHealthy: true, checkedAt: new Date().toISOString(),
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
  assert.equal(result.stale, true);
});

async function request(base, path, cookie, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { cookie, 'content-type': 'application/json', ...(options.headers || {}) } });
}

test('用户列表只返回自己的站点', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/sites', cookie);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.sites.map(site => site.domain), ['a.example.com']);
});

test('用户服务状态返回真实汇总且不泄露上游错误详情', async t => {
  const f = await fixture(); f.cdnfly.health = async () => { throw new Error('secret upstream credential leaked'); };
  t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password'); const response = await request(base, '/api/service-status', cookie);
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.ok, false); assert.equal(result.services.cdn.ok, false); assert.equal(result.services.billing.ok, false);
  assert.equal(JSON.stringify(result).includes('secret upstream credential leaked'), false);
});

test('用户无法读取、更新或删除他人的站点，且不会调用上游', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  for (const [method, body] of [['GET'], ['PUT', { enabled: false }], ['DELETE']]) {
    const response = await request(base, '/api/sites/2', cookie, { method, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(f.cdnfly.calls, []);
});

test('普通用户无法访问用户管理接口', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  assert.equal((await request(base, '/api/admin/users', cookie)).status, 403);
  assert.equal((await request(base, '/api/admin/users', cookie, { method: 'POST', body: JSON.stringify({ username: 'eve', password: 'password-long', siteLimit: 10 }) })).status, 403);
});

test('创建站点受本地额度限制', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  f.db.prepare('UPDATE users SET site_limit = 1 WHERE username = ?').run('alice');
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/sites', cookie, { method: 'POST', body: JSON.stringify({ domain: 'new.example.com', origin: '192.0.2.9' }) });
  assert.equal(response.status, 409);
  assert.deepEqual(f.cdnfly.calls, []);
});

test('管理员普通站点接口同样不能跨用户操作', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'admin', 'admin-password');
  const response = await request(base, '/api/sites/1', cookie);
  assert.equal(response.status, 404);
  assert.deepEqual(f.cdnfly.calls, []);
});

test('平台管理员没有站点额度旁路', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'admin', 'admin-password');
  const response = await request(base, '/api/sites', cookie, { method: 'POST', body: JSON.stringify({ domain: 'admin.example.com', origin: '192.0.2.20' }) });
  assert.equal(response.status, 409);
  assert.deepEqual(f.cdnfly.calls, []);
});

test('管理员健康检查分别报告 PostgreSQL、Redis 和 CDNFly 状态', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'admin', 'admin-password');
  const response = await request(base, '/api/admin/health', cookie);
  assert.equal(response.status, 207);
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.packageId, 9);
  assert.deepEqual(result.services.postgres, { ok: true, error: null });
  assert.deepEqual(result.services.redis, { ok: false, degraded: true, error: '未配置' });
  assert.deepEqual(result.services.cdnfly, { ok: true, error: null });
  assert.deepEqual(result.services.email, { ok: true, skipped: true, required: false, configured: false, error: '邮箱验证未启用' });
  assert.ok(result.checkedAt);
});

test('启用邮箱验证但邮件服务不可用时系统状态明确报告异常', async t => {
  const f = await fixture({ emailVerificationEnabled: true }); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'admin', 'admin-password');
  const result = await (await request(base, '/api/admin/health', cookie)).json();
  assert.deepEqual(result.services.email, { ok: false, required: true, configured: false, error: '邮箱验证已启用，但邮件服务不可用' });
});

test('接受实际访问 Host，拒绝跨站请求来源', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const accepted = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'alice', password: 'alice-password' }),
  });
  assert.equal(accepted.status, 200);
  const rejected = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ username: 'alice', password: 'alice-password' }),
  });
  assert.equal(rejected.status, 403);
});
