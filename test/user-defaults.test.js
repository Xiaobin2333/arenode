import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, databaseInternals } from '../src/db.js';
import { applyUserDefaults } from '../src/user-defaults.js';
import { exposeOwnershipRemark, ownershipRemark, stripOwnershipRemark } from '../src/resource-ownership.js';
import { configInternals } from '../src/config.js';

function fixture() {
  const db = createDatabase();
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
    .run('defaults-user', 'x', 'user').lastInsertRowid);
  const siteGroupId = Number(db.prepare('INSERT INTO customer_site_groups (user_id,name) VALUES (?,?)')
    .run(userId, '生产网站').lastInsertRowid);
  const streamGroupId = Number(db.prepare('INSERT INTO customer_stream_groups (user_id,name) VALUES (?,?)')
    .run(userId, '生产转发').lastInsertRowid);
  return { db, userId, siteGroupId, streamGroupId };
}

function addConfig(db, userId, name, value, type, scopeName = 'global', scopeId = 0) {
  db.prepare(`INSERT INTO user_configs (user_id,name,value,type,scope_name,scope_id,enable)
    VALUES (?,?,?,?,?,?,1)`).run(userId, name, value, type, scopeName, scopeId);
}

test('客户默认设置按全局、站内分组、表单输入的优先级应用', async () => {
  const f = fixture();
  try {
    addConfig(f.db, f.userId, 'gzip_enable', '1', 'site');
    addConfig(f.db, f.userId, 'balance_way', 'ip_hash', 'site');
    addConfig(f.db, f.userId, 'balance_way', 'least_conn', 'site', 'group', f.siteGroupId);
    addConfig(f.db, f.userId, 'https_listen.http2', '1', 'site', 'group', f.siteGroupId);
    const applied = await applyUserDefaults(f.db, f.userId, 'site', f.siteGroupId, {
      domain: 'default.example.com', balance_way: 'rr', https_listen: { port: '443' },
    });
    assert.equal(applied.gzip_enable, 1);
    assert.equal(applied.balance_way, 'rr');
    assert.deepEqual(applied.https_listen, { http2: 1, port: '443' });
  } finally { f.db.close(); }
});

test('四层和证书默认设置只写入新资源请求且证书保持客户全局作用域', async () => {
  const f = fixture();
  try {
    addConfig(f.db, f.userId, 'listen_protocol', 'udp', 'stream', 'group', f.streamGroupId);
    addConfig(f.db, f.userId, 'balance_way', 'ip_hash', 'stream');
    addConfig(f.db, f.userId, 'provider', 'zerossl', 'cert');
    addConfig(f.db, f.userId, 'auto_renew', '1', 'cert');
    const stream = await applyUserDefaults(f.db, f.userId, 'stream', f.streamGroupId, {
      listen: [{ port: 8443 }], backend: [{ addr: '192.0.2.1' }], backend_port: 443,
    });
    assert.deepEqual(stream.listen, [{ protocol: 'udp', port: 8443 }]);
    assert.equal(stream.balance_way, 'ip_hash');
    const cert = await applyUserDefaults(f.db, f.userId, 'cert', f.siteGroupId, { name: '自动证书', domain: 'cert.example.com' });
    assert.equal(cert.type, 'zerossl'); assert.equal(cert.auto_renew, 1);
  } finally { f.db.close(); }
});

test('上游归属备注包含分销站和客户标记且客户侧会剥离标记', () => {
  const client = { groupNamespace: 'RESELLER-A' };
  const marked = ownershipRemark(client, 7, '生产证书');
  assert.equal(marked, '[AN:RESELLER-A:U000007] 生产证书');
  assert.deepEqual(exposeOwnershipRemark({ name: '证书', des: marked }), { name: '证书', des: '生产证书' });
  assert.equal(stripOwnershipRemark('[ED:RESELLER-A:U000007] 历史备注'), '历史备注');
});

test('上游站点标识不包含部署网址或 IP', () => {
  const value = configInternals.opaqueUpstreamGroupNamespace('https://console.example.com');
  assert.match(value, /^S-[A-F0-9]{12}$/);
  assert.equal(value.includes('192'), false);
  assert.equal(value.includes('3080'), false);
});

test('品牌迁移只替换系统历史默认站点信息', async () => {
  const db = createDatabase();
  try {
    db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?)').run('site_name', 'SCDN用户中心');
    db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?)').run('site_subtitle', '企业商用 CDN 用户控制台');
    db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?)').run('support_email', 'support@example.com');
    await databaseInternals.migrateBrandDefaults(db);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='site_name'").get().value, 'Arenode');
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='site_subtitle'").get().value, '边缘资源管理平台');
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='support_email'").get().value, 'support@example.com');
  } finally { db.close(); }
});
