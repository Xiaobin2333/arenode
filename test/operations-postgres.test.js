import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresDatabase } from '../src/db.js';
import { acquireOperationsLease } from '../src/operations-lease.js';
import { OperationsService } from '../src/operations-service.js';
import { S3Backups } from '../src/s3-backups.js';
import { operationDefaults, saveOperationSettings } from '../src/operations-settings.js';
import { hashPassword } from '../src/security.js';

test('PostgreSQL 18 encrypted backup, transactional rollback, in-place restore and instance fencing', { skip: !process.env.OPERATIONS_TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.OPERATIONS_TEST_DATABASE_URL }); await admin.connect();
  const name = `operations_test_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.OPERATIONS_TEST_DATABASE_URL); url.pathname = `/${name}`;
  let db; let lease; let second;
  try {
    db = await createPostgresDatabase(url.href);
    lease = await acquireOperationsLease(url.href); second = await acquireOperationsLease(url.href);
    assert.equal(await lease.exclusive(), false);
    await second.close(); second = null; assert.equal(await lease.exclusive(), true);
    let started = false;
    const pending = acquireOperationsLease(url.href).then(value => { started = true; return value; });
    await delay(100); assert.equal(started, false);
    await lease.releaseExclusive(); second = await pending; await second.close(); second = null;
    const userId = (await db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run('before_restore', hashPassword('test-password'), 'admin')).lastInsertRowid;
    await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run('old-session', userId, new Date(Date.now() + 86400000).toISOString());
    const config = { databaseUrl: url.href, settingsEncryptionKey: 'isolated-postgres-backup-test-encryption-key' };
    const settings = { ...operationDefaults.backup, bucket: 'test-bucket', accessKeyId: 'test', secretAccessKey: 'test' };
    await saveOperationSettings(db, config, 'backup', settings, userId);
    const objects = new Map();
    const client = { send: async command => {
      const { Key, Body } = command.input;
      if (command.constructor.name === 'PutObjectCommand') { objects.set(Key, Buffer.from(Body)); return {}; }
      if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([objects.get(Key)]) };
      if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].map(Key => ({ Key })) };
      if (command.constructor.name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
      throw Error('unsupported');
    } };
    const backups = new S3Backups(config, { clientFactory: () => client, upload: async ({ params }) => {
      const chunks = []; for await (const chunk of params.Body) chunks.push(chunk); objects.set(params.Key, Buffer.concat(chunks));
    } });
    const snapshot = await backups.backup(settings);
    await db.prepare('UPDATE users SET username=? WHERE id=?').run('after_snapshot', userId);
    // A dependent object absent from the archive makes --clean fail. The entire
    // restore transaction must roll back, including previously dropped objects.
    await db.exec('CREATE VIEW restore_blocker AS SELECT id FROM users');
    await assert.rejects(backups.withDownloaded(settings, snapshot.id, dump => backups.restore(dump)), /pg_restore/);
    assert.equal((await db.prepare('SELECT username FROM users WHERE id=?').get(userId)).username, 'after_snapshot');
    assert.ok(await db.prepare('SELECT token_hash FROM sessions').get());
    await db.exec('DROP VIEW restore_blocker');
    let restarted = false; let invalidated = false;
    const service = new OperationsService({ db, config, backups, lease, billing: { scheduler: {} }, cache: { invalidate: async () => { invalidated = true; } }, restart: () => { restarted = true; } });
    const jobId = crypto.randomUUID();
    await service.restore({ id: jobId, actor_id: userId }, snapshot.id);
    assert.equal((await db.prepare('SELECT username FROM users WHERE id=?').get(userId)).username, 'before_restore');
    assert.equal((await db.prepare('SELECT * FROM sessions').all()).length, 0);
    const job = await db.prepare('SELECT * FROM operations_jobs WHERE id=?').get(jobId);
    assert.equal(job.status, 'succeeded'); assert.ok(JSON.parse(job.result).preRestoreBackupId);
    assert.equal((await backups.list(settings)).filter(item => item.reason === 'pre_restore').length, 1);
    assert.equal(invalidated, true); assert.equal(service.restoring, true);
    await delay(1100); assert.equal(restarted, true);
  } finally {
    await second?.close(); await lease?.close(); await db?.close();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
  }
});
