import crypto from 'node:crypto';

function intEnv(name, fallback, min = 0) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} 配置无效`);
  return value;
}

function boolEnv(name, fallback) {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} 配置无效`);
}

export function normalizeUpstreamGroupNamespace(value) {
  const normalized = String(value || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (!normalized || normalized.length > 40) throw new Error('UPSTREAM_GROUP_NAMESPACE 配置无效');
  return normalized;
}

export function opaqueUpstreamGroupNamespace(value) {
  const source = String(value || '').trim();
  if (!source || source.length > 240) throw new Error('UPSTREAM_GROUP_NAMESPACE 配置无效');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12).toUpperCase();
  return `S-${hash}`;
}

function defaultUpstreamGroupNamespace(appOrigin) {
  return opaqueUpstreamGroupNamespace(appOrigin || 'local');
}

export function loadConfig(overrides = {}) {
  const appOrigin = overrides.appOrigin ?? process.env.APP_ORIGIN ?? 'http://localhost:3080';
  const namespaceSource = overrides.upstreamGroupNamespace ?? process.env.UPSTREAM_GROUP_NAMESPACE;
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const config = {
    port: intEnv('PORT', 3080, 1),
    databaseUrl: process.env.DATABASE_URL || 'postgres://cdnfly:change-this-database-password@localhost:5432/cdnfly_reseller',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    cdnflyBaseUrl: (process.env.CDNFLY_BASE_URL || '').replace(/\/$/, ''),
    cdnflyApiKey: process.env.CDNFLY_API_KEY || '',
    cdnflyApiSecret: process.env.CDNFLY_API_SECRET || '',
    cdnflyUserPackageId: intEnv('CDNFLY_USER_PACKAGE_ID', 0),
    cdnflyCnameSuffix: process.env.CDNFLY_CNAME_SUFFIX || '',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionHours: intEnv('SESSION_HOURS', 24, 1),
    allowRegistration: boolEnv('ALLOW_REGISTRATION', false),
    emailVerificationEnabled: boolEnv('EMAIL_VERIFICATION_ENABLED', false),
    requireLegalConsent: boolEnv('REQUIRE_LEGAL_CONSENT', true),
    authCodeMinutes: intEnv('AUTH_CODE_MINUTES', 10, 1),
    authCodeCooldownSeconds: intEnv('AUTH_CODE_COOLDOWN_SECONDS', 60, 10),
    authCodeHourlyLimit: intEnv('AUTH_CODE_HOURLY_LIMIT', 5, 1),
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: intEnv('SMTP_PORT', 587, 1),
    smtpSecure: boolEnv('SMTP_SECURE', false),
    smtpUser: process.env.SMTP_USER || '',
    smtpPassword: process.env.SMTP_PASSWORD || '',
    smtpFrom: process.env.SMTP_FROM || 'noreply@localhost',
    // Verification codes may only be returned by an explicitly configured
    // development process. A stale production environment variable must
    // never turn the password-reset endpoint into a code disclosure API.
    mailDevExposeCode: !production && boolEnv('MAIL_DEV_EXPOSE_CODE', false),
    settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || '',
    upstreamTimeoutMs: intEnv('UPSTREAM_TIMEOUT_MS', 15000, 1000),
    cdnflyCacheTtlSeconds: intEnv('CDNFLY_CACHE_TTL_SECONDS', 30, 1),
    cdnflyMonitorCacheTtlSeconds: intEnv('CDNFLY_MONITOR_CACHE_TTL_SECONDS', 8, 1),
    cdnflyRequestsPerMinute: intEnv('CDNFLY_REQUESTS_PER_MINUTE', 300, 1),
    ...overrides,
    appOrigin,
    upstreamGroupNamespace: namespaceSource
      ? opaqueUpstreamGroupNamespace(namespaceSource)
      : defaultUpstreamGroupNamespace(appOrigin),
  };
  return config;
}

export const configInternals = { defaultUpstreamGroupNamespace, opaqueUpstreamGroupNamespace };

export function assertProductionConfig(config) {
  if (String(config.settingsEncryptionKey || '').length < 32) {
    throw new Error('SETTINGS_ENCRYPTION_KEY 至少需要 32 个字符');
  }
  if (/change-this|replace-with/i.test(String(config.databaseUrl || ''))) {
    throw new Error('DATABASE_URL 仍包含示例数据库密码');
  }
  if (config.adminPassword && String(config.adminPassword).length < 10) {
    throw new Error('ADMIN_PASSWORD 至少需要 10 个字符');
  }
  if (config.mailDevExposeCode) throw new Error('生产环境禁止 MAIL_DEV_EXPOSE_CODE');
  return true;
}
