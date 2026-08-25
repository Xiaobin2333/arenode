import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { BillingService } from '../src/billing.js';
import { createApp } from '../src/app.js';
import { mfaInternals } from '../src/mfa.js';
import { DEFAULT_ALLOWED_EMAIL_DOMAINS, normalizeAllowedEmailDomains } from '../src/email-policy.js';

async function fixture(overrides = {}) {
  const db = createDatabase();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, ?, ?)');
  const admin = Number(add.run('admin', hashPassword('admin-password'), 'admin', 0).lastInsertRowid);
  const alice = Number(add.run('alice', hashPassword('alice-password'), 'user', 1).lastInsertRowid);
  const bob = Number(add.run('bob', hashPassword('bobby-password'), 'user', 1).lastInsertRowid);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, enabled, state) VALUES (?, 'site-a', 'a.example.com', '192.0.2.1', 1, 'active')`).run(alice);
  db.prepare(`INSERT INTO sites (owner_id, upstream_id, domain, origin, enabled, state) VALUES (?, 'site-b', 'b.example.com', '192.0.2.2', 1, 'active')`).run(bob);
  const calls = [];
  const cdnfly = {
    packageId: 88, groupNamespace: 'TEST-ACCOUNT', calls,
    createSite: async input => { calls.push(['create', input]); return { id: 'site-new' }; },
    getSite: async id => { calls.push(['get', id]); return { id }; },
    updateSite: async (id, body) => { calls.push(['update', id, body]); return true; },
    deleteSite: async id => { calls.push(['delete', id]); return true; },
    request: async (method, path, body) => { calls.push(['request', method, path, body]); return path.startsWith('/v1/monitor/usage') ? [] : true; },
    health: async () => true,
  };
  const billing = await new BillingService(db, cdnfly).initialize();
  const trial = db.prepare("SELECT id FROM plans WHERE code='trial'").get();
  await billing.assignPlan(alice, trial.id); await billing.assignPlan(bob, trial.id); await billing.ensureResourceAssignments();
  const sentCodes = []; const sentTexts = [];
  const mailer = {
    available: true,
    verify: async () => true,
    sendCode: async message => { sentCodes.push(message); return { devCode: message.code }; },
    sendText: async message => { sentTexts.push(message); return true; },
  };
  const turnstileCalls = [];
  const turnstileFetch = async (_url, options) => {
    const values = Object.fromEntries(options.body); turnstileCalls.push(values);
    return { json: async () => ({ success: values.response === 'valid-turnstile' }) };
  };
  const config = { appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 88, allowRegistration: true, emailVerificationEnabled: true, authCodeMinutes: 10, settingsEncryptionKey: 'test-settings-key', allowedEmailDomains: 'example.com\nexample.net', ...overrides };
  const server = http.createServer(createApp({ db, cdnfly, config, billing, mailer, turnstileFetch }));
  return { db, cdnfly, billing, server, sentCodes, sentTexts, turnstileCalls, ids: { admin, alice, bob } };
}

async function start(f) {
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${f.server.address().port}`;
}

async function login(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

function request(base, path, cookie, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('用户通过邮箱验证码自助注册且不自动获得套餐', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const publicConfig = await (await request(base, '/api/auth/config')).json();
  assert.equal(publicConfig.registrationEnabled, true); assert.equal(publicConfig.emailVerificationEnabled, true);
  const requested = await request(base, '/api/auth/register', null, 'POST', { username: 'new_user', email: 'new@example.com', password: 'new-user-password' });
  assert.equal(requested.status, 202); const code = (await requested.json()).devCode;
  assert.equal((await request(base, '/api/auth/register/verify', null, 'POST', { email: 'new@example.com', code })).status, 201);
  const user = f.db.prepare("SELECT * FROM users WHERE username='new_user'").get();
  assert.equal(await f.billing.activeSubscription(user.id), null);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(user.id).balance_cents, 0);
  assert.equal((await login(base, 'new@example.com', 'new-user-password')).response.status, 200);
});

test('CDNFly v6 公开兼容路径完成邮箱注册并使用 access-token 鉴权', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const sent = await request(base, '/api/cdnfly/v1/email-captcha', null, 'POST', {
    email: 'compat@example.com', check_exist: 0,
  });
  assert.equal(sent.status, 202); const code = (await sent.json()).data.devCode;
  const registered = await request(base, '/api/cdnfly/v1/user', null, 'POST', {
    username: 'compat_user', email: 'compat@example.com', password: 'compat-user-password', captcha: code, accept_agreement: 1,
  });
  assert.equal(registered.status, 201); assert.equal((await registered.json()).code, 0);
  const user = f.db.prepare("SELECT * FROM users WHERE username='compat_user'").get();
  assert.equal(await f.billing.activeSubscription(user.id), null);

  const loggedIn = await request(base, '/api/cdnfly/v1/login', null, 'POST', { account: 'compat@example.com', password: 'compat-user-password' });
  assert.equal(loggedIn.status, 200); const loginBody = await loggedIn.json();
  assert.equal(loginBody.data.username, 'compat_user'); assert.ok(loginBody.data.access_token);
  const profile = await fetch(`${base}/api/cdnfly/v1/user`, { headers: { 'access-token': loginBody.data.access_token } });
  assert.equal(profile.status, 200); assert.equal((await profile.json()).data.username, 'compat_user');
});

test('CDNFly v6 用户默认配置遵循官方字段、分页与批量语义', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const loggedIn = await request(base, '/api/cdnfly/v1/login', null, 'POST', { account: 'alice', password: 'alice-password' });
  assert.equal(loggedIn.status, 200); const token = (await loggedIn.json()).data.access_token;
  const compat = (path, options = {}) => fetch(`${base}/api/cdnfly/v1${path}`, {
    ...options,
    headers: { 'access-token': token, 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const created = await compat('/user-configs', { method: 'POST', body: {
    name: 'proxy_protocol', value: '0', type: 'stream', scope_name: 'global', enable: 1,
  } });
  assert.equal(created.status, 200); const id = (await created.json()).data; assert.equal(Number.isInteger(id), true);
  const second = await compat('/user-configs', { method: 'POST', body: {
    name: 'cert_default_type', value: 'zerossl', type: 'cert',
  } });
  const secondBody = await second.json(); const secondId = secondBody.data; assert.equal(second.status, 200);

  const listed = await compat('/user-configs?type=stream&limit=0'); const listBody = await listed.json();
  assert.equal(listed.status, 200); assert.equal(listBody.count, 1); assert.equal(listBody.data.length, 1);
  assert.deepEqual(Object.keys(listBody.data[0]).sort(), [
    'create_at', 'enable', 'id', 'name', 'scope_id', 'scope_name', 'site_group_name',
    'stream_group_name', 'type', 'uid', 'update_at', 'username', 'value',
  ].sort());
  assert.equal(listBody.data[0].name, 'proxy_protocol'); assert.equal(listBody.data[0].scope_id, 0);

  const ignoredPathId = await compat(`/user-configs/${secondId}?type=stream&limit=0`); const ignoredBody = await ignoredPathId.json();
  assert.equal(ignoredPathId.status, 200); assert.equal(ignoredBody.count, 1); assert.equal(ignoredBody.data[0].id, id);
  assert.equal((await compat('/user-configs', { method: 'PUT', body: { id, value: '1' } })).status, 400);
  const batchUpdated = await compat('/user-configs', { method: 'PUT', body: [{ id, value: '1', enable: 0 }] });
  assert.equal(batchUpdated.status, 200); assert.equal((await batchUpdated.json()).data, null);
  assert.equal((await compat(`/user-configs/${id}`, { method: 'PUT', body: { value: '0' } })).status, 200);
  assert.equal((await compat('/user-configs', { method: 'POST', body: {
    uid: f.ids.bob, name: 'gzip_enable', value: '1', type: 'site',
  } })).status, 403);

  const removed = await compat(`/user-configs/${id},${secondId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200); assert.equal((await removed.json()).data, null);
  const empty = await compat('/user-configs?limit=0'); const emptyBody = await empty.json();
  assert.equal(emptyBody.count, 0); assert.deepEqual(emptyBody.data, []);
});

test('CDNFly v6 邮箱验证码兼容路径严格区分注册和找回用途', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const missingPurpose = await request(base, '/api/cdnfly/v1/email-captcha', null, 'POST', { email: 'compat@example.com' });
  assert.equal(missingPurpose.status, 400); assert.equal(f.sentCodes.length, 0);

  const admin = await login(base, 'admin', 'admin-password');
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', { registrationEnabled: false })).status, 200);
  const registrationClosed = await request(base, '/api/cdnfly/v1/email-captcha', null, 'POST', {
    email: 'compat@example.com', check_exist: 0,
  });
  assert.equal(registrationClosed.status, 403); assert.equal(f.sentCodes.length, 0);

  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    registrationEnabled: true, emailVerificationEnabled: false,
  })).status, 200);
  const verificationDisabled = await request(base, '/api/cdnfly/v1/email-captcha', null, 'POST', {
    email: 'compat@example.com', check_exist: 0,
  });
  assert.equal(verificationDisabled.status, 409); assert.equal(f.sentCodes.length, 0);
});

test('CDNFly v6 公开兼容路径支持邮箱找回并明确拒绝短信流程', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  f.db.prepare('UPDATE users SET email=?, email_verified_at=CURRENT_TIMESTAMP WHERE id=?').run('alice@example.com', f.ids.alice);
  const oldSession = await login(base, 'alice', 'alice-password');
  const sent = await request(base, '/api/cdnfly/v1/email-captcha', null, 'POST', { account: 'alice' });
  assert.equal(sent.status, 202); const code = (await sent.json()).data.devCode;
  const reset = await request(base, '/api/cdnfly/v1/reset-pass', null, 'POST', {
    reset_by: 'email', email: 'alice@example.com', captcha: code, password: 'compat-reset-password',
  });
  assert.equal(reset.status, 200); assert.equal((await reset.json()).code, 0);
  assert.equal((await request(base, '/api/me', oldSession.cookie)).status, 401);
  assert.equal((await request(base, '/api/cdnfly/v1/login', null, 'POST', { account: 'alice', password: 'compat-reset-password' })).status, 200);
  assert.equal((await request(base, '/api/cdnfly/v1/phone-captcha', null, 'POST', { phone: '13800138000' })).status, 501);
  assert.equal((await request(base, '/api/cdnfly/v1/reset-pass', null, 'POST', {
    reset_by: 'phone', phone: '13800138000', phone_captcha: '1234', password: 'another-password',
  })).status, 501);
});

test('自助邮箱域默认使用九个允许域且拒绝空白名单和名单外注册', async t => {
  assert.deepEqual(DEFAULT_ALLOWED_EMAIL_DOMAINS, [
    'gmail.com', '163.com', '126.com', 'qq.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com', 'foxmail.com',
  ]);
  assert.throws(() => normalizeAllowedEmailDomains(''), /至少需要一个域名/);
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', { allowedEmailDomains: '' })).status, 400);
  const rejected = await request(base, '/api/auth/register', null, 'POST', { username: 'blocked_domain', email: 'user@invalid.test', password: 'blocked-domain-password' });
  assert.equal(rejected.status, 403); assert.equal(f.sentCodes.length, 0);
});

test('关闭自助注册后公开注册接口返回 403', async t => {
  const f = await fixture({ allowRegistration: false }); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  assert.equal((await request(base, '/api/auth/register', null, 'POST', { username: 'blocked', password: 'blocked-password' })).status, 403);
});

test('管理员关闭注册邮箱验证后直接创建无套餐零余额账号', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const saved = await request(base, '/api/admin/settings', admin.cookie, 'PUT', { emailVerificationEnabled: false });
  assert.equal(saved.status, 200);
  const publicConfig = await (await request(base, '/api/auth/config')).json();
  assert.equal(publicConfig.registrationEnabled, true); assert.equal(publicConfig.emailVerificationEnabled, false);
  const registered = await request(base, '/api/auth/register', null, 'POST', { username: 'direct_user', email: 'direct@example.com', password: 'direct-user-password' });
  assert.equal(registered.status, 201); assert.equal((await registered.json()).verificationRequired, false); assert.equal(f.sentCodes.length, 0);
  const user = f.db.prepare("SELECT * FROM users WHERE username='direct_user'").get();
  assert.equal(user.email_verified_at, null); assert.equal(await f.billing.activeSubscription(user.id), null);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(user.id).balance_cents, 0);
  assert.equal((await login(base, 'direct@example.com', 'direct-user-password')).response.status, 200);
});

test('修改密码验证当前密码并使全部旧会话失效', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const first = await login(base, 'alice', 'alice-password'); const second = await login(base, 'alice', 'alice-password');
  assert.equal((await request(base, '/api/account/password', first.cookie, 'PUT', { currentPassword: 'wrong-password', newPassword: 'changed-password' })).status, 403);
  assert.equal((await request(base, '/api/account/password', first.cookie, 'PUT', { currentPassword: 'alice-password', newPassword: 'changed-password' })).status, 200);
  assert.equal((await request(base, '/api/me', first.cookie)).status, 401);
  assert.equal((await request(base, '/api/me', second.cookie)).status, 401);
  assert.equal((await login(base, 'alice', 'alice-password')).response.status, 401);
  assert.equal((await login(base, 'alice', 'changed-password')).response.status, 200);
});

test('管理员客户接口不暴露管理员并可重置密码和禁用客户', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password');
  const customers = await (await request(base, '/api/admin/customers', admin.cookie)).json();
  assert.deepEqual(customers.customers.map(row => row.username).sort(), ['alice', 'bob']);
  assert.equal((await request(base, `/api/admin/customers/${f.ids.alice}/password`, admin.cookie, 'PUT', { password: 'admin-reset-password' })).status, 200);
  assert.equal((await request(base, '/api/me', alice.cookie)).status, 401);
  assert.equal((await login(base, 'alice', 'admin-reset-password')).response.status, 200);
  assert.equal((await request(base, `/api/admin/customers/${f.ids.alice}`, admin.cookie, 'DELETE')).status, 200);
  assert.equal((await login(base, 'alice', 'admin-reset-password')).response.status, 401);
});

test('管理员站点接口可跨客户管理但普通站点接口仍无旁路', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const sites = await (await request(base, '/api/admin/sites', admin.cookie)).json();
  assert.deepEqual(sites.sites.map(row => row.username).sort(), ['alice', 'bob']);
  assert.equal((await request(base, '/api/sites/1', admin.cookie)).status, 404);
  assert.equal((await request(base, '/api/admin/sites/1', admin.cookie, 'PUT', { enabled: false })).status, 200);
  assert.deepEqual(f.cdnfly.calls.at(-1), ['update', 'site-a', { enabled: false }]);
  assert.equal((await request(base, '/api/admin/sites/1', admin.cookie, 'DELETE')).status, 200);
  assert.deepEqual(f.cdnfly.calls.at(-1), ['delete', 'site-a']);
});

test('管理员代客户创建站点仍执行客户套餐额度并登记客户归属', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const blocked = await request(base, '/api/admin/sites', admin.cookie, 'POST', { userId: f.ids.bob, domain: 'new-bob.example.com', origin: '192.0.2.9' });
  assert.equal(blocked.status, 409); assert.equal(f.cdnfly.calls.length, 0);
  const standard = f.db.prepare("SELECT id FROM plans WHERE code='standard'").get(); const subscriptionId = await f.billing.assignPlan(f.ids.bob, standard.id);
  const created = await request(base, '/api/admin/sites', admin.cookie, 'POST', { userId: f.ids.bob, subscriptionId, domain: 'new-bob.example.com', origin: '192.0.2.9' });
  assert.equal(created.status, 201);
  assert.equal(f.db.prepare("SELECT owner_id FROM sites WHERE domain='new-bob.example.com'").get().owner_id, f.ids.bob);
});

test('管理员四层接口按客户管理资源并完整读取更新请求体', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const standard = f.db.prepare("SELECT id FROM plans WHERE code='standard'").get();
  const subscriptionId = await f.billing.assignPlan(f.ids.alice, standard.id);
  const snapshot = {
    id: 'stream-a', name: 'API 转发', des: '备用说明', enable: 1,
    listen: [{ port: 18443, protocol: 'tcp' }], backend_port: 18443,
    backend: [{ addr: '192.0.2.10', weight: 1, state: 'up' }],
    cname_hostname: 'edge', cname_domain: 'example.net', sync_state: 'synced',
  };
  const localId = Number(f.db.prepare(`INSERT INTO tenant_resources (owner_id,subscription_id,kind,upstream_id,enabled,snapshot)
    VALUES (?,?,'streams','stream-a',1,?)`).run(f.ids.alice, subscriptionId, JSON.stringify(snapshot)).lastInsertRowid);
  f.db.prepare('INSERT INTO stream_ports (resource_id,port) VALUES (?,18443)').run(localId);
  f.cdnfly.request = async (method, path, body) => {
    f.cdnfly.calls.push(['request', method, path, body]);
    if (method === 'GET' && path === '/v1/streams/stream-a') return snapshot;
    if (method === 'PUT' && path === '/v1/streams/stream-a') return { ...snapshot, ...body };
    if (method === 'DELETE' && path === '/v1/streams/stream-a') return true;
    return { items: [] };
  };

  const listed = await (await request(base, '/api/admin/streams', admin.cookie)).json();
  assert.equal(listed.streams.length, 1);
  assert.equal(listed.streams[0].name, 'API 转发');
  assert.equal(listed.streams[0].cname, 'edge.example.net');
  assert.deepEqual(listed.streams[0].ports, [18443]);
  assert.equal(listed.streams[0].syncState, 'synced');

  const detail = await request(base, `/api/admin/streams/${localId}`, admin.cookie);
  assert.equal(detail.status, 200); assert.equal((await detail.json()).stream.backendPort, 18443);
  const activeDelete = await request(base, `/api/admin/streams/${localId}`, admin.cookie, 'DELETE');
  assert.equal(activeDelete.status, 409); assert.match((await activeDelete.json()).error, /请先停用四层转发/);
  const updated = await request(base, `/api/admin/streams/${localId}`, admin.cookie, 'PUT', { enable: 0 });
  assert.equal(updated.status, 200);
  assert.deepEqual(f.cdnfly.calls.at(-1), ['request', 'PUT', '/v1/streams/stream-a', {
    enable: 0, des: '[AN:TEST-ACCOUNT:U000002] 备用说明',
  }]);
  assert.equal(f.db.prepare('SELECT enabled FROM tenant_resources WHERE id=?').get(localId).enabled, 0);
  assert.equal((await request(base, `/api/admin/streams/${localId}`, admin.cookie, 'DELETE')).status, 200);
  assert.equal(f.db.prepare('SELECT id FROM tenant_resources WHERE id=?').get(localId), undefined);
  assert.equal((await request(base, '/api/admin/streams', (await login(base, 'bob', 'bobby-password')).cookie)).status, 403);
});

test('兑换码原子发放套餐且不泄露完整码或允许同租户重复兑换', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password'); const bob = await login(base, 'bob', 'bobby-password');
  const plan = f.db.prepare("SELECT id FROM plans WHERE code='standard'").get();
  f.db.prepare("UPDATE plans SET purchase_mode='once' WHERE id=?").run(plan.id);
  const created = await request(base, '/api/admin/billing/redemption-codes', admin.cookie, 'POST', { type: 'plan', productId: plan.id, count: 2, maxUses: 2, label: '活动码' });
  assert.equal(created.status, 201); const generated = (await created.json()).codes; const code = generated[0].code;
  const list = await (await request(base, '/api/admin/billing/redemption-codes', admin.cookie)).json();
  assert.equal(list.codes[0].code, undefined); assert.equal(list.codes[0].codeHash, undefined);
  assert.equal((await request(base, '/api/billing/redeem', alice.cookie, 'POST', { code })).status, 200);
  assert.equal((await f.billing.activeSubscription(f.ids.alice)).plan_id, plan.id);
  assert.equal((await request(base, '/api/billing/redeem', alice.cookie, 'POST', { code })).status, 409);
  const subscription = f.db.prepare('SELECT id FROM subscriptions WHERE user_id=? AND plan_id=?').get(f.ids.alice, plan.id);
  f.db.prepare("UPDATE subscriptions SET status='expired', ends_at=? WHERE id=?")
    .run(new Date(Date.now() - 86400_000).toISOString(), subscription.id);
  assert.equal((await request(base, '/api/billing/redeem', alice.cookie, 'POST', { code: generated[1].code })).status, 409);
  assert.equal((await request(base, '/api/billing/redeem', bob.cookie, 'POST', { code })).status, 200);
  assert.equal(f.db.prepare('SELECT used_count FROM redemption_codes WHERE id=?').get(generated[0].id).used_count, 2);
  assert.equal(f.db.prepare('SELECT used_count FROM redemption_codes WHERE id=?').get(generated[1].id).used_count, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM orders WHERE channel='redemption' AND status='paid'").get().count, 2);
});

test('增值项和流量包兑换仅增加当前租户权益', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password'); const bob = await login(base, 'bob', 'bobby-password');
  const upgradeId = Number(f.db.prepare("INSERT INTO plan_upgrades (name, price_cents, port_increment) VALUES ('端口扩容',500,2)").run().lastInsertRowid);
  const trafficId = Number(f.db.prepare("INSERT INTO traffic_packages (name, traffic_bytes, price_cents, duration_days) VALUES ('20G流量包',?,500,30)").run(20 * 1024 ** 3).lastInsertRowid);
  const makeCode = async (type, productId, amount = 1) => {
    const response = await request(base, '/api/admin/billing/redemption-codes', admin.cookie, 'POST', { type, productId, amount });
    return (await response.json()).codes[0].code;
  };
  assert.equal((await request(base, '/api/billing/redeem', alice.cookie, 'POST', { code: await makeCode('upgrade', upgradeId, 2) })).status, 200);
  assert.equal((await request(base, '/api/billing/redeem', alice.cookie, 'POST', { code: await makeCode('traffic', trafficId, 2) })).status, 200);
  assert.equal((await f.billing.entitlement(f.ids.alice)).portLimit, 4);
  assert.equal((await f.billing.entitlement(f.ids.alice)).trafficLimitBytes, 50 * 1024 ** 3);
  assert.equal((await f.billing.entitlement(f.ids.bob)).portLimit, 0);
  assert.equal((await (await request(base, '/api/billing/redemptions', bob.cookie)).json()).redemptions.length, 0);
  assert.equal((await request(base, '/api/admin/customers', alice.cookie)).status, 403);
  assert.equal((await request(base, '/api/admin/sites', alice.cookie)).status, 403);
});

test('Turnstile 通过后才发送验证码且发送冷却按邮箱和 IP 生效', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const rejected = await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    turnstileEnabled: true, turnstileSiteKey: 'site-key', turnstileSecret: 'secret-key',
    emailCodeCooldownSeconds: 30, emailCodeHourlyLimit: 3,
  });
  assert.equal(rejected.status, 409);
  const saved = await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    turnstileEnabled: false, turnstileSiteKey: 'site-key', turnstileSecret: 'secret-key',
    emailCodeCooldownSeconds: 30, emailCodeHourlyLimit: 3,
  });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).settings.turnstileVerified, false);
  assert.equal((await request(base, '/api/admin/settings/test-turnstile', admin.cookie, 'POST', { turnstileToken: 'valid-turnstile' })).status, 200);
  const enabled = await request(base, '/api/admin/settings', admin.cookie, 'PUT', { turnstileEnabled: true });
  assert.equal(enabled.status, 200); assert.equal((await enabled.json()).settings.turnstileVerified, true);
  const publicConfig = await (await request(base, '/api/auth/config')).json();
  assert.equal(publicConfig.turnstileEnabled, true); assert.equal(publicConfig.turnstileSiteKey, 'site-key');
  assert.equal(publicConfig.turnstileSecret, undefined); assert.equal(publicConfig.turnstileConfigured, undefined);

  const body = { username: 'turnstile_user', email: 'turnstile@example.com', password: 'turnstile-password' };
  assert.equal((await request(base, '/api/auth/register', null, 'POST', body)).status, 400);
  assert.equal((await request(base, '/api/auth/register', null, 'POST', { ...body, turnstileToken: 'invalid' })).status, 400);
  assert.equal(f.sentCodes.length, 0);
  const blockedDomain = await request(base, '/api/auth/register', null, 'POST', { ...body, email: 'turnstile@invalid.test', turnstileToken: 'valid-turnstile' });
  assert.equal(blockedDomain.status, 403); assert.equal(f.sentCodes.length, 0);
  const accepted = await request(base, '/api/auth/register', null, 'POST', { ...body, turnstileToken: 'valid-turnstile' });
  assert.equal(accepted.status, 202); assert.equal(f.sentCodes.length, 1);
  const crossFlowLimited = await request(base, '/api/auth/password/forgot', null, 'POST', { email: 'other@example.net', turnstileToken: 'valid-turnstile' });
  assert.equal(crossFlowLimited.status, 429); assert.equal(f.sentCodes.length, 1);
  const limited = await request(base, '/api/auth/register', null, 'POST', { ...body, turnstileToken: 'valid-turnstile' });
  assert.equal(limited.status, 429); assert.ok((await limited.json()).retryAfter > 0); assert.equal(f.sentCodes.length, 1);
  assert.equal((await login(base, 'alice', 'alice-password')).response.status, 400);
  assert.equal((await request(base, '/api/auth/login', null, 'POST', { username: 'alice', password: 'alice-password', turnstileToken: 'valid-turnstile' })).status, 200);
  assert.ok(f.turnstileCalls.length >= 4);

  const changed = await request(base, '/api/admin/settings', admin.cookie, 'PUT', { turnstileEnabled: false, turnstileSiteKey: 'changed-key' });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).settings.turnstileVerified, false);
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', { turnstileEnabled: true })).status, 409);
});

test('测试邮件同样要求 Turnstile 并与验证码邮件共享限流', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    turnstileEnabled: false, turnstileSiteKey: 'site-key', turnstileSecret: 'secret-key',
  });
  assert.equal((await request(base, '/api/admin/settings/test-turnstile', admin.cookie, 'POST', { turnstileToken: 'valid-turnstile' })).status, 200);
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', { turnstileEnabled: true })).status, 200);
  assert.equal((await request(base, '/api/admin/settings/test-email', admin.cookie, 'POST', { email: 'test@example.com' })).status, 400);
  assert.equal((await request(base, '/api/admin/settings/test-email', admin.cookie, 'POST', { email: 'test@example.com', turnstileToken: 'invalid' })).status, 400);
  assert.equal(f.sentTexts.length, 0);
  assert.equal((await request(base, '/api/admin/settings/test-email', admin.cookie, 'POST', { email: 'test@example.com', turnstileToken: 'valid-turnstile' })).status, 200);
  assert.equal(f.sentTexts.length, 1);
  const limited = await request(base, '/api/auth/password/forgot', null, 'POST', { email: 'other@example.net', turnstileToken: 'valid-turnstile' });
  assert.equal(limited.status, 429); assert.equal(f.sentCodes.length, 0);
});

test('邮件服务已配置但邮箱验证关闭时系统状态显示未启用', async t => {
  const f = await fixture({ emailVerificationEnabled: false }); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const result = await (await request(base, '/api/admin/health', admin.cookie)).json();
  assert.deepEqual(result.services.email, { ok: true, skipped: true, required: false, configured: true, error: '邮箱验证未启用' });
});

test('邮箱和 IP 二次拒绝规则接口及数据表已删除', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  assert.equal((await request(base, '/api/admin/security/blocks', admin.cookie)).status, 404);
  assert.equal((await request(base, '/api/admin/security/blocks', admin.cookie, 'POST', { type: 'email', value: 'blocked@example.com' })).status, 404);
  const table = f.db.prepare("SELECT table_name FROM information_schema.tables WHERE table_name='blocked_identities'").get();
  assert.equal(table, undefined);
});

test('用户可通过邮箱验证码找回密码且旧会话全部失效', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  f.db.prepare('UPDATE users SET email=?, email_verified_at=CURRENT_TIMESTAMP WHERE id=?').run('alice@example.com', f.ids.alice);
  const session = await login(base, 'alice', 'alice-password');
  const requested = await request(base, '/api/auth/password/forgot', null, 'POST', { email: 'alice@example.com' });
  assert.equal(requested.status, 202); const code = (await requested.json()).devCode;
  assert.equal((await request(base, '/api/auth/password/reset', null, 'POST', { email: 'alice@example.com', code: '000000', newPassword: 'new-alice-password' })).status, 400);
  assert.equal((await request(base, '/api/auth/password/reset', null, 'POST', { email: 'alice@example.com', code, newPassword: 'new-alice-password' })).status, 200);
  assert.equal((await request(base, '/api/me', session.cookie)).status, 401);
  assert.equal((await login(base, 'alice@example.com', 'new-alice-password')).response.status, 200);
});

test('充值码增加余额、重复核销被拒绝且完整码不在列表中返回', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password');
  const created = await request(base, '/api/admin/billing/recharge-codes', admin.cookie, 'POST', { amountCents: 2500, count: 1, label: '测试充值' });
  assert.equal(created.status, 201); const code = (await created.json()).codes[0].code;
  const listed = await (await request(base, '/api/admin/billing/recharge-codes', admin.cookie)).json();
  assert.equal(listed.codes[0].code, undefined); assert.equal(listed.codes[0].codeHash, undefined);
  const redeemed = await request(base, '/api/billing/recharge-code', alice.cookie, 'POST', { code });
  assert.equal(redeemed.status, 200); assert.equal((await redeemed.json()).balanceCents, 2500);
  assert.equal((await request(base, '/api/billing/recharge-code', alice.cookie, 'POST', { code })).status, 409);
  const wallet = await (await request(base, '/api/billing/wallet', alice.cookie)).json();
  assert.equal(wallet.balanceCents, 2500); assert.equal(wallet.transactions.length, 1); assert.equal(wallet.transactions[0].direction, 'credit');
});

test('管理员创建客户时不分配套餐并初始化零余额钱包', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const created = await request(base, '/api/admin/customers', admin.cookie, 'POST', { username: 'manual_user', email: 'manual@example.com', password: 'manual-user-password' });
  assert.equal(created.status, 201); const user = (await created.json()).customer;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=?').get(user.id).count, 0);
  assert.equal(f.db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(user.id).balance_cents, 0);
});

test('用户验证新邮箱后完成更换并使全部旧会话失效', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  f.db.prepare('UPDATE users SET email=?,email_verified_at=CURRENT_TIMESTAMP WHERE id=?').run('alice@example.com', f.ids.alice);
  f.db.prepare('UPDATE users SET email=?,email_verified_at=CURRENT_TIMESTAMP WHERE id=?').run('bob@example.com', f.ids.bob);
  const first = await login(base, 'alice', 'alice-password'); const second = await login(base, 'alice', 'alice-password');
  assert.equal((await request(base, '/api/account/email/change/request', first.cookie, 'POST', {
    email: 'new-alice@example.com', currentPassword: 'wrong-password',
  })).status, 403);
  assert.equal((await request(base, '/api/account/email/change/request', first.cookie, 'POST', {
    email: 'bob@example.com', currentPassword: 'alice-password',
  })).status, 409);
  const requested = await request(base, '/api/account/email/change/request', first.cookie, 'POST', {
    email: 'new-alice@example.com', currentPassword: 'alice-password',
  });
  assert.equal(requested.status, 202); const code = (await requested.json()).devCode;
  assert.equal((await request(base, '/api/account/email/change/confirm', first.cookie, 'POST', { code: '000000' })).status, 400);
  assert.equal((await request(base, '/api/account/email/change/confirm', first.cookie, 'POST', { code })).status, 200);
  assert.equal((await request(base, '/api/me', first.cookie)).status, 401);
  assert.equal((await request(base, '/api/me', second.cookie)).status, 401);
  assert.equal((await login(base, 'alice@example.com', 'alice-password')).response.status, 401);
  assert.equal((await login(base, 'new-alice@example.com', 'alice-password')).response.status, 200);
  const changed = f.db.prepare('SELECT email,email_verified_at FROM users WHERE id=?').get(f.ids.alice);
  assert.equal(changed.email, 'new-alice@example.com'); assert.ok(changed.email_verified_at);
});

test('邮箱更换验证码过期和尝试次数上限均被拒绝', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const alice = await login(base, 'alice', 'alice-password');
  const expiredRequest = await request(base, '/api/account/email/change/request', alice.cookie, 'POST', {
    email: 'expired@example.com', currentPassword: 'alice-password',
  });
  assert.equal(expiredRequest.status, 202);
  f.db.prepare('UPDATE email_change_tokens SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 60_000).toISOString(), f.ids.alice);
  assert.equal((await request(base, '/api/account/email/change/confirm', alice.cookie, 'POST', { code: (await expiredRequest.json()).devCode })).status, 409);

  f.db.prepare('DELETE FROM email_change_tokens WHERE user_id=?').run(f.ids.alice);
  const requested = await request(base, '/api/account/email/change/request', alice.cookie, 'POST', {
    email: 'attempts@example.net', currentPassword: 'alice-password',
  });
  assert.equal(requested.status, 429);

  const f2 = await fixture(); const base2 = await start(f2); t.after(() => { f2.server.close(); f2.db.close(); });
  const session = await login(base2, 'alice', 'alice-password');
  assert.equal((await request(base2, '/api/account/email/change/request', session.cookie, 'POST', {
    email: 'attempts@example.com', currentPassword: 'alice-password',
  })).status, 202);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request(base2, '/api/account/email/change/confirm', session.cookie, 'POST', { code: '000000' })).status, 400);
  }
  assert.equal((await request(base2, '/api/account/email/change/confirm', session.cookie, 'POST', { code: '000000' })).status, 429);
});

test('邮箱更换在启用 Turnstile 时先完成人机验证再发送验证码', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password');
  await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    turnstileEnabled: false, turnstileSiteKey: 'site-key', turnstileSecret: 'secret-key',
  });
  assert.equal((await request(base, '/api/admin/settings/test-turnstile', admin.cookie, 'POST', { turnstileToken: 'valid-turnstile' })).status, 200);
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', { turnstileEnabled: true })).status, 200);
  const body = { email: 'secured@example.com', currentPassword: 'alice-password' };
  assert.equal((await request(base, '/api/account/email/change/request', alice.cookie, 'POST', body)).status, 400);
  assert.equal((await request(base, '/api/account/email/change/request', alice.cookie, 'POST', { ...body, turnstileToken: 'invalid' })).status, 400);
  assert.equal(f.sentCodes.length, 0);
  assert.equal((await request(base, '/api/account/email/change/request', alice.cookie, 'POST', { ...body, turnstileToken: 'valid-turnstile' })).status, 202);
  assert.equal(f.sentCodes.length, 1); assert.equal(f.sentCodes[0].purpose, 'emailChange');
});

test('关闭邮箱验证后用户可直接更换邮箱且不发送验证码', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password');
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', { emailVerificationEnabled: false })).status, 200);
  const changed = await request(base, '/api/account/email/change/request', alice.cookie, 'POST', {
    email: 'direct-change@example.com', currentPassword: 'alice-password',
  });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).verificationRequired, false);
  assert.equal(f.sentCodes.length, 0); assert.equal((await request(base, '/api/me', alice.cookie)).status, 401);
  assert.equal((await login(base, 'direct-change@example.com', 'alice-password')).response.status, 200);
});

test('账号注销检查阻塞项并在成功后保留历史财务与审计记录', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const alice = await login(base, 'alice', 'alice-password');
  const blocked = await request(base, '/api/account/closure', alice.cookie); const blockedBody = await blocked.json();
  assert.equal(blocked.status, 200); assert.equal(blockedBody.eligible, false);
  assert.deepEqual(blockedBody.blockers.map(item => item.key).sort(), ['sites', 'subscriptions']);
  assert.equal((await request(base, '/api/account', alice.cookie, 'DELETE', { currentPassword: 'wrong-password' })).status, 403);
  assert.equal((await request(base, '/api/account', alice.cookie, 'DELETE', { currentPassword: 'alice-password' })).status, 409);

  const admin = await login(base, 'admin', 'admin-password');
  const created = await request(base, '/api/admin/customers', admin.cookie, 'POST', {
    username: 'closable', email: 'closable@example.com', password: 'closable-password',
  });
  const customer = (await created.json()).customer;
  f.db.prepare("INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id,description) VALUES (?,'credit',1000,1000,'recharge-code','closure-recharge','历史充值')").run(customer.id);
  f.db.prepare("INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id,description) VALUES (?,'debit',1000,0,'order','closure-order','历史消费')").run(customer.id);
  f.db.prepare("INSERT INTO orders (user_id,type,amount_cents,status,channel,product_name,paid_at) VALUES (?,'plan',1000,'paid','balance','历史套餐',CURRENT_TIMESTAMP)").run(customer.id);
  f.db.prepare("INSERT INTO audit_logs (actor_id,action,resource_type,resource_id) VALUES (?,'history.action','user',?)").run(customer.id, String(customer.id));
  const customerSession = await login(base, 'closable@example.com', 'closable-password');
  assert.equal((await (await request(base, '/api/account/closure', customerSession.cookie)).json()).eligible, true);
  assert.equal((await request(base, '/api/account', customerSession.cookie, 'DELETE', { currentPassword: 'closable-password' })).status, 200);
  const closed = f.db.prepare('SELECT username,email,status FROM users WHERE id=?').get(customer.id);
  assert.deepEqual(closed, { username: 'closable', email: null, status: 'disabled' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wallet_transactions WHERE user_id=?').get(customer.id).count, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id=?').get(customer.id).count, 1);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=?').get(customer.id).count >= 2);
  assert.equal((await login(base, 'closable', 'closable-password')).response.status, 401);
  assert.equal((await login(base, 'closable@example.com', 'closable-password')).response.status, 401);
});

test('启用 MFA 的用户注销账号时必须提交动态验证码', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const created = await request(base, '/api/admin/customers', admin.cookie, 'POST', {
    username: 'mfa_close', email: 'mfa-close@example.com', password: 'mfa-close-password',
  });
  const customer = (await created.json()).customer; const session = await login(base, 'mfa_close', 'mfa-close-password');
  const setup = await (await request(base, '/api/account/mfa/setup', session.cookie, 'POST', { currentPassword: 'mfa-close-password' })).json();
  assert.equal((await request(base, '/api/account/mfa/confirm', session.cookie, 'POST', { code: mfaInternals.totp(setup.secret) })).status, 200);
  assert.equal((await request(base, '/api/account', session.cookie, 'DELETE', { currentPassword: 'mfa-close-password' })).status, 403);
  assert.equal((await request(base, '/api/account', session.cookie, 'DELETE', {
    currentPassword: 'mfa-close-password', mfaCode: mfaInternals.totp(setup.secret),
  })).status, 200);
  assert.equal(f.db.prepare('SELECT status FROM users WHERE id=?').get(customer.id).status, 'disabled');
});

test('余额摘要返回可用余额、累计充值和扣除退款后的累计消费', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  f.db.prepare('INSERT INTO wallets (user_id,balance_cents) VALUES (?,5300) ON CONFLICT(user_id) DO UPDATE SET balance_cents=5300').run(f.ids.alice);
  f.db.prepare("INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id) VALUES (?,'credit',5000,5000,'recharge-code','wallet-recharge')").run(f.ids.alice);
  f.db.prepare("INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id) VALUES (?,'debit',1200,3800,'order','wallet-order')").run(f.ids.alice);
  f.db.prepare("INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id) VALUES (?,'credit',1200,5000,'order-refund','wallet-refund')").run(f.ids.alice);
  f.db.prepare("INSERT INTO wallet_transactions (user_id,direction,amount_cents,balance_after_cents,reference_type,reference_id) VALUES (?,'credit',300,5300,'admin-adjustment','wallet-adjustment')").run(f.ids.alice);
  const alice = await login(base, 'alice', 'alice-password'); const wallet = await (await request(base, '/api/billing/wallet', alice.cookie)).json();
  assert.equal(wallet.availableBalanceCents, 5300); assert.equal(wallet.totalRechargeCents, 5300); assert.equal(wallet.totalSpentCents, 0);
  assert.equal(wallet.frozenBalanceCents, undefined); assert.equal(wallet.frozenCents, undefined);
});

test('公告按受众和时间展示且内容变更生成新版本', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password'); const alice = await login(base, 'alice', 'alice-password');
  const startsAt = new Date(Date.now() - 60_000).toISOString(); const endsAt = new Date(Date.now() + 60_000).toISOString();
  const saved = await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    announcementEnabled: true, announcementTitle: '客户公告', announcementBody: '维护窗口说明', announcementSeverity: 'warning',
    announcementAudience: 'customers', announcementMode: 'modal', announcementDismissible: true, announcementStartsAt: startsAt, announcementEndsAt: endsAt,
  });
  assert.equal(saved.status, 200); const firstVersion = (await saved.json()).settings.announcementVersion; assert.ok(firstVersion);
  assert.equal((await (await request(base, '/api/auth/config')).json()).announcementEnabled, false);
  const customerConfig = await (await request(base, '/api/auth/config', alice.cookie)).json();
  assert.equal(customerConfig.announcementEnabled, true); assert.equal(customerConfig.announcementStatus, 'active'); assert.equal(customerConfig.announcementMode, 'modal');
  assert.equal((await (await request(base, '/api/auth/config', admin.cookie)).json()).announcementEnabled, false);
  const allAudience = await request(base, '/api/admin/settings', admin.cookie, 'PUT', { announcementAudience: 'all' });
  assert.equal(allAudience.status, 200);
  assert.equal((await (await request(base, '/api/auth/config')).json()).announcementEnabled, true);
  assert.equal((await (await request(base, '/api/auth/config', alice.cookie)).json()).announcementEnabled, true);
  assert.equal((await (await request(base, '/api/auth/config', admin.cookie)).json()).announcementEnabled, true);
  const legacyPublic = await request(base, '/api/admin/settings', admin.cookie, 'PUT', { announcementAudience: 'public' });
  assert.equal((await legacyPublic.json()).settings.announcementAudience, 'public');
  assert.equal((await (await request(base, '/api/auth/config')).json()).announcementEnabled, true);
  assert.equal((await (await request(base, '/api/auth/config', alice.cookie)).json()).announcementEnabled, false);
  assert.equal((await (await request(base, '/api/auth/config', admin.cookie)).json()).announcementEnabled, false);
  const updated = await request(base, '/api/admin/settings', admin.cookie, 'PUT', { announcementBody: '新的维护说明' });
  assert.notEqual((await updated.json()).settings.announcementVersion, firstVersion);
  const scheduled = await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    announcementStartsAt: new Date(Date.now() + 120_000).toISOString(), announcementEndsAt: new Date(Date.now() + 240_000).toISOString(),
  });
  assert.equal(scheduled.status, 200);
  const scheduledConfig = await (await request(base, '/api/auth/config', alice.cookie)).json();
  assert.equal(scheduledConfig.announcementEnabled, false); assert.equal(scheduledConfig.announcementStatus, 'scheduled');
  assert.equal((await request(base, '/api/admin/settings', admin.cookie, 'PUT', {
    announcementStartsAt: new Date(Date.now() + 240_000).toISOString(), announcementEndsAt: new Date(Date.now() + 120_000).toISOString(),
  })).status, 400);
});

test('本地 CSV 导出路由均已移除', async t => {
  const f = await fixture(); const base = await start(f); t.after(() => { f.server.close(); f.db.close(); });
  const admin = await login(base, 'admin', 'admin-password');
  const routes = [
    '/api/admin/customers/export', '/api/admin/billing/orders/export', '/api/admin/billing/reports/export',
    '/api/admin/audit/export', '/api/admin/billing/recharge-codes/export',
  ];
  for (const route of routes) assert.equal((await request(base, route, admin.cookie)).status, 404, route);
});
