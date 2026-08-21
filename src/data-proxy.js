import { isIP } from 'node:net';
import { tenantProxyInternals } from './tenant-proxy.js';

const BLOCKED_QUERY = new Set(['uid', 'user_id', 'owner_id', 'receive', 'user_package', 'action']);
const URL_JOB_TYPES = new Set(['clean_url', 'clean_dir', 'pre_cache_url']);
const IP_JOB_TYPES = new Set(['unlock_ip', 'clear_white_ip']);
const JOB_TYPES = new Set([...URL_JOB_TYPES, ...IP_JOB_TYPES, 'down_http_access_log']);
const SITE_TOP_TYPES = new Set(['top-ip', 'top-country', 'top-province', 'top-isp', 'top-url', 'top-domain', 'top-tls-fp', 'top-referer']);
const STREAM_TOP_TYPES = new Set(['top-ports']);
const OVERVIEW_REALTIME_TYPES = new Set(['traffic', 'bandwidth', 'req', 'qps']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function findCollection(value) {
  if (Array.isArray(value)) return { parent: null, key: null, items: value };
  if (!value || typeof value !== 'object') return null;
  for (const key of ['items', 'list', 'rows', 'data', 'result']) {
    if (Array.isArray(value[key])) return { parent: value, key, items: value[key] };
    const nested = findCollection(value[key]);
    if (nested) return nested;
  }
  return null;
}

function setCollection(root, ref, items) {
  if (!ref || ref.parent === null) return items;
  ref.parent[ref.key] = items;
  for (const target of new Set([root, ref.parent])) {
    for (const key of ['count', 'total', 'total_count']) if (typeof target?.[key] === 'number') target[key] = items.length;
  }
  return root;
}

function cleanQuery(url, extraBlocked = []) {
  const query = new URLSearchParams(url.searchParams);
  for (const key of [...BLOCKED_QUERY, ...extraBlocked]) query.delete(key);
  return query;
}

function withQuery(path, query) {
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

function validateUsageRange(query) {
  const parse = (name) => {
    const value = String(query.get(name) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw httpError(`${name} 必须使用 YYYY-MM-DD 格式`);
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw httpError(`${name} 日期无效`);
    return date;
  };
  const start = parse('start'); const end = parse('end');
  if (start > end) throw httpError('start 不能晚于 end');
}

function normalizeStreamTopQuery(query) {
  const requestedType = String(query.get('type') || 'top-ports');
  const type = requestedType === 'top-port' ? 'top-ports' : requestedType;
  if (!STREAM_TOP_TYPES.has(type)) throw httpError('四层排行仅支持监听端口维度');
  let recentTime = String(query.get('recent_time') || '');
  if (/^(10|30|60)$/.test(recentTime)) recentTime += 'm';
  if (!recentTime) {
    const start = new Date(String(query.get('start') || '').replace(' ', 'T'));
    const end = new Date(String(query.get('end') || '').replace(' ', 'T'));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      recentTime = '60m';
    } else if (Math.ceil((end - start) / 60_000) > 60) {
      throw httpError('四层排行时间范围不能超过 1 小时');
    }
    const minutes = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start < end ? Math.ceil((end - start) / 60_000) : 60;
    recentTime = minutes <= 10 ? '10m' : minutes <= 30 ? '30m' : '60m';
  }
  if (!['10m', '30m', '60m'].includes(recentTime)) throw httpError('四层排行时间范围仅支持最近 10、30 或 60 分钟');
  query.set('type', type); query.set('recent_time', recentTime);
  query.delete('port'); query.delete('start'); query.delete('end');
  return query;
}

function normalizeSiteTopQuery(query) {
  const type = String(query.get('type') || '');
  if (!SITE_TOP_TYPES.has(type)) throw httpError('请选择有效的资源排行维度');
  let recentTime = String(query.get('recent_time') || '');
  if (/^(10|30|60)$/.test(recentTime)) recentTime += 'm';
  if (!recentTime) {
    const start = new Date(String(query.get('start') || '').replace(' ', 'T'));
    const end = new Date(String(query.get('end') || '').replace(' ', 'T'));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw httpError('数据排行时间范围无效');
    const minutes = Math.ceil((end - start) / 60_000);
    if (minutes > 60) throw httpError('数据排行时间范围不能超过 1 小时');
    recentTime = minutes <= 10 ? '10m' : minutes <= 30 ? '30m' : '60m';
  }
  if (!['10m', '30m', '60m'].includes(recentTime)) throw httpError('数据排行时间范围仅支持最近 10、30 或 60 分钟');
  query.set('type', type); query.set('recent_time', recentTime);
  query.delete('start'); query.delete('end');
  return query;
}

async function ownedSites(db, userId) {
  return db.prepare('SELECT id, upstream_id, upstream_account_id, subscription_id, domain FROM sites WHERE owner_id = ?').all(userId);
}

function splitDomains(value) {
  return String(value || '').split(/[\s,]+/).map(item => item.trim().toLowerCase().replace(/:\d+$/, '')).filter(Boolean);
}

function domainOwned(domain, sites) {
  const candidate = String(domain || '').toLowerCase().replace(/:\d+$/, '');
  return sites.some(site => splitDomains(site.domain).some(owned => owned === candidate || (owned.startsWith('*.') && candidate.endsWith(owned.slice(1)))));
}

async function scopeDomain(url, db, userId, preferredKey) {
  const sites = await ownedSites(db, userId);
  if (!sites.length) throw httpError('当前租户没有网站', 409);
  const query = cleanQuery(url);
  let requested = query.get('host') || query.get('domain');
  const localSiteId = query.get('site_id');
  if (localSiteId) {
    const site = sites.find(item => item.id === Number(localSiteId));
    if (!site) throw httpError('网站不存在', 404);
    const domains = splitDomains(site.domain);
    if (!domains.length) throw httpError('网站没有可查询域名', 409);
    requested = domains[0];
    query.delete('site_id');
  }
  if (!requested) {
    const domains = [...new Set(sites.flatMap(site => splitDomains(site.domain)))];
    if (domains.length !== 1) throw httpError('必须指定当前租户的 site_id、domain 或 host');
    requested = domains[0];
  }
  const requestedDomains = splitDomains(requested);
  if (!requestedDomains.length || requestedDomains.some(domain => !domainOwned(domain, sites))) throw httpError('只能查询当前租户网站的域名', 403);
  query.delete('host'); query.delete('domain');
  query.set(preferredKey, requestedDomains.join(' '));
  return { query, sites, domains: requestedDomains };
}

async function scopeSite(url, db, userId) {
  const sites = await ownedSites(db, userId);
  const query = cleanQuery(url);
  let site;
  if (query.get('site_id')) site = sites.find(item => item.id === Number(query.get('site_id')));
  else if (sites.length === 1) site = sites[0];
  else throw httpError('必须指定当前租户的 site_id');
  if (!site) throw httpError('网站不存在', 404);
  query.set('site_id', site.upstream_id);
  return { query, site };
}

function localizeSiteRecords(data, site) {
  const output = clone(data); const ref = findCollection(output);
  if (!ref) return output;
  const items = ref.items.filter(item => String(item.site_id) === String(site.upstream_id)).map(item => ({ ...item, site_id: site.id, uid: undefined, user_id: undefined }));
  return setCollection(output, ref, items);
}

function recordDomain(record) {
  return record?.host ?? record?.domain ?? record?.server_name ?? record?.hostname ?? record?.site_domain;
}

function recordResourceId(record) {
  return record?.resource_id ?? record?.resourceId ?? record?.site_id ?? record?.siteId
    ?? record?.stream_id ?? record?.streamId ?? record?.res_id ?? record?.resId;
}

function filterDomainRecords(data, domains) {
  const output = clone(data); const ref = findCollection(output);
  if (!ref) return output;
  const items = ref.items.filter(record => {
    const value = recordDomain(record);
    return value && splitDomains(value).some(domain => domains.includes(domain));
  });
  return setCollection(output, ref, items);
}

function filterScopedRecords(data, domains) {
  const output = clone(data); const ref = findCollection(output);
  if (!ref) return output;
  const identified = ref.items.filter(item => recordDomain(item));
  // CDNFly's realtime/top endpoints may return aggregate rows without a
  // repeated domain field; the request itself is already constrained by the
  // validated domain query. Preserve that aggregate response, while filtering
  // mixed collections below where individual records can be identified.
  if (!identified.length) return output;
  const items = ref.items.filter(item => {
    const value = recordDomain(item);
    return value && splitDomains(value).some(domain => domains.includes(domain));
  });
  return setCollection(output, ref, items);
}

function filterResourceRecords(data, resourceIds) {
  const output = clone(data); const ref = findCollection(output);
  if (!ref) return output;
  const allowed = new Set(resourceIds.map(value => String(value)));
  const identified = ref.items.filter(item => recordResourceId(item) !== undefined && recordResourceId(item) !== null);
  // Aggregate rows have no resource identifier. The request is already
  // constrained by the validated resource list, so preserve that shape.
  if (!identified.length) return output;
  return setCollection(output, ref, ref.items.filter(item => allowed.has(String(recordResourceId(item)))));
}

async function rememberDocuments(db, userId, kind, data, upstreamAccountId = null, localize = false) {
  const ref = findCollection(data); if (!ref) return;
  for (const record of ref.items) {
    const rawId = record.id ?? record._id ?? record.document_id;
    if (rawId === undefined || rawId === null) continue;
    const accountId = upstreamAccountId || null;
    let document = accountId
      ? await db.prepare('SELECT id FROM monitor_documents WHERE user_id=? AND kind=? AND document_id=? AND upstream_account_id=?').get(userId, kind, String(rawId), accountId)
      : await db.prepare('SELECT id FROM monitor_documents WHERE user_id=? AND kind=? AND document_id=? AND upstream_account_id IS NULL').get(userId, kind, String(rawId));
    if (!document) {
      const inserted = await db.prepare('INSERT OR IGNORE INTO monitor_documents (user_id, kind, document_id, upstream_account_id) VALUES (?, ?, ?, ?)')
        .run(userId, kind, String(rawId), accountId);
      document = inserted.lastInsertRowid ? { id: inserted.lastInsertRowid } : (accountId
        ? await db.prepare('SELECT id FROM monitor_documents WHERE user_id=? AND kind=? AND document_id=? AND upstream_account_id=?').get(userId, kind, String(rawId), accountId)
        : await db.prepare('SELECT id FROM monitor_documents WHERE user_id=? AND kind=? AND document_id=? AND upstream_account_id IS NULL').get(userId, kind, String(rawId)));
    }
    if (localize) {
      record.id = Number(document.id);
      delete record._id;
      if (Object.hasOwn(record, 'document_id')) record.document_id = Number(document.id);
    }
  }
}

async function siteByLocal(db, userId, id) {
  return db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(Number(id), userId) || null;
}

async function mapSiteIds(db, userId, value) {
  const ids = Array.isArray(value) ? value : String(value).split(/[\s,]+/).filter(Boolean);
  return Promise.all(ids.map(async id => {
    const site = await siteByLocal(db, userId, id);
    if (!site) throw httpError('网站不存在', 404);
    return site.upstream_id;
  }));
}

async function ownedStreamMappings(db, userId) {
  return db.prepare(`SELECT r.id, r.upstream_id, r.upstream_account_id, r.subscription_id, r.snapshot FROM tenant_resources r WHERE r.kind = 'streams' AND r.owner_id = ?`).all(userId);
}

async function allowedStreamPorts(db, userId) {
  return (await db.prepare(`SELECT p.port FROM stream_ports p JOIN tenant_resources r ON r.id = p.resource_id
    WHERE r.kind = 'streams' AND r.owner_id = ? ORDER BY p.port`).all(userId)).map(row => Number(row.port));
}

async function refreshStreamPorts(db, cdnfly, userId, upstreams = null, requestedPorts = null) {
  const mappings = await ownedStreamMappings(db, userId);
  const requested = requestedPorts instanceof Set ? requestedPorts : new Set((requestedPorts || []).map(Number));
  const scoped = requested.size
    ? (await db.prepare(`SELECT DISTINCT r.id FROM tenant_resources r JOIN stream_ports p ON p.resource_id=r.id
        WHERE r.owner_id=? AND r.kind='streams' AND p.port IN (${[...requested].map(() => '?').join(',')})`).all(userId, ...requested)).map(row => Number(row.id))
    : null;
  const selected = scoped ? mappings.filter(mapping => scoped.includes(Number(mapping.id))) : mappings;
  await Promise.all(selected.map(async mapping => {
    const client = upstreams ? await upstreams.clientForResource(mapping) : cdnfly;
    const detail = await tenantProxyInternals.resourceDetail(client, 'streams', mapping.upstream_id, mapping);
    await tenantProxyInternals.syncStreamPorts(db, mapping.id, detail);
  }));
}

async function scopePorts(url, db, userId) {
  const allowed = await allowedStreamPorts(db, userId);
  const query = cleanQuery(url);
  const requested = String(query.get('port') || '').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isInteger);
  if (requested.some(port => !allowed.includes(port))) throw httpError('只能查询当前租户的四层监听端口', 403);
  query.set('port', (requested.length ? requested : allowed).join(' '));
  return { query, allowed, requested: requested.length ? requested : null };
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function streamRecordPort(item) {
  const port = Number(item?.port ?? item?.listen_port ?? item?.res);
  return Number.isInteger(port) ? port : null;
}

function streamRecordAllowed(item, allowed, { allowAggregate = false } = {}) {
  const port = streamRecordPort(item);
  return port === null ? allowAggregate : allowed.includes(port);
}

async function accountStreamsBelongToPorts(cdnfly, allowed) {
  try {
    const data = await cdnfly.request('GET', '/v1/streams?limit=0'); const ref = findCollection(data);
    const ports = [...new Set((ref?.items || []).flatMap(item => Array.isArray(item?.listen) ? item.listen : [])
      .map(item => Number(item?.port)).filter(Number.isInteger))];
    return ports.length > 0 && ports.every(port => allowed.includes(port));
  } catch {
    return false;
  }
}

function usageValues(data) {
  const ref = findCollection(data);
  return (ref?.items || []).map(item => numericValue(item.value));
}

async function usageFor(cdnfly, type, cate, resources, start, end) {
  if (!resources.length) return [];
  const query = new URLSearchParams({ type, cate, res: resources.join(' '), start, end });
  return usageValues(filterResourceRecords(await cdnfly.request('GET', withQuery('/v1/monitor/usage', query)), resources));
}

async function localAudit(db, userId, loginOnly, url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10)));
  const condition = loginOnly ? "action LIKE 'login.%'" : "action NOT LIKE 'login.%'";
  const count = (await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = ? AND ${condition}`).get(userId)).count;
  const rows = await db.prepare(`SELECT id, action, resource_type, resource_id, detail, ip, created_at FROM audit_logs
    WHERE actor_id = ? AND ${condition} ORDER BY id DESC LIMIT ? OFFSET ?`).all(userId, limit, (page - 1) * limit);
  return { count, items: rows };
}

function resourceMapping(db, userId, kind, localId) {
  return tenantProxyInternals.resourceByLocal(db, kind, localId, userId);
}

async function mappingByUpstream(db, userId, kind, upstreamId, upstreamAccountId = null) {
  return upstreamAccountId
    ? db.prepare('SELECT * FROM tenant_resources WHERE owner_id=? AND kind=? AND upstream_id=? AND upstream_account_id=?').get(userId, kind, String(upstreamId), Number(upstreamAccountId)) || null
    : db.prepare('SELECT * FROM tenant_resources WHERE owner_id=? AND kind=? AND upstream_id=? AND upstream_account_id IS NULL').get(userId, kind, String(upstreamId)) || null;
}

async function prepareJob(db, user, job) {
  const clean = tenantProxyInternals.stripForbidden(job);
  if (clean.type === 'cancel_task') throw httpError('当前 CDN 服务暂不支持取消任务', 501);
  if (!JOB_TYPES.has(clean.type) || !clean.data || typeof clean.data !== 'object' || Array.isArray(clean.data)) throw httpError('任务类型或数据无效');
  const sites = await ownedSites(db, user.id);
  const input = clean.data;
  const data = {};
  if (IP_JOB_TYPES.has(clean.type)) {
    const site = await siteByLocal(db, user.id, input.site_id);
    if (!site) throw httpError('网站不存在', 404);
    data.site_id = Number(site.upstream_id);
    const ip = String(input.ip || '').trim();
    if (isIP(ip) === 0) throw httpError('IP 地址无效');
    data.ip = ip;
  } else if (URL_JOB_TYPES.has(clean.type)) {
    const value = String(input.url || '').trim();
    if (!value) throw httpError('缓存任务必须指定当前租户网站 URL');
    let hostname;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid URL');
      hostname = parsed.hostname;
    } catch { throw httpError('任务 URL 必须是完整的 HTTP 或 HTTPS 地址'); }
    if (!domainOwned(hostname, sites)) throw httpError('只能操作当前租户网站的 URL', 403);
    data.url = value;
  } else if (clean.type === 'down_http_access_log') {
    const host = String(input.host || input.domain || '').trim().toLowerCase();
    if (!host || !domainOwned(host, sites)) throw httpError('下载访问日志必须指定当前租户域名', host ? 403 : 400);
    if (!input.start || !input.end) throw httpError('下载访问日志必须指定开始和结束时间');
    const start = new Date(String(input.start).replace(' ', 'T')); const end = new Date(String(input.end).replace(' ', 'T'));
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end) throw httpError('访问日志时间范围无效');
    data.host = host;
    data.start = String(input.start).trim();
    data.end = String(input.end).trim();
  }
  return { type: clean.type, data };
}

function jobReferencedSites(data, sites) {
  if (!data || typeof data !== 'object') return [];
  const selected = new Map();
  const add = site => { if (site) selected.set(Number(site.id), site); };
  const siteIds = [data.site_id, ...(Array.isArray(data.site_ids) ? data.site_ids : String(data.site_ids || '').split(/[\s,]+/).filter(Boolean))]
    .filter(value => value !== undefined && value !== null && value !== '');
  for (const id of siteIds) {
    const site = sites.find(item => Number(item.id) === Number(id));
    if (site) add(site);
  }
  const candidates = [data.host, data.domain, ...(Array.isArray(data.urls) ? data.urls : []), data.url]
    .filter(Boolean);
  for (const candidate of candidates) {
    let domain = candidate;
    try { domain = new URL(String(candidate)).hostname; } catch {}
    const match = sites.find(site => domainOwned(domain, [site]));
    add(match);
  }
  return [...selected.values()];
}

async function listJobs(db, cdnfly, user, url) {
  const query = cleanQuery(url);
  if (String(query.get('type') || '').split(',').includes('backup')) throw httpError('当前客户账号不能查询平台共享备份任务', 403);
  const output = clone(await cdnfly.request('GET', withQuery('/v1/jobs', query)));
  const ref = findCollection(output); if (!ref) return output;
  const items = (await Promise.all(ref.items.map(async record => {
    const mapping = await mappingByUpstream(db, user.id, 'jobs', record.id, cdnfly.accountId);
    return mapping ? { ...record, id: mapping.id, uid: undefined, user_id: undefined } : null;
  }))).filter(Boolean);
  return setCollection(output, ref, items);
}

export async function handleDataProxy({ req, url, user, db, cdnfly, upstreams = null, readBody }) {
  const prefix = '/api/cdnfly/v1';
  if (!url.pathname.startsWith(prefix)) return null;
  if (user.role !== 'user') return null;
  const path = url.pathname.slice(prefix.length) || '/';

  if (path === '/monitor/site/overview' && req.method === 'GET') {
    const sites = await ownedSites(db, user.id);
    if (!sites.length) return { status: 200, data: [] };
    const query = cleanQuery(url, ['site_id', 'host', 'domain', 'server_port']);
    const type = String(query.get('type') || 'traffic');
    if (!OVERVIEW_REALTIME_TYPES.has(type)) throw httpError('控制台趋势指标无效');
    const start = new Date(String(query.get('start') || '').replace(' ', 'T'));
    const end = new Date(String(query.get('end') || '').replace(' ', 'T'));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end - start > 48 * 60 * 60_000) {
      throw httpError('控制台趋势时间范围无效');
    }
    const groups = new Map();
    for (const site of sites) {
      const key = upstreams ? String(site.upstream_account_id) : 'legacy';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(site);
    }
    const items = [];
    for (const groupedSites of groups.values()) {
      const domains = [...new Set(groupedSites.flatMap(site => splitDomains(site.domain)))];
      if (!domains.length) continue;
      const scoped = new URLSearchParams(query); scoped.set('type', type); scoped.set('domain', domains.join(' '));
      const client = upstreams ? await upstreams.clientForSite(groupedSites[0]) : cdnfly;
      const data = filterScopedRecords(await client.request('GET', withQuery('/v1/monitor/site/realtime', scoped)), domains);
      const ref = findCollection(data);
      items.push(...(ref?.items || (Array.isArray(data) ? data : [])));
    }
    return { status: 200, data: items };
  }

  const scopedLists = new Map([
    ['/monitor/site/access-log', { key: 'host', doc: 'access-log' }],
    ['/monitor/site/attack-log', { key: 'domain', doc: 'attack-log' }],
  ]);
  if (req.method === 'GET' && scopedLists.has(path)) {
    const spec = scopedLists.get(path); const { query, domains, sites } = await scopeDomain(url, db, user.id, spec.key);
    if (path === '/monitor/site/access-log') {
      const limit = Number(query.get('limit') || 100); const page = Number(query.get('page') || 1);
      query.set('limit', String(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100));
      query.set('page', String(Number.isInteger(page) && page > 0 ? page : 1));
    }
    const matched = sites.filter(site => domains.some(domain => domainOwned(domain, [site])));
    if (upstreams && new Set(matched.map(site => Number(site.upstream_account_id))).size > 1) throw httpError('一次只能查询同一 CDN 服务下的网站日志', 409);
    const upstreamClient = upstreams ? await upstreams.clientForSite(matched[0]) : cdnfly;
    if (path === '/monitor/site/attack-log' && !await tenantProxyInternals.supportsAttackLogs(upstreamClient, matched[0])) {
      throw httpError('当前 CDN 服务未提供攻击日志功能', 501);
    }
    let data = await upstreamClient.request('GET', withQuery(`/v1${path}`, query));
    data = filterDomainRecords(data, domains);
    if (spec.doc) await rememberDocuments(db, user.id, spec.doc, data, upstreamClient.accountId, Boolean(upstreams));
    return { status: 200, data };
  }

  if (req.method === 'GET' && ['/monitor/site/blackip', '/monitor/site/history-blackip'].includes(path)) {
    const { query, site } = await scopeSite(url, db, user.id);
    const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
    const data = await upstreamClient.request('GET', withQuery(`/v1${path}`, query));
    return { status: 200, data: localizeSiteRecords(data, site) };
  }

  const accessDetail = path.match(/^\/monitor\/site\/access-log\/(.+)$/);
  if (req.method === 'GET' && accessDetail) {
    const document = upstreams
      ? await db.prepare('SELECT * FROM monitor_documents WHERE id=? AND user_id=? AND kind=?').get(Number(accessDetail[1]), user.id, 'access-log')
      : await db.prepare('SELECT * FROM monitor_documents WHERE user_id=? AND kind=? AND document_id=?').get(user.id, 'access-log', accessDetail[1]);
    if (!document) throw httpError('访问日志不存在', 404);
    const upstreamClient = upstreams ? await upstreams.clientForAccount(document.upstream_account_id) : cdnfly;
    return { status: 200, data: await upstreamClient.request('GET', `/v1/monitor/site/access-log/${encodeURIComponent(document.document_id)}`) };
  }
  const attackDetail = path.match(/^\/monitor\/site\/attack-log\/(.+)$/);
  if (req.method === 'GET' && attackDetail && attackDetail[1] !== 'stats') {
    const document = upstreams
      ? await db.prepare('SELECT * FROM monitor_documents WHERE id=? AND user_id=? AND kind=?').get(Number(attackDetail[1]), user.id, 'attack-log')
      : await db.prepare('SELECT * FROM monitor_documents WHERE user_id=? AND kind=? AND document_id=?').get(user.id, 'attack-log', attackDetail[1]);
    if (!document) throw httpError('攻击日志不存在', 404);
    const upstreamClient = upstreams ? await upstreams.clientForAccount(document.upstream_account_id) : cdnfly;
    try {
      return { status: 200, data: await upstreamClient.request('GET', `/v1/monitor/site/attack-log/${encodeURIComponent(document.document_id)}`) };
    } catch (error) {
      if (Number(error?.upstreamStatus) === 404) throw httpError('当前 CDN 服务未提供攻击日志功能', 501);
      throw error;
    }
  }

  if (req.method === 'GET' && ['/monitor/site/attack-log/stats', '/monitor/site/realtime', '/monitor/site/top'].includes(path)) {
    const { query, domains, sites } = await scopeDomain(url, db, user.id, 'domain');
    if (path === '/monitor/site/top') normalizeSiteTopQuery(query);
    const matched = sites.filter(site => domains.some(domain => domainOwned(domain, [site])));
    if (upstreams && new Set(matched.map(site => Number(site.upstream_account_id))).size > 1) throw httpError('一次只能查询同一 CDN 服务下的网站数据', 409);
    const upstreamClient = upstreams ? await upstreams.clientForSite(matched[0]) : cdnfly;
    if (path === '/monitor/site/attack-log/stats' && !await tenantProxyInternals.supportsAttackLogs(upstreamClient, matched[0])) {
      throw httpError('当前 CDN 服务未提供攻击日志功能', 501);
    }
    let data = await upstreamClient.request('GET', withQuery(`/v1${path}`, query));
    if (path !== '/monitor/site/attack-log/stats') data = filterScopedRecords(data, domains);
    return { status: 200, data };
  }

  if (path === '/monitor/site/blackip-count' && req.method === 'GET') {
    const clients = upstreams ? await upstreams.clientsForUser(user.id) : [cdnfly]; const items = [];
    for (const client of clients) {
      const data = clone(await client.request('GET', '/v1/monitor/site/blackip-count')); const ref = findCollection(data);
      for (const item of ref?.items || []) {
        const site = client.accountId
          ? await db.prepare('SELECT id FROM sites WHERE owner_id=? AND upstream_account_id=? AND upstream_id=?').get(user.id, client.accountId, String(item.site_id))
          : await db.prepare('SELECT id FROM sites WHERE owner_id=? AND upstream_account_id IS NULL AND upstream_id=?').get(user.id, String(item.site_id));
        if (site) items.push({ ...item, site_id: site.id, uid: undefined });
      }
    }
    return { status: 200, data: { count: items.length, items } };
  }

  const accessDownload = path.match(/^\/monitor\/site\/download-access-log\/(\d+)$/);
  if (accessDownload && req.method === 'GET') {
    const job = await resourceMapping(db, user.id, 'jobs', accessDownload[1]);
    if (!job) throw httpError('下载任务不存在', 404);
    const upstreamClient = upstreams ? await upstreams.clientForResource(job) : cdnfly;
    return { status: 200, download: await upstreamClient.download(`/v1/monitor/site/download-access-log/${job.upstream_id}`) };
  }

  if (path === '/monitor/stream/realtime' && req.method === 'GET') {
    const initialScope = await scopePorts(url, db, user.id);
    await refreshStreamPorts(db, cdnfly, user.id, upstreams, initialScope.requested);
    const { allowed } = initialScope;
    if (!allowed.length) return { status: 200, data: [] };
    if (!upstreams) {
      const { query } = await scopePorts(url, db, user.id);
      query.set('port', '');
      const metric = String(query.get('type') || '');
      if (metric && !metric.startsWith('stream-')) query.set('type', `stream-${metric}`);
      const data = clone(await cdnfly.request('GET', withQuery('/v1/monitor/stream/realtime', query)));
      const ref = findCollection(data);
      if (!ref) return { status: 200, data };
      const allowAggregate = await accountStreamsBelongToPorts(cdnfly, allowed);
      return { status: 200, data: setCollection(data, ref, ref.items.filter(item => streamRecordAllowed(item, allowed, { allowAggregate }))) };
    }
    const rows = await db.prepare(`SELECT DISTINCT r.upstream_account_id,p.port FROM tenant_resources r JOIN stream_ports p ON p.resource_id=r.id
      WHERE r.owner_id=? AND r.kind='streams' ORDER BY r.upstream_account_id,p.port`).all(user.id);
    const items = [];
    for (const accountId of new Set(rows.map(row => Number(row.upstream_account_id)))) {
      const ports = rows.filter(row => Number(row.upstream_account_id) === accountId && allowed.includes(Number(row.port))).map(row => Number(row.port));
      if (!ports.length) continue;
      const query = cleanQuery(url); query.set('port', '');
      const metric = String(query.get('type') || '');
      if (metric && !metric.startsWith('stream-')) query.set('type', `stream-${metric}`);
      const client = await upstreams.clientForAccount(accountId);
      const data = await client.request('GET', withQuery('/v1/monitor/stream/realtime', query)); const ref = findCollection(data);
      const allowAggregate = await accountStreamsBelongToPorts(client, ports);
      items.push(...(ref?.items || (Array.isArray(data) ? data : [])).filter(item => streamRecordAllowed(item, ports, { allowAggregate })));
    }
    return { status: 200, data: { count: items.length, items } };
  }
  if (path === '/monitor/stream/top' && req.method === 'GET') {
    const initialScope = await scopePorts(url, db, user.id);
    await refreshStreamPorts(db, cdnfly, user.id, upstreams, initialScope.requested);
    const { allowed } = initialScope; const query = normalizeStreamTopQuery(initialScope.query);
    if (!allowed.length) return { status: 200, data: [] };
    if (!upstreams) {
      const data = clone(await cdnfly.request('GET', withQuery('/v1/monitor/stream/top', query))); const ref = findCollection(data);
      if (!ref) return { status: 200, data: [] };
      return { status: 200, data: setCollection(data, ref, ref.items.filter(item => streamRecordPort(item) !== null && streamRecordAllowed(item, allowed))) };
    }
    const clients = upstreams ? await upstreams.clientsForUser(user.id) : [cdnfly]; const items = [];
    for (const client of clients) {
      const scoped = new URLSearchParams(query);
      const clientAllowed = (await db.prepare(`SELECT p.port FROM stream_ports p JOIN tenant_resources r ON r.id=p.resource_id
        WHERE r.owner_id=? AND r.kind='streams' AND r.upstream_account_id=?`).all(user.id, client.accountId)).map(row => Number(row.port));
      if (!clientAllowed.length) continue;
      const data = clone(await client.request('GET', withQuery('/v1/monitor/stream/top', scoped))); const ref = findCollection(data);
      items.push(...(ref?.items || []).filter(item => streamRecordPort(item) !== null && streamRecordAllowed(item, clientAllowed) && streamRecordAllowed(item, allowed)));
    }
    return { status: 200, data: { count: items.length, items } };
  }

  if (path === '/monitor/usage' && req.method === 'GET') {
    const query = cleanQuery(url); const cate = query.get('cate');
    if (!['site', 'stream'].includes(cate)) throw httpError('用量查询必须指定 cate=site 或 cate=stream');
    validateUsageRange(query);
    const localIds = String(query.get('res') || '').split(/\s+/).filter(Boolean);
    if (upstreams) {
      const resources = cate === 'site' ? await ownedSites(db, user.id) : await ownedStreamMappings(db, user.id);
      const selected = localIds.length ? localIds.map(id => { const row = resources.find(item => item.id === Number(id)); if (!row) throw httpError(cate === 'site' ? '网站不存在' : '四层转发不存在', 404); return row; }) : resources;
      if (!selected.length) return { status: 200, data: [] };
      const items = [];
      for (const accountId of new Set(selected.map(row => Number(row.upstream_account_id)))) {
        const ids = selected.filter(row => Number(row.upstream_account_id) === accountId).map(row => row.upstream_id);
        const scoped = new URLSearchParams(query); scoped.set('res', ids.join(' ')); scoped.delete('user_package');
        const data = await (await upstreams.clientForAccount(accountId)).request('GET', withQuery('/v1/monitor/usage', scoped));
        const filtered = filterResourceRecords(data, ids); const ref = findCollection(filtered);
        items.push(...(ref?.items || (Array.isArray(filtered) ? filtered : [])));
      }
      return { status: 200, data: items };
    }
    let upstreamIds;
    if (cate === 'site') upstreamIds = localIds.length ? await mapSiteIds(db, user.id, localIds) : (await ownedSites(db, user.id)).map(site => site.upstream_id);
    else {
      const streams = await ownedStreamMappings(db, user.id);
      upstreamIds = localIds.length ? localIds.map(id => {
        const mapping = streams.find(item => item.id === Number(id)); if (!mapping) throw httpError('四层转发不存在', 404); return mapping.upstream_id;
      }) : streams.map(item => item.upstream_id);
    }
    if (!upstreamIds.length) return { status: 200, data: [] };
    query.set('res', upstreamIds.join(' ')); query.delete('user_package');
    return { status: 200, data: filterResourceRecords(await cdnfly.request('GET', withQuery('/v1/monitor/usage', query)), upstreamIds) };
  }

  if (path === '/monitor/usage-count' && req.method === 'GET') {
    const range = cleanQuery(url); validateUsageRange(range);
    const start = range.get('start'); const end = range.get('end');
    const siteRows = await ownedSites(db, user.id); const streamRows = await ownedStreamMappings(db, user.id);
    const groups = upstreams ? [...new Set([...siteRows, ...streamRows].map(row => Number(row.upstream_account_id)))] : [null];
    const values = { siteBw: [], streamBw: [], siteTraffic: [], streamTraffic: [], siteReq: [], streamReq: [], blackip: [] };
    for (const accountId of groups) {
      const client = upstreams ? await upstreams.clientForAccount(accountId) : cdnfly;
      const sites = siteRows.filter(row => !upstreams || Number(row.upstream_account_id) === accountId).map(row => row.upstream_id);
      const streams = streamRows.filter(row => !upstreams || Number(row.upstream_account_id) === accountId).map(row => row.upstream_id);
      const result = await Promise.all([
        usageFor(client, 'bandwidth', 'site', sites, start, end), usageFor(client, 'bandwidth', 'stream', streams, start, end),
        usageFor(client, 'traffic', 'site', sites, start, end), usageFor(client, 'traffic', 'stream', streams, start, end),
        usageFor(client, 'req', 'site', sites, start, end), usageFor(client, 'req', 'stream', streams, start, end),
        usageFor(client, 'blackip', 'site', sites, start, end),
      ]);
      ['siteBw','streamBw','siteTraffic','streamTraffic','siteReq','streamReq','blackip'].forEach((key, index) => values[key].push(...result[index]));
    }
    const { siteBw, streamBw, siteTraffic, streamTraffic, siteReq, streamReq, blackip } = values;
    return { status: 200, data: {
      bandwidth_value: Math.max(0, ...siteBw, ...streamBw),
      traffic_value: [...siteTraffic, ...streamTraffic].reduce((sum, value) => sum + value, 0),
      req_value: [...siteReq, ...streamReq].reduce((sum, value) => sum + value, 0),
      blackip_value: blackip.reduce((sum, value) => sum + value, 0),
    } };
  }

  if (path === '/node-traffic' && req.method === 'GET') throw httpError('节点总流量无法限定到当前客户的数据范围', 403);

  if (path === '/log/login' && req.method === 'GET') return { status: 200, data: await localAudit(db, user.id, true, url) };
  if (path === '/log/op' && req.method === 'GET') return { status: 200, data: await localAudit(db, user.id, false, url) };

  if (path === '/jobs' && req.method === 'GET') {
    const clients = upstreams ? await upstreams.clientsForUser(user.id) : [cdnfly]; const items = [];
    for (const client of clients) { const data = await listJobs(db, client, user, url); const ref = findCollection(data); items.push(...(ref?.items || (Array.isArray(data) ? data : []))); }
    return { status: 200, data: { count: items.length, items } };
  }
  if (path === '/jobs' && req.method === 'POST') {
    const body = await readBody(req); const items = Array.isArray(body) ? body : [body];
    const clean = await Promise.all(items.map(item => prepareJob(db, user, item)));
    const sites = await ownedSites(db, user.id);
    // Resolve the upstream from the original local identifiers and URL hosts.
    // `prepareJob` translates site IDs to upstream IDs, so resolving only after
    // translation can silently fall back to the wrong account in multi-upstream
    // tenants.
    const referenced = [...new Map(items.flatMap(item => jobReferencedSites(item?.data, sites)).map(site => [site.id, site])).values()];
    if (upstreams && new Set(referenced.map(site => Number(site.upstream_account_id))).size > 1) throw httpError('一次只能向同一 CDN 服务提交任务', 409);
    if (upstreams && new Set(referenced.map(site => Number(site.subscription_id)).filter(Number.isInteger)).size > 1) throw httpError('一次只能向同一套餐提交任务', 409);
    if (upstreams && !referenced.length && (await upstreams.clientsForUser(user.id)).length > 1) throw httpError('任务必须指定当前租户的网站或 URL', 400);
    const upstreamClient = upstreams && referenced.length ? await upstreams.clientForSite(referenced[0]) : (upstreams ? await upstreams.defaultClient(user.id) : cdnfly);
    const upstream = await upstreamClient.request('POST', '/v1/jobs', Array.isArray(body) ? clean : clean[0]);
    const upstreamIds = tenantProxyInternals.parseIds(upstream);
    if (upstreamIds.length !== clean.length) throw httpError('CDN 服务返回的任务 ID 数量不匹配', 502);
    const localIds = await Promise.all(upstreamIds.map(async id => {
      const localId = await tenantProxyInternals.saveResource(db, 'jobs', id, user.id, null, false, upstreamClient.accountId);
      const subscriptionId = referenced[0]?.subscription_id;
      if (subscriptionId) await db.prepare('UPDATE tenant_resources SET subscription_id=? WHERE id=? AND owner_id=?').run(subscriptionId, localId, user.id);
      return localId;
    }));
    return { status: 201, data: localIds, action: 'job.create', resourceId: localIds.join(',') };
  }

  return null;
}

export const dataProxyInternals = { normalizeSiteTopQuery, normalizeStreamTopQuery, prepareJob };
