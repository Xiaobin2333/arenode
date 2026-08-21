import { resolveCname as resolveDnsCname } from 'node:dns/promises';
import { validateDomain, validateOrigin } from './validation.js';
import { normalizeCdnflyUrl } from './compat-path.js';
import { ensureCustomerUpstreamGroups } from './customer-groups.js';
import { applyUserDefaults } from './user-defaults.js';
import { OWNERSHIP_REMARK_KINDS, exposeOwnershipRemark, ownershipMarker, ownershipRemark } from './resource-ownership.js';

const RESOURCE_KINDS = new Set([
  'site-groups', 'certs', 'dnsapis', 'cc-filters', 'cc-matchs', 'cc-rules', 'waf-rules',
  'acls', 'stream-groups', 'streams',
]);

const CERTIFICATE_TYPES = new Set(['custom', 'lets', 'zerossl', 'buypass']);
const DNS_API_AUTH_FIELDS = new Map([
  ['CloudFlare', ['CF_Key', 'CF_Email']],
  ['DNSPod.cn', ['DP_Id', 'DP_Key']],
  ['DNSPod.com', ['DPI_Id', 'DPI_Key']],
  ['GoDaddy.com', ['GD_Key', 'GD_Secret']],
  ['Aliyun', ['Ali_Key', 'Ali_Secret']],
  ['cloudns.net', ['CLOUDNS_SUB_AUTH_ID', 'CLOUDNS_AUTH_PASSWORD']],
  ['Name.com', ['Namecom_Username', 'Namecom_Token']],
  ['Namecheap', ['NAMECHEAP_USERNAME', 'NAMECHEAP_API_KEY', 'NAMECHEAP_SOURCEIP']],
  ['jdcloud.com', ['JD_ACCESS_KEY_ID', 'JD_ACCESS_KEY_SECRET']],
  ['DNS.LA', ['LA_Ak', 'LA_Sk']],
  ['Namesilo.com', ['Namesilo_Key']],
  ['51DNS.COM', ['dns_com_key', 'dns_com_secret']],
  ['huaweicloud.com', ['huaweicloud_access_key_id', 'huaweicloud_serect_access_key']],
]);
const STREAM_PROTOCOLS = new Set(['tcp', 'udp']);
const STREAM_BALANCE_WAYS = new Set(['rr', 'ip_hash']);
const ACL_ACTIONS = new Set(['allow', 'reject']);
const ACL_REJECT_CODES = new Set(['302', '403']);
const ACL_MATCH_ITEMS = new Set([
  'count404', 'uniq_ua', 'header', 'ip', 'host', 'accept_language', 'user_agent',
  'referer', 'uri', 'req_uri', 'req_method', 'country_iso_code', 'asnumber',
  'province', 'city', 'isp', 'protocol', 'tls_fp', 'uniq_tls_fp', 'server_port',
]);
const ACL_OPERATORS = new Set([
  '=', '!=', '>', 'contain', '!contain', 'prefix', 'suffix', 'regex', '!regex',
  'exists', '!exists', 'ip_range', '!ip_range',
]);
const TLS_PROTOCOLS = new Set(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);
const DEFAULT_TLS_PROTOCOLS = 'TLSv1.2 TLSv1.3';
const DEFAULT_SSL_CIPHERS = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';
const CAPABILITY_TTL_MS = 5 * 60_000;
const capabilityCache = new WeakMap();

const FORBIDDEN_FIELDS = new Set([
  'uid', 'new_uid', 'user_package', 'user_package_id', 'internal', 'internal_self',
  'share', 'share_uid', 'scope_uid', 'owner_id', 'user_id', 'subscription_id', 'subscriptionId',
]);

const REFERENCE_FIELDS = new Map([
  ['groups', 'site-groups'],
  ['group_id', 'site-groups'],
  ['site_group', 'site-groups'],
  ['cert', 'certs'],
  ['cert_id', 'certs'],
  ['dns_api', 'dnsapis'],
  ['dnsapi', 'dnsapis'],
  ['dnsapi_id', 'dnsapis'],
  ['cc_default_rule', 'cc-rules'],
  ['cc_rule', 'cc-rules'],
  ['cc_rule_id', 'cc-rules'],
  ['filter_id', 'cc-filters'],
  ['cc_filter_id', 'cc-filters'],
  ['match_id', 'cc-matchs'],
  ['matcher_id', 'cc-matchs'],
  ['cc_match_id', 'cc-matchs'],
  ['waf_rule_id', 'waf-rules'],
]);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function supportsWafRules(client) {
  const cached = capabilityCache.get(client)?.wafRules;
  if (cached && Date.now() - cached.checkedAt < CAPABILITY_TTL_MS) return cached.supported;
  try {
    await client.request('GET', '/v1/waf-rules');
    capabilityCache.set(client, { ...(capabilityCache.get(client) || {}), wafRules: { supported: true, checkedAt: Date.now() } });
    return true;
  } catch (error) {
    if (Number(error?.upstreamStatus) !== 404) return true;
    capabilityCache.set(client, { ...(capabilityCache.get(client) || {}), wafRules: { supported: false, checkedAt: Date.now() } });
    return false;
  }
}

async function supportsAttackLogs(client, site) {
  const cached = capabilityCache.get(client)?.attackLogs;
  if (cached && Date.now() - cached.checkedAt < CAPABILITY_TTL_MS) return cached.supported;
  const domain = String(site?.domain || '').split(/[\s,]+/).map(item => item.trim()).find(Boolean);
  if (!domain) return true;
  const end = new Date(); const start = new Date(end.getTime() - 60 * 60_000);
  const time = value => value.toISOString().slice(0, 19).replace('T', ' ');
  const query = new URLSearchParams({ domain, start: time(start), end: time(end) });
  try {
    await client.request('GET', `/v1/monitor/site/attack-log?${query}`);
    capabilityCache.set(client, { ...(capabilityCache.get(client) || {}), attackLogs: { supported: true, checkedAt: Date.now() } });
    return true;
  } catch (error) {
    if (Number(error?.upstreamStatus) !== 404) return true;
    capabilityCache.set(client, { ...(capabilityCache.get(client) || {}), attackLogs: { supported: false, checkedAt: Date.now() } });
    return false;
  }
}

async function userSupportsWafRules(upstreams, cdnfly, userId) {
  const clients = upstreams ? await upstreams.clientsForUser(userId) : [cdnfly];
  const supported = await Promise.all(clients.map(supportsWafRules));
  return supported.length > 0 && supported.every(Boolean);
}

function unsupportedWaf() {
  return httpError('当前 CDN 服务未提供 WAF 规则库功能', 501);
}

function isCompleteCname(value) {
  const candidate = normalizeCname(value);
  return Boolean(candidate && candidate.includes('.') && !/^\d+(?:\.\d+)*$/.test(candidate));
}

function cnameDomainValue(value) {
  return isCompleteCname(value) ? normalizeCname(value) : '';
}

function extractCname(value, fallback = '', resolvedDomain = '') {
  const previous = isCompleteCname(fallback) ? normalizeCname(fallback) : '';
  if (typeof value === 'string') {
    const candidate = normalizeCname(value);
    if (previous && candidate && (previous === candidate || previous.endsWith(`.${candidate}`) || previous.startsWith(`${candidate}.`))) return previous;
    return isCompleteCname(candidate) ? candidate : previous;
  }
  if (!value || typeof value !== 'object') return previous;

  const preferFull = candidate => {
    const normalized = normalizeCname(candidate);
    return previous && normalized && previous !== normalized && previous.endsWith(`.${normalized}`) ? previous : normalized;
  };
  const rawDomain = value.cname_domain ?? value.cnameDomain ?? value.cname_suffix ?? value.cnameSuffix;
  const suffix = cnameDomainValue(rawDomain) || cnameDomainValue(resolvedDomain);
  const hostname = normalizeCname(value.cname_hostname ?? value.cnameHostname);
  const combine = (hostValue, domainValue = suffix) => {
    const host = normalizeCname(hostValue);
    const domain = cnameDomainValue(domainValue) || cnameDomainValue(resolvedDomain);
    if (!host) return previous || domain;
    if (isCompleteCname(host)) return preferFull(host);
    if (!domain) return previous;
    return `${host}.${domain}`;
  };

  for (const key of ['cname_full', 'cnameFull', 'cname_fqdn', 'cnameFqdn', 'cname_record', 'cnameRecord', 'cname_target', 'cnameTarget']) {
    if (typeof value[key] === 'string' && isCompleteCname(value[key])) return preferFull(value[key]);
  }
  if (typeof value.cname === 'string' && isCompleteCname(value.cname)) {
    const candidate = normalizeCname(value.cname);
    if (!hostname || candidate.startsWith(`${hostname}.`) || !suffix) return preferFull(candidate);
  }
  if (typeof value.cname === 'string' && value.cname.trim()) {
    const candidate = normalizeCname(value.cname);
    if (!(hostname && suffix && candidate === suffix)) {
      const combined = combine(candidate, suffix);
      if (combined) return combined;
    }
  }
  if (value.cname && typeof value.cname === 'object') {
    const nested = value.cname;
    const nestedHost = nested.hostname ?? nested.host ?? nested.cname_hostname ?? nested.cnameHostname ?? nested.target;
    const nestedDomain = nested.domain ?? nested.suffix ?? nested.cname_domain ?? nested.cnameDomain ?? suffix;
    const combined = combine(nestedHost, nestedDomain);
    if (combined) return combined;
  }
  if (hostname) {
    const combined = combine(hostname, suffix);
    if (combined) return combined;
  }
  for (const key of ['data', 'result', 'site', 'item', 'record', 'payload']) {
    const nested = value[key] && typeof value[key] === 'object' ? extractCname(value[key], fallback, suffix || resolvedDomain) : '';
    if (nested) return nested;
  }
  for (const [key, candidate] of Object.entries(value)) if (/cname/i.test(key)) {
    if (['cname_full', 'cnameFull', 'cname_fqdn', 'cnameFqdn', 'cname_record', 'cnameRecord', 'cname', 'cname_target', 'cnameTarget', 'cname_hostname', 'cnameHostname', 'cname_domain', 'cnameDomain', 'cname_suffix', 'cnameSuffix'].includes(key)) continue;
    if (typeof candidate === 'string' && isCompleteCname(candidate)) return preferFull(candidate);
    if (candidate && typeof candidate === 'object') {
      const nested = extractCname(candidate, fallback, suffix || resolvedDomain);
      if (nested) return nested;
    }
  }
  return previous || suffix;
}

function normalizeCname(candidate) {
  const text = String(candidate || '').trim().replace(/\.$/, '').replace(/\/$/, '');
  if (!text) return '';
  try { return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname.replace(/\.$/, ''); }
  catch { return text.split('/')[0].replace(/\.$/, ''); }
}

function extractCompleteCname(value, fallback = '', resolvedDomain = '') {
  const previous = isCompleteCname(fallback) ? normalizeCname(fallback) : '';
  const cname = extractCname(value, fallback, resolvedDomain);
  // `cname_domain` is either a suffix or a configuration ID. It is not a
  // usable CNAME target by itself. With no target in the current response,
  // keep the last complete snapshot instead of promoting the suffix.
  if (value && typeof value === 'object' && !hasCnameTarget(value, resolvedDomain)) return previous;
  return isCompleteCname(cname) ? cname : '';
}

function hasCnameTarget(value, resolvedDomain = '') {
  if (typeof value === 'string') return isCompleteCname(value);
  if (!value || typeof value !== 'object') return false;
  const rawDomain = value.cname_domain ?? value.cnameDomain ?? value.cname_suffix ?? value.cnameSuffix;
  const suffix = cnameDomainValue(rawDomain) || cnameDomainValue(resolvedDomain);
  if (normalizeCname(value.cname_hostname ?? value.cnameHostname)) return true;
  for (const key of ['cname_full', 'cnameFull', 'cname_fqdn', 'cnameFqdn', 'cname_record', 'cnameRecord', 'cname_target', 'cnameTarget']) {
    if (isCompleteCname(value[key])) return true;
  }
  if (typeof value.cname === 'string') {
    const candidate = normalizeCname(value.cname);
    // CDNFly can return the generated hostname in `cname` and the suffix in
    // `cname_domain`. A non-empty hostname paired with a suffix is a complete
    // target even when the hostname itself contains no dot.
    if (candidate && ((suffix && candidate !== suffix) || isCompleteCname(candidate))) return true;
  }
  if (value.cname && typeof value.cname === 'object') {
    const nested = value.cname;
    if (normalizeCname(nested.hostname ?? nested.host ?? nested.cname_hostname ?? nested.cnameHostname ?? nested.target)) return true;
  }
  for (const key of ['data', 'result', 'site', 'item', 'record', 'payload']) {
    if (hasCnameTarget(value[key], suffix || resolvedDomain)) return true;
  }
  return false;
}

function cnameDomainId(value) {
  if (!value || typeof value !== 'object') return '';
  const raw = value.cname_domain ?? value.cnameDomain;
  if ((typeof raw === 'number' && Number.isInteger(raw)) || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) return String(raw).trim();
  for (const key of ['data', 'result', 'site', 'item', 'record', 'payload']) {
    const nested = cnameDomainId(value[key]);
    if (nested) return nested;
  }
  return '';
}

function findCnameDomain(value, targetId = '', path = '') {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCnameDomain(item, targetId, path);
      if (found) return found;
    }
    return '';
  }
  const explicitId = value.cname_domain_id ?? value.cnameDomainId;
  const contextualId = /cname/.test(path)
    ? (value.id ?? ((typeof value.value === 'number' || /^\d+$/.test(String(value.value || ''))) ? value.value : undefined))
    : undefined;
  const rawOwnId = explicitId ?? contextualId;
  if ((!targetId && /cname/.test(path)) || String(rawOwnId ?? '') === String(targetId)) {
    for (const key of ['domain', 'cname', 'hostname', 'host', 'name', 'label']) {
      const candidate = cnameDomainValue(value[key]);
      if (candidate) return candidate;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${path}.${key}`.toLowerCase();
    if (targetId && /cname/.test(nextPath) && String(key) === String(targetId)) {
      const direct = cnameDomainValue(child);
      if (direct) return direct;
    }
    if (child && typeof child === 'object') {
      const found = findCnameDomain(child, targetId, nextPath);
      if (found) return found;
    } else if (/cname/.test(nextPath)) {
      const candidate = cnameDomainValue(child);
      if (candidate) return candidate;
    }
  }
  return '';
}

async function resolveCnameDomain(client, domainId, ...payloads) {
  const configured = cnameDomainValue(client?.cnameSuffix);
  if (configured) return configured;
  for (const payload of payloads) {
    const found = findCnameDomain(payload, domainId);
    if (found) return found;
  }
  return '';
}

async function resolveCompleteCname(client, value, fallback = '', ...payloads) {
  const domainId = cnameDomainId(value);
  const resolvedDomain = domainId || client?.cnameSuffix
    ? await resolveCnameDomain(client, domainId, ...payloads, value)
    : '';
  return extractCompleteCname(value, fallback, resolvedDomain);
}

function stripForbidden(value) {
  if (Array.isArray(value)) return value.map(stripForbidden);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_FIELDS.has(key)) output[key] = stripForbidden(child);
  }
  return output;
}

function parseIds(value) {
  if (Array.isArray(value)) return value.flatMap(parseIds);
  if (value && typeof value === 'object') return parseIds(value.id ?? value.ids ?? value.data ?? value.result ?? '');
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

async function resourceByLocal(db, kind, localId, ownerId, { allowShared = false } = {}) {
  const id = Number.parseInt(localId, 10);
  if (!Number.isInteger(id) || id < 1) return null;
  const row = await db.prepare('SELECT * FROM tenant_resources WHERE id = ? AND kind = ?').get(id, kind);
  if (!row || (row.owner_id !== ownerId && !(allowShared && row.shared))) return null;
  return row;
}

async function resourceByUpstream(db, kind, upstreamId, ownerId, { allowShared = false, upstreamAccountId = null } = {}) {
  const row = upstreamAccountId
    ? await db.prepare('SELECT * FROM tenant_resources WHERE kind = ? AND upstream_id = ? AND upstream_account_id=?').get(kind, String(upstreamId), Number(upstreamAccountId))
    : await db.prepare('SELECT * FROM tenant_resources WHERE kind = ? AND upstream_id = ? AND upstream_account_id IS NULL').get(kind, String(upstreamId));
  if (!row || (row.owner_id !== ownerId && !(allowShared && row.shared))) return null;
  return row;
}

function persistedResourceSnapshot(kind, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  let value = exposeResourceRecord(kind, stripForbidden(clone(snapshot)));
  if (kind === 'certs') value = redactCertificate(value);
  if (kind === 'dnsapis') value = redactDnsApi(value);
  try { return JSON.stringify(value); }
  catch { return null; }
}

function mergeResourceSnapshot(kind, previous, incoming) {
  if (kind !== 'acls' || !previous || typeof previous !== 'object' || Array.isArray(previous)
    || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const merged = { ...previous, ...incoming };
  const previousRules = Array.isArray(previous.data) ? previous.data : [];
  const incomingRules = Array.isArray(incoming.data) ? incoming.data : [];
  if (previousRules.length && !incomingRules.length) merged.data = clone(previousRules);
  return merged;
}

async function saveResource(db, kind, upstreamId, ownerId, snapshot = null, shared = false, upstreamAccountId = null) {
  const existing = upstreamAccountId
    ? await db.prepare('SELECT * FROM tenant_resources WHERE kind = ? AND upstream_id = ? AND upstream_account_id=?').get(kind, String(upstreamId), Number(upstreamAccountId))
    : await db.prepare('SELECT * FROM tenant_resources WHERE kind = ? AND upstream_id = ? AND upstream_account_id IS NULL').get(kind, String(upstreamId));
  const mergedSnapshot = mergeResourceSnapshot(kind, resourceSnapshot(existing), snapshot);
  const snapshotText = persistedResourceSnapshot(kind, mergedSnapshot);
  const rawEnabled = mergedSnapshot?.enable ?? mergedSnapshot?.enabled;
  const enabled = [1, true, '1', 'true', 'on', 'active', 'enabled'].includes(rawEnabled) ? 1
    : [0, false, '0', 'false', 'off', 'disabled'].includes(rawEnabled) ? 0 : null;
  if (existing) {
    if (!existing.shared && existing.owner_id !== ownerId) throw httpError('该 CDN 资源已归属于其他账户', 409);
    await db.prepare('UPDATE tenant_resources SET snapshot=COALESCE(?,snapshot),enabled=COALESCE(?,enabled),updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(snapshotText, enabled, existing.id);
    return existing.id;
  }
  return Number((await db.prepare(`INSERT INTO tenant_resources (owner_id, kind, upstream_id, shared, snapshot, upstream_account_id, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(shared ? null : ownerId, kind, String(upstreamId), Number(shared), snapshotText, upstreamAccountId || null, enabled)).lastInsertRowid);
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

async function syncSiteCnames(db, sites, upstreams, cdnfly) {
  const rows = (sites || []).filter(site => site?.upstream_id);
  if (!rows.length) return sites || [];
  const groups = new Map();
  for (const site of rows) {
    // A single CDNFly account may expose more than one purchased package;
    // each package can return a different site view and CNAME assignment.
    const key = upstreams ? `account:${site.upstream_account_id || 'legacy'}|subscription:${site.subscription_id || 'legacy'}` : 'legacy';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(site);
  }
  for (const grouped of groups.values()) {
    try {
      const client = upstreams ? await upstreams.clientForSite(grouped[0]) : cdnfly;
      const payload = await client.request('GET', '/v1/sites?page=1&page_size=1000');
      const ref = findCollection(payload);
      const records = ref?.items || (Array.isArray(payload) ? payload : []);
      const byId = new Map(records.map(record => [String(record.id), record]));
      const domainCache = new Map();
      for (const site of grouped) {
        const record = byId.get(String(site.upstream_id));
        let syncedRecord = record || {};
        const knownCname = normalizeCname(site.cname);
        const domainId = cnameDomainId(record);
        let resolvedDomain = domainCache.get(domainId) || '';
        if (domainId && !resolvedDomain) {
          resolvedDomain = await resolveCnameDomain(client, domainId, payload, record);
          if (resolvedDomain) domainCache.set(domainId, resolvedDomain);
        }
        const freshRecordCname = extractCompleteCname(record, '', resolvedDomain);
        let cname = freshRecordCname || knownCname;
        if (!record || !freshRecordCname) {
          try {
            const detail = await client.request('GET', `/v1/sites/${encodeURIComponent(site.upstream_id)}`);
            syncedRecord = detail || syncedRecord;
            const detailDomainId = cnameDomainId(detail) || domainId;
            let detailDomain = domainCache.get(detailDomainId) || resolvedDomain;
            if (!detailDomain && detailDomainId) {
              detailDomain = await resolveCnameDomain(client, detailDomainId, payload, record, detail);
              if (detailDomain) domainCache.set(detailDomainId, detailDomain);
            }
            const detailCname = extractCompleteCname(detail, cname, detailDomain);
            if (detailCname) cname = detailCname;
          } catch {}
        }
        const upstreamEnabled = syncedRecord.enable ?? syncedRecord.enabled;
        if (upstreamEnabled !== undefined) site.upstream_enabled = upstreamEnabled;
        const upstreamState = syncedRecord.sync_state ?? syncedRecord.syncState ?? syncedRecord.status ?? syncedRecord.state;
        if (upstreamState !== undefined) site.upstream_state = upstreamState;
        const https = syncedRecord.https_listen;
        if (https && typeof https === 'object' && !Array.isArray(https)) {
          const value = https.ok ?? https.enable ?? Boolean(https.cert);
          site.https_enabled = [1, true, '1', 'true', 'on', 'enabled', 'active'].includes(value);
        }
        const listenPorts = [];
        const http = syncedRecord.http_listen;
        if (http && typeof http === 'object' && !Array.isArray(http)
          && ![0, false, '0', 'false', 'off', 'disabled'].includes(http.enable)) {
          listenPorts.push(`HTTP:${http.port || '80'}`);
        }
        if (site.https_enabled) listenPorts.push(`HTTPS:${https.port || '443'}`);
        if (listenPorts.length) site.listen_ports = listenPorts.join(' · ');
        if (cname !== normalizeCname(site.cname)) {
          await db.prepare('UPDATE sites SET cname=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(cname || null, site.id);
          site.cname = cname || null;
        }
      }
    } catch {
      // Listing remains available from the local snapshot when upstream sync fails.
    }
  }
  return sites || [];
}

function setCollection(root, ref, items) {
  if (!ref) return items;
  if (ref.parent === null) return items;
  ref.parent[ref.key] = items;
  for (const target of new Set([root, ref.parent])) {
    for (const key of ['count', 'total', 'total_count']) if (typeof target?.[key] === 'number') target[key] = items.length;
  }
  return root;
}

function isSharedWaf(record) {
  const scope = String(record.scope ?? record.rule_scope ?? record.type ?? '').toLowerCase();
  const uid = record.uid ?? record.user_id ?? record.owner_id;
  return [0, '0', null].includes(uid) || ['global', 'system', 'builtin', 'subscription'].includes(scope);
}

function publicRecord(record, localId, shared = false) {
  if (!record || typeof record !== 'object') return record;
  const output = { ...record, id: localId, _shared: Boolean(shared) };
  for (const field of FORBIDDEN_FIELDS) delete output[field];
  return output;
}

function ownershipPayload(kind, client, userId, record, previous = null) {
  if (!OWNERSHIP_REMARK_KINDS.has(kind) || !record || typeof record !== 'object' || Array.isArray(record)) return record;
  const output = { ...record };
  const customerRemark = Object.hasOwn(output, 'des') ? output.des
    : Object.hasOwn(output, 'description') ? output.description
      : previous?.des ?? previous?.description ?? '';
  output.des = ownershipRemark(client, userId, customerRemark);
  delete output.description;
  return output;
}

function exposeResourceRecord(kind, record) {
  if (Array.isArray(record)) return record.map(item => exposeResourceRecord(kind, item));
  const exposed = OWNERSHIP_REMARK_KINDS.has(kind) ? exposeOwnershipRemark(record) : record;
  if (kind === 'certs') return redactCertificate(exposed);
  if (kind === 'dnsapis') return redactDnsApi(exposed);
  return exposed;
}

async function markOwnershipPersisted(db, kind, localId, client, userId) {
  if (!OWNERSHIP_REMARK_KINDS.has(kind)) return;
  await db.prepare('UPDATE tenant_resources SET ownership_marker=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?')
    .run(ownershipMarker(client, userId), Number(localId), Number(userId));
}

function redactCertificate(value) {
  if (!value || typeof value !== 'object') return value;
  const output = { ...value };
  let configured = false;
  for (const field of ['key', 'private_key', 'privateKey']) {
    if (Object.hasOwn(output, field)) {
      configured = configured || Boolean(output[field]);
      delete output[field];
    }
  }
  for (const field of ['task_ret', 'taskRet', 'task_log', 'taskLog', 'acme_log', 'acmeLog', 'debug_log', 'debugLog']) delete output[field];
  if (output.cert && typeof output.cert === 'object') output.cert = redactCertificate(output.cert);
  if (configured) output.key_configured = true;
  return output;
}

function redactDnsApi(value) {
  if (!value || typeof value !== 'object') return value;
  const output = { ...value };
  const auth = output.auth && typeof output.auth === 'object' ? output.auth : null;
  if (auth) {
    output.auth_configured = Object.values(auth).some(Boolean);
    output.auth_keys = Object.keys(auth).slice(0, 8);
    delete output.auth;
  }
  for (const field of ['key', 'secret', 'token', 'api_key', 'api_secret']) {
    if (!Object.hasOwn(output, field)) continue;
    output.auth_configured = output.auth_configured || Boolean(output[field]);
    delete output[field];
  }
  return output;
}

function resourceSnapshot(mapping) {
  if (!mapping?.snapshot) return null;
  if (typeof mapping.snapshot === 'object') return clone(mapping.snapshot);
  try { return JSON.parse(mapping.snapshot); }
  catch { return null; }
}

function cleanText(value, label, { required = false, max = 240 } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw httpError(`${label}必填`);
  if (text.length > max) throw httpError(`${label}不能超过 ${max} 个字符`);
  return text;
}

function validatePrivateKeyPem(value) {
  const text = String(value || '').trim();
  const match = text.match(/^-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----/);
  if (!match || !text.endsWith(`-----END ${match[1]}-----`)) throw httpError('证书私钥 PEM 格式无效');
  return text;
}

function validateCertificatePem(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('-----BEGIN CERTIFICATE-----') || !text.endsWith('-----END CERTIFICATE-----')) {
    throw httpError('证书正文 PEM 格式无效');
  }
  return text;
}

function validateCertificateDomains(value) {
  const domains = String(value || '').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!domains.length) throw httpError('签发域名必填');
  for (const domain of domains) validateDomain(domain.startsWith('*.') ? domain.slice(2) : domain);
  return { value: domains.join(' '), wildcard: domains.some(domain => domain.startsWith('*.')) };
}

function sanitizeCertificateInput(item, { partial = false, existing = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError('证书配置必须是对象');
  const output = {};
  const has = field => Object.hasOwn(item, field);
  if (!partial || has('name')) output.name = cleanText(item.name, '证书名称', { required: true, max: 120 });
  if (has('des')) output.des = cleanText(item.des, '证书备注');
  if (has('enable')) output.enable = normalizeEnabled(item.enable);
  const existingType = CERTIFICATE_TYPES.has(String(existing?.type || '')) ? String(existing.type) : '';
  const type = has('type') ? String(item.type || '').trim() : existingType;
  if (!partial || has('type')) {
    if (!CERTIFICATE_TYPES.has(type)) throw httpError('证书类型无效');
    output.type = type;
  }
  const effectiveType = type || existingType;
  if (!partial && !effectiveType) throw httpError('证书类型必填');

  if (effectiveType === 'custom') {
    const hasKey = has('key') && String(item.key || '').trim();
    const hasCert = has('cert') && String(item.cert || '').trim();
    const switchingToCustom = has('type') && existingType !== 'custom';
    if ((!partial || switchingToCustom) && (!hasKey || !hasCert)) throw httpError('上传证书必须同时提供私钥和证书正文');
    if (Boolean(hasKey) !== Boolean(hasCert)) throw httpError('替换上传证书时必须同时提供私钥和证书正文');
    if (hasKey && hasCert) {
      output.key = validatePrivateKeyPem(item.key);
      output.cert = validateCertificatePem(item.cert);
    }
    return output;
  }

  if (has('auto_renew')) output.auto_renew = normalizeEnabled(item.auto_renew);

  const domainSource = has('domain') ? item.domain : existing?.domain;
  if (!partial || has('domain') || (has('type') && effectiveType)) {
    const domains = validateCertificateDomains(domainSource);
    output.domain = domains.value;
    const dnsapi = has('dnsapi') ? item.dnsapi : existing?.dnsapi;
    if (dnsapi !== undefined && dnsapi !== null && dnsapi !== '') {
      const id = Number(dnsapi);
      if (!Number.isInteger(id) || id < 1) throw httpError('DNS API 资源无效');
      if (has('dnsapi')) output.dnsapi = id;
    } else if (domains.wildcard) {
      throw httpError('通配符证书必须选择 DNS API');
    }
  } else if (has('dnsapi')) {
    const id = Number(item.dnsapi);
    if (!Number.isInteger(id) || id < 1) throw httpError('DNS API 资源无效');
    output.dnsapi = id;
  }
  return output;
}

function sanitizeDnsApiInput(item, { partial = false, existing = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError('DNS API 配置必须是对象');
  const output = {};
  const has = field => Object.hasOwn(item, field);
  if (!partial || has('name')) output.name = cleanText(item.name, 'DNS API 名称', { required: true, max: 120 });
  if (has('des')) output.des = cleanText(item.des, 'DNS API 备注');
  const previousType = DNS_API_AUTH_FIELDS.has(String(existing?.type || '')) ? String(existing.type) : '';
  const type = has('type') ? String(item.type || '').trim() : previousType;
  if (!partial || has('type')) {
    if (!DNS_API_AUTH_FIELDS.has(type)) throw httpError('不支持的 DNS 服务商');
    output.type = type;
  }
  if (!partial && !type) throw httpError('DNS 服务商必填');
  const providerChanged = has('type') && type !== previousType;
  if (has('auth')) {
    if (!item.auth || typeof item.auth !== 'object' || Array.isArray(item.auth)) throw httpError('DNS API 凭据格式无效');
    const requiredKeys = DNS_API_AUTH_FIELDS.get(type) || [];
    const suppliedKeys = Object.keys(item.auth);
    if (suppliedKeys.length !== requiredKeys.length || suppliedKeys.some(key => !requiredKeys.includes(key))) {
      throw httpError(`${type} DNS API 凭据字段无效`);
    }
    output.auth = Object.fromEntries(requiredKeys.map(key => {
      const value = cleanText(item.auth[key], `${key} 凭据`, { required: true, max: 512 });
      return [key, value];
    }));
  } else if (!partial || providerChanged) {
    throw httpError('DNS API 凭据必填');
  }
  return output;
}

function normalizeEnabled(value) {
  if ([1, true, '1', 'true', 'on'].includes(value)) return 1;
  if ([0, false, '0', 'false', 'off'].includes(value)) return 0;
  throw httpError('启用状态无效');
}

function aclAction(value, label) {
  const action = String(value || '').trim();
  if (!ACL_ACTIONS.has(action)) throw httpError(`${label}无效`);
  return action;
}

function aclRejectCode(value, fallback = '403') {
  const empty = value === undefined || value === null || String(value).trim() === '' || Number(value) === 0;
  const code = String(empty ? fallback : value).trim();
  if (!ACL_REJECT_CODES.has(code)) throw httpError('ACL 拒绝码只支持 403 或 302');
  return code;
}

function aclRedirectUrl(value, { required = false } = {}) {
  const text = cleanText(value, '跳转 URL', { required, max: 2048 });
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); }
  catch { throw httpError('跳转 URL 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError('跳转 URL 只支持 HTTP 或 HTTPS');
  return text;
}

function sanitizeAclMatcher(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('ACL 匹配规则必须是对象');
  const matchItem = String(value.item ?? value.match_item ?? '').trim();
  const operator = String(value.op ?? value.operator ?? '').trim();
  if (!ACL_MATCH_ITEMS.has(matchItem)) throw httpError('ACL 匹配项无效');
  if (!ACL_OPERATORS.has(operator)) throw httpError('ACL 操作符无效');
  const rawValue = Array.isArray(value.value) ? value.value.join('\n') : value.value;
  if (!['string', 'number'].includes(typeof rawValue) && rawValue !== undefined && rawValue !== null) throw httpError('ACL 比较值必须是文本');
  const matcherValue = cleanText(rawValue, 'ACL 比较值', { max: 32768 });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(matcherValue)) throw httpError('ACL 比较值不能包含控制字符');
  if (!['exists', '!exists'].includes(operator) && !matcherValue) throw httpError('ACL 比较值必填');
  return { item: matchItem, op: operator, value: matcherValue };
}

function sanitizeAclRule(value, { legacy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('ACL 规则必须是对象');
  const rawAction = String(value.acl_action ?? value.action ?? '').trim().toLowerCase();
  const action = rawAction === 'allow' ? 'allow' : rawAction === 'reject' || ACL_REJECT_CODES.has(rawAction) ? 'reject' : '';
  if (!action) throw httpError('ACL 命中动作只支持允许、403 拒绝或 302 跳转');
  const matcherSource = legacy ? [value] : value.acl_matcher;
  if (!Array.isArray(matcherSource) || !matcherSource.length) throw httpError('每条 ACL 规则至少需要一个匹配条件');
  const output = { acl_action: action, acl_matcher: matcherSource.map(sanitizeAclMatcher) };
  if (action === 'reject') {
    output.acl_code = aclRejectCode(value.acl_code ?? (ACL_REJECT_CODES.has(rawAction) ? rawAction : undefined));
    output.acl_url = output.acl_code === '302'
      ? aclRedirectUrl(value.acl_url ?? value.redirect_url, { required: true })
      : '';
  }
  return output;
}

function sanitizeAclInput(item, { partial = false, existing = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError('ACL 配置必须是对象');
  const output = {};
  const has = field => Object.hasOwn(item, field);
  if (has('id')) {
    const id = Number(item.id);
    if (!Number.isInteger(id) || id < 1) throw httpError('ACL 资源 ID 无效');
    output.id = id;
  }
  if (!partial || has('name')) output.name = cleanText(item.name, 'ACL 名称', { required: true, max: 120 });
  if (!partial || has('des')) output.des = cleanText(item.des, 'ACL 备注');

  const defaultAction = has('default_action')
    ? aclAction(item.default_action, 'ACL 默认动作')
    : ACL_ACTIONS.has(String(existing?.default_action || '')) ? String(existing.default_action) : 'allow';
  if (!partial || has('default_action')) output.default_action = defaultAction;

  const rejectCode = has('reject_code')
    ? aclRejectCode(item.reject_code)
    : aclRejectCode(existing?.reject_code, '403');
  if (!partial || has('reject_code')) output.reject_code = rejectCode;

  const redirectChanged = !partial || has('default_action') || has('reject_code') || has('redirect_url');
  if (redirectChanged) {
    const redirectSource = has('redirect_url') ? item.redirect_url : existing?.redirect_url;
    output.redirect_url = defaultAction === 'reject' && rejectCode === '302'
      ? aclRedirectUrl(redirectSource, { required: true })
      : '';
  }
  if (!partial || has('enable')) output.enable = has('enable') ? normalizeEnabled(item.enable) : 1;
  if (!partial || has('data') || has('matcher')) {
    const legacy = !has('data') && has('matcher');
    const rules = has('data') ? item.data : (has('matcher') ? item.matcher : []);
    if (!Array.isArray(rules)) throw httpError('ACL 规则必须是数组');
    if (!rules.length) throw httpError('ACL 至少需要一条规则');
    if (rules.length > 100) throw httpError('单个 ACL 最多包含 100 条规则');
    output.data = rules.map(rule => sanitizeAclRule(rule, { legacy }));
  }
  return output;
}

function sanitizeStreamInput(item, { partial = false } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError('四层转发配置必须是对象');
  const output = {};
  const has = field => Object.hasOwn(item, field);
  if (has('id')) {
    const id = Number(item.id);
    if (!Number.isInteger(id) || id < 1) throw httpError('四层转发资源 ID 无效');
    output.id = id;
  }
  if (has('des')) output.des = cleanText(item.des, '四层转发名称', { max: 120 });
  const groupField = ['groups', 'groupId', 'group_id', 'stream_group'].find(has);
  if (groupField) {
    const groupValue = item[groupField];
    const groupIds = (Array.isArray(groupValue) ? groupValue : String(groupValue ?? '').split(','))
      .map(value => String(value).trim()).filter(value => value && value !== '0');
    if (groupIds.some(value => !/^\d+$/.test(value) || Number(value) < 1)) throw httpError('四层转发分组无效');
    if (new Set(groupIds).size > 1) throw httpError('四层转发只能选择一个站内分组');
    output.groups = [...new Set(groupIds)].join(',');
  }
  if (!partial || has('listen')) {
    if (!Array.isArray(item.listen) || !item.listen.length) throw httpError('监听端口必填');
    const ports = new Set();
    output.listen = item.listen.map(value => {
      const port = Number(value?.port);
      const protocol = String(value?.protocol || 'tcp').toLowerCase();
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError('监听端口无效');
      if (ports.has(port)) throw httpError('监听端口不能重复');
      if (!STREAM_PROTOCOLS.has(protocol)) throw httpError('监听协议无效');
      ports.add(port);
      return { port, protocol };
    });
  }
  if (!partial || has('backend')) {
    if (!Array.isArray(item.backend) || !item.backend.length) throw httpError('四层源站地址必填');
    output.backend = item.backend.map(value => {
      if (!value?.addr) throw httpError('四层源站地址必填');
      validateOrigin(value.addr);
      const weight = value.weight === undefined ? 1 : Number(value.weight);
      const state = String(value.state || 'up').toLowerCase();
      if (!Number.isInteger(weight) || weight < 1 || weight > 10) throw httpError('四层源站权重无效');
      if (!['up', 'down', 'backup'].includes(state)) throw httpError('四层源站状态无效');
      return { addr: String(value.addr).trim(), weight, state };
    });
    if (!output.backend.some(value => value.state === 'up')) throw httpError('四层转发至少需要一个在线源站');
  }
  if (!partial || has('backend_port')) {
    const port = Number(item.backend_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError('四层源站端口无效');
    output.backend_port = port;
  }
  if (!partial || has('balance_way')) {
    const balanceWay = String(item.balance_way || 'rr').toLowerCase();
    if (!STREAM_BALANCE_WAYS.has(balanceWay)) throw httpError('四层负载方式无效');
    output.balance_way = balanceWay;
  }
  if (!partial || has('enable')) output.enable = has('enable') ? normalizeEnabled(item.enable) : 1;
  return output;
}

function requestedStreamGroup(item) {
  if (!item || typeof item !== 'object') return undefined;
  for (const key of ['groups', 'groupId', 'group_id', 'stream_group']) {
    if (Object.hasOwn(item, key)) return item[key];
  }
  return undefined;
}

async function resolveLocalStreamGroup(db, userId, value, current = null) {
  if (value === undefined) return current === undefined ? null : current;
  if (value === null || value === '' || value === 0 || value === '0') return null;
  const values = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (values.length !== 1 || !/^\d+$/.test(values[0])) throw httpError('四层转发分组无效');
  const id = Number(values[0]);
  const group = await db.prepare('SELECT id FROM customer_stream_groups WHERE id=? AND user_id=?').get(id, userId);
  if (!group) throw httpError('四层转发分组不存在', 404);
  return id;
}

async function translateScalar(db, kind, value, userId, allowShared = false, targetAccountId = null) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return value;
  if (typeof value === 'string' && value.includes(',')) {
    return (await Promise.all(value.split(',').map(async id => {
      const row = await resourceByLocal(db, kind, id.trim(), userId, { allowShared });
      if (!row) throw httpError(`${kind} 资源不存在`, 404);
      if (targetAccountId && !row.shared && Number(row.upstream_account_id) !== Number(targetAccountId)) throw httpError('关联资源与目标套餐不属于同一 CDN 服务', 409);
      return row.upstream_id;
    }))).join(',');
  }
  const row = await resourceByLocal(db, kind, value, userId, { allowShared });
  if (!row) throw httpError(`${kind} 资源不存在`, 404);
  if (targetAccountId && !row.shared && Number(row.upstream_account_id) !== Number(targetAccountId)) throw httpError('关联资源与目标套餐不属于同一 CDN 服务', 409);
  return Number.isInteger(value) || typeof value === 'number' ? Number(row.upstream_id) : row.upstream_id;
}

async function translateReferences(db, value, userId, targetAccountId = null) {
  if (Array.isArray(value)) return Promise.all(value.map(item => translateReferences(db, item, userId, targetAccountId)));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const kind = REFERENCE_FIELDS.get(key);
    output[key] = kind ? await translateScalar(db, kind, child, userId, kind === 'waf-rules', targetAccountId) : await translateReferences(db, child, userId, targetAccountId);
  }
  return output;
}

function normalizeTlsProtocols(value) {
  const values = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/))
    .map(item => String(item).trim()).filter(Boolean);
  if (!values.length) return DEFAULT_TLS_PROTOCOLS;
  if (values.some(item => !TLS_PROTOCOLS.has(item))) throw httpError('TLS 协议无效');
  return [...new Set(values)].join(' ');
}

const PROXY_CACHE_UNIT_ALIASES = new Map([
  ['s', 's'], ['second', 's'], ['seconds', 's'],
  ['m', 'm'], ['minute', 'm'], ['minutes', 'm'],
  ['h', 'h'], ['hour', 'h'], ['hours', 'h'],
  ['d', 'd'], ['day', 'd'], ['days', 'd'],
]);

function normalizeProxyCacheUnit(value) {
  const unit = String(value ?? '').trim().toLowerCase();
  if (!unit) return 'h';
  const normalized = PROXY_CACHE_UNIT_ALIASES.get(unit);
  if (!normalized) throw httpError('缓存时间单位无效');
  return normalized;
}

function normalizeSiteBackendState(value) {
  const state = String(value ?? 'up').trim().toLowerCase();
  if (['up', 'online', 'active', 'enabled', '1', 'true'].includes(state)) return 'up';
  if (['down', 'offline', 'disabled', '0', 'false'].includes(state)) return 'down';
  if (['backup', 'standby'].includes(state)) return 'backup';
  throw httpError('源站状态无效');
}

function normalizeSiteWriteInput(value) {
  const output = stripForbidden(value);
  // page_50x was used by an early local UI but is not a CDNFly v6 field.
  // Silently discard it so stale clients cannot turn an otherwise valid
  // partial update into an upstream HTTP 500.
  delete output?.page_50x;
  // CDNFly treats zero as a concrete CC rule ID and returns
  // "无法找到0规则". An unselected rule must be omitted from a partial site
  // update so the account's existing/default rule remains in effect.
  if ([null, '', 0, '0'].includes(output?.cc_default_rule)) delete output.cc_default_rule;
  if (output?.cc_switch && typeof output.cc_switch === 'object' && !Array.isArray(output.cc_switch)) {
    const ruleMissing = [undefined, null, '', 0, '0'].includes(output.cc_switch.rule);
    const enabled = normalizeEnabled(output.cc_switch.enable ?? 0);
    if (ruleMissing && enabled) throw httpError('开启自动提升防护时必须选择 CC 规则');
    if (ruleMissing) delete output.cc_switch;
  }
  if (Object.hasOwn(output || {}, 'proxy_ssl_protocols')) output.proxy_ssl_protocols = normalizeTlsProtocols(output.proxy_ssl_protocols);
  if (Array.isArray(output?.backend)) {
    if (!output.backend.length) throw httpError('至少保留一个源站');
    output.backend = output.backend.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !String(item.addr || '').trim()) throw httpError('源站地址必填');
      validateOrigin(item.addr);
      const weight = Number(item.weight ?? 1);
      if (!Number.isInteger(weight) || weight < 1 || weight > 1000) throw httpError('源站权重无效');
      return { ...item, addr: String(item.addr).trim(), weight, state: normalizeSiteBackendState(item.state) };
    });
    if (!output.backend.some(item => item.state === 'up')) throw httpError('至少保留一个在线源站');
  }
  if (Array.isArray(output?.proxy_cache)) {
    output.proxy_cache = output.proxy_cache.map(rule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw httpError('缓存规则无效');
      return { ...rule, unit: normalizeProxyCacheUnit(rule.unit) };
    });
  }
  if (!output?.https_listen || typeof output.https_listen !== 'object' || Array.isArray(output.https_listen)) return output;
  const https = { ...output.https_listen };
  const certificateMissing = !Object.hasOwn(https, 'cert') || [null, '', 0, '0'].includes(https.cert);
  const httpsEnabled = normalizeEnabled(https.ok ?? https.enable ?? (certificateMissing ? 0 : 1));
  if (httpsEnabled && certificateMissing) throw httpError('启用 HTTPS 时证书不能为空');
  // CDNFly validates certificate fields whenever https_listen is present. For
  // an already-disabled site this optional object must be omitted entirely.
  if (!httpsEnabled && certificateMissing) {
    delete output.https_listen;
    return output;
  }
  if (Object.hasOwn(https, 'ssl_protocols')) https.ssl_protocols = normalizeTlsProtocols(https.ssl_protocols);
  if (httpsEnabled) https.ssl_ciphers = String(https.ssl_ciphers || '').trim() || DEFAULT_SSL_CIPHERS;
  if (Object.hasOwn(https, 'ssl_prefer_server_ciphers')) {
    https.ssl_prefer_server_ciphers = normalizeEnabled(https.ssl_prefer_server_ciphers) ? 'on' : 'off';
  }
  output.https_listen = https;
  return output;
}

async function localizeScalar(db, kind, value, userId, allowShared = false, upstreamAccountId = null) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return value;
  const values = typeof value === 'string' && value.includes(',') ? value.split(',').map(item => item.trim()) : [value];
  const localized = await Promise.all(values.map(async upstreamId => (await resourceByUpstream(db, kind, upstreamId, userId, { allowShared, upstreamAccountId }))?.id ?? null));
  if (localized.some(id => id === null)) return null;
  return values.length > 1 ? localized.join(',') : localized[0];
}

async function localizeReferences(db, value, userId, upstreamAccountId = null) {
  if (Array.isArray(value)) return Promise.all(value.map(item => localizeReferences(db, item, userId, upstreamAccountId)));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const kind = REFERENCE_FIELDS.get(key);
    output[key] = kind ? await localizeScalar(db, kind, child, userId, kind === 'waf-rules', upstreamAccountId) : await localizeReferences(db, child, userId, upstreamAccountId);
  }
  return output;
}

async function translateResourceId(db, kind, item, userId, allowShared = false, targetAccountId = null) {
  const source = stripForbidden(item);
  const certificateBody = kind === 'certs' ? source.cert : undefined;
  if (kind === 'certs') delete source.cert;
  let clean = await translateReferences(db, source, userId, targetAccountId);
  if (kind === 'certs' && certificateBody !== undefined) clean.cert = certificateBody;
  if (kind === 'cc-rules') clean = await translateCcRuleReferences(db, clean, userId, false, targetAccountId);
  if (clean.id !== undefined) {
    const row = await resourceByLocal(db, kind, clean.id, userId, { allowShared });
    if (!row || row.shared) throw httpError('资源不存在或只读', 404);
    clean.id = Number(row.upstream_id);
  }
  return clean;
}

async function translateCcRuleReferences(db, value, userId, localize, upstreamAccountId = null) {
  const output = clone(value);
  if (!Array.isArray(output?.data)) return output;
  for (const rule of output.data) {
    for (const [key, kind] of [['matcher', 'cc-matchs'], ['filter1', 'cc-filters'], ['filter2', 'cc-filters']]) {
      if (rule[key] === undefined || rule[key] === null || rule[key] === 0) continue;
      if (localize) rule[key] = await localizeScalar(db, kind, rule[key], userId, false, upstreamAccountId);
      else rule[key] = await translateScalar(db, kind, rule[key], userId, false, upstreamAccountId);
    }
  }
  return output;
}

async function translateSiteReferences(db, value, userId, localize = false, upstreamAccountId = null) {
  const source = clone(value);
  // Website groups are local console metadata and must never be translated to
  // or submitted as CDNFly site-group references.
  for (const key of ['groups', 'group_id', 'groupId', 'site_group', 'group_name']) delete source?.[key];
  const output = localize ? await localizeReferences(db, source, userId, upstreamAccountId) : await translateReferences(db, normalizeSiteWriteInput(source), userId, upstreamAccountId);
  if (output?.acl !== undefined && output.acl !== null && output.acl !== '' && typeof output.acl !== 'object') {
    output.acl = localize
      ? await localizeScalar(db, 'acls', output.acl, userId, false, upstreamAccountId)
      : await translateScalar(db, 'acls', output.acl, userId, false, upstreamAccountId);
  }
  if (output?.cc_switch?.rule !== undefined && output.cc_switch.rule !== 0) {
    output.cc_switch.rule = localize
      ? await localizeScalar(db, 'cc-rules', output.cc_switch.rule, userId, false, upstreamAccountId)
      : await translateScalar(db, 'cc-rules', output.cc_switch.rule, userId, false, upstreamAccountId);
  }
  return output;
}

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

async function checkCnameResolution(domain, expected, resolver = resolveDnsCname) {
  const target = normalizeHostname(expected);
  const resolved = [];
  if (!target) return { domain: normalizeHostname(domain), expected: null, resolved, ok: false };
  let current = normalizeHostname(domain).replace(/^\*\./, '');
  const visited = new Set();
  try {
    for (let depth = 0; current && depth < 8 && !visited.has(current); depth += 1) {
      visited.add(current);
      const aliases = (await resolver(current)).map(normalizeHostname).filter(Boolean);
      resolved.push(...aliases.filter(alias => !resolved.includes(alias)));
      if (!aliases.length || (target && aliases.includes(target))) break;
      current = aliases[0];
    }
  } catch (error) {
    const dnsFailure = error?.syscall === 'queryCname' || [
      'ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'SERVFAIL', 'ETIMEOUT', 'EAI_AGAIN',
      'ECONNREFUSED', 'EREFUSED', 'EFORMERR', 'ENOTIMP', 'EBADQUERY',
    ].includes(error?.code);
    if (!dnsFailure) throw error;
  }
  return { domain: normalizeHostname(domain), expected: target || null, resolved, ok: Boolean(target && resolved.includes(target)) };
}

async function translateStreamReferences(db, value, userId, localize = false, upstreamAccountId = null) {
  const source = clone(value);
  // The customer-visible forwarding group is local metadata. CDNFly receives
  // the hidden per-customer group injected by the create/update caller.
  for (const key of ['groups', 'group_id', 'groupId', 'stream_group', 'group_name']) delete source?.[key];
  const output = localize ? await localizeReferences(db, source, userId, upstreamAccountId) : await translateReferences(db, stripForbidden(source), userId, upstreamAccountId);
  return output;
}

async function syncStreamPorts(db, localId, record) {
  if (record?.enable !== undefined) await db.prepare('UPDATE tenant_resources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(Boolean(record.enable)), localId);
  if (!Array.isArray(record?.listen)) return;
  const ports = [...new Set(record.listen.map(item => Number(item?.port)).filter(port => Number.isInteger(port) && port > 0 && port <= 65535))];
  await db.prepare('DELETE FROM stream_ports WHERE resource_id = ?').run(localId);
  const insert = db.prepare('INSERT INTO stream_ports (resource_id, port) VALUES (?, ?)');
  for (const port of ports) await insert.run(localId, port);
}

function countDomains(value) { return String(value || '').split(/[\s,]+/).filter(Boolean).length; }
function countCustomSitePorts(config) {
  const ports = new Set();
  const add = (listen, standard) => {
    if (!listen || Number(listen.enable ?? listen.ok ?? 1) === 0) return;
    for (const port of String(listen.port ?? '').split(/[\s,]+/).map(Number)) if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== standard) ports.add(port);
  };
  add(config?.http_listen, 80); add(config?.https_listen, 443); return ports.size;
}
function countStreamPorts(config) { return new Set((config?.listen || []).map(item => Number(item?.port)).filter(port => Number.isInteger(port) && port > 0 && port <= 65535)).size; }

function validateCompatDomains(value) {
  const domains = String(value ?? '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
  if (!domains.length) throw httpError('网站域名必填');
  domains.forEach(validateDomain);
}

function validateCompatSiteInput(item, { partial = false } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw httpError('网站配置必须是对象');
  if (!partial || item.domain !== undefined) validateCompatDomains(item.domain);
  const backend = Array.isArray(item.backend) ? item.backend[0] : null;
  const origin = backend?.addr ?? item.origin;
  if (!partial || origin !== undefined) {
    if (!origin) throw httpError('源站地址必填');
    validateOrigin(origin);
  }
  if (item.backend_host !== undefined && item.backend_host !== null && item.backend_host !== '') validateDomain(item.backend_host);
}

function validateCompatStreamInput(item, { partial = false } = {}) {
  sanitizeStreamInput(item, { partial });
}

function queryString(url, blocked = []) {
  const query = new URLSearchParams(url.searchParams);
  for (const key of ['uid', 'user_id', 'owner_id', 'internal', 'internal_self', 'action', ...blocked]) query.delete(key);
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function ownSite(db, localId, userId) {
  const id = Number.parseInt(localId, 10);
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(id, userId) || null;
}

async function siteByUpstream(db, upstreamId, userId, upstreamAccountId = null) {
  return upstreamAccountId
    ? db.prepare('SELECT * FROM sites WHERE upstream_id = ? AND owner_id = ? AND upstream_account_id=?').get(String(upstreamId), userId, Number(upstreamAccountId)) || null
    : db.prepare('SELECT * FROM sites WHERE upstream_id = ? AND owner_id = ? AND upstream_account_id IS NULL').get(String(upstreamId), userId) || null;
}

async function localizeDomain(db, record, userId, upstreamAccountId = null) {
  const upstreamSiteId = record.site_id ?? record.site ?? record.sid;
  const site = await siteByUpstream(db, upstreamSiteId, userId, upstreamAccountId);
  if (!site) return null;
  const localId = await saveResource(db, 'domains', record.id, userId, record, false, upstreamAccountId);
  if (site.subscription_id) {
    await db.prepare('UPDATE tenant_resources SET subscription_id=? WHERE id=? AND owner_id=?')
      .run(site.subscription_id, localId, userId);
  }
  const output = { ...record, id: localId, site_id: site.id };
  for (const field of FORBIDDEN_FIELDS) delete output[field];
  return output;
}

async function pruneOrphanDomainMappings(db, userId, upstreamAccountId = null) {
  const mappings = upstreamAccountId
    ? await db.prepare("SELECT * FROM tenant_resources WHERE kind='domains' AND owner_id=? AND upstream_account_id=?").all(userId, Number(upstreamAccountId))
    : await db.prepare("SELECT * FROM tenant_resources WHERE kind='domains' AND owner_id=? AND upstream_account_id IS NULL").all(userId);
  for (const mapping of mappings) {
    const snapshot = resourceSnapshot(mapping);
    const upstreamSiteId = snapshot?.site_id ?? snapshot?.site ?? snapshot?.sid;
    if (upstreamSiteId === undefined || upstreamSiteId === null || upstreamSiteId === '') continue;
    if (await siteByUpstream(db, upstreamSiteId, userId, upstreamAccountId)) continue;
    await db.prepare("DELETE FROM tenant_resources WHERE id=? AND owner_id=? AND kind='domains'").run(mapping.id, userId);
  }
}

async function listResources({ db, cdnfly, kind, user, url }) {
  const upstream = clone(await cdnfly.request('GET', `/v1/${kind}${queryString(url)}`));
  const ref = findCollection(upstream);
  const source = ref?.items || (Array.isArray(upstream) ? upstream : []);
  const visible = [];
  for (const record of source) {
    let mapping = await resourceByUpstream(db, kind, record.id, user.id, { allowShared: kind === 'waf-rules', upstreamAccountId: cdnfly.accountId });
    if (!mapping && kind === 'waf-rules' && isSharedWaf(record)) {
      const localId = await saveResource(db, kind, record.id, user.id, record, true, cdnfly.accountId);
      mapping = await db.prepare('SELECT * FROM tenant_resources WHERE id = ?').get(localId);
    }
    if (mapping) {
      const currentRecord = mergeResourceSnapshot(kind, resourceSnapshot(mapping), record);
      if (!mapping.subscription_id && cdnfly.accountId && cdnfly.packageId) {
        const matchingSubscription = await db.prepare(`SELECT id FROM subscriptions
          WHERE user_id=? AND status IN ('active','suspended') AND upstream_id=? AND upstream_package_id=?
          ORDER BY id DESC LIMIT 1`).get(user.id, Number(cdnfly.accountId), String(cdnfly.packageId));
        if (matchingSubscription) {
          await db.prepare('UPDATE tenant_resources SET subscription_id=?,upstream_account_id=? WHERE id=?')
            .run(matchingSubscription.id, cdnfly.accountId || null, mapping.id);
          mapping.subscription_id = matchingSubscription.id;
          mapping.upstream_account_id = cdnfly.accountId || mapping.upstream_account_id;
        }
      }
      await saveResource(db, kind, record.id, user.id, currentRecord, Boolean(mapping.shared), cdnfly.accountId);
      let localized;
      if (kind === 'streams') localized = await translateStreamReferences(db, currentRecord, user.id, true, cdnfly.accountId);
      else if (kind === 'certs') {
        const certificateBody = currentRecord.cert; const source = { ...currentRecord }; delete source.cert;
        localized = await localizeReferences(db, source, user.id, cdnfly.accountId);
        if (certificateBody !== undefined) localized.cert = certificateBody;
      } else localized = await localizeReferences(db, currentRecord, user.id, cdnfly.accountId);
      if (kind === 'cc-rules') localized = await translateCcRuleReferences(db, localized, user.id, true, cdnfly.accountId);
      const publicValue = publicRecord(localized, mapping.id, Boolean(mapping.shared));
      const customerValue = exposeResourceRecord(kind, publicValue);
      const exposed = kind === 'certs' ? redactCertificate(customerValue)
        : kind === 'dnsapis' ? redactDnsApi(customerValue)
          : customerValue;
      if (kind === 'streams') {
        const sub = await db.prepare('SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(mapping.subscription_id);
        exposed.subscription_id = mapping.subscription_id; exposed.plan_name = sub?.name || null;
        exposed.groups = mapping.local_group_id || '';
      } else if (mapping.subscription_id) exposed.subscription_id = mapping.subscription_id;
      visible.push(exposed);
      if (kind === 'streams') await syncStreamPorts(db, mapping.id, currentRecord);
    }
  }
  return setCollection(upstream, ref, visible);
}

async function resourceDetail(cdnfly, kind, upstreamId, fallbackMapping = null) {
  try {
    return await cdnfly.request('GET', `/v1/${kind}/${encodeURIComponent(upstreamId)}`);
  } catch (error) {
    if (kind !== 'streams') throw error;
    for (const path of ['/v1/streams?limit=0', '/v1/streams']) {
      try {
        const payload = await cdnfly.request('GET', path);
        const ref = findCollection(payload);
        const records = ref?.items || (Array.isArray(payload) ? payload : []);
        const record = records.find(item => String(item?.id) === String(upstreamId));
        if (record) return record;
      } catch {}
    }
    const snapshot = resourceSnapshot(fallbackMapping);
    if (snapshot) return { ...snapshot, sync_warning: 'CDN 服务详情暂时不可用，当前显示最近一次成功同步的配置' };
    if (fallbackMapping) {
      return {
        id: Number.isFinite(Number(upstreamId)) ? Number(upstreamId) : upstreamId,
        enable: 0,
        sync_unavailable: true,
        sync_warning: 'CDN 服务暂未返回该转发的可用详情',
      };
    }
    throw error;
  }
}

const STREAM_DISABLE_FIRST = /请先(?:禁用|停用)|先(?:禁用|停用)/;
const STREAM_PROCESSING = /正在处理|处理中|稍后再操作|操作频繁/;
const STREAM_MISSING_OR_HIDDEN = /不存在|未找到|not found|需要管理员权限|无权限/i;

function resourceIsStopped(mapping) {
  const snapshot = resourceSnapshot(mapping);
  const enabled = snapshot?.enable ?? snapshot?.enabled ?? mapping?.enabled;
  return [0, false, '0', 'false', 'off', 'disabled'].includes(enabled);
}

function requireStoppedResource(mapping, label) {
  if (!resourceIsStopped(mapping)) throw httpError(`请先停用${label}，再执行删除操作`, 409);
}

async function streamAbsentFromAccount(client, upstreamId) {
  try {
    const payload = await client.request('GET', '/v1/streams?limit=0');
    const ref = findCollection(payload);
    const records = ref?.items || (Array.isArray(payload) ? payload : []);
    return !records.some(item => String(item?.id) === String(upstreamId));
  } catch {
    return false;
  }
}

async function deleteStreamResource(client, upstreamId, { attempts = 8, delayMs = 500, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const path = `/v1/streams/${encodeURIComponent(upstreamId)}`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await client.request('DELETE', path);
    } catch (error) {
      const message = String(error?.message || '');
      if ((Number(error?.upstreamStatus) === 404 || STREAM_MISSING_OR_HIDDEN.test(message))
        && await streamAbsentFromAccount(client, upstreamId)) return { ok: true, alreadyAbsent: true };
      if (STREAM_DISABLE_FIRST.test(message)) throw httpError('请先停用四层转发，再执行删除操作', 409);
      if (!STREAM_PROCESSING.test(message)) {
        throw error;
      }
      if (attempt < attempts - 1) await wait(delayMs);
    }
  }
  throw httpError('四层转发状态正在更新，请稍后重试删除', 409);
}

async function createResources({ db, cdnfly, upstreams, billing, kind, user, body }) {
  const sourceItems = Array.isArray(body) ? body : [body];
  // Four-layer forwarding and upstream-backed resources must be tied to the
  // selected active package so later reads/updates use the same CDN service.
  // Domain records already carry their site ownership. Other upstream-backed
  // resources, including site groups, need a subscription to select the
  // correct upstream account when a customer has more than one.
  const subscriptions = billing && kind !== 'domains'
    ? await Promise.all(sourceItems.map(item => billing.resolveSubscription(user.id, item.subscriptionId ?? item.subscription_id, { requireExplicit: true })))
    : [];
  if (upstreams && subscriptions.length && new Set(subscriptions.map(item => Number(item.upstream_id))).size !== 1) throw httpError('批量创建只能选择同一 CDN 服务下的套餐', 409);
  const upstreamClient = upstreams
    ? (subscriptions[0] ? await upstreams.clientForSubscription(subscriptions[0]) : await upstreams.defaultClient(user.id))
    : cdnfly;
  const localStreamGroupIds = kind === 'streams'
    ? await Promise.all(sourceItems.map(item => resolveLocalStreamGroup(db, user.id, requestedStreamGroup(item))))
    : [];
  const defaultedItems = await Promise.all(sourceItems.map((item, index) => applyUserDefaults(
    db, user.id, kind === 'streams' ? 'stream' : kind === 'certs' ? 'cert' : '', localStreamGroupIds[index], item,
  )));
  const customerGroups = kind === 'streams' ? await ensureCustomerUpstreamGroups(db, upstreamClient, user.id) : null;
  let clean;
  if (kind === 'streams') {
    const sanitized = defaultedItems.map(item => sanitizeStreamInput(item));
    clean = Array.isArray(body)
      ? await Promise.all(sanitized.map(item => translateStreamReferences(db, item, user.id, false, upstreamClient.accountId)))
      : await translateStreamReferences(db, sanitized[0], user.id, false, upstreamClient.accountId);
  } else {
    const translateCreateItem = async item => {
      const source = kind === 'certs' ? sanitizeCertificateInput(item)
        : kind === 'dnsapis' ? sanitizeDnsApiInput(item)
          : kind === 'acls' ? sanitizeAclInput(item)
          : stripForbidden(item);
      // `cert` is a resource reference in a site config, but it is the PEM
      // certificate body when creating a certificate resource itself.
      const certificateBody = kind === 'certs' ? source.cert : undefined;
      if (kind === 'certs') delete source.cert;
      const translated = await translateReferences(db, source, user.id, upstreamClient.accountId);
      if (kind === 'certs' && certificateBody !== undefined) translated.cert = certificateBody;
      return translated;
    };
    clean = Array.isArray(body) ? await Promise.all(defaultedItems.map(translateCreateItem)) : await translateCreateItem(defaultedItems[0]);
  }
  if (kind === 'cc-rules') clean = Array.isArray(clean)
    ? await Promise.all(clean.map(item => translateCcRuleReferences(db, item, user.id, false, upstreamClient.accountId)))
    : await translateCcRuleReferences(db, clean, user.id, false, upstreamClient.accountId);
  if (kind === 'streams') {
    if (billing) await Promise.all((Array.isArray(clean) ? clean : [clean]).map((item, index) => billing.assertProjected(user.id, { ports: countStreamPorts(item) }, subscriptions[index].id)));
    for (const item of (Array.isArray(clean) ? clean : [clean])) {
      item.user_package = upstreamClient.packageId;
      if (customerGroups?.stream) item.groups = String(customerGroups.stream.upstream_group_id);
    }
  }
  clean = Array.isArray(clean)
    ? clean.map(item => ownershipPayload(kind, upstreamClient, user.id, item))
    : ownershipPayload(kind, upstreamClient, user.id, clean);
  const upstream = await upstreamClient.request('POST', `/v1/${kind}`, clean);
  const ids = parseIds(upstream);
  if (!ids.length) throw httpError('CDN 服务未返回新资源 ID', 502);
  const inputs = Array.isArray(clean) ? clean : [clean];
  const localIds = await Promise.all(ids.map(async (id, index) => {
    const localId = await saveResource(db, kind, id, user.id, inputs[index] || inputs[0], false, upstreamClient.accountId);
    await markOwnershipPersisted(db, kind, localId, upstreamClient, user.id);
    if (subscriptions[index]) await db.prepare('UPDATE tenant_resources SET subscription_id=?,upstream_account_id=? WHERE id=?').run(subscriptions[index].id, subscriptions[index].upstream_id, localId);
    if (kind === 'streams') {
      await db.prepare('UPDATE tenant_resources SET local_group_id=? WHERE id=?').run(localStreamGroupIds[index] ?? null, localId);
      await syncStreamPorts(db, localId, inputs[index] || inputs[0]);
    }
    return localId;
  }));
  return localIds.join(',');
}

async function updateCollection({ db, cdnfly, upstreams, billing, kind, user, body }) {
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.some(item => item?.id === undefined)) throw httpError('批量更新必须提供每个资源的本地 ID');
  const existingMappings = (await Promise.all(items.filter(item => item.id !== undefined).map(item => resourceByLocal(db, kind, item.id, user.id)))).filter(Boolean);
  if (existingMappings.length !== items.length) throw httpError('资源不存在', 404);
  if (upstreams && new Set(existingMappings.map(item => Number(item.upstream_account_id))).size > 1) throw httpError('批量更新只能操作同一 CDN 服务下的资源', 409);
  const upstreamClient = upstreams && existingMappings.length ? await upstreams.clientForResource(existingMappings[0]) : (upstreams ? await upstreams.defaultClient(user.id) : cdnfly);
  const mappingById = new Map(existingMappings.map(mapping => [Number(mapping.id), mapping]));
  const localStreamGroupIds = kind === 'streams'
    ? await Promise.all(items.map(item => {
      const row = mappingById.get(Number(item.id));
      return resolveLocalStreamGroup(db, user.id, requestedStreamGroup(item), row.local_group_id);
    }))
    : [];
  const customerGroups = kind === 'streams' ? await ensureCustomerUpstreamGroups(db, upstreamClient, user.id) : null;
  const translated = await Promise.all(items.map(async item => {
    const row = mappingById.get(Number(item.id));
    if (kind !== 'streams') {
      const sanitized = kind === 'certs' ? sanitizeCertificateInput(item, { partial: true, existing: resourceSnapshot(row) })
        : kind === 'dnsapis' ? sanitizeDnsApiInput(item, { partial: true, existing: resourceSnapshot(row) })
          : kind === 'acls' ? sanitizeAclInput(item, { partial: true, existing: resourceSnapshot(row) })
          : stripForbidden(item);
      sanitized.id = Number(item.id);
      return translateResourceId(db, kind, sanitized, user.id, false, upstreamClient.accountId);
    }
    const sanitized = sanitizeStreamInput(item, { partial: true });
    const clean = await translateStreamReferences(db, sanitized, user.id, false, upstreamClient.accountId);
    clean.id = Number(row.upstream_id);
    delete clean.user_package;
    if (customerGroups?.stream) clean.groups = String(customerGroups.stream.upstream_group_id);
    return clean;
  }));
  for (let index = 0; index < translated.length; index += 1) {
    translated[index] = ownershipPayload(kind, upstreamClient, user.id, translated[index], resourceSnapshot(existingMappings[index]));
  }
  const upstream = await upstreamClient.request('PUT', `/v1/${kind}`, Array.isArray(body) ? translated : translated[0]);
  await Promise.all(items.map(async (item, index) => {
    const mapping = mappingById.get(Number(item.id));
    const previous = resourceSnapshot(mapping) || {};
    const sanitized = kind === 'streams' ? sanitizeStreamInput(item, { partial: true })
      : kind === 'certs' ? sanitizeCertificateInput(item, { partial: true, existing: previous })
        : kind === 'dnsapis' ? sanitizeDnsApiInput(item, { partial: true, existing: previous })
          : kind === 'acls' ? sanitizeAclInput(item, { partial: true, existing: previous })
          : stripForbidden(item);
    delete sanitized.id;
    const snapshotUpdate = kind === 'streams' ? { ...translated[index] } : sanitized;
    delete snapshotUpdate.id;
    await saveResource(db, kind, mapping.upstream_id, user.id, { ...previous, ...snapshotUpdate }, Boolean(mapping.shared), mapping.upstream_account_id);
    await markOwnershipPersisted(db, kind, mapping.id, upstreamClient, user.id);
    if (kind === 'streams') await db.prepare('UPDATE tenant_resources SET local_group_id=? WHERE id=?')
      .run(localStreamGroupIds[index] ?? null, mapping.id);
  }));
  const newIds = parseIds(upstream);
  const created = [];
  let newIndex = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].id !== undefined) continue;
    const upstreamId = newIds[newIndex++];
    if (upstreamId) created.push(await saveResource(db, kind, upstreamId, user.id, items[index], false, upstreamClient.accountId));
  }
  if (kind === 'streams') await Promise.all(items.filter(item => item.id !== undefined).map(item => syncStreamPorts(db, Number(item.id), item)));
  if (kind === 'streams' && billing) await billing.enforceUser(user.id, { syncTraffic: false });
  return created.length ? created.join(',') : exposeResourceRecord(kind, upstream);
}

export async function handleTenantProxy({ req, url, user, db, cdnfly, upstreams = null, billing, readBody, dnsResolveCname = resolveDnsCname }) {
  normalizeCdnflyUrl(url);
  const prefix = '/api/cdnfly/v1';
  if (!url.pathname.startsWith(prefix)) return null;
  if (user.role !== 'user') throw httpError('平台管理员不能使用租户资源接口', 403);
  const path = url.pathname.slice(prefix.length) || '/';

  if (path === '/site-groups') {
    if (req.method === 'GET') {
      const rows = await db.prepare('SELECT * FROM customer_site_groups WHERE user_id=? ORDER BY id DESC').all(user.id);
      return { status: 200, data: { count: rows.length, items: rows.map(row => ({
        id: Number(row.id), name: row.name, des: row.description || '', enable: Number(row.enabled),
        created_at: row.created_at, updated_at: row.updated_at,
      })) } };
    }
    if (req.method === 'POST') {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError('网站分组请求必须是对象');
      const allowed = new Set(['name', 'des', 'description', 'enable', 'subscriptionId', 'subscription_id']);
      const unknown = Object.keys(input).find(key => !allowed.has(key));
      if (unknown) throw httpError(`不支持的网站分组字段: ${unknown}`);
      const name = cleanText(input.name, '网站分组名称', { required: true, max: 120 });
      const description = cleanText(input.des ?? input.description, '网站分组备注', { max: 240 });
      const enabled = input.enable === undefined ? 1 : normalizeEnabled(input.enable);
      try {
        const row = await db.prepare('INSERT INTO customer_site_groups (user_id,name,description,enabled) VALUES (?,?,?,?)').run(user.id, name, description, enabled);
        return { status: 201, data: Number(row.lastInsertRowid), action: 'site-group.create', resourceId: row.lastInsertRowid };
      } catch (error) {
        if (/unique|duplicate/i.test(String(error.message || ''))) throw httpError('网站分组名称已存在', 409);
        throw error;
      }
    }
  }

  const localSiteGroup = path.match(/^\/site-groups\/(\d+)$/);
  if (localSiteGroup) {
    const row = await db.prepare('SELECT * FROM customer_site_groups WHERE id=? AND user_id=?').get(Number(localSiteGroup[1]), user.id);
    if (!row) throw httpError('网站分组不存在', 404);
    if (req.method === 'GET') return { status: 200, data: { id: Number(row.id), name: row.name, des: row.description || '', enable: Number(row.enabled) } };
    if (req.method === 'PUT') {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError('网站分组请求必须是对象');
      const allowed = new Set(['name', 'des', 'description', 'enable']);
      const unknown = Object.keys(input).find(key => !allowed.has(key));
      if (unknown) throw httpError(`不支持的网站分组字段: ${unknown}`);
      const name = input.name === undefined ? row.name : cleanText(input.name, '网站分组名称', { required: true, max: 120 });
      const description = input.des === undefined && input.description === undefined ? row.description : cleanText(input.des ?? input.description, '网站分组备注', { max: 240 });
      const enabled = input.enable === undefined ? Number(row.enabled) : normalizeEnabled(input.enable);
      try {
        await db.prepare('UPDATE customer_site_groups SET name=?,description=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(name, description, enabled, row.id, user.id);
      } catch (error) {
        if (/unique|duplicate/i.test(String(error.message || ''))) throw httpError('网站分组名称已存在', 409);
        throw error;
      }
      return { status: 200, data: true, action: 'site-group.update', resourceId: row.id };
    }
    if (req.method === 'DELETE') {
      await db.transaction(async transaction => {
        await transaction.prepare('UPDATE sites SET local_group_id=NULL WHERE owner_id=? AND local_group_id=?').run(user.id, row.id);
        await transaction.prepare("UPDATE user_configs SET scope_name='global',scope_id=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND type='site' AND scope_name='group' AND scope_id=?").run(user.id, row.id);
        await transaction.prepare('DELETE FROM customer_site_groups WHERE id=? AND user_id=?').run(row.id, user.id);
      });
      return { status: 200, data: true, action: 'site-group.delete', resourceId: row.id };
    }
  }

  if (path === '/stream-groups') {
    if (req.method === 'GET') {
      const rows = await db.prepare('SELECT * FROM customer_stream_groups WHERE user_id=? ORDER BY id DESC').all(user.id);
      return { status: 200, data: { count: rows.length, items: rows.map(row => ({
        id: Number(row.id), name: row.name, des: row.description || '', enable: Number(row.enabled),
        created_at: row.created_at, updated_at: row.updated_at,
      })) } };
    }
    if (req.method === 'POST') {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError('四层转发分组请求必须是对象');
      const allowed = new Set(['name', 'des', 'description', 'enable', 'subscriptionId', 'subscription_id']);
      const unknown = Object.keys(input).find(key => !allowed.has(key));
      if (unknown) throw httpError(`不支持的四层转发分组字段: ${unknown}`);
      const name = cleanText(input.name, '四层转发分组名称', { required: true, max: 120 });
      const description = cleanText(input.des ?? input.description, '四层转发分组备注', { max: 240 });
      const enabled = input.enable === undefined ? 1 : normalizeEnabled(input.enable);
      try {
        const row = await db.prepare('INSERT INTO customer_stream_groups (user_id,name,description,enabled) VALUES (?,?,?,?)').run(user.id, name, description, enabled);
        return { status: 201, data: Number(row.lastInsertRowid), action: 'stream-group.create', resourceId: row.lastInsertRowid };
      } catch (error) {
        if (/unique|duplicate/i.test(String(error.message || ''))) throw httpError('四层转发分组名称已存在', 409);
        throw error;
      }
    }
  }

  const localStreamGroup = path.match(/^\/stream-groups\/(\d+)$/);
  if (localStreamGroup) {
    const row = await db.prepare('SELECT * FROM customer_stream_groups WHERE id=? AND user_id=?').get(Number(localStreamGroup[1]), user.id);
    if (!row) throw httpError('四层转发分组不存在', 404);
    if (req.method === 'GET') return { status: 200, data: { id: Number(row.id), name: row.name, des: row.description || '', enable: Number(row.enabled) } };
    if (req.method === 'PUT') {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError('四层转发分组请求必须是对象');
      const allowed = new Set(['name', 'des', 'description', 'enable']);
      const unknown = Object.keys(input).find(key => !allowed.has(key));
      if (unknown) throw httpError(`不支持的四层转发分组字段: ${unknown}`);
      const name = input.name === undefined ? row.name : cleanText(input.name, '四层转发分组名称', { required: true, max: 120 });
      const description = input.des === undefined && input.description === undefined ? row.description : cleanText(input.des ?? input.description, '四层转发分组备注', { max: 240 });
      const enabled = input.enable === undefined ? Number(row.enabled) : normalizeEnabled(input.enable);
      try {
        await db.prepare('UPDATE customer_stream_groups SET name=?,description=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(name, description, enabled, row.id, user.id);
      } catch (error) {
        if (/unique|duplicate/i.test(String(error.message || ''))) throw httpError('四层转发分组名称已存在', 409);
        throw error;
      }
      return { status: 200, data: true, action: 'stream-group.update', resourceId: row.id };
    }
    if (req.method === 'DELETE') {
      await db.transaction(async transaction => {
        await transaction.prepare("UPDATE tenant_resources SET local_group_id=NULL WHERE owner_id=? AND kind='streams' AND local_group_id=?").run(user.id, row.id);
        await transaction.prepare("UPDATE user_configs SET scope_name='global',scope_id=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND type='stream' AND scope_name='group' AND scope_id=?").run(user.id, row.id);
        await transaction.prepare('DELETE FROM customer_stream_groups WHERE id=? AND user_id=?').run(row.id, user.id);
      });
      return { status: 200, data: true, action: 'stream-group.delete', resourceId: row.id };
    }
  }

  if (path === '/capabilities' && req.method === 'GET') {
    const site = await db.prepare('SELECT * FROM sites WHERE owner_id=? ORDER BY id LIMIT 1').get(user.id);
    const attackClient = site ? (upstreams ? await upstreams.clientForSite(site) : cdnfly) : null;
    const [wafRules, attackLogs] = await Promise.all([
      userSupportsWafRules(upstreams, cdnfly, user.id),
      attackClient ? supportsAttackLogs(attackClient, site) : Promise.resolve(true),
    ]);
    return { status: 200, data: { wafRules, attackLogs } };
  }

  if (path === '/sites' && req.method === 'GET') {
    const rows = await db.prepare('SELECT * FROM sites WHERE owner_id = ? ORDER BY id DESC').all(user.id);
    await syncSiteCnames(db, rows, upstreams, cdnfly);
    return { status: 200, data: { count: rows.length, items: rows.map(row => ({
      id: row.id, domain: row.domain, backend: [{ addr: row.origin, weight: 1, state: 'up' }],
      subscription_id: row.subscription_id,
      group_id: row.local_group_id,
      backend_protocol: row.backend_protocol, backend_host: row.backend_host,
      websocket_enable: row.websocket, gzip_enable: row.gzip, enable: row.enabled,
      state: row.state, cname: row.cname, created_at: row.created_at,
    })) } };
  }
  if (path === '/sites' && req.method === 'POST') {
    const raw = await readBody(req);
    const inputs = Array.isArray(raw) ? raw : [raw];
    if (!inputs.length) throw httpError('网站请求不能为空');
    const subscriptions = billing ? await Promise.all(inputs.map(item => billing.resolveSubscription(user.id, item.subscriptionId ?? item.subscription_id, { requireExplicit: true }))) : [];
    if (upstreams && new Set(subscriptions.map(item => Number(item.upstream_id))).size !== 1) throw httpError('批量创建网站只能选择同一 CDN 服务下的套餐', 409);
    const upstreamClient = upstreams ? await upstreams.clientForSubscription(subscriptions[0]) : cdnfly;
    const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, user.id);
    const current = (await db.prepare('SELECT COUNT(*) AS count FROM sites WHERE owner_id = ?').get(user.id)).count;
    if (current + inputs.length > user.site_limit) throw httpError('站点额度不足', 409);
    const localGroupIds = await Promise.all(inputs.map(async item => {
      const rawId = item.groupId ?? item.group_id ?? item.groups ?? item.site_group;
      if (rawId === undefined || rawId === null || rawId === '' || Number(rawId) === 0) return null;
      const id = Number(rawId);
      const group = Number.isInteger(id) ? await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(id, user.id) : null;
      if (!group) throw httpError('网站分组不存在', 404);
      return id;
    }));
    const clean = await Promise.all(inputs.map(async (item, index) => {
      const defaulted = await applyUserDefaults(db, user.id, 'site', localGroupIds[index], item);
      validateCompatSiteInput(defaulted);
      const translated = await translateSiteReferences(db, defaulted, user.id, false, upstreamClient.accountId);
      translated.user_package = upstreamClient.packageId;
      if (customerGroups?.site) translated.groups = String(customerGroups.site.upstream_group_id);
      return translated;
    }));
    if (billing) await Promise.all(clean.map((item, index) => billing.assertProjected(user.id, {
      domains: countDomains(item.domain), ports: countCustomSitePorts(item),
    }, subscriptions[index].id)));
    for (const item of clean) {
      if (!item.domain) throw httpError('网站域名必填');
      if (await db.prepare('SELECT id FROM sites WHERE domain = ?').get(String(item.domain))) throw httpError('域名已存在', 409);
    }
    const upstream = await upstreamClient.request('POST', '/v1/sites', Array.isArray(raw) ? clean : clean[0]);
    const upstreamIds = parseIds(upstream);
    if (upstreamIds.length !== clean.length) throw httpError('CDN 服务返回的网站 ID 数量不匹配', 502);
    const localIds = await Promise.all(clean.map(async (item, index) => {
      const backend = Array.isArray(item.backend) ? item.backend[0] : null;
      const origin = backend?.addr || item.origin || item.backend_host || String(item.domain).split(',')[0];
      return Number((await db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_account_id, upstream_id, local_group_id, domain, origin, backend_protocol, backend_host, websocket, gzip, enabled, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(
        user.id, subscriptions[index]?.id || null, subscriptions[index]?.upstream_id || upstreamClient.accountId || null, upstreamIds[index], localGroupIds[index], String(item.domain), String(origin), item.backend_protocol || 'http', item.backend_host || String(item.domain).split(',')[0],
        Number(Boolean(item.websocket_enable)), Number(Boolean(item.gzip_enable)), item.enable === undefined ? 1 : Number(Boolean(item.enable)),
      )).lastInsertRowid);
    }));
    if (billing) await Promise.all(localIds.map((id, index) => billing.syncSitePorts(id, clean[index])));
    const createdRows = await db.prepare(`SELECT * FROM sites WHERE id IN (${localIds.map(() => '?').join(',')}) AND owner_id=?`).all(...localIds, user.id);
    await syncSiteCnames(db, createdRows, upstreams, cdnfly);
    return { status: 201, data: localIds.join(','), action: 'site.create', resourceId: localIds.join(',') };
  }
  if (path === '/sites' && req.method === 'PUT') {
    const raw = await readBody(req);
    if (!Array.isArray(raw)) throw httpError('批量更新网站必须使用数组');
    const sites = await Promise.all(raw.map(item => ownSite(db, item.id, user.id)));
    if (sites.some(site => !site)) throw httpError('网站不存在', 404);
    if (upstreams && new Set(sites.map(site => Number(site.upstream_account_id))).size !== 1) throw httpError('批量更新只能操作同一 CDN 服务下的网站', 409);
    const targetSubscriptions = await Promise.all(raw.map(async (item, index) => {
      if (!billing || (item.subscriptionId === undefined && item.subscription_id === undefined)
        || Number(item.subscriptionId ?? item.subscription_id) === Number(sites[index].subscription_id)) return null;
      const target = await billing.resolveSubscription(user.id, item.subscriptionId ?? item.subscription_id);
      await billing.assertProjected(user.id, { domains: countDomains(sites[index].domain) }, target.id);
      if (upstreams && Number(target.upstream_id) !== Number(sites[index].upstream_account_id)) {
        throw httpError('网站不能直接迁移到其他 CDN 服务，请在目标套餐下重新创建', 409);
      }
      return target;
    }));
    const localGroupIds = await Promise.all(raw.map(async (item, index) => {
      if (![item.groupId, item.group_id, item.groups, item.site_group].some(value => value !== undefined)) return sites[index].local_group_id;
      const value = item.groupId ?? item.group_id ?? item.groups ?? item.site_group;
      const id = value === '' || value === null || Number(value) === 0 ? null : Number(value);
      if (id !== null && (!Number.isInteger(id) || !await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(id, user.id))) {
        throw httpError('网站分组不存在', 404);
      }
      return id;
    }));
    const upstreamClient = upstreams ? await upstreams.clientForSite(sites[0]) : cdnfly;
    const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, user.id);
    const translated = await Promise.all(raw.map(async (item, index) => {
      validateCompatSiteInput(item, { partial: true });
      const clean = await translateSiteReferences(db, item, user.id, false, upstreamClient.accountId);
      clean.id = Number(sites[index].upstream_id);
      delete clean.user_package;
      if (customerGroups?.site) clean.groups = String(customerGroups.site.upstream_group_id);
      return clean;
    }));
    const data = await upstreamClient.request('PUT', '/v1/sites', translated);
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index];
      let subscriptionId = sites[index].subscription_id;
      if (targetSubscriptions[index]) subscriptionId = targetSubscriptions[index].id;
      const backend = Array.isArray(item.backend) ? item.backend[0] : null;
      await db.prepare(`UPDATE sites SET domain = COALESCE(?, domain), origin = COALESCE(?, origin), backend_protocol = COALESCE(?, backend_protocol),
        backend_host = COALESCE(?, backend_host), websocket = COALESCE(?, websocket), gzip = COALESCE(?, gzip), subscription_id=?, local_group_id=?, enabled = COALESCE(?, enabled), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(item.domain ?? null, backend?.addr ?? null, item.backend_protocol ?? null, item.backend_host ?? null,
          item.websocket_enable === undefined ? null : Number(Boolean(item.websocket_enable)), item.gzip_enable === undefined ? null : Number(Boolean(item.gzip_enable)),
          subscriptionId, localGroupIds[index], item.enable === undefined ? null : Number(Boolean(item.enable)), sites[index].id);
      if (billing) await billing.syncSitePorts(sites[index].id, item);
    }
    if (billing) await billing.enforceUser(user.id, { syncTraffic: false });
    return { status: 200, data, action: 'site.batch-update', resourceId: raw.map(item => item.id).join(',') };
  }

  const siteDetail = path.match(/^\/sites\/([0-9,]+)$/);
  if (siteDetail) {
    const localIds = siteDetail[1].split(',');
    const sites = await Promise.all(localIds.map(id => ownSite(db, id, user.id)));
    if (sites.some(site => !site)) throw httpError('网站不存在', 404);
    if (upstreams && new Set(sites.map(site => Number(site.upstream_account_id))).size > 1) throw httpError('批量操作只能包含同一 CDN 服务下的网站', 409);
    const upstreamClient = upstreams ? await upstreams.clientForSite(sites[0]) : cdnfly;
    if (req.method === 'GET' && sites.length === 1) {
      const data = await upstreamClient.request('GET', `/v1/sites/${sites[0].upstream_id}`);
      const cname = await resolveCompleteCname(upstreamClient, data, sites[0].cname, data);
      if (cname !== sites[0].cname) await db.prepare('UPDATE sites SET cname=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(cname || null, sites[0].id);
      const output = publicRecord(await translateSiteReferences(db, data, user.id, true, upstreamClient.accountId), sites[0].id);
      if (cname) output.cname = cname;
      const sub = await db.prepare('SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(sites[0].subscription_id);
      output.subscription_id = sites[0].subscription_id; output.plan_name = sub?.name || null; output.group_id = sites[0].local_group_id;
      return { status: 200, data: output };
    }
    if (req.method === 'PUT' && sites.length === 1) {
      const raw = await readBody(req);
      let localGroupId = sites[0].local_group_id;
      if ([raw.groupId, raw.group_id, raw.groups, raw.site_group].some(value => value !== undefined)) {
        const value = raw.groupId ?? raw.group_id ?? raw.groups ?? raw.site_group;
        localGroupId = value === '' || value === null || Number(value) === 0 ? null : Number(value);
        if (localGroupId !== null && (!Number.isInteger(localGroupId) || !await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(localGroupId, user.id))) throw httpError('网站分组不存在', 404);
      }
      let subscriptionId = sites[0].subscription_id;
      if (billing && (raw.subscriptionId !== undefined || raw.subscription_id !== undefined) && Number(raw.subscriptionId ?? raw.subscription_id) !== Number(subscriptionId)) {
        const target = await billing.resolveSubscription(user.id, raw.subscriptionId ?? raw.subscription_id);
        await billing.assertProjected(user.id, { domains: countDomains(sites[0].domain) }, target.id);
        if (upstreams && Number(target.upstream_id) !== Number(sites[0].upstream_account_id)) {
          throw httpError('网站不能直接迁移到其他 CDN 服务，请在目标套餐下重新创建', 409);
        }
        subscriptionId = target.id;
      }
      const clean = await translateSiteReferences(db, raw, user.id, false, upstreamClient.accountId);
      delete clean.id; delete clean.user_package;
      const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, user.id);
      if (customerGroups?.site) clean.groups = String(customerGroups.site.upstream_group_id);
      const data = await upstreamClient.request('PUT', `/v1/sites/${sites[0].upstream_id}`, clean);
      const backend = Array.isArray(raw.backend) ? raw.backend[0] : null;
      await db.prepare(`UPDATE sites SET domain = COALESCE(?, domain), origin = COALESCE(?, origin), backend_protocol = COALESCE(?, backend_protocol),
        backend_host = COALESCE(?, backend_host), websocket = COALESCE(?, websocket), gzip = COALESCE(?, gzip), subscription_id=?, local_group_id=?, enabled = COALESCE(?, enabled), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(raw.domain ?? null, backend?.addr ?? null, raw.backend_protocol ?? null, raw.backend_host ?? null,
          raw.websocket_enable === undefined ? null : Number(Boolean(raw.websocket_enable)), raw.gzip_enable === undefined ? null : Number(Boolean(raw.gzip_enable)),
          subscriptionId, localGroupId, raw.enable === undefined ? null : Number(Boolean(raw.enable)), sites[0].id);
      if (billing) { await billing.syncSitePorts(sites[0].id, raw); await billing.enforceUser(user.id, { syncTraffic: false }); }
      return { status: 200, data, action: 'site.update', resourceId: sites[0].id };
    }
    if (req.method === 'DELETE') {
      const data = await upstreamClient.request('DELETE', `/v1/sites/${sites.map(site => site.upstream_id).join(',')}`);
      await db.prepare(`DELETE FROM sites WHERE id IN (${sites.map(() => '?').join(',')}) AND owner_id = ?`).run(...sites.map(site => site.id), user.id);
      if (billing) await billing.enforceUser(user.id, { syncTraffic: false });
      return { status: 200, data, action: 'site.delete', resourceId: localIds.join(',') };
    }
  }

  if (path === '/site-sys-config' && req.method === 'GET') {
    const upstreamClient = upstreams ? await upstreams.defaultClient(user.id) : cdnfly;
    return { status: 200, data: await upstreamClient.request('GET', '/v1/site-sys-config') };
  }
  if (path === '/configs' && req.method === 'GET') return { status: 200, data: [] };
  if (path === '/configs/global-0-system-recharge' && req.method === 'GET') {
    const upstreamClient = upstreams ? await upstreams.defaultClient(user.id) : cdnfly;
    return { status: 200, data: await upstreamClient.request('GET', '/v1/configs/global-0-system-recharge') };
  }
  const configMatch = path.match(/^\/configs\/site-(\d+)-(.+)$/);
  if (configMatch && req.method === 'GET') {
    const site = await ownSite(db, configMatch[1], user.id);
    if (!site) throw httpError('网站不存在', 404);
    const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
    return { status: 200, data: await upstreamClient.request('GET', `/v1/configs/site-${site.upstream_id}-${encodeURIComponent(configMatch[2])}`) };
  }

  const siteWaf = path.match(/^\/sites\/(\d+)\/waf-rules$/);
  if (siteWaf) {
    const site = await ownSite(db, siteWaf[1], user.id);
    if (!site) throw httpError('网站不存在', 404);
    const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
    if (!await supportsWafRules(upstreamClient)) throw unsupportedWaf();
    if (req.method === 'GET') {
      const data = await upstreamClient.request('GET', `/v1/sites/${site.upstream_id}/waf-rules`);
      const ref = findCollection(data); const items = ref?.items || (Array.isArray(data) ? data : []);
      const visible = (await Promise.all(items.map(async record => {
        const upstreamId = record.id ?? record.rule_id ?? record.waf_rule_id;
        const mapping = await resourceByUpstream(db, 'waf-rules', upstreamId, user.id, { allowShared: true, upstreamAccountId: upstreamClient.accountId });
        return mapping ? { ...record, id: mapping.id, rule_id: mapping.id, waf_rule_id: mapping.id } : null;
      }))).filter(Boolean);
      return { status: 200, data: setCollection(data, ref, visible) };
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body) || body.length > 50) throw httpError('WAF 规则编排必须为不超过 50 项的数组');
      const translated = await Promise.all(body.map(async item => {
        const localId = item.id ?? item.rule_id ?? item.waf_rule_id;
        const mapping = await resourceByLocal(db, 'waf-rules', localId, user.id, { allowShared: true });
        if (!mapping) throw httpError('WAF 规则不存在', 404);
        if (upstreams && mapping.upstream_account_id && Number(mapping.upstream_account_id) !== Number(upstreamClient.accountId)) {
          throw httpError('WAF 规则与当前网站不属于同一 CDN 服务', 409);
        }
        const clean = stripForbidden(item);
        delete clean.id; delete clean.waf_rule_id;
        clean.rule_id = Number(mapping.upstream_id);
        return clean;
      }));
      return { status: 200, data: await upstreamClient.request('PUT', `/v1/sites/${site.upstream_id}/waf-rules`, translated), action: 'site.waf.update', resourceId: site.id };
    }
  }

  if (path === '/cname-check' && req.method === 'POST') {
    const rawBody = await readBody(req);
    const ownedSites = await db.prepare('SELECT domain,cname FROM sites WHERE owner_id = ?').all(user.id);
    const domains = ownedSites.flatMap(row => String(row.domain).split(',')).map(item => item.trim().toLowerCase());
    const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) && (rawBody.domain || rawBody.hostname)
      ? { domain: String(rawBody.domain || rawBody.hostname).trim() }
      : rawBody;
    const candidateValue = value => typeof value === 'string' ? value : value?.domain ?? value?.hostname ?? '';
    const candidates = Array.isArray(body)
      ? body.map(item => String(candidateValue(item)).trim()).filter(Boolean)
      : (body && typeof body === 'object' && (body.domain || body.hostname)
        ? [String(body.domain || body.hostname).trim()]
        : Object.entries(body || {}).map(([key, value]) => String(candidateValue(value) || key).trim()).filter(Boolean));
    if (!candidates.length || candidates.some(candidate => !domains.includes(candidate.toLowerCase()))) throw httpError('只能检查当前租户网站的域名', 403);
    const checks = await Promise.all(candidates.map(candidate => {
      const site = ownedSites.find(item => String(item.domain).split(',').some(domain => domain.trim().toLowerCase() === candidate.toLowerCase()));
      return checkCnameResolution(candidate, site?.cname, dnsResolveCname);
    }));
    return { status: 200, data: checks.length === 1 ? checks[0] : { ok: checks.every(item => item.ok), items: checks } };
  }

  if (path === '/domains' && req.method === 'GET') {
    if (!upstreams) {
      await pruneOrphanDomainMappings(db, user.id);
      const upstream = clone(await cdnfly.request('GET', `/v1/domains${queryString(url)}`));
      const ref = findCollection(upstream); const source = ref?.items || (Array.isArray(upstream) ? upstream : []);
      const visible = (await Promise.all(source.map(record => localizeDomain(db, record, user.id)))).filter(Boolean);
      return { status: 200, data: setCollection(upstream, ref, visible) };
    }
    const clients = upstreams ? await upstreams.clientsForUser(user.id) : [cdnfly]; const visible = [];
    for (const client of clients) {
      await pruneOrphanDomainMappings(db, user.id, client.accountId);
      const upstream = clone(await client.request('GET', `/v1/domains${queryString(url)}`));
      const ref = findCollection(upstream); const source = ref?.items || (Array.isArray(upstream) ? upstream : []);
      visible.push(...(await Promise.all(source.map(record => localizeDomain(db, record, user.id, client.accountId)))).filter(Boolean));
    }
    return { status: 200, data: { count: visible.length, items: visible } };
  }
  if (path === '/domains' && req.method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body)) throw httpError('域名同步请求必须为数组');
    const translated = await Promise.all(body.map(async item => {
      const localId = typeof item === 'object' ? item.id : item;
      const mapping = await resourceByLocal(db, 'domains', localId, user.id);
      if (!mapping) throw httpError('域名记录不存在', 404);
      return typeof item === 'object' ? { ...stripForbidden(item), id: Number(mapping.upstream_id) } : Number(mapping.upstream_id);
    }));
    const mappings = await Promise.all(body.map(item => resourceByLocal(db, 'domains', typeof item === 'object' ? item.id : item, user.id)));
    if (upstreams && new Set(mappings.map(item => Number(item.upstream_account_id))).size > 1) throw httpError('一次只能同步同一 CDN 服务下的域名', 409);
    const upstreamClient = upstreams ? await upstreams.clientForResource(mappings[0]) : cdnfly;
    return { status: 200, data: await upstreamClient.request('POST', '/v1/domains', translated), action: 'domain.sync' };
  }

  const collection = path.match(/^\/([a-z-]+)$/);
  if (collection && RESOURCE_KINDS.has(collection[1])) {
    const kind = collection[1];
    if (kind === 'waf-rules' && !await userSupportsWafRules(upstreams, cdnfly, user.id)) throw unsupportedWaf();
    if (req.method === 'GET') {
      const clients = upstreams ? await upstreams.clientsForUser(user.id) : [cdnfly]; const items = [];
      for (const client of clients) { const data = await listResources({ db, cdnfly: client, kind, user, url }); const ref = findCollection(data); items.push(...(ref?.items || (Array.isArray(data) ? data : []))); }
      return { status: 200, data: { count: items.length, items } };
    }
    if (req.method === 'POST') return { status: 201, data: await createResources({ db, cdnfly, upstreams, billing, kind, user, body: await readBody(req) }), action: `${kind}.create` };
    if (req.method === 'PUT') {
      if (['site-groups', 'stream-groups'].includes(kind)) throw httpError('请使用带资源 ID 的更新接口', 405);
      return { status: 200, data: await updateCollection({ db, cdnfly, upstreams, billing, kind, user, body: await readBody(req) }), action: `${kind}.update` };
    }
  }

  const detail = path.match(/^\/([a-z-]+)\/([0-9,]+)$/);
  if (detail && RESOURCE_KINDS.has(detail[1])) {
    const [, kind, localIdsText] = detail;
    const localIds = localIdsText.split(',');
    const mappings = await Promise.all(localIds.map(id => resourceByLocal(db, kind, id, user.id, { allowShared: req.method === 'GET' && kind === 'waf-rules' })));
    if (mappings.some(row => !row)) throw httpError('资源不存在', 404);
    if (upstreams && new Set(mappings.map(row => Number(row.upstream_account_id))).size > 1) throw httpError('批量操作只能包含同一 CDN 服务下的资源', 409);
    const upstreamClient = upstreams ? await upstreams.clientForResource(mappings[0]) : cdnfly;
    if (kind === 'waf-rules' && !await supportsWafRules(upstreamClient)) throw unsupportedWaf();
    if (req.method !== 'GET' && mappings.some(row => row.shared)) throw httpError('共享资源只读', 403);
    if (req.method === 'GET' && localIds.length === 1) {
      const mapping = mappings[0];
      if (kind === 'certs' && url.searchParams.get('action') === 'download') {
        return { status: 200, download: await upstreamClient.download(`/v1/certs/${mapping.upstream_id}?action=download`) };
      }
      let data = await resourceDetail(upstreamClient, kind, mapping.upstream_id, mapping);
      if (kind === 'acls') {
        data = mergeResourceSnapshot(kind, resourceSnapshot(mapping), data);
        await saveResource(db, kind, mapping.upstream_id, user.id, data, Boolean(mapping.shared), mapping.upstream_account_id);
      }
      let localized;
      if (kind === 'streams') localized = await translateStreamReferences(db, data, user.id, true, upstreamClient.accountId);
      else if (kind === 'certs') {
        const certificateBody = data.cert; const source = { ...data }; delete source.cert;
        localized = await localizeReferences(db, source, user.id, upstreamClient.accountId);
        if (certificateBody !== undefined) localized.cert = certificateBody;
      } else localized = await localizeReferences(db, data, user.id, upstreamClient.accountId);
      if (kind === 'cc-rules') localized = await translateCcRuleReferences(db, localized, user.id, true, upstreamClient.accountId);
      if (kind === 'streams') await syncStreamPorts(db, mapping.id, data);
      const publicValue = publicRecord(localized, mapping.id, Boolean(mapping.shared));
      const customerValue = exposeResourceRecord(kind, publicValue);
      const output = kind === 'certs' ? redactCertificate(customerValue)
        : kind === 'dnsapis' ? redactDnsApi(customerValue)
          : customerValue;
      if (kind === 'streams') {
        const sub = await db.prepare('SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(mapping.subscription_id);
        output.subscription_id = mapping.subscription_id; output.plan_name = sub?.name || null;
        output.groups = mapping.local_group_id || '';
      }
      else if (mapping.subscription_id) output.subscription_id = mapping.subscription_id;
      return { status: 200, data: output };
    }
    if (req.method === 'PUT' && localIds.length === 1) {
      const input = { ...(await readBody(req)), id: Number(localIds[0]) };
      let targetSubscription = mappings[0].subscription_id;
      if (kind === 'streams' && billing && (input.subscriptionId !== undefined || input.subscription_id !== undefined)) {
        const selected = await billing.resolveSubscription(user.id, input.subscriptionId ?? input.subscription_id);
        if (upstreams && Number(selected.upstream_id) !== Number(mappings[0].upstream_account_id)) throw httpError('四层转发不能直接迁移到其他 CDN 服务，请在目标套餐下重新创建', 409);
        if (Number(selected.id) !== Number(mappings[0].subscription_id)) await billing.assertProjected(user.id, { ports: countStreamPorts(input) || (await db.prepare('SELECT COUNT(*) AS count FROM stream_ports WHERE resource_id=?').get(mappings[0].id)).count }, selected.id);
        targetSubscription = selected.id;
      }
      let body;
      let localStreamGroupId = null;
      if (kind === 'streams') {
        const sanitized = sanitizeStreamInput(input, { partial: true });
        localStreamGroupId = await resolveLocalStreamGroup(db, user.id, requestedStreamGroup(input), mappings[0].local_group_id);
        body = await translateStreamReferences(db, sanitized, user.id, false, upstreamClient.accountId);
        body.id = Number(mappings[0].upstream_id);
        const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, user.id);
        if (customerGroups?.stream) body.groups = String(customerGroups.stream.upstream_group_id);
      } else {
        const sanitized = kind === 'certs' ? sanitizeCertificateInput(input, { partial: true, existing: resourceSnapshot(mappings[0]) })
          : kind === 'dnsapis' ? sanitizeDnsApiInput(input, { partial: true, existing: resourceSnapshot(mappings[0]) })
            : kind === 'acls' ? sanitizeAclInput(input, { partial: true, existing: resourceSnapshot(mappings[0]) })
            : input;
        sanitized.id = Number(mappings[0].id);
        body = await translateResourceId(db, kind, sanitized, user.id, false, upstreamClient.accountId);
      }
      delete body.id;
      delete body.user_package;
      body = ownershipPayload(kind, upstreamClient, user.id, body, resourceSnapshot(mappings[0]));
      const data = await upstreamClient.request('PUT', `/v1/${kind}/${mappings[0].upstream_id}`, body);
      await saveResource(db, kind, mappings[0].upstream_id, user.id,
        { ...(resourceSnapshot(mappings[0]) || {}), ...body }, Boolean(mappings[0].shared), mappings[0].upstream_account_id);
      await markOwnershipPersisted(db, kind, mappings[0].id, upstreamClient, user.id);
      if (kind === 'streams') {
        await db.prepare('UPDATE tenant_resources SET subscription_id=?,local_group_id=? WHERE id=?')
          .run(targetSubscription, localStreamGroupId, mappings[0].id);
        await syncStreamPorts(db, mappings[0].id, input);
      }
      if (kind === 'streams' && billing) await billing.enforceUser(user.id, { syncTraffic: false });
      return { status: 200, data: exposeResourceRecord(kind, data), action: `${kind}.update`, resourceId: mappings[0].id };
    }
    if (req.method === 'DELETE') {
      let data;
      if (kind === 'streams') {
        for (const mapping of mappings) requireStoppedResource(mapping, '四层转发');
        const results = [];
        for (const mapping of mappings) {
          results.push(await deleteStreamResource(upstreamClient, mapping.upstream_id));
          await db.prepare('DELETE FROM tenant_resources WHERE id=? AND owner_id=?').run(mapping.id, user.id);
        }
        data = results.length === 1 ? results[0] : results;
      } else {
        if (kind === 'certs') for (const mapping of mappings) requireStoppedResource(mapping, '证书');
        const upstreamIds = mappings.map(row => row.upstream_id).join(',');
        try {
          data = await upstreamClient.request('DELETE', `/v1/${kind}/${upstreamIds}`);
        } catch (error) {
          if (kind === 'certs' && STREAM_DISABLE_FIRST.test(String(error?.message || ''))) {
            throw httpError('请先停用证书，再执行删除操作', 409);
          }
          throw error;
        }
        await db.prepare(`DELETE FROM tenant_resources WHERE id IN (${mappings.map(() => '?').join(',')}) AND owner_id = ?`).run(...mappings.map(row => row.id), user.id);
      }
      if (kind === 'streams' && billing) await billing.enforceUser(user.id, { syncTraffic: false });
      return { status: 200, data, action: `${kind}.delete`, resourceId: localIdsText };
    }
  }

  throw httpError('当前接口不支持此操作', 404);
}

export const tenantProxyInternals = {
  stripForbidden, parseIds, saveResource, resourceByLocal, translateReferences, localizeReferences, translateStreamReferences,
  syncStreamPorts, createResources, extractCname, extractCompleteCname, cnameDomainId,
  findCnameDomain, resolveCnameDomain, resolveCompleteCname, redactCertificate, redactDnsApi,
  sanitizeCertificateInput, sanitizeDnsApiInput, sanitizeStreamInput, sanitizeAclInput, resourceDetail, mergeResourceSnapshot,
  resolveLocalStreamGroup,
  ownershipPayload, exposeResourceRecord, markOwnershipPersisted,
  validateCompatSiteInput, validateCompatStreamInput, supportsAttackLogs,
  normalizeTlsProtocols, normalizeProxyCacheUnit, normalizeSiteBackendState, normalizeSiteWriteInput, checkCnameResolution,
  countCustomSitePorts,
  deleteStreamResource, resourceIsStopped, requireStoppedResource,
};
export { syncSiteCnames };
