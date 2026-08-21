import assert from 'node:assert/strict';
import { loadConfig } from 'file:///app/src/config.js';
import { createPostgresDatabase } from 'file:///app/src/db.js';
import { CdnflyClient } from 'file:///app/src/cdnfly.js';
import { UpstreamService } from 'file:///app/src/upstreams.js';

if (String(process.env.RUN_REAL_CDNFLY_WRITE_TESTS || '') !== '1') throw new Error('必须显式设置 RUN_REAL_CDNFLY_WRITE_TESTS=1');
const allowedDomain = String(process.env.REAL_TEST_DOMAIN || '').trim().toLowerCase();
if (!allowedDomain) throw new Error('需要 REAL_TEST_DOMAIN');
const config = loadConfig();
const db = await createPostgresDatabase(config.databaseUrl);
const legacy = new CdnflyClient(config, fetch, null);
const upstreams = new UpstreamService(db, config, null, { legacyClient: legacy });

function domainList(value) {
  return String(value || '').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
}

function pick(source, fields) {
  return Object.fromEntries(fields.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
}

try {
  const rows = await db.prepare('SELECT * FROM sites WHERE lower(domain)=? ORDER BY id').all(allowedDomain);
  assert.equal(rows.length, 1, `写入烟测要求本地恰好存在一个 ${allowedDomain} 站点`);
  const site = rows[0];
  assert.deepEqual(domainList(site.domain), [allowedDomain], '写入烟测禁止操作其他域名');
  const client = await upstreams.clientForSite(site);
  const before = await client.request('GET', `/v1/sites/${encodeURIComponent(site.upstream_id)}`);
  assert.deepEqual(domainList(before.domain), [allowedDomain], '上游站点域名不在烟测白名单');

  const group = before.groups === undefined ? {} : { groups: before.groups };
  const sections = {
    basic: { enable: before.enable },
    http: pick(before, ['http_listen']),
    origin: pick(before, ['backend', 'backend_protocol', 'balance_way', 'backend_http_port', 'backend_https_port', 'backend_host', 'proxy_timeout', 'proxy_http_version', 'proxy_ssl_protocols', 'backend_port_mapping', 'ups_keepalive', 'ups_keepalive_conn', 'ups_keepalive_timeout', 'range', 'health_check']),
    cache: pick(before, ['proxy_cache']),
    security: pick(before, ['cc_default_rule', 'cc_switch', 'block_proxy', 'black_ip', 'white_ip', 'block_region']),
    access: pick(before, ['acl', 'hotlink', 'cors']),
    advanced: pick(before, ['websocket_enable', 'gzip_enable', 'gzip_types', 'enable_ipv6', 'recv_real_time', 'send_real_time', 'acme_proxy_to_orgin', 'spider_to_sip', 'post_size_limit', 'page_403', 'page_404', 'page_500', 'page_502', 'page_504', 'req_header', 'resp_header', 'url_rewrite']),
  };
  if (before.https_listen && Object.keys(before.https_listen).length) sections.https = { https_listen: before.https_listen };

  const results = {};
  for (const [name, payload] of Object.entries(sections)) {
    try {
      await client.request('PUT', `/v1/sites/${encodeURIComponent(site.upstream_id)}`, { ...payload, ...group });
      results[name] = { ok: true, fields: Object.keys(payload) };
    } catch (error) {
      results[name] = { ok: false, status: error.upstreamStatus || error.status, message: error.message, fields: Object.keys(payload) };
      console.log(JSON.stringify({ allowedDomain, localSiteId: site.id, upstreamSiteId: site.upstream_id, results }, null, 2));
      throw error;
    }
  }

  const after = await client.request('GET', `/v1/sites/${encodeURIComponent(site.upstream_id)}`);
  assert.deepEqual(domainList(after.domain), [allowedDomain]);
  assert.deepEqual(after.backend, before.backend, '烟测后源站配置发生变化');
  assert.deepEqual(after.http_listen, before.http_listen, '烟测后 HTTP 监听发生变化');
  assert.deepEqual(after.https_listen, before.https_listen, '烟测后 HTTPS 监听发生变化');
  console.log(JSON.stringify({ allowedDomain, localSiteId: site.id, upstreamSiteId: site.upstream_id, results }, null, 2));
} finally {
  await db.close();
}
