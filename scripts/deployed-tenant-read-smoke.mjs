import assert from 'node:assert/strict';
import { loadConfig } from 'file:///app/src/config.js';
import { createPostgresDatabase } from 'file:///app/src/db.js';
import { newSessionToken, tokenDigest } from 'file:///app/src/security.js';

const allowedDomain = String(process.env.ARENODE_ACCEPTANCE_DOMAIN || '').trim().toLowerCase();
const allowedStreamId = Number(process.env.ARENODE_ACCEPTANCE_STREAM_ID || 0);
const baseUrl = String(process.env.ARENODE_ACCEPTANCE_BASE_URL || 'http://127.0.0.1:3080').replace(/\/$/, '');
if (!allowedDomain) throw new Error('需要 ARENODE_ACCEPTANCE_DOMAIN');
const config = loadConfig();
const db = await createPostgresDatabase(config.databaseUrl);
const token = newSessionToken();
const digest = tokenDigest(token);

function domains(value) {
  return String(value || '').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
}

function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['items', 'data', 'list', 'rows', 'result']) {
    const size = collectionSize(value[key]);
    if (size !== null) return size;
  }
  return null;
}

try {
  const site = await db.prepare(`SELECT s.*,u.role FROM sites s JOIN users u ON u.id=s.owner_id
    WHERE lower(s.domain)=? ORDER BY s.id`).get(allowedDomain);
  assert.ok(site, `未找到 ${allowedDomain}`);
  assert.equal(site.role, 'user');
  const ownerSites = await db.prepare('SELECT id,domain FROM sites WHERE owner_id=? ORDER BY id').all(site.owner_id);
  assert.equal(ownerSites.length, 1, '部署验收账号必须只有一个站点');
  assert.deepEqual(domains(ownerSites[0].domain), [allowedDomain]);
  await db.prepare(`INSERT INTO sessions (token_hash,user_id,expires_at,ip,user_agent)
    VALUES (?,?,CURRENT_TIMESTAMP + INTERVAL '5 minutes',?,?)`).run(digest, site.owner_id, '127.0.0.1', 'Arenode deployment smoke');

  const end = new Date(); const start = new Date(end.getTime() - 24 * 60 * 60_000);
  const hourStart = new Date(end.getTime() - 60 * 60_000);
  const localTime = value => value.toISOString().slice(0, 19).replace('T', ' ');
  const range = `start=${encodeURIComponent(localTime(start))}&end=${encodeURIComponent(localTime(end))}`;
  const hourRange = `start=${encodeURIComponent(localTime(hourStart))}&end=${encodeURIComponent(localTime(end))}`;
  const paths = [
    '/api/me', '/api/sites', '/api/cdnfly/v1/sites', `/api/cdnfly/v1/sites/${site.id}`, '/api/cdnfly/v1/capabilities',
    '/api/cdnfly/v1/site-groups', '/api/cdnfly/v1/certs', '/api/cdnfly/v1/dnsapis', '/api/cdnfly/v1/acls',
    '/api/cdnfly/v1/cc-filters', '/api/cdnfly/v1/cc-matchs', '/api/cdnfly/v1/cc-rules',
    '/api/cdnfly/v1/streams', '/api/cdnfly/v1/stream-groups', '/api/cdnfly/v1/domains', '/api/cdnfly/v1/jobs',
    '/api/cdnfly/v1/configs', '/api/cdnfly/v1/site-sys-config', '/api/cdnfly/v1/user', '/api/cdnfly/v1/user-overview',
    '/api/cdnfly/v1/user-configs', '/api/cdnfly/v1/api-key', '/api/cdnfly/v1/common-menu', '/api/cdnfly/v1/common-menu-2',
    '/api/cdnfly/v1/common-package-purchase-notice', '/api/cdnfly/v1/user-certify', '/api/cdnfly/v1/package-groups',
    '/api/cdnfly/v1/packages', '/api/cdnfly/v1/package-ups', '/api/cdnfly/v1/traffic-packages',
    '/api/cdnfly/v1/user-packages', '/api/cdnfly/v1/user-traffic-packages', '/api/cdnfly/v1/orders', '/api/cdnfly/v1/order-count',
    `/api/cdnfly/v1/monitor/site/overview?type=traffic&${range}`,
    `/api/cdnfly/v1/monitor/site/realtime?site_id=${site.id}&type=traffic&${range}`,
    `/api/cdnfly/v1/monitor/site/access-log?site_id=${site.id}&limit=100&page=1&${range}`,
    `/api/cdnfly/v1/monitor/site/top?site_id=${site.id}&type=top-domain&${hourRange}`,
    `/api/cdnfly/v1/monitor/site/blackip?site_id=${site.id}`,
    `/api/cdnfly/v1/monitor/site/history-blackip?site_id=${site.id}&${hourRange}`,
    '/api/cdnfly/v1/monitor/site/blackip-count',
    `/api/cdnfly/v1/monitor/usage?cate=site&res=${site.id}&type=traffic&start=2026-08-20&end=2026-08-21`,
    '/api/cdnfly/v1/monitor/usage-count?start=2026-08-20&end=2026-08-21',
    '/api/cdnfly/v1/log/op', '/api/cdnfly/v1/log/login', '/api/service-status',
  ];
  const checks = {};
  let accessItems = [];
  let siteDetail = null;
  let certificateItems = [];
  let streamItems = [];
  let capabilities = {};
  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { 'access-token': token, accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    checks[path.split('?')[0]] = { status: response.status, count: collectionSize(body.data ?? body) };
    assert.ok(response.ok, `${path}: ${response.status} ${body.error || ''}`);
    if (path.includes('/monitor/site/access-log?')) accessItems = Array.isArray(body.data) ? body.data : body.data?.items || body.data?.data || [];
    if (path === `/api/cdnfly/v1/sites/${site.id}`) siteDetail = body.data || {};
    if (path === '/api/cdnfly/v1/certs') certificateItems = Array.isArray(body.data) ? body.data : body.data?.items || [];
    if (path === '/api/cdnfly/v1/streams') streamItems = Array.isArray(body.data) ? body.data : body.data?.items || [];
    if (path === '/api/cdnfly/v1/capabilities') capabilities = body.data || {};
  }
  assert.equal(streamItems.length, 1, '部署验收账号必须只有一个测试转发');
  if (allowedStreamId) assert.equal(Number(streamItems[0].id), allowedStreamId, '测试转发本地 ID 已变化');
  const streamDetailPath = `/api/cdnfly/v1/streams/${streamItems[0].id}`;
  const streamDetailResponse = await fetch(`${baseUrl}${streamDetailPath}`, { headers: { 'access-token': token, accept: 'application/json' } });
  const streamDetailBody = await streamDetailResponse.json().catch(() => ({}));
  assert.ok(streamDetailResponse.ok, `${streamDetailPath}: ${streamDetailResponse.status} ${streamDetailBody.error || ''}`);
  const streamDetail = streamDetailBody.data || {};
  const streamPorts = (Array.isArray(streamDetail.listen) ? streamDetail.listen : []).map(item => Number(item.port)).filter(Number.isInteger);
  assert.equal(streamPorts.length, 1, '测试转发必须只有一个监听端口');
  checks['/api/cdnfly/v1/streams/:id'] = { status: streamDetailResponse.status, count: null };
  for (const path of [
    `/api/cdnfly/v1/monitor/stream/realtime?port=${streamPorts[0]}&type=stream-traffic&${hourRange}`,
    '/api/cdnfly/v1/monitor/stream/top?type=top-ports&recent_time=60m',
    ...(capabilities.wafRules === false ? [] : ['/api/cdnfly/v1/waf-rules', `/api/cdnfly/v1/sites/${site.id}/waf-rules`]),
    ...(capabilities.attackLogs === false ? [] : [
      `/api/cdnfly/v1/monitor/site/attack-log?domain=${encodeURIComponent(allowedDomain)}&${hourRange}`,
      `/api/cdnfly/v1/monitor/site/attack-log/stats?site_id=${site.id}&${hourRange}`,
    ]),
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { 'access-token': token, accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    checks[path.split('?')[0]] = { status: response.status, count: collectionSize(body.data ?? body) };
    assert.ok(response.ok, `${path}: ${response.status} ${body.error || ''}`);
  }
  const cnameResponse = await fetch(`${baseUrl}/api/cdnfly/v1/cname-check`, {
    method: 'POST', headers: { 'access-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ domain: allowedDomain }),
  });
  const cnameBody = await cnameResponse.json().catch(() => ({}));
  assert.ok(cnameResponse.ok, `CNAME 检查: ${cnameResponse.status} ${cnameBody.error || ''}`);
  checks['/api/cdnfly/v1/cname-check'] = { status: cnameResponse.status, count: null };
  assert.ok(accessItems.length > 0, '访问日志没有返回可验证记录');
  const access = accessItems[0];
  assert.equal(String(access.host || access.host2 || '').toLowerCase(), allowedDomain);
  const accessFields = Object.keys(access).sort();
  for (const field of ['timestamp', 'host', 'server_port', 'protocol', 'method', 'req_uri', 'status', 'addr', 'tls_fp', 'country', 'province', 'city', 'isp', 'sip', 'content_type', 'referer', 'user_agent', 'up_resp_time', 'bytes_sent', 'cache_status']) {
    assert.ok(accessFields.includes(field), `访问日志缺少 ${field}`);
  }
  const documentId = access.id ?? access._id ?? access.document_id;
  assert.ok(documentId !== undefined && documentId !== null, '访问日志缺少详情 ID');
  const detailResponse = await fetch(`${baseUrl}/api/cdnfly/v1/monitor/site/access-log/${encodeURIComponent(documentId)}`, { headers: { 'access-token': token } });
  const detailBody = await detailResponse.json().catch(() => ({}));
  assert.ok(detailResponse.ok, `访问日志详情: ${detailResponse.status} ${detailBody.error || ''}`);
  checks['/api/cdnfly/v1/monitor/site/access-log/:id'] = { status: detailResponse.status, fields: Object.keys(detailBody.data || {}).sort() };
  const listed = await fetch(`${baseUrl}/api/sites`, { headers: { 'access-token': token } }).then(response => response.json());
  assert.deepEqual((listed.sites || []).flatMap(item => domains(item.domain)), [allowedDomain]);
  const certificateDetails = await Promise.all(certificateItems.map(async item => {
    const response = await fetch(`${baseUrl}/api/cdnfly/v1/certs/${item.id}`, { headers: { 'access-token': token } });
    const body = await response.json().catch(() => ({}));
    assert.ok(response.ok, `证书详情 ${item.id}: ${response.status} ${body.error || ''}`);
    return body.data || {};
  }));
  const https = siteDetail?.https_listen || {};
  const resourceSnapshot = {
    https: Object.fromEntries(['ok', 'enable', 'port', 'cert', 'ssl_protocols', 'ssl_ciphers'].filter(key => https[key] !== undefined).map(key => [key, https[key]])),
    certificates: certificateDetails.map((detail, index) => {
      const item = { ...certificateItems[index], ...detail };
      return Object.fromEntries(['id', 'name', 'domain', 'type', 'status', 'state', 'issue_state', 'sync_state', 'task_enable', 'create_at2', 'start_time', 'expire_time2', 'expire_time', 'enable', 'auto_renew'].filter(key => item[key] !== undefined).map(key => [key, item[key]]));
    }),
    streams: [streamDetail].map(item => Object.fromEntries(['id', 'des', 'listen', 'backend', 'backend_port', 'balance_way', 'enable'].filter(key => item[key] !== undefined).map(key => [key, item[key]]))),
  };
  console.log(JSON.stringify({ allowedDomain, localSiteId: site.id, resourceSnapshot, accessFields, checks }, null, 2));
} finally {
  await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest).catch(() => {});
  await db.close();
}
