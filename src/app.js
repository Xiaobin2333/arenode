import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSessionToken, tokenDigest, verifyPassword, hashPassword, validateUsername } from './security.js';
import { publicUser } from './db.js';
import { CdnflyError } from './cdnfly.js';
import { validateSiteInput } from './validation.js';
import { handleTenantProxy, syncSiteCnames, tenantProxyInternals } from './tenant-proxy.js';
import { handleDataProxy } from './data-proxy.js';
import { handleBillingApi } from './billing-api.js';
import { handleRedemptionApi } from './redemption.js';
import { createVirtualUser, handleAdminApi } from './admin-api.js';
import { normalizeEmail, registerWithoutVerification, requestRegistration, requestRegistrationCode, verifyRegistration, requestPasswordReset, resetPassword,
  changeEmailWithoutVerification, requestEmailChange, confirmEmailChange } from './auth-service.js';
import { getRuntimeSettings, publicRuntimeSettings, updateRuntimeSettings, verifyTurnstile, testTurnstileConfiguration } from './settings.js';
import { handleWalletApi } from './wallet.js';
import { handleAdminSecurityApi, isSuperAdmin } from './admin-security.js';
import { pagination, paged, searchLike } from './http-utils.js';
import { validateRegistrationEligibility, validateSelfServiceEmail, handleRegistrationSecurityApi } from './registration-security.js';
import { beginMfaLogin, completeMfaLogin, handleMfaApi } from './mfa.js';
import { handleUpstreamApi } from './upstream-api.js';
import { accountClosureStatus, closeAccount } from './account-service.js';
import { authenticateApiKey, handlePublicUserCompatApi, handleUserCompatApi } from './user-compat.js';
import { normalizeCdnflyUrl } from './compat-path.js';
import { ensureCustomerUpstreamGroups } from './customer-groups.js';
import { applyUserDefaults } from './user-defaults.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const COOKIE = 'cdnfly_session';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function getSessionToken(req) {
  return getCookie(req, COOKIE) || String(req.headers['access-token'] || '').trim();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}

async function audit(db, actorId, action, type, resourceId, detail, req) {
  const requestPath = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return req.url || ''; } })();
  const context = { method: req.method, path: requestPath };
  if (Array.isArray(detail)) context.changedFields = detail.map(String).slice(0, 50);
  else if (detail && typeof detail === 'object') {
    for (const [key, value] of Object.entries(detail)) {
      if (/password|secret|token|key|credential|authorization|cookie/i.test(key)) continue;
      if (['string', 'number', 'boolean'].includes(typeof value) || value === null) context[key] = value;
      else if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) context[key] = value.slice(0, 50);
    }
  }
  await db.prepare('INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actorId || null, action, type, resourceId ? String(resourceId) : null, JSON.stringify(context), req.socket.remoteAddress || null);
}

async function userFromSession(db, req) {
  const authorization = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) {
    const apiUser = await authenticateApiKey(db, authorization.replace(/^Bearer\s+/i, ''));
    if (apiUser) return apiUser;
  }
  const token = getSessionToken(req);
  if (!token) return null;
  const hash = tokenDigest(token);
  const user = await db.prepare(`SELECT u.*, COALESCE(ap.role_key, 'super_admin') AS admin_role
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN admin_profiles ap ON ap.user_id=u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`).get(hash, new Date().toISOString()) || null;
  if (user) await db.prepare('UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(hash);
  return user;
}

async function ownedSite(db, localId, user) {
  const id = Number.parseInt(localId, 10);
  if (!Number.isInteger(id) || id < 1) return null;
  return db.prepare(`SELECT s.*, p.name AS plan_name FROM sites s
    LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id
    WHERE s.id = ? AND s.owner_id = ?`).get(id, user.id) || null;
}

function presentSite(row) {
  const upstreamEnabled = row.upstream_enabled === undefined
    ? Boolean(row.enabled)
    : [1, true, '1', 'true', 'on', 'enabled', 'active'].includes(row.upstream_enabled);
  return {
    id: row.id, domain: row.domain, origin: row.origin,
    enabled: row.state === 'quota_suspended' ? false : upstreamEnabled,
    subscriptionId: row.subscription_id, planName: row.plan_name || null,
    groupId: row.local_group_id === null || row.local_group_id === undefined ? null : Number(row.local_group_id),
    backendProtocol: row.backend_protocol, backendHost: row.backend_host,
    websocket: Boolean(row.websocket), gzip: Boolean(row.gzip),
    state: row.upstream_state ?? row.state, cname: row.cname, lastError: row.last_error, createdAt: row.created_at,
    httpsEnabled: row.https_enabled, listenPorts: row.listen_ports,
  };
}

function sameOrigin(req, config) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = forwardedHost || req.headers.host;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
    const requestOrigin = host ? `${protocol}://${host}` : '';
    return new URL(origin).origin === new URL(config.appOrigin).origin || origin === requestOrigin;
  } catch {
    return false;
  }
}

async function rateAllowed(cache, fallback, scope, key, limit, windowMs) {
  if (cache) return (await cache.rateLimit(scope, key, limit, Math.ceil(windowMs / 1000))).allowed;
  const fallbackKey = `${scope}:${key}`;
  const attempt = fallback.get(fallbackKey) || { count: 0, reset: Date.now() + windowMs };
  if (attempt.reset < Date.now()) Object.assign(attempt, { count: 0, reset: Date.now() + windowMs });
  attempt.count += 1; fallback.set(fallbackKey, attempt);
  return attempt.count <= limit;
}

async function claimCooldown(cache, fallback, scope, key, seconds) {
  if (cache) return cache.claimCooldown(scope, key, seconds);
  const fallbackKey = `${scope}:${key}`; const expiresAt = fallback.get(fallbackKey) || 0;
  if (expiresAt > Date.now()) return { allowed: false, retryAfter: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)), fallbackKey };
  fallback.set(fallbackKey, Date.now() + seconds * 1000);
  return { allowed: true, retryAfter: 0, fallbackKey };
}

async function releaseCooldown(cache, fallback, claim) {
  if (cache) return cache.releaseCooldown(claim);
  if (claim?.fallbackKey) fallback.delete(claim.fallbackKey);
}

function summarizeUpstreamHealth(active, checks) {
  const healthy = checks.filter(item => item.ok).length;
  const transientHealthy = checks.filter(item => !item.ok && item.transient && item.lastKnownHealthy).length;
  const ok = checks.length > 0 && healthy + transientHealthy === checks.length;
  const degraded = !ok && (checks.some(item => item.degraded)
    || active.some(item => item.lastHealthStatus === 'healthy' && item.lastCheckedAt
      && Date.now() - new Date(item.lastCheckedAt).getTime() < 120_000)
    || (healthy > 0 && healthy < checks.length));
  return { ok, degraded, stale: transientHealthy > 0, checkedAt: checks.at(-1)?.checkedAt || new Date().toISOString() };
}

export function createApp({ db, cdnfly, upstreams = null, config, billing = null, cache = null, mailer = null, turnstileFetch = fetch, dnsResolveCname }) {
  const loginAttempts = new Map();
  const registrationAttempts = new Map();
  const passwordResetAttempts = new Map();
  const verificationCooldowns = new Map();
  let adminHealthSnapshot = null;
  let adminHealthInFlight = null;

  async function serviceStatus(user) {
    const load = async () => {
      let cdn;
      if (upstreams) {
        const subscriptions = await db.prepare(`SELECT DISTINCT upstream_id FROM subscriptions
          WHERE user_id=? AND status IN ('active','suspended') AND upstream_id IS NOT NULL`).all(user.id);
        const active = (await upstreams.list()).filter(item => item.status === 'active');
        const ids = subscriptions.length ? subscriptions.map(item => Number(item.upstream_id)) : active.filter(item => item.isDefault).map(item => item.id);
        const targets = ids.length ? [...new Set(ids)] : active.map(item => item.id);
        const checks = await Promise.all(targets.map(id => upstreams.test(id)));
        cdn = summarizeUpstreamHealth(active, checks);
      } else {
        try { await cdnfly.health(); cdn = { ok: true, checkedAt: new Date().toISOString() }; }
        catch { cdn = { ok: false, checkedAt: new Date().toISOString() }; }
      }
      const scheduler = billing ? billing.schedulerHealth() : { ok: false };
      const hardFailure = !cdn.ok && !cdn.degraded;
      // The customer-facing CDN status must describe the CDN service itself.
      // Billing scheduler startup is an administrator concern and must not
      // make a customer's CDN appear partially unavailable.
      return { ok: cdn.ok, status: hardFailure ? 'unhealthy' : cdn.degraded ? 'degraded' : 'healthy', checkedAt: new Date().toISOString(), services: { cdn, billing: { ok: scheduler.ok } } };
    };
    return cache ? cache.getOrSet('service-status', `user:${user.id}`, 30, load) : load();
  }

  async function adminHealthStatus({ fresh = false } = {}) {
    const snapshotAge = adminHealthSnapshot ? Date.now() - adminHealthSnapshot.createdAt : Infinity;
    if (!fresh && snapshotAge < 30_000) return adminHealthSnapshot.value;
    if (adminHealthInFlight) return adminHealthInFlight;
    adminHealthInFlight = (async () => {
      const probe = async callback => {
        try { await callback(); return { ok: true, error: null }; }
        catch (error) { return { ok: false, error: error.message || '探针失败' }; }
      };
      const settings = await getRuntimeSettings(db, config);
      let upstreamRows = []; let upstreamListError = null;
      if (upstreams) {
        try { upstreamRows = (await upstreams.list()).filter(item => item.status === 'active'); }
        catch (error) { upstreamListError = error.message || '无法读取上游配置'; }
      }
      const upstreamProbe = upstreams
        ? (upstreamRows.length ? Promise.all(upstreamRows.map(async item => ({ id: item.id, name: item.name, ...(await upstreams.test(item.id, { fresh })) }))) : Promise.resolve([]))
        : Promise.resolve([await probe(() => cdnfly.health({ fresh }))]);
      const [postgres, redis, upstreamChecks] = await Promise.all([
        probe(() => db.health()),
        cache ? cache.health() : Promise.resolve({ ok: false, degraded: true, error: '未配置' }),
        upstreamProbe,
      ]);
      const healthyUpstreams = upstreamChecks.filter(item => item.ok).length;
      const transientHealthyUpstreams = upstreamChecks.filter(item => !item.ok && item.transient && item.lastKnownHealthy).length;
      const availableUpstreams = healthyUpstreams + transientHealthyUpstreams;
      const staleHealthy = upstreamChecks.some(item => !item.ok && upstreamRows.some(row => Number(row.id) === Number(item.id)
        && row.lastHealthStatus === 'healthy' && row.lastCheckedAt && Date.now() - new Date(row.lastCheckedAt).getTime() < 120_000));
      const upstreamPartial = Boolean(upstreamListError) || upstreamChecks.some(item => item.degraded) || (healthyUpstreams > 0 && healthyUpstreams < upstreamChecks.length) || staleHealthy;
      const cdnflyStatus = upstreams ? { ok: upstreamChecks.length > 0 && availableUpstreams === upstreamChecks.length,
        degraded: availableUpstreams !== upstreamChecks.length && upstreamPartial, stale: transientHealthyUpstreams > 0,
        total: upstreamChecks.length, healthy: availableUpstreams, accounts: upstreamChecks,
        error: upstreamListError || (availableUpstreams !== upstreamChecks.length ? upstreamChecks.find(item => !item.ok)?.error : null)
          || (upstreamChecks.length ? null : '尚未配置已启用的上游账号'),
        warning: transientHealthyUpstreams ? upstreamChecks.find(item => item.transient)?.error || '上游探针短暂波动，沿用最近正常状态' : null }
        : upstreamChecks[0];
      const scheduler = billing ? billing.schedulerHealth() : { ok: false, error: '计费任务未启动' };
      const emailRequired = Boolean(settings.emailVerificationEnabled);
      const emailConfigured = Boolean(mailer?.available);
      const email = !emailRequired
        ? { ok: true, skipped: true, required: false, configured: emailConfigured, error: '邮箱验证未启用' }
        : emailConfigured
          ? { ok: true, required: true, configured: true, error: null }
          : { ok: false, required: true, configured: false, error: '邮箱验证已启用，但邮件服务不可用' };
      // `ok` remains a strict compatibility flag. `status` tells the UI
      // whether a failure is a hard outage or a recoverable degradation.
      const ok = postgres.ok && redis.ok && cdnflyStatus.ok && scheduler.ok && email.ok;
      const hardFailure = !postgres.ok || (!cdnflyStatus.ok && !cdnflyStatus.degraded) || (!scheduler.ok && !scheduler.pending) || (email.required && !email.ok);
      const degraded = !hardFailure && (!redis.ok || Boolean(scheduler.pending));
      const status = hardFailure ? 'unhealthy' : degraded ? 'degraded' : 'healthy';
      const value = { ok, status, degraded, upstreamCount: cdnflyStatus.total, packageId: upstreams ? null : config.cdnflyUserPackageId,
        checkedAt: new Date().toISOString(), services: { postgres, redis, cdnfly: cdnflyStatus, scheduler, email } };
      adminHealthSnapshot = { createdAt: Date.now(), value };
      return value;
    })().finally(() => { adminHealthInFlight = null; });
    return adminHealthInFlight;
  }

  async function reserveVerificationSend(settings, email, ip) {
    const claims = [];
    for (const [scope, identity] of [['verification-email', email], ['verification-ip', ip]]) {
      const claim = await claimCooldown(cache, verificationCooldowns, scope, identity, settings.emailCodeCooldownSeconds);
      if (!claim.allowed) {
        await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item)));
        throw Object.assign(new Error(`验证码发送过于频繁，请 ${claim.retryAfter} 秒后再试`), { status: 429, retryAfter: claim.retryAfter });
      }
      claims.push(claim);
    }
    const emailAllowed = await rateAllowed(cache, registrationAttempts, 'verification-email-hour', email, settings.emailCodeHourlyLimit, 60 * 60_000);
    const ipAllowed = await rateAllowed(cache, passwordResetAttempts, 'verification-ip-hour', ip, settings.emailCodeHourlyLimit * 4, 60 * 60_000);
    if (!emailAllowed || !ipAllowed) {
      await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item)));
      throw Object.assign(new Error('验证码发送次数过多，请一小时后再试'), { status: 429, retryAfter: 3600 });
    }
    return claims;
  }

  async function issueSession(user, req) {
    const token = newSessionToken(); const expires = new Date(Date.now() + config.sessionHours * 3600_000);
    await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(tokenDigest(token), user.id, expires.toISOString(), req.socket.remoteAddress || null, String(req.headers['user-agent'] || '').slice(0, 500));
    return { token, expires };
  }

  function turnstileToken(body) {
    return body.turnstileToken ?? body.turnstile_token ?? body['cf-turnstile-response'];
  }

  async function authenticateLogin(req, body) {
    const key = req.socket.remoteAddress || 'unknown';
    if (!await rateAllowed(cache, loginAttempts, 'login', key, 10, 15 * 60_000)) return { status: 429, error: '登录尝试过多，请稍后再试' };
    const username = String(body.username ?? body.account ?? '').trim().toLowerCase();
    await verifyTurnstile(db, config, turnstileToken(body), key, turnstileFetch);
    const user = await db.prepare(`SELECT u.*, COALESCE(ap.role_key, 'super_admin') AS admin_role
      FROM users u LEFT JOIN admin_profiles ap ON ap.user_id=u.id WHERE u.username = ? OR u.email = ?`).get(username, username);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      await audit(db, user.id, 'login.locked', 'session', null, { username }, req);
      return { status: 423, error: '登录失败次数过多，账号已临时锁定，请稍后再试' };
    }
    if (!user || user.status !== 'active' || !verifyPassword(body.password || '', user.password_hash)) {
      if (user) {
        const attempts = Number(user.failed_login_count || 0) + 1;
        const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
        await db.prepare('UPDATE users SET failed_login_count=?, locked_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(attempts >= 5 ? 0 : attempts, lockedUntil, user.id);
      }
      await audit(db, user?.id, 'login.failed', 'session', null, { username }, req);
      return { status: 401, error: '用户名或密码错误' };
    }
    const loginSettings = await getRuntimeSettings(db, config);
    if (loginSettings.maintenanceMode && user.role !== 'admin') return { status: 503, error: '平台正在维护，请稍后再试', maintenance: true };
    const mfaChallenge = await beginMfaLogin(db, user.id);
    if (mfaChallenge) {
      await audit(db, user.id, 'login.mfa.required', 'session', null, null, req);
      return { status: 202, data: { mfaRequired: true, challengeToken: mfaChallenge } };
    }
    if (!cache) loginAttempts.delete(key);
    const { token } = await issueSession(user, req);
    await db.prepare('UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
    await audit(db, user.id, 'login.success', 'session', null, null, req);
    return { status: 200, user, token };
  }

  async function handlePublicCompatPost(req, res, url) {
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/cdnfly/v1/')) return false;
    const path = url.pathname.slice('/api/cdnfly/v1'.length);
    if (!['/login', '/email-captcha', '/phone-captcha', '/reset-pass', '/user'].includes(path)) return false;
    if (path === '/phone-captcha') throw Object.assign(new Error('平台未配置可验证的短信服务'), { status: 501 });
    const body = await readBody(req);

    if (path === '/login') {
      const result = await authenticateLogin(req, body);
      if (result.error) { json(res, result.status, { error: result.error, ...(result.maintenance ? { maintenance: true } : {}) }); return true; }
      if (result.status === 202) { json(res, 202, { code: 0, msg: '需要多因素验证', data: result.data }); return true; }
      json(res, 200, { code: 0, msg: '登录成功!', data: { access_token: result.token, username: result.user.username, uid: result.user.id, type: result.user.role === 'admin' ? 1 : 2 } }, {
        'set-cookie': `${COOKIE}=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600}${config.appOrigin.startsWith('https:') ? '; Secure' : ''}`,
      });
      return true;
    }

    if (path === '/email-captcha') {
      const settings = await getRuntimeSettings(db, config); const key = req.socket.remoteAddress || 'unknown';
      await verifyTurnstile(db, config, turnstileToken(body), key, turnstileFetch);
      let email;
      if (body.account) {
        const account = String(body.account).trim().toLowerCase();
        const row = await db.prepare("SELECT email FROM users WHERE (username=? OR email=?) AND role='user' AND status='active'").get(account, account);
        if (!row?.email) {
          if (!await rateAllowed(cache, passwordResetAttempts, 'verification-missing-account', key, 10, 60 * 60_000)) throw Object.assign(new Error('验证码发送次数过多，请稍后再试'), { status: 429 });
          json(res, 202, { code: 0, msg: '发送请求已受理', data: null }); return true;
        }
        email = normalizeEmail(row.email);
      } else {
        if (![0, 1].includes(Number(body.check_exist))) throw Object.assign(new Error('直接指定邮箱时必须提供 check_exist=0 或 1'), { status: 400 });
        email = normalizeEmail(body.email);
      }
      const registering = Number(body.check_exist) === 0;
      if (registering) {
        if (!settings.registrationEnabled) throw Object.assign(new Error('自助注册已关闭'), { status: 403 });
        if (!settings.emailVerificationEnabled) throw Object.assign(new Error('注册邮箱验证未启用，无需发送验证码'), { status: 409 });
        await validateSelfServiceEmail(settings, email);
      }
      const claims = await reserveVerificationSend(settings, email, key);
      try {
        const result = registering
          ? await requestRegistrationCode({ db, config, mailer, settings, email })
          : await requestPasswordReset({ db, config, mailer, settings, body: { email } });
        json(res, 202, { code: 0, msg: '发送成功!', data: result.devCode ? { devCode: result.devCode, expiresAt: result.expiresAt } : null });
      } catch (error) {
        await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item))); throw error;
      }
      return true;
    }

    if (path === '/user') {
      const settings = await getRuntimeSettings(db, config);
      if (!settings.registrationEnabled) throw Object.assign(new Error('自助注册已关闭'), { status: 403 });
      if (Number(body.accept_agreement) !== 1) throw Object.assign(new Error('请阅读并同意注册协议'), { status: 400 });
      const email = normalizeEmail(body.email); const key = req.socket.remoteAddress || 'unknown';
      const eligibility = await validateRegistrationEligibility(db, settings, {
        email, inviteCode: body.inviteCode ?? body.invite_code,
        termsAccepted: true, privacyAccepted: true, ip: key,
      });
      let customer;
      if (settings.emailVerificationEnabled) {
        customer = await verifyRegistration({ db, config, billing, body: {
          email, code: body.captcha, username: body.username, password: body.password, inviteId: eligibility.inviteId,
        } });
      } else {
        await verifyTurnstile(db, config, turnstileToken(body), key, turnstileFetch);
        if (!await rateAllowed(cache, registrationAttempts, 'registration', key, 10, 60 * 60_000)) throw Object.assign(new Error('注册尝试过多，请稍后再试'), { status: 429 });
        customer = await registerWithoutVerification({ db, billing, body: { ...body, email, ...eligibility } });
      }
      await audit(db, customer.id, 'register.success', 'user', customer.id, { compat: true, emailVerified: Boolean(settings.emailVerificationEnabled) }, req);
      json(res, 201, { code: 0, msg: '注册成功!', data: null }); return true;
    }

    if (String(body.reset_by || 'email') !== 'email') throw Object.assign(new Error('平台未配置可验证的短信找回流程'), { status: 501 });
    await resetPassword({ db, config, body: { email: body.email, code: body.captcha, newPassword: body.password } });
    json(res, 200, { code: 0, msg: '重置成功!', data: null }); return true;
  }

  return async function app(req, res) {
    const url = new URL(req.url, config.appOrigin);
    normalizeCdnflyUrl(url);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!sameOrigin(req, config)) return json(res, 403, { error: '请求来源无效' });

      if (url.pathname === '/api/auth/config' && req.method === 'GET') {
        const settings = await getRuntimeSettings(db, config);
        const sessionUser = await userFromSession(db, req);
        return json(res, 200, publicRuntimeSettings(settings, mailer, sessionUser?.role || null));
      }

      if (url.pathname === '/api/auth/session' && req.method === 'GET') {
        return json(res, 200, { authenticated: Boolean(await userFromSession(db, req)) });
      }

      if (url.pathname.startsWith('/api/cdnfly/v1/')) {
        const publicCompatResult = await handlePublicUserCompatApi({ req, url, db, config, mailer });
        if (publicCompatResult) return json(res, publicCompatResult.status, { code: 0, msg: '', data: publicCompatResult.data });
        if (await handlePublicCompatPost(req, res, url)) return;
      }

      if (url.pathname === '/api/auth/register' && req.method === 'POST') {
        const settings = await getRuntimeSettings(db, config);
        if (!settings.registrationEnabled) return json(res, 403, { error: '自助注册已关闭' });
        const body = await readBody(req);
        const key = req.socket.remoteAddress || 'unknown';
        await verifyTurnstile(db, config, body.turnstileToken, key, turnstileFetch);
        const email = normalizeEmail(body.email);
        const eligibility = await validateRegistrationEligibility(db, settings, { ...body, email, ip: key });
        if (!settings.emailVerificationEnabled) {
          if (!await rateAllowed(cache, registrationAttempts, 'registration', key, 10, 60 * 60_000)) return json(res, 429, { error: '注册尝试过多，请稍后再试' });
          const customer = await registerWithoutVerification({ db, billing, body: { ...body, email, ...eligibility } });
          await audit(db, customer.id, 'register.success', 'user', customer.id, { emailVerified: false }, req);
          return json(res, 201, { verificationRequired: false, user: publicUser(customer) });
        }
        const claims = await reserveVerificationSend(settings, email, key);
        let result;
        try { result = await requestRegistration({ db, config, mailer, settings, body: { ...body, email, ...eligibility } }); }
        catch (error) { await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item))); throw error; }
        return json(res, 202, result);
      }

      if (url.pathname === '/api/auth/register/verify' && req.method === 'POST') {
        const settings = await getRuntimeSettings(db, config);
        if (!settings.emailVerificationEnabled) return json(res, 409, { error: '注册邮箱验证未启用' });
        const customer = await verifyRegistration({ db, config, billing, body: await readBody(req) });
        await audit(db, customer.id, 'register.success', 'user', customer.id, null, req);
        return json(res, 201, { user: publicUser(customer) });
      }

      if (url.pathname === '/api/auth/password/forgot' && req.method === 'POST') {
        const key = req.socket.remoteAddress || 'unknown';
        const settings = await getRuntimeSettings(db, config); const body = await readBody(req);
        await verifyTurnstile(db, config, body.turnstileToken, key, turnstileFetch);
        const email = normalizeEmail(body.email); const claims = await reserveVerificationSend(settings, email, key);
        let result;
        try { result = await requestPasswordReset({ db, config, mailer, settings, body: { ...body, email } }); }
        catch (error) { await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item))); throw error; }
        return json(res, 202, result);
      }

      if (url.pathname === '/api/auth/password/reset' && req.method === 'POST') {
        const result = await resetPassword({ db, config, body: await readBody(req) });
        return json(res, 200, result);
      }

      if (url.pathname === '/api/auth/login/mfa' && req.method === 'POST') {
        const key = req.socket.remoteAddress || 'unknown';
        if (!await rateAllowed(cache, loginAttempts, 'login-mfa', key, 10, 15 * 60_000)) return json(res, 429, { error: '验证尝试过多，请稍后再试' });
        const user = await completeMfaLogin(db, config, await readBody(req)); const { token } = await issueSession(user, req);
        await db.prepare('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
        await audit(db, user.id, 'login.mfa.success', 'session', null, null, req);
        return json(res, 200, { user: publicUser(user) }, { 'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600}${config.appOrigin.startsWith('https:') ? '; Secure' : ''}` });
      }

      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await authenticateLogin(req, body);
        if (result.error) return json(res, result.status, { error: result.error, ...(result.maintenance ? { maintenance: true } : {}) });
        if (result.status === 202) return json(res, 202, result.data);
        return json(res, 200, { user: publicUser(result.user) }, {
          'set-cookie': `${COOKIE}=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600}${config.appOrigin.startsWith('https:') ? '; Secure' : ''}`,
        });
      }

      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = getCookie(req, COOKIE);
        if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenDigest(token));
        return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      }

      if (url.pathname.startsWith('/api/')) {
        const user = await userFromSession(db, req);
        if (!user) return json(res, 401, { error: '请先登录' });
        const currentTokenHash = tokenDigest(getSessionToken(req));
        if (user.role !== 'admin' && (await getRuntimeSettings(db, config)).maintenanceMode && url.pathname !== '/api/auth/logout') return json(res, 503, { error: '平台正在维护，请稍后再试', maintenance: true });

        if (url.pathname === '/api/me' && req.method === 'GET') {
          const count = (await db.prepare('SELECT COUNT(*) AS count FROM sites WHERE owner_id = ?').get(user.id)).count;
          return json(res, 200, { user: publicUser(user), usage: { sites: count, limit: user.site_limit }, ...(billing && user.role === 'user' ? { billing: await billing.snapshot(user.id) } : {}) });
        }

        if (url.pathname === '/api/service-status' && req.method === 'GET') {
          return json(res, 200, await serviceStatus(user));
        }

        if (url.pathname === '/api/account/email/change/request' && req.method === 'POST') {
          const settings = await getRuntimeSettings(db, config); const body = await readBody(req);
          const email = normalizeEmail(body.email); const key = req.socket.remoteAddress || 'unknown';
          let result;
          if (!settings.emailVerificationEnabled) {
            await validateSelfServiceEmail(settings, email);
            result = await changeEmailWithoutVerification({ db, user, body: { ...body, email } });
          } else {
            await verifyTurnstile(db, config, body.turnstileToken, key, turnstileFetch);
            await validateSelfServiceEmail(settings, email);
            const claims = await reserveVerificationSend(settings, email, key);
            try { result = await requestEmailChange({ db, config, mailer, settings, user, body: { ...body, email } }); }
            catch (error) { await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item))); throw error; }
          }
          await audit(db, user.id, 'account.email.change.request', 'user', user.id, { email, verificationRequired: result.verificationRequired }, req);
          return json(res, result.verificationRequired ? 202 : 200, result,
            result.relogin ? { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } : {});
        }

        if (url.pathname === '/api/account/email/change/confirm' && req.method === 'POST') {
          const result = await confirmEmailChange({ db, config, user, body: await readBody(req) });
          await audit(db, user.id, 'account.email.change.confirm', 'user', user.id, { email: result.email }, req);
          return json(res, 200, result, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
        }

        if (url.pathname === '/api/account/closure' && req.method === 'GET') {
          if (user.role !== 'user') return json(res, 403, { error: '管理员账号不能自助注销' });
          return json(res, 200, await accountClosureStatus(db, user.id));
        }

        if (url.pathname === '/api/account' && req.method === 'DELETE') {
          const result = await closeAccount({ db, config, user, body: await readBody(req) });
          await audit(db, user.id, 'account.close', 'user', user.id, null, req);
          return json(res, 200, result, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
        }

        if (url.pathname === '/api/admin/settings' && user.role === 'admin') {
          if (req.method === 'GET') return json(res, 200, { settings: await getRuntimeSettings(db, config) });
          if (req.method === 'PUT') {
            if (!isSuperAdmin(user)) return json(res, 403, { error: '仅超级管理员可修改运行参数' });
            const settings = await updateRuntimeSettings(db, config, user.id, await readBody(req), mailer);
            if (billing) billing.renewalGraceDays = settings.renewalGraceDays;
            await audit(db, user.id, 'settings.update', 'settings', null, null, req);
            return json(res, 200, { settings });
          }
        }

        if (url.pathname === '/api/admin/settings/test-email' && req.method === 'POST' && user.role === 'admin') {
          if (!isSuperAdmin(user)) return json(res, 403, { error: '仅超级管理员可测试邮件配置' });
          const settings = await getRuntimeSettings(db, config); const body = await readBody(req); const key = req.socket.remoteAddress || 'unknown';
          await verifyTurnstile(db, config, body.turnstileToken, key, turnstileFetch);
          if (!mailer?.available) throw Object.assign(new Error('邮件服务未配置'), { status: 503 });
          const email = normalizeEmail(body.email || user.email || settings.supportEmail); const claims = await reserveVerificationSend(settings, email, key);
          try {
            await mailer.verify(); await mailer.sendText({ email, subject: '邮件配置测试', text: '邮件服务配置有效，这是一封测试邮件。', siteName: settings.siteName });
          } catch (error) { await Promise.all(claims.map(item => releaseCooldown(cache, verificationCooldowns, item))); throw error; }
          await audit(db, user.id, 'settings.email.test', 'settings', null, { email }, req);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === '/api/admin/settings/test-turnstile' && req.method === 'POST' && user.role === 'admin') {
          if (!isSuperAdmin(user)) return json(res, 403, { error: '仅超级管理员可测试 Turnstile 配置' });
          const body = await readBody(req); await testTurnstileConfiguration(db, config, body.turnstileToken, req.socket.remoteAddress, turnstileFetch, user.id);
          await audit(db, user.id, 'settings.turnstile.test', 'settings', null, null, req);
          return json(res, 200, { ok: true });
        }

        const securityResult = await handleAdminSecurityApi({ req, url, user, db, tokenHash: currentTokenHash, readBody: () => readBody(req) });
        if (securityResult) {
          if (securityResult.action) await audit(db, user.id, securityResult.action, 'security', securityResult.resourceId, null, req);
          return json(res, securityResult.status, securityResult.data);
        }

        const registrationSecurityResult = await handleRegistrationSecurityApi({ req, url, user, db, readBody: () => readBody(req) });
        if (registrationSecurityResult) {
          if (registrationSecurityResult.action) await audit(db, user.id, registrationSecurityResult.action, 'security', registrationSecurityResult.resourceId, null, req);
          return json(res, registrationSecurityResult.status, registrationSecurityResult.data);
        }

        const mfaResult = await handleMfaApi({ req, url, user, db, config, readBody: () => readBody(req) });
        if (mfaResult) {
          if (mfaResult.action) await audit(db, user.id, mfaResult.action, 'security', mfaResult.resourceId, null, req);
          return json(res, mfaResult.status, mfaResult.data);
        }

        const userCompatResult = await handleUserCompatApi({ req, url, user, db, billing, config, readBody: () => readBody(req) });
        if (userCompatResult) {
          if (userCompatResult.action) await audit(db, user.id, userCompatResult.action, 'user', userCompatResult.resourceId, null, req);
          return userCompatResult.compat
            ? json(res, userCompatResult.status, {
              code: 0,
              msg: '',
              ...(userCompatResult.count === undefined ? {} : { count: userCompatResult.count }),
              data: userCompatResult.data,
            })
            : json(res, userCompatResult.status, userCompatResult.data);
        }

        const upstreamResult = await handleUpstreamApi({ req, url, user, db, upstreams, readBody: () => readBody(req) });
        if (upstreamResult) {
          if (upstreamResult.action) await audit(db, user.id, upstreamResult.action, 'upstream', upstreamResult.resourceId, null, req);
          return json(res, upstreamResult.status, upstreamResult.data);
        }

        const adminResult = await handleAdminApi({ req, url, user, db, cdnfly, upstreams, billing, readBody: () => readBody(req) });
        if (adminResult) {
          if (adminResult.action) await audit(db, user.id, adminResult.action, adminResult.action.startsWith('admin.site') ? 'site' : 'user', adminResult.resourceId, null, req);
          if (adminResult.download) {
            res.writeHead(adminResult.status, { 'content-type': adminResult.download.contentType, 'content-disposition': adminResult.download.disposition, 'cache-control': 'no-store' });
            return res.end(adminResult.download.buffer);
          }
          return json(res, adminResult.status, adminResult.data);
        }

        if (billing) {
          const walletResult = await handleWalletApi({ req, url, user, db, readBody: () => readBody(req) });
          if (walletResult) {
            if (walletResult.action) await audit(db, user.id, walletResult.action, 'wallet', walletResult.resourceId, null, req);
            if (walletResult.download) {
              res.writeHead(walletResult.status, { 'content-type': walletResult.download.contentType, 'content-disposition': walletResult.download.disposition, 'cache-control': 'no-store' });
              return res.end(walletResult.download.buffer);
            }
            return json(res, walletResult.status, walletResult.data);
          }
        }

        if (billing) {
          const redemptionResult = await handleRedemptionApi({ req, url, user, db, billing, readBody: () => readBody(req) });
          if (redemptionResult) {
            if (redemptionResult.action) await audit(db, user.id, redemptionResult.action, 'redemption', redemptionResult.resourceId, null, req);
            return json(res, redemptionResult.status, redemptionResult.data);
          }
        }

        if (billing) {
          const billingResult = await handleBillingApi({ req, url, user, db, billing, readBody: () => readBody(req) });
          if (billingResult) {
            if (billingResult.action) await audit(db, user.id, billingResult.action, 'billing', billingResult.resourceId, null, req);
            if (billingResult.download) {
              res.writeHead(billingResult.status, { 'content-type': billingResult.download.contentType, 'content-disposition': billingResult.download.disposition, 'cache-control': 'no-store' });
              return res.end(billingResult.download.buffer);
            }
            return billingResult.compat
              ? json(res, billingResult.status, { code: 0, msg: '', data: billingResult.data })
              : json(res, billingResult.status, billingResult.data);
          }
        }

        if (url.pathname.startsWith('/api/cdnfly/v1')) {
          const context = { req, url, user, db, cdnfly, upstreams, billing, readBody: () => readBody(req), dnsResolveCname };
          const result = await handleDataProxy(context) || await handleTenantProxy(context);
          if (!result) return json(res, 404, { error: '当前接口不支持此操作' });
          if (result.download) {
            res.writeHead(result.status, {
              'content-type': result.download.contentType,
              'content-disposition': result.download.disposition,
              'cache-control': 'no-store',
            });
            return res.end(result.download.buffer);
          }
          if (result.action) await audit(db, user.id, result.action, 'cdnfly-resource', result.resourceId, null, req);
          return json(res, result.status, { code: 0, msg: '', data: result.data });
        }

        if (url.pathname === '/api/sites' && req.method === 'GET') {
          const rows = await db.prepare(`SELECT s.*, p.name AS plan_name FROM sites s
            LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id
            WHERE s.owner_id = ? ORDER BY s.id DESC`).all(user.id);
          await syncSiteCnames(db, rows, upstreams, cdnfly);
          return json(res, 200, { sites: rows.map(presentSite) });
        }

        if (url.pathname === '/api/sites' && req.method === 'POST') {
          const body = await readBody(req);
          const requestedGroupId = body.groupId === '' || body.groupId === null || body.groupId === undefined ? null : Number(body.groupId);
          if (requestedGroupId !== null && (!Number.isInteger(requestedGroupId) || !await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(requestedGroupId, user.id))) {
            return json(res, 404, { error: '网站分组不存在' });
          }
          const defaulted = await applyUserDefaults(db, user.id, 'site', requestedGroupId, body);
          const input = validateSiteInput(defaulted);
          if (input.backendProtocol === undefined && ['http', 'https'].includes(defaulted.backend_protocol)) input.backendProtocol = defaulted.backend_protocol;
          if (input.websocket === undefined && defaulted.websocket_enable !== undefined) input.websocket = Boolean(Number(defaulted.websocket_enable));
          if (input.gzip === undefined && defaulted.gzip_enable !== undefined) input.gzip = Boolean(Number(defaulted.gzip_enable));
          const current = (await db.prepare('SELECT COUNT(*) AS count FROM sites WHERE owner_id = ?').get(user.id)).count;
          const subscription = billing ? await billing.resolveSubscription(user.id, body.subscriptionId, { requireExplicit: true }) : null;
          if (billing) await billing.assertProjected(user.id, {
            domains: 1, ports: tenantProxyInternals.countCustomSitePorts(defaulted),
          }, subscription.id);
          else if (current >= user.site_limit) return json(res, 409, { error: '站点额度已用完，请联系管理员' });
          const duplicate = await db.prepare('SELECT id FROM sites WHERE domain = ?').get(input.domain);
          if (duplicate) return json(res, 409, { error: '域名已存在' });
          const upstreamClient = upstreams && subscription ? await upstreams.clientForSubscription(subscription) : cdnfly;
          const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, user.id);
          const pending = await db.prepare(`INSERT INTO sites (owner_id, subscription_id, upstream_account_id, local_group_id, domain, origin, backend_protocol, backend_host, websocket, gzip, enabled, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'provisioning')`)
            .run(user.id, subscription?.id || null, subscription?.upstream_id || null, requestedGroupId, input.domain, input.origin, input.backendProtocol || 'http', input.backendHost || input.domain, Number(Boolean(input.websocket)), Number(Boolean(input.gzip)));
          try {
            const upstream = await upstreamClient.createSite({ ...defaulted, ...input,
              ...(customerGroups?.site ? { groups: String(customerGroups.site.upstream_group_id) } : {}) });
            await db.prepare(`UPDATE sites SET upstream_id = ?, state = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(upstream.id, pending.lastInsertRowid);
            if (billing) await billing.syncSitePorts(Number(pending.lastInsertRowid), defaulted);
            const createdRows = await db.prepare('SELECT * FROM sites WHERE id=? AND owner_id=?').all(Number(pending.lastInsertRowid), user.id);
            await syncSiteCnames(db, createdRows, upstreams, cdnfly);
            await audit(db, user.id, 'site.create', 'site', pending.lastInsertRowid, { domain: input.domain }, req);
            const site = await db.prepare(`SELECT s.*, p.name AS plan_name FROM sites s LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id WHERE s.id = ?`).get(pending.lastInsertRowid);
            return json(res, 201, { site: presentSite(site) });
          } catch (error) {
            await db.prepare('DELETE FROM sites WHERE id = ?').run(pending.lastInsertRowid);
            throw error;
          }
        }

        const siteMatch = url.pathname.match(/^\/api\/sites\/(\d+)$/);
        if (siteMatch) {
          const site = await ownedSite(db, siteMatch[1], user);
          if (!site) return json(res, 404, { error: '站点不存在' });
          if (req.method === 'GET') {
            let upstream = null;
            const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
            if (site.upstream_id) {
              const detail = await upstreamClient.getSite(site.upstream_id);
              upstream = detail && typeof detail === 'object' ? { ...detail, groups: site.local_group_id || '' } : detail;
            }
            const cname = await tenantProxyInternals.resolveCompleteCname(upstreamClient, upstream, site.cname, upstream);
            if (cname !== site.cname) {
              await db.prepare('UPDATE sites SET cname=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(cname || null, site.id);
              site.cname = cname || null;
            }
            return json(res, 200, { site: presentSite({ ...site, cname: cname || site.cname }), upstream });
          }
          if (req.method === 'PUT') {
            const body = await readBody(req); const input = validateSiteInput(body, true);
            delete input.domain;
            let localGroupId = site.local_group_id;
            if (Object.hasOwn(body, 'groupId')) {
              localGroupId = body.groupId === '' || body.groupId === null ? null : Number(body.groupId);
              if (localGroupId !== null && (!Number.isInteger(localGroupId) || !await db.prepare('SELECT id FROM customer_site_groups WHERE id=? AND user_id=?').get(localGroupId, user.id))) {
                return json(res, 404, { error: '网站分组不存在' });
              }
            }
            let subscriptionId = site.subscription_id;
            if (billing && body.subscriptionId !== undefined && Number(body.subscriptionId) !== Number(site.subscription_id)) {
              const target = await billing.resolveSubscription(user.id, body.subscriptionId); await billing.assertProjected(user.id, { domains: 1 }, target.id);
              if (Number(target.upstream_id || 0) !== Number(site.upstream_account_id || 0)) return json(res, 409, { error: '网站不能直接迁移到其他 CDN 服务，请在目标套餐下重新创建' });
              subscriptionId = target.id;
            }
            if (billing && input.enabled) await billing.assertProjected(user.id, {}, subscriptionId);
            const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
            const customerGroups = await ensureCustomerUpstreamGroups(db, upstreamClient, user.id);
            await upstreamClient.updateSite(site.upstream_id, { ...input,
              ...(customerGroups?.site ? { groups: String(customerGroups.site.upstream_group_id) } : {}) });
            const nextEnabled = input.enabled === undefined ? site.enabled : Number(input.enabled);
            const nextState = input.enabled === undefined ? site.state : (input.enabled ? 'active' : 'inactive');
            await db.prepare(`UPDATE sites SET origin = COALESCE(?, origin), backend_protocol = COALESCE(?, backend_protocol),
              backend_host = COALESCE(?, backend_host), websocket = COALESCE(?, websocket), gzip = COALESCE(?, gzip),
              subscription_id = ?, local_group_id = ?, enabled = ?, state = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(input.origin ?? null, input.backendProtocol ?? null, input.backendHost ?? null,
                input.websocket === undefined ? null : Number(input.websocket), input.gzip === undefined ? null : Number(input.gzip),
                subscriptionId, localGroupId, nextEnabled, nextState, site.id);
            if (input.enabled !== undefined) await db.prepare("UPDATE quota_suspensions SET restored_at=CURRENT_TIMESTAMP WHERE user_id=? AND resource_kind='site' AND resource_id=? AND restored_at IS NULL").run(user.id, site.id);
            if (billing) await billing.enforceUser(user.id, { syncTraffic: false });
            await audit(db, user.id, 'site.update', 'site', site.id, Object.keys(input), req);
            return json(res, 200, { site: presentSite(await db.prepare(`SELECT s.*, p.name AS plan_name FROM sites s LEFT JOIN subscriptions sub ON sub.id=s.subscription_id LEFT JOIN plans p ON p.id=sub.plan_id WHERE s.id = ?`).get(site.id)) });
          }
          if (req.method === 'DELETE') {
            if (site.enabled) return json(res, 409, { error: '请先停用站点再删除' });
            const upstreamClient = upstreams ? await upstreams.clientForSite(site) : cdnfly;
            await upstreamClient.deleteSite(site.upstream_id);
            await db.prepare('DELETE FROM sites WHERE id = ? AND owner_id = ?').run(site.id, user.id);
            if (billing) await billing.enforceUser(user.id, { syncTraffic: false });
            await audit(db, user.id, 'site.delete', 'site', site.id, { domain: site.domain }, req);
            return json(res, 200, { ok: true });
          }
        }

        if (url.pathname.startsWith('/api/admin/')) {
          if (user.role !== 'admin') return json(res, 403, { error: '无管理员权限' });
          if (url.pathname === '/api/admin/users' && req.method === 'GET') {
            const users = await db.prepare(`SELECT u.*, COUNT(s.id) AS site_count FROM users u LEFT JOIN sites s ON s.owner_id = u.id GROUP BY u.id ORDER BY u.id DESC`).all();
            return json(res, 200, { users: users.map(row => ({ ...publicUser(row), siteCount: row.site_count })) });
          }
          if (url.pathname === '/api/admin/users' && req.method === 'POST') {
            const body = await readBody(req);
            const username = validateUsername(body.username);
            const siteLimit = Number.parseInt(body.siteLimit ?? 0, 10);
            if (!Number.isInteger(siteLimit) || siteLimit < 0 || siteLimit > 10000) throw new Error('站点额度无效');
            try {
              const result = await db.prepare(`INSERT INTO users (username, password_hash, role, site_limit) VALUES (?, ?, 'user', ?)`)
                .run(username, hashPassword(body.password || ''), siteLimit);
              await db.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING').run(result.lastInsertRowid);
              await audit(db, user.id, 'user.create', 'user', result.lastInsertRowid, { username, siteLimit }, req);
              return json(res, 201, { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid)) });
            } catch (error) {
              if (error.code === '23505' || /unique|duplicate/i.test(error.message || '')) return json(res, 409, { error: '用户名已存在' });
              throw error;
            }
          }
          const userMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
          if (userMatch && req.method === 'PUT') {
            const targetId = Number(userMatch[1]);
            const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
            if (!target || target.role === 'admin') return json(res, 404, { error: '用户不存在' });
            const body = await readBody(req);
            const status = body.status === undefined ? target.status : body.status;
            const siteLimit = body.siteLimit === undefined ? target.site_limit : Number.parseInt(body.siteLimit, 10);
            if (!['active', 'disabled'].includes(status) || !Number.isInteger(siteLimit) || siteLimit < 0 || siteLimit > 10000) throw new Error('用户配置无效');
            await db.prepare('UPDATE users SET status = ?, site_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, siteLimit, targetId);
            if (status === 'disabled') await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
            await audit(db, user.id, 'user.update', 'user', targetId, { status, siteLimit }, req);
            return json(res, 200, { user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(targetId)) });
          }
          if (url.pathname === '/api/admin/audit' && req.method === 'GET') {
            const { page, pageSize, offset } = pagination(url); const clauses = ['1=1']; const params = [];
            const q = url.searchParams.get('q'); const action = url.searchParams.get('action'); const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
            if (q) { clauses.push('(u.username LIKE ? OR a.resource_id LIKE ? OR a.resource_type LIKE ? OR a.detail LIKE ? OR a.ip LIKE ?)'); const like = searchLike(q); params.push(like, like, like, like, like); }
            if (action) { clauses.push('a.action=?'); params.push(action); }
            if (from) { clauses.push('a.created_at>=?'); params.push(from); }
            if (to) { clauses.push('a.created_at<?'); params.push(to); }
            const where = clauses.join(' AND ');
            const total = (await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ${where}`).get(...params)).count;
            const logs = await db.prepare(`SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
            return json(res, 200, paged(logs.map(log => ({ id: log.id, username: log.username || '-', action: log.action, resourceType: log.resource_type, resourceId: log.resource_id, detail: log.detail, ip: log.ip, createdAt: log.created_at })), total, page, pageSize, 'logs'));
          }
          if (url.pathname === '/api/admin/health' && req.method === 'GET') {
            const result = await adminHealthStatus({ fresh: url.searchParams.get('fresh') === '1' });
            return json(res, result.status === 'unhealthy' ? 207 : 200, result);
          }
        }

        return json(res, 404, { error: '接口不存在' });
      }

      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const filename = path.resolve(PUBLIC_DIR, `.${requested}`);
      if (!filename.startsWith(PUBLIC_DIR) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
        const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        return res.end(index);
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(filename)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(filename).pipe(res);
    } catch (error) {
      const known = error instanceof CdnflyError;
      const status = error.status || (known ? 502 : 400);
      if (status >= 500 && status !== 501) console.error(error);
      json(res, status, { error: error.message || '服务器错误', ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        ...(error.detail ? { detail: error.detail } : {}), ...(known && error.upstreamCode !== null ? { upstreamCode: error.upstreamCode } : {}) });
    }
  };
}

export const appInternals = { summarizeUpstreamHealth };
