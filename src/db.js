import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword, normalizeUsername } from './security.js';
import { BRAND_NAME, BRAND_SUBTITLE } from './brand.js';

const require = createRequire(import.meta.url);
const SCHEMA = fs.readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
const ID_TABLES = new Set([
  'users', 'sites', 'audit_logs', 'tenant_resources', 'package_groups', 'plans',
  'upstream_accounts', 'upstream_packages',
  'plan_upgrades', 'subscriptions', 'traffic_packages', 'user_traffic_packages',
  'orders', 'quota_suspensions', 'redemption_codes', 'redemption_uses',
  'wallet_transactions', 'recharge_codes', 'recharge_code_uses', 'recharge_code_batches',
  'registration_invites', 'user_configs', 'user_api_keys',
  'customer_site_groups', 'customer_stream_groups', 'upstream_customer_groups', 'upstream_customer_group_history',
  'monitor_documents',
]);

pg.types.setTypeParser(pg.types.builtins.INT8, value => Number(value));

function postgresSql(source, { returningId = false } = {}) {
  let index = 0;
  let sql = source.replace(/\?/g, () => `$${++index}`)
    .replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ');
  if (/^\s*INSERT\s+OR\s+IGNORE\s+/i.test(source) && !/\bON\s+CONFLICT\b/i.test(sql)) sql += ' ON CONFLICT DO NOTHING';
  const table = sql.match(/^\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i)?.[1]?.toLowerCase();
  if (returningId && table && ID_TABLES.has(table) && !/\bRETURNING\b/i.test(sql)) sql += ' RETURNING id';
  return sql;
}

function resultShape(result) {
  return {
    changes: result.rowCount || 0,
    lastInsertRowid: result.rows?.[0]?.id,
  };
}

class AsyncStatement {
  constructor(executor, sql) {
    this.executor = executor;
    this.sql = sql;
  }

  async get(...params) {
    const result = await this.executor.query(postgresSql(this.sql), params);
    return result.rows[0];
  }

  async all(...params) {
    const result = await this.executor.query(postgresSql(this.sql), params);
    return result.rows;
  }

  async run(...params) {
    const result = await this.executor.query(postgresSql(this.sql, { returningId: true }), params);
    return resultShape(result);
  }
}

class PostgresDatabase {
  constructor(pool, executor = pool) {
    this.pool = pool;
    this.executor = executor;
    this.isMemory = false;
  }

  prepare(sql) {
    return new AsyncStatement(this.executor, sql);
  }

  async exec(sql) {
    return this.executor.query(sql.replace(/BEGIN\s+IMMEDIATE/gi, 'BEGIN'));
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    const scoped = new PostgresDatabase(this.pool, client);
    try {
      await client.query('BEGIN');
      const result = await callback(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    await this.executor.query('SELECT 1');
    return true;
  }

  async withAdvisoryLock(key, callback) {
    const client = await this.pool.connect();
    try {
      const locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [String(key)])).rows[0]?.locked;
      if (!locked) return { acquired: false, value: null };
      try { return { acquired: true, value: await callback() }; }
      finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [String(key)]); }
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class MemoryStatement {
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
  }

  get(...params) {
    return this.client.querySync(postgresSql(this.sql), params)[0];
  }

  all(...params) {
    return this.client.querySync(postgresSql(this.sql), params);
  }

  run(...params) {
    const rows = this.client.querySync(postgresSql(this.sql, { returningId: true }), params);
    return { changes: rows.length, lastInsertRowid: rows[0]?.id };
  }
}

class MemoryPostgresDatabase {
  constructor(client) {
    this.client = client;
    this.isMemory = true;
    this.locks = new Set();
  }

  prepare(sql) {
    return new MemoryStatement(this.client, sql);
  }

  exec(sql) {
    this.client.querySync(sql.replace(/BEGIN\s+IMMEDIATE/gi, 'BEGIN'), []);
  }

  async transaction(callback) {
    this.exec('BEGIN');
    try {
      const result = await callback(this);
      this.exec('COMMIT');
      return result;
    } catch (error) {
      this.exec('ROLLBACK');
      throw error;
    }
  }

  health() {
    return true;
  }

  async withAdvisoryLock(key, callback) {
    if (this.locks.has(key)) return { acquired: false, value: null };
    this.locks.add(key);
    try { return { acquired: true, value: await callback() }; }
    finally { this.locks.delete(key); }
  }

  close() {}
}

export function createDatabase() {
  const { newDb } = require('pg-mem');
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const NativeClient = memory.adapters.createPgNative();
  const client = new NativeClient();
  client.connectSync();
  client.querySync(SCHEMA, []);
  return new MemoryPostgresDatabase(client);
}

async function migrateCustomerSiteGroups(db) {
  const legacy = await db.prepare("SELECT id,owner_id,snapshot FROM tenant_resources WHERE kind='site-groups' ORDER BY id").all();
  for (const item of legacy) {
    let snapshot = {};
    try { snapshot = JSON.parse(item.snapshot || '{}'); } catch {}
    const name = String(snapshot.name || '').trim(); if (!name) continue;
    const description = String(snapshot.des ?? snapshot.description ?? '').trim().slice(0, 240);
    await db.prepare('INSERT INTO customer_site_groups (user_id,name,description,enabled) VALUES (?,?,?,?) ON CONFLICT(user_id,name) DO NOTHING')
      .run(item.owner_id, name.slice(0, 120), description, [0, false, '0', 'false'].includes(snapshot.enable) ? 0 : 1);
    const group = await db.prepare('SELECT id FROM customer_site_groups WHERE user_id=? AND name=?').get(item.owner_id, name.slice(0, 120));
    if (group) await db.prepare("UPDATE user_configs SET scope_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND type='site' AND scope_name='group' AND scope_id=?")
      .run(group.id, item.owner_id, item.id);
  }
}

async function migrateCustomerStreamGroups(db) {
  const legacy = await db.prepare("SELECT id,owner_id,upstream_account_id,upstream_id,snapshot FROM tenant_resources WHERE kind='stream-groups' ORDER BY id").all();
  const localByUpstream = new Map();
  for (const item of legacy) {
    let snapshot = {};
    try { snapshot = JSON.parse(item.snapshot || '{}'); } catch {}
    const name = String(snapshot.name || '').trim(); if (!name) continue;
    const description = String(snapshot.des ?? snapshot.description ?? '').trim().slice(0, 240);
    await db.prepare('INSERT INTO customer_stream_groups (user_id,name,description,enabled) VALUES (?,?,?,?) ON CONFLICT(user_id,name) DO NOTHING')
      .run(item.owner_id, name.slice(0, 120), description, [0, false, '0', 'false'].includes(snapshot.enable) ? 0 : 1);
    const group = await db.prepare('SELECT id FROM customer_stream_groups WHERE user_id=? AND name=?').get(item.owner_id, name.slice(0, 120));
    if (!group) continue;
    localByUpstream.set(`${item.owner_id}:${item.upstream_account_id || 0}:${item.upstream_id}`, Number(group.id));
    await db.prepare("UPDATE user_configs SET scope_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND type='stream' AND scope_name='group' AND scope_id=?")
      .run(group.id, item.owner_id, item.id);
  }

  const streams = await db.prepare("SELECT id,owner_id,upstream_account_id,snapshot FROM tenant_resources WHERE kind='streams' AND local_group_id IS NULL").all();
  for (const stream of streams) {
    let snapshot = {};
    try { snapshot = JSON.parse(stream.snapshot || '{}'); } catch {}
    const upstreamGroupId = String(snapshot.groups ?? snapshot.group_id ?? '').split(',').map(value => value.trim()).find(Boolean);
    if (!upstreamGroupId) continue;
    const localId = localByUpstream.get(`${stream.owner_id}:${stream.upstream_account_id || 0}:${upstreamGroupId}`);
    if (localId) await db.prepare("UPDATE tenant_resources SET local_group_id=? WHERE id=? AND kind='streams'").run(localId, stream.id);
  }
}

async function migrateBrandDefaults(db) {
  await db.prepare(`UPDATE app_settings SET value=?,updated_at=CURRENT_TIMESTAMP
    WHERE key='site_name' AND value IN ('SCDN用户中心','SCDN 用户中心','EdgeDesk','CDNFly Reseller')`).run(BRAND_NAME);
  await db.prepare(`UPDATE app_settings SET value=?,updated_at=CURRENT_TIMESTAMP
    WHERE key='site_subtitle' AND value IN ('企业商用 CDN 用户控制台','边缘交付管理平台')`).run(BRAND_SUBTITLE);
}

async function migratePlanAcquisitions(db) {
  const rows = await db.prepare("SELECT user_id,product_id,metadata FROM orders WHERE type='plan_change'").all();
  for (const row of rows) {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
    const planIds = new Set([row.product_id, metadata.fromPlanId, metadata.toPlanId]
      .map(Number).filter(Number.isInteger));
    for (const planId of planIds) {
      if (!await db.prepare('SELECT id FROM plans WHERE id=?').get(planId)) continue;
      await db.prepare(`INSERT INTO user_plan_acquisitions (user_id,plan_id) VALUES (?,?)
        ON CONFLICT(user_id,plan_id) DO NOTHING`).run(row.user_id, planId);
    }
  }
}

export async function createPostgresDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL 未配置');
  const pool = new pg.Pool({ connectionString, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000 });
  const db = new PostgresDatabase(pool);
  await db.exec(SCHEMA);
  await migratePlanAcquisitions(db);
  await migrateBrandDefaults(db);
  await migrateCustomerSiteGroups(db);
  await migrateCustomerStreamGroups(db);
  await db.health();
  return db;
}

export async function bootstrapAdmin(db, username, password) {
  const existing = await db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (existing) {
    await db.prepare("INSERT INTO admin_profiles (user_id, role_key) VALUES (?, 'super_admin') ON CONFLICT(user_id) DO NOTHING").run(existing.id);
    return false;
  }
  if (!password) return false;
  const id = (await db.prepare('INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, ?, ?)')
    .run(normalizeUsername(username), hashPassword(password), 'admin', 0)).lastInsertRowid;
  await db.prepare("INSERT INTO admin_profiles (user_id, role_key) VALUES (?, 'super_admin') ON CONFLICT(user_id) DO NOTHING").run(id);
  return true;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email || null,
    emailVerified: Boolean(user.email_verified_at),
    role: user.role,
    adminRole: user.admin_role || user.role_key || (user.role === 'admin' ? 'super_admin' : null),
    status: user.status,
    siteLimit: user.site_limit,
    createdAt: user.created_at,
  };
}

export const databaseInternals = { postgresSql, migrateBrandDefaults, migrateCustomerSiteGroups, migrateCustomerStreamGroups, migratePlanAcquisitions };
