import { normalizeUpstreamGroupNamespace } from './config.js';
import { BRAND_GROUP_PREFIX, BRAND_NAME } from './brand.js';

const GROUP_KINDS = {
  site: { apiKind: 'site-groups' },
  stream: { apiKind: 'stream-groups' },
};

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

function firstId(value) {
  if (Array.isArray(value)) return firstId(value[0]);
  if (value && typeof value === 'object') return firstId(value.id ?? value.ids ?? value.data ?? value.result);
  return String(value ?? '').split(',').map(item => item.trim()).find(Boolean) || '';
}

function groupIdentity(userId, namespace) {
  const suffix = String(Number(userId)).padStart(6, '0');
  const site = normalizeUpstreamGroupNamespace(namespace);
  return { name: `${BRAND_GROUP_PREFIX}-${site}-U${suffix}`, description: `${BRAND_NAME} ${site} customer U${suffix}` };
}

function clientIdentity(client, userId) {
  if (!client?.groupNamespace) {
    throw Object.assign(new Error('未配置当前站点的上游分组命名空间'), { status: 503 });
  }
  return groupIdentity(userId, client.groupNamespace);
}

async function mapping(db, userId, accountId, resourceKind) {
  return db.prepare(`SELECT * FROM upstream_customer_groups
    WHERE user_id=? AND upstream_account_id=? AND resource_kind=?`).get(Number(userId), Number(accountId), resourceKind);
}

async function saveMapping(db, userId, accountId, resourceKind, upstreamGroupId, name) {
  const current = await mapping(db, userId, accountId, resourceKind);
  if (current && (String(current.upstream_group_id) !== String(upstreamGroupId) || current.name !== name)) {
    await db.prepare(`INSERT INTO upstream_customer_group_history
      (user_id,upstream_account_id,resource_kind,upstream_group_id,name) VALUES (?,?,?,?,?)
      ON CONFLICT(upstream_account_id,resource_kind,upstream_group_id) DO NOTHING`)
      .run(Number(userId), Number(accountId), resourceKind, String(current.upstream_group_id), current.name);
  }
  await db.prepare(`INSERT INTO upstream_customer_groups
    (user_id,upstream_account_id,resource_kind,upstream_group_id,name) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,upstream_account_id,resource_kind) DO UPDATE SET
      upstream_group_id=excluded.upstream_group_id,name=excluded.name,updated_at=CURRENT_TIMESTAMP`)
    .run(Number(userId), Number(accountId), resourceKind, String(upstreamGroupId), name);
  return mapping(db, userId, accountId, resourceKind);
}

async function findNamedGroup(client, apiKind, name) {
  const payload = await client.request('GET', `/v1/${apiKind}?limit=0`);
  return collectionItems(payload).find(item => String(item?.name || '').trim() === name) || null;
}

async function provisionGroup(db, client, userId, resourceKind) {
  const accountId = Number(client?.accountId || 0);
  const config = GROUP_KINDS[resourceKind];
  if (!config) throw new Error('客户上游分组类型无效');
  if (!accountId) return null;

  const identity = clientIdentity(client, userId);
  const current = await mapping(db, userId, accountId, resourceKind);
  if (current?.name === identity.name) return current;
  const existing = await findNamedGroup(client, config.apiKind, identity.name);
  if (existing?.id !== undefined) return saveMapping(db, userId, accountId, resourceKind, existing.id, identity.name);

  let upstreamGroupId;
  try {
    upstreamGroupId = firstId(await client.request('POST', `/v1/${config.apiKind}`, {
      name: identity.name, des: identity.description,
    }));
  } catch (error) {
    const raced = await findNamedGroup(client, config.apiKind, identity.name).catch(() => null);
    if (!raced?.id) throw error;
    upstreamGroupId = String(raced.id);
  }
  if (!upstreamGroupId) throw Object.assign(new Error('CDN 服务未返回资源分组 ID'), { status: 502 });
  return saveMapping(db, userId, accountId, resourceKind, upstreamGroupId, identity.name);
}

export async function ensureCustomerUpstreamGroup(db, client, userId, resourceKind) {
  const accountId = Number(client?.accountId || 0);
  if (!accountId) return null;
  const identity = clientIdentity(client, userId);
  const current = await mapping(db, userId, accountId, resourceKind);
  if (current?.name === identity.name) return current;
  const lock = await db.withAdvisoryLock(`customer-group:${accountId}:${userId}:${resourceKind}`,
    () => provisionGroup(db, client, userId, resourceKind));
  if (lock.acquired) return lock.value;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const created = await mapping(db, userId, accountId, resourceKind);
    if (created?.name === identity.name) return created;
  }
  throw Object.assign(new Error('客户专属上游分组正在初始化，请稍后重试'), { status: 409 });
}

export async function ensureCustomerUpstreamGroups(db, client, userId) {
  const [site, stream] = await Promise.all([
    ensureCustomerUpstreamGroup(db, client, userId, 'site'),
    ensureCustomerUpstreamGroup(db, client, userId, 'stream'),
  ]);
  return { site, stream };
}

export const customerGroupInternals = { collectionItems, firstId, groupIdentity, clientIdentity };
