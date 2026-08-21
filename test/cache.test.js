import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheService } from '../src/cache.js';
import { CdnflyClient, CdnflyError } from '../src/cdnfly.js';

class FakeRedis {
  constructor() {
    this.isOpen = false;
    this.values = new Map();
    this.expirations = new Map();
    this.handlers = new Map();
  }

  on(event, handler) { this.handlers.set(event, handler); }
  async connect() { this.isOpen = true; }
  async ping() { if (!this.isOpen) throw new Error('redis unavailable'); return 'PONG'; }
  async get(key) {
    if ((this.expirations.get(key) || Infinity) <= Date.now()) { this.values.delete(key); this.expirations.delete(key); }
    return this.values.get(key) ?? null;
  }
  async set(key, value, options = {}) {
    if (options.NX && await this.get(key) !== null) return null;
    this.values.set(key, value);
    if (options.EX) this.expirations.set(key, Date.now() + Number(options.EX) * 1000);
    return 'OK';
  }
  async incr(key) { const value = Number(await this.get(key) || 0) + 1; this.values.set(key, String(value)); return value; }
  async expire(key, seconds) { this.expirations.set(key, Date.now() + Number(seconds) * 1000); return true; }
  async ttl(key) { return Math.max(0, Math.ceil(((this.expirations.get(key) || Date.now()) - Date.now()) / 1000)); }
  async eval(_script, { keys, arguments: args }) {
    if (await this.get(keys[0]) !== args[0]) return 0;
    this.values.delete(keys[0]); this.expirations.delete(keys[0]); return 1;
  }
  async quit() { this.isOpen = false; }
}

const config = {
  redisUrl: 'redis://test', cdnflyBaseUrl: 'https://panel.example.com/api',
  cdnflyApiKey: 'key', cdnflyApiSecret: 'secret', cdnflyUserPackageId: 1,
  upstreamTimeoutMs: 1000, cdnflyCacheTtlSeconds: 30,
  cdnflyMonitorCacheTtlSeconds: 8, cdnflyRequestsPerMinute: 2,
};

test('GET 缓存合并并发请求，写操作后立即失效', async () => {
  const redis = new FakeRedis();
  const cache = await new CacheService(config, redis).connect();
  let calls = 0;
  const client = new CdnflyClient({ ...config, cdnflyRequestsPerMinute: 10 }, async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ code: 0, data: { call: calls } }), { status: 200 });
  }, cache);

  const [first, second] = await Promise.all([client.request('GET', '/v1/sites'), client.request('GET', '/v1/sites')]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(await client.request('GET', '/v1/sites'), { call: 1 });
  assert.equal(calls, 1);

  await client.request('PUT', '/v1/sites/1', { enable: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(await client.request('GET', '/v1/sites'), { call: 3 });
  assert.equal(calls, 3);
});

test('健康探针按上游账号共享缓存，显式检测可强制实时请求', async () => {
  const cache = await new CacheService(config, new FakeRedis()).connect();
  let calls = 0;
  const client = new CdnflyClient({ ...config, cdnflyRequestsPerMinute: 10 }, async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
  }, cache);
  await Promise.all([client.health(), client.health()]);
  assert.equal(calls, 1);
  await client.health();
  assert.equal(calls, 1);
  await client.health({ fresh: true });
  assert.equal(calls, 2);
});

test('上游请求预算在共享 Redis 中执行固定窗口限流', async () => {
  const cache = await new CacheService(config, new FakeRedis()).connect();
  const client = new CdnflyClient(config, async () => new Response(JSON.stringify({ code: 0, data: true }), { status: 200 }), cache);
  await client.request('POST', '/v1/jobs', {});
  await client.request('POST', '/v1/jobs', {});
  await assert.rejects(client.request('POST', '/v1/jobs', {}), error => error instanceof CdnflyError && error.status === 429);
});

test('验证码冷却和小时计数由 Redis 在服务实例间共享', async () => {
  const redis = new FakeRedis();
  const first = await new CacheService(config, redis).connect();
  const second = await new CacheService(config, redis).connect();
  assert.equal((await first.claimCooldown('verification-email', 'user@example.com', 60)).allowed, true);
  assert.equal((await second.claimCooldown('verification-email', 'user@example.com', 60)).allowed, false);
  assert.equal((await first.rateLimit('verification-ip-hour', '127.0.0.1', 1, 3600)).allowed, true);
  assert.equal((await second.rateLimit('verification-ip-hour', '127.0.0.1', 1, 3600)).allowed, false);
});

test('Redis 不可用时缓存和限流降级到进程内存', async () => {
  const redis = new FakeRedis();
  redis.connect = async () => { throw new Error('connection refused'); };
  const cache = await new CacheService(config, redis).connect();
  assert.equal(cache.connected, false);
  let loads = 0;
  const first = await cache.getOrSet('resource', '/v1/sites', 30, async () => ({ loads: ++loads }));
  const second = await cache.getOrSet('resource', '/v1/sites', 30, async () => ({ loads: ++loads }));
  assert.deepEqual(first, second);
  assert.equal(loads, 1);
  assert.equal((await cache.rateLimit('login', '127.0.0.1', 1, 60)).allowed, true);
  assert.equal((await cache.rateLimit('login', '127.0.0.1', 1, 60)).allowed, false);
  assert.deepEqual(await cache.health(), { ok: false, degraded: true, error: 'connection refused' });
});
