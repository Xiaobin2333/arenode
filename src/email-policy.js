export const DEFAULT_ALLOWED_EMAIL_DOMAINS = Object.freeze([
  'gmail.com',
  '163.com',
  '126.com',
  'qq.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'yahoo.com',
  'foxmail.com',
]);

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseEmailDomains(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/)
    .map(item => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
}

export function normalizeAllowedEmailDomains(value) {
  const domains = parseEmailDomains(value);
  if (!domains.length) throw Object.assign(new Error('电子邮件域白名单至少需要一个域名'), { status: 400 });
  const invalid = domains.find(domain => !DOMAIN_PATTERN.test(domain));
  if (invalid) throw Object.assign(new Error(`电子邮件域名格式无效：${invalid}`), { status: 400 });
  return domains.join('\n');
}

export function emailDomain(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || '';
}
