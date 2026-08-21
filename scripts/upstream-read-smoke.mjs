import { loadConfig } from 'file:///app/src/config.js';
import { createPostgresDatabase } from 'file:///app/src/db.js';
import { CdnflyClient } from 'file:///app/src/cdnfly.js';
import { UpstreamService } from 'file:///app/src/upstreams.js';

const config = loadConfig();
const db = await createPostgresDatabase(config.databaseUrl);
const legacy = new CdnflyClient(config, fetch, null);
const upstreams = new UpstreamService(db, config, null, { legacyClient: legacy });
const allowedDomain = String(process.env.ARENODE_ACCEPTANCE_DOMAIN || '').trim().toLowerCase();
if (!allowedDomain) throw new Error('需要 ARENODE_ACCEPTANCE_DOMAIN');

function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['items', 'data', 'list', 'rows', 'result']) {
    const size = collectionSize(value[key]);
    if (size !== null) return size;
  }
  return null;
}

function safeError(error) {
  return { status: Number(error?.upstreamStatus || error?.status || 0), message: String(error?.message || '请求失败').slice(0, 160) };
}

const checks = {};
async function probe(name, client, path) {
  try {
    const data = await client.request('GET', path);
    checks[name] = { ok: true, count: collectionSize(data), shape: Array.isArray(data) ? 'array' : typeof data };
    return data;
  } catch (error) {
    checks[name] = { ok: false, ...safeError(error) };
    return null;
  }
}

try {
  const sites = await db.prepare(`SELECT s.*,u.username FROM sites s JOIN users u ON u.id=s.owner_id
    WHERE u.role='user' AND lower(s.domain)=? ORDER BY s.id`).all(allowedDomain);
  if (sites.length !== 1) throw new Error(`需要且只能存在一个验收网站 ${allowedDomain}`);
  const site = sites[0]; const domain = String(site.domain || '').split(/[\s,]+/)[0];
  const siteClient = await upstreams.clientForSite(site);
  await probe('siteDetail', siteClient, `/v1/sites/${encodeURIComponent(site.upstream_id)}`);
  for (const resource of ['site-groups', 'certs', 'dnsapis', 'acls', 'cc-filters', 'cc-matchs', 'cc-rules', 'stream-groups', 'domains', 'jobs', 'site-sys-config', 'user-configs', 'api-key', 'orders']) {
    await probe(resource, siteClient, `/v1/${resource}?limit=100`);
  }
  const end = new Date(); const start = new Date(end.getTime() - 60 * 60_000);
  const time = value => encodeURIComponent(value.toISOString().slice(0, 19).replace('T', ' '));
  const range = `start=${time(start)}&end=${time(end)}`;
  await probe('basicMonitor', siteClient, `/v1/monitor/site/realtime?domain=${encodeURIComponent(domain)}&type=traffic&${range}`);
  await probe('quality4xx', siteClient, `/v1/monitor/site/realtime?domain=${encodeURIComponent(domain)}&type=status-4xx&${range}`);
  await probe('qualityRequestCache', siteClient, `/v1/monitor/site/realtime?domain=${encodeURIComponent(domain)}&type=req-cache-status&${range}`);
  await probe('qualityByteCache', siteClient, `/v1/monitor/site/realtime?domain=${encodeURIComponent(domain)}&type=byte-cache-status&${range}`);
  await probe('originBandwidth', siteClient, `/v1/monitor/site/realtime?domain=${encodeURIComponent(domain)}&type=backend-bandwidth&${range}`);
  await probe('originResponseTime', siteClient, `/v1/monitor/site/realtime?domain=${encodeURIComponent(domain)}&type=backend-resp-time&${range}`);
  await probe('siteRanking', siteClient, `/v1/monitor/site/top?domain=${encodeURIComponent(domain)}&type=top-domain&recent_time=10m`);
  await probe('accessLogs', siteClient, `/v1/monitor/site/access-log?host=${encodeURIComponent(domain)}&limit=100&page=1&${range}`);

  const streams = await db.prepare(`SELECT r.* FROM tenant_resources r WHERE r.kind='streams' AND r.owner_id=? ORDER BY r.id`).all(site.owner_id);
  if (streams.length) {
    const stream = streams[0]; const streamClient = await upstreams.clientForResource(stream);
    await probe('streamDetail', streamClient, `/v1/streams/${encodeURIComponent(stream.upstream_id)}`);
    await probe('streamMonitor', streamClient, `/v1/monitor/stream/realtime?type=stream-traffic&port=&${range}`);
    await probe('streamRanking', streamClient, '/v1/monitor/stream/top?type=top-ports&recent_time=10m');
  }
  const failed = Object.entries(checks).filter(([, value]) => !value.ok);
  console.log(JSON.stringify({ checkedSiteId: site.id, checkedStreamCount: streams.length, checks, failed: failed.map(([name, value]) => ({ name, status: value.status, message: value.message })) }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  await db.close();
}
