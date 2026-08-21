import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { mfaInternals } from '../src/mfa.js';
import { hashPassword } from '../src/security.js';

async function fixture() {
  const db = createDatabase();
  const insert = db.prepare('INSERT INTO users (username, email, password_hash, role, site_limit) VALUES (?, ?, ?, ?, ?)');
  const superAdmin = Number(insert.run('rootadmin', 'root@example.com', hashPassword('root-password'), 'admin', 0).lastInsertRowid);
  const administrator = Number(insert.run('operator', 'operator@example.com', hashPassword('operator-password'), 'admin', 0).lastInsertRowid);
  const customer = Number(insert.run('customer', 'customer@example.com', hashPassword('customer-password'), 'user', 0).lastInsertRowid);
  db.prepare('INSERT INTO admin_profiles (user_id, role_key) VALUES (?, ?)').run(superAdmin, 'super_admin');
  db.prepare('INSERT INTO admin_profiles (user_id, role_key) VALUES (?, ?)').run(administrator, 'admin');
  const cdnfly = { health: async () => true };
  const config = {
    appOrigin: 'http://127.0.0.1', sessionHours: 24, cdnflyUserPackageId: 1,
    settingsEncryptionKey: 'commercial-security-test-key',
  };
  const server = http.createServer(createApp({ db, cdnfly, config }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, ids: { superAdmin, administrator, customer } };
}

async function request(fixtureValue, path, { cookie, method = 'GET', body } = {}) {
  return fetch(`${fixtureValue.base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(fixtureValue, username, password) {
  const response = await request(fixtureValue, '/api/auth/login', { method: 'POST', body: { username, password } });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function enableMfa(fixtureValue, cookie, password) {
  const setupResponse = await request(fixtureValue, '/api/account/mfa/setup', { cookie, method: 'POST', body: { currentPassword: password } });
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json();
  assert.match(setup.otpauthUri, /issuer=Arenode/);
  const confirm = await request(fixtureValue, '/api/account/mfa/confirm', {
    cookie, method: 'POST', body: { code: mfaInternals.totp(setup.secret) },
  });
  assert.equal(confirm.status, 200);
  return setup;
}

test('普通用户可完整配置 MFA，错误次数受限且恢复码只能使用一次', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const initial = await login(f, 'customer', 'customer-password');
  assert.equal(initial.response.status, 200);
  const setup = await enableMfa(f, initial.cookie, 'customer-password');
  assert.equal(setup.recoveryCodes.length, 8);

  const enabled = await (await request(f, '/api/account/mfa', { cookie: initial.cookie })).json();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.recoveryCodesRemaining, 8);

  await request(f, '/api/auth/logout', { cookie: initial.cookie, method: 'POST' });
  const challenged = await login(f, 'customer', 'customer-password');
  assert.equal(challenged.response.status, 202);
  assert.equal(challenged.cookie, undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const invalid = await request(f, '/api/auth/login/mfa', {
      method: 'POST', body: { challengeToken: challenged.data.challengeToken, code: '000000' },
    });
    assert.equal(invalid.status, 401);
  }
  const locked = await request(f, '/api/auth/login/mfa', {
    method: 'POST', body: { challengeToken: challenged.data.challengeToken, code: '000000' },
  });
  assert.equal(locked.status, 429);

  const recoveryChallenge = await login(f, 'customer', 'customer-password');
  const recovered = await request(f, '/api/auth/login/mfa', {
    method: 'POST', body: { challengeToken: recoveryChallenge.data.challengeToken, code: setup.recoveryCodes[0] },
  });
  assert.equal(recovered.status, 200);
  const recoveryCookie = recovered.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await request(f, '/api/account/mfa', { cookie: recoveryCookie })).json()).recoveryCodesRemaining, 7);

  await request(f, '/api/auth/logout', { cookie: recoveryCookie, method: 'POST' });
  const reusedChallenge = await login(f, 'customer', 'customer-password');
  assert.equal((await request(f, '/api/auth/login/mfa', {
    method: 'POST', body: { challengeToken: reusedChallenge.data.challengeToken, code: setup.recoveryCodes[0] },
  })).status, 401);

  const currentChallenge = await login(f, 'customer', 'customer-password');
  const current = await request(f, '/api/auth/login/mfa', {
    method: 'POST', body: { challengeToken: currentChallenge.data.challengeToken, code: mfaInternals.totp(setup.secret) },
  });
  const currentCookie = current.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(f, '/api/account/mfa', {
    cookie: currentCookie, method: 'DELETE', body: { currentPassword: 'customer-password', code: mfaInternals.totp(setup.secret) },
  })).status, 200);
  await request(f, '/api/auth/logout', { cookie: currentCookie, method: 'POST' });
  assert.equal((await login(f, 'customer', 'customer-password')).response.status, 200);
});

test('超级管理员和管理员均可配置 MFA，但只有超级管理员可管理管理员和运行参数', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const operator = await login(f, 'operator', 'operator-password');
  const operatorSetup = await enableMfa(f, operator.cookie, 'operator-password');
  await request(f, '/api/auth/logout', { cookie: operator.cookie, method: 'POST' });
  const operatorChallenge = await login(f, 'operator', 'operator-password');
  const operatorLogin = await request(f, '/api/auth/login/mfa', {
    method: 'POST', body: { challengeToken: operatorChallenge.data.challengeToken, code: mfaInternals.totp(operatorSetup.secret) },
  });
  assert.equal(operatorLogin.status, 200);
  const operatorCookie = operatorLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(f, '/api/admin/administrators', { cookie: operatorCookie })).status, 403);
  assert.equal((await request(f, '/api/admin/settings', { cookie: operatorCookie, method: 'PUT', body: { siteName: 'blocked' } })).status, 403);

  const root = await login(f, 'rootadmin', 'root-password');
  const rootSetup = await enableMfa(f, root.cookie, 'root-password');
  await request(f, '/api/auth/logout', { cookie: root.cookie, method: 'POST' });
  const rootChallenge = await login(f, 'rootadmin', 'root-password');
  const rootLogin = await request(f, '/api/auth/login/mfa', {
    method: 'POST', body: { challengeToken: rootChallenge.data.challengeToken, code: mfaInternals.totp(rootSetup.secret) },
  });
  assert.equal(rootLogin.status, 200);
  const rootCookie = rootLogin.headers.get('set-cookie').split(';')[0];
  const administrators = await request(f, '/api/admin/administrators', { cookie: rootCookie });
  const administratorResult = await administrators.json();
  assert.equal(administrators.status, 200, JSON.stringify(administratorResult));
  assert.deepEqual(administratorResult.administrators.map(item => item.adminRole).sort(), ['admin', 'super_admin']);
  assert.equal((await request(f, `/api/admin/administrators/${f.ids.superAdmin}`, {
    cookie: rootCookie, method: 'PUT', body: { adminRole: 'admin' },
  })).status, 409);
});

test('邀请码独立管理并返回汇总，旧拒绝规则接口不存在', async t => {
  const f = await fixture(); t.after(() => { f.server.close(); f.db.close(); });
  const root = await login(f, 'rootadmin', 'root-password');
  const created = await request(f, '/api/admin/security/invites', {
    cookie: root.cookie, method: 'POST', body: { count: 2, maxUses: 3, label: '渠道测试' },
  });
  assert.equal(created.status, 201); const codes = (await created.json()).codes; assert.equal(codes.length, 2);
  const firstPageResponse = await request(f, '/api/admin/security/invites?page=1&pageSize=1', { cookie: root.cookie });
  const firstPage = await firstPageResponse.json(); assert.equal(firstPageResponse.status, 200, JSON.stringify(firstPage));
  assert.deepEqual(firstPage.summary, { total: 2, active: 2, used: 0 }); assert.equal(firstPage.invites.length, 1);
  assert.equal((await request(f, `/api/admin/security/invites/${codes[0].id}`, { cookie: root.cookie, method: 'DELETE' })).status, 200);
  const afterDisable = await (await request(f, '/api/admin/security/invites', { cookie: root.cookie })).json();
  assert.deepEqual(afterDisable.summary, { total: 2, active: 1, used: 0 });
  assert.equal((await request(f, '/api/admin/security/blocks', { cookie: root.cookie })).status, 404);
  assert.equal((await request(f, '/api/admin/security/blocks', { cookie: root.cookie, method: 'POST', body: { type: 'ip', value: '192.0.2.1' } })).status, 404);
});
