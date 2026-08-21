import crypto from 'node:crypto';
import { BRAND_PLATFORM } from './brand.js';
import { hashPassword, verifyPassword } from './security.js';
import { publicUser } from './db.js';
import { changeEmailWithoutVerification, normalizeEmail } from './auth-service.js';
import { getRuntimeSettings, publicRuntimeSettings } from './settings.js';
import { normalizeCdnflyUrl } from './compat-path.js';

const PREFIX = '/api/cdnfly/v1';

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function collection(items) {
  return { count: items.length, items };
}

const USER_CONFIG_TYPES = new Set(['site', 'stream', 'cert']);
const USER_CONFIG_SCOPES = new Set(['global', 'group']);
const USER_CONFIG_FIELDS = new Set(['id', 'uid', 'name', 'value', 'type', 'scope_name', 'scope_id', 'enable']);
const USER_MENU = [
  { name: 'dashboard', title: '控制台', jump: '/user-dashboard/index' },
  { name: 'site', title: '网站管理', jump: '/site/site/', list: [
    { name: 'sites', title: '网站列表', jump: '/site/site/' },
    { name: 'site-groups', title: '网站分组', jump: '/site/group/' },
    { name: 'certs', title: '证书管理', jump: '/site/cert/' },
    { name: 'dnsapis', title: 'DNS API', jump: '/site/dnsapi/' },
  ] },
  { name: 'security', title: '安全防护', jump: '/site/acl/', list: [
    { name: 'acls', title: 'ACL 管理', jump: '/site/acl/' },
    { name: 'cc-rules', title: 'CC 防护', jump: '/security/cc-rule/' },
    { name: 'waf-rules', title: 'WAF 规则', jump: '/security/waf-rule/' },
  ] },
  { name: 'stream', title: '四层转发', jump: '/stream/stream/' },
  { name: 'monitor', title: '数据详情', jump: '/monitor/site/realtime' },
  { name: 'package', title: '套餐中心', jump: '/package/user-package/' },
  { name: 'account', title: '账户中心', jump: '/user/user/' },
];

function configName(value) {
  if (typeof value !== 'string') throw httpError('配置项名称必须是字符串');
  const name = value.trim();
  if (!name || name.length > 120 || /[<>\u0000-\u001f\u007f]/.test(name)) throw httpError('配置项名称无效');
  return name;
}

function configValue(value) {
  if (typeof value !== 'string') throw httpError('配置项值必须是字符串');
  if (Buffer.byteLength(value, 'utf8') > 64 * 1024) throw httpError('配置项值不能超过 64 KiB');
  return value;
}

function configType(value) {
  const type = String(value || '').trim();
  if (!USER_CONFIG_TYPES.has(type)) throw httpError('配置类型必须是 site、stream 或 cert');
  return type;
}

function configEnable(value) {
  if (value === 0 || value === '0' || value === false) return 0;
  if (value === 1 || value === '1' || value === true) return 1;
  throw httpError('启用状态必须是 0 或 1');
}

function positiveInteger(value, name, { zero = false } = {}) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw httpError(`${name}不是数字`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < (zero ? 0 : 1)) throw httpError(`${name}无效`);
  return number;
}

async function normalizeConfigScope(db, userId, type, scopeName, scopeId) {
  const scope = String(scopeName ?? 'global').trim();
  if (!USER_CONFIG_SCOPES.has(scope)) throw httpError('作用域必须是 global 或 group');
  if (scope === 'global') return { scopeName: scope, scopeId: 0 };
  if (type === 'cert') throw httpError('证书默认配置仅支持全局作用域');
  const id = positiveInteger(scopeId, '作用域 ID');
  const group = type === 'site'
    ? await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(id, userId)
    : await db.prepare('SELECT id FROM customer_stream_groups WHERE id=? AND user_id=?').get(id, userId);
  if (!group) throw httpError(type === 'site' ? '网站分组不存在' : '四层转发分组不存在', 404);
  return { scopeName: scope, scopeId: id };
}

async function publicConfig(db, row) {
  let siteGroupName = null; let streamGroupName = null;
  if (row.scope_name === 'group') {
    if (['site', 'stream'].includes(row.type)) {
      const group = row.type === 'site'
        ? await db.prepare('SELECT name FROM customer_site_groups WHERE id=? AND user_id=?').get(Number(row.scope_id), Number(row.user_id))
        : await db.prepare('SELECT name FROM customer_stream_groups WHERE id=? AND user_id=?').get(Number(row.scope_id), Number(row.user_id));
      const name = group?.name || null;
      if (row.type === 'site') siteGroupName = name; else streamGroupName = name;
    }
  }
  return {
    id: Number(row.id),
    uid: Number(row.user_id),
    username: row.username || null,
    name: row.name,
    value: row.value,
    type: row.type,
    scope_id: Number(row.scope_id),
    scope_name: row.scope_name,
    site_group_name: siteGroupName,
    stream_group_name: streamGroupName,
    enable: Number(row.enable),
    create_at: row.created_at,
    update_at: row.updated_at,
  };
}

function assertConfigFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError('请求体必须是 JSON 对象');
  const unknown = Object.keys(body).find(key => !USER_CONFIG_FIELDS.has(key));
  if (unknown) throw httpError(`不支持的用户默认配置字段: ${unknown}`);
  if (Object.hasOwn(body, 'uid')) throw httpError('普通用户不能指定配置归属账号', 403);
}

async function normalizeUserConfig(db, userId, body, current = null) {
  assertConfigFields(body);
  const name = body.name === undefined ? current?.name : configName(body.name);
  const value = body.value === undefined ? current?.value : configValue(body.value);
  const type = body.type === undefined ? current?.type : configType(body.type);
  if (name === undefined || value === undefined || type === undefined) throw httpError('name、value 和 type 为必填字段');
  const scopeName = body.scope_name === undefined ? current?.scope_name ?? 'global' : body.scope_name;
  const scopeId = body.scope_id === undefined ? current?.scope_id ?? 0 : body.scope_id;
  const scope = await normalizeConfigScope(db, userId, type, scopeName, scopeId);
  const enable = body.enable === undefined ? Number(current?.enable ?? 1) : configEnable(body.enable);
  return { name, value, type, scopeName: scope.scopeName, scopeId: scope.scopeId, enable };
}

function configQueryInteger(url, name, fallback, { zero = false } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  return positiveInteger(raw, name, { zero });
}

async function listUserConfigs(db, user, url) {
  const page = configQueryInteger(url, 'page', 1);
  const limit = configQueryInteger(url, 'limit', 10, { zero: true });
  const clauses = ['uc.user_id=?']; const params = [user.id];
  const type = url.searchParams.get('type'); const name = url.searchParams.get('name'); const enable = url.searchParams.get('enable');
  if (type) { clauses.push('uc.type=?'); params.push(type); }
  if (name) { clauses.push('uc.name=?'); params.push(name); }
  if (enable !== null && enable !== '') { clauses.push('uc.enable=?'); params.push(configEnable(enable)); }
  const where = clauses.join(' AND ');
  const count = Number((await db.prepare(`SELECT COUNT(*) AS count FROM user_configs uc WHERE ${where}`).get(...params)).count);
  let sql = `SELECT uc.*, u.username FROM user_configs uc JOIN users u ON u.id=uc.user_id WHERE ${where} ORDER BY uc.id DESC`;
  const rowParams = [...params];
  if (limit > 0) { sql += ' LIMIT ? OFFSET ?'; rowParams.push(limit, (page - 1) * limit); }
  const rows = await db.prepare(sql).all(...rowParams);
  return { count, items: await Promise.all(rows.map(row => publicConfig(db, row))) };
}

function keyDigest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newApiKey() {
  const secret = `epk_${crypto.randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 14), hash: keyDigest(secret) };
}

function publicApiKey(row) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function bodyItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.items)) return body.items;
  return [body || {}];
}

async function ownConfig(db, userId, id) {
  const numeric = Number.parseInt(id, 10);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return db.prepare('SELECT * FROM user_configs WHERE id=? AND user_id=?').get(numeric, userId);
}

async function ownApiKey(db, userId, id) {
  const numeric = Number.parseInt(id, 10);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return db.prepare('SELECT * FROM user_api_keys WHERE id=? AND user_id=?').get(numeric, userId);
}

function overviewUser(user) {
  return publicUser(user);
}

export async function handleUserCompatApi({ req, url, user, db, billing, config, readBody }) {
  normalizeCdnflyUrl(url);
  if (user.role !== 'user' || !url.pathname.startsWith(PREFIX)) return null;
  const path = url.pathname.slice(PREFIX.length) || '/';

  if (path === '/user' && req.method === 'GET') {
    const wallet = await db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(user.id);
    return { status: 200, compat: true, data: {
      ...overviewUser(user),
      name: user.username,
      phone: null,
      qq: null,
      balance: Number(wallet?.balance_cents || 0) / 100,
      white_ip: '',
      login_captcha: 'none',
      user_group: null,
      group_name: null,
      cert_id: null,
      cert_name: '',
      cert_no: '',
      cert_verified: 0,
      id_auth_way: 'none',
      auth2_enable: 0,
      auth2_verified: 0,
      auth2_end_at: null,
      auth2_expire_action: null,
      company_auth_enable: 0,
      company_name: null,
      company_credit_code: null,
      company_verified: 0,
      create_at: user.created_at || null,
    } };
  }

  if (path === '/user' && req.method === 'PUT') {
    const body = await readBody();
    const allowed = new Set(['email', 'password', 'currentPassword']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw httpError('用户资料只允许更新邮箱或密码', 400);
    if (!body.currentPassword || !verifyPassword(body.currentPassword, user.password_hash)) throw httpError('当前密码错误', 403);
    let result = { ok: true, relogin: false };
    if (body.email !== undefined) {
      const settings = await import('./settings.js').then(module => module.getRuntimeSettings(db, config));
      if (settings.emailVerificationEnabled) throw httpError('邮箱验证已启用，请使用账户中心的换绑邮箱流程', 409);
      result = await changeEmailWithoutVerification({ db, user, body: { email: normalizeEmail(body.email), currentPassword: body.currentPassword } });
    }
    if (body.password !== undefined) {
      const password = String(body.password || '');
      if (password.length < 1) throw httpError('新密码不能为空');
      await db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(password), user.id);
      await db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      result = { ...result, passwordChanged: true, relogin: true };
    }
    return { status: 200, compat: true, data: result, action: 'user.update', resourceId: user.id };
  }

  if (path === '/user-overview' && req.method === 'GET') {
    const now = new Date(); const renewBefore = new Date(now.getTime() + 24 * 60 * 60_000);
    const [activePackages, renewPackages, wallet, sites, certs, streamPorts] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=? AND status<>'cancelled' AND ends_at>?").get(user.id, now.toISOString()),
      db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=? AND status<>'cancelled' AND ends_at<=?").get(user.id, renewBefore.toISOString()),
      db.prepare('SELECT balance_cents FROM wallets WHERE user_id=?').get(user.id),
      db.prepare('SELECT domain FROM sites WHERE owner_id=?').all(user.id),
      db.prepare("SELECT COUNT(*) AS count FROM tenant_resources WHERE owner_id=? AND kind='certs'").get(user.id),
      db.prepare(`SELECT COUNT(*) AS count FROM stream_ports p JOIN tenant_resources r ON r.id=p.resource_id
        WHERE r.owner_id=? AND r.kind='streams'`).get(user.id),
    ]);
    const domainCount = sites.reduce((total, site) => total + String(site.domain || '').split(/[\s,]+/).filter(Boolean).length, 0);
    return { status: 200, compat: true, data: {
      user_package_count: Number(activePackages.count || 0),
      cert_verified: 0,
      auth2_enable: 0,
      auth2_verified: 0,
      renew: Number(renewPackages.count || 0),
      balance: Number(wallet?.balance_cents || 0) / 100,
      uid: Number(user.id),
      domain_count: domainCount,
      cert_count: Number(certs.count || 0),
      stream_port_count: Number(streamPorts.count || 0),
    } };
  }

  if (path === '/user-configs' && req.method === 'GET') {
    const result = await listUserConfigs(db, user, url);
    return { status: 200, compat: true, count: result.count, data: result.items };
  }
  if (path === '/user-configs' && req.method === 'POST') {
    const normalized = await normalizeUserConfig(db, user.id, await readBody());
    try {
      const row = await db.prepare(`INSERT INTO user_configs (user_id,name,value,type,scope_name,scope_id,enable)
        VALUES (?,?,?,?,?,?,?)`).run(user.id, normalized.name, normalized.value, normalized.type, normalized.scopeName, normalized.scopeId, normalized.enable);
      return { status: 200, compat: true, data: Number(row.lastInsertRowid), action: 'user-config.create', resourceId: row.lastInsertRowid };
    } catch (error) {
      if (/unique|duplicate/i.test(error.message || '')) throw httpError('同一作用域中的同类型配置项已存在', 409);
      throw error;
    }
  }
  if (path === '/user-configs' && req.method === 'PUT') {
    const body = await readBody();
    if (!Array.isArray(body) || !body.length) throw httpError('批量更新请求体必须是非空 JSON 数组');
    try {
      await db.transaction(async transaction => {
        for (const item of body) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || item.id === undefined) throw httpError('批量更新的每个对象都必须提供 id');
          const row = await ownConfig(transaction, user.id, item.id);
          if (!row) throw httpError('用户默认配置不存在', 404);
          const normalized = await normalizeUserConfig(transaction, user.id, item, row);
          await transaction.prepare(`UPDATE user_configs SET name=?,value=?,type=?,scope_name=?,scope_id=?,enable=?,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND user_id=?`).run(normalized.name, normalized.value, normalized.type, normalized.scopeName, normalized.scopeId, normalized.enable, row.id, user.id);
        }
      });
      return { status: 200, compat: true, data: null, action: 'user-config.update' };
    } catch (error) {
      if (/unique|duplicate/i.test(error.message || '')) throw httpError('同一作用域中的同类型配置项已存在', 409);
      throw error;
    }
  }

  const configMatch = path.match(/^\/user-configs\/(\d+(?:,\d+)*)$/);
  if (configMatch) {
    const ids = [...new Set(configMatch[1].split(',').map(id => positiveInteger(id, 'id')))];
    if (req.method === 'GET') {
      if (ids.length !== 1) throw httpError('id 不是数字');
      const result = await listUserConfigs(db, user, url);
      return { status: 200, compat: true, count: result.count, data: result.items };
    }
    if (req.method === 'PUT') {
      if (ids.length !== 1) throw httpError('id 不是数字');
      const row = await ownConfig(db, user.id, ids[0]);
      if (!row) throw httpError('用户默认配置不存在', 404);
      const body = await readBody();
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).some(key => !['id', 'uid'].includes(key))) throw httpError('请至少提供一个需要变更的字段');
      try {
        const normalized = await normalizeUserConfig(db, user.id, body, row);
        await db.prepare(`UPDATE user_configs SET name=?,value=?,type=?,scope_name=?,scope_id=?,enable=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND user_id=?`).run(normalized.name, normalized.value, normalized.type, normalized.scopeName, normalized.scopeId, normalized.enable, row.id, user.id);
        return { status: 200, compat: true, data: null, action: 'user-config.update', resourceId: row.id };
      } catch (error) {
        if (/unique|duplicate/i.test(error.message || '')) throw httpError('同一作用域中的同类型配置项已存在', 409);
        throw error;
      }
    }
    if (req.method === 'DELETE') {
      await db.transaction(async transaction => {
        for (const id of ids) {
          const row = await ownConfig(transaction, user.id, id);
          if (!row) throw httpError('用户默认配置不存在', 404);
          await transaction.prepare('DELETE FROM user_configs WHERE id=? AND user_id=?').run(row.id, user.id);
        }
      });
      return { status: 200, compat: true, data: null, action: 'user-config.delete', resourceId: ids.join(',') };
    }
  }

  if (path === '/api-key' && req.method === 'GET') {
    const rows = await db.prepare('SELECT * FROM user_api_keys WHERE user_id=? ORDER BY id DESC').all(user.id);
    return { status: 200, compat: true, data: collection(rows.map(publicApiKey)) };
  }
  if (path === '/api-key' && req.method === 'POST') {
    const body = await readBody(); const name = String(body.name || '未命名密钥').trim();
    if (!name || name.length > 80) throw httpError('API Key 名称不能为空且不能超过 80 个字符');
    const key = newApiKey();
    const row = await db.prepare('INSERT INTO user_api_keys (user_id,name,key_prefix,key_hash) VALUES (?,?,?,?)').run(user.id, name, key.prefix, key.hash);
    return { status: 201, compat: true, data: { ...publicApiKey(await ownApiKey(db, user.id, row.lastInsertRowid)), key: key.secret }, action: 'api-key.create', resourceId: row.lastInsertRowid };
  }
  if (path === '/api-key' && req.method === 'PUT') {
    const body = await readBody();
    for (const item of bodyItems(body)) {
      const row = await ownApiKey(db, user.id, item.id); if (!row) throw httpError('API Key 不存在', 404);
      if (item.name !== undefined) {
        const name = String(item.name || '').trim(); if (!name || name.length > 80) throw httpError('API Key 名称无效');
        await db.prepare('UPDATE user_api_keys SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(name, row.id, user.id);
      }
      if (item.revoked !== undefined || item.enabled !== undefined) {
        const revoked = item.revoked === true || item.enabled === false;
        await db.prepare('UPDATE user_api_keys SET revoked_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(revoked ? new Date().toISOString() : null, row.id, user.id);
      }
    }
    return { status: 200, compat: true, data: true, action: 'api-key.update' };
  }
  const apiKeyMatch = path.match(/^\/api-key\/(\d+)$/);
  if (apiKeyMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const row = await ownApiKey(db, user.id, apiKeyMatch[1]); if (!row) throw httpError('API Key 不存在', 404);
    if (req.method === 'DELETE') {
      await db.prepare('UPDATE user_api_keys SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(row.id, user.id);
      return { status: 200, compat: true, data: true, action: 'api-key.revoke', resourceId: row.id };
    }
    const body = await readBody(); const name = String(body.name || row.name).trim();
    if (!name || name.length > 80) throw httpError('API Key 名称无效');
    await db.prepare('UPDATE user_api_keys SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(name, row.id, user.id);
    return { status: 200, compat: true, data: publicApiKey(await ownApiKey(db, user.id, row.id)), action: 'api-key.update', resourceId: row.id };
  }
  if (path === '/api-key' && req.method === 'DELETE') {
    const body = await readBody();
    const ids = bodyItems(body).map(item => item.id).filter(Boolean);
    if (!ids.length) throw httpError('请指定要撤销的 API Key');
    for (const id of ids) {
      const row = await ownApiKey(db, user.id, id); if (!row) throw httpError('API Key 不存在', 404);
      await db.prepare('UPDATE user_api_keys SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(row.id, user.id);
    }
    return { status: 200, compat: true, data: true, action: 'api-key.revoke' };
  }

  if (path === '/user-certify' && req.method === 'GET') {
    return { status: 200, compat: true, data: { supported: false, status: 'not_supported', message: '实名认证由平台账户流程独立管理' } };
  }
  if (path === '/user-certify' && req.method === 'POST') throw httpError('实名认证未接入可验证的第三方流程', 501);

  if (path === '/common-menu' && req.method === 'GET') return { status: 200, compat: true, data: structuredClone(USER_MENU) };
  if (path === '/common-menu-2' && req.method === 'GET') return { status: 200, compat: true, data: { sider: structuredClone(USER_MENU), header: [] } };
  if (path === '/common-package-purchase-notice' && req.method === 'GET') return { status: 200, compat: true, data: { html: '' } };

  return null;
}

export async function handlePublicUserCompatApi({ req, url, db, config, mailer }) {
  normalizeCdnflyUrl(url);
  if (!url.pathname.startsWith(PREFIX) || req.method !== 'GET') return null;
  const path = url.pathname.slice(PREFIX.length) || '/';
  const settings = await getRuntimeSettings(db, config);
  const publicSettings = publicRuntimeSettings(settings, mailer, null);
  if (path === '/common-register-info' || path === '/common/register-info') return { status: 200, compat: true, data: {
    enabled: Boolean(settings.registrationEnabled), registrationEnabled: Boolean(settings.registrationEnabled),
    emailVerificationEnabled: Boolean(settings.emailVerificationEnabled), turnstileEnabled: Boolean(settings.turnstileEnabled),
    siteName: settings.siteName, siteSubtitle: settings.siteSubtitle, inviteOnly: Boolean(settings.inviteOnly),
  } };
  if (path === '/common-sysinfo' || path === '/common/sysinfo') return { status: 200, compat: true, data: { siteName: settings.siteName, siteSubtitle: settings.siteSubtitle, apiVersion: 'v6', platform: BRAND_PLATFORM } };
  if (path === '/common-captcha' || path === '/common-captcha-type' || path.startsWith('/common-captcha/') || path === '/common/captcha' || path === '/common/captcha-type') {
    return { status: 200, compat: true, data: { enabled: false, type: 'none' } };
  }
  if (path === '/user-login-policy') return { status: 200, compat: true, data: { turnstileEnabled: Boolean(settings.turnstileEnabled), maxAttempts: 5, lockMinutes: 15 } };
  if (path === '/common-package-purchase-notice') return { status: 200, compat: true, data: { html: '' } };
  if (path === '/runtime-settings') return { status: 200, compat: true, data: publicSettings };
  return null;
}

export async function authenticateApiKey(db, token) {
  const value = String(token || '').trim();
  if (!value.startsWith('epk_')) return null;
  const row = await db.prepare(`SELECT u.*, COALESCE(ap.role_key, 'super_admin') AS admin_role
    FROM user_api_keys k JOIN users u ON u.id=k.user_id LEFT JOIN admin_profiles ap ON ap.user_id=u.id
    WHERE k.key_hash=? AND k.revoked_at IS NULL AND u.status='active'`).get(keyDigest(value));
  if (!row) return null;
  await db.prepare('UPDATE user_api_keys SET last_used_at=CURRENT_TIMESTAMP WHERE key_hash=?').run(keyDigest(value));
  return row;
}

export const userCompatInternals = { keyDigest, newApiKey, configName, configValue, configType, configEnable };
