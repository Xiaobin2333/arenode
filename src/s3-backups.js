import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { opError } from './operations-settings.js';

export function postgresEnvironment(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw opError('备份仅支持 PostgreSQL');
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer', PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'arenode-backup' };
}
export async function runPostgres(command, args, env, { timeoutMs = 30 * 60_000, maxFile = null, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let failure;
    const abort = message => { failure = opError(message, 502); child.kill('SIGKILL'); };
    const timeout = setTimeout(() => abort(`${command} 执行超时`), timeoutMs);
    const sizeTimer = maxFile ? setInterval(() => { void stat(maxFile).then(s => { if (s.size > maxBytes) abort('备份超过配置大小限制'); }).catch(() => {}); }, 1000) : null;
    child.stdout.on('data', data => { if (output.length < 4 * 1024 * 1024) output += data.toString(); });
    // Do not expose connection details or database contents in errors.
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timeout); clearInterval(sizeTimer); reject(opError(`${command} 不可用，请检查 PostgreSQL 客户端安装`, 503)); });
    child.once('close', code => { clearTimeout(timeout); clearInterval(sizeTimer); if (failure || code !== 0) reject(failure || opError(`${command} 失败，请检查数据库权限、客户端版本及磁盘空间`, 502)); else resolve(output); });
  });
}
function limiter(maxBytes, hash = null) {
  let size = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) callback(opError('备份超过配置大小限制'));
    else { hash?.update(chunk); callback(null, chunk); }
  } });
}
export class S3Backups {
  constructor(config, { clientFactory, run = runPostgres, upload = options => new Upload(options).done() } = {}) {
    this.config = config; this.run = run;
    this.upload = upload;
    this.clientFactory = clientFactory || (settings => new S3Client({ endpoint: settings.endpoint || undefined, region: settings.region,
      forcePathStyle: settings.forcePathStyle, maxAttempts: 2,
      requestHandler: { requestTimeout: 120000, connectionTimeout: 15000 },
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey } }));
  }
  key(purpose) {
    if (!this.config.settingsEncryptionKey) throw opError('需配置并离线保管 SETTINGS_ENCRYPTION_KEY', 503);
    return crypto.createHmac('sha256', this.config.settingsEncryptionKey).update(`arenode-backup:${purpose}:v1`).digest();
  }
  sign(manifest) { return crypto.createHmac('sha256', this.key('manifest')).update(JSON.stringify(manifest)).digest('hex'); }
  verify(document, settings) {
    const { signature, ...manifest } = document;
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || !crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(manifest), 'hex'))) throw opError('备份清单签名不匹配（请检查加密密钥）');
    if (manifest.version !== 1 || !/^[a-f0-9-]{36}$/.test(manifest.id) || manifest.objectKey !== `${settings.prefix}${manifest.id}.bin`
      || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)
      || Buffer.from(manifest.iv || '', 'base64').length !== 12 || Buffer.from(manifest.tag || '', 'base64').length !== 16
      || !Number.isFinite(Date.parse(manifest.createdAt))) throw opError('备份清单格式无效');
    return manifest;
  }
  async use(settings, callback) {
    if (!settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) throw opError('请先配置 S3 备份');
    const client = this.clientFactory(settings);
    try { return await callback(client); } finally { client.destroy?.(); }
  }
  async readManifest(client, settings, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw opError('备份 ID 无效');
    const response = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: `${settings.prefix}${id}.json` }));
    const chunks = []; let size = 0;
    for await (const chunk of response.Body) { size += chunk.length; if (size > 16384) { response.Body.destroy?.(); throw opError('备份清单过大'); } chunks.push(Buffer.from(chunk)); }
    const manifest = this.verify(JSON.parse(Buffer.concat(chunks).toString('utf8')), settings);
    if (manifest.id !== id) throw opError('备份 ID 与清单不一致');
    return manifest;
  }
  async list(settings) {
    return this.use(settings, async client => {
      let token; const items = []; let scanned = 0;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: settings.prefix, ContinuationToken: token, MaxKeys: 1000 }));
        for (const item of page.Contents || []) {
          if (++scanned > 10000) throw opError('前缀下对象过多，请使用专用备份前缀');
          const name = item.Key.slice(settings.prefix.length);
          if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
          items.push(await this.readManifest(client, settings, name.slice(0, -5)));
        }
        token = page.IsTruncated ? page.NextContinuationToken : null;
      } while (token);
      return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    });
  }
  async test(settings) { return this.use(settings, async client => { await client.send(new HeadBucketCommand({ Bucket: settings.bucket })); return { ok: true }; }); }
  async remove(settings, id) {
    return this.use(settings, async client => {
      const manifest = await this.readManifest(client, settings, id);
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: manifest.objectKey }));
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: `${settings.prefix}${id}.json` }));
    });
  }
  async backup(settings, { reason = 'manual', protectedIds = [] } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arenode-backup-')); const dump = path.join(dir, 'database.dump'); const encrypted = path.join(dir, 'database.enc');
    const maxBytes = settings.maxBackupMb * 1024 * 1024;
    try {
      const version = await this.run('pg_dump', ['--version'], postgresEnvironment(this.config.databaseUrl));
      await this.run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump], postgresEnvironment(this.config.databaseUrl), { maxFile: dump, maxBytes });
      const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', this.key('data'), iv); const hash = crypto.createHash('sha256');
      await pipeline(createReadStream(dump), cipher, limiter(maxBytes, hash), createWriteStream(encrypted, { mode: 0o600 }));
      const id = crypto.randomUUID();
      const manifest = { version: 1, id, objectKey: `${settings.prefix}${id}.bin`, createdAt: new Date().toISOString(), reason,
        size: (await stat(encrypted)).size, sha256: hash.digest('hex'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), postgres: version.trim() };
      await this.use(settings, async client => {
        await this.upload({ client, params: { Bucket: settings.bucket, Key: manifest.objectKey, Body: createReadStream(encrypted), ContentType: 'application/octet-stream' }, queueSize: 2, leavePartsOnError: false });
        await client.send(new PutObjectCommand({ Bucket: settings.bucket, Key: `${settings.prefix}${id}.json`, Body: JSON.stringify({ ...manifest, signature: this.sign(manifest) }), ContentType: 'application/json' }));
      });
      let retentionError = null;
      try {
        const items = await this.list(settings);
        for (const item of items.filter(item => item.reason !== 'pre_restore').slice(settings.retention)) if (!protectedIds.includes(item.id) && item.id !== id) await this.remove(settings, item.id);
      } catch { retentionError = '备份已完成，但保留策略清理失败，请检查 S3 删除权限或对象锁'; }
      return { ...manifest, retentionError };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async withDownloaded(settings, id, callback) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arenode-restore-')); const encrypted = path.join(dir, 'database.enc'); const dump = path.join(dir, 'database.dump');
    try {
      const manifest = await this.use(settings, async client => {
        const item = await this.readManifest(client, settings, id);
        if (item.size > settings.maxBackupMb * 1024 * 1024) throw opError('备份超过当前大小限制');
        const response = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: item.objectKey })); const hash = crypto.createHash('sha256');
        await pipeline(response.Body, limiter(item.size, hash), createWriteStream(encrypted, { mode: 0o600 }));
        if ((await stat(encrypted)).size !== item.size || hash.digest('hex') !== item.sha256) throw opError('备份大小或 SHA-256 校验失败');
        return item;
      });
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key('data'), Buffer.from(manifest.iv, 'base64')); decipher.setAuthTag(Buffer.from(manifest.tag, 'base64'));
      await pipeline(createReadStream(encrypted), decipher, createWriteStream(dump, { mode: 0o600 }));
      await this.run('pg_restore', ['--list', dump], postgresEnvironment(this.config.databaseUrl));
      return await callback(dump, manifest);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async restore(dump) {
    const env = postgresEnvironment(this.config.databaseUrl);
    await this.run('pg_restore', ['--exit-on-error', '--single-transaction', '--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', env.PGDATABASE, dump], env);
  }
}
