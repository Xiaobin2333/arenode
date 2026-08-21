import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { dataProxyInternals } from '../src/data-proxy.js';

function fixture() {
  const db = createDatabase();
  const userId = Number(db.prepare("INSERT INTO users (username,password_hash,role) VALUES ('job-user','x','user')").run().lastInsertRowid);
  const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,upstream_id,domain,origin,state)
    VALUES (?, '501', 'tenant.example.com', '1.1.1.1', 'active')`).run(userId).lastInsertRowid);
  return { db, user: { id: userId }, siteId };
}

test('刷新预热任务只保留所属网站的完整 URL', async () => {
  const { db, user } = fixture();
  const job = await dataProxyInternals.prepareJob(db, user, {
    type: 'clean_url',
    data: { url: 'https://tenant.example.com/assets/app.js', site_id: 999, uid: 7, unexpected: true },
  });
  assert.deepEqual(job, { type: 'clean_url', data: { url: 'https://tenant.example.com/assets/app.js' } });
  await assert.rejects(
    dataProxyInternals.prepareJob(db, user, { type: 'pre_cache_url', data: { url: 'https://other.example/app.js' } }),
    error => error.status === 403,
  );
  db.close();
});

test('IP 与访问日志任务生成各自的最小请求体', async () => {
  const { db, user, siteId } = fixture();
  assert.deepEqual(await dataProxyInternals.prepareJob(db, user, {
    type: 'unlock_ip', data: { site_id: siteId, ip: '1.1.1.1', url: 'https://ignored.example' },
  }), { type: 'unlock_ip', data: { site_id: 501, ip: '1.1.1.1' } });
  assert.deepEqual(await dataProxyInternals.prepareJob(db, user, {
    type: 'down_http_access_log',
    data: { host: 'tenant.example.com', start: '2026-08-19 10:00', end: '2026-08-19 11:00', ip: '1.1.1.1' },
  }), {
    type: 'down_http_access_log',
    data: { host: 'tenant.example.com', start: '2026-08-19 10:00', end: '2026-08-19 11:00' },
  });
  db.close();
});

test('未确认字段的取消任务不会伪装为可用接口', async () => {
  const { db, user } = fixture();
  await assert.rejects(
    dataProxyInternals.prepareJob(db, user, { type: 'cancel_task', data: { url: 'https://tenant.example.com/' } }),
    error => error.status === 501,
  );
  db.close();
});
