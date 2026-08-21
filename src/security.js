import crypto from 'node:crypto';

const KEY_LENGTH = 64;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    throw new Error('密码长度必须为 10-200 个字符');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, saltText, hashText] = String(encoded).split(':');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) {
    throw new Error('用户名须为 3-32 位字母、数字、点、下划线或连字符');
  }
  return username;
}
