import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { handlePublicUserCompatApi, handleUserCompatApi } from '../src/user-compat.js';
import { normalizeCdnflyPath } from '../src/compat-path.js';

const config = {
  allowRegistration: true,
  emailVerificationEnabled: false,
  siteName: 'EdgePilot',
  siteSubtitle: 'CDN 服务控制台',
  settingsEncryptionKey: 'compat-test-key',
};

async function get(path) {
  const db = createDatabase();
  try {
    return await handlePublicUserCompatApi({
      req: { method: 'GET' },
      url: new URL(`http://localhost/api/cdnfly/v1${path}`),
      db,
      config,
      mailer: { available: false },
    });
  } finally { db.close(); }
}

test('公共兼容接口使用 CDNFly v6 的连字符路径', async () => {
  const register = await get('/common-register-info');
  assert.equal(register.status, 200);
  assert.equal(register.data.registrationEnabled, true);
  const sysinfo = await get('/common-sysinfo');
  assert.equal(sysinfo.status, 200);
  assert.equal(sysinfo.data.apiVersion, 'v6');
  assert.equal(sysinfo.data.platform, 'arenode');
  const captcha = await get('/common-captcha/email');
  assert.deepEqual(captcha.data, { enabled: false, type: 'none' });
  const captchaType = await get('/common-captcha-type');
  assert.deepEqual(captchaType.data, { enabled: false, type: 'none' });
  const loginPolicy = await get('/user-login-policy');
  assert.deepEqual(loginPolicy.data, { turnstileEnabled: false, maxAttempts: 5, lockMinutes: 15 });
  const officialLoginPolicy = await get('/user/login-policy');
  assert.deepEqual(officialLoginPolicy.data, loginPolicy.data);
});

test('旧公共路径保留为兼容别名', async () => {
  assert.equal((await get('/common/register-info')).status, 200);
  assert.equal((await get('/common/sysinfo')).status, 200);
  assert.equal((await get('/common/captcha-type')).status, 200);
});

test('官方 v6 用户路径映射到现有租户实现', () => {
  const cases = [
    ['/api/cdnfly/v1/user/overview', '/api/cdnfly/v1/user-overview'],
    ['/api/cdnfly/v1/user/certify', '/api/cdnfly/v1/user-certify'],
    ['/api/cdnfly/v1/user/login-policy', '/api/cdnfly/v1/user-login-policy'],
    ['/api/cdnfly/v1/common/menu', '/api/cdnfly/v1/common-menu'],
    ['/api/cdnfly/v1/common/menu2', '/api/cdnfly/v1/common-menu-2'],
    ['/api/cdnfly/v1/common/package-purchase-notice', '/api/cdnfly/v1/common-package-purchase-notice'],
    ['/api/cdnfly/v1/order/count', '/api/cdnfly/v1/order-count'],
    ['/api/cdnfly/v1/user-traffic-package/usage', '/api/cdnfly/v1/user-traffic-package-usage'],
    ['/api/cdnfly/v1/alipay/preorder', '/api/cdnfly/v1/alipay-preorder'],
    ['/api/cdnfly/v1/wxpay/preorder', '/api/cdnfly/v1/wxpay-preorder'],
  ];
  for (const [official, local] of cases) assert.equal(normalizeCdnflyPath(official), local);
  assert.equal(normalizeCdnflyPath('/api/cdnfly/v1/streams'), '/api/cdnfly/v1/streams');
});

test('官方套餐购买说明路径可直接读取', async () => {
  const response = await get('/common/package-purchase-notice');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { html: '' });
});

test('官方用户概览字段由当前租户资源重新计算', async () => {
  const db = createDatabase();
  try {
    const userId = Number((await db.prepare("INSERT INTO users (username,password_hash,role,site_limit) VALUES ('overview-user','x','user',10)").run()).lastInsertRowid);
    await db.prepare('INSERT INTO wallets (user_id,balance_cents) VALUES (?,?)').run(userId, 12345);
    await db.prepare("INSERT INTO sites (owner_id,upstream_id,domain,origin,state) VALUES (?,?,'one.example.com,two.example.com','192.0.2.1','active')").run(userId, 'overview-site');
    await db.prepare("INSERT INTO tenant_resources (owner_id,kind,upstream_id) VALUES (?,'certs','overview-cert')").run(userId);
    const streamId = Number((await db.prepare("INSERT INTO tenant_resources (owner_id,kind,upstream_id) VALUES (?,'streams','overview-stream')").run(userId)).lastInsertRowid);
    await db.prepare('INSERT INTO stream_ports (resource_id,port) VALUES (?,8443),(?,9443)').run(streamId, streamId);
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const result = await handleUserCompatApi({
      req: { method: 'GET' }, url: new URL('http://localhost/api/cdnfly/v1/user/overview'), user, db,
      billing: null, config, readBody: async () => ({}),
    });
    assert.deepEqual(result.data, {
      user_package_count: 0, cert_verified: 0, auth2_enable: 0, auth2_verified: 0, renew: 0,
      balance: 123.45, uid: userId, domain_count: 2, cert_count: 1, stream_port_count: 2,
    });
  } finally { db.close(); }
});
