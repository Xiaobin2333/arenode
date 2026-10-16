import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from '../src/db.js';
import { verifyPassword } from '../src/security.js';
import { requestRegistration, verifyRegistration, requestPasswordReset, resetPassword, requestEmailChange, confirmEmailChange } from '../src/auth-service.js';
import { tenantProxyInternals } from '../src/tenant-proxy.js';
import { withResourceMutation } from '../src/resource-mutation.js';

// Run against a dedicated disposable database; pg-mem cannot validate rollback semantics.
test('PostgreSQL persists failed code attempts across all verification flows', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const db = await createPostgresDatabase(process.env.TEST_DATABASE_URL); t.after(() => db.close());
  const config = { settingsEncryptionKey: 'integration-only', authCodeMinutes: 10 };
  const settings = { siteName: 'test' }; let code;
  const mailer = { available: true, sendCode: async message => { code = message.code; return {}; } };
  const suffix = Date.now(); const email = `verify${suffix}@example.com`;
  const registration = { db, config, mailer, settings, body: { username: `verify${suffix}`, email, password: 'test-password' } };
  const check = async (issue, verify, row) => {
    await issue(); const correct = code; const wrong = code === '000000' ? '000001' : '000000';
    // Concurrent failures exercise row locks as well as transaction commit.
    const failures = await Promise.allSettled(Array.from({ length: 7 }, () => verify(wrong)));
    assert.equal(failures.filter(result => result.status === 'rejected' && result.reason.status === 400).length, 5);
    assert.equal(failures.filter(result => result.status === 'rejected' && result.reason.status === 429).length, 2);
    assert.equal((await row()).attempts, 5);
    await assert.rejects(() => verify(correct), { status: 429 });
    await issue(); assert.equal((await row()).attempts, 0);
    await verify(code); assert.equal(await row(), undefined);
  };
  await check(() => requestRegistration(registration), value => verifyRegistration({ db, config, body: { email, code: value } }),
    () => db.prepare('SELECT attempts FROM pending_registrations WHERE email=?').get(email));
  let user = await db.prepare('SELECT * FROM users WHERE email=?').get(email);
  await check(() => requestPasswordReset({ db, config, mailer, settings, body: { email } }),
    value => resetPassword({ db, config, body: { email, code: value, newPassword: 'changed-password' } }),
    () => db.prepare('SELECT attempts FROM password_reset_tokens WHERE email=?').get(email));
  user = await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  assert.ok(verifyPassword('changed-password', user.password_hash));
  const nextEmail = `changed${suffix}@example.com`;
  await check(() => requestEmailChange({ db, config, mailer, settings, user, body: { email: nextEmail, currentPassword: 'changed-password' } }),
    value => confirmEmailChange({ db, config, user, body: { code: value } }),
    () => db.prepare('SELECT attempts FROM email_change_tokens WHERE user_id=?').get(user.id));
  assert.equal((await db.prepare('SELECT email FROM users WHERE id=?').get(user.id)).email, nextEmail);

  // Independent readers must not observe a refresh's temporary deleted usage.
  const stream = await tenantProxyInternals.saveResource(db, 'streams', `atomic-${suffix}`, user.id);
  await tenantProxyInternals.syncStreamPorts(db, stream, { listen: [{ port: 8443 }] });
  const deleted = Promise.withResolvers(); const resume = Promise.withResolvers();
  const intercepted = Object.create(db);
  intercepted.transaction = callback => db.transaction(transaction => callback({
    prepare(sql) {
      const statement = transaction.prepare(sql);
      if (!sql.startsWith('DELETE FROM stream_ports')) return statement;
      return { run: async (...args) => { const result = await statement.run(...args); deleted.resolve(); await resume.promise; return result; } };
    },
  }));
  const refresh = tenantProxyInternals.syncStreamPorts(intercepted, stream, { listen: [{ port: 8443 }] });
  await deleted.promise;
  try {
    await withResourceMutation(db, user.id, async () => {
      const usage = await db.prepare('SELECT COUNT(*) AS count FROM stream_ports WHERE resource_id=?').get(stream);
      assert.equal(usage.count, 1);
      await assert.rejects(() => withResourceMutation(db, user.id, () => assert.fail('concurrent mutation admitted')), { status: 409 });
    });
  } finally { resume.resolve(); await refresh; }
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM stream_ports WHERE resource_id=?').get(stream)).count, 1);

  const allLocked = Promise.withResolvers(); const releaseLocks = Promise.withResolvers(); let entered = 0;
  const mutations = Array.from({ length: 12 }, (_, index) => db.withAdvisoryLock(`pool-test:${suffix}:${index}`, async () => {
    if (++entered === 12) allLocked.resolve();
    await releaseLocks.promise;
    return (await db.prepare('SELECT 1 AS value').get()).value;
  }));
  await allLocked.promise;
  try {
    assert.equal((await db.prepare('SELECT 1 AS value').get()).value, 1);
    assert.equal((await db.withAdvisoryLock(`pool-overflow:${suffix}`, () => assert.fail('overflow admitted'))).acquired, false);
  } finally { releaseLocks.resolve(); }
  assert.ok((await Promise.all(mutations)).every(result => result.acquired && result.value === 1));
});
