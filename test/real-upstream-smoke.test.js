import test from 'node:test';
import assert from 'node:assert/strict';

// This test is opt-in. It deliberately refuses to run unless the operator
// supplies the running reseller URL and a dedicated test account.
const enabled = String(process.env.RUN_REAL_CDNFLY_TESTS || '').toLowerCase() === '1';
const writeEnabled = enabled && String(process.env.RUN_REAL_CDNFLY_WRITE_TESTS || '').toLowerCase() === '1';
const base = process.env.REAL_TEST_BASE_URL || '';
const username = process.env.REAL_TEST_USERNAME || '';
const password = process.env.REAL_TEST_PASSWORD || '';
const configuredSessionCookie = process.env.REAL_TEST_SESSION_COOKIE || '';
const skipStreamChecks = String(process.env.REAL_TEST_SKIP_STREAMS || '').toLowerCase() === '1';
const allowedDomain = String(process.env.REAL_TEST_DOMAIN || '').trim().toLowerCase();
const allowedCname = String(process.env.REAL_TEST_EXPECTED_CNAME || '').trim().toLowerCase();
const allowedPackageId = String(process.env.REAL_TEST_UPSTREAM_PACKAGE_ID || '').trim();
const allowedStreamId = Number(process.env.REAL_TEST_STREAM_ID || 0);
const allowedStreamOrigin = String(process.env.REAL_TEST_STREAM_ORIGIN || '').trim();
const allowedStreamBackendPort = Number(process.env.REAL_TEST_STREAM_BACKEND_PORT || 0);
const allowedStreamPort = Number(process.env.REAL_TEST_STREAM_PORT || 0);

function assertSafeDomain(value) {
  const domains = String(value || '').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
  assert.deepEqual(domains, [allowedDomain], `真实烟测只允许 ${allowedDomain}`);
}

function streamPorts(item) {
  return (Array.isArray(item?.listen) ? item.listen : []).map(entry => Number(entry?.port)).filter(Number.isInteger);
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${options.method || 'GET'} ${path}: ${response.status} ${data.error || ''}`);
  return data;
}

async function safeWrite(path, body, sessionCookie) {
  assert.ok(writeEnabled, '写操作烟测必须显式设置 RUN_REAL_CDNFLY_WRITE_TESTS=1');
  return request(path, { method: 'PUT', body: JSON.stringify(body), headers: { cookie: sessionCookie } });
}

test('真实上游安全烟测：仅检查指定域名、源站和四层端口', { skip: !enabled }, async () => {
  assert.ok(base, '需要 REAL_TEST_BASE_URL');
  assert.ok(allowedDomain, '需要 REAL_TEST_DOMAIN');
  assert.ok(allowedCname, '需要 REAL_TEST_EXPECTED_CNAME');
  assert.equal(writeEnabled && skipStreamChecks, false, '真实写测不能跳过四层资源边界检查');
  if (!skipStreamChecks) {
    assert.ok(Number.isInteger(allowedStreamId) && allowedStreamId > 0, '需要 REAL_TEST_STREAM_ID');
    assert.ok(Number.isInteger(allowedStreamPort) && allowedStreamPort > 0, '需要 REAL_TEST_STREAM_PORT');
    assert.ok(allowedStreamOrigin, '需要 REAL_TEST_STREAM_ORIGIN');
    assert.ok(Number.isInteger(allowedStreamBackendPort) && allowedStreamBackendPort > 0, '需要 REAL_TEST_STREAM_BACKEND_PORT');
  }
  if (writeEnabled) assert.ok(allowedPackageId, '写测需要 REAL_TEST_UPSTREAM_PACKAGE_ID');
  let sessionCookie = configuredSessionCookie;
  if (!sessionCookie) {
    assert.ok(username && password, '需要 REAL_TEST_USERNAME、REAL_TEST_PASSWORD 或一次性 REAL_TEST_SESSION_COOKIE');
    const loginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const loginData = await loginResponse.json().catch(() => ({}));
    assert.ok(loginResponse.ok, `登录失败: ${loginResponse.status} ${loginData.error || ''}`);
    sessionCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  }
  assert.ok(sessionCookie, '登录响应未返回会话 Cookie');
  const authed = path => request(path, { headers: { cookie: sessionCookie } });

  const me = await authed('/api/me');
  const subscriptions = me.billing?.subscriptions || [];
  assert.ok(subscriptions.length > 0, '真实烟测账号必须有生效套餐实例');
  if (allowedPackageId) {
    assert.equal(subscriptions.every(item => String(item.plan?.upstreamPackageId || '') === allowedPackageId), true,
      `真实烟测的全部生效套餐必须绑定上游套餐 ${allowedPackageId}`);
  }

  const sites = (await authed('/api/sites')).sites || [];
  assert.equal(sites.length, 1, '真实烟测账号必须只有一个测试站点');
  const site = sites[0]; assertSafeDomain(site.domain);
  const siteOrigin = String(site.origin || '').trim();
  assert.ok(siteOrigin, '测试站点必须返回当前源站，写测只会原样保留该值');
  assert.equal(String(site.cname || '').toLowerCase(), allowedCname, '网站列表必须返回完整 CNAME');
  const compatSites = (await authed('/api/cdnfly/v1/sites')).data?.items || [];
  assert.equal(compatSites.length, 1, '兼容层网站列表必须只有测试站点');
  assertSafeDomain(compatSites[0].domain); assert.equal(compatSites[0].backend?.[0]?.addr, siteOrigin);
  assert.equal(String(compatSites[0].cname || '').toLowerCase(), allowedCname, '兼容层网站列表必须返回完整 CNAME');
  const detail = await authed(`/api/sites/${site.id}`); assertSafeDomain(detail.site?.domain || site.domain); assert.equal(detail.site?.origin || site.origin, siteOrigin);
  assert.equal(String(detail.site?.cname || site.cname || '').toLowerCase(), allowedCname, '测试站点 CNAME 必须返回上游完整目标');
  const capabilities = (await authed('/api/cdnfly/v1/capabilities')).data || {};

  let streams = []; let target = [];
  if (!skipStreamChecks) {
    const listedStreams = (await authed('/api/cdnfly/v1/streams')).data?.items || [];
    streams = await Promise.all(listedStreams.map(async item => streamPorts(item).length
      ? item
      : (await authed(`/api/cdnfly/v1/streams/${item.id}`)).data));
    target = streams.filter(item => Number(item.id) === allowedStreamId);
    assert.deepEqual(streams.map(item => Number(item.id)), [allowedStreamId], `真实烟测账号只能包含本地转发 #${allowedStreamId}`);
    for (const item of streams) {
      assert.deepEqual(streamPorts(item), [allowedStreamPort], `发现非 ${allowedStreamPort} 四层资源，已停止烟测`);
      const backend = item.backend?.[0]?.addr;
      if (backend !== undefined) assert.equal(backend, allowedStreamOrigin, `四层源站必须为 ${allowedStreamOrigin}`);
      const backendPort = Number(item.backend?.[0]?.port ?? item.backend_port);
      if (Number.isInteger(backendPort)) assert.equal(backendPort, allowedStreamBackendPort, `四层源站端口必须为 ${allowedStreamBackendPort}`);
    }
  }
  // Read-only resource and monitoring checks. Mutating operations are kept
  // out of the default smoke test and require a separately reviewed run.
  const resourcePaths = [
    '/site-groups', '/certs', '/dnsapis', '/cc-filters', '/cc-matchs', '/cc-rules', '/stream-groups', '/domains', '/jobs', '/configs', '/site-sys-config',
    '/user', '/user-overview', '/user-configs', '/api-key', '/common-menu', '/common-menu-2',
    '/common-package-purchase-notice', '/user-certify', '/package-groups', '/packages', '/package-ups', '/traffic-packages',
    '/user-packages', '/user-traffic-packages', '/orders', '/order-count',
  ];
  if (capabilities.wafRules !== false) resourcePaths.push('/waf-rules', `/sites/${site.id}/waf-rules`);
  for (const path of resourcePaths) {
    await authed(`/api/cdnfly/v1${path}`);
  }
  const monitorEnd = new Date(); const monitorStart = new Date(monitorEnd.getTime() - 60 * 60_000);
  const monitorTime = value => value.toISOString().slice(0, 19).replace('T', ' ');
  const monitorRange = `start=${encodeURIComponent(monitorTime(monitorStart))}&end=${encodeURIComponent(monitorTime(monitorEnd))}`;
  for (const path of [
    `/monitor/site/access-log?domain=${encodeURIComponent(allowedDomain)}&${monitorRange}`,
    `/monitor/site/realtime?site_id=${site.id}&type=traffic&${monitorRange}`,
    `/monitor/site/top?site_id=${site.id}&type=top-ip&${monitorRange}`,
    `/monitor/site/blackip?site_id=${site.id}`,
    `/monitor/site/history-blackip?site_id=${site.id}&${monitorRange}`,
    `/monitor/site/blackip-count`,
    `/monitor/usage?cate=site&res=${site.id}&type=traffic&start=2026-01-01&end=2026-01-02`,
    `/monitor/usage-count?start=2026-01-01&end=2026-01-02`,
    '/log/login', '/log/op',
  ]) await authed(`/api/cdnfly/v1${path}`);
  if (capabilities.attackLogs !== false) {
    await authed(`/api/cdnfly/v1/monitor/site/attack-log?domain=${encodeURIComponent(allowedDomain)}&${monitorRange}`);
    await authed(`/api/cdnfly/v1/monitor/site/attack-log/stats?site_id=${site.id}&${monitorRange}`);
  }
  if (target[0]) {
    const streamDetail = await authed(`/api/cdnfly/v1/streams/${target[0].id}`);
    assert.deepEqual(streamPorts(streamDetail.data), [allowedStreamPort], `四层详情必须只有 ${allowedStreamPort}`);
    const detailBackend = streamDetail.data?.backend?.[0]?.addr;
    if (detailBackend !== undefined) assert.equal(detailBackend, allowedStreamOrigin, `四层详情源站必须为 ${allowedStreamOrigin}`);
    assert.equal(Number(streamDetail.data?.backend?.[0]?.port ?? streamDetail.data?.backend_port), allowedStreamBackendPort, `四层详情源站端口必须为 ${allowedStreamBackendPort}`);
    await authed(`/api/cdnfly/v1/monitor/stream/realtime?port=${allowedStreamPort}`);
    await authed(`/api/cdnfly/v1/monitor/stream/top?port=${allowedStreamPort}`);
  }

  if (writeEnabled) {
    // Idempotent no-op updates against the already verified test resources.
    // This suite never creates or deletes an upstream resource.
    const siteUpdate = await safeWrite(`/api/cdnfly/v1/sites/${site.id}`, {
      domain: allowedDomain,
      backend: [{ addr: siteOrigin, weight: 1, state: 'up' }],
      backend_protocol: detail.upstream?.backend_protocol || site.backendProtocol || 'http',
      backend_host: detail.upstream?.backend_host || site.backendHost || allowedDomain,
      enable: detail.upstream?.enable ?? (site.enabled ? 1 : 0),
    }, sessionCookie);
    assert.ok(siteUpdate.data !== undefined, '测试网站更新未返回响应数据');
    if (target[0]) {
      const stream = target[0];
      const streamUpdate = await safeWrite(`/api/cdnfly/v1/streams/${stream.id}`, {
        des: stream.des || '测试四层转发',
        listen: [{ port: allowedStreamPort, protocol: String(stream.listen?.[0]?.protocol || 'tcp').toLowerCase() }],
        backend: [{ addr: allowedStreamOrigin, port: allowedStreamBackendPort, weight: 1, state: 'up' }],
        backend_port: allowedStreamBackendPort,
        balance_way: stream.balance_way || 'rr',
        enable: stream.enable === undefined ? 1 : stream.enable,
      }, sessionCookie);
      assert.ok(streamUpdate.data !== undefined, '测试四层转发更新未返回响应数据');
    }
    const cnameCheck = await request('/api/cdnfly/v1/cname-check', {
      method: 'POST', body: JSON.stringify({ domain: allowedDomain }), headers: { cookie: sessionCookie },
    });
    assert.ok(cnameCheck.data !== undefined, 'CNAME 检查未返回响应数据');
    const refreshedSites = (await authed('/api/sites')).sites || [];
    assert.equal(refreshedSites.length, 1, '写测后测试账号网站数量发生变化');
    assertSafeDomain(refreshedSites[0].domain); assert.equal(refreshedSites[0].origin, siteOrigin);
    assert.equal(String(refreshedSites[0].cname || '').toLowerCase(), allowedCname, '写测后 CNAME 未保持完整目标');
    const refreshedStreams = (await authed('/api/cdnfly/v1/streams')).data?.items || [];
    for (const item of refreshedStreams) {
      assert.deepEqual(streamPorts(item), [allowedStreamPort], `写测后发现非 ${allowedStreamPort} 四层资源`);
      if (item.backend?.[0]?.addr !== undefined) assert.equal(item.backend[0].addr, allowedStreamOrigin);
      const backendPort = Number(item.backend?.[0]?.port ?? item.backend_port);
      if (Number.isInteger(backendPort)) assert.equal(backendPort, allowedStreamBackendPort);
    }
  }
});
