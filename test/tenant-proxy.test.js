import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase, databaseInternals } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/app.js';
import { handleTenantProxy, syncSiteCnames, tenantProxyInternals } from '../src/tenant-proxy.js';

async function fixture() {
  const db = createDatabase();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, ?, ?)');
  const admin = Number(add.run('admin', hashPassword('admin-password'), 'admin', 0).lastInsertRowid);
  const alice = Number(add.run('alice', hashPassword('alice-password'), 'user', 5).lastInsertRowid);
  const bob = Number(add.run('bob', hashPassword('bobby-password'), 'user', 5).lastInsertRowid);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state, cname) VALUES (?, 'site-a', 'a.example.com', '192.0.2.1', 'active', 'alice.cdn.example')`).run(alice);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, state, cname) VALUES (?, 'site-b', 'b.example.com', '192.0.2.2', 'active', 'bob.cdn.example')`).run(bob);
  const groupAlice = Number(db.prepare('INSERT INTO customer_site_groups (user_id,name) VALUES (?,?)').run(alice, 'Alice group').lastInsertRowid);
  const groupBob = Number(db.prepare('INSERT INTO customer_site_groups (user_id,name) VALUES (?,?)').run(bob, 'Bob group').lastInsertRowid);
  const calls = [];
  const cdnfly = {
    packageId: 88, groupNamespace: 'TEST-TENANT',
    calls,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/v1/site-groups?')) return { count: 2, items: [{ id: 101, uid: 10, name: 'Alice group' }, { id: 102, uid: 10, name: 'Bob group' }] };
      if (method === 'POST' && path === '/v1/site-groups') return '103';
      if (method === 'POST' && path === '/v1/acls') return '701';
      if (method === 'GET' && path === '/v1/waf-rules') return { items: [
        { id: 301, uid: 0, scope: 'global', name: 'Global SQLi' },
        { id: 302, uid: 10, scope: 'user', name: 'Alice custom' },
        { id: 303, uid: 10, scope: 'user', name: 'Bob custom' },
      ] };
      if (method === 'PUT' && path.endsWith('/waf-rules')) return true;
      if (method === 'POST' && path === '/v1/cc-rules') return '401';
      if (method === 'POST' && path === '/v1/sites') return 'site-new';
      if (method === 'GET' && path.startsWith('/v1/domains')) return { count: 2, rows: [
        { id: 501, site_id: 'site-a', domain: 'a.example.com' }, { id: 502, site_id: 'site-b', domain: 'b.example.com' },
      ] };
      if (method === 'POST' && path === '/v1/cname-check') return { domain: 'a.example.com', ok: true };
      return { id: path.split('/').at(-1), ok: true };
    },
    createSite: async () => ({ id: 'legacy-new' }), getSite: async () => ({}), updateSite: async () => true,
    deleteSite: async () => true, health: async () => true,
  };
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 88 };
  const dnsResolveCname = async domain => domain === 'a.example.com' ? ['alice.cdn.example.'] : [];
  const server = http.createServer(createApp({ db, cdnfly, config, dnsResolveCname }));
  return { db, server, cdnfly, ids: { admin, alice, bob, groupAlice, groupBob } };
}

async function start(f) {
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${f.server.address().port}`;
}

async function login(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return response.headers.get('set-cookie').split(';')[0];
}

test('CNAME 优先使用完整值并组合上游 hostname 与 domain', () => {
  assert.equal(tenantProxyInternals.extractCname({ cname: 'https://full.example.net/path/' }), 'full.example.net');
  assert.equal(tenantProxyInternals.extractCname({ cname_hostname: 'hgzp2mc4', cname_domain: 'cdndns.vip' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname_hostname: 'hgzp2mc4.cdndns.vip', cname_domain: 'cdndns.vip' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname_domain: 'https://cdndns.vip/' }), 'cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname_domain: 'cdndns.vip' }, 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname: 'cdndns.vip' }, 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname('cdndns.vip', 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname('hgzp2mc4', 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname: 'hgzp2mc4', cname_domain: 'cdndns.vip' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname: 'cdndns.vip', cname_hostname: 'hgzp2mc4', cname_domain: 'cdndns.vip' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname: 'hgzp2mc4.cdndns.vip', cname_hostname: '', cname_domain: 'cdndns.vip' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ data: { cname_hostname: 'hgzp2mc4', cname_domain: 'cdndns.vip' } }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname: { host: 'hgzp2mc4', domain: 'cdndns.vip' } }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname: { hostname: 'hgzp2mc4' }, cname_domain: 'cdndns.vip' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ result: { cname: { hostname: 'hgzp2mc4', suffix: 'cdndns.vip' } } }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname_domain: 'cdndns.vip', data: { cname_hostname: 'hgzp2mc4' } }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCname({ cname_full: 'https://hgzp2mc4.cdndns.vip./path' }), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname_domain: 'cdndns.vip' }, 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname: 'cdndns.vip', cname_domain: 'cdndns.vip' }, 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname_hostname: 'fresh', cname_domain: 'cdndns.vip' }, 'old.example'), 'fresh.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname: 'fresh.cdndns.vip', cname_domain: 'cdndns.vip' }, 'old.example'), 'fresh.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname: 'hgzp2mc4', cname_domain: 'cdndns.vip' }, 'cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname_hostname: 'hgzp2mc4', cname_domain: 7 }, '', 'cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname_hostname: 'hgzp2mc4', cname_domain: 7 }, 'hgzp2mc4.cdndns.vip'), 'hgzp2mc4.cdndns.vip');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname_hostname: 'hgzp2mc4', cname_domain: 7 }), '');
  assert.equal(tenantProxyInternals.extractCompleteCname({ cname_domain: 'cdndns.vip' }), '');
});

test('旧网站分组迁移为客户站内分组并更新默认设置作用域', async t => {
  const db = createDatabase(); t.after(() => db.close());
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)').run('migration-user', hashPassword('migration-password'), 'user', 1).lastInsertRowid);
  const legacyId = await tenantProxyInternals.saveResource(db, 'site-groups', 'legacy-upstream-group', userId, { name: '生产站点', des: '旧分组', enable: 1 });
  db.prepare("INSERT INTO user_configs (user_id,name,value,type,scope_name,scope_id,enable) VALUES (?,?,?,?,?,?,?)").run(userId, 'gzip_enable', '1', 'site', 'group', legacyId, 1);
  await databaseInternals.migrateCustomerSiteGroups(db);
  const group = db.prepare('SELECT * FROM customer_site_groups WHERE user_id=? AND name=?').get(userId, '生产站点');
  assert.equal(group.description, '旧分组');
  assert.equal(db.prepare('SELECT scope_id FROM user_configs WHERE user_id=?').get(userId).scope_id, group.id);
  await databaseInternals.migrateCustomerSiteGroups(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_site_groups WHERE user_id=?').get(userId).count, 1);
});

test('CNAME 域名配置 ID 使用上游账户配置的后缀解析', async () => {
  assert.equal(tenantProxyInternals.cnameDomainId({ data: { cname_domain: 7 } }), '7');
  assert.equal(tenantProxyInternals.findCnameDomain({ cname_domains: [{ id: 7, domain: 'cdndns.vip' }] }, '7'), 'cdndns.vip');
  assert.equal(tenantProxyInternals.findCnameDomain({ items: [{ id: 7, domain: 'tenant.example.com' }] }, '7'), '');
  const calls = [];
  const client = { cnameSuffix: 'cdndns.vip', request: async (method, path) => {
    calls.push({ method, path });
    throw new Error('不应请求无关的公共系统信息接口');
  } };
  assert.equal(await tenantProxyInternals.resolveCnameDomain(client, '7'), 'cdndns.vip');
  assert.deepEqual(calls, []);
});

test('证书私钥不通过兼容接口回显', () => {
  const value = tenantProxyInternals.redactCertificate({ id: 7, issue_state: 'failed', retry_at2: '2026-08-21 21:24:54', task_ret: '/root/.acme.sh/internal.log', task_log: 'internal', cert: { body: 'PUBLIC-CERT', key: 'PRIVATE-KEY-2' }, key: 'PRIVATE-KEY', private_key: 'PRIVATE-KEY-2' });
  assert.equal(value.cert.body, 'PUBLIC-CERT');
  assert.equal(value.cert.key, undefined);
  assert.equal(value.key, undefined);
  assert.equal(value.private_key, undefined);
  assert.equal(value.task_ret, undefined);
  assert.equal(value.task_log, undefined);
  assert.equal(value.issue_state, 'failed');
  assert.equal(value.retry_at2, '2026-08-21 21:24:54');
  assert.equal(value.key_configured, true);
});

test('DNS API 凭据不通过兼容接口回显', () => {
  const value = tenantProxyInternals.redactDnsApi({ id: 8, name: 'dns', type: 'CloudFlare', auth: { CF_Email: 'a@example.com', CF_Key: 'secret' }, token: 'token' });
  assert.equal(value.auth, undefined);
  assert.equal(value.token, undefined);
  assert.equal(value.auth_configured, true);
  assert.deepEqual(value.auth_keys, ['CF_Email', 'CF_Key']);
});

test('本地资源快照保存配置状态但不保存证书私钥和 DNS 密钥', async () => {
  const db = createDatabase();
  try {
    const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('snapshot-user', hashPassword('snapshot-password'), 'user', 1).lastInsertRowid);
    const certId = await tenantProxyInternals.saveResource(db, 'certs', 'cert-upstream', userId, {
      name: '证书', type: 'custom', key: 'PRIVATE', cert: 'PUBLIC',
    });
    const certSnapshot = JSON.parse(db.prepare('SELECT snapshot FROM tenant_resources WHERE id=?').get(certId).snapshot);
    assert.equal(certSnapshot.type, 'custom'); assert.equal(certSnapshot.cert, 'PUBLIC');
    assert.equal(certSnapshot.key, undefined); assert.equal(certSnapshot.key_configured, true);
    const dnsId = await tenantProxyInternals.saveResource(db, 'dnsapis', 'dns-upstream', userId, {
      name: 'DNS', type: 'CloudFlare', auth: { CF_Email: 'owner@example.com', CF_Key: 'secret' },
    });
    const dnsSnapshot = JSON.parse(db.prepare('SELECT snapshot FROM tenant_resources WHERE id=?').get(dnsId).snapshot);
    assert.equal(dnsSnapshot.auth, undefined); assert.equal(dnsSnapshot.auth_configured, true);
    assert.deepEqual(dnsSnapshot.auth_keys, ['CF_Email', 'CF_Key']);
  } finally { db.close(); }
});

test('ACL 简略同步不会覆盖已保存的完整匹配规则', async () => {
  const db = createDatabase();
  try {
    const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('acl-snapshot-user', hashPassword('acl-snapshot-password'), 'user', 1).lastInsertRowid);
    const data = [{ acl_action: 'reject', acl_code: '403', acl_url: '', acl_matcher: [
      { item: 'ip', op: 'ip_range', value: '192.0.2.0/24' },
    ] }];
    const localId = await tenantProxyInternals.saveResource(db, 'acls', 'acl-upstream', userId, {
      name: '完整 ACL', default_action: 'allow', reject_code: '403', enable: 1, data,
    });
    await tenantProxyInternals.saveResource(db, 'acls', 'acl-upstream', userId, {
      id: 'acl-upstream', name: '完整 ACL', enable: 1,
    });
    const snapshot = JSON.parse(db.prepare('SELECT snapshot FROM tenant_resources WHERE id=?').get(localId).snapshot);
    assert.deepEqual(snapshot.data, data);
    assert.equal(snapshot.default_action, 'allow');
  } finally { db.close(); }
});

test('证书请求只保留官方字段并校验签发方式和 PEM', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----';
  const cert = '-----BEGIN CERTIFICATE-----\nZmFrZS1jZXJ0\n-----END CERTIFICATE-----';
  assert.deepEqual(tenantProxyInternals.sanitizeCertificateInput({
    name: '上传证书', des: '测试', type: 'custom', key, cert, uid: 99, unexpected: true,
  }), { name: '上传证书', des: '测试', type: 'custom', key, cert });
  assert.deepEqual(tenantProxyInternals.sanitizeCertificateInput({
    name: '自动证书', type: 'lets', domain: 'example.com *.example.com', dnsapi: 7, auto_renew: true,
  }), { name: '自动证书', type: 'lets', auto_renew: 1, domain: 'example.com *.example.com', dnsapi: 7 });
  assert.deepEqual(tenantProxyInternals.sanitizeCertificateInput({ enable: 0 }, {
    partial: true, existing: { type: 'custom' },
  }), { enable: 0 });
  assert.throws(() => tenantProxyInternals.sanitizeCertificateInput({
    name: '错误续签', type: 'lets', domain: 'example.com', auto_renew: 'maybe',
  }), /启用状态无效/);
  assert.throws(() => tenantProxyInternals.sanitizeCertificateInput({
    name: '通配符', type: 'lets', domain: '*.example.com',
  }), /必须选择 DNS API/);
  assert.throws(() => tenantProxyInternals.sanitizeCertificateInput({
    name: '错误证书', type: 'custom', key: `${key}x`, cert,
  }), /私钥 PEM 格式无效/);
  assert.doesNotThrow(() => tenantProxyInternals.sanitizeCertificateInput({ name: '改名' }, {
    partial: true, existing: { type: 'custom' },
  }));
  assert.throws(() => tenantProxyInternals.sanitizeCertificateInput({ name: '切换类型', type: 'custom' }, {
    partial: true, existing: { type: 'lets', domain: 'example.com' },
  }), /必须同时提供/);
});

test('DNS API 请求支持上游服务商并严格校验各自凭据键', () => {
  assert.deepEqual(tenantProxyInternals.sanitizeDnsApiInput({
    name: 'Cloudflare DNS', des: '测试', type: 'CloudFlare',
    auth: { CF_Key: 'secret', CF_Email: 'owner@example.com' }, token: 'ignored',
  }), {
    name: 'Cloudflare DNS', des: '测试', type: 'CloudFlare',
    auth: { CF_Key: 'secret', CF_Email: 'owner@example.com' },
  });
  const providers = new Map([
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
  for (const [type, keys] of providers) {
    const auth = Object.fromEntries(keys.map(key => [key, `${key}-value`]));
    assert.deepEqual(tenantProxyInternals.sanitizeDnsApiInput({ name: type, type, auth }), { name: type, type, auth });
  }
  assert.throws(() => tenantProxyInternals.sanitizeDnsApiInput({
    name: '错误凭据', type: 'CloudFlare', auth: { token: 'secret' },
  }), /凭据字段无效/);
  assert.throws(() => tenantProxyInternals.sanitizeDnsApiInput({
    name: '未知服务商', type: 'unknown', auth: { Key: 'a', Secret: 'b' },
  }), /不支持的 DNS 服务商/);
  assert.deepEqual(tenantProxyInternals.sanitizeDnsApiInput({ name: '仅改名' }, {
    partial: true, existing: { type: 'Aliyun' },
  }), { name: '仅改名' });
  assert.throws(() => tenantProxyInternals.sanitizeDnsApiInput({ name: '改服务商', type: 'CloudFlare' }, {
    partial: true, existing: { type: 'Aliyun' },
  }), /凭据必填/);
});

test('DNS API 集合更新翻译本地 ID 且未提交凭据时保留上游密钥', async () => {
  const db = createDatabase();
  try {
    const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
      .run('dns-collection-user', 'x', 'user').lastInsertRowid);
    const localId = await tenantProxyInternals.saveResource(db, 'dnsapis', '801', userId, {
      name: '旧名称', type: 'CloudFlare', auth_configured: true, auth_keys: ['CF_Email', 'CF_Key'],
    });
    const calls = [];
    const result = await handleTenantProxy({
      req: { method: 'PUT' },
      url: new URL('http://localhost/api/cdnfly/v1/dnsapis'),
      user: { id: userId, role: 'user' }, db, upstreams: null, billing: null,
      cdnfly: { groupNamespace: 'TEST-DNS', request: async (method, path, body) => { calls.push({ method, path, body }); return true; } },
      readBody: async () => [{ id: localId, name: '新名称' }],
    });
    assert.equal(result.status, 200);
    assert.deepEqual(calls, [{ method: 'PUT', path: '/v1/dnsapis', body: [{ id: 801, name: '新名称', des: '[AN:TEST-DNS:U000001]' }] }]);
    const snapshot = JSON.parse(db.prepare('SELECT snapshot FROM tenant_resources WHERE id=?').get(localId).snapshot);
    assert.equal(snapshot.name, '新名称');
    assert.equal(snapshot.type, 'CloudFlare');
    assert.equal(snapshot.auth, undefined);
    assert.equal(snapshot.auth_configured, true);
  } finally { db.close(); }
});

test('四层转发请求清洗字段并严格校验监听、源站和负载方式', () => {
  assert.deepEqual(tenantProxyInternals.sanitizeStreamInput({
    subscriptionId: 8, des: '测试转发', groups: 3,
    listen: [{ port: '52461', protocol: 'TCP', extra: true }], backend_port: '443',
    backend: [{ addr: '1.1.1.1', weight: '1', state: 'UP', secret: 'ignored' }],
    balance_way: 'rr', enable: true, unexpected: true,
  }), {
    des: '测试转发', groups: '3', listen: [{ port: 52461, protocol: 'tcp' }], backend_port: 443,
    backend: [{ addr: '1.1.1.1', weight: 1, state: 'up' }], balance_way: 'rr', enable: 1,
  });
  assert.throws(() => tenantProxyInternals.sanitizeStreamInput({
    listen: [{ port: 52461 }, { port: 52461 }], backend_port: 443,
    backend: [{ addr: '1.1.1.1' }], balance_way: 'rr',
  }), /不能重复/);
  assert.throws(() => tenantProxyInternals.sanitizeStreamInput({
    listen: [{ port: 52461 }], backend_port: 443,
    backend: [{ addr: '1.1.1.1' }], balance_way: 'random',
  }), /负载方式无效/);
  assert.equal(tenantProxyInternals.sanitizeStreamInput({ groups: 0 }, { partial: true }).groups, '');
  assert.throws(() => tenantProxyInternals.sanitizeStreamInput({
    listen: [{ port: 52461 }], backend_port: 443,
    backend: [{ addr: '1.1.1.1', weight: 11 }], balance_way: 'rr',
  }), /权重无效/);
});

test('四层转发详情更新只保存站内分组且不会把本地 ID 提交上游', async () => {
  const db = createDatabase();
  try {
    const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
      .run('stream-update-user', 'x', 'user').lastInsertRowid);
    const groupId = Number(db.prepare('INSERT INTO customer_stream_groups (user_id,name) VALUES (?,?)')
      .run(userId, '业务组').lastInsertRowid);
    const streamId = await tenantProxyInternals.saveResource(db, 'streams', '3350', userId, {
      groups: '', listen: [{ port: 8265, protocol: 'tcp' }],
      backend: [{ addr: '1.1.1.1', weight: 1, state: 'up' }], backend_port: 443,
    });
    const calls = [];
    const cdnfly = { groupNamespace: 'TEST-STREAM', request: async (method, path, body) => { calls.push({ method, path, body }); return true; } };
    const update = body => handleTenantProxy({
      req: { method: 'PUT' }, url: new URL(`http://localhost/api/cdnfly/v1/streams/${streamId}`),
      user: { id: userId, role: 'user' }, db, cdnfly, billing: null, readBody: async () => body,
    });

    assert.equal((await update({
      groups: groupId, listen: [{ port: 28265, protocol: 'tcp' }],
      backend: [{ addr: '8.8.8.8', weight: 1, state: 'up' }], backend_port: 443,
      balance_way: 'rr', enable: 0,
    })).status, 200);
    assert.deepEqual(calls.at(-1), {
      method: 'PUT', path: '/v1/streams/3350', body: {
        des: '[AN:TEST-STREAM:U000001]',
        listen: [{ port: 28265, protocol: 'tcp' }],
        backend: [{ addr: '8.8.8.8', weight: 1, state: 'up' }], backend_port: 443,
        balance_way: 'rr', enable: 0,
      },
    });
    assert.equal(db.prepare('SELECT local_group_id FROM tenant_resources WHERE id=?').get(streamId).local_group_id, groupId);

    assert.equal((await update({ groups: 0 })).status, 200);
    assert.deepEqual(calls.at(-1), { method: 'PUT', path: '/v1/streams/3350', body: { des: '[AN:TEST-STREAM:U000001]' } });
    assert.equal(db.prepare('SELECT local_group_id FROM tenant_resources WHERE id=?').get(streamId).local_group_id, null);
  } finally { db.close(); }
});

test('四层详情被上游误判为管理员接口时从当前账号列表精确回退', async () => {
  const calls = [];
  const client = {
    async request(method, path) {
      calls.push([method, path]);
      if (path === '/v1/streams/3348') throw Object.assign(new Error('需要管理员权限'), { upstreamCode: 'stream-102' });
      return { count: 2, data: [
        { id: 3347, listen: [{ protocol: 'tcp', port: '52461' }] },
        { id: 3348, listen: [{ protocol: 'tcp', port: '18443' }], backend: [{ addr: '192.0.2.10' }], backend_port: '18443' },
      ] };
    },
  };
  const detail = await tenantProxyInternals.resourceDetail(client, 'streams', '3348');
  assert.equal(detail.id, 3348);
  assert.deepEqual(detail.listen, [{ protocol: 'tcp', port: '18443' }]);
  assert.deepEqual(calls, [['GET', '/v1/streams/3348'], ['GET', '/v1/streams?limit=0']]);
});

test('四层详情和列表均暂时不可用时返回最近一次本地快照', async () => {
  const calls = [];
  const client = { request: async (method, path) => { calls.push([method, path]); throw new Error('upstream unavailable'); } };
  const detail = await tenantProxyInternals.resourceDetail(client, 'streams', '3348', {
    snapshot: JSON.stringify({ id: 3348, listen: [{ protocol: 'tcp', port: 18443 }], backend: [{ addr: '192.0.2.10' }], backend_port: 18443 }),
  });
  assert.equal(detail.id, 3348);
  assert.match(detail.sync_warning, /最近一次成功同步/);
  assert.deepEqual(calls, [['GET', '/v1/streams/3348'], ['GET', '/v1/streams?limit=0'], ['GET', '/v1/streams']]);
});

test('四层旧映射没有本地快照时返回明确的不可见状态', async () => {
  const client = { request: async () => { throw Object.assign(new Error('需要管理员权限'), { upstreamCode: 'stream-102' }); } };
  const detail = await tenantProxyInternals.resourceDetail(client, 'streams', '3347', { id: 5, snapshot: null });
  assert.equal(detail.id, 3347);
  assert.equal(detail.enable, 0);
  assert.equal(detail.sync_unavailable, true);
  assert.match(detail.sync_warning, /CDN 服务暂未返回/);
});

test('兼容层创建接口校验网站和四层资源输入', () => {
  assert.doesNotThrow(() => tenantProxyInternals.validateCompatSiteInput({ domain: 'tenant.example.com', backend: [{ addr: '1.1.1.1' }] }));
  assert.throws(() => tenantProxyInternals.validateCompatSiteInput({ domain: 'not a domain', backend: [{ addr: '1.1.1.1' }] }), /有效域名/);
  assert.doesNotThrow(() => tenantProxyInternals.validateCompatStreamInput({ listen: [{ port: 52461, protocol: 'tcp' }], backend: [{ addr: '1.1.1.1' }], backend_port: 443 }));
  assert.throws(() => tenantProxyInternals.validateCompatStreamInput({ listen: [{ port: 15658, protocol: 'sctp' }], backend: [{ addr: '1.1.1.1' }], backend_port: 443 }), /协议无效/);
});

test('ACL 输入严格转换为官方 data/acl_matcher 结构和字符串拒绝码', () => {
  assert.deepEqual(tenantProxyInternals.sanitizeAclInput({
    name: '办公网访问', des: '仅允许可信来源', default_action: 'reject', reject_code: '302',
    redirect_url: 'https://www.example.com/denied', enable: '1', uid: 999,
    data: [{ acl_action: 'allow', acl_matcher: [{ item: 'header', op: 'exists', value: '', unknown: true }], unknown: true }],
  }), {
    name: '办公网访问', des: '仅允许可信来源', default_action: 'reject', reject_code: '302',
    redirect_url: 'https://www.example.com/denied', enable: 1,
    data: [{ acl_action: 'allow', acl_matcher: [{ item: 'header', op: 'exists', value: '' }] }],
  });
  assert.deepEqual(tenantProxyInternals.sanitizeAclInput({ enable: 0 }, {
    partial: true, existing: { default_action: 'allow', reject_code: '403' },
  }), { enable: 0 });
  assert.deepEqual(tenantProxyInternals.sanitizeAclInput({
    name: '兼容旧页面', default_action: 'allow', reject_code: 0,
    matcher: [{ match_item: 'ip', operator: 'ip_range', value: ['192.0.2.0/24'], action: 'reject' }],
  }), {
    name: '兼容旧页面', des: '', default_action: 'allow', reject_code: '403', redirect_url: '', enable: 1,
    data: [{ acl_action: 'reject', acl_code: '403', acl_url: '', acl_matcher: [{ item: 'ip', op: 'ip_range', value: '192.0.2.0/24' }] }],
  });
  assert.throws(() => tenantProxyInternals.sanitizeAclInput({
    name: '跳转', default_action: 'reject', reject_code: '302', data: [
      { acl_action: 'allow', acl_matcher: [{ item: 'ip', op: 'ip_range', value: '192.0.2.0/24' }] },
    ],
  }), /跳转 URL/);
  assert.throws(() => tenantProxyInternals.sanitizeAclInput({
    name: '错误匹配项', default_action: 'allow', reject_code: '403',
    data: [{ acl_action: 'reject', acl_matcher: [{ item: 'cookie', op: '=', value: 'a' }] }],
  }), /匹配项无效/);
  assert.throws(() => tenantProxyInternals.sanitizeAclInput({
    name: '空规则', default_action: 'allow', reject_code: '403', data: [],
  }), /至少需要一条规则/);
});

test('网站 HTTPS 写入规范化空证书和 TLS 协议', () => {
  const recommendedCiphers = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';
  assert.deepEqual(tenantProxyInternals.normalizeSiteWriteInput({
    proxy_ssl_protocols: ['TLSv1.2', 'TLSv1.3', 'TLSv1.2'],
    https_listen: { ok: 0, cert: 0, ssl_protocols: ['TLSv1.3', 'TLSv1.2', 'TLSv1.3'], ssl_prefer_server_ciphers: 1 },
  }), { proxy_ssl_protocols: 'TLSv1.2 TLSv1.3' });
  assert.deepEqual(tenantProxyInternals.normalizeSiteWriteInput({
    https_listen: { ok: 0, cert: 9, ssl_protocols: ['TLSv1.3', 'TLSv1.2'], ssl_prefer_server_ciphers: 1 },
  }), { https_listen: { ok: 0, cert: 9, ssl_protocols: 'TLSv1.3 TLSv1.2', ssl_prefer_server_ciphers: 'on' } });
  assert.deepEqual(tenantProxyInternals.normalizeSiteWriteInput({
    https_listen: { ok: 1, cert: 9, ssl_protocols: '', ssl_ciphers: '   ', ssl_prefer_server_ciphers: 0 },
  }), { https_listen: { ok: 1, cert: 9, ssl_protocols: 'TLSv1.2 TLSv1.3', ssl_ciphers: recommendedCiphers, ssl_prefer_server_ciphers: 'off' } });
  assert.throws(() => tenantProxyInternals.normalizeSiteWriteInput({ https_listen: { ok: 1, cert: '' } }), /启用 HTTPS 时证书不能为空/);
  assert.equal(tenantProxyInternals.normalizeTlsProtocols(''), 'TLSv1.2 TLSv1.3');
  assert.throws(() => tenantProxyInternals.normalizeTlsProtocols('SSLv3 TLSv1.2'), /TLS 协议无效/);
  assert.equal(tenantProxyInternals.normalizeTlsProtocols('TLSv1 TLSv1.1 TLSv1.2'), 'TLSv1 TLSv1.1 TLSv1.2');
  assert.deepEqual(tenantProxyInternals.normalizeSiteWriteInput({ page_404: 'not found', page_50x: 'legacy' }), { page_404: 'not found' });
});

test('CNAME 检查沿别名链匹配期望目标', async () => {
  const records = new Map([
    ['www.example.com', ['edge.example.net.']],
    ['edge.example.net', ['target.cdn.example.']],
  ]);
  const result = await tenantProxyInternals.checkCnameResolution('www.example.com', 'target.cdn.example', async domain => records.get(domain) || []);
  assert.deepEqual(result, {
    domain: 'www.example.com', expected: 'target.cdn.example',
    resolved: ['edge.example.net', 'target.cdn.example'], ok: true,
  });
});

test('网站列表同步上游完整 CNAME 并更新本地快照', async () => {
  const db = createDatabase();
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('cname-list', hashPassword('cname-password'), 'user', 5).lastInsertRowid);
  const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,upstream_id,domain,origin,state,cname)
    VALUES (?, 'upstream-site', 'tenant.example.com', '1.1.1.1', 'active', 'cdndns.vip')`).run(userId).lastInsertRowid);
  const sites = db.prepare('SELECT * FROM sites WHERE id=?').all(siteId);
  const client = { request: async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/v1/sites?page=1&page_size=1000');
    return { items: [{ id: 'upstream-site', cname_hostname: 'hgzp2mc4', cname_domain: 'cdndns.vip',
      enable: 0, sync_state: 'syncing', http_listen: { enable: 1, port: '80 8080' }, https_listen: { ok: 1, port: '443', cert: 7 } }] };
  } };
  await syncSiteCnames(db, sites, null, client);
  assert.equal(sites[0].cname, 'hgzp2mc4.cdndns.vip');
  assert.equal(sites[0].upstream_enabled, 0);
  assert.equal(sites[0].upstream_state, 'syncing');
  assert.equal(sites[0].https_enabled, true);
  assert.equal(sites[0].listen_ports, 'HTTP:80 8080 · HTTPS:443');
  assert.equal(db.prepare('SELECT cname FROM sites WHERE id=?').get(siteId).cname, 'hgzp2mc4.cdndns.vip');
  db.close();
});

test('网站列表把上游 cname 主机名与 cname_domain 后缀组合并替换旧快照', async () => {
  const db = createDatabase();
  const userId = Number(db.prepare("INSERT INTO users (username,password_hash,role) VALUES ('cname-pair-user','x','user')").run().lastInsertRowid);
  const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,upstream_id,domain,origin,state,cname)
    VALUES (?, 'upstream-cname-pair', 'tenant.example.com', '1.1.1.1', 'active', 'cdndns.vip')`).run(userId).lastInsertRowid);
  const sites = db.prepare('SELECT * FROM sites WHERE id=?').all(siteId);
  const client = { request: async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/v1/sites?page=1&page_size=1000');
    return { items: [{ id: 'upstream-cname-pair', cname: 'hgzp2mc4', cname_domain: 'cdndns.vip' }] };
  } };
  await syncSiteCnames(db, sites, null, client);
  assert.equal(sites[0].cname, 'hgzp2mc4.cdndns.vip');
  assert.equal(db.prepare('SELECT cname FROM sites WHERE id=?').get(siteId).cname, 'hgzp2mc4.cdndns.vip');
  db.close();
});

test('网站列表通过 CNAME 域名配置 ID 同步完整目标', async () => {
  const db = createDatabase();
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('cname-domain-id', hashPassword('cname-password'), 'user', 5).lastInsertRowid);
  const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,upstream_id,domain,origin,state,cname)
    VALUES (?, 'upstream-domain-id', 'tenant.example.com', '1.1.1.1', 'active', NULL)`).run(userId).lastInsertRowid);
  const sites = db.prepare('SELECT * FROM sites WHERE id=?').all(siteId);
  const calls = [];
  const client = { cnameSuffix: 'cdndns.vip', request: async (method, path) => {
    calls.push(path);
    if (path.startsWith('/v1/sites?')) return { items: [{ id: 'upstream-domain-id', cname_hostname: 'hgzp2mc4', cname_domain: 7 }] };
    throw new Error(`unexpected ${method} ${path}`);
  } };
  await syncSiteCnames(db, sites, null, client);
  assert.equal(sites[0].cname, 'hgzp2mc4.cdndns.vip');
  assert.equal(db.prepare('SELECT cname FROM sites WHERE id=?').get(siteId).cname, 'hgzp2mc4.cdndns.vip');
  assert.deepEqual(calls, ['/v1/sites?page=1&page_size=1000']);
  db.close();
});

test('网站列表和详情只有 CNAME 后缀时保留已同步的完整目标', async () => {
  const db = createDatabase();
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('cname-fallback', hashPassword('cname-password'), 'user', 5).lastInsertRowid);
  const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,upstream_id,domain,origin,state,cname)
    VALUES (?, 'upstream-partial', 'tenant.example.com', '1.1.1.1', 'active', 'hgzp2mc4.cdndns.vip')`).run(userId).lastInsertRowid);
  const sites = db.prepare('SELECT * FROM sites WHERE id=?').all(siteId);
  const client = { request: async (_method, path) => path.includes('?')
    ? { items: [{ id: 'upstream-partial', cname_domain: 'cdndns.vip' }] }
    : { cname_domain: 'cdndns.vip' } };
  await syncSiteCnames(db, sites, null, client);
  assert.equal(sites[0].cname, 'hgzp2mc4.cdndns.vip');
  assert.equal(db.prepare('SELECT cname FROM sites WHERE id=?').get(siteId).cname, 'hgzp2mc4.cdndns.vip');
  db.close();
});

test('网站列表只有 CNAME 域名配置时继续查询详情并修复旧快照', async () => {
  const db = createDatabase();
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
    .run('cname-detail-refresh', hashPassword('cname-password'), 'user', 5).lastInsertRowid);
  const siteId = Number(db.prepare(`INSERT INTO sites (owner_id,upstream_id,domain,origin,state,cname)
    VALUES (?, 'upstream-detail-refresh', 'tenant.example.com', '1.1.1.1', 'active', 'cdndns.vip')`).run(userId).lastInsertRowid);
  const calls = [];
  const client = { cnameSuffix: 'cdndns.vip', request: async (method, path) => {
    calls.push(path);
    if (path.startsWith('/v1/sites?')) return { items: [{ id: 'upstream-detail-refresh', cname_domain: 7 }] };
    if (path === '/v1/sites/upstream-detail-refresh') return { cname_hostname: 'hgzp2mc4', cname_domain: 7 };
    throw new Error(`unexpected ${method} ${path}`);
  } };
  const sites = db.prepare('SELECT * FROM sites WHERE owner_id=?').all(userId);
  await syncSiteCnames(db, sites, null, client);
  assert.equal(sites[0].cname, 'hgzp2mc4.cdndns.vip');
  assert.equal(db.prepare('SELECT cname FROM sites WHERE id=?').get(siteId).cname, 'hgzp2mc4.cdndns.vip');
  assert.deepEqual(calls, ['/v1/sites?page=1&page_size=1000', '/v1/sites/upstream-detail-refresh']);
});

function request(base, path, cookie, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('网站分组列表完全来自当前租户本地数据且不请求上游', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const before = f.cdnfly.calls.length;
  const response = await request(base, '/api/cdnfly/v1/site-groups?uid=999&internal=1&page=1', cookie);
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, f.ids.groupAlice);
  assert.equal(data.items[0].uid, undefined);
  assert.equal(f.cdnfly.calls.length, before);
});

test('创建网站分组拒绝归属字段并且合法创建只写入本地', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  assert.equal((await request(base, '/api/cdnfly/v1/site-groups', cookie, 'POST', { name: 'Invalid', uid: f.ids.bob })).status, 400);
  const before = f.cdnfly.calls.length;
  const response = await request(base, '/api/cdnfly/v1/site-groups', cookie, 'POST', { name: 'New', des: '站内分组' });
  assert.equal(response.status, 201);
  const localId = Number((await response.json()).data);
  assert.equal(f.cdnfly.calls.length, before);
  assert.deepEqual(f.db.prepare('SELECT user_id,name,description FROM customer_site_groups WHERE id = ?').get(localId), { user_id: f.ids.alice, name: 'New', description: '站内分组' });
});

test('ACL CRUD 使用租户本地 ID、字段白名单并隔离其他租户', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const created = await request(base, '/api/cdnfly/v1/acls', cookie, 'POST', {
    name: '可信来源', des: '办公室', default_action: 'reject', reject_code: 403, redirect_url: 'https://ignored.example',
    enable: true, subscriptionId: 99, uid: f.ids.bob,
    matcher: [{ match_item: 'ip', header_name: 'Ignored', operator: 'ip_range', value: ['192.0.2.0/24'], action: 'allow' }],
  });
  assert.equal(created.status, 201);
  const localId = Number((await created.json()).data);
  assert.deepEqual(f.cdnfly.calls.at(-1), { method: 'POST', path: '/v1/acls', body: {
    name: '可信来源', des: '[AN:TEST-TENANT:U000002] 办公室', default_action: 'reject', reject_code: '403', redirect_url: '', enable: 1,
    data: [{ acl_action: 'allow', acl_matcher: [{ item: 'ip', op: 'ip_range', value: '192.0.2.0/24' }] }],
  } });
  assert.equal(f.db.prepare('SELECT owner_id,kind FROM tenant_resources WHERE id=?').get(localId).owner_id, f.ids.alice);

  const bobAcl = await tenantProxyInternals.saveResource(f.db, 'acls', '702', f.ids.bob, { name: 'Bob ACL', default_action: 'allow', reject_code: '403', enable: 1, data: [] });
  f.cdnfly.request = async (method, path, body) => {
    f.cdnfly.calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/v1/acls?')) return { items: [
      { id: 701, name: '可信来源', default_action: 'reject', reject_code: '403', enable: 1, data: [] },
      { id: 702, name: 'Bob ACL', default_action: 'allow', reject_code: '403', enable: 1, data: [] },
    ] };
    return true;
  };
  const listed = await request(base, '/api/cdnfly/v1/acls?page=1', cookie);
  assert.deepEqual((await listed.json()).data.items.map(item => item.id), [localId]);
  const updated = await request(base, `/api/cdnfly/v1/acls/${localId}`, cookie, 'PUT', { enable: 0, owner_id: f.ids.bob });
  assert.equal(updated.status, 200);
  assert.deepEqual(f.cdnfly.calls.at(-1), { method: 'PUT', path: '/v1/acls/701', body: { enable: 0, des: '[AN:TEST-TENANT:U000002] 办公室' } });
  const before = f.cdnfly.calls.length;
  assert.equal((await request(base, `/api/cdnfly/v1/acls/${bobAcl}`, cookie)).status, 404);
  assert.equal(f.cdnfly.calls.length, before);
});

test('ACL 创建兼容旧前端字段并提交官方字符串枚举', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/acls', cookie, 'POST', {
    name: '默认允许', default_action: 'allow', reject_code: 0, enable: 1, subscriptionId: 99,
    matcher: [{ match_item: 'ip', operator: 'ip_range', value: ['192.0.2.0/24'], action: 'allow' }],
  });
  assert.equal(response.status, 201);
  assert.deepEqual(f.cdnfly.calls.at(-1), { method: 'POST', path: '/v1/acls', body: {
    name: '默认允许', des: '[AN:TEST-TENANT:U000002]', default_action: 'allow', reject_code: '403', redirect_url: '', enable: 1,
    data: [{ acl_action: 'allow', acl_matcher: [{ item: 'ip', op: 'ip_range', value: '192.0.2.0/24' }] }],
  } });
});

test('ACL 详情暂未返回规则时使用最近一次完整快照回填', async () => {
  const db = createDatabase();
  try {
    const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('acl-detail-user', hashPassword('acl-detail-password'), 'user', 1).lastInsertRowid);
    const data = [{ acl_action: 'allow', acl_matcher: [
      { item: 'ip', op: 'ip_range', value: '198.51.100.0/24' },
      { item: 'req_method', op: '=', value: 'GET' },
    ] }];
    const localId = await tenantProxyInternals.saveResource(db, 'acls', '703', userId, {
      name: '保留规则', des: '完整快照', default_action: 'reject', reject_code: '403', enable: 1, data,
    });
    const calls = [];
    const result = await handleTenantProxy({
      req: { method: 'GET' },
      url: new URL(`http://localhost/api/cdnfly/v1/acls/${localId}`),
      user: { id: userId, role: 'user' }, db, upstreams: null, billing: null,
      cdnfly: { request: async (method, path) => { calls.push({ method, path }); return { id: 703, name: '保留规则', enable: 1 }; } },
      readBody: async () => null,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.data, data);
    assert.equal(result.data.default_action, 'reject');
    assert.deepEqual(calls, [{ method: 'GET', path: '/v1/acls/703' }]);
  } finally { db.close(); }
});

test('其他租户无法按本地资源 ID读取资源且不请求上游', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'bob', 'bobby-password');
  const before = f.cdnfly.calls.length;
  const response = await request(base, `/api/cdnfly/v1/site-groups/${f.ids.groupAlice}`, cookie);
  assert.equal(response.status, 404);
  assert.equal(f.cdnfly.calls.length, before);
});

test('系统配置详情只允许当前租户网站和公开充值配置', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const list = await request(base, '/api/cdnfly/v1/configs', cookie);
  assert.equal(list.status, 200); assert.deepEqual((await list.json()).data, []);

  const siteConfig = await request(base, '/api/cdnfly/v1/configs/site-1-system-cache-key', cookie);
  assert.equal(siteConfig.status, 200);
  assert.equal(f.cdnfly.calls.at(-1).path, '/v1/configs/site-site-a-system-cache-key');

  const before = f.cdnfly.calls.length;
  assert.equal((await request(base, '/api/cdnfly/v1/configs/site-2-system-cache-key', cookie)).status, 404);
  assert.equal(f.cdnfly.calls.length, before);

  const recharge = await request(base, '/api/cdnfly/v1/configs/global-0-system-recharge', cookie);
  assert.equal(recharge.status, 200);
  assert.equal(f.cdnfly.calls.at(-1).path, '/v1/configs/global-0-system-recharge');
});

test('网站完整配置不能引用其他租户的关联资源', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const before = f.cdnfly.calls.length;
  const response = await request(base, '/api/cdnfly/v1/sites', cookie, 'POST', {
    domain: 'blocked.example.com', backend: [{ addr: '192.0.2.8' }], groups: String(f.ids.groupBob),
  });
  assert.equal(response.status, 404);
  assert.equal(f.cdnfly.calls.length, before);
});

test('CC 规则中的匹配器和过滤器引用均执行租户 ID 翻译', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const matcher = await tenantProxyInternals.saveResource(f.db, 'cc-matchs', '201', f.ids.alice);
  const filter = await tenantProxyInternals.saveResource(f.db, 'cc-filters', '202', f.ids.alice);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/cc-rules', cookie, 'POST', { name: 'Rule', data: [{ matcher, filter1: filter, filter2: null }] });
  assert.equal(response.status, 201);
  assert.deepEqual(f.cdnfly.calls.at(-1).body.data[0], { matcher: 201, filter1: 202, filter2: null });
});

test('WAF 全局规则可读可编排，其他租户规则不可见', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  await tenantProxyInternals.saveResource(f.db, 'waf-rules', '302', f.ids.alice);
  await tenantProxyInternals.saveResource(f.db, 'waf-rules', '303', f.ids.bob);
  const cookie = await login(base, 'alice', 'alice-password');
  const capabilities = await request(base, '/api/cdnfly/v1/capabilities', cookie);
  assert.deepEqual((await capabilities.json()).data, { wafRules: true, attackLogs: true });
  const list = await request(base, '/api/cdnfly/v1/waf-rules', cookie);
  const items = (await list.json()).data.items;
  assert.deepEqual(items.map(item => item.name).sort(), ['Alice custom', 'Global SQLi']);
  const global = items.find(item => item.name === 'Global SQLi');
  const save = await request(base, '/api/cdnfly/v1/sites/1/waf-rules', cookie, 'PUT', [{ rule_id: global.id, sort: 1, enable: 1 }]);
  assert.equal(save.status, 200);
  assert.deepEqual(f.cdnfly.calls.at(-1), { method: 'PUT', path: '/v1/sites/site-a/waf-rules', body: [{ rule_id: 301, sort: 1, enable: 1 }] });
});

test('上游不提供 WAF 时能力接口关闭入口且资源接口明确返回 501', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  f.cdnfly.request = async (_method, path) => {
    if (path === '/v1/waf-rules') throw Object.assign(new Error('CDNFly HTTP 404'), { status: 502, upstreamStatus: 404 });
    if (path.startsWith('/v1/monitor/site/attack-log?')) throw Object.assign(new Error('CDNFly HTTP 404'), { status: 502, upstreamStatus: 404 });
    return [];
  };
  const cookie = await login(base, 'alice', 'alice-password');
  const capabilities = await request(base, '/api/cdnfly/v1/capabilities', cookie);
  assert.equal(capabilities.status, 200);
  assert.deepEqual((await capabilities.json()).data, { wafRules: false, attackLogs: false });
  const list = await request(base, '/api/cdnfly/v1/waf-rules', cookie);
  assert.equal(list.status, 501);
  assert.match((await list.json()).error, /未提供 WAF/);
});

test('完整网站接口固定普通用户套餐并翻译关联资源', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const aclId = await tenantProxyInternals.saveResource(f.db, 'acls', '701', f.ids.alice, { name: 'Alice ACL', enable: 1 });
  const ccRuleId = await tenantProxyInternals.saveResource(f.db, 'cc-rules', '401', f.ids.alice, { name: 'Alice CC', enable: 1 });
  const response = await request(base, '/api/cdnfly/v1/sites', cookie, 'POST', {
    domain: 'new.example.com', backend: [{ addr: '192.0.2.9' }], groups: String(f.ids.groupAlice), uid: 999, new_uid: 999, user_package: 999,
  });
  assert.equal(response.status, 201);
  const createdSiteId = Number((await response.json()).data);
  const body = f.cdnfly.calls.findLast(call => call.method === 'POST' && call.path === '/v1/sites').body;
  assert.equal(body.user_package, 88);
  assert.equal(body.groups, undefined);
  assert.equal(body.uid, undefined);
  assert.equal(body.new_uid, undefined);
  assert.equal(f.db.prepare('SELECT local_group_id FROM sites WHERE id=?').get(createdSiteId).local_group_id, f.ids.groupAlice);

  const updated = await request(base, '/api/cdnfly/v1/sites/1', cookie, 'PUT', {
    proxy_ssl_protocols: ['TLSv1.2', 'TLSv1.3'], https_listen: { ok: 0, cert: 0, ssl_protocols: ['TLSv1.2', 'TLSv1.3', 'TLSv1.2'] },
    acl: aclId, cc_default_rule: ccRuleId, cc_switch: { rule: ccRuleId, switch: 120, enable: 1 },
  });
  assert.equal(updated.status, 200);
  const updateBody = f.cdnfly.calls.findLast(call => call.method === 'PUT' && call.path === '/v1/sites/site-a').body;
  assert.equal(updateBody.https_listen, undefined);
  assert.equal(updateBody.proxy_ssl_protocols, 'TLSv1.2 TLSv1.3');
  assert.equal(updateBody.acl, 701);
  assert.equal(updateBody.cc_default_rule, 401);
  assert.deepEqual(updateBody.cc_switch, { rule: 401, switch: 120, enable: 1 });

  const emptyCc = await request(base, '/api/cdnfly/v1/sites/1', cookie, 'PUT', {
    cc_default_rule: 0, cc_switch: { rule: 0, switch: 0, enable: 0 }, gzip_enable: 1,
  });
  assert.equal(emptyCc.status, 200);
  const emptyCcBody = f.cdnfly.calls.findLast(call => call.method === 'PUT' && call.path === '/v1/sites/site-a').body;
  assert.equal(Object.hasOwn(emptyCcBody, 'cc_default_rule'), false);
  assert.equal(Object.hasOwn(emptyCcBody, 'cc_switch'), false);
  assert.equal(emptyCcBody.gzip_enable, 1);

  const certId = await tenantProxyInternals.saveResource(f.db, 'certs', '601', f.ids.alice, { name: 'Alice cert', enable: 1 });
  const disabled = await request(base, '/api/cdnfly/v1/sites/1', cookie, 'PUT', {
    https_listen: { ok: 0, cert: certId, port: '443', ssl_protocols: ['TLSv1.2', 'TLSv1.3'] },
  });
  assert.equal(disabled.status, 200);
  const disableBody = f.cdnfly.calls.findLast(call => call.method === 'PUT' && call.path === '/v1/sites/site-a').body;
  assert.deepEqual(disableBody.https_listen, { ok: 0, cert: 601, port: '443', ssl_protocols: 'TLSv1.2 TLSv1.3' });

  f.cdnfly.request = async (method, path, body) => {
    f.cdnfly.calls.push({ method, path, body });
    if (method === 'GET' && path === '/v1/sites/site-a') return {
      id: 'site-a', domain: 'a.example.com', acl: 701, cc_default_rule: 401,
      cc_switch: { rule: 401, switch: 120, enable: 1 },
    };
    return true;
  };
  const detail = await request(base, '/api/cdnfly/v1/sites/1', cookie);
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()).data;
  assert.equal(detailBody.acl, aclId);
  assert.equal(detailBody.cc_default_rule, ccRuleId);
  assert.equal(detailBody.cc_switch.rule, ccRuleId);
  assert.equal(detailBody.group_id, null);
});

test('网站缓存单位按 CDNFly 短值保存并兼容旧长值', () => {
  const normalized = tenantProxyInternals.normalizeSiteWriteInput({
    proxy_cache: [
      { type: 'suffix', content: 'jpg|png', expire: 3, unit: 'd' },
      { type: 'suffix', content: 'js|css', expire: 2, unit: 'hour' },
      { type: 'all', content: '', expire: 1, unit: '' },
    ],
  });

  assert.deepEqual(normalized.proxy_cache.map(rule => rule.unit), ['d', 'h', 'h']);
  assert.throws(() => tenantProxyInternals.normalizeSiteWriteInput({ proxy_cache: [{ unit: 'week' }] }), /缓存时间单位无效/);
});

test('网站更新不会把未选择的 CC 规则转换为上游规则 0', () => {
  const normalized = tenantProxyInternals.normalizeSiteWriteInput({
    cc_default_rule: 0,
    cc_switch: { rule: '0', switch: 0, enable: 0 },
    gzip_enable: 1,
  });
  assert.equal(Object.hasOwn(normalized, 'cc_default_rule'), false);
  assert.equal(Object.hasOwn(normalized, 'cc_switch'), false);
  assert.equal(normalized.gzip_enable, 1);
  assert.throws(() => tenantProxyInternals.normalizeSiteWriteInput({ cc_switch: { rule: 0, switch: 100, enable: 1 } }), /必须选择 CC 规则/);
});

test('网站源站状态兼容界面值并且至少保留一个在线源站', () => {
  const normalized = tenantProxyInternals.normalizeSiteWriteInput({
    backend: [
      { addr: '192.0.2.10', weight: 2, state: 'online' },
      { addr: '192.0.2.11', weight: 1, state: 'disabled' },
      { addr: '192.0.2.12', weight: 1, state: 'standby' },
    ],
  });
  assert.deepEqual(normalized.backend.map(item => item.state), ['up', 'down', 'backup']);
  assert.throws(() => tenantProxyInternals.normalizeSiteWriteInput({
    backend: [{ addr: '192.0.2.11', weight: 1, state: 'offline' }],
  }), /至少保留一个在线源站/);
});

test('四层转发删除不会自动停用并统一返回停用提示', async () => {
  const calls = [];
  const client = { request: async (method, path, body) => {
    calls.push([method, path, body]);
    throw new Error('请先禁用再删除');
  } };

  await assert.rejects(tenantProxyInternals.deleteStreamResource(client, '3347'), error => {
    assert.equal(error.status, 409);
    assert.equal(error.message, '请先停用四层转发，再执行删除操作');
    return true;
  });
  assert.deepEqual(calls, [['DELETE', '/v1/streams/3347', undefined]]);
});

test('证书和四层转发必须显式停用后才能删除', async () => {
  const db = createDatabase();
  try {
    const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role,site_limit) VALUES (?,?,?,?)')
      .run('stop-before-delete', hashPassword('stop-before-delete-password'), 'user', 1).lastInsertRowid);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const calls = [];
    let rejectCertificateDelete = false;
    const cdnfly = { groupNamespace: 'TEST-STOP', request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'PUT') return { ...body };
      if (method === 'DELETE' && path.includes('/certs/') && rejectCertificateDelete) throw new Error('请先禁用再删除');
      if (method === 'DELETE') return true;
      return {};
    } };
    const invoke = (kind, id, method, body = {}) => handleTenantProxy({
      req: { method }, url: new URL(`http://localhost/api/cdnfly/v1/${kind}/${id}`), user, db, cdnfly,
      billing: null, readBody: async () => body,
    });

    const certId = await tenantProxyInternals.saveResource(db, 'certs', 'cert-stop', userId, { name: '生产证书', type: 'custom', enable: 1 });
    await assert.rejects(invoke('certs', certId, 'DELETE'), error => error.status === 409 && /请先停用证书/.test(error.message));
    assert.equal(calls.some(call => call.method === 'DELETE' && call.path.includes('/certs/')), false);
    assert.equal((await invoke('certs', certId, 'PUT', { enable: 0 })).status, 200);
    assert.equal(calls.at(-1).method, 'PUT'); assert.equal(calls.at(-1).body.enable, 0);
    assert.equal(JSON.parse(db.prepare('SELECT snapshot FROM tenant_resources WHERE id=?').get(certId).snapshot).enable, 0);
    rejectCertificateDelete = true;
    await assert.rejects(invoke('certs', certId, 'DELETE'), error => error.status === 409 && error.message === '请先停用证书，再执行删除操作');
    rejectCertificateDelete = false;
    assert.equal((await invoke('certs', certId, 'DELETE')).status, 200);

    const streamId = await tenantProxyInternals.saveResource(db, 'streams', 'stream-stop', userId, { name: '生产转发', enable: 1 });
    await assert.rejects(invoke('streams', streamId, 'DELETE'), error => error.status === 409 && /请先停用四层转发/.test(error.message));
    assert.equal(calls.some(call => call.method === 'PUT' && call.path.includes('/streams/') && call.body?.enable === 0), false);
    assert.equal((await invoke('streams', streamId, 'PUT', { enable: 0 })).status, 200);
    assert.equal(db.prepare('SELECT enabled FROM tenant_resources WHERE id=?').get(streamId).enabled, 0);
    assert.equal((await invoke('streams', streamId, 'DELETE')).status, 200);
  } finally { db.close(); }
});

test('四层转发已从当前上游账号消失时删除陈旧本地映射', async () => {
  const calls = [];
  const client = { request: async (method, path) => {
    calls.push([method, path]);
    if (method === 'DELETE') throw new Error('需要管理员权限');
    return { items: [] };
  } };

  assert.deepEqual(await tenantProxyInternals.deleteStreamResource(client, '3347'), { ok: true, alreadyAbsent: true });
  assert.deepEqual(calls, [
    ['DELETE', '/v1/streams/3347'],
    ['GET', '/v1/streams?limit=0'],
  ]);
});

test('域名列表依据网站归属过滤并使用本地域名 ID', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/domains', cookie);
  const data = (await response.json()).data;
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].domain, 'a.example.com');
  assert.equal(data.rows[0].site_id, 1);
  assert.notEqual(data.rows[0].id, 501);
});

test('域名列表清理已删除网站遗留的本地域名映射', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  assert.equal((await request(base, '/api/cdnfly/v1/domains', cookie)).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tenant_resources WHERE owner_id=? AND kind='domains'").get(f.ids.alice).count, 1);

  f.db.prepare("DELETE FROM sites WHERE owner_id=? AND upstream_id='site-a'").run(f.ids.alice);
  const response = await request(base, '/api/cdnfly/v1/domains', cookie);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.rows.length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tenant_resources WHERE owner_id=? AND kind='domains'").get(f.ids.alice).count, 0);
});

test('CNAME 检查接受 domain 对象并限定当前网站', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'alice', 'alice-password');
  const response = await request(base, '/api/cdnfly/v1/cname-check', cookie, 'POST', { domain: 'a.example.com' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    domain: 'a.example.com', expected: 'alice.cdn.example', resolved: ['alice.cdn.example'], ok: true,
  });
  assert.equal(f.cdnfly.calls.some(call => call.path === '/v1/cname-check'), false);
  const denied = await request(base, '/api/cdnfly/v1/cname-check', cookie, 'POST', { domain: 'b.example.com' });
  assert.equal(denied.status, 403);
});

test('平台管理员不能进入客户兼容接口', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const cookie = await login(base, 'admin', 'admin-password');
  const response = await request(base, '/api/cdnfly/v1/site-groups', cookie);
  assert.equal(response.status, 403);
  assert.equal(f.cdnfly.calls.length, 0);
});

test('四层转发固定套餐并把站内分组保存在本地，同时登记监听端口', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); }); const base = await start(f);
  const group = Number(f.db.prepare('INSERT INTO customer_stream_groups (user_id,name) VALUES (?,?)')
    .run(f.ids.alice, '业务组').lastInsertRowid);
  const cookie = await login(base, 'alice', 'alice-password');
  f.cdnfly.request = async (method, path, body) => { f.cdnfly.calls.push({ method, path, body }); return 'stream-new'; };
  const response = await request(base, '/api/cdnfly/v1/streams', cookie, 'POST', {
    user_package: 999, uid: 999, groups: String(group), listen: [{ port: 8443, protocol: 'tcp' }], backend_port: 443, backend: [{ addr: '192.0.2.30' }],
  });
  assert.equal(response.status, 201);
  const localId = Number((await response.json()).data);
  const body = f.cdnfly.calls.at(-1).body;
  assert.equal(body.user_package, 88);
  assert.equal(body.groups, undefined);
  assert.equal(body.uid, undefined);
  assert.equal(f.db.prepare('SELECT local_group_id FROM tenant_resources WHERE id=?').get(localId).local_group_id, group);
  assert.deepEqual(f.db.prepare('SELECT port FROM stream_ports WHERE resource_id = ?').all(localId).map(row => row.port), [8443]);
});
