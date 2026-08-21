import { ensureCustomerUpstreamGroups } from './customer-groups.js';
import { OWNERSHIP_REMARK_KINDS, ownershipMarker, ownershipRemark } from './resource-ownership.js';
import { BRAND_GROUP_PREFIX, LEGACY_BRAND_GROUP_PREFIXES } from './brand.js';

const INTERNAL_GROUP_PREFIX = new RegExp(`^(?:${[BRAND_GROUP_PREFIX, ...LEGACY_BRAND_GROUP_PREFIXES].join('|')})-`);

function collectionItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'list', 'rows', 'data', 'result']) {
    if (Array.isArray(value[key])) return value[key];
    const nested = collectionItems(value[key]);
    if (nested.length) return nested;
  }
  return [];
}

function snapshot(row) {
  if (!row?.snapshot) return {};
  if (typeof row.snapshot === 'object') return structuredClone(row.snapshot);
  try { return JSON.parse(row.snapshot); } catch { return {}; }
}

function groupIds(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

async function customerUpstreamPairs(db) {
  const [subscriptions, sites, resources] = await Promise.all([
    db.prepare(`SELECT DISTINCT user_id,upstream_id FROM subscriptions
      WHERE upstream_id IS NOT NULL AND status IN ('active','suspended')`).all(),
    db.prepare('SELECT DISTINCT owner_id AS user_id,upstream_account_id AS upstream_id FROM sites WHERE upstream_account_id IS NOT NULL').all(),
    db.prepare(`SELECT DISTINCT owner_id AS user_id,upstream_account_id AS upstream_id FROM tenant_resources
      WHERE owner_id IS NOT NULL AND upstream_account_id IS NOT NULL`).all(),
  ]);
  const pairs = new Map();
  for (const row of [...subscriptions, ...sites, ...resources]) {
    const userId = Number(row.user_id); const accountId = Number(row.upstream_id);
    if (Number.isInteger(userId) && userId > 0 && Number.isInteger(accountId) && accountId > 0) {
      pairs.set(`${userId}:${accountId}`, { userId, accountId });
    }
  }
  return [...pairs.values()].sort((a, b) => a.userId - b.userId || a.accountId - b.accountId);
}

async function clientForPair(db, upstreams, pair, cdnfly) {
  if (!upstreams) return cdnfly;
  const subscription = await db.prepare(`SELECT * FROM subscriptions
    WHERE user_id=? AND upstream_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,id DESC LIMIT 1`)
    .get(pair.userId, pair.accountId);
  if (subscription) return upstreams.clientForSubscription(subscription);
  const site = await db.prepare('SELECT * FROM sites WHERE owner_id=? AND upstream_account_id=? ORDER BY id LIMIT 1')
    .get(pair.userId, pair.accountId);
  if (site) return upstreams.clientForSite(site);
  const resource = await db.prepare('SELECT * FROM tenant_resources WHERE owner_id=? AND upstream_account_id=? ORDER BY id LIMIT 1')
    .get(pair.userId, pair.accountId);
  if (resource) return upstreams.clientForResource(resource);
  return upstreams.clientForAccount(pair.accountId);
}

async function reconcileSite(db, upstreams, cdnfly, site, upstreamGroupId) {
  const client = upstreams ? await upstreams.clientForSite(site) : cdnfly;
  await client.request('PUT', `/v1/sites/${encodeURIComponent(site.upstream_id)}`, { groups: String(upstreamGroupId) });
}

async function reconcileStream(db, upstreams, cdnfly, stream, upstreamGroupId) {
  const client = upstreams ? await upstreams.clientForResource(stream) : cdnfly;
  const groups = String(upstreamGroupId);
  await client.request('PUT', `/v1/streams/${encodeURIComponent(stream.upstream_id)}`, { groups });
  await db.prepare('UPDATE tenant_resources SET snapshot=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(JSON.stringify({ ...snapshot(stream), groups }), stream.id);
}

async function removeStaleStreamIfAbsent(db, client, stream) {
  let payload;
  try { payload = await client.request('GET', '/v1/streams?limit=0'); }
  catch { return false; }
  const exists = collectionItems(payload).some(item => String(item?.id) === String(stream.upstream_id));
  if (exists) return false;
  await db.prepare("DELETE FROM tenant_resources WHERE id=? AND owner_id=? AND kind='streams'")
    .run(stream.id, stream.owner_id);
  return true;
}

async function reconcileResourceRemarks(db, upstreams, cdnfly, pair) {
  const result = { checked: 0, updated: 0, errors: [] };
  const kinds = [...OWNERSHIP_REMARK_KINDS];
  const rows = await db.prepare(`SELECT * FROM tenant_resources
    WHERE owner_id=? AND upstream_account_id=? AND shared=0 AND kind IN (${kinds.map(() => '?').join(',')})
    ORDER BY id`).all(pair.userId, pair.accountId, ...kinds);
  for (const row of rows) {
    result.checked += 1;
    try {
      const client = upstreams ? await upstreams.clientForResource(row) : cdnfly;
      const marker = ownershipMarker(client, pair.userId);
      if (row.ownership_marker === marker) continue;
      const value = snapshot(row);
      await client.request('PUT', `/v1/${row.kind}/${encodeURIComponent(row.upstream_id)}`, {
        des: ownershipRemark(client, pair.userId, value.des ?? value.description ?? ''),
      });
      await db.prepare('UPDATE tenant_resources SET ownership_marker=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(marker, row.id);
      result.updated += 1;
    } catch (error) {
      result.errors.push({ userId: pair.userId, accountId: pair.accountId, kind: row.kind,
        resourceId: Number(row.id), message: error.message });
    }
  }
  return result;
}

async function cleanupLegacyGroups(db, client, pair, hiddenGroups) {
  const result = { deleted: 0, retained: 0, supersededDeleted: 0, supersededRetained: 0 };
  const [sitePayload, streamPayload, legacy, superseded] = await Promise.all([
    client.request('GET', '/v1/sites?limit=0'),
    client.request('GET', '/v1/streams?limit=0'),
    db.prepare(`SELECT * FROM tenant_resources WHERE owner_id=? AND upstream_account_id=?
      AND kind IN ('site-groups','stream-groups') ORDER BY id`).all(pair.userId, pair.accountId),
    db.prepare(`SELECT * FROM upstream_customer_group_history WHERE user_id=? AND upstream_account_id=?
      AND cleaned_at IS NULL ORDER BY id`).all(pair.userId, pair.accountId),
  ]);
  const references = {
    'site-groups': new Set(collectionItems(sitePayload).flatMap(item => groupIds(item?.groups ?? item?.group_id))),
    'stream-groups': new Set(collectionItems(streamPayload).flatMap(item => groupIds(item?.groups ?? item?.group_id))),
  };
  const protectedIds = new Set([
    String(hiddenGroups.site.upstream_group_id), String(hiddenGroups.stream.upstream_group_id),
  ]);
  for (const row of legacy) {
    const id = String(row.upstream_id);
    const value = snapshot(row);
    if (protectedIds.has(id) || INTERNAL_GROUP_PREFIX.test(String(value.name || '')) || references[row.kind].has(id)) {
      result.retained += 1;
      continue;
    }
    try {
      await client.request('DELETE', `/v1/${row.kind}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (Number(error?.upstreamStatus) !== 404) throw error;
    }
    await db.prepare('DELETE FROM tenant_resources WHERE id=? AND owner_id=?').run(row.id, pair.userId);
    result.deleted += 1;
  }
  for (const row of superseded) {
    const id = String(row.upstream_group_id);
    const apiKind = row.resource_kind === 'site' ? 'site-groups' : 'stream-groups';
    if (protectedIds.has(id) || references[apiKind].has(id)) {
      result.supersededRetained += 1;
      continue;
    }
    try {
      await client.request('DELETE', `/v1/${apiKind}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (Number(error?.upstreamStatus) !== 404) throw error;
    }
    await db.prepare('UPDATE upstream_customer_group_history SET cleaned_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
    result.supersededDeleted += 1;
  }
  return result;
}

export async function reconcileCustomerUpstreamGroups({ db, upstreams = null, cdnfly = null, cleanupLegacy = false, strict = false } = {}) {
  const result = { pairs: 0, groups: 0, sites: 0, streams: 0, staleStreamsRemoved: 0,
    remarksChecked: 0, remarksUpdated: 0,
    legacyDeleted: 0, legacyRetained: 0, supersededDeleted: 0, supersededRetained: 0, errors: [] };
  for (const pair of await customerUpstreamPairs(db)) {
    result.pairs += 1;
    try {
      const groupClient = await clientForPair(db, upstreams, pair, cdnfly);
      const hiddenGroups = await ensureCustomerUpstreamGroups(db, groupClient, pair.userId);
      if (!hiddenGroups?.site || !hiddenGroups?.stream) continue;
      result.groups += 2;
      const [sites, streams] = await Promise.all([
        db.prepare('SELECT * FROM sites WHERE owner_id=? AND upstream_account_id=? AND upstream_id IS NOT NULL ORDER BY id')
          .all(pair.userId, pair.accountId),
        db.prepare("SELECT * FROM tenant_resources WHERE owner_id=? AND upstream_account_id=? AND kind='streams' ORDER BY id")
          .all(pair.userId, pair.accountId),
      ]);
      for (const site of sites) {
        try {
          await reconcileSite(db, upstreams, cdnfly, site, hiddenGroups.site.upstream_group_id);
          result.sites += 1;
        } catch (error) {
          result.errors.push({ userId: pair.userId, accountId: pair.accountId, kind: 'site', resourceId: Number(site.id), message: error.message });
        }
      }
      for (const stream of streams) {
        try {
          await reconcileStream(db, upstreams, cdnfly, stream, hiddenGroups.stream.upstream_group_id);
          result.streams += 1;
        } catch (error) {
          const client = upstreams ? await upstreams.clientForResource(stream) : cdnfly;
          if (await removeStaleStreamIfAbsent(db, client, stream)) result.staleStreamsRemoved += 1;
          else result.errors.push({ userId: pair.userId, accountId: pair.accountId, kind: 'stream', resourceId: Number(stream.id), message: error.message });
        }
      }
      const remarks = await reconcileResourceRemarks(db, upstreams, cdnfly, pair);
      result.remarksChecked += remarks.checked;
      result.remarksUpdated += remarks.updated;
      result.errors.push(...remarks.errors);
      if (cleanupLegacy && !result.errors.some(error => error.userId === pair.userId && error.accountId === pair.accountId)) {
        try {
          const cleanup = await cleanupLegacyGroups(db, groupClient, pair, hiddenGroups);
          result.legacyDeleted += cleanup.deleted; result.legacyRetained += cleanup.retained;
          result.supersededDeleted += cleanup.supersededDeleted; result.supersededRetained += cleanup.supersededRetained;
        } catch (error) {
          result.errors.push({ userId: pair.userId, accountId: pair.accountId, kind: 'legacy-group-cleanup', message: error.message });
        }
      }
    } catch (error) {
      result.errors.push({ userId: pair.userId, accountId: pair.accountId, kind: 'group', message: error.message });
    }
  }
  if (strict && result.errors.length) {
    const error = new Error(`客户上游分组对账存在 ${result.errors.length} 个失败项`);
    error.result = result;
    throw error;
  }
  return result;
}

export const customerGroupReconciliationInternals = {
  customerUpstreamPairs, groupIds, collectionItems, removeStaleStreamIfAbsent, reconcileResourceRemarks,
};
