import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/app.js';
import { tenantProxyInternals } from '../src/tenant-proxy.js';

async function fixture() {
  const db = createDatabase();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, ?, ?)');
  const alice = Number(add.run('alice', hashPassword('alice-password'), 'user', 5).lastInsertRowid);
  const bob = Number(add.run('bob', hashPassword('bobby-password'), 'user', 5).lastInsertRowid);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state) VALUES (?, 'site-a', 'a.example.com', '192.0.2.1', 'active')`).run(alice);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state) VALUES (?, 'site-b', 'b.example.com', '192.0.2.2', 'active')`).run(bob);
  const streamAlice = await tenantProxyInternals.saveResource(db, 'streams', 'stream-a', alice);
  const streamBob = await tenantProxyInternals.saveResource(db, 'streams', 'stream-b', bob);
  db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, ?)').run(streamAlice, 8443);
  db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, ?)').run(streamBob, 9443);
  const calls = [];
  const cdnfly = {
    packageId: 88,
    calls,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.startsWith('/v1/monitor/site/access-log?')) return { count: 2, data: [
        { id: 'doc-a', host: 'a.example.com', status: 200 }, { id: 'doc-b', host: 'b.example.com', status: 403 },
      ] };
      if (path === '/v1/monitor/site/access-log/doc-a') return { request_body: 'alice' };
      if (path.startsWith('/v1/monitor/site/blackip?')) return { count: 2, data: [
        { id: 1, site_id: 'site-a', ip: '198.51.100.1' }, { id: 2, site_id: 'site-b', ip: '198.51.100.2' },
      ] };
      if (path.startsWith('/v1/monitor/site/top?')) return [{ res: '198.51.100.1', count: 2, traffic: 10, up_recv: 1 }];
      if (path.startsWith('/v1/monitor/site/realtime?')) return [['2026-08-21 10:00:00', 10], ['2026-08-21 10:05:00', 20]];
      if (path.startsWith('/v1/monitor/stream/top')) return [{ port: 8443, traffic: 10 }, { res: 9443, traffic: 20 }];
      if (path.startsWith('/v1/monitor/stream/realtime')) return [{ port: 8443, time: '00:00', value: 1 }, { port: 9443, time: '00:00', value: 2 }];
      if (path === '/v1/streams?limit=0') return { items: [
        { id: 'stream-a', listen: [{ port: 8443 }] }, { id: 'stream-b', listen: [{ port: 9443 }] },
      ] };
      if (path.startsWith('/v1/monitor/usage?')) return [{ date: '2026-01-01', value: path.includes('bandwidth') ? 5 : 10 }];
      if (method === 'POST' && path === '/v1/jobs') return ['900'];
      if (method === 'GET' && path.startsWith('/v1/jobs')) return { count: 2, items: [{ id: 900, type: 'clean_url' }, { id: 901, type: 'clean_url' }] };
      return {};
    },
    download: async path => { calls.push({ method: 'DOWNLOAD', path }); return { buffer: Buffer.from(path), contentType: 'text/plain', disposition: 'attachment' }; },
    createSite: async () => ({ id: 'new' }), getSite: async () => ({}), updateSite: async () => true,
    deleteSite: async () => true, health: async () => true,
  };
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 88 };
  const server = http.createServer(createApp({ db, cdnfly, config }));
  return { db, server, cdnfly, ids: { alice, bob, streamAlice, streamBob } };
}

async function start(f) {
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${f.server.address().port}`;
}

async function login(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return response.headers.get('set-cookie').split(';')[0];
}

function request(base, path, cookie, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('访问日志按当前租户域名过滤，详情需要列表授权', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const denied = await request(base, '/api/cdnfly/v1/monitor/site/access-log/doc-b', cookie);
  assert.equal(denied.status, 404);
  const list = await request(base, '/api/cdnfly/v1/monitor/site/access-log?site_id=1', cookie);
  const data = (await list.json()).data;
  assert.equal(data.count, 1);
  assert.deepEqual(data.data.map(item => item.id), ['doc-a']);
  assert.match(f.cdnfly.calls.at(-1).path, /limit=100/);
  assert.match(f.cdnfly.calls.at(-1).path, /page=1/);
  const detail = await request(base, '/api/cdnfly/v1/monitor/site/access-log/doc-a', cookie);
  assert.equal(detail.status, 200);
});

test('控制台趋势通过实时接口聚合当前租户网站', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  f.db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state) VALUES (?, 'site-a2', 'a2.example.com', '192.0.2.3', 'active')`).run(f.ids.alice);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/monitor/site/overview?type=traffic&start=2026-08-21%2000%3A00%3A00&end=2026-08-21%2012%3A00%3A00', cookie);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [['2026-08-21 10:00:00', 10], ['2026-08-21 10:05:00', 20]]);
  const upstreamPath = f.cdnfly.calls.at(-1).path;
  assert.match(upstreamPath, /\/v1\/monitor\/site\/realtime\?/);
  assert.match(decodeURIComponent(upstreamPath), /domain=a\.example\.com\+a2\.example\.com|domain=a\.example\.com a2\.example\.com/);
  assert.doesNotMatch(upstreamPath, /b\.example\.com/);
});

test('访问日志下载只接受当前租户登记的本地任务 ID', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const aliceJob = await tenantProxyInternals.saveResource(f.db, 'jobs', 'download-alice', f.ids.alice);
  const bobJob = await tenantProxyInternals.saveResource(f.db, 'jobs', 'download-bob', f.ids.bob);
  const cookie = await login(base, 'alice', 'alice-password');
  const deniedBefore = f.cdnfly.calls.length;
  assert.equal((await request(base, `/api/cdnfly/v1/monitor/site/download-access-log/${bobJob}`, cookie)).status, 404);
  assert.equal(f.cdnfly.calls.length, deniedBefore);
  const response = await request(base, `/api/cdnfly/v1/monitor/site/download-access-log/${aliceJob}`, cookie);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '/v1/monitor/site/download-access-log/download-alice');
  assert.deepEqual(f.cdnfly.calls.at(-1), { method: 'DOWNLOAD', path: '/v1/monitor/site/download-access-log/download-alice' });
});

test('上游不提供攻击日志时返回 501 而不是连接异常', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const original = f.cdnfly.request;
  f.cdnfly.request = async (method, path, body) => {
    if (path.startsWith('/v1/monitor/site/attack-log?')) throw Object.assign(new Error('CDNFly HTTP 404'), { status: 502, upstreamStatus: 404 });
    return original(method, path, body);
  };
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/monitor/site/attack-log?domain=a.example.com&start=2026-08-19%2010%3A00%3A00&end=2026-08-19%2011%3A00%3A00', cookie);
  assert.equal(response.status, 501);
  assert.match((await response.json()).error, /未提供攻击日志/);
});

test('IP 黑名单使用本地网站 ID并过滤其他租户记录', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/monitor/site/blackip?site_id=1', cookie);
  const data = (await response.json()).data;
  assert.equal(data.count, 1);
  assert.deepEqual(data.data.map(item => item.site_id), [1]);
  assert.match(f.cdnfly.calls.at(-1).path, /site_id=site-a/);
});

test('资源排行使用官方维度并把本地网站 ID 转换为租户域名', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/monitor/site/top?site_id=1&type=top-ip&recent_time=10m', cookie);
  assert.equal(response.status, 200);
  const path = f.cdnfly.calls.at(-1).path;
  assert.match(path, /type=top-ip/);
  assert.match(path, /domain=a\.example\.com/);
  assert.match(path, /recent_time=10m/);
  assert.doesNotMatch(path, /site_id=/);

  const before = f.cdnfly.calls.length;
  const invalid = await request(base, '/api/cdnfly/v1/monitor/site/top?site_id=1&type=traffic&recent_time=10m', cookie);
  assert.equal(invalid.status, 400);
  assert.equal(f.cdnfly.calls.length, before);

  const overRange = await request(base, '/api/cdnfly/v1/monitor/site/top?site_id=1&type=top-ip&start=2026-08-19%2010%3A00%3A00&end=2026-08-19%2011%3A01%3A00', cookie);
  assert.equal(overRange.status, 400);
  assert.match((await overRange.json()).error, /不能超过 1 小时/);
});

test('四层监控只能查询当前租户监听端口', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const before = f.cdnfly.calls.length;
  const denied = await request(base, '/api/cdnfly/v1/monitor/stream/realtime?type=traffic&start=x&end=y&port=9443', cookie);
  assert.equal(denied.status, 403);
  assert.equal(f.cdnfly.calls.length, before);
  const topDenied = await request(base, '/api/cdnfly/v1/monitor/stream/top?recent_time=10&port=9443', cookie);
  assert.equal(topDenied.status, 403);
  assert.equal(f.cdnfly.calls.length, before);
  const top = await request(base, '/api/cdnfly/v1/monitor/stream/top?recent_time=10', cookie);
  const topBody = await top.json();
  assert.equal(top.status, 200, JSON.stringify(topBody));
  assert.deepEqual(topBody.data.map(item => item.port), [8443]);
  assert.match(f.cdnfly.calls.at(-1).path, /type=top-ports/);
  assert.match(f.cdnfly.calls.at(-1).path, /recent_time=10m/);
  assert.doesNotMatch(f.cdnfly.calls.at(-1).path, /port=|start=|end=/);
  const invalidType = await request(base, '/api/cdnfly/v1/monitor/stream/top?type=top-ip&recent_time=10m', cookie);
  assert.equal(invalidType.status, 400);
});

test('四层监控响应会二次过滤上游返回的未授权端口', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const realtime = await request(base, '/api/cdnfly/v1/monitor/stream/realtime?type=traffic', cookie);
  const realtimeBody = await realtime.json();
  assert.equal(realtime.status, 200, JSON.stringify(realtimeBody));
  assert.equal(realtimeBody.data.length, 1);
  const realtimeCall = f.cdnfly.calls.findLast(call => call.path.startsWith('/v1/monitor/stream/realtime'));
  assert.match(realtimeCall.path, /type=stream-traffic/);
  assert.match(realtimeCall.path, /port=/);
});

test('四层实时监控不返回无法按端口归属的共享上游聚合结果', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const original = f.cdnfly.request;
  f.cdnfly.request = async (method, path, body) => path.startsWith('/v1/monitor/stream/realtime')
    ? [{ time: '00:00', value: 3 }]
    : original(method, path, body);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/monitor/stream/realtime?type=traffic', cookie);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, []);
});

test('四层 access-log 未被上游路由提供时明确返回 404', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password'); const before = f.cdnfly.calls.length;
  const response = await request(base, '/api/cdnfly/v1/monitor/stream/access-log?port=8443&start=2026-08-19%2010%3A00%3A00&end=2026-08-19%2011%3A00%3A00', cookie);
  assert.equal(response.status, 404);
  assert.equal(f.cdnfly.calls.length, before);
});

test('用量查询把本地资源 ID 翻译为当前租户上游 ID', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/monitor/usage?type=traffic&start=2026-01-01&end=2026-01-02&cate=site&res=1', cookie);
  assert.equal(response.status, 200);
  const path = f.cdnfly.calls.at(-1).path;
  assert.match(path, /res=site-a/);
  assert.doesNotMatch(path, /site-b/);
});

test('用量查询拒绝上游不接受的日期格式和倒序范围', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password'); const before = f.cdnfly.calls.length;
  const timestamp = await request(base, '/api/cdnfly/v1/monitor/usage?type=traffic&start=2026-01-01%2010%3A00%3A00&end=2026-01-02&cate=site&res=1', cookie);
  assert.equal(timestamp.status, 400);
  const invalidDay = await request(base, '/api/cdnfly/v1/monitor/usage?type=traffic&start=2026-02-30&end=2026-03-01&cate=site&res=1', cookie);
  assert.equal(invalidDay.status, 400);
  const reversed = await request(base, '/api/cdnfly/v1/monitor/usage-count?start=2026-03-02&end=2026-03-01', cookie);
  assert.equal(reversed.status, 400);
  assert.equal(f.cdnfly.calls.length, before);
});

test('平台消息相关兼容接口已完全移除', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password'); const before = f.cdnfly.calls.length;
  assert.equal((await request(base, '/api/cdnfly/v1/messages', cookie)).status, 404);
  assert.equal((await request(base, '/api/cdnfly/v1/messages/read', cookie, 'POST', { id: 701 })).status, 404);
  assert.equal((await request(base, '/api/cdnfly/v1/messages/sub', cookie)).status, 404);
  assert.equal(f.cdnfly.calls.length, before);
});

test('缓存任务仅接受当前租户域名并返回本地任务 ID', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const deniedBefore = f.cdnfly.calls.length;
  const denied = await request(base, '/api/cdnfly/v1/jobs', cookie, 'POST', { type: 'clean_url', data: { url: 'https://b.example.com/file.js' } });
  assert.equal(denied.status, 403);
  assert.equal(f.cdnfly.calls.length, deniedBefore);
  const created = await request(base, '/api/cdnfly/v1/jobs', cookie, 'POST', { type: 'clean_url', data: { url: 'https://a.example.com/file.js' } });
  assert.equal(created.status, 201);
  const localId = (await created.json()).data[0];
  assert.equal(f.db.prepare('SELECT owner_id FROM tenant_resources WHERE id = ?').get(localId).owner_id, f.ids.alice);
  const jobs = await request(base, '/api/cdnfly/v1/jobs', cookie);
  assert.deepEqual((await jobs.json()).data.items.map(item => item.id), [localId]);
});

test('上游节点总流量和备份任务不会暴露给客户账号', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const before = f.cdnfly.calls.length;
  assert.equal((await request(base, '/api/cdnfly/v1/node-traffic?node_id=1', cookie)).status, 403);
  assert.equal((await request(base, '/api/cdnfly/v1/jobs?type=backup', cookie)).status, 403);
  assert.equal(f.cdnfly.calls.length, before);
});
