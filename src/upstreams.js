import { CdnflyClient } from './cdnfly.js';
import { settingsInternals } from './settings.js';

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/$/, '');
  let url;
  try { url = new URL(text); } catch { throw httpError('上游 API 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw httpError('上游 API 地址无效');
  return url.toString().replace(/\/$/, '');
}

function normalizeCnameSuffix(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.$/, '');
  if (!text) return '';
  if (text.includes('/') || text.includes(':') || !text.includes('.') || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text)) {
    throw httpError('CNAME 后缀无效');
  }
  return text;
}

function publicAccount(row) {
  return {
    id: Number(row.id), name: row.name, baseUrl: row.base_url, status: row.status,
    cnameSuffix: row.cname_suffix || '',
    isDefault: Boolean(row.is_default), requestsPerMinute: Number(row.requests_per_minute),
    timeoutMs: Number(row.timeout_ms), lastHealthStatus: row.last_health_status || null,
    lastHealthError: row.last_health_error || null, lastCheckedAt: row.last_checked_at || null,
    credentialConfigured: Boolean(row.api_key_encrypted && row.api_secret_encrypted),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function packageItems(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'data', 'list', 'rows', 'packages']) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = packageItems(value); if (nested.length) return nested;
    }
  }
  return [];
}

function publicAvailablePackage(item) {
  // /v1/user-packages returns the purchased user-package instance in `id`.
  // Its `package` field is only the public base-package catalog ID and must not
  // be used for site creation.
  const packageId = item?.id ?? item?.user_package ?? item?.user_package_id;
  if (packageId === undefined || packageId === null || String(packageId).trim() === '') return null;
  const name = String(item.name ?? item.user_package_name ?? `账号套餐 ${packageId}`).trim();
  return { packageId: String(packageId), name, description: String(item.description ?? item.des ?? item.remark ?? '').trim() };
}

export class UpstreamService {
  constructor(db, config, cache, { fetchImpl = fetch, legacyClient = null } = {}) {
    this.db = db;
    this.config = config;
    this.cache = cache;
    this.fetch = fetchImpl;
    this.legacyClient = legacyClient;
    this.legacyClients = new Map();
    this.clients = new Map();
    this.healthFailures = new Map();
  }

  async initialize() {
    const count = Number((await this.db.prepare('SELECT COUNT(*) AS count FROM upstream_accounts').get()).count);
    const legacyReady = this.config.cdnflyBaseUrl && this.config.cdnflyApiKey && this.config.cdnflyApiSecret && this.config.cdnflyUserPackageId;
    if (!count && legacyReady && this.config.settingsEncryptionKey) {
      const id = Number((await this.db.prepare(`INSERT INTO upstream_accounts
        (name, base_url, api_key_encrypted, api_secret_encrypted, status, is_default, requests_per_minute, timeout_ms)
        VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`)
        .run('默认 CDNFly 上游', normalizeBaseUrl(this.config.cdnflyBaseUrl),
          settingsInternals.encryptSecret(this.config.cdnflyApiKey, this.config),
          settingsInternals.encryptSecret(this.config.cdnflyApiSecret, this.config),
          this.config.cdnflyRequestsPerMinute, this.config.upstreamTimeoutMs)).lastInsertRowid);
      await this.db.prepare(`INSERT INTO upstream_packages (upstream_id, package_id, name, enabled)
        VALUES (?, ?, ?, 1) ON CONFLICT(upstream_id, package_id) DO NOTHING`)
        .run(id, String(this.config.cdnflyUserPackageId), `上游套餐 ${this.config.cdnflyUserPackageId}`);
      await this.db.prepare('UPDATE plans SET upstream_id=?, upstream_package_id=? WHERE upstream_id IS NULL').run(id, String(this.config.cdnflyUserPackageId));
      await this.db.prepare(`UPDATE subscriptions s SET upstream_id=p.upstream_id, upstream_package_id=p.upstream_package_id
        FROM plans p WHERE p.id=s.plan_id AND s.upstream_id IS NULL`).run();
      await this.db.prepare(`UPDATE sites s SET upstream_account_id=sub.upstream_id
        FROM subscriptions sub WHERE sub.id=s.subscription_id AND s.upstream_account_id IS NULL`).run();
      await this.db.prepare(`UPDATE tenant_resources r SET upstream_account_id=sub.upstream_id
        FROM subscriptions sub WHERE sub.id=r.subscription_id AND r.upstream_account_id IS NULL`).run();
    }
    if (this.config.cdnflyCnameSuffix) {
      const suffix = normalizeCnameSuffix(this.config.cdnflyCnameSuffix);
      await this.db.prepare("UPDATE upstream_accounts SET cname_suffix=? WHERE is_default=1 AND (cname_suffix IS NULL OR cname_suffix='')").run(suffix);
    }
    return this;
  }

  async rows({ includeDisabled = true } = {}) {
    return this.db.prepare(`SELECT * FROM upstream_accounts ${includeDisabled ? '' : "WHERE status='active'"} ORDER BY is_default DESC, id`).all();
  }

  async list() {
    const accounts = await this.rows();
    const packages = await this.db.prepare('SELECT * FROM upstream_packages ORDER BY upstream_id, id').all();
    return Promise.all(accounts.map(async row => {
      // Keep the CDNFly account shared, while exposing the local customer
      // ownership that determines which subscription/site uses it. CDNFly's
      // API does not provide reseller-side customer groups for this account.
      const customerMap = new Map();
      const ensureCustomer = item => {
        const id = Number(item.id ?? item.user_id);
        if (!customerMap.has(id)) customerMap.set(id, { id, username: item.username, subscriptionCount: 0, siteCount: 0, resourceCount: 0 });
        return customerMap.get(id);
      };
      const subscriptions = await this.db.prepare(`SELECT u.id, u.username, COUNT(*) AS count
        FROM subscriptions s JOIN users u ON u.id=s.user_id
        WHERE u.role='user' AND s.upstream_id=? GROUP BY u.id, u.username ORDER BY u.username`).all(Number(row.id));
      const sites = await this.db.prepare(`SELECT u.id, u.username, COUNT(*) AS count
        FROM sites s JOIN users u ON u.id=s.owner_id
        WHERE u.role='user' AND s.upstream_account_id=? GROUP BY u.id, u.username ORDER BY u.username`).all(Number(row.id));
      const resources = await this.db.prepare(`SELECT u.id, u.username, COUNT(*) AS count
        FROM tenant_resources r JOIN users u ON u.id=r.owner_id
        WHERE u.role='user' AND r.upstream_account_id=? GROUP BY u.id, u.username ORDER BY u.username`).all(Number(row.id));
      for (const item of subscriptions) ensureCustomer(item).subscriptionCount = Number(item.count);
      for (const item of sites) ensureCustomer(item).siteCount = Number(item.count);
      for (const item of resources) ensureCustomer(item).resourceCount = Number(item.count);
      const customers = [...customerMap.values()].sort((a, b) => a.username.localeCompare(b.username));
      const ownedSites = await this.db.prepare('SELECT COUNT(*) AS count FROM sites WHERE upstream_account_id=?').get(Number(row.id));
      const ownedResources = await this.db.prepare('SELECT COUNT(*) AS count FROM tenant_resources WHERE upstream_account_id=?').get(Number(row.id));
      return { ...publicAccount(row), packages: packages.filter(item => Number(item.upstream_id) === Number(row.id) && Boolean(item.enabled)).map(item => ({
        id: Number(item.id), packageId: item.package_id, name: item.name, description: item.description || '', enabled: Boolean(item.enabled), updatedAt: item.updated_at,
      })),
      customers: customers.map(item => ({ id: Number(item.id), username: item.username, subscriptionCount: Number(item.subscriptionCount), siteCount: Number(item.siteCount), resourceCount: Number(item.resourceCount) })),
      customerCount: customers.length,
      siteCount: Number(ownedSites?.count || 0),
      resourceCount: Number(ownedResources?.count || 0),
    };
    }));
  }

  async row(id, { active = false } = {}) {
    const row = await this.db.prepare(`SELECT * FROM upstream_accounts WHERE id=?${active ? " AND status='active'" : ''}`).get(Number(id));
    if (!row) throw httpError(active ? '上游账号不可用' : '上游账号不存在', 404);
    return row;
  }

  async clientForAccount(id, packageId = null) {
    if (!id) {
      if (this.legacyClient) {
        if (!packageId) return this.legacyClient;
        const key = String(packageId);
        if (this.legacyClients.has(key)) return this.legacyClients.get(key);
        // Legacy deployments inject a pre-built client. Clone it per package
        // so concurrent customers cannot overwrite its package selector.
        const client = Object.assign(Object.create(Object.getPrototypeOf(this.legacyClient)), this.legacyClient);
        client.packageId = packageId;
        if (client.cacheScope) {
          const baseScope = String(client.cacheScope).split('|package=')[0];
          client.cacheScope = `${baseScope}|package=${encodeURIComponent(key)}`;
        }
        this.legacyClients.set(key, client);
        return client;
      }
      throw httpError('套餐未绑定可用的 CDN 服务', 409);
    }
    const row = await this.row(id, { active: true });
    const cacheKey = `${row.id}:${row.updated_at}:${packageId || ''}`;
    if (this.clients.has(cacheKey)) return this.clients.get(cacheKey);
    const apiKey = settingsInternals.decryptSecret(row.api_key_encrypted, this.config);
    const apiSecret = settingsInternals.decryptSecret(row.api_secret_encrypted, this.config);
    if (!apiKey || !apiSecret) throw httpError('上游凭据无法解密，请重新保存', 503);
    const client = new CdnflyClient({
      ...this.config,
      cdnflyBaseUrl: row.base_url,
      cdnflyApiKey: apiKey,
      cdnflyApiSecret: apiSecret,
      cdnflyUserPackageId: packageId || 0,
      cdnflyAccountId: row.id,
      cdnflyCnameSuffix: row.cname_suffix || '',
      cdnflyRequestsPerMinute: Number(row.requests_per_minute),
      upstreamTimeoutMs: Number(row.timeout_ms),
    }, this.fetch, this.cache);
    this.clients.set(cacheKey, client);
    return client;
  }

  async clientForSubscription(subscriptionOrId, userId = null) {
    const subscription = typeof subscriptionOrId === 'object' ? subscriptionOrId : await this.db.prepare(
      `SELECT s.* FROM subscriptions s WHERE s.id=?${userId ? ' AND s.user_id=?' : ''}`
    ).get(...(userId ? [Number(subscriptionOrId), Number(userId)] : [Number(subscriptionOrId)]));
    if (!subscription) throw httpError('客户套餐不存在', 404);
    return this.clientForAccount(subscription.upstream_id, subscription.upstream_package_id);
  }

  async clientForSite(siteOrId, userId = null) {
    let site = typeof siteOrId === 'object' ? siteOrId : await this.db.prepare(
      `SELECT s.*, sub.upstream_id AS subscription_upstream_id, sub.upstream_package_id
       FROM sites s LEFT JOIN subscriptions sub ON sub.id=s.subscription_id
       WHERE s.id=?${userId ? ' AND s.owner_id=?' : ''}`
    ).get(...(userId ? [Number(siteOrId), Number(userId)] : [Number(siteOrId)]));
    if (!site) throw httpError('网站不存在', 404);
    // Callers commonly pass a row selected from `sites` without the joined
    // subscription columns. Always hydrate the frozen account/package pair;
    // an existing account ID must not cause the package ID to be skipped.
    if (site.subscription_id && (!site.subscription_upstream_id || !site.upstream_package_id)) {
      const subscription = await this.db.prepare('SELECT upstream_id,upstream_package_id FROM subscriptions WHERE id=?').get(site.subscription_id);
      site = { ...site, subscription_upstream_id: site.subscription_upstream_id || subscription?.upstream_id,
        upstream_package_id: site.upstream_package_id || subscription?.upstream_package_id };
    }
    return this.clientForAccount(site.upstream_account_id || site.subscription_upstream_id, site.upstream_package_id);
  }

  async clientForResource(resourceOrId, kind = null, userId = null) {
    let resource = typeof resourceOrId === 'object' ? resourceOrId : await this.db.prepare(
      `SELECT r.*, sub.upstream_id AS subscription_upstream_id, sub.upstream_package_id
       FROM tenant_resources r LEFT JOIN subscriptions sub ON sub.id=r.subscription_id
       WHERE r.id=?${kind ? ' AND r.kind=?' : ''}${userId ? ' AND r.owner_id=?' : ''}`
    ).get(...[Number(resourceOrId), ...(kind ? [kind] : []), ...(userId ? [Number(userId)] : [])]);
    if (!resource) throw httpError('资源不存在', 404);
    if (resource.subscription_id && (!resource.subscription_upstream_id || !resource.upstream_package_id)) {
      const subscription = await this.db.prepare('SELECT upstream_id,upstream_package_id FROM subscriptions WHERE id=?').get(resource.subscription_id);
      resource = { ...resource, subscription_upstream_id: resource.subscription_upstream_id || subscription?.upstream_id,
        upstream_package_id: resource.upstream_package_id || subscription?.upstream_package_id };
    }
    if (!resource.subscription_id && resource.upstream_account_id) {
      const packages = await this.db.prepare(`SELECT MIN(upstream_package_id) AS upstream_package_id, COUNT(DISTINCT upstream_package_id) AS count
        FROM subscriptions WHERE user_id=? AND status IN ('active','suspended') AND upstream_id=?`).get(resource.owner_id, Number(resource.upstream_account_id));
      if (Number(packages?.count) === 1 && packages.upstream_package_id) resource = { ...resource, upstream_package_id: packages.upstream_package_id };
    }
    return this.clientForAccount(resource.upstream_account_id || resource.subscription_upstream_id, resource.upstream_package_id);
  }

  async defaultClient(userId = null) {
    if (userId) {
      const rows = await this.db.prepare(`SELECT DISTINCT upstream_id, upstream_package_id FROM subscriptions
        WHERE user_id=? AND status IN ('active','suspended') AND upstream_id IS NOT NULL ORDER BY upstream_id, upstream_package_id`).all(Number(userId));
      if (rows.length === 1) return this.clientForAccount(rows[0].upstream_id, rows[0].upstream_package_id);
      if (rows.length > 1) throw httpError('当前账号使用多个上游套餐，请先选择客户套餐', 409);
    }
    const row = await this.db.prepare("SELECT * FROM upstream_accounts WHERE status='active' ORDER BY is_default DESC, id LIMIT 1").get();
    return row ? this.clientForAccount(row.id) : this.clientForAccount(null);
  }

  async clientsForUser(userId) {
    const rows = await this.db.prepare(`SELECT DISTINCT upstream_id, upstream_package_id FROM subscriptions
      WHERE user_id=? AND status IN ('active','suspended') AND upstream_id IS NOT NULL ORDER BY upstream_id, upstream_package_id`).all(Number(userId));
    if (!rows.length) return [await this.defaultClient(userId)];
    return Promise.all(rows.map(row => this.clientForAccount(row.upstream_id, row.upstream_package_id)));
  }

  async create(body, actorId) {
    const name = String(body.name || '').trim();
    const cnameSuffix = normalizeCnameSuffix(body.cnameSuffix);
    const apiKey = String(body.apiKey || '').trim(); const apiSecret = String(body.apiSecret || '').trim();
    if (!name || name.length > 80) throw httpError('上游名称须为 1-80 个字符');
    if (!apiKey || !apiSecret) throw httpError('API Key 和 API Secret 必填');
    if (!this.config.settingsEncryptionKey) throw httpError('未配置 SETTINGS_ENCRYPTION_KEY，不能保存上游凭据', 503);
    const count = Number((await this.db.prepare('SELECT COUNT(*) AS count FROM upstream_accounts').get()).count);
    const isDefault = body.isDefault === undefined ? count === 0 : Boolean(body.isDefault);
    return this.db.transaction(async transaction => {
      if (isDefault) await transaction.prepare('UPDATE upstream_accounts SET is_default=0').run();
      const id = Number((await transaction.prepare(`INSERT INTO upstream_accounts
        (name,base_url,cname_suffix,api_key_encrypted,api_secret_encrypted,status,is_default,requests_per_minute,timeout_ms,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, normalizeBaseUrl(body.baseUrl), cnameSuffix || null,
        settingsInternals.encryptSecret(apiKey, this.config), settingsInternals.encryptSecret(apiSecret, this.config),
        body.status === 'disabled' ? 'disabled' : 'active', Number(isDefault), Number(body.requestsPerMinute || 300), Number(body.timeoutMs || 15000), actorId)).lastInsertRowid);
      return publicAccount(await transaction.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(id));
    });
  }

  async update(id, body) {
    const current = await this.row(id); const name = String(body.name ?? current.name).trim();
    const cnameSuffix = Object.hasOwn(body, 'cnameSuffix') ? normalizeCnameSuffix(body.cnameSuffix) : (current.cname_suffix || '');
    if (!name || name.length > 80) throw httpError('上游名称须为 1-80 个字符');
    const status = body.status ?? current.status;
    if (!['active', 'disabled'].includes(status)) throw httpError('上游状态无效');
    const apiKey = Object.hasOwn(body, 'apiKey') ? String(body.apiKey || '').trim() : '';
    const apiSecret = Object.hasOwn(body, 'apiSecret') ? String(body.apiSecret || '').trim() : '';
    const keyEncrypted = apiKey ? settingsInternals.encryptSecret(apiKey, this.config) : current.api_key_encrypted;
    const secretEncrypted = apiSecret ? settingsInternals.encryptSecret(apiSecret, this.config) : current.api_secret_encrypted;
    const isDefault = body.isDefault === undefined ? Boolean(current.is_default) : Boolean(body.isDefault);
    await this.db.transaction(async transaction => {
      if (isDefault) await transaction.prepare('UPDATE upstream_accounts SET is_default=0').run();
      await transaction.prepare(`UPDATE upstream_accounts SET name=?,base_url=?,cname_suffix=?,api_key_encrypted=?,api_secret_encrypted=?,status=?,is_default=?,
        requests_per_minute=?,timeout_ms=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(name, normalizeBaseUrl(body.baseUrl ?? current.base_url), cnameSuffix || null, keyEncrypted, secretEncrypted,
        status, Number(isDefault), Number(body.requestsPerMinute ?? current.requests_per_minute), Number(body.timeoutMs ?? current.timeout_ms), current.id);
    });
    this.clients.clear();
    return publicAccount(await this.row(id));
  }

  async test(id, { fresh = false } = {}) {
    const checkedAt = new Date().toISOString();
    const current = await this.row(id, { active: true });
    try {
      await (await this.clientForAccount(id)).health({ fresh });
      this.healthFailures.delete(Number(id));
      await this.db.prepare("UPDATE upstream_accounts SET last_health_status='healthy',last_health_error=NULL,last_checked_at=? WHERE id=?").run(checkedAt, Number(id));
      return { ok: true, checkedAt };
    } catch (error) {
      const failures = (this.healthFailures.get(Number(id)) || 0) + 1;
      this.healthFailures.set(Number(id), failures);
      const message = String(error.message || error).slice(0, 1000);
      if (failures < 3) {
        await this.db.prepare("UPDATE upstream_accounts SET last_health_error=?,last_checked_at=? WHERE id=?").run(message, checkedAt, Number(id));
        return { ok: false, degraded: true, transient: true, lastKnownHealthy: current.last_health_status === 'healthy', error: message, checkedAt };
      }
      await this.db.prepare("UPDATE upstream_accounts SET last_health_status='unhealthy',last_health_error=?,last_checked_at=? WHERE id=?").run(message, checkedAt, Number(id));
      return { ok: false, error: message, checkedAt };
    }
  }

  async availablePackages(id) {
    await this.row(id, { active: true });
    const payload = await (await this.clientForAccount(id)).request('GET', '/v1/user-packages?limit=0');
    const packages = packageItems(payload).map(publicAvailablePackage).filter(Boolean);
    if (!packages.length) throw httpError('CDNFly 未返回该账号已持有的用户套餐，请确认账号已购买套餐且 API 密钥拥有读取权限', 502);
    return [...new Map(packages.map(item => [item.packageId, item])).values()];
  }

  async syncAvailablePackages(id) {
    const available = await this.availablePackages(id);
    const ids = new Set(available.map(item => item.packageId));
    await this.db.transaction(async transaction => {
      await transaction.prepare('UPDATE upstream_packages SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE upstream_id=?').run(Number(id));
      for (const item of available) {
        await transaction.prepare(`INSERT INTO upstream_packages (upstream_id,package_id,name,description,enabled)
          VALUES (?,?,?,?,1)
          ON CONFLICT(upstream_id,package_id) DO UPDATE SET name=excluded.name,description=excluded.description,enabled=1,updated_at=CURRENT_TIMESTAMP`)
          .run(Number(id), item.packageId, item.name, item.description || '');
      }
    });
    return available.filter(item => ids.has(item.packageId));
  }

  async savePackage(upstreamId, body, packageRowId = null) {
    await this.row(upstreamId);
    const packageId = String(body.packageId || '').trim(); const name = String(body.name || '').trim();
    if (!packageId || !name) throw httpError('上游套餐 ID 和名称必填');
    if (packageRowId) {
      const row = await this.db.prepare('SELECT * FROM upstream_packages WHERE id=? AND upstream_id=?').get(Number(packageRowId), Number(upstreamId));
      if (!row) throw httpError('上游套餐不存在', 404);
      await this.db.prepare(`UPDATE upstream_packages SET package_id=?,name=?,description=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(packageId, name, String(body.description || ''), Number(body.enabled !== false), row.id);
      return Number(row.id);
    }
    return Number((await this.db.prepare(`INSERT INTO upstream_packages (upstream_id,package_id,name,description,enabled) VALUES (?,?,?,?,?)`)
      .run(Number(upstreamId), packageId, name, String(body.description || ''), Number(body.enabled !== false))).lastInsertRowid);
  }
}

export const upstreamInternals = { normalizeBaseUrl, normalizeCnameSuffix, publicAccount, packageItems, publicAvailablePackage };
