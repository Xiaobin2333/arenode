import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, databaseInternals } from '../src/db.js';
import { ensureCustomerUpstreamGroups } from '../src/customer-groups.js';
import { reconcileCustomerUpstreamGroups } from '../src/customer-group-reconciliation.js';
import { handleTenantProxy, tenantProxyInternals } from '../src/tenant-proxy.js';

function addUser(db, username) {
  return Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run(username, 'x', 'user', 20).lastInsertRowid);
}

function addAccount(db, name) {
  return Number(db.prepare(`INSERT INTO upstream_accounts (name,base_url,api_key_encrypted,api_secret_encrypted)
    VALUES (?,?,?,?)`).run(name, `https://${name}.example`, 'key', 'secret').lastInsertRowid);
}

function fakeClient(accountId, calls, state = { next: 1000, groups: new Map() }, groupNamespace = 'TEST-SITE') {
  return {
    accountId, packageId: 'pkg-1', groupNamespace,
    async request(method, path, body) {
      calls.push({ accountId, method, path, body });
      const groupKind = path.match(/^\/v1\/(site-groups|stream-groups)(?:\?limit=0)?$/)?.[1];
      if (method === 'GET' && groupKind) return { items: state.groups.get(`${accountId}:${groupKind}`) || [] };
      if (method === 'POST' && groupKind) {
        const id = String(state.next++); const key = `${accountId}:${groupKind}`;
        state.groups.set(key, [...(state.groups.get(key) || []), { id, ...body }]);
        return id;
      }
      if (method === 'POST' && path === '/v1/streams') return 'stream-1';
      if (method === 'POST' && path === '/v1/sites') return 'site-1';
      if (method === 'GET' && path === '/v1/streams/stream-1') return { id: 'stream-1', groups: 'hidden', listen: [{ port: 443, protocol: 'tcp' }] };
      if (method === 'GET' && path === '/v1/sites/site-1') return { id: 'site-1', groups: 'hidden', domain: 'hidden.example.com' };
      return true;
    },
  };
}

test('两个分销站使用同一上游和相同客户 ID 时按命名空间创建不同隐藏分组', async () => {
  const firstDb = createDatabase(); const secondDb = createDatabase();
  try {
    const firstUser = addUser(firstDb, 'same-user'); const secondUser = addUser(secondDb, 'same-user');
    const firstAccount = addAccount(firstDb, 'shared-upstream'); const secondAccount = addAccount(secondDb, 'shared-upstream');
    assert.equal(firstUser, secondUser); assert.equal(firstAccount, secondAccount);
    const calls = []; const state = { next: 1000, groups: new Map() };
    const first = await ensureCustomerUpstreamGroups(firstDb, fakeClient(firstAccount, calls, state, 'RESELLER-A'), firstUser);
    const second = await ensureCustomerUpstreamGroups(secondDb, fakeClient(secondAccount, calls, state, 'RESELLER-B'), secondUser);
    assert.notEqual(first.site.upstream_group_id, second.site.upstream_group_id);
    assert.notEqual(first.stream.upstream_group_id, second.stream.upstream_group_id);
    assert.deepEqual(state.groups.get(`${firstAccount}:site-groups`).map(item => item.name), [
      'AN-RESELLER-A-U000001', 'AN-RESELLER-B-U000001',
    ]);
  } finally { firstDb.close(); secondDb.close(); }
});

test('命名空间变化会迁移旧映射并保留历史记录', async () => {
  const db = createDatabase();
  try {
    const userId = addUser(db, 'namespace-migration'); const accountId = addAccount(db, 'namespace-upstream');
    db.prepare(`INSERT INTO upstream_customer_groups
      (user_id,upstream_account_id,resource_kind,upstream_group_id,name) VALUES (?,?,?,?,?)`)
      .run(userId, accountId, 'site', '900', 'ED-U000001');
    const calls = []; const state = { next: 1000, groups: new Map() };
    const migrated = await ensureCustomerUpstreamGroups(db, fakeClient(accountId, calls, state, 'RESELLER-NEW'), userId);
    assert.equal(migrated.site.name, 'AN-RESELLER-NEW-U000001');
    assert.deepEqual(db.prepare('SELECT upstream_group_id,name FROM upstream_customer_group_history').get(), {
      upstream_group_id: '900', name: 'ED-U000001',
    });
  } finally { db.close(); }
});

test('每个客户和上游账号各有一组隐藏站点/转发分组且可幂等复用', async () => {
  const db = createDatabase();
  try {
    const alice = addUser(db, 'group-alice'); const bob = addUser(db, 'group-bob');
    const firstAccount = addAccount(db, 'group-upstream-a'); const secondAccount = addAccount(db, 'group-upstream-b');
    const calls = []; const state = { next: 1000, groups: new Map() };
    const firstClient = fakeClient(firstAccount, calls, state); const secondClient = fakeClient(secondAccount, calls, state);
    const aliceFirst = await ensureCustomerUpstreamGroups(db, firstClient, alice);
    const repeated = await ensureCustomerUpstreamGroups(db, firstClient, alice);
    const bobFirst = await ensureCustomerUpstreamGroups(db, firstClient, bob);
    const aliceSecond = await ensureCustomerUpstreamGroups(db, secondClient, alice);

    assert.deepEqual(repeated, aliceFirst);
    assert.notEqual(aliceFirst.site.upstream_group_id, bobFirst.site.upstream_group_id);
    assert.notEqual(aliceFirst.stream.upstream_group_id, bobFirst.stream.upstream_group_id);
    assert.notEqual(aliceFirst.site.upstream_group_id, aliceSecond.site.upstream_group_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM upstream_customer_groups').get().count, 6);
    assert.equal(calls.filter(call => call.method === 'POST' && /-groups$/.test(call.path)).length, 6);
  } finally { db.close(); }
});

test('站内转发分组 CRUD 不请求上游', async () => {
  const db = createDatabase();
  try {
    const userId = addUser(db, 'local-stream-group'); const calls = [];
    const context = (method, path, body = {}) => handleTenantProxy({
      req: { method }, url: new URL(`http://localhost/api/cdnfly/v1${path}`),
      user: { id: userId, role: 'user' }, db, billing: null,
      cdnfly: { request: async (...args) => { calls.push(args); return true; } }, readBody: async () => body,
    });
    const created = await context('POST', '/stream-groups', { name: '生产转发', des: '站内标签' });
    const id = Number(created.data);
    assert.equal((await context('GET', '/stream-groups')).data.items[0].name, '生产转发');
    await context('PUT', `/stream-groups/${id}`, { name: '核心转发' });
    await context('DELETE', `/stream-groups/${id}`);
    assert.equal(calls.length, 0);
  } finally { db.close(); }
});

test('站点和转发创建更新强制隐藏上游分组且详情只返回站内分组', async () => {
  const db = createDatabase();
  try {
    const userId = addUser(db, 'hidden-stream-user'); const accountId = addAccount(db, 'hidden-stream-upstream');
    const localGroupId = Number(db.prepare('INSERT INTO customer_stream_groups (user_id,name) VALUES (?,?)')
      .run(userId, '客户可见分组').lastInsertRowid);
    const localSiteGroupId = Number(db.prepare('INSERT INTO customer_site_groups (user_id,name) VALUES (?,?)')
      .run(userId, '客户可见网站组').lastInsertRowid);
    const calls = []; const client = fakeClient(accountId, calls);
    const localId = Number(await tenantProxyInternals.createResources({
      db, cdnfly: client, upstreams: null, billing: null, kind: 'streams', user: { id: userId, role: 'user' },
      body: { groups: localGroupId, listen: [{ port: 443, protocol: 'tcp' }], backend_port: 443,
        backend: [{ addr: '192.0.2.10', weight: 1, state: 'up' }], balance_way: 'rr' },
    }));
    const mapping = db.prepare('SELECT * FROM tenant_resources WHERE id=?').get(localId);
    const hidden = db.prepare("SELECT upstream_group_id FROM upstream_customer_groups WHERE user_id=? AND upstream_account_id=? AND resource_kind='stream'")
      .get(userId, accountId).upstream_group_id;
    assert.equal(calls.find(call => call.method === 'POST' && call.path === '/v1/streams').body.groups, hidden);
    assert.notEqual(hidden, String(localGroupId));
    assert.equal(mapping.local_group_id, localGroupId);

    const update = await handleTenantProxy({
      req: { method: 'PUT' }, url: new URL(`http://localhost/api/cdnfly/v1/streams/${localId}`),
      user: { id: userId, role: 'user' }, db, cdnfly: client, billing: null,
      readBody: async () => ({ groups: localGroupId, des: '已更新' }),
    });
    assert.equal(update.status, 200);
    assert.equal(calls.findLast(call => call.method === 'PUT' && call.path === '/v1/streams/stream-1').body.groups, hidden);

    const detail = await handleTenantProxy({
      req: { method: 'GET' }, url: new URL(`http://localhost/api/cdnfly/v1/streams/${localId}`),
      user: { id: userId, role: 'user' }, db, cdnfly: client, billing: null, readBody: async () => ({}),
    });
    assert.equal(detail.data.groups, localGroupId);

    const createdSite = await handleTenantProxy({
      req: { method: 'POST' }, url: new URL('http://localhost/api/cdnfly/v1/sites'),
      user: { id: userId, role: 'user', site_limit: 20 }, db, cdnfly: client, billing: null,
      readBody: async () => ({ domain: 'hidden.example.com', backend: [{ addr: '192.0.2.11' }], groups: localSiteGroupId }),
    });
    assert.equal(createdSite.status, 201);
    const siteId = Number(createdSite.data);
    const hiddenSite = db.prepare("SELECT upstream_group_id FROM upstream_customer_groups WHERE user_id=? AND upstream_account_id=? AND resource_kind='site'")
      .get(userId, accountId).upstream_group_id;
    assert.equal(calls.find(call => call.method === 'POST' && call.path === '/v1/sites').body.groups, hiddenSite);
    assert.notEqual(hiddenSite, String(localSiteGroupId));
    assert.equal(db.prepare('SELECT local_group_id FROM sites WHERE id=?').get(siteId).local_group_id, localSiteGroupId);

    const siteUpdate = await handleTenantProxy({
      req: { method: 'PUT' }, url: new URL(`http://localhost/api/cdnfly/v1/sites/${siteId}`),
      user: { id: userId, role: 'user' }, db, cdnfly: client, billing: null,
      readBody: async () => ({ groups: localSiteGroupId, gzip_enable: 1 }),
    });
    assert.equal(siteUpdate.status, 200);
    assert.equal(calls.findLast(call => call.method === 'PUT' && call.path === '/v1/sites/site-1').body.groups, hiddenSite);
    const siteDetail = await handleTenantProxy({
      req: { method: 'GET' }, url: new URL(`http://localhost/api/cdnfly/v1/sites/${siteId}`),
      user: { id: userId, role: 'user' }, db, cdnfly: client, billing: null, readBody: async () => ({}),
    });
    assert.equal(siteDetail.data.group_id, localSiteGroupId);
    assert.equal(siteDetail.data.groups, undefined);
  } finally { db.close(); }
});

test('旧转发分组迁移为站内分组并保留资源归组', async () => {
  const db = createDatabase();
  try {
    const userId = addUser(db, 'legacy-stream-group');
    const legacyGroupId = await tenantProxyInternals.saveResource(db, 'stream-groups', '281', userId, { name: '旧转发组', des: '迁移备注' });
    const streamId = await tenantProxyInternals.saveResource(db, 'streams', '3350', userId, { groups: '281' });
    db.prepare("INSERT INTO user_configs (user_id,name,value,type,scope_name,scope_id,enable) VALUES (?,?,?,?,?,?,?)")
      .run(userId, 'balance_way', 'rr', 'stream', 'group', legacyGroupId, 1);
    await databaseInternals.migrateCustomerStreamGroups(db);
    const group = db.prepare('SELECT * FROM customer_stream_groups WHERE user_id=?').get(userId);
    assert.equal(group.name, '旧转发组'); assert.equal(group.description, '迁移备注');
    assert.equal(db.prepare('SELECT local_group_id FROM tenant_resources WHERE id=?').get(streamId).local_group_id, group.id);
    assert.equal(db.prepare('SELECT scope_id FROM user_configs WHERE user_id=?').get(userId).scope_id, group.id);
  } finally { db.close(); }
});

test('存量对账让同一客户的多个资源共用隐藏分组', async () => {
  const db = createDatabase();
  try {
    const userId = addUser(db, 'reconcile-user'); const accountId = addAccount(db, 'reconcile-upstream');
    db.prepare(`INSERT INTO sites (owner_id,upstream_account_id,upstream_id,domain,origin,state)
      VALUES (?,?,?,?,?,'active')`).run(userId, accountId, 'site-a', 'a.reconcile.example', '192.0.2.1');
    db.prepare(`INSERT INTO sites (owner_id,upstream_account_id,upstream_id,domain,origin,state)
      VALUES (?,?,?,?,?,'active')`).run(userId, accountId, 'site-b', 'b.reconcile.example', '192.0.2.2');
    await tenantProxyInternals.saveResource(db, 'streams', 'stream-a', userId, { groups: 'legacy' }, false, accountId);
    const calls = []; const client = fakeClient(accountId, calls);
    const upstreams = {
      clientForAccount: async () => client, clientForSite: async () => client,
      clientForResource: async () => client,
    };
    const result = await reconcileCustomerUpstreamGroups({ db, upstreams, cdnfly: client, strict: true });
    assert.equal(result.sites, 2); assert.equal(result.streams, 1); assert.equal(result.errors.length, 0);
    const siteGroupIds = calls.filter(call => call.method === 'PUT' && call.path.startsWith('/v1/sites/')).map(call => call.body.groups);
    assert.equal(new Set(siteGroupIds).size, 1);
    const stream = db.prepare("SELECT snapshot FROM tenant_resources WHERE kind='streams'").get();
    assert.equal(JSON.parse(stream.snapshot).groups,
      db.prepare("SELECT upstream_group_id FROM upstream_customer_groups WHERE user_id=? AND resource_kind='stream'").get(userId).upstream_group_id);
  } finally { db.close(); }
});

test('存量对账只在完整列表确认不存在时清理陈旧转发映射', async () => {
  const db = createDatabase();
  try {
    const userId = addUser(db, 'stale-stream-user'); const accountId = addAccount(db, 'stale-stream-upstream');
    db.prepare(`INSERT INTO sites (owner_id,upstream_account_id,upstream_id,domain,origin,state)
      VALUES (?,?,?,?,?,'active')`).run(userId, accountId, 'stale-site', 'stale.example.com', '192.0.2.20');
    const staleId = await tenantProxyInternals.saveResource(db, 'streams', 'missing-stream', userId, null, false, accountId);
    const calls = []; const client = fakeClient(accountId, calls);
    const baseRequest = client.request.bind(client);
    client.request = async (method, path, body) => {
      if (method === 'PUT' && path === '/v1/streams/missing-stream') throw new Error('转发不存在');
      if (method === 'GET' && path === '/v1/streams?limit=0') return { items: [] };
      return baseRequest(method, path, body);
    };
    const upstreams = { clientForAccount: async () => client, clientForSite: async () => client, clientForResource: async () => client };
    const result = await reconcileCustomerUpstreamGroups({ db, upstreams, cdnfly: client, strict: true });
    assert.equal(result.staleStreamsRemoved, 1, JSON.stringify(result)); assert.equal(result.errors.length, 0);
    assert.equal(db.prepare('SELECT id FROM tenant_resources WHERE id=?').get(staleId), undefined);
  } finally { db.close(); }
});
