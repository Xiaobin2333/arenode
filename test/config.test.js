import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionConfig } from '../src/config.js';

const valid = {
  databaseUrl: 'postgres://arenode:strong-password@postgres:5432/arenode',
  settingsEncryptionKey: 'a'.repeat(32),
  adminPassword: '',
  mailDevExposeCode: false,
};

test('生产配置要求加密主密钥并拒绝示例数据库密码', () => {
  assert.equal(assertProductionConfig(valid), true);
  assert.throws(() => assertProductionConfig({ ...valid, settingsEncryptionKey: 'short' }), /至少需要 32 个字符/);
  assert.throws(() => assertProductionConfig({ ...valid, databaseUrl: 'postgres://u:change-this-password@db/app' }), /示例数据库密码/);
  assert.throws(() => assertProductionConfig({ ...valid, adminPassword: 'short' }), /至少需要 10 个字符/);
  assert.throws(() => assertProductionConfig({ ...valid, mailDevExposeCode: true }), /禁止 MAIL_DEV_EXPOSE_CODE/);
});
