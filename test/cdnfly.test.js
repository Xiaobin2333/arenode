import test from 'node:test';
import assert from 'node:assert/strict';
import { CdnflyClient, CdnflyError } from '../src/cdnfly.js';
import { createDatabase } from '../src/db.js';
import { UpstreamService } from '../src/upstreams.js';

const config = {
  cdnflyBaseUrl: 'https://panel.example.com/api',
  cdnflyApiKey: 'key-value',
  cdnflyApiSecret: 'secret-value',
  cdnflyUserPackageId: 88,
  upstreamTimeoutMs: 1000,
};

test('普通用户密钥以正确请求头发送，套餐只能来自服务端配置', async () => {
  let captured;
  const client = new CdnflyClient(config, async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ code: 0, data: '123' }), { status: 200 });
  });
  const result = await client.createSite({
    domain: 'www.example.com', origin: '192.0.2.10', user_package: 999, uid: 7, new_uid: 8,
  });
  assert.deepEqual(result, { id: '123' });
  assert.equal(captured.url, 'https://panel.example.com/api/v1/sites');
  assert.equal(captured.init.headers['api-key'], 'key-value');
  assert.equal(captured.init.headers['api-secret'], 'secret-value');
  assert.equal(captured.body.user_package, 88);
  assert.equal(captured.body.https_listen, undefined);
  assert.equal(captured.body.uid, undefined);
  assert.equal(captured.body.new_uid, undefined);
});

test('HTTP 200 内的 CDNFly 业务错误会被识别', async () => {
  const client = new CdnflyClient(config, async () => new Response(JSON.stringify({ code: 4001, msg: '套餐额度不足' }), { status: 200 }));
  await assert.rejects(() => client.getSite('1'), error => error instanceof CdnflyError && error.message === '套餐额度不足');
});

test('HTTP 200 内的 CDNFly 纯文本权限和参数错误会被识别', async () => {
  for (const message of ['需要管理员权限', '开始时间日期格式不正确', '不支持查询类型']) {
    const client = new CdnflyClient(config, async () => Response.json(message));
    await assert.rejects(() => client.request('GET', '/v1/test'), error => error instanceof CdnflyError
      && error.status === 502 && error.upstreamStatus === 200 && error.message === message);
  }
});

test('上游 JSON 字符串配置会按官方字段恢复为结构化数据', async () => {
  const client = new CdnflyClient(config, async () => Response.json({ code: 0, data: {
    id: 3348,
    listen: '[{"protocol":"tcp","port":"18443"}]',
    backend: '[{"addr":"192.0.2.10","weight":1,"state":"up"}]',
    req_header: '[{"name":"X-Origin-Token","value":"secret"}]',
    resp_header: '[{"name":"X-Cache","value":"$upstream_cache_status"}]',
    url_rewrite: '[{"host":".*","match":"^/old$","redirect":"https://www.example.com/new","code":"301"}]',
    backend_port: '18443',
    des: '[保留为普通文本]',
  } }));
  const result = await client.request('GET', '/v1/streams?limit=0');
  assert.deepEqual(result.listen, [{ protocol: 'tcp', port: '18443' }]);
  assert.deepEqual(result.backend, [{ addr: '192.0.2.10', weight: 1, state: 'up' }]);
  assert.deepEqual(result.req_header, [{ name: 'X-Origin-Token', value: 'secret' }]);
  assert.deepEqual(result.resp_header, [{ name: 'X-Cache', value: '$upstream_cache_status' }]);
  assert.deepEqual(result.url_rewrite, [{ host: '.*', match: '^/old$', redirect: 'https://www.example.com/new', code: '301' }]);
  assert.equal(result.des, '[保留为普通文本]');
});

test('GET 最多尝试三次，PUT 尝试两次，POST 不自动重试', async () => {
  let reads = 0;
  const readClient = new CdnflyClient(config, async () => {
    reads += 1;
    if (reads < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    return Response.json({ code: 0, data: { ok: true } });
  });
  assert.deepEqual(await readClient.request('GET', '/v1/sites'), { ok: true });
  assert.equal(reads, 3);

  let updates = 0;
  const updateClient = new CdnflyClient(config, async () => {
    updates += 1;
    if (updates === 1) return new Response('', { status: 503 });
    return Response.json({ code: 0, data: true });
  });
  assert.equal(await updateClient.request('PUT', '/v1/sites/1', { enable: 0 }), true);
  assert.equal(updates, 2);

  let creates = 0;
  const createClient = new CdnflyClient(config, async () => { creates += 1; throw new Error('reset'); });
  await assert.rejects(() => createClient.request('POST', '/v1/sites', {}), /CDN 服务暂时不可用/);
  assert.equal(creates, 1);
});

test('上游 HTTP 状态会保留用于能力判断但不会直接透传响应状态', async () => {
  const client = new CdnflyClient(config, async () => new Response('Not Found', { status: 404 }));
  await assert.rejects(() => client.request('GET', '/v1/waf-rules'), error => error instanceof CdnflyError && error.status === 502 && error.upstreamStatus === 404);
});

test('上游 HTML 错误页不会作为界面错误正文透传', async () => {
  const client = new CdnflyClient(config, async () => new Response(
    '<!DOCTYPE HTML><title>500 Internal Server Error</title><h1>Internal Server Error</h1>',
    { status: 500, headers: { 'content-type': 'text/html' } },
  ));
  await assert.rejects(
    () => client.request('POST', '/v1/cname-check', { domain: 'www.example.com' }),
    error => error instanceof CdnflyError && error.message === 'CDN 服务暂时不可用，请稍后重试' && error.providerMessage === 'HTTP 500' && !error.message.includes('<'),
  );
});

test('同一上游账号的不同套餐使用独立缓存范围', async () => {
  const cache = {
    values: new Map(),
    async getOrSet(namespace, key, _ttl, loader) {
      const full = `${namespace}:${key}`;
      if (!this.values.has(full)) this.values.set(full, await loader());
      return structuredClone(this.values.get(full));
    },
    async rateLimit() { return { allowed: true }; },
    async invalidate() { this.values.clear(); },
  };
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    return Response.json({ code: 0, data: { packageId: JSON.parse(init.body || '{}').package_id || calls } });
  };
  const first = new CdnflyClient({ ...config, cdnflyAccountId: 7, cdnflyUserPackageId: 'pkg-a' }, fetchImpl, cache);
  const second = new CdnflyClient({ ...config, cdnflyAccountId: 7, cdnflyUserPackageId: 'pkg-b' }, fetchImpl, cache);
  assert.notEqual(first.cacheScope, second.cacheScope);
  await first.request('GET', '/v1/sites');
  await second.request('GET', '/v1/sites');
  assert.equal(calls, 2);
});

test('旧兼容上游客户端按套餐隔离且不会改写共享实例', async () => {
  const db = createDatabase();
  const legacy = { packageId: 'base', cacheScope: 'legacy', request: async () => true };
  const upstreams = new UpstreamService(db, {}, null, { legacyClient: legacy });
  const first = await upstreams.clientForAccount(null, 'pkg-a');
  const second = await upstreams.clientForAccount(null, 'pkg-b');
  assert.notEqual(first, second);
  assert.equal(first.packageId, 'pkg-a');
  assert.equal(second.packageId, 'pkg-b');
  assert.equal(legacy.packageId, 'base');
  assert.notEqual(first.cacheScope, second.cacheScope);
  db.close();
});
