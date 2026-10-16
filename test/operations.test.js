import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { operationDefaults, operationSettings, saveOperationSettings } from '../src/operations-settings.js';
import { S3Backups } from '../src/s3-backups.js';
import { SiteInspection, validateVerdict, assertNoPolicyHold, classifyPages } from '../src/site-inspection.js';
import { fetchPublicPage, publicAddress } from '../src/inspection-fetch.js';
import { OperationsService } from '../src/operations-service.js';
import { handleOperationsApi } from '../src/operations-api.js';
import { handleTenantProxy } from '../src/tenant-proxy.js';
import { handleAdminApi } from '../src/admin-api.js';
import { BillingService } from '../src/billing.js';
import { CacheService } from '../src/cache.js';

const config = { settingsEncryptionKey: 'test-operations-encryption-key-not-for-production', databaseUrl: 'postgresql://test:password@localhost/test' };
const settings = { ...operationDefaults.backup, bucket: 'test-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key', retention: 2 };
function fixture(t) {
  const db = createDatabase(); t.after(() => db.close());
  const id = Number(db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run('operator', hashPassword('test-password'), 'admin').lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  return { db, user };
}
function fakeStorage(run) {
  const objects = new Map();
  const client = { send: async command => {
    const { Key, Body } = command.input;
    switch (command.constructor.name) {
      case 'PutObjectCommand': objects.set(Key, Buffer.from(Body)); return {};
      case 'GetObjectCommand': if (!objects.has(Key)) throw Error('missing'); return { Body: Readable.from([objects.get(Key)]) };
      case 'ListObjectsV2Command': return { Contents: [...objects.keys()].map(Key => ({ Key })) };
      case 'DeleteObjectCommand': objects.delete(Key); return {};
      case 'HeadBucketCommand': return {};
      default: throw Error('unknown');
    }
  } };
  const backups = new S3Backups(config, { clientFactory: () => client,
    run: run || (async (command, args) => {
      if (args[0] === '--version') return 'pg_dump (PostgreSQL) 18.6';
      if (command === 'pg_dump') await writeFile(args[args.indexOf('--file') + 1], 'private database contents');
      return '';
    }),
    upload: async ({ params }) => { const chunks = []; for await (const chunk of params.Body) chunks.push(chunk); objects.set(params.Key, Buffer.concat(chunks)); },
  });
  return { backups, objects };
}

test('operations settings encrypt secrets, mask responses and validate policy', async t => {
  const { db, user } = fixture(t);
  assert.equal((await operationSettings(db, config, 'inspection')).autoDisable, false);
  assert.equal((await operationSettings(db, config, 'inspection')).threshold, .9);
  const saved = await saveOperationSettings(db, config, 'backup', settings, user.id);
  assert.equal(saved.secretAccessKey, ''); assert.equal(saved.secretAccessKeyConfigured, true);
  assert.ok(!db.prepare('SELECT value FROM app_settings WHERE key=?').get('operations:backup').value.includes('secret-key'));
  await saveOperationSettings(db, config, 'backup', { secretAccessKey: '', retention: 3 }, user.id);
  assert.equal((await operationSettings(db, config, 'backup', true)).secretAccessKey, 'secret-key');
  await assert.rejects(saveOperationSettings(db, config, 'backup', { endpoint: 'http://example.com' }, user.id), /HTTPS/);
  await assert.rejects(saveOperationSettings(db, config, 'backup', { retention: 0 }, user.id), /retention/);
});

test('S3 encrypted roundtrip, signature/hash verification and retention preserve pre-restore backups', async () => {
  const { backups, objects } = fakeStorage();
  const first = await backups.backup(settings);
  assert.ok(!objects.get(first.objectKey).includes(Buffer.from('private database')));
  await backups.withDownloaded(settings, first.id, async dump => assert.equal(await readFile(dump, 'utf8'), 'private database contents'));
  const original = objects.get(first.objectKey); objects.set(first.objectKey, Buffer.alloc(original.length));
  await assert.rejects(backups.withDownloaded(settings, first.id, () => assert.fail('unverified dump')), /校验/);
  objects.set(first.objectKey, original);
  const manifestKey = `${settings.prefix}${first.id}.json`; const manifest = objects.get(manifestKey);
  objects.set(manifestKey, Buffer.from(manifest.toString().replace('manual', 'tamper')));
  await assert.rejects(backups.list(settings), /签名/); objects.set(manifestKey, manifest);
  const safety = await backups.backup(settings, { reason: 'pre_restore' });
  await backups.backup(settings); await backups.backup(settings);
  const list = await backups.list(settings);
  assert.equal(list.filter(item => item.reason !== 'pre_restore').length, 2);
  assert.ok(list.some(item => item.id === safety.id));
  await backups.remove(settings, safety.id); assert.equal((await backups.list(settings)).length, 2);
});

test('inspection fetch rejects private, mapped, mixed DNS, credentials and nonstandard ports before connecting', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '0.0.0.0']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  await assert.rejects(fetchPublicPage('http://127.0.0.1'), /非公网/);
  await assert.rejects(fetchPublicPage('https://example.com', { resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /非公网/);
  await assert.rejects(fetchPublicPage('https://user:password@example.com'), /标准端口/);
  await assert.rejects(fetchPublicPage('https://example.com:8080'), /标准端口/);
});

const pages = [{ url: 'https://example.com/', title: 'Example', text: '赌博网站的示例原文，仅用于测试审核证据与边界。', links: [] }];
test('page fetch pins DNS, rechecks redirects, bounds content and DNS time', async () => {
  const resolve = async () => [{ address: '1.1.1.1', family: 4 }];
  const transport = (body, statusCode = 200, headers = {}) => (_url, options, callback) => {
    options.lookup('example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.equal(addresses[0].address, '1.1.1.1'); });
    assert.equal(options.agent, false); assert.equal(options.headers.authorization, undefined);
    const req = new EventEmitter(); req.destroy = error => { req.emit('error', error); req.emit('close'); };
    queueMicrotask(() => { const res = Readable.from([Buffer.from(body)]); res.statusCode = statusCode; res.headers = { 'content-type': 'text/html', ...headers }; res.on('close', () => req.emit('close')); callback(res); });
    return req;
  };
  const page = await fetchPublicPage('https://example.com', { resolve, get: transport('<html><title>Page</title><body>This is sufficiently long visible text for the website inspection.<script>hidden payload</script><a href="/next">Next</a></body></html>') });
  assert.ok(!page.text.includes('hidden payload')); assert.deepEqual(page.links, ['https://example.com/next']);
  await assert.rejects(fetchPublicPage('https://example.com', { resolve, get: transport('', 302, { location: 'http://169.254.169.254/latest' }) }), /非公网/);
  await assert.rejects(fetchPublicPage('https://example.com', { resolve, get: transport('a'.repeat(100)), maxBytes: 50 }), /大小/);
  await assert.rejects(fetchPublicPage('https://example.com', { resolve: () => new Promise(() => {}), timeoutMs: 10 }), /DNS/);
});
const verdict = { category: 'gambling', confidence: .95, reason: '涉嫌赌博', evidence: [{ url: pages[0].url, quote: '赌博网站的示例原文' }] };
test('AI requires grounded evidence and rejects malformed, truncated and refused responses', async () => {
  assert.deepEqual(validateVerdict(verdict, pages), verdict);
  for (const change of [{ category: 'unknown' }, { confidence: 2 }, { evidence: [] }, { evidence: [{ url: pages[0].url, quote: '不存在的原文' }] }]) assert.throws(() => validateVerdict({ ...verdict, ...change }, pages));
  const aiSettings = { baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'test' };
  await assert.rejects(classifyPages(aiSettings, pages, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })), /未完成/);
  const result = await classifyPages(aiSettings, pages, async (url, options) => {
    assert.equal(url, 'https://example.com/v1/chat/completions'); assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).response_format.type, 'json_object');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict) } }] });
  }); assert.equal(result.category, 'gambling');
});

function siteFixture(t) {
  const { db, user } = fixture(t);
  const siteId = Number(db.prepare('INSERT INTO sites (owner_id,domain,origin,upstream_id) VALUES (?,?,?,?)').run(user.id, 'example.com', '1.1.1.1', 'upstream-1').lastInsertRowid);
  const calls = []; const cdnfly = { updateSite: async (...args) => calls.push(args) };
  const service = new SiteInspection({ db, cdnfly, fetchPage: async () => pages[0], classify: async () => verdict });
  return { db, user, siteId, calls, service, cdnfly };
}
test('manual review default, threshold auto-disable, holds block tenant/admin writes and quota recovery', async t => {
  const { db, user, siteId, calls, service, cdnfly } = siteFixture(t);
  const policy = { ...operationDefaults.inspection, baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test' };
  await service.run('job-1', policy, siteId); assert.equal(calls.length, 0);
  const review = db.prepare('SELECT id FROM site_inspections WHERE job_id=?').get('job-1');
  await service.action(siteId, review.id, 'approve', '人工核查为教育页面', user.id);
  assert.equal(db.prepare('SELECT status FROM site_inspections WHERE id=?').get(review.id).status, 'reviewed');
  assert.equal(calls.length, 0);
  await service.run('job-2', { ...policy, autoDisable: true, threshold: .99 }, siteId); assert.equal(calls.length, 0);
  await service.run('job-3', { ...policy, autoDisable: true }, siteId); assert.equal(calls.length, 1);
  await assert.rejects(assertNoPolicyHold(db, [siteId]), /隔离/);
  await assert.rejects(handleTenantProxy({ req: { method: 'PUT' }, url: new URL(`http://localhost/api/cdnfly/v1/sites/${siteId}`), user: { ...user, role: 'user' }, db, cdnfly, readBody: async () => ({ enable: 1 }) }), /隔离/);
  await assert.rejects(handleTenantProxy({ req: { method: 'PUT' }, url: new URL('http://localhost/api/cdnfly/v1/sites'), user: { ...user, role: 'user' }, db, cdnfly, readBody: async () => [{ id: siteId, enable: 1 }] }), /隔离/);
  await assert.rejects(handleAdminApi({ req: { method: 'PUT' }, url: new URL(`http://localhost/api/admin/sites/${siteId}`), user, db, cdnfly, readBody: async () => ({ enabled: true }) }), /隔离/);
  db.prepare("INSERT INTO quota_suspensions (user_id,resource_kind,resource_id,reason) VALUES (?,'site',?,'quota')").run(user.id, siteId);
  const billing = new BillingService(db, cdnfly); await billing.restore(user.id); assert.equal(calls.length, 1);
  const row = db.prepare('SELECT * FROM site_inspections WHERE job_id=?').get('job-3');
  await service.action(siteId, row.id, 'enable', '人工确认误报', user.id);
  assert.equal(calls.at(-1)[1].enabled, true); await assertNoPolicyHold(db, [siteId]);
});

test('failed upstream disable keeps hold; failed fetch is never classified clean', async t => {
  const { db, siteId, service } = siteFixture(t);
  service.cdnfly.updateSite = async () => { throw Error('upstream failed'); };
  await service.run('job', { ...operationDefaults.inspection, baseUrl: 'https://example.com', model: 'test', apiKey: 'test', autoDisable: true }, siteId);
  assert.equal(db.prepare('SELECT status FROM site_policy_holds WHERE site_id=?').get(siteId).status, 'disable_failed');
  service.fetchPage = async () => { throw Error('unreadable'); };
  await service.run('job-failed', { ...operationDefaults.inspection, baseUrl: 'https://example.com', model: 'test', apiKey: 'test' }, siteId);
  assert.equal(db.prepare('SELECT status FROM site_inspections WHERE job_id=?').get('job-failed').status, 'error');
});

test('operations API restricts privileges, reauthenticates overwrite and never queues passwords', async t => {
  const { db, user } = fixture(t); const queued = [];
  const operations = { enqueue: async (...args) => { queued.push(args); return { id: crypto.randomUUID() }; } };
  const id = crypto.randomUUID(); let body = { backupId: id, confirmation: `RESTORE ${id}`, currentPassword: 'wrong' };
  const options = { req: { method: 'POST' }, url: new URL('http://localhost/api/admin/operations/restore'), db, config, operations, user, readBody: async () => body };
  await assert.rejects(handleOperationsApi({ ...options, user: { ...user, role: 'user' } }), /超级管理员/);
  await assert.rejects(handleOperationsApi({ ...options, user: { ...user, admin_role: 'operator' } }), /超级管理员/);
  await assert.rejects(handleOperationsApi(options), /密码/); assert.equal(queued.length, 0);
  body.currentPassword = 'test-password'; assert.equal((await handleOperationsApi(options)).status, 202);
  assert.deepEqual(queued[0][1], { backupId: id });
});

test('durable worker executes queued work once and schedules at interval', async t => {
  const { db, user } = fixture(t); let count = 0;
  await saveOperationSettings(db, config, 'backup', { ...settings, scheduled: true }, user.id);
  const service = new OperationsService({ db, config, backups: { backup: async () => ({ count: ++count }) } });
  await Promise.all([service.tick(), service.tick()]); await service.tick(); assert.equal(count, 1);
  const jobs = db.prepare('SELECT * FROM operations_jobs').all(); assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'succeeded');
});

test('overwrite restore refuses multiple instances and resumes after transactional failure', async t => {
  const { db } = fixture(t); let restored = false; let exclusive = false; let release = 0;
  const order = []; const billing = { scheduler: {}, paused: false };
  const backups = { withDownloaded: async (_s, _id, callback) => callback('/test.dump'), backup: async (_s, options) => { order.push(options.reason); return { id: 'before' }; }, restore: async () => { restored = true; throw Error('transaction rolled back'); } };
  const service = new OperationsService({ db, config, billing, backups, lease: { exclusive: async () => exclusive, releaseExclusive: async () => release++ }, restart: () => {} });
  await assert.rejects(service.restore({ id: 'job' }, 'source'), /单实例/); assert.equal(restored, false);
  exclusive = true;
  await assert.rejects(service.restore({ id: 'job' }, 'source'), /rolled back/);
  assert.deepEqual(order, ['pre_restore']); assert.equal(release, 1); assert.equal(service.restoring, false); assert.equal(billing.paused, false);
});

test('overwrite fails closed when safety backup fails', async t => {
  const { db } = fixture(t);
  const service = new OperationsService({ db, config, backups: { withDownloaded: async (_s, _id, callback) => callback('/test.dump'), backup: async () => { throw Error('S3 unavailable'); }, restore: async () => assert.fail('must not restore') }, lease: { exclusive: async () => true, releaseExclusive: async () => {} }, restart: () => {} });
  await assert.rejects(service.restore({ id: 'job' }, 'source'), /S3 unavailable/); assert.equal(service.restoring, false);
});

test('a full queue does not prevent worker from draining when a schedule becomes due', async t => {
  const { db, user } = fixture(t); let inspected = 0;
  await saveOperationSettings(db, config, 'backup', { ...settings, scheduled: true }, user.id);
  const service = new OperationsService({ db, config, inspection: { run: async () => ({ count: ++inspected }) } });
  for (let i = 0; i < 10; i++) await service.enqueue('inspection');
  await service.tick(); assert.equal(inspected, 1);
  assert.equal(db.prepare("SELECT * FROM operations_jobs WHERE status='queued'").all().length, 9);
});

test('restore waits for in-flight requests before creating safety backup', async t => {
  const { db } = fixture(t); let backedUp = false;
  const service = new OperationsService({ db, config, backups: { withDownloaded: async (_s, _id, callback) => callback('/test.dump'), backup: async () => { backedUp = true; throw Error('stop after drain'); } }, lease: { exclusive: async () => true, releaseExclusive: async () => {} }, restart: () => {} });
  service.inflight = 1;
  const pending = assert.rejects(service.restore({ id: 'job' }, 'source'), /stop after drain/);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(backedUp, false); assert.equal(service.restoring, true);
  service.inflight = 0; await pending; assert.equal(backedUp, true);
});

test('cache invalidation is retried after Redis recovers', async () => {
  let generation = 10;
  const cache = new CacheService({}, { on() {}, incr: async () => ++generation, get: async () => String(generation) });
  await cache.invalidate(); assert.equal(cache.pendingInvalidation, true);
  cache.connected = true; assert.equal(await cache.currentGeneration(), 11); assert.equal(cache.pendingInvalidation, false);
  assert.equal(await cache.currentGeneration(), 11);
});

test('real AWS SDK upload, signed requests, list and download roundtrip against an isolated S3 HTTP fixture', async t => {
  const objects = new Map(); let signed = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization?.startsWith('AWS4-HMAC-SHA256')) signed++;
    const url = new URL(req.url, 'http://localhost'); const key = decodeURIComponent(url.pathname.replace('/test-bucket/', ''));
    if (req.method === 'GET' && url.searchParams.has('list-type')) {
      res.setHeader('content-type', 'application/xml');
      res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects.keys()].map(Key => `<Contents><Key>${Key}</Key></Contents>`).join('')}</ListBucketResult>`); return;
    }
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks); objects.set(key, body);
      res.setHeader('ETag', `"${crypto.createHash('md5').update(body).digest('hex')}"`); res.end(); return;
    }
    if (req.method === 'GET' && objects.has(key)) { res.setHeader('content-length', objects.get(key).length); res.end(objects.get(key)); return; }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const backups = new S3Backups(config, { run: async (command, args) => {
    if (args[0] === '--version') return 'pg_dump 18.6';
    if (command === 'pg_dump') await writeFile(args[args.indexOf('--file') + 1], 'actual SDK encrypted roundtrip');
    return '';
  } });
  const local = { ...settings, endpoint: `http://127.0.0.1:${server.address().port}` };
  const saved = await backups.backup(local);
  await backups.withDownloaded(local, saved.id, async dump => assert.equal(await readFile(dump, 'utf8'), 'actual SDK encrypted roundtrip'));
  assert.equal((await backups.list(local)).length, 1); assert.ok(signed >= 6);
  await backups.remove(local, saved.id); assert.equal(objects.size, 0);
});
