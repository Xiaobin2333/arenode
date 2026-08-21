import crypto from 'node:crypto';
import { DEFAULT_ALLOWED_EMAIL_DOMAINS, normalizeAllowedEmailDomains } from './email-policy.js';
import { BRAND_NAME, BRAND_SUBTITLE } from './brand.js';

const PUBLIC_KEYS = new Set([
  'siteName', 'siteSubtitle', 'announcementEnabled', 'announcementTitle', 'announcementBody',
  'announcementSeverity', 'announcementAudience', 'announcementStartsAt', 'announcementEndsAt',
  'announcementMode', 'announcementDismissible', 'announcementVersion',
  'supportEmail', 'registrationEnabled', 'emailVerificationEnabled', 'turnstileEnabled', 'turnstileSiteKey',
  'emailCodeCooldownSeconds', 'maintenanceMode', 'inviteOnly', 'termsTitle', 'termsBody', 'privacyTitle', 'privacyBody',
  'legalConsentRequired', 'allowedEmailDomains',
]);

const KEY_MAP = {
  siteName: 'site_name', siteSubtitle: 'site_subtitle', announcementEnabled: 'announcement_enabled',
  announcementTitle: 'announcement_title', announcementBody: 'announcement_body', supportEmail: 'support_email',
  registrationEnabled: 'registration_enabled', emailVerificationEnabled: 'email_verification_enabled',
  turnstileEnabled: 'turnstile_enabled', turnstileSiteKey: 'turnstile_site_key',
  emailCodeCooldownSeconds: 'email_code_cooldown_seconds', emailCodeHourlyLimit: 'email_code_hourly_limit',
  announcementSeverity: 'announcement_severity', announcementAudience: 'announcement_audience',
  announcementStartsAt: 'announcement_starts_at', announcementEndsAt: 'announcement_ends_at',
  announcementMode: 'announcement_mode', announcementDismissible: 'announcement_dismissible', announcementVersion: 'announcement_version',
  maintenanceMode: 'maintenance_mode', inviteOnly: 'invite_only', termsTitle: 'terms_title', termsBody: 'terms_body',
  privacyTitle: 'privacy_title', privacyBody: 'privacy_body', renewalGraceDays: 'renewal_grace_days',
  allowedEmailDomains: 'allowed_email_domains', legalConsentRequired: 'legal_consent_required',
};

function defaults(config) {
  return {
    siteName: BRAND_NAME,
    siteSubtitle: BRAND_SUBTITLE,
    announcementEnabled: false,
    announcementTitle: '服务运行正常',
    announcementBody: '暂无需要处理的平台公告',
    announcementSeverity: 'info',
    announcementAudience: 'all',
    announcementStartsAt: '',
    announcementEndsAt: '',
    announcementMode: 'banner',
    announcementDismissible: true,
    announcementVersion: '',
    supportEmail: '',
    registrationEnabled: config.allowRegistration !== false,
    emailVerificationEnabled: config.emailVerificationEnabled === true,
    turnstileEnabled: false,
    turnstileSiteKey: '',
    turnstileConfigured: false,
    emailCodeCooldownSeconds: config.authCodeCooldownSeconds || 60,
    emailCodeHourlyLimit: config.authCodeHourlyLimit || 5,
    maintenanceMode: false,
    inviteOnly: false,
    termsTitle: '服务条款',
    termsBody: '使用本服务即表示您同意遵守适用法律法规，不得利用平台从事违法活动。',
    privacyTitle: '隐私政策',
    privacyBody: '平台仅收集提供账号、计费、安全和服务运营所必需的信息。',
    renewalGraceDays: 3,
    allowedEmailDomains: normalizeAllowedEmailDomains(config.allowedEmailDomains || DEFAULT_ALLOWED_EMAIL_DOMAINS.join('\n')),
    legalConsentRequired: config.requireLegalConsent === true,
  };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function encryptionKey(config) {
  if (!config.settingsEncryptionKey) return null;
  return crypto.createHash('sha256').update(config.settingsEncryptionKey).digest();
}

function encryptSecret(value, config) {
  const key = encryptionKey(config);
  if (!key) throw Object.assign(new Error('未配置 SETTINGS_ENCRYPTION_KEY，不能保存 Turnstile 私钥'), { status: 503 });
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSecret(value, config) {
  if (!value) return '';
  const key = encryptionKey(config); if (!key) return '';
  try {
    const [version, iv, tag, encrypted] = String(value).split(':'); if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function turnstileFingerprint(siteKey, secret) {
  if (!siteKey || !secret) return '';
  return crypto.createHash('sha256').update(`${siteKey}\0${secret}`).digest('hex');
}

export async function getRuntimeSettings(db, config) {
  const values = defaults(config);
  const rows = await db.prepare('SELECT key, value FROM app_settings').all();
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value]));
  for (const [name, key] of Object.entries(KEY_MAP)) {
    if (stored[key] === undefined) continue;
    values[name] = ['announcementEnabled', 'announcementDismissible', 'registrationEnabled', 'emailVerificationEnabled', 'turnstileEnabled', 'maintenanceMode', 'inviteOnly', 'legalConsentRequired'].includes(name)
      ? parseBoolean(stored[key], values[name])
      : ['emailCodeCooldownSeconds', 'emailCodeHourlyLimit', 'renewalGraceDays'].includes(name) ? Number(stored[key]) : stored[key];
  }
  values.turnstileConfigured = Boolean(decryptSecret(stored.turnstile_secret, config));
  const secret = decryptSecret(stored.turnstile_secret, config);
  values.turnstileVerified = Boolean(stored.turnstile_tested_fingerprint
    && stored.turnstile_tested_fingerprint === turnstileFingerprint(values.turnstileSiteKey, secret));
  values.turnstileTestedAt = values.turnstileVerified ? (stored.turnstile_tested_at || '') : '';
  if (!values.turnstileSiteKey || !values.turnstileConfigured || !values.turnstileVerified) values.turnstileEnabled = false;
  return values;
}

function announcementState(settings, now = new Date()) {
  if (!settings.announcementEnabled) return 'disabled';
  if (settings.announcementStartsAt && new Date(settings.announcementStartsAt) > now) return 'scheduled';
  if (settings.announcementEndsAt && new Date(settings.announcementEndsAt) <= now) return 'ended';
  return 'active';
}

export function publicRuntimeSettings(settings, mailer, role = null) {
  const now = new Date();
  const state = announcementState(settings, now);
  const target = role === 'admin' ? 'admins' : role === 'user' ? 'customers' : 'public';
  return {
    ...Object.fromEntries([...PUBLIC_KEYS].map(key => [key, settings[key]])),
    announcementEnabled: Boolean(state === 'active' && ['all', target].includes(settings.announcementAudience)),
    announcementStatus: state,
    emailServiceAvailable: Boolean(mailer?.available),
  };
}

function cleanText(value, name, max, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw Object.assign(new Error(`${name}不能为空`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${name}不能超过 ${max} 个字符`), { status: 400 });
  return text;
}

function boundedInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw Object.assign(new Error(`${name}必须为 ${min}-${max} 的整数`), { status: 400 });
  return number;
}

export async function updateRuntimeSettings(db, config, actorId, body, mailer = null) {
  const current = await getRuntimeSettings(db, config);
  const next = {
    siteName: cleanText(body.siteName ?? current.siteName, '站点名称', 60, { required: true }),
    siteSubtitle: cleanText(body.siteSubtitle ?? current.siteSubtitle, '站点说明', 160),
    announcementEnabled: body.announcementEnabled === undefined ? current.announcementEnabled : Boolean(body.announcementEnabled),
    announcementTitle: cleanText(body.announcementTitle ?? current.announcementTitle, '公告标题', 120),
    announcementBody: cleanText(body.announcementBody ?? current.announcementBody, '公告内容', 1000),
    announcementSeverity: ['info', 'success', 'warning', 'critical'].includes(body.announcementSeverity ?? current.announcementSeverity) ? (body.announcementSeverity ?? current.announcementSeverity) : 'info',
    announcementAudience: ['all', 'public', 'customers', 'admins'].includes(body.announcementAudience ?? current.announcementAudience) ? (body.announcementAudience ?? current.announcementAudience) : 'all',
    announcementStartsAt: cleanText(body.announcementStartsAt ?? current.announcementStartsAt, '公告开始时间', 40),
    announcementEndsAt: cleanText(body.announcementEndsAt ?? current.announcementEndsAt, '公告结束时间', 40),
    announcementMode: ['banner', 'modal'].includes(body.announcementMode ?? current.announcementMode) ? (body.announcementMode ?? current.announcementMode) : 'banner',
    announcementDismissible: body.announcementDismissible === undefined ? current.announcementDismissible : Boolean(body.announcementDismissible),
    supportEmail: cleanText(body.supportEmail ?? current.supportEmail, '联系邮箱', 254),
    registrationEnabled: body.registrationEnabled === undefined ? current.registrationEnabled : Boolean(body.registrationEnabled),
    emailVerificationEnabled: body.emailVerificationEnabled === undefined ? current.emailVerificationEnabled : Boolean(body.emailVerificationEnabled),
    turnstileEnabled: body.turnstileEnabled === undefined ? current.turnstileEnabled : Boolean(body.turnstileEnabled),
    turnstileSiteKey: cleanText(body.turnstileSiteKey ?? current.turnstileSiteKey, 'Turnstile 站点密钥', 180),
    emailCodeCooldownSeconds: boundedInteger(body.emailCodeCooldownSeconds ?? current.emailCodeCooldownSeconds, '验证码发送间隔', 10, 3600),
    emailCodeHourlyLimit: boundedInteger(body.emailCodeHourlyLimit ?? current.emailCodeHourlyLimit, '验证码每小时上限', 1, 100),
    maintenanceMode: body.maintenanceMode === undefined ? current.maintenanceMode : Boolean(body.maintenanceMode),
    inviteOnly: body.inviteOnly === undefined ? current.inviteOnly : Boolean(body.inviteOnly),
    termsTitle: cleanText(body.termsTitle ?? current.termsTitle, '服务条款标题', 80, { required: true }),
    termsBody: cleanText(body.termsBody ?? current.termsBody, '服务条款', 10000, { required: true }),
    privacyTitle: cleanText(body.privacyTitle ?? current.privacyTitle, '隐私政策标题', 80, { required: true }),
    privacyBody: cleanText(body.privacyBody ?? current.privacyBody, '隐私政策', 10000, { required: true }),
    legalConsentRequired: body.legalConsentRequired === undefined ? current.legalConsentRequired : Boolean(body.legalConsentRequired),
    renewalGraceDays: boundedInteger(body.renewalGraceDays ?? current.renewalGraceDays, '续费宽限期', 0, 30),
    allowedEmailDomains: normalizeAllowedEmailDomains(cleanText(body.allowedEmailDomains ?? current.allowedEmailDomains, '电子邮件域白名单', 5000)),
  };
  if (next.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.supportEmail)) throw Object.assign(new Error('联系邮箱格式无效'), { status: 400 });
  for (const [name, value] of [['公告开始时间', next.announcementStartsAt], ['公告结束时间', next.announcementEndsAt]]) if (value && !Number.isFinite(new Date(value).getTime())) throw Object.assign(new Error(`${name}无效`), { status: 400 });
  if (next.announcementStartsAt && next.announcementEndsAt && new Date(next.announcementEndsAt) <= new Date(next.announcementStartsAt)) throw Object.assign(new Error('公告结束时间必须晚于开始时间'), { status: 400 });
  const announcementFields = ['announcementEnabled', 'announcementTitle', 'announcementBody', 'announcementSeverity', 'announcementAudience', 'announcementStartsAt', 'announcementEndsAt', 'announcementMode', 'announcementDismissible'];
  next.announcementVersion = announcementFields.some(name => String(next[name]) !== String(current[name]))
    ? `${Date.now()}` : (current.announcementVersion || `${Date.now()}`);
  if (next.emailVerificationEnabled && !mailer?.available) throw Object.assign(new Error('启用注册邮箱验证前必须先配置邮件服务'), { status: 400 });
  const secretRow = await db.prepare("SELECT value FROM app_settings WHERE key='turnstile_secret'").get();
  const currentSecret = decryptSecret(secretRow?.value, config);
  const nextSecret = Object.hasOwn(body, 'turnstileSecret') ? String(body.turnstileSecret || '').trim() : currentSecret;
  if (next.turnstileEnabled && (!next.turnstileSiteKey || !nextSecret)) throw Object.assign(new Error('启用 Turnstile 前必须配置站点密钥和私钥'), { status: 400 });
  const testedRow = await db.prepare("SELECT value FROM app_settings WHERE key='turnstile_tested_fingerprint'").get();
  const nextFingerprint = turnstileFingerprint(next.turnstileSiteKey, nextSecret);
  if (next.turnstileEnabled && testedRow?.value !== nextFingerprint) {
    throw Object.assign(new Error('启用 Turnstile 前必须先保存密钥并完成配置测试'), { status: 409 });
  }
  const upsert = db.prepare(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`);
  for (const [name, key] of Object.entries(KEY_MAP)) await upsert.run(key, String(next[name]), actorId);
  if (Object.hasOwn(body, 'turnstileSecret')) {
    const secret = String(body.turnstileSecret || '').trim();
    if (secret) await upsert.run('turnstile_secret', encryptSecret(secret, config), actorId);
    else await db.prepare("DELETE FROM app_settings WHERE key='turnstile_secret'").run();
  }
  if (nextFingerprint !== turnstileFingerprint(current.turnstileSiteKey, currentSecret)) {
    await db.prepare("DELETE FROM app_settings WHERE key IN ('turnstile_tested_fingerprint','turnstile_tested_at')").run();
  }
  return getRuntimeSettings(db, config);
}

export async function verifyTurnstile(db, config, token, ip, fetchImpl = fetch) {
  const settings = await getRuntimeSettings(db, config);
  if (!settings.turnstileEnabled) return true;
  if (!token) throw Object.assign(new Error('请完成人机验证'), { status: 400 });
  const secretRow = await db.prepare("SELECT value FROM app_settings WHERE key='turnstile_secret'").get();
  const secret = decryptSecret(secretRow?.value, config);
  if (!secret) throw Object.assign(new Error('Turnstile 服务未完整配置'), { status: 503 });
  const payload = new URLSearchParams({ secret, response: String(token) }); if (ip) payload.set('remoteip', ip);
  let result;
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: payload });
    result = await response.json();
  } catch { throw Object.assign(new Error('人机验证服务暂时不可用'), { status: 503 }); }
  if (!result?.success) throw Object.assign(new Error('人机验证未通过，请重试'), { status: 400 });
  return true;
}

export async function testTurnstileConfiguration(db, config, token, ip, fetchImpl = fetch, actorId = null) {
  if (!token) throw Object.assign(new Error('请先完成人机验证测试'), { status: 400 });
  const secretRow = await db.prepare("SELECT value FROM app_settings WHERE key='turnstile_secret'").get();
  const secret = decryptSecret(secretRow?.value, config);
  if (!secret) throw Object.assign(new Error('Turnstile 私钥未配置'), { status: 503 });
  const payload = new URLSearchParams({ secret, response: String(token) }); if (ip) payload.set('remoteip', ip);
  const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: payload });
  const result = await response.json();
  if (!result?.success) throw Object.assign(new Error('Turnstile 配置测试失败'), { status: 400 });
  const settings = await getRuntimeSettings(db, config);
  if (!settings.turnstileSiteKey) throw Object.assign(new Error('Turnstile Site Key 未配置'), { status: 400 });
  const fingerprint = turnstileFingerprint(settings.turnstileSiteKey, secret);
  const upsert = db.prepare(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`);
  const testedAt = new Date().toISOString();
  await upsert.run('turnstile_tested_fingerprint', fingerprint, actorId);
  await upsert.run('turnstile_tested_at', testedAt, actorId);
  return { testedAt };
}

export const settingsInternals = { encryptSecret, decryptSecret, turnstileFingerprint, announcementState };
