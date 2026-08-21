import crypto from 'node:crypto';
import { hashPassword, validateUsername, verifyPassword } from './security.js';
import { createVirtualUser } from './admin-api.js';
import { consumeInvite } from './registration-security.js';

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError('邮箱格式无效');
  return email;
}

function codeDigest(config, email, code) {
  return crypto.createHash('sha256').update(`${config.settingsEncryptionKey || 'local'}:${email}:${String(code)}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function validateCode(value) {
  const code = String(value || '').trim(); if (!/^\d{6}$/.test(code)) throw httpError('验证码格式无效'); return code;
}

export async function requestRegistration({ db, config, mailer, settings, body }) {
  if (!mailer?.available) throw httpError('邮件验证服务未配置，暂时不能自助注册', 503);
  const username = validateUsername(body.username); const email = normalizeEmail(body.email);
  const existing = await db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email);
  if (existing) throw httpError('用户名或邮箱已注册', 409);
  const code = generateCode(); const expires = new Date(Date.now() + config.authCodeMinutes * 60_000).toISOString();
  const acceptedAt = new Date().toISOString();
  await db.prepare(`INSERT INTO pending_registrations (email, username, password_hash, code_hash, expires_at, attempts, terms_accepted_at, privacy_accepted_at, invite_id, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET username=excluded.username, password_hash=excluded.password_hash,
      code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, terms_accepted_at=excluded.terms_accepted_at,
      privacy_accepted_at=excluded.privacy_accepted_at, invite_id=excluded.invite_id, updated_at=CURRENT_TIMESTAMP`)
    .run(email, username, hashPassword(body.password || ''), codeDigest(config, email, code), expires, acceptedAt, acceptedAt, body.inviteId || null);
  try {
    const sent = await mailer.sendCode({ email, code, purpose: 'registration', siteName: settings.siteName });
    return { email, expiresAt: expires, ...sent };
  } catch (error) {
    await db.prepare('DELETE FROM pending_registrations WHERE email=?').run(email); throw error;
  }
}

export async function requestRegistrationCode({ db, config, mailer, settings, email: emailValue }) {
  if (!mailer?.available) throw httpError('邮件验证服务未配置，暂时不能自助注册', 503);
  const email = normalizeEmail(emailValue);
  if (await db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw httpError('邮箱已注册', 409);
  const code = generateCode(); const expires = new Date(Date.now() + config.authCodeMinutes * 60_000).toISOString();
  const placeholder = `pending_${crypto.createHash('sha256').update(email).digest('hex').slice(0, 20)}`;
  await db.prepare(`INSERT INTO pending_registrations (email, username, password_hash, code_hash, expires_at, attempts, terms_accepted_at, privacy_accepted_at, invite_id, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET username=excluded.username, password_hash=excluded.password_hash,
      code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, terms_accepted_at=NULL,
      privacy_accepted_at=NULL, invite_id=NULL, updated_at=CURRENT_TIMESTAMP`)
    .run(email, placeholder, hashPassword(crypto.randomBytes(24).toString('base64url')), codeDigest(config, email, code), expires);
  try {
    const sent = await mailer.sendCode({ email, code, purpose: 'registration', siteName: settings.siteName });
    return { email, expiresAt: expires, ...sent };
  } catch (error) {
    await db.prepare('DELETE FROM pending_registrations WHERE email=?').run(email); throw error;
  }
}

export async function verifyRegistration({ db, config, billing, body }) {
  const email = normalizeEmail(body.email); const code = validateCode(body.code); let customer;
  const replacesPendingIdentity = body.username !== undefined || body.password !== undefined;
  if (replacesPendingIdentity && (body.username === undefined || body.password === undefined)) throw httpError('用户名和密码必须同时提供');
  const suppliedUsername = replacesPendingIdentity ? validateUsername(body.username) : null;
  const suppliedPasswordHash = replacesPendingIdentity ? hashPassword(body.password || '') : null;
  await db.transaction(async transaction => {
    const pending = await transaction.prepare('SELECT * FROM pending_registrations WHERE email=? FOR UPDATE').get(email);
    if (!pending || new Date(pending.expires_at) <= new Date()) throw httpError('验证码已过期，请重新获取', 409);
    if (pending.attempts >= 5) throw httpError('验证码尝试次数过多，请重新获取', 429);
    if (pending.code_hash !== codeDigest(config, email, code)) {
      await transaction.prepare('UPDATE pending_registrations SET attempts=attempts+1 WHERE email=?').run(email);
      throw httpError('验证码错误', 400);
    }
    const username = suppliedUsername || pending.username;
    const passwordHash = suppliedPasswordHash || pending.password_hash;
    const existing = await transaction.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email);
    if (existing) throw httpError('用户名或邮箱已注册', 409);
    const acceptedAt = replacesPendingIdentity ? new Date().toISOString() : null;
    const inviteId = body.inviteId ?? pending.invite_id;
    await consumeInvite(transaction, inviteId);
    customer = await createVirtualUser(transaction, null, { username, email, passwordHash, emailVerified: true,
      termsAcceptedAt: acceptedAt || pending.terms_accepted_at, privacyAcceptedAt: acceptedAt || pending.privacy_accepted_at });
    await transaction.prepare('INSERT INTO wallets (user_id, balance_cents) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING').run(customer.id);
    await transaction.prepare('DELETE FROM pending_registrations WHERE email=?').run(email);
  });
  await billing?.updateLegacySiteLimit(customer.id);
  return customer;
}

export async function registerWithoutVerification({ db, billing, body }) {
  const email = normalizeEmail(body.email);
  let customer;
  await db.transaction(async transaction => {
    await consumeInvite(transaction, body.inviteId);
    const acceptedAt = new Date().toISOString();
    customer = await createVirtualUser(transaction, null, { username: body.username, email, password: body.password, emailVerified: false,
      termsAcceptedAt: acceptedAt, privacyAcceptedAt: acceptedAt });
  });
  await billing?.updateLegacySiteLimit(customer.id);
  return customer;
}

export async function requestPasswordReset({ db, config, mailer, settings, body }) {
  if (!mailer?.available) throw httpError('邮件服务未配置，暂时不能找回密码', 503);
  const email = normalizeEmail(body.email); const user = await db.prepare("SELECT * FROM users WHERE email=? AND role='user' AND status='active'").get(email);
  if (!user) return { accepted: true };
  const code = generateCode(); const expires = new Date(Date.now() + config.authCodeMinutes * 60_000).toISOString();
  await db.prepare(`INSERT INTO password_reset_tokens (email, user_id, code_hash, expires_at, attempts, updated_at)
    VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET user_id=excluded.user_id, code_hash=excluded.code_hash,
      expires_at=excluded.expires_at, attempts=0, updated_at=CURRENT_TIMESTAMP`)
    .run(email, user.id, codeDigest(config, email, code), expires);
  const sent = await mailer.sendCode({ email, code, purpose: 'passwordReset', siteName: settings.siteName });
  return { accepted: true, expiresAt: expires, ...sent };
}

export async function resetPassword({ db, config, body }) {
  const email = normalizeEmail(body.email); const code = validateCode(body.code);
  await db.transaction(async transaction => {
    const token = await transaction.prepare('SELECT * FROM password_reset_tokens WHERE email=? FOR UPDATE').get(email);
    if (!token || new Date(token.expires_at) <= new Date()) throw httpError('验证码已过期，请重新获取', 409);
    if (token.attempts >= 5) throw httpError('验证码尝试次数过多，请重新获取', 429);
    if (token.code_hash !== codeDigest(config, email, code)) {
      await transaction.prepare('UPDATE password_reset_tokens SET attempts=attempts+1 WHERE email=?').run(email);
      throw httpError('验证码错误');
    }
    await transaction.prepare('UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(body.newPassword || ''), token.user_id);
    await transaction.prepare('DELETE FROM sessions WHERE user_id=?').run(token.user_id);
    await transaction.prepare('DELETE FROM password_reset_tokens WHERE email=?').run(email);
  });
  return { ok: true };
}

function assertEmailChange(user, body) {
  if (user.role !== 'user') throw httpError('管理员邮箱请由超级管理员维护', 403);
  if (!verifyPassword(body.currentPassword || '', user.password_hash)) throw httpError('当前密码错误', 403);
  const email = normalizeEmail(body.email);
  if (email === user.email) throw httpError('新邮箱不能与当前邮箱相同');
  return email;
}

async function assertEmailAvailable(db, email, userId) {
  const existing = await db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, userId);
  if (existing) throw httpError('该邮箱已被其他账号使用', 409);
}

export async function changeEmailWithoutVerification({ db, user, body }) {
  const email = assertEmailChange(user, body); await assertEmailAvailable(db, email, user.id);
  await db.transaction(async transaction => {
    await transaction.prepare('UPDATE users SET email=?,email_verified_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(email, user.id);
    await transaction.prepare('DELETE FROM email_change_tokens WHERE user_id=?').run(user.id);
    await transaction.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  });
  return { email, verificationRequired: false, relogin: true };
}

export async function requestEmailChange({ db, config, mailer, settings, user, body }) {
  if (!mailer?.available) throw httpError('邮件验证服务未配置，暂时不能更换邮箱', 503);
  const email = assertEmailChange(user, body); await assertEmailAvailable(db, email, user.id);
  const code = generateCode(); const expires = new Date(Date.now() + config.authCodeMinutes * 60_000).toISOString();
  await db.prepare(`INSERT INTO email_change_tokens (user_id,email,code_hash,expires_at,attempts,updated_at)
    VALUES (?,?,?,?,0,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,code_hash=excluded.code_hash,
      expires_at=excluded.expires_at,attempts=0,updated_at=CURRENT_TIMESTAMP`)
    .run(user.id, email, codeDigest(config, email, code), expires);
  try {
    const sent = await mailer.sendCode({ email, code, purpose: 'emailChange', siteName: settings.siteName });
    return { email, expiresAt: expires, verificationRequired: true, ...sent };
  } catch (error) {
    await db.prepare('DELETE FROM email_change_tokens WHERE user_id=?').run(user.id); throw error;
  }
}

export async function confirmEmailChange({ db, config, user, body }) {
  const code = validateCode(body.code); let email;
  await db.transaction(async transaction => {
    const token = await transaction.prepare('SELECT * FROM email_change_tokens WHERE user_id=? FOR UPDATE').get(user.id);
    if (!token || new Date(token.expires_at) <= new Date()) throw httpError('验证码已过期，请重新获取', 409);
    if (Number(token.attempts) >= 5) throw httpError('验证码尝试次数过多，请重新获取', 429);
    if (token.code_hash !== codeDigest(config, token.email, code)) {
      await transaction.prepare('UPDATE email_change_tokens SET attempts=attempts+1 WHERE user_id=?').run(user.id);
      throw httpError('验证码错误');
    }
    await assertEmailAvailable(transaction, token.email, user.id); email = token.email;
    await transaction.prepare('UPDATE users SET email=?,email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(email, user.id);
    await transaction.prepare('DELETE FROM email_change_tokens WHERE user_id=?').run(user.id);
    await transaction.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  });
  return { email, verificationRequired: true, relogin: true };
}

export const authInternals = { codeDigest, generateCode, validateCode };
